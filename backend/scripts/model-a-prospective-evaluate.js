#!/usr/bin/env node
'use strict';

// Operator tool: no application bootstrap, dotenv, migrations, model or provider imports.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { STAGES, LEAGUES, EPSILON, REPLICAS, validProbability, loss, summarize, utcWeek, blockBootstrap } = require('./model-a-prospective-statistics');
const HASH = /^[a-f0-9]{64}$/i;
const PUBLIC_ID = /^[A-Za-z0-9._-]{1,128}$/;
const DEFAULT_SEED = 20261105;
const SQL_DIRECTORY = path.join(__dirname, '../experiments/model-a-prospective');
const sha256 = value => createHash('sha256').update(value).digest('hex');
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function canonical(value) {
  const ordered = item => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item;
  return JSON.stringify(ordered(value));
}
function timestamp(value) {
  const parts = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!parts) fail('invalid_utc_timestamp');
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number), date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) fail('invalid_utc_timestamp');
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) fail('invalid_utc_timestamp');
  return instant;
}
// Stored producer times may carry an explicit offset; public scope times must use UTC Z.
function storedTime(value) {
  const parts = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) fail('invalid_stored_timestamp');
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number), date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) fail('invalid_stored_timestamp');
  return Date.parse(value);
}
function optionsFor(input) {
  const options = { mode: 'strict', seed: DEFAULT_SEED, ...input };
  if (!['strict', 'technical'].includes(options.mode)) fail('invalid_mode');
  timestamp(options.cutoff);
  if (!['direct_a', 'shared_ac', 'internal', 'prospective_a'].includes(options.origin)) fail('explicit_origin_required');
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) fail('invalid_seed');
  if (options.origin === 'prospective_a') {
    if (!PUBLIC_ID.test(options.protocolId ?? '') || !HASH.test(options.manifestSha256 ?? '')) fail('protocol_and_expected_manifest_required');
  } else if (options.protocolId != null || options.manifestSha256 != null) fail('protocol_not_allowed_for_origin');
  if (options.studyStartedAt != null && timestamp(options.studyStartedAt) > timestamp(options.cutoff)) fail('study_start_after_cutoff');
  if (options.quoteMaxAgeMs != null && (!Number.isSafeInteger(options.quoteMaxAgeMs) || options.quoteMaxAgeMs <= 0)) fail('invalid_quote_age_policy');
  return options;
}

/** Only fixed SELECT/WITH statements reach clients; this also protects injected clients. */
function selectOnly(sql) {
  const bare = sql.replace(/--[^\r\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'(?:''|[^'])*'/g, "''").trim();
  if (!/^(SELECT|WITH)\b/i.test(bare) || /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|BEGIN|COMMIT|ROLLBACK)\b/i.test(bare)
    || bare.replace(/;\s*$/, '').includes(';')) fail('select_only_required');
}
async function read(client, sql, args = {}) { selectOnly(sql); return (await client.execute({ sql, args })).rows; }
function canonicalQueries() {
  return { strict: fs.readFileSync(path.join(SQL_DIRECTORY, 'paired-results.sql'), 'utf8'),
    technical: fs.readFileSync(path.join(SQL_DIRECTORY, 'technical-paired-results.sql'), 'utf8') };
}
async function registeredManifest(client, options) {
  if (options.origin !== 'prospective_a') return null;
  const rows = await read(client, 'SELECT scope_json FROM model_a_collection_protocols WHERE protocol_id=:protocol_id', { protocol_id: options.protocolId });
  if (rows.length !== 1) fail('registered_protocol_required');
  let manifest;
  try { manifest = JSON.parse(rows[0].scope_json); } catch { fail('invalid_registered_manifest'); }
  const scope = manifest?.snapshot;
  if (!scope || manifest.sha256 !== options.manifestSha256 || sha256(JSON.stringify(scope)) !== options.manifestSha256
    || scope.protocolId !== options.protocolId || scope.origin !== options.origin
    || !Array.isArray(scope.competitions) || JSON.stringify(scope.competitions) !== JSON.stringify(LEAGUES)
    || !Array.isArray(scope.seasons) || !scope.seasons.length || scope.seasons.some(s => typeof s !== 'string' || !/^\d{4}\/\d{2,4}$/.test(s))
    || scope.window !== 'T-24h..T-60min inclusive') fail('registered_manifest_mismatch');
  if (timestamp(scope.from) >= timestamp(scope.to)) fail('invalid_registered_scope');
  return scope;
}

function forecastIssue(row, options, scope) {
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
    const at = storedTime(row.forecast_at), kickoff = storedTime(row.kickoff_at);
    if (payload.schema !== 'model-a-operational-prospective-v1' || payload.family !== 'A' || payload.id !== row.id || payload.matchId !== row.match_id
      || payload.forecastAt !== row.forecast_at || payload.kickoffAt !== row.kickoff_at || payload.origin !== options.origin
      || storedTime(payload.inputAsOf) > at || at > timestamp(options.cutoff) || at < kickoff - 86400000 || at > kickoff - 3600000) return { reason: 'invalid_payload_identity_or_time' };
    if (!LEAGUES.includes(payload.competition) || typeof payload.season !== 'string' || !/^\d{4}\/\d{2,4}$/.test(payload.season)) return { reason: 'invalid_competition_or_season' };
    if (options.origin === 'prospective_a' && (payload.collection?.protocolId !== options.protocolId || payload.collection?.manifestSha256 !== options.manifestSha256
      || !PUBLIC_ID.test(payload.collection?.claimId ?? '') || !scope || !scope.seasons.includes(payload.season)
      || kickoff < timestamp(scope.from) || kickoff >= timestamp(scope.to))) return { reason: 'collection_manifest_or_scope_mismatch' };
    if (!PUBLIC_ID.test(payload.model?.version ?? '') || !['codeHash', 'configHash', 'stateHash'].every(key => HASH.test(payload.model?.[key] ?? ''))) return { reason: 'invalid_model_identity' };
    const provenance = payload.provenance;
    if (!HASH.test(provenance?.inputSnapshotHash ?? '')) return { reason: 'input_snapshot_hash_missing_or_invalid' };
    if (provenance.snapshot != null && sha256(canonical(provenance.snapshot)) !== provenance.inputSnapshotHash.toLowerCase()) return { reason: 'input_snapshot_hash_mismatch' };
    if (provenance.observedInputsThrough != null && storedTime(provenance.observedInputsThrough) > at) return { reason: 'input_timestamp_after_forecast' };
    const declared = provenance.classification === 'verified' && provenance.rigorousEligible === true
      && provenance.inputAvailableThrough != null && storedTime(provenance.inputAvailableThrough) <= at
      && provenance.snapshot?.classification !== 'technical_only' && provenance.snapshot?.rigorousEligible !== false;
    return { payload, declared, snapshotVerified: provenance.snapshot != null };
  } catch { return { reason: 'invalid_payload_identity_or_time' }; }
}
function resultIssue(row, cutoff) {
  if (row.evidence_id == null) return 'missing_or_unconfirmed_result';
  try {
    if (!Number.isSafeInteger(row.home_goals) || !Number.isSafeInteger(row.away_goals) || row.home_goals < 0 || row.away_goals < 0
      || storedTime(row.observed_at) <= storedTime(row.kickoff_at) || storedTime(row.observed_at) > timestamp(cutoff)
      || storedTime(row.recorded_at) > timestamp(cutoff) || typeof row.source !== 'string' || !PUBLIC_ID.test(row.source)) return 'invalid_result';
  } catch { return 'invalid_result'; }
  return null;
}
function stageValue(payload, stage, side) { const p = payload.stages?.[stage]?.value?.[side]; return validProbability(p) ? p : null; }
function hasPair(row, stage) { return ['over', 'under'].every(side => stageValue(row.payload, stage, side) !== null); }
function observation(row, stage, side) { return { probability: stageValue(row.payload, stage, side), outcome: side === 'over' ? row.over : 1 - row.over }; }
// stateHash includes the fixture/request and is NOT a model-version grouping key.
function versionOf(payload) { return { version: payload.model.version, codeHash: payload.model.codeHash, configHash: payload.model.configHash }; }
function grouped(rows, key, describe) {
  const groups = new Map();
  for (const row of rows) { const value = key(row); if (!groups.has(value)) groups.set(value, []); groups.get(value).push(row); }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([group, values]) => ({ group, ...describe(values) }));
}
function stageScores(rows, stage) {
  const metrics = subset => Object.fromEntries(['over', 'under'].map(side => [side, summarize(subset.filter(row => stageValue(row.payload, stage, side) !== null).map(row => observation(row, stage, side)))]));
  return { ...metrics(rows), byLeague: grouped(rows, r => r.payload.competition, metrics),
    byVersion: grouped(rows, r => canonical(versionOf(r.payload)), metrics) };
}
function quoteEligible(payload, options) {
  if (!options.quoteMaxAgeMs) return false;
  return ['over25', 'under25'].every(selection => (payload.quotes ?? []).some(quote => {
    try {
      const at = storedTime(payload.inputAsOf), captured = storedTime(quote.capturedAt), updated = storedTime(quote.updatedAt);
      return quote.selection === selection && quote.provider === 'odds_api' && typeof quote.bookmaker === 'string' && quote.bookmaker.trim()
        && typeof quote.odds === 'number' && Number.isFinite(quote.odds) && quote.odds > 1
        && updated <= captured && captured <= at && at - updated <= options.quoteMaxAgeMs;
    } catch { return false; }
  }));
}
function comparison(rows, from, to, seed, selectionOnly = false) {
  const stats = subset => Object.fromEntries(['over', 'under'].map(side => {
    const eligible = subset.filter(r => (!selectionOnly || r.payload.selected?.selection === `${side}25`)
      && stageValue(r.payload, from, side) !== null && stageValue(r.payload, to, side) !== null);
    const paired = eligible.map(r => {
      const a = loss(stageValue(r.payload, from, side), side === 'over' ? r.over : 1 - r.over);
      const b = loss(stageValue(r.payload, to, side), side === 'over' ? r.over : 1 - r.over);
      return { league: r.payload.competition, week: utcWeek(r.kickoff_at), brier: b.brier - a.brier, logLoss: b.logLoss - a.logLoss };
    });
    return [side, blockBootstrap(paired, seed)];
  }));
  return { from, to, direction: 'to_minus_from_negative_favors_to', matchCount: rows.length, ...stats(rows),
    byLeague: grouped(rows, r => r.payload.competition, stats), byVersion: grouped(rows, r => canonical(versionOf(r.payload)), stats) };
}

/** Inputs are the FIRST candidates emitted by canonical SQL, never a fallback forecast. */
function evaluateRows(technicalRows, strictRows, input, metadata = {}) {
  const options = optionsFor(input), exclusions = {}, increments = reason => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const strictIds = new Set(strictRows.map(row => row.id)), validRows = [], missingStage = {};
  let invalid = 0, technicalTemporal = 0, missingResults = 0, snapshotUnverifiable = 0;
  for (const row of technicalRows) {
    const parsed = forecastIssue(row, options, metadata.scope);
    if (parsed.reason) { increments(parsed.reason); invalid++; continue; }
    if (!parsed.declared) technicalTemporal++;
    if (!parsed.snapshotVerified) snapshotUnverifiable++;
    const resultReason = resultIssue(row, options.cutoff);
    if (resultReason) missingResults++;
    if (options.mode === 'strict' && !parsed.snapshotVerified) { increments('input_snapshot_not_verifiable'); continue; }
    if (options.mode === 'strict' && (!strictIds.has(row.id) || !parsed.declared)) { increments('strict_temporal_gate_excluded'); continue; }
    if (resultReason) { increments(resultReason); continue; }
    const item = { ...row, payload: parsed.payload, over: row.home_goals + row.away_goals >= 3 ? 1 : 0 };
    validRows.push(item);
    for (const stage of STAGES) for (const side of ['over', 'under']) if (stageValue(item.payload, stage, side) === null) {
      const key = `${stage}.${side}`; missingStage[key] = (missingStage[key] ?? 0) + 1;
    }
  }
  const primary = validRows.filter(row => ['ensembleRaw', 'contextual', 'calibrated'].every(stage => hasPair(row, stage)));
  const contextualCalibrated = validRows.filter(row => ['contextual', 'calibrated'].every(stage => hasPair(row, stage)));
  const blendStages = validRows.filter(row => ['calibrated', 'marketBlended'].every(stage => hasPair(row, stage)));
  const blending = blendStages.filter(row => quoteEligible(row.payload, options));
  const decision = blending.filter(row => ['over25', 'under25'].includes(row.payload.selected?.selection)
    && stageValue(row.payload, 'decision', row.payload.selected.selection === 'over25' ? 'over' : 'under') !== null);
  const selected = validRows.filter(row => ['over25', 'under25'].includes(row.payload.selected?.selection));
  const exact = selected.filter(row => validProbability(row.payload.selected.exactProbability) && validProbability(row.payload.selected.probability)
    && Math.abs(Number((row.payload.selected.exactProbability * 100).toFixed(2)) / 100 - row.payload.selected.probability) <= 2 * Number.EPSILON);
  const primaryLeagues = Object.fromEntries(LEAGUES.map(league => [league, primary.filter(row => row.payload.competition === league).length]));
  const weeks = new Set(primary.map(row => utcWeek(row.kickoff_at))).size;
  let deadline = null;
  if (options.studyStartedAt) { const date = new Date(options.studyStartedAt); date.setUTCMonth(date.getUTCMonth() + 18); deadline = date.toISOString(); }
  const rowDigest = sha256(canonical(technicalRows.map(row => ({ id: row.id, digest: sha256(canonical(row)) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  return { schema: 'model-a-prospective-evaluation-v1', mode: options.mode,
    scientificStatus: { validationStatisticallyConcluded: false, eligibility: options.mode === 'technical' ? 'technical_descriptive_only' : 'declared_eligible_independent_attestation_unverified',
      methodologyEvidenceRequired: true, thresholdsArePowerGuarantee: false },
    scope: { cutoff: options.cutoff, origin: options.origin, protocolId: options.protocolId ?? null, manifestSha256: options.manifestSha256 ?? null },
    configuration: { outcome: 'over25_equals_total_goals_at_least_3', epsilon: EPSILON, deciles: 'left_closed_right_open_last_includes_1',
      bootstrapReplicas: REPLICAS, bootstrapSeed: options.seed, blocks: 'league_and_monday_utc_kickoff_week', quoteMaxAgeMs: options.quoteMaxAgeMs ?? null,
      pooledVersions: 'descriptive_only_also_reported_separately', studyStartedAt: options.studyStartedAt ?? null,
      studyStartEvidence: options.studyStartedAt ? 'explicit_operator_metadata_not_independently_verified' : 'absent_no_inferred_start' },
    provenance: { sqlHashes: metadata.sqlHashes ?? null, selectedRowsDigest: rowDigest, evaluatorCodeHash: sha256(fs.readFileSync(__filename)),
      statisticsCodeHash: sha256(fs.readFileSync(path.join(__dirname, 'model-a-prospective-statistics.js'))), reads: 'sequential_selects_not_atomic_historical_snapshot' },
    denominators: { scopedForecastRows: metadata.scopedForecastRows ?? null, scopedMatches: metadata.scopedMatches ?? null,
      scopedWindowForecastRows: metadata.scopedWindowForecastRows ?? null,
      forecastRowsOutsideWindow: metadata.scopedForecastRows == null ? null : metadata.scopedForecastRows - metadata.scopedWindowForecastRows,
      laterForecastRowsNotSelected: metadata.scopedWindowForecastRows == null ? null : metadata.scopedWindowForecastRows - technicalRows.length,
      scopedMatchesWithoutWindowCandidate: metadata.scopedMatches == null ? null : metadata.scopedMatches - technicalRows.length,
      firstForecastCandidates: technicalRows.length, strictSqlDeclaredCandidates: strictRows.length, invalidCandidates: invalid,
      temporalTechnicalOrUnverified: technicalTemporal, inputSnapshotNotAvailableForHashCheck: snapshotUnverifiable,
      missingOrInvalidResultsAmongValidCandidates: missingResults, scoredMatches: validRows.length },
    exclusions, missingStageProbabilities: { denominator: validRows.length, counts: missingStage },
    versionHistory: grouped(validRows, r => canonical(versionOf(r.payload)), subset => ({ count: subset.length,
      distinctForecastStateHashes: new Set(subset.map(r => r.payload.model.stateHash)).size,
      firstForecastAt: new Date(Math.min(...subset.map(r => storedTime(r.forecast_at)))).toISOString(),
      lastForecastAt: new Date(Math.max(...subset.map(r => storedTime(r.forecast_at)))).toISOString(),
      utcWeeks: grouped(subset, r => utcWeek(r.kickoff_at), values => ({ count: values.length })) })),
    stages: Object.fromEntries(STAGES.map(stage => [stage, stageScores(validRows, stage)])),
    comparisons: { initialScoredMatches: validRows.length, primaryMissingRequiredStages: validRows.length - primary.length,
      primary: { ensembleRawToContextual: comparison(primary, 'ensembleRaw', 'contextual', options.seed), contextualToCalibrated: comparison(primary, 'contextual', 'calibrated', options.seed) },
      secondaryContextualToCalibrated: comparison(contextualCalibrated, 'contextual', 'calibrated', options.seed),
      blendingMissingStages: validRows.length - blendStages.length, blendingWithoutVerifiableRealPrices: blendStages.length - blending.length,
      calibratedToMarketBlended: comparison(blending, 'calibrated', 'marketBlended', options.seed),
      marketBlendedToDecisionSelectedOnly: comparison(decision, 'marketBlended', 'decision', options.seed, true) },
    selected: { denominator: validRows.length, overUnderSelections: selected.length, noOverUnderSelection: validRows.length - selected.length,
      abstentions: validRows.filter(row => row.payload.selected == null).length, otherMarketSelections: validRows.filter(row => row.payload.selected != null && !['over25', 'under25'].includes(row.payload.selected.selection)).length,
      exactUnavailableOrInconsistentWithRecordedRounding: selected.length - exact.length, exact: summarize(exact.map(row => ({ probability: row.payload.selected.exactProbability,
        outcome: row.payload.selected.selection === 'over25' ? row.over : 1 - row.over }))),
      interpretation: 'selected_opportunities_do_not_represent_all_matches_decision_stage_keeps_its_recorded_precision' },
    readiness: { primaryPairedMatches: primary.length, primaryByLeague: primaryLeagues, primaryUtcWeeks: weeks,
      targetMatches: 1000, targetEachLeague: 100, targetUtcWeeks: 12,
      practicalTargetsReached: primary.length >= 1000 && LEAGUES.every(league => primaryLeagues[league] >= 100) && weeks >= 12,
      eighteenMonthDeadline: deadline, eighteenMonthsElapsed: deadline ? timestamp(options.cutoff) >= timestamp(deadline) : null,
      permitsAutomaticConclusion: false },
    limitations: ['Strict SQL tests declarations; hashes and local clocks do not attest historical input availability or training genealogy.',
      'Current producers are technical_only; missing ensembleRaw and marketBlended are never reconstructed.',
      'Under probabilities are scored as recorded; no complement is imputed.',
      'Missing or blocked results are excluded, never treated as losses; canonical SQL chooses the first forecast before eligibility.',
      'Understat outcomes are statistical observations, not independently certified official results.',
      'League and version comparisons are exploratory; bootstrap intervals cannot repair timing or selection bias.',
      'No model, calibration, weights, selection, temporal classification or collection is changed.'] };
}

async function evaluateProspective(client, input) {
  const options = optionsFor(input), scope = await registeredManifest(client, options), sql = canonicalQueries();
  const args = { cutoff: options.cutoff, origin: options.origin, protocol_id: options.protocolId ?? null };
  // Invalid JSON cannot safely pass the immutable canonical SQL. Stop with a redacted code.
  const invalid = await read(client, 'SELECT COUNT(*) AS count FROM model_a_prospective_forecasts WHERE NOT json_valid(payload_json)');
  if (Number(invalid[0]?.count)) fail('invalid_json_prevents_canonical_export');
  const denominator = await read(client, `SELECT COUNT(*) AS forecasts,COUNT(DISTINCT match_id) AS matches,
    SUM(CASE WHEN julianday(forecast_at)>=julianday(kickoff_at)-1 AND julianday(forecast_at)<=julianday(kickoff_at)-1.0/24 THEN 1 ELSE 0 END) AS window_forecasts
    FROM model_a_prospective_forecasts
    WHERE json_extract(payload_json,'$.origin')=:origin AND julianday(forecast_at)<=julianday(:cutoff)
    AND ((:origin='prospective_a' AND json_extract(payload_json,'$.collection.protocolId')=:protocol_id) OR (:origin<>'prospective_a' AND :protocol_id IS NULL))`, args);
  const technical = await read(client, sql.technical, args), strict = await read(client, sql.strict, args);
  return evaluateRows(technical, strict, options, { scope, scopedForecastRows: Number(denominator[0]?.forecasts ?? 0), scopedMatches: Number(denominator[0]?.matches ?? 0),
    scopedWindowForecastRows: Number(denominator[0]?.window_forecasts ?? 0),
    sqlHashes: Object.fromEntries(Object.entries(sql).map(([key, query]) => [key, sha256(query)])) });
}

function localDatabasePath(value) {
  if (typeof value !== 'string' || !value.startsWith('file:') || /[?#\0]/.test(value)) fail('existing_local_file_url_required');
  let filename;
  try { const url = new URL(value); if (url.hostname || url.username || url.password) fail('unsafe_database_url'); filename = fileURLToPath(url); }
  catch { fail('unsafe_database_url'); }
  const resolved = path.resolve(filename);
  if (resolved.startsWith('\\\\') || resolved.startsWith('//')) fail('unsafe_database_path');
  let current = resolved;
  for (;;) { if (fs.lstatSync(current).isSymbolicLink()) fail('unsafe_database_path'); const parent = path.dirname(current); if (parent === current) break; current = parent; }
  if (!fs.statSync(resolved).isFile()) fail('existing_database_file_required');
  return resolved;
}
async function openClient(options, env) {
  if (!options.remote) {
    const filename = localDatabasePath(options.dbUrl), [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || major === 22 && minor < 13) fail('local_read_only_requires_node_22_13');
    const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(filename, { readOnly: true });
    return { async execute({ sql, args }) { selectOnly(sql); return { rows: db.prepare(sql).all(args) }; }, close() { db.close(); } };
  }
  if (options.dbUrl) fail('remote_credentials_environment_only');
  let url;
  try { url = new URL(env.TURSO_DATABASE_URL); } catch { fail('remote_configuration_required'); }
  if (!['libsql:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) fail('unsafe_database_url');
  if (!env.TURSO_AUTH_TOKEN) fail('remote_configuration_required');
  const { createClient } = require('@libsql/client');
  return createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
}
const HELP = `Read-only Model A prospective evaluation (aggregate JSON only).
Local Node >=22.13:
  node backend/scripts/model-a-prospective-evaluate.js --db-url file:///absolute/study.db --cutoff 2026-11-05T12:00:00Z --origin prospective_a --protocol-id STUDY --manifest-sha256 SHA256 [--mode strict|technical]
Other origins: direct_a|shared_ac|internal require no protocol/manifest.
Default mode: strict. Technical mode is descriptive and never promotes records.
Optional: --seed UINT32 --study-started-at UTC --quote-max-age-ms INTEGER --output NEW_FILE
Remote opt-in: --remote-read-only (TURSO_DATABASE_URL/TURSO_AUTH_TOKEN already set privately; no --db-url).
Remote uses raw client and SELECT only; actual credential permissions remain the operator's responsibility.
Output creation is exclusive. No dotenv, providers, bootstrap, migrations, model changes or writes to the database.\n`;
function parseArgs(argv) {
  const options = {}, names = { '--db-url': 'dbUrl', '--cutoff': 'cutoff', '--origin': 'origin', '--protocol-id': 'protocolId', '--manifest-sha256': 'manifestSha256',
    '--mode': 'mode', '--seed': 'seed', '--study-started-at': 'studyStartedAt', '--quote-max-age-ms': 'quoteMaxAgeMs', '--output': 'output' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') { options.help = true; continue; }
    if (arg === '--remote-read-only') { if (options.remote) fail('duplicate_argument'); options.remote = true; continue; }
    const name = names[arg];
    if (!name || options[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('invalid_cli_arguments');
    options[name] = argv[++i];
  }
  for (const key of ['seed', 'quoteMaxAgeMs']) if (options[key] !== undefined) { if (!/^\d+$/.test(options[key])) fail('invalid_numeric_argument'); options[key] = Number(options[key]); }
  return options;
}
async function main(argv = process.argv.slice(2), env = process.env) {
  let client;
  try {
    const options = parseArgs(argv);
    if (options.help) { process.stdout.write(HELP); return 0; }
    optionsFor(options);
    if (options.output && fs.existsSync(options.output)) fail('output_already_exists');
    client = await openClient(options, env);
    const result = await evaluateProspective(client, options), json = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) fs.writeFileSync(options.output, json, { flag: 'wx', mode: 0o600 }); else process.stdout.write(json);
    return 0;
  } catch (error) {
    // Never print a driver message: it can contain URL, token, SQL or input payload.
    const allowed = error?.code && /^[a-z0-9_]+$/.test(error.code) ? error.code : 'evaluation_failed';
    process.stdout.write(`${JSON.stringify({ schema: 'model-a-prospective-evaluation-v1', error: allowed, validationStatisticallyConcluded: false })}\n`); return 1;
  } finally { if (client) client.close(); }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { evaluateProspective, evaluateRows, canonical, canonicalQueries, optionsFor, selectOnly, localDatabasePath, openClient, parseArgs, main };
