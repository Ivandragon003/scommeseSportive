#!/usr/bin/env node
'use strict';

// Deliberately does not import application startup, dotenv, recorder or spool writers.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { measureResults, pair } = require('./model-a-prospective-result-monitoring');
const { parseCollectionPerformance, measureCollectionRecorderOutcomes } = require('./model-a-prospective-alerts');

const HOUR = 3600000;
const AUDIT_TYPES = new Set(['attempted', 'accepted', 'rejected', 'ineligible', 'recovered', 'stored', 'delivery_unconfirmed', 'capture_error', 'result_reconciliation', 'result_reconciliation_error', 'retry', 'duplicate_suppressed']);
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
  if (!['direct_a', 'shared_ac', 'internal', 'prospective_a'].includes(options.origin)) fail('origin_required');
  if (options.protocolId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(options.protocolId)) fail('invalid_protocol_id');
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
  const issues = [], tables = {};
  for (const [table, required] of Object.entries(REQUIRED)) {
    if (!objects.some(row => row.type === 'table' && row.name === table)) {
      tables[table] = { status: 'missing', readable: false };
      issues.push(`missing_table:${table}`); continue;
    }
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const missing = required.filter(column => !columns.some(row => row.name === column));
    tables[table] = { status: missing.length ? 'incompatible' : 'available', readable: missing.length === 0 };
    for (const column of missing) issues.push(`missing_column:${table}.${column}`);
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
  return { compatible: issues.length === 0, issues, tables, verification: 'read_only_structure_no_mutation_probe' };
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
  if (provenance.classification === 'technical_only' || provenance.rigorousEligible === false
    || provenance.snapshot.classification === 'technical_only' || provenance.snapshot.rigorousEligible === false) return 'technical_only';
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
    unsafeEntries: 0, oldestForecastAt: null, audit: { counts: {}, invalidLines: 0, unknownTypes: 0, afterCutoff: 0, latestAt: null,
      reconciliationErrors: 0, reconciliationFailedItems: 0 }, records: [] };
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
      if (record.at <= cutoff) {
        result.records.push(record);
        if (result.oldestForecastAt === null || record.at < Date.parse(result.oldestForecastAt)) result.oldestForecastAt = new Date(record.at).toISOString();
      }
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
        if (!result.audit.latestAt || at > Date.parse(result.audit.latestAt)) result.audit.latestAt = new Date(at).toISOString();
        if (event.type === 'result_reconciliation_error') result.audit.reconciliationErrors++;
        if (event.type === 'result_reconciliation' && Number.isSafeInteger(event.failed) && event.failed >= 0) result.audit.reconciliationFailedItems += event.failed;
      } catch { result.audit.invalidLines++; }
    }
  }
  return result;
}

function calendarProjection(db, options, schema) {
  let policy;
  if (options.protocolId) {
    const protocols = optionalRows(db, 'model_a_collection_protocols', ['protocol_id', 'scope_json']);
    try {
      const manifest = JSON.parse(protocols.rows?.find(row => row.protocol_id === options.protocolId)?.scope_json ?? 'null');
      if (manifest?.snapshot?.calendar && manifest.sha256 !== createHash('sha256').update(JSON.stringify(manifest.snapshot)).digest('hex'))
        return { evaluable: false, source: 'unverified', fixtures: [], evidence: { status: 'invalid_manifest' } };
      if (manifest?.snapshot && manifest.sha256 === createHash('sha256').update(JSON.stringify(manifest.snapshot)).digest('hex')) policy = manifest.snapshot.calendar;
    } catch { /* The collector scope check reports invalid manifests. */ }
  }
  if (!policy) return { evaluable: schema.tables.matches.readable, source: 'matches', fixtures: schema.tables.matches.readable
    ? db.prepare('SELECT match_id,date FROM matches WHERE competition=? AND season=?').all(options.competition, options.season) : [] };
  const attempts = optionalRows(db, 'model_a_calendar_attempts', ['attempt_id', 'protocol_id', 'competition', 'season', 'acquired_at', 'status', 'coverage_json', 'fixture_attempt_id']);
  const rows = optionalRows(db, 'model_a_calendar_fixtures', ['observation_id', 'attempt_id', 'provider_match_id', 'match_id', 'kickoff_at', 'status', 'issue']);
  const evidence = { source: 'football-data.org', status: 'unavailable', providerFixtures: null, unmapped: null, conflicts: null, duplicates: null, acquiredAt: null, statusCounts: null };
  const priorIssues = schema.issues.length;
  for (const [name, table] of [['model_a_calendar_attempts', attempts], ['model_a_calendar_fixtures', rows]]) {
    schema.tables[name] = { status: table.status, readable: table.status === 'available' };
    if (table.status !== 'available') { schema.compatible = false; schema.issues.push(`${table.status}_table:${name}`); }
    else {
      const key = name === 'model_a_calendar_attempts' ? 'attempt_id' : 'observation_id';
      const keys = db.prepare(`PRAGMA table_info(${name})`).all().filter(row => Number(row.pk) > 0).sort((a, b) => a.pk - b.pk).map(row => row.name);
      if (keys.join(',') !== key) { schema.compatible = false; schema.issues.push(`missing_or_incompatible_primary_key:${name}`); }
      for (const operation of ['update', 'delete']) {
        const triggerName = `${name}_no_${operation}`;
        const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=? AND tbl_name=?").get(triggerName, name);
        const sql = String(trigger?.sql ?? '').replace(/\s+/g, ' ').trim();
        if (!new RegExp(`^CREATE TRIGGER (?:IF NOT EXISTS )?${triggerName} BEFORE ${operation} ON ${name} BEGIN SELECT RAISE\\(ABORT, '[^']+'\\); END$`, 'i').test(sql)) {
          schema.compatible = false; schema.issues.push(`missing_or_unverified_trigger:${triggerName}`);
        }
      }
    }
  }
  if (schema.issues.length !== priorIssues || policy.source !== 'football-data.org' || !/^[a-f0-9]{64}$/.test(policy.mappingSha256 ?? '') || !Number.isSafeInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds <= 0 || !attempts.rows || !rows.rows) return { evaluable: false, source: evidence.source, fixtures: [], evidence };
  const candidates = attempts.rows.filter(row => row.protocol_id === options.protocolId && row.competition === options.competition && row.season === options.season && safeTime(row.acquired_at) !== null && safeTime(row.acquired_at) <= options.cutoff)
    .sort((a, b) => safeTime(b.acquired_at) - safeTime(a.acquired_at) || String(b.attempt_id).localeCompare(String(a.attempt_id)));
  const attempt = candidates[0];
  if (!attempt) return { evaluable: false, source: evidence.source, fixtures: [], evidence };
  evidence.acquiredAt = attempt.acquired_at;
  if (candidates.length > 1 && safeTime(candidates[1].acquired_at) === safeTime(attempt.acquired_at)) {
    evidence.status = 'ambiguous_latest';
    return { evaluable: false, source: evidence.source, fixtures: [], evidence };
  }
  let counts; try { counts = JSON.parse(attempt.coverage_json); } catch { counts = null; }
  if (counts) for (const name of ['providerFixtures', 'unmapped', 'conflicts', 'duplicates']) evidence[name] = counts[name] ?? null;
  evidence.status = attempt.status !== 'success' ? 'failed' : options.cutoff - safeTime(attempt.acquired_at) > policy.maxAgeSeconds * 1000 ? 'stale' : 'incomplete';
  const sourceAttempt = attempts.rows.find(row => row.attempt_id === attempt.fixture_attempt_id && row.protocol_id === options.protocolId
    && row.competition === options.competition && row.season === options.season && row.status === 'success'
    && safeTime(row.acquired_at) !== null && safeTime(row.acquired_at) <= safeTime(attempt.acquired_at));
  const fixtures = rows.rows.filter(row => row.attempt_id === attempt.fixture_attempt_id);
  const validCounts = counts?.complete === true && ['providerFixtures', 'unmapped', 'conflicts', 'duplicates'].every(name => Number.isSafeInteger(counts[name]) && counts[name] >= 0)
    && counts.unmapped === 0 && counts.conflicts === 0 && counts.duplicates === 0 && counts.providerFixtures === fixtures.length;
  const statuses = new Set(['SCHEDULED', 'TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED', 'SUSPENDED', 'POSTPONED', 'CANCELLED', 'AWARDED']);
  const statusCounts = {}; for (const fixture of fixtures) statusCounts[fixture.status] = (statusCounts[fixture.status] ?? 0) + 1;
  evidence.statusCounts = statusCounts;
  const validRows = fixtures.every(row => statuses.has(row.status) && row.match_id != null && !row.issue && row.provider_match_id != null
    && (!['TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED'].includes(row.status) || safeTime(row.kickoff_at) !== null))
    && new Set(fixtures.map(row => String(row.provider_match_id))).size === fixtures.length && new Set(fixtures.map(row => String(row.match_id))).size === fixtures.length;
  if (evidence.status !== 'incomplete' || !validCounts || !validRows || !sourceAttempt) return { evaluable: false, source: evidence.source, fixtures: [], evidence };
  evidence.status = 'available';
  return { evaluable: true, source: evidence.source, evidence, fixtures: fixtures.filter(row => ['TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED'].includes(row.status)).map(row => ({ match_id: row.match_id, date: row.kickoff_at })) };
}

function coverage(db, options, spool, schema, calendar) {
  const calendarEvaluable = calendar.evaluable;
  const protocolStorageEvaluable = !options.protocolId || (optionalRows(db, 'model_a_collection_protocols', ['protocol_id', 'scope_json']).rows !== null
    && optionalRows(db, 'model_a_collection_ledger', ['protocol_id', 'match_id', 'kickoff_at', 'claim_at', 'claim_id']).rows !== null);
  const coverageEvaluable = calendarEvaluable && schema.tables.model_a_prospective_forecasts.readable && protocolStorageEvaluable;
  const result = {
    scope: { kickoffFromInclusive: new Date(options.from).toISOString(), kickoffToExclusive: new Date(options.to).toISOString(), cutoff: new Date(options.cutoff).toISOString(), origin: options.origin,
      cutoffPurpose: 'forecast_and_audit_event_time_filter_not_database_insertion_time',
      competitionSeasonFilter: 'explicit_exact_match', forecastWindowHoursBeforeKickoff: [24, 1] },
    calendarEvaluable, coverageEvaluable, calendarSource: calendar.source, calendarEvidence: calendar.evidence ?? null,
    storageStatus: { calendar: schema.tables.matches.status, forecasts: schema.tables.model_a_prospective_forecasts.status,
      results: schema.tables.model_a_prospective_results.status },
    fixtureMatches: null, overdueFixtures: null, openWindowFixtures: null, futureWindowFixtures: null,
    overdueMissing: null, openWindowMissing: null, receivedForecastEvidence: null, receivedMatchEvidence: null,
    recordedForecasts: null, recordedMatches: null, pendingUnconfirmedForecasts: null, pendingAlreadyRecordedForecasts: null,
    recordedMatchesInWindow: null, outsideWindowForecasts: null, kickoffConflicts: null,
    nonEvaluableProvenance: null, provenanceReasons: null, temporalClassificationCounts: null, invalidForecastRowsDatabaseWide: null,
    invalidFixtureTimesInCompetitionSeason: null,
  };
  if (!calendarEvaluable) return result;
  const fixtures = calendar.fixtures;
  let invalidFixtureTimes = 0;
  const scoped = new Map();
  for (const fixture of fixtures) {
    try { const kickoff = timestamp(fixture.date); if (kickoff >= options.from && kickoff < options.to) scoped.set(String(fixture.match_id), kickoff); }
    catch { invalidFixtureTimes++; }
  }
  let overdueFixtures = 0, openWindowFixtures = 0, futureWindowFixtures = 0;
  for (const kickoff of scoped.values()) {
    if (options.cutoff >= kickoff - HOUR) overdueFixtures++;
    else if (options.cutoff >= kickoff - 24 * HOUR) openWindowFixtures++;
    else futureWindowFixtures++;
  }
  Object.assign(result, { fixtureMatches: scoped.size, overdueFixtures, openWindowFixtures, futureWindowFixtures,
    invalidFixtureTimesInCompetitionSeason: invalidFixtureTimes });
  if (!coverageEvaluable) return result;
  const records = [], storedIds = new Set(); let invalidForecasts = 0;
  for (const row of db.prepare('SELECT id,match_id,forecast_at,kickoff_at,payload_json FROM model_a_prospective_forecasts').all()) {
    const record = parseForecast(row);
    if (!record) { invalidForecasts++; continue; }
    if (record.at <= options.cutoff) { records.push(record); storedIds.add(record.id); }
  }
  const belongsToProtocol = protocolForecastFilter(db, options);
  const inScope = record => belongsToProtocol(record) && scoped.has(record.matchId) && record.payload.origin === options.origin
    && record.payload.competition === options.competition && record.payload.season === options.season;
  const stored = records.filter(inScope), pending = spool.records.filter(inScope), received = new Map([...stored, ...pending].map(row => [row.id, row]));
  const selected = new Map(); let kickoffConflicts = 0, outsideWindowForecasts = 0;
  for (const record of stored) {
    if (record.kickoff !== scoped.get(record.matchId)) { kickoffConflicts++; continue; }
    if (record.at < record.kickoff - 24 * HOUR || record.at > record.kickoff - HOUR) { outsideWindowForecasts++; continue; }
    const previous = selected.get(record.matchId);
    if (!previous || record.at < previous.at || (record.at === previous.at && record.id < previous.id)) selected.set(record.matchId, record);
  }
  let overdueMissing = 0, openWindowMissing = 0;
  for (const [id, kickoff] of scoped) {
    if (options.cutoff >= kickoff - HOUR) { if (!selected.has(id)) overdueMissing++; }
    else if (options.cutoff >= kickoff - 24 * HOUR && !selected.has(id)) openWindowMissing++;
  }
  const provenanceReasons = {}, temporalClassificationCounts = {}; let nonEvaluableProvenance = 0;
  for (const record of selected.values()) {
    const classification = record.payload.provenance?.classification === 'technical_only' ? 'technical_only'
      : record.payload.provenance?.classification === 'verified' ? 'declared_rigorous_unverified' : 'unclassified';
    temporalClassificationCounts[classification] = (temporalClassificationCounts[classification] ?? 0) + 1;
    const issue = provenanceIssue(record.payload, record.at);
    if (issue) { nonEvaluableProvenance++; provenanceReasons[issue] = (provenanceReasons[issue] ?? 0) + 1; }
  }
  return { ...result,
  overdueMissing, openWindowMissing,
  receivedForecastEvidence: received.size, receivedMatchEvidence: new Set([...received.values()].map(row => row.matchId)).size,
  recordedForecasts: stored.length, recordedMatches: new Set(stored.map(row => row.matchId)).size,
  pendingUnconfirmedForecasts: pending.filter(row => !storedIds.has(row.id)).length,
  pendingAlreadyRecordedForecasts: pending.filter(row => storedIds.has(row.id)).length,
  recordedMatchesInWindow: selected.size, outsideWindowForecasts, kickoffConflicts,
  nonEvaluableProvenance, provenanceReasons, temporalClassificationCounts, invalidForecastRowsDatabaseWide: invalidForecasts };
}

// Optional research tables are never installed or repaired by an inspection.
function optionalRows(db, table, columns) {
  const found = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table);
  if (!found) return { status: 'missing', rows: null };
  const actual = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some(name => !actual.some(row => row.name === name))) return { status: 'incompatible', rows: null };
  return { status: 'available', rows: db.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all() };
}
function safeTime(value) { try { return timestamp(value); } catch { return null; } }
function protocolForecastFilter(db, options) {
  if (!options.protocolId) return () => true;
  const protocols = optionalRows(db, 'model_a_collection_protocols', ['protocol_id', 'scope_json']);
  const ledger = optionalRows(db, 'model_a_collection_ledger', ['protocol_id', 'match_id', 'kickoff_at', 'claim_at', 'claim_id']);
  let manifest;
  try { manifest = JSON.parse(protocols.rows?.find(row => row.protocol_id === options.protocolId)?.scope_json ?? 'null'); } catch { return () => false; }
  if (!manifest?.snapshot || manifest.snapshot.protocolId !== options.protocolId || manifest.sha256 !== createHash('sha256').update(JSON.stringify(manifest.snapshot)).digest('hex') || !ledger.rows) return () => false;
  return record => record.payload.collection?.protocolId === options.protocolId && record.payload.collection?.manifestSha256 === manifest.sha256
    && ledger.rows.some(row => row.protocol_id === options.protocolId && row.match_id === record.matchId && safeTime(row.kickoff_at) === record.kickoff
      && row.claim_id && row.claim_id === record.payload.collection.claimId && safeTime(row.claim_at) !== null && safeTime(row.claim_at) <= record.at);
}
function collectorMonitoring(db, options, collection, schema, projection) {
  const ledger = optionalRows(db, 'model_a_collection_ledger', ['protocol_id', 'match_id', 'kickoff_at', 'competition', 'season', 'state', 'reason', 'claim_at', 'forecast_id', 'updated_at']);
  const recorderColumns = ledger.rows !== null ? db.prepare('PRAGMA table_info(model_a_collection_ledger)').all().map(row => row.name) : [];
  const missingRecorderColumns = ['recorder_status', 'recorder_reason'].filter(name => !recorderColumns.includes(name));
  const recorderStatusReadable = ledger.rows !== null && missingRecorderColumns.length === 0;
  const runs = optionalRows(db, 'model_a_collection_runs', ['run_id', 'protocol_id', 'started_at', 'completed_at', 'status']);
  const performanceReadable = runs.rows !== null && db.prepare('PRAGMA table_info(model_a_collection_runs)').all().some(row => row.name === 'performance_json');
  const protocols = optionalRows(db, 'model_a_collection_protocols', ['protocol_id', 'scope_json', 'created_at']);
  const result = { requested: Boolean(options.protocolId), storageStatus: { ledger: ledger.status, runs: runs.status, protocols: protocols.status },
    registeredScopeMatches: null, analyzedFixtures: null, predictionStartedFixtures: null, eligibleFixtures: null,
    pendingFixtures: null, failedFixtures: null, storedFixtures: null, missedWindows: null, ledgerMissingFixtures: null,
    invalidKickoffObservations: null, kickoffChangedObservations: null, missingCalendarObservations: null, reasonCounts: null,
    lastRunStartedAt: null, lastSuccessfulRunAt: null, latestRunStatus: null, failedRuns: null, incompleteRuns: null, oldestPendingAt: null,
    performance: { status: 'no_completed_run', verified: false, reason: 'no_completed_run', metrics: null, runStartedAt: null, runCompletedAt: null, runStatus: null },
    ...measureCollectionRecorderOutcomes([], false) };
  if (!options.protocolId) return result;
  if (runs.rows && !performanceReadable) {
    result.storageStatus.runs = 'incompatible';
    schema.compatible = false;
    schema.issues.push('missing_column:model_a_collection_runs.performance_json');
  }
  if (ledger.rows && !recorderStatusReadable) {
    result.storageStatus.ledger = 'incompatible'; schema.compatible = false;
    for (const name of missingRecorderColumns) schema.issues.push(`missing_column:model_a_collection_ledger.${name}`);
  }
  const registered = protocols.rows?.find(row => row.protocol_id === options.protocolId);
  if (protocols.rows) {
    result.registeredScopeMatches = false;
    try {
      const manifest = JSON.parse(registered?.scope_json ?? 'null');
      const scope = manifest?.snapshot;
      const validHash = scope && manifest.sha256 === createHash('sha256').update(JSON.stringify(scope)).digest('hex');
      result.registeredScopeMatches = !!validHash && scope.protocolId === options.protocolId && scope.origin === options.origin
        && Array.isArray(scope.seasons) && scope.seasons.includes(options.season)
        && Array.isArray(scope.competitions) && scope.competitions.includes(options.competition) && safeTime(scope.from) !== null && safeTime(scope.to) !== null
        && options.from >= safeTime(scope.from) && options.to <= safeTime(scope.to);
    } catch { /* An invalid registered scope is not a successful registration. */ }
  }
  if (runs.rows) {
    const selected = runs.rows.filter(row => row.protocol_id === options.protocolId && safeTime(row.started_at) !== null && safeTime(row.started_at) <= options.cutoff)
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    result.lastRunStartedAt = selected[0]?.started_at ?? null;
    result.latestRunStatus = selected[0]?.status ?? null;
    const successful = selected.filter(row => row.status === 'success' && safeTime(row.completed_at) !== null && safeTime(row.completed_at) <= options.cutoff);
    result.lastSuccessfulRunAt = successful.map(row => row.completed_at).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    result.failedRuns = selected.filter(row => row.status === 'failed' && safeTime(row.completed_at) !== null && safeTime(row.completed_at) <= options.cutoff).length;
    result.incompleteRuns = selected.filter(row => row.status === 'started' || safeTime(row.completed_at) === null || safeTime(row.completed_at) > options.cutoff).length;
    if (performanceReadable) {
      const completed = db.prepare(`SELECT started_at,completed_at,status,performance_json FROM model_a_collection_runs WHERE protocol_id=? AND status IN ('success','failed','interrupted','partial') AND julianday(started_at)<=julianday(?) AND julianday(completed_at)<=julianday(?) ORDER BY julianday(completed_at) DESC,julianday(started_at) DESC,run_id DESC LIMIT 1`)
        .get(options.protocolId, new Date(options.cutoff).toISOString(), new Date(options.cutoff).toISOString());
      if (completed && safeTime(completed.started_at) !== null && safeTime(completed.completed_at) !== null) result.performance = {
        ...parseCollectionPerformance(completed.performance_json), runStartedAt: completed.started_at, runCompletedAt: completed.completed_at, runStatus: completed.status };
    } else result.performance = { ...result.performance, status: 'schema_unavailable', reason: 'performance_column_missing' };
  }
  if (!ledger.rows || !collection.calendarEvaluable) return result;
  const fixtures = projection.fixtures;
  const calendar = new Map(fixtures.filter(row => safeTime(row.date) !== null && safeTime(row.date) >= options.from && safeTime(row.date) < options.to)
    .map(row => [String(row.match_id), safeTime(row.date)]));
  const scoped = ledger.rows.filter(row => row.protocol_id === options.protocolId && row.competition === options.competition && row.season === options.season && safeTime(row.updated_at) !== null && safeTime(row.updated_at) <= options.cutoff);
  const current = scoped.filter(row => safeTime(row.kickoff_at) !== null && calendar.get(String(row.match_id)) === safeTime(row.kickoff_at));
  const receipts = recorderStatusReadable ? db.prepare('SELECT protocol_id,match_id,kickoff_at,recorder_status,recorder_reason FROM model_a_collection_ledger WHERE protocol_id=?').all(options.protocolId) : [];
  const receiptByFixture = new Map(receipts.map(row => [pair(row.match_id, safeTime(row.kickoff_at)), row]));
  const receiptMetrics = measureCollectionRecorderOutcomes(current.map(row => ({ ...row, ...receiptByFixture.get(pair(row.match_id, safeTime(row.kickoff_at))) })), recorderStatusReadable);
  const reasons = {};
  for (const row of current) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  const pending = current.filter(row => ['claimed', 'unconfirmed'].includes(row.state));
  const pendingTimes = pending.map(row => safeTime(row.claim_at) ?? safeTime(row.updated_at)).filter(value => value !== null);
  return { ...result, ...receiptMetrics, analyzedFixtures: new Set(current.map(row => String(row.match_id))).size,
    predictionStartedFixtures: current.filter(row => safeTime(row.claim_at) !== null).length,
    eligibleFixtures: current.filter(row => safeTime(row.claim_at) !== null || row.reason === 'eligible').length,
    storedFixtures: current.filter(row => row.state === 'stored').length,
    pendingFixtures: pending.length, failedFixtures: current.filter(row => row.state === 'unconfirmed').length,
    missedWindows: current.filter(row => row.reason === 'window_expired').length,
    ledgerMissingFixtures: [...calendar].filter(([id, kickoff]) => options.cutoff >= kickoff - 24 * HOUR && !current.some(row => String(row.match_id) === id)).length,
    invalidKickoffObservations: Math.max(collection.invalidFixtureTimesInCompetitionSeason ?? 0, scoped.filter(row => row.reason === 'invalid_kickoff').length),
    kickoffChangedObservations: scoped.filter(row => row.reason === 'kickoff_changed').length,
    missingCalendarObservations: scoped.filter(row => row.reason === 'fixture_missing_from_calendar').length,
    oldestPendingAt: pendingTimes.length ? new Date(Math.min(...pendingTimes)).toISOString() : null, reasonCounts: reasons };
}

function resultMonitoring(db, options, schema, projection) {
  const result = { evaluable: false, linkedForecasts: null, currentlyPairableForecasts: null, preservedFinalEvidence: null,
    pendingForecasts: null, oldestPendingKickoffAt: null, unassociatedResults: null, orphanForecasts: null, invalidResultRows: null,
    lifecycle: null, lifecycleReasons: null, lastLifecycleObservedAt: null, refreshRunLivenessVerified: false,
    lastRefreshStartedAt: null, lastRefreshCompletedAt: null, lastSuccessfulRefreshAt: null, latestRefreshStatus: null, lifecycleStorage: 'missing' };
  const refresh = optionalRows(db, 'model_a_prospective_result_refresh_state', ['refresh_id', 'last_started_at', 'last_completed_at', 'last_success_at', 'last_status']);
  result.refreshStateStorage = refresh.status;
  const state = refresh.rows?.find(row => row.refresh_id === 'understat-results-v1');
  if (state) Object.assign(result, { refreshRunLivenessVerified: true,
    lastRefreshStartedAt: safeTime(state.last_started_at) !== null && safeTime(state.last_started_at) <= options.cutoff ? state.last_started_at : null,
    lastRefreshCompletedAt: safeTime(state.last_completed_at) !== null && safeTime(state.last_completed_at) <= options.cutoff ? state.last_completed_at : null,
    lastSuccessfulRefreshAt: safeTime(state.last_success_at) !== null && safeTime(state.last_success_at) <= options.cutoff ? state.last_success_at : null,
    latestRefreshStatus: state.last_status });
  if (!schema.tables.model_a_prospective_forecasts.readable || !schema.tables.model_a_prospective_results.readable) return result;
  const belongsToProtocol = protocolForecastFilter(db, options);
  const forecasts = db.prepare('SELECT id,match_id,forecast_at,kickoff_at,payload_json FROM model_a_prospective_forecasts').all().map(parseForecast)
    .filter(row => row && belongsToProtocol(row) && row.at <= options.cutoff && row.kickoff >= options.from && row.kickoff < options.to && row.payload.origin === options.origin
      && row.payload.competition === options.competition && row.payload.season === options.season);
  const rows = db.prepare('SELECT evidence_id,match_id,source,kickoff_at,observed_at,recorded_at,home_goals,away_goals,evidence_json FROM model_a_prospective_results').all();
  let invalidResultRows = 0; const results = [];
  for (const row of rows) {
    const kickoff = safeTime(row.kickoff_at), observed = safeTime(row.observed_at), recorded = safeTime(row.recorded_at);
    if (kickoff === null || observed === null || recorded === null || observed <= kickoff || recorded < observed
      || ![row.home_goals, row.away_goals].every(value => Number.isSafeInteger(value) && value >= 0)) { invalidResultRows++; continue; }
    if (observed <= options.cutoff && recorded <= options.cutoff) results.push({ evidenceId: row.evidence_id, matchId: String(row.match_id), kickoff, observed, recorded, homeGoals: row.home_goals, awayGoals: row.away_goals });
  }
  const calendar = projection.evaluable ? new Map(projection.fixtures
    .filter(row => safeTime(row.date) !== null && safeTime(row.date) >= options.from && safeTime(row.date) < options.to).map(row => [String(row.match_id), safeTime(row.date)])) : null;
  const lifecycle = optionalRows(db, 'model_a_prospective_result_observations', ['evidence_id', 'match_id', 'kickoff_at', 'observed_at', 'recorded_at', 'status', 'reason', 'evidence_json']);
  const observations = lifecycle.rows?.filter(row => safeTime(row.kickoff_at) !== null && safeTime(row.observed_at) !== null && safeTime(row.recorded_at) !== null && safeTime(row.observed_at) <= options.cutoff && safeTime(row.recorded_at) <= options.cutoff).map(row => {
    let evidence; try { evidence = JSON.parse(row.evidence_json); } catch { evidence = null; }
    return { evidenceId: row.evidence_id, matchId: String(row.match_id), kickoff: safeTime(row.kickoff_at), observed: safeTime(row.observed_at), recorded: safeTime(row.recorded_at),
      status: row.status, reason: row.reason, homeGoals: evidence?.resultRow?.home_goals, awayGoals: evidence?.resultRow?.away_goals };
  }) ?? null;
  const ledger = options.protocolId ? optionalRows(db, 'model_a_collection_ledger', ['protocol_id', 'match_id', 'kickoff_at', 'reason', 'updated_at']) : { rows: null };
  const exclusions = ledger.rows?.filter(row => row.protocol_id === options.protocolId && row.reason === 'cancelled_or_postponed' && safeTime(row.updated_at) !== null && safeTime(row.updated_at) <= options.cutoff)
    .map(row => pair(row.match_id, safeTime(row.kickoff_at))) ?? [];
  const scopedResults = results.filter(row => row.kickoff >= options.from && row.kickoff < options.to
    && (calendar?.has(row.matchId) || forecasts.some(forecast => forecast.matchId === row.matchId)));
  const measured = measureResults(forecasts, scopedResults, observations, calendar, options.cutoff, exclusions);
  return { ...result, ...measured, invalidResultRows, lifecycleStorage: lifecycle.status };
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
    const projection = calendarProjection(db, scope, schema);
    const collection = coverage(db, scope, spool, schema, projection);
    const measuredResults = resultMonitoring(db, scope, schema, projection);
    const { excludedKeys, ...resultDiagnostics } = measuredResults;
    if (excludedKeys && collection.calendarEvaluable) {
      const fixtures = projection.fixtures
        .filter(row => safeTime(row.date) !== null && safeTime(row.date) >= scope.from && safeTime(row.date) < scope.to);
      const excluded = fixtures.filter(row => excludedKeys.has(pair(row.match_id, safeTime(row.date))));
      collection.eligibleFixtureMatches = fixtures.length - excluded.length;
      collection.excludedLifecycleFixtures = excluded.length;
      if (collection.coverageEvaluable) {
        const belongs = protocolForecastFilter(db, scope);
        const selected = new Set(db.prepare('SELECT id,match_id,forecast_at,kickoff_at,payload_json FROM model_a_prospective_forecasts').all().map(parseForecast)
          .filter(row => row && belongs(row) && row.payload.origin === scope.origin && row.payload.competition === scope.competition && row.payload.season === scope.season
            && row.at <= scope.cutoff && row.at >= row.kickoff - 24 * HOUR && row.at <= row.kickoff - HOUR).map(row => pair(row.matchId, row.kickoff)));
        const eligible = fixtures.filter(row => !excludedKeys.has(pair(row.match_id, safeTime(row.date))));
        collection.overdueMissing = eligible.filter(row => scope.cutoff >= safeTime(row.date) - HOUR && !selected.has(pair(row.match_id, safeTime(row.date)))).length;
        collection.openWindowMissing = eligible.filter(row => scope.cutoff >= safeTime(row.date) - 24 * HOUR && scope.cutoff < safeTime(row.date) - HOUR && !selected.has(pair(row.match_id, safeTime(row.date)))).length;
      }
    }
    const { records: _records, ...diagnostics } = spool;
    return { schemaVersion: 'model-a-prospective-inspection-v1', mode: 'local_read_only', measuredAt,
      timeSemantics: { observation: 'current_local_files_at_inspection', historicalSnapshot: false,
        forecastRows: 'currently_present_rows_filtered_by_forecast_at_lte_cutoff',
        databaseInsertionAsOfCutoffVerified: false,
        fixtureCalendar: 'currently_present_fixture_rows',
        collectorLedger: 'currently_present_states_filtered_by_updated_at_lte_cutoff_not_historical_state_reconstruction',
        spool: 'currently_present_files_with_forecast_records_filtered_by_forecast_at_lte_cutoff',
        audit: 'currently_readable_complete_lines_filtered_by_event_at_lte_cutoff_not_proven_write_time' }, schema,
      configuration: { enabledInInspectorEnvironment: environment.MODEL_A_PROSPECTIVE_ENABLED === 'true',
        volatileAllowedInInspectorEnvironment: environment.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE === 'true',
        explicitSpoolConfigured: Boolean(options.spoolDir),
        runtimeEnvironmentVerified: false, writeAccessTested: false, persistenceAcrossRestartVerified: false },
      spool: diagnostics, coverage: collection, collector: collectorMonitoring(db, scope, collection, schema, projection), results: resultDiagnostics,
      limitations: ['Explicit scope is caller supplied; preregistration is not certified.', 'Fixture calendar completeness and historical fixture revisions are not certified.',
        'Cutoff filters forecast and audit event timestamps, not database insertion time. A forecast delivered after cutoff is counted if present now; historical persistence and historical coverage at cutoff are not certified.',
        'Spool files and audit lines are inspected as currently available. Their past contents, missing files, write times and backlog at cutoff cannot be reconstructed.',
        'Audit event counts cover all origins and scopes; retries are events, not distinct forecasts. Missing audit writes cannot be recovered here.',
        'Collector ledger records observed fixture/kickoff states; predictionStartedFixtures requires a claim and is distinct from fixture analysis. Only successful persisted runs establish collector liveness.',
        'Result associations use match ID and equivalent UTC kickoff plus observation/recording cutoff. Counts describe stored evidence, not an official result certification. Lifecycle timestamps alone do not prove refresh cycle liveness.',
        'Received evidence is persisted rows plus valid spool files, not an independent request denominator.',
        'Unavailable calendar or forecast storage yields null coverage metrics, not zero requests or zero coverage. Readable data does not certify schema guards or official results.',
        'Filesystem checks are observations, not ACL, disk durability or runtime permission guarantees. Spool and database snapshots are not atomic together.',
        'This inspection does not authorize activation or establish scientific validity.'] };
  } finally { db.close(); }
}

function main(argv) {
  try {
    const names = { '--db-url': 'dbUrl', '--competition': 'competition', '--season': 'season', '--from': 'from', '--to': 'to', '--cutoff': 'cutoff', '--origin': 'origin', '--spool-dir': 'spoolDir', '--protocol-id': 'protocolId' };
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
