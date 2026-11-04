#!/usr/bin/env node
'use strict';

// Deliberately does not import application startup, dotenv, recorder or spool writers.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');

const HOUR = 3600000;
const AUDIT_TYPES = new Set(['attempted', 'accepted', 'rejected', 'ineligible', 'recovered', 'stored', 'delivery_unconfirmed', 'capture_error']);
const REQUIRED = {
  matches: ['match_id', 'competition', 'season', 'date'],
  model_a_prospective_forecasts: ['id', 'match_id', 'forecast_at', 'kickoff_at', 'payload_json'],
  model_a_prospective_results: ['evidence_id', 'match_id', 'source', 'kickoff_at', 'observed_at', 'recorded_at', 'home_goals', 'away_goals', 'evidence_json'],
};

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function timestamp(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) fail('invalid_timestamp');
  return Date.parse(value);
}
function scopeOptions(options) {
  if (typeof options.competition !== 'string' || !options.competition.trim() || typeof options.season !== 'string' || !options.season.trim()) fail('scope_required');
  if (!['direct_a', 'shared_ac', 'internal'].includes(options.origin)) fail('origin_required');
  const from = timestamp(options.from), to = timestamp(options.to), cutoff = timestamp(options.cutoff);
  if (from >= to) fail('invalid_scope_interval');
  return { ...options, from, to, cutoff };
}

/** Reject symbolic links in every existing component, including Windows junctions. */
function regularPath(value, directory = false) {
  const resolved = path.resolve(value);
  if (resolved.startsWith('\\\\') || resolved.startsWith('//')) fail('network_path_forbidden');
  let current = resolved;
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('symlink_forbidden');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const stat = fs.statSync(resolved);
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail('invalid_file_type');
  return resolved;
}
function localDatabasePath(url) {
  if (typeof url !== 'string' || !url.startsWith('file:') || /[?#]/.test(url) || url.includes('\0')) fail('local_file_url_required');
  const suffix = url.slice(5);
  if (!suffix || suffix.includes(':memory:')) fail('existing_database_required');
  let filename;
  if (suffix.startsWith('//')) {
    const parsed = new URL(url);
    if (parsed.hostname || parsed.username || parsed.password) fail('network_path_forbidden');
    filename = fileURLToPath(parsed);
  } else filename = decodeURIComponent(suffix);
  return regularPath(filename);
}

function inspectSchema(db) {
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  const issues = [];
  for (const [table, required] of Object.entries(REQUIRED)) {
    if (!objects.some(row => row.type === 'table' && row.name === table)) { issues.push(`missing_table:${table}`); continue; }
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    for (const column of required) if (!columns.some(row => row.name === column)) issues.push(`missing_column:${table}.${column}`);
    const identity = table === 'matches' ? 'match_id' : table === 'model_a_prospective_forecasts' ? 'id' : 'evidence_id';
    if (!columns.some(row => row.name === identity && row.pk === 1)) issues.push(`missing_primary_key:${table}`);
  }
  for (const [table, index, last] of [
    ['model_a_prospective_forecasts', 'idx_model_a_prospective_match', 'forecast_at'],
    ['model_a_prospective_results', 'idx_model_a_prospective_results_match', 'observed_at'],
  ]) {
    const columns = db.prepare(`PRAGMA index_info(${index})`).all().map(row => row.name);
    if (!objects.some(row => row.type === 'index' && row.name === index && row.tbl_name === table)
      || columns.join(',') !== `match_id,${last}`) issues.push(`missing_or_incompatible_index:${index}`);
    for (const operation of ['update', 'delete']) {
      const name = table === 'model_a_prospective_forecasts' ? `model_a_prospective_no_${operation}` : `model_a_prospective_results_no_${operation}`;
      const trigger = objects.find(row => row.type === 'trigger' && row.name === name && row.tbl_name === table);
      const sql = String(trigger?.sql ?? '').replace(/\s+/g, ' ').trim();
      // A conditional or different trigger is not proof of the proposed append-only guard.
      const pattern = new RegExp(`^CREATE TRIGGER (?:IF NOT EXISTS )?${name} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE\\(ABORT, '[^']+'\\); END$`, 'i');
      if (!pattern.test(sql)) issues.push(`missing_or_unverified_trigger:${name}`);
    }
  }
  return { compatible: issues.length === 0, issues, verification: 'read_only_structure_no_mutation_probe' };
}

function canonical(value) {
  function ordered(item) {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])]));
    return item;
  }
  // Match ModelAProspectiveInputs, including JSON integer-key ordering.
  return JSON.stringify(ordered(value));
}
function provenanceIssue(payload, at) {
  const provenance = payload.provenance;
  if (!provenance?.inputSnapshotHash || !provenance.snapshot) return 'input_snapshot_missing';
  const hash = createHash('sha256').update(canonical(provenance.snapshot)).digest('hex');
  if (provenance.inputSnapshotHash !== hash) return 'input_snapshot_hash_mismatch';
  if (!provenance.inputAvailableThrough) return 'input_availability_unverified';
  try {
    if (timestamp(provenance.inputAvailableThrough) > at || (provenance.observedInputsThrough && timestamp(provenance.observedInputsThrough) > at)) return 'input_timestamp_after_forecast';
  } catch { return 'input_timestamp_invalid'; }
  return null;
}
function parseForecast(row) {
  try {
    const payload = JSON.parse(row.payload_json), at = timestamp(row.forecast_at), kickoff = timestamp(row.kickoff_at);
    if (payload.schema !== 'model-a-operational-prospective-v1' || payload.family !== 'A' || payload.id !== row.id
      || payload.matchId !== row.match_id || payload.forecastAt !== row.forecast_at || payload.kickoffAt !== row.kickoff_at || at >= kickoff) return null;
    return { id: row.id, matchId: row.match_id, at, kickoff, payload };
  } catch { return null; }
}

function readSmallFile(filename, limit) {
  regularPath(filename);
  if (fs.statSync(filename).size > limit) fail('inspection_size_limit');
  return fs.readFileSync(filename, 'utf8');
}
function inspectSpool(directory, cutoff) {
  const result = { configured: Boolean(directory), readable: false, pendingFiles: 0, partialFiles: 0, invalidFiles: 0,
    unsafeEntries: 0, audit: { counts: {}, invalidLines: 0, unknownTypes: 0, afterCutoff: 0 }, records: [] };
  if (!directory) return result;
  const location = regularPath(directory, true);
  result.readable = true;
  for (const entry of fs.readdirSync(location, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) { result.unsafeEntries++; continue; }
    if (entry.name.endsWith('.partial')) { result.partialFiles++; continue; }
    if (!entry.name.endsWith('.json')) continue;
    result.pendingFiles++;
    try {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(entry.name)) fail('invalid_spool_name');
      const event = JSON.parse(readSmallFile(path.join(location, entry.name), 2 * 1024 * 1024));
      const record = parseForecast({ id: event.id, match_id: event.matchId, forecast_at: event.forecastAt, kickoff_at: event.kickoffAt, payload_json: event.payload });
      if (!record || event.durable !== true || entry.name !== `${event.id}.json`) fail('invalid_spool');
      if (record.at <= cutoff) result.records.push(record);
    } catch { result.invalidFiles++; }
  }
  const auditPath = path.join(location, 'audit.ndjson');
  if (fs.existsSync(auditPath)) {
    const data = readSmallFile(auditPath, 16 * 1024 * 1024), lines = data.split('\n');
    if (lines.pop()) result.audit.invalidLines++;
    for (const line of lines) {
      if (!line) continue;
      try {
        const event = JSON.parse(line), at = timestamp(event.at);
        if (at > cutoff) { result.audit.afterCutoff++; continue; }
        if (!AUDIT_TYPES.has(event.type)) { result.audit.unknownTypes++; continue; }
        result.audit.counts[event.type] = (result.audit.counts[event.type] ?? 0) + 1;
      } catch { result.audit.invalidLines++; }
    }
  }
  return result;
}

function coverage(db, options, spool) {
  const fixtures = db.prepare('SELECT match_id,date FROM matches WHERE competition=? AND season=?').all(options.competition, options.season);
  let invalidFixtureTimes = 0;
  const scoped = new Map();
  for (const fixture of fixtures) {
    try { const kickoff = timestamp(fixture.date); if (kickoff >= options.from && kickoff < options.to) scoped.set(String(fixture.match_id), kickoff); }
    catch { invalidFixtureTimes++; }
  }
  const records = [], storedIds = new Set(); let invalidForecasts = 0;
  for (const row of db.prepare('SELECT id,match_id,forecast_at,kickoff_at,payload_json FROM model_a_prospective_forecasts').all()) {
    const record = parseForecast(row);
    if (!record) { invalidForecasts++; continue; }
    if (record.at <= options.cutoff) { records.push(record); storedIds.add(record.id); }
  }
  const inScope = record => scoped.has(record.matchId) && record.payload.origin === options.origin
    && record.payload.competition === options.competition && record.payload.season === options.season;
  const stored = records.filter(inScope), pending = spool.records.filter(inScope), received = new Map([...stored, ...pending].map(row => [row.id, row]));
  const selected = new Map(); let kickoffConflicts = 0, outsideWindowForecasts = 0;
  for (const record of stored) {
    if (record.kickoff !== scoped.get(record.matchId)) { kickoffConflicts++; continue; }
    if (record.at < record.kickoff - 24 * HOUR || record.at > record.kickoff - HOUR) { outsideWindowForecasts++; continue; }
    const previous = selected.get(record.matchId);
    if (!previous || record.at < previous.at || (record.at === previous.at && record.id < previous.id)) selected.set(record.matchId, record);
  }
  let overdueFixtures = 0, openWindowFixtures = 0, futureWindowFixtures = 0, overdueMissing = 0, openWindowMissing = 0;
  for (const [id, kickoff] of scoped) {
    if (options.cutoff >= kickoff - HOUR) { overdueFixtures++; if (!selected.has(id)) overdueMissing++; }
    else if (options.cutoff >= kickoff - 24 * HOUR) { openWindowFixtures++; if (!selected.has(id)) openWindowMissing++; }
    else futureWindowFixtures++;
  }
  const provenanceReasons = {}; let nonEvaluableProvenance = 0;
  for (const record of selected.values()) {
    const issue = provenanceIssue(record.payload, record.at);
    if (issue) { nonEvaluableProvenance++; provenanceReasons[issue] = (provenanceReasons[issue] ?? 0) + 1; }
  }
  return { scope: { kickoffFromInclusive: new Date(options.from).toISOString(), kickoffToExclusive: new Date(options.to).toISOString(), cutoff: new Date(options.cutoff).toISOString(), origin: options.origin,
    cutoffPurpose: 'forecast_and_audit_event_time_filter_not_database_insertion_time',
    competitionSeasonFilter: 'explicit_exact_match', forecastWindowHoursBeforeKickoff: [24, 1] },
  fixtureMatches: scoped.size, overdueFixtures, openWindowFixtures, futureWindowFixtures, overdueMissing, openWindowMissing,
  receivedForecastEvidence: received.size, receivedMatchEvidence: new Set([...received.values()].map(row => row.matchId)).size,
  recordedForecasts: stored.length, recordedMatches: new Set(stored.map(row => row.matchId)).size,
  pendingUnconfirmedForecasts: pending.filter(row => !storedIds.has(row.id)).length,
  pendingAlreadyRecordedForecasts: pending.filter(row => storedIds.has(row.id)).length,
  recordedMatchesInWindow: selected.size, outsideWindowForecasts, kickoffConflicts,
  nonEvaluableProvenance, provenanceReasons, invalidForecastRowsDatabaseWide: invalidForecasts, invalidFixtureTimesInCompetitionSeason: invalidFixtureTimes };
}

function inspect(options, environment = process.env) {
  const measuredAt = new Date().toISOString();
  const scope = scopeOptions(options), filename = localDatabasePath(options.dbUrl);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) fail('node_sqlite_required_node_22_13_or_newer');
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { fail('node_sqlite_required_node_22_13_or_newer'); }
  const db = new DatabaseSync(filename, { readOnly: true, enableExtensions: false });
  try {
    db.exec('PRAGMA query_only=ON');
    db.exec('BEGIN');
    const schema = inspectSchema(db), spool = inspectSpool(options.spoolDir, scope.cutoff);
    const collection = schema.compatible ? coverage(db, scope, spool) : null;
    const { records: _records, ...diagnostics } = spool;
    return { schemaVersion: 'model-a-prospective-inspection-v1', mode: 'local_read_only', measuredAt,
      timeSemantics: { observation: 'current_local_files_at_inspection', historicalSnapshot: false,
        forecastRows: 'currently_present_rows_filtered_by_forecast_at_lte_cutoff',
        databaseInsertionAsOfCutoffVerified: false,
        fixtureCalendar: 'currently_present_fixture_rows',
        spool: 'currently_present_files_with_forecast_records_filtered_by_forecast_at_lte_cutoff',
        audit: 'currently_readable_complete_lines_filtered_by_event_at_lte_cutoff_not_proven_write_time' }, schema,
      configuration: { enabledInInspectorEnvironment: environment.MODEL_A_PROSPECTIVE_ENABLED === 'true',
        volatileAllowedInInspectorEnvironment: environment.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE === 'true',
        explicitSpoolConfigured: Boolean(options.spoolDir),
        runtimeEnvironmentVerified: false, writeAccessTested: false, persistenceAcrossRestartVerified: false },
      spool: diagnostics, coverage: collection,
      limitations: ['Explicit scope is caller supplied; preregistration is not certified.', 'Fixture calendar completeness and historical fixture revisions are not certified.',
        'Cutoff filters forecast and audit event timestamps, not database insertion time. A forecast delivered after cutoff is counted if present now; historical persistence and historical coverage at cutoff are not certified.',
        'Spool files and audit lines are inspected as currently available. Their past contents, missing files, write times and backlog at cutoff cannot be reconstructed.',
        'Audit event counts cover all origins and scopes; retries are events, not distinct forecasts. Missing audit writes cannot be recovered here.',
        'Received evidence is persisted rows plus valid spool files, not an independent request denominator.',
        'Filesystem checks are observations, not ACL, disk durability or runtime permission guarantees. Spool and database snapshots are not atomic together.',
        'This inspection does not authorize activation or establish scientific validity.'] };
  } finally { db.close(); }
}

function main(argv) {
  try {
    const names = { '--db-url': 'dbUrl', '--competition': 'competition', '--season': 'season', '--from': 'from', '--to': 'to', '--cutoff': 'cutoff', '--origin': 'origin', '--spool-dir': 'spoolDir' };
    const options = {};
    for (let i = 0; i < argv.length; i += 2) {
      const key = names[argv[i]];
      if (!key || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('invalid_arguments');
      options[key] = argv[i + 1];
    }
    const report = inspect(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.schema.compatible ? 0 : 1;
  } catch (error) {
    // Never emit paths, URLs, payloads, credentials or raw driver errors.
    const code = /^[a-z_]+$/.test(error.code ?? '') ? error.code : 'inspection_failed';
    process.stdout.write(`${JSON.stringify({ error: code, mode: 'local_read_only' })}\n`);
    return 1;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { inspect, main, localDatabasePath };
