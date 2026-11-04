const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { localDatabasePath } = require('../scripts/model-a-prospective-inspect');
const { evaluate, main: checkMonitoring } = require('../scripts/check-model-a-prospective');
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || (major === 22 && minor >= 13);
const test = (name, fn) => nodeTest(name, { skip: supported ? false : 'Read-only inspector requires Node >=22.13; backend Node 20 remains supported.' }, fn);

// The actual CLI is a short-lived operator process; process isolation also releases
// native SQLite statement handles deterministically before Windows temp cleanup.
function inspect(config, environment) {
  const names = { dbUrl: '--db-url', competition: '--competition', season: '--season', from: '--from', to: '--to', cutoff: '--cutoff', origin: '--origin', spoolDir: '--spool-dir', protocolId: '--protocol-id' };
  const args = Object.entries(config).flatMap(([key, value]) => [names[key], value]);
  const child = spawnSync(process.execPath, [path.join(__dirname, '../scripts/model-a-prospective-inspect.js'), ...args],
    { env: { ...process.env, MODEL_A_PROSPECTIVE_ENABLED: '', MODEL_A_PROSPECTIVE_ALLOW_VOLATILE: '', ...environment }, encoding: 'utf8' });
  assert.ok(child.status === 0 || child.status === 1, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.error, undefined, child.stdout);
  return result;
}

function createLocalClient(url) {
  const run = (statement, multiple) => {
    const source = `const {createClient}=require('@libsql/client');
      const fs=require('node:fs');
      (async()=>{const c=createClient({url:process.argv[1]});try{
        const input=JSON.parse(fs.readFileSync(0,'utf8'));
        if(input.multiple)await c.executeMultiple(input.statement);else await c.execute(input.statement);
      }finally{c.close();}})().catch(()=>{process.exitCode=1});`;
    const result = spawnSync(process.execPath, ['-e', source, url], { input: JSON.stringify({ statement, multiple }), encoding: 'utf8', cwd: path.join(__dirname, '..') });
    assert.equal(result.status, 0, result.stderr);
  };
  return { execute: statement => run(statement, false), executeMultiple: statement => run(statement, true), close() {} };
}

const kickoff = '2026-11-04T18:00:00.000Z';
const options = { competition: 'Test', season: '2026/27', from: '2026-11-04T00:00:00Z', to: '2026-11-07T00:00:00Z',
  cutoff: '2026-11-04T19:00:00Z', origin: 'direct_a' };
async function fixture(t, schema = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-a-inspect-')), filename = path.join(dir, 'test.db');
  const client = createLocalClient(pathToFileURL(filename).href);
  await client.execute('CREATE TABLE matches (match_id TEXT PRIMARY KEY, competition TEXT, season TEXT, date TEXT)');
  if (schema) await client.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
  const f = { dir, filename, client, options: { ...options, dbUrl: pathToFileURL(filename).href } };
  t.after(async () => {
    f.client.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(path.resolve(dir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}model-a-inspect-`));
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}
async function match(f, id, date = kickoff, competition = 'Test') {
  await f.client.execute({ sql: 'INSERT INTO matches VALUES (?,?,?,?)', args: [id, competition, '2026/27', date] });
}
function forecast(id, matchId, overrides = {}) {
  const snapshot = { a: 1 }, inputSnapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return { schema: 'model-a-operational-prospective-v1', family: 'A', id, matchId, competition: 'Test', season: '2026/27',
    forecastAt: '2026-11-04T12:00:00.000Z', kickoffAt: kickoff, origin: 'direct_a',
    provenance: { snapshot, inputSnapshotHash, inputAvailableThrough: null }, ...overrides };
}
async function store(f, payload) {
  await f.client.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)',
    args: [payload.id, payload.matchId, payload.forecastAt, payload.kickoffAt, JSON.stringify(payload)] });
}

test('coverage uses the configured fixture denominator, origin, window and cutoff without inventing requests', async t => {
  const f = await fixture(t);
  for (const id of ['present', 'missing', 'wrong-origin', 'late', 'changed']) await match(f, id);
  await match(f, 'open', '2026-11-05T18:00:00Z');
  await match(f, 'future', '2026-11-06T18:00:00Z');
  await match(f, 'other-competition', kickoff, 'Other');
  await match(f, 'outside-scope', '2026-11-08T18:00:00Z');
  await store(f, forecast('b', 'present'));
  await store(f, forecast('a', 'present'));
  await store(f, forecast('wrong', 'wrong-origin', { origin: 'shared_ac' }));
  await store(f, forecast('late', 'late', { forecastAt: '2026-11-04T17:30:00Z' }));
  await store(f, forecast('changed', 'changed', { kickoffAt: '2026-11-04T19:00:00Z' }));
  await store(f, forecast('outside', 'outside-scope', { kickoffAt: '2026-11-08T18:00:00Z' }));
  f.client.close();
  const before = fs.readFileSync(f.filename), filesBefore = fs.readdirSync(f.dir);
  const report = inspect(f.options, {});
  assert.equal(report.schema.compatible, true);
  assert.equal(report.coverage.calendarEvaluable, true);
  assert.equal(report.coverage.coverageEvaluable, true);
  assert.equal(report.mode, 'local_read_only');
  assert.deepEqual(fs.readFileSync(f.filename), before);
  assert.deepEqual(fs.readdirSync(f.dir), filesBefore);
  assert.equal(report.coverage.fixtureMatches, 7);
  assert.equal(report.coverage.overdueFixtures, 5);
  assert.equal(report.coverage.overdueMissing, 4);
  assert.equal(report.coverage.openWindowFixtures, 1);
  assert.equal(report.coverage.futureWindowFixtures, 1);
  assert.equal(report.coverage.recordedForecasts, 4);
  assert.equal(report.coverage.recordedMatchesInWindow, 1);
  assert.equal(report.coverage.outsideWindowForecasts, 1);
  assert.equal(report.coverage.kickoffConflicts, 1);
  assert.equal(report.coverage.nonEvaluableProvenance, 1);
  assert.equal(report.coverage.provenanceReasons.input_availability_unverified, 1);
  assert.equal(report.configuration.writeAccessTested, false);
  assert.equal(report.configuration.runtimeEnvironmentVerified, false);
  assert.equal(JSON.stringify(report).includes(f.filename), false);
});

test('calendar-only storage reports scoped windows without inventing forecast coverage or applying schema', async t => {
  const f = await fixture(t, false);
  await match(f, 'overdue');
  await match(f, 'open', '2026-11-05T18:00:00Z');
  await match(f, 'future', '2026-11-06T18:00:00Z');
  await match(f, 'outside', '2026-11-08T18:00:00Z');
  await match(f, 'other', kickoff, 'Other');
  await match(f, 'invalid', 'not-a-timestamp');
  f.client.close();
  const before = fs.readFileSync(f.filename), filesBefore = fs.readdirSync(f.dir);
  const report = inspect(f.options, {});
  assert.equal(report.schema.compatible, false);
  assert.equal(report.coverage.calendarEvaluable, true);
  assert.equal(report.coverage.coverageEvaluable, false);
  assert.deepEqual(report.coverage.storageStatus, { calendar: 'available', forecasts: 'missing', results: 'missing' });
  assert.equal(report.coverage.fixtureMatches, 3);
  assert.equal(report.coverage.overdueFixtures, 1);
  assert.equal(report.coverage.openWindowFixtures, 1);
  assert.equal(report.coverage.futureWindowFixtures, 1);
  assert.equal(report.coverage.invalidFixtureTimesInCompetitionSeason, 1);
  for (const name of ['overdueMissing', 'openWindowMissing', 'receivedForecastEvidence', 'recordedForecasts', 'recordedMatchesInWindow',
    'pendingUnconfirmedForecasts', 'pendingAlreadyRecordedForecasts', 'nonEvaluableProvenance']) assert.equal(report.coverage[name], null, name);
  assert.ok(report.schema.issues.includes('missing_table:model_a_prospective_forecasts'));
  assert.deepEqual(fs.readFileSync(f.filename), before);
  assert.deepEqual(fs.readdirSync(f.dir), filesBefore);
});

test('missing results storage preserves measured forecast coverage without certifying full schema or official results', async t => {
  const f = await fixture(t);
  await match(f, 'present'); await match(f, 'missing');
  await store(f, forecast('present', 'present'));
  await f.client.execute('DROP TABLE model_a_prospective_results');
  f.client.close();
  const before = fs.readFileSync(f.filename);
  const report = inspect(f.options, {});
  assert.equal(report.schema.compatible, false);
  assert.equal(report.coverage.coverageEvaluable, true);
  assert.deepEqual(report.coverage.storageStatus, { calendar: 'available', forecasts: 'available', results: 'missing' });
  assert.equal(report.coverage.fixtureMatches, 2);
  assert.equal(report.coverage.recordedForecasts, 1);
  assert.equal(report.coverage.recordedMatchesInWindow, 1);
  assert.equal(report.coverage.overdueMissing, 1);
  assert.equal(report.coverage.nonEvaluableProvenance, 1);
  assert.deepEqual(fs.readFileSync(f.filename), before);
  assert.ok(report.schema.issues.includes('missing_table:model_a_prospective_results'));
});

test('malformed calendar columns are diagnosed without querying unavailable fields or inventing counts', async t => {
  const f = await fixture(t);
  await f.client.execute('DROP TABLE matches');
  await f.client.execute('CREATE TABLE matches (match_id TEXT PRIMARY KEY, competition TEXT, season TEXT)');
  await f.client.execute("INSERT INTO matches VALUES ('unknown-time','Test','2026/27')");
  f.client.close();
  const before = fs.readFileSync(f.filename);
  const report = inspect(f.options, {});
  assert.equal(report.schema.compatible, false);
  assert.equal(report.schema.tables.matches.readable, false);
  assert.equal(report.coverage.calendarEvaluable, false);
  assert.equal(report.coverage.coverageEvaluable, false);
  assert.equal(report.coverage.storageStatus.calendar, 'incompatible');
  assert.ok(report.schema.issues.includes('missing_column:matches.date'));
  for (const name of ['fixtureMatches', 'overdueFixtures', 'openWindowFixtures', 'futureWindowFixtures', 'overdueMissing',
    'recordedForecasts', 'recordedMatchesInWindow']) assert.equal(report.coverage[name], null, name);
  assert.deepEqual(fs.readFileSync(f.filename), before);
});

test('unverified schema guards remain reported separately from readable forecast coverage', async t => {
  const f = await fixture(t);
  await match(f, 'present'); await store(f, forecast('present', 'present'));
  await f.client.execute('DROP TRIGGER model_a_prospective_no_update');
  await f.client.execute("CREATE TRIGGER model_a_prospective_no_update BEFORE UPDATE ON model_a_prospective_forecasts WHEN 0 BEGIN SELECT RAISE(ABORT, 'fake'); END");
  f.client.close();
  const report = inspect(f.options, {});
  assert.equal(report.schema.compatible, false);
  assert.equal(report.coverage.coverageEvaluable, true);
  assert.equal(report.coverage.recordedMatchesInWindow, 1);
  assert.ok(report.schema.issues.includes('missing_or_unverified_trigger:model_a_prospective_no_update'));
});

test('spool diagnostics distinguish pending confirmations, corrupt files and audit events without writing', async t => {
  const f = await fixture(t), spoolDir = path.join(f.dir, 'spool');
  fs.mkdirSync(spoolDir);
  await match(f, 'pending'); await match(f, 'already-stored');
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  for (let i = 0; i < ids.length; i++) {
    const payload = forecast(ids[i], i === 0 ? 'pending' : 'already-stored');
    fs.writeFileSync(path.join(spoolDir, `${ids[i]}.json`), JSON.stringify({ id: payload.id, matchId: payload.matchId,
      forecastAt: payload.forecastAt, kickoffAt: payload.kickoffAt, payload: JSON.stringify(payload), durable: true }));
    if (i === 1) await store(f, payload);
  }
  fs.writeFileSync(path.join(spoolDir, 'bad.json'), '{}');
  fs.writeFileSync(path.join(spoolDir, 'pending.json.partial'), 'partial');
  fs.writeFileSync(path.join(spoolDir, 'audit.ndjson'), [
    JSON.stringify({ at: '2026-11-04T12:00:00Z', type: 'attempted', matchId: 'pending' }),
    JSON.stringify({ at: '2026-11-04T12:00:00Z', type: 'accepted', id: ids[0] }),
    JSON.stringify({ at: '2026-11-04T20:00:00Z', type: 'stored', id: ids[0] }),
    'invalid', '{"unterminated":true}',
  ].join('\n'));
  const filesBefore = fs.readdirSync(spoolDir);
  f.client.close();
  const report = inspect({ ...f.options, spoolDir }, { MODEL_A_PROSPECTIVE_ENABLED: 'true', MODEL_A_PROSPECTIVE_ALLOW_VOLATILE: 'true' });
  assert.equal(report.spool.pendingFiles, 3);
  assert.equal(report.spool.invalidFiles, 1);
  assert.equal(report.spool.partialFiles, 1);
  assert.equal(report.spool.audit.invalidLines, 2);
  assert.equal(report.spool.audit.afterCutoff, 1);
  assert.deepEqual(report.spool.audit.counts, { attempted: 1, accepted: 1 });
  assert.equal(report.coverage.pendingUnconfirmedForecasts, 1);
  assert.equal(report.coverage.pendingAlreadyRecordedForecasts, 1);
  assert.equal(report.coverage.receivedForecastEvidence, 2);
  assert.equal(report.coverage.recordedForecasts, 1);
  assert.equal(report.coverage.overdueMissing, 1);
  assert.equal(report.configuration.volatileAllowedInInspectorEnvironment, true);
  assert.deepEqual(fs.readdirSync(spoolDir), filesBefore);
  assert.equal(JSON.stringify(report).includes(ids[0]), false);
});

test('rejects remote/credential URLs, missing files, symlinks and unsafe arguments with redacted errors', async t => {
  const f = await fixture(t), missing = path.join(f.dir, 'missing.db');
  for (const value of ['libsql://user:secret@example.com', 'https://secret@example.com', `${f.options.dbUrl}?authToken=secret`, 'file::memory:', 'file://server/share/test.db']) {
    assert.throws(() => localDatabasePath(value));
  }
  assert.throws(() => localDatabasePath(pathToFileURL(missing).href));
  assert.equal(fs.existsSync(missing), false);
  const link = path.join(f.dir, 'link');
  fs.symlinkSync(f.dir, link, 'junction');
  assert.throws(() => localDatabasePath(pathToFileURL(path.join(link, 'test.db')).href), /symlink/);
  const child = spawnSync(process.execPath, [path.join(__dirname, '../scripts/model-a-prospective-inspect.js'), '--db-url', 'libsql://user:secret@example.com',
    '--competition', 'Test', '--season', '2026/27', '--from', options.from, '--to', options.to, '--cutoff', options.cutoff, '--origin', options.origin], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.equal(child.stdout.includes('secret'), false);
  assert.equal(JSON.parse(child.stdout).error, 'local_file_url_required');
  assert.equal(child.stderr.includes('secret'), false);
});

test('provenance is not evaluable when snapshot hash fails or availability is future', async t => {
  const f = await fixture(t);
  await match(f, 'hash'); await match(f, 'future'); await match(f, 'numeric');
  const hash = forecast('hash', 'hash'); hash.provenance.inputSnapshotHash = 'wrong';
  const future = forecast('future', 'future'); future.provenance.inputAvailableThrough = '2026-11-04T13:00:00Z';
  const numeric = forecast('numeric', 'numeric');
  numeric.provenance.snapshot = { z: { '10': 1, '2': 2 }, a: ['first', { c: 1, b: 2 }] };
  const ordered = { a: ['first', { b: 2, c: 1 }], z: { '2': 2, '10': 1 } };
  numeric.provenance.inputSnapshotHash = createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
  await store(f, hash); await store(f, future); await store(f, numeric);
  f.client.close();
  const result = inspect(f.options, {}).coverage;
  assert.equal(result.nonEvaluableProvenance, 3);
  assert.deepEqual(result.provenanceReasons, { input_snapshot_hash_mismatch: 1, input_timestamp_after_forecast: 1, input_availability_unverified: 1 });
});

test('technical-only classification never becomes rigorously eligible through a populated availability field', async t => {
  const f = await fixture(t); await match(f, 'technical');
  const payload = forecast('technical', 'technical');
  payload.provenance.classification = 'technical_only';
  payload.provenance.rigorousEligible = false;
  payload.provenance.inputAvailableThrough = payload.forecastAt;
  await store(f, payload);
  const report = inspect(f.options, {});
  assert.deepEqual(report.coverage.temporalClassificationCounts, { technical_only: 1 });
  assert.deepEqual(report.coverage.provenanceReasons, { technical_only: 1 });
  assert.equal(report.coverage.nonEvaluableProvenance, 1);
});

test('late delivery is counted from current storage without claiming persistence or coverage at cutoff', async t => {
  const f = await fixture(t), spoolDir = path.join(f.dir, 'spool');
  const oldKickoff = '2020-01-02T18:00:00.000Z';
  const historicalScope = { ...f.options, from: '2020-01-02T00:00:00Z', to: '2020-01-03T00:00:00Z', cutoff: '2020-01-02T19:00:00Z', spoolDir };
  fs.mkdirSync(spoolDir);
  await match(f, 'delayed', oldKickoff);
  const before = inspect(historicalScope, {});
  assert.equal(before.coverage.recordedForecasts, 0);
  assert.equal(before.coverage.overdueMissing, 1);
  const deliveredAt = new Date().toISOString();
  await store(f, forecast('delayed', 'delayed', { kickoffAt: oldKickoff, forecastAt: '2020-01-02T12:00:00.000Z' }));
  fs.writeFileSync(path.join(spoolDir, 'audit.ndjson'), `${JSON.stringify({ type: 'stored', id: 'delayed', at: deliveredAt })}\n`);
  const after = inspect(historicalScope, {});
  assert.equal(after.coverage.recordedForecasts, 1);
  assert.equal(after.coverage.recordedMatchesInWindow, 1);
  assert.equal(after.coverage.overdueMissing, 0);
  assert.equal(after.spool.audit.afterCutoff, 1);
  assert.ok(Date.parse(after.measuredAt) >= Date.parse(deliveredAt));
  assert.equal(after.timeSemantics.historicalSnapshot, false);
  assert.equal(after.timeSemantics.databaseInsertionAsOfCutoffVerified, false);
  assert.equal(after.timeSemantics.forecastRows, 'currently_present_rows_filtered_by_forecast_at_lte_cutoff');
  assert.match(after.timeSemantics.audit, /not_proven_write_time/);
  assert.match(after.coverage.scope.cutoffPurpose, /not_database_insertion_time/);
  assert.ok(after.limitations.some(value => value.includes('A forecast delivered after cutoff is counted if present now')));
});

nodeTest('monitoring is off before argument parsing, credentials or database access', () => {
  const output = [];
  const code = checkMonitoring(['--db-url', 'libsql://secret@remote'], { MODEL_A_PROSPECTIVE_MONITORING_ENABLED: 'false' }, report => output.push(report));
  assert.equal(code, 0);
  assert.deepEqual(output, [{ enabled: false, status: 'disabled', alerts: [] }]);
});

test('enabled monitoring fails closed on absent schema and an empty configured calendar', async t => {
  const f = await fixture(t, false);
  const report = inspect({ ...f.options, origin: 'prospective_a', protocolId: 'test-protocol' }, {});
  assert.equal(report.collector.analyzedFixtures, null);
  assert.equal(report.results.pendingForecasts, null);
  const monitoring = evaluate(report);
  assert.equal(monitoring.status, 'critical');
  const codes = monitoring.alerts.map(alert => alert.code);
  for (const code of ['schema_unverified', 'calendar_unverifiable', 'collector_scope_unverified', 'unanalyzed_fixtures', 'collector_stale', 'results_unverifiable']) assert.ok(codes.includes(code), code);
  const output = [];
  assert.equal(checkMonitoring(['--db-url', 'libsql://user:secret@remote', '--competition', 'Test', '--season', '2026/27', '--from', options.from,
    '--to', options.to, '--cutoff', options.cutoff, '--origin', 'prospective_a'], { MODEL_A_PROSPECTIVE_MONITORING_ENABLED: 'true' }, report => output.push(report)), 1);
  assert.equal(output[0].error, 'local_file_url_required');
  assert.equal(JSON.stringify(output).includes('secret'), false);
});

async function registerCollector(f, state = 'stored') {
  // These are collector-only manual tables, never created by the inspector.
  await f.client.executeMultiple(`CREATE TABLE IF NOT EXISTS model_a_collection_runs(run_id TEXT PRIMARY KEY,protocol_id TEXT,started_at TEXT,completed_at TEXT,status TEXT,error_code TEXT,examined INTEGER,claimed INTEGER);
    CREATE TABLE IF NOT EXISTS model_a_prospective_result_observations(evidence_id TEXT PRIMARY KEY,match_id TEXT,source TEXT,kickoff_at TEXT,observed_at TEXT,recorded_at TEXT,status TEXT,reason TEXT,evidence_json TEXT);`);
  const snapshot = { protocolId: 'test-protocol', seasons: ['2026/27'], from: options.from, to: options.to,
    competitions: ['Test'], origin: 'prospective_a', window: 'T-24h..T-60min inclusive' };
  const manifest = { snapshot, sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
  f.manifestHash = manifest.sha256;
  await f.client.execute({ sql: 'INSERT INTO model_a_collection_protocols VALUES (?,?,?)', args: ['test-protocol', JSON.stringify(manifest), '2026-11-04T12:00:00Z'] });
  await f.client.execute({ sql: 'INSERT INTO model_a_collection_runs(run_id,protocol_id,started_at,completed_at,status,error_code,examined,claimed) VALUES (?,?,?,?,?,?,?,?)', args: ['run', 'test-protocol', '2026-11-04T18:00:00Z', '2026-11-04T18:01:00Z', 'success', null, 3, 2] });
  await f.client.execute({ sql: 'INSERT INTO model_a_prospective_result_refresh_state(refresh_id,last_started_at,last_completed_at,last_success_at,last_status) VALUES(?,?,?,?,?)', args: ['understat-results-v1','2026-11-04T18:00:00Z','2026-11-04T18:01:00Z','2026-11-04T18:01:00Z','completed'] });
  for (const [id, rowState, reason, claim] of [['present', state, 'forecast_confirmed', '2026-11-04T12:00:00Z'],
    ['pending', 'unconfirmed', 'delivery_unconfirmed', '2026-11-04T12:00:00Z'], ['missed', 'expired', 'window_expired', null], ['orphan', 'claimed', 'prediction_started', '2026-11-04T12:00:00Z']]) {
    await f.client.execute({ sql: 'INSERT INTO model_a_collection_ledger(protocol_id,match_id,kickoff_at,competition,season,state,reason,claim_at,forecast_id,updated_at,claim_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      args: ['test-protocol', id, kickoff, 'Test', '2026/27', rowState, reason, claim, id === 'present' ? 'present' : null, '2026-11-04T18:00:00Z', `${id}-claim`] });
  }
}

function registeredForecast(f, id) { return forecast(id, id, { origin: 'prospective_a', collection: { protocolId: 'test-protocol', manifestSha256: f.manifestHash, claimId: `${id}-claim` } }); }

test('collector monitoring separates analyzed, eligible, missed, pending and missing ledgers without counting retries as fixtures', async t => {
  const f = await fixture(t);
  for (const id of ['present', 'pending', 'missed', 'unseen']) await match(f, id);
  await registerCollector(f);
  await store(f, registeredForecast(f, 'present'));
  const spoolDir = path.join(f.dir, 'spool'); fs.mkdirSync(spoolDir);
  fs.writeFileSync(path.join(spoolDir, 'audit.ndjson'), ['recovered', 'recovered', 'retry', 'duplicate_suppressed', 'result_reconciliation_error']
    .map(type => JSON.stringify({ type, at: '2026-11-04T18:00:00Z', matchId: 'pending' })).join('\n') + '\n');
  const report = inspect({ ...f.options, origin: 'prospective_a', protocolId: 'test-protocol', spoolDir }, {});
  assert.equal(report.collector.registeredScopeMatches, true);
  assert.equal(report.collector.analyzedFixtures, 3);
  assert.equal(report.collector.predictionStartedFixtures, 2);
  assert.equal(report.collector.eligibleFixtures, 2);
  assert.equal(report.collector.missedWindows, 1);
  assert.equal(report.collector.pendingFixtures, 1);
  assert.equal(report.collector.storedFixtures, 1);
  assert.equal(report.collector.ledgerMissingFixtures, 1);
  assert.equal(report.spool.audit.counts.recovered, 2);
  assert.equal(report.spool.audit.counts.duplicate_suppressed, 1);
  assert.equal(report.coverage.recordedForecasts, 1);
  assert.equal(report.collector.lastSuccessfulRunAt, '2026-11-04T18:01:00Z');
  const monitoring = evaluate(report), codes = monitoring.alerts.map(alert => alert.code);
  for (const code of ['missing_forecast_windows', 'unanalyzed_fixtures', 'forecast_delivery_unconfirmed', 'pending_forecasts_old', 'result_reconciliation_errors']) assert.ok(codes.includes(code), code);
  assert.ok(monitoring.notices.some(notice => notice.code === 'temporal_provenance_unknown'));
  assert.equal(codes.includes('collector_stale'), false);
});

test('result monitoring keeps pending, horizon exclusions, kickoff conflicts and unavailable final evidence distinct', async t => {
  const f = await fixture(t);
  for (const id of ['present', 'pending', 'unassociated']) await match(f, id);
  await registerCollector(f);
  await store(f, registeredForecast(f, 'present'));
  await store(f, registeredForecast(f, 'pending'));
  await store(f, registeredForecast(f, 'orphan'));
  for (const [id, observed, recorded] of [['present', '2026-11-04T18:30:00Z', '2026-11-04T18:31:00Z'],
    ['pending', '2026-11-04T18:30:00Z', '2026-11-04T20:00:00Z'], ['unassociated', '2026-11-04T18:30:00Z', '2026-11-04T18:31:00Z']]) {
    await f.client.execute({ sql: 'INSERT INTO model_a_prospective_results VALUES (?,?,?,?,?,?,?,?,?)', args: [id, id, 'understat', kickoff, observed, recorded, 1, 0, '{}'] });
  }
  for (const [id, status, at] of [['pending', 'not_final', '2026-11-04T18:30:00Z'], ['pending', 'postponed', '2026-11-04T18:40:00Z'], ['orphan', 'unverified', '2026-11-04T18:40:00Z']]) {
    await f.client.execute({ sql: 'INSERT INTO model_a_prospective_result_observations VALUES (?,?,?,?,?,?,?,?,?)',
      args: [`${id}-${status}`, id, 'understat', kickoff, at, at, status, status === 'unverified' ? 'kickoff_changed' : status, '{}'] });
  }
  const report = inspect({ ...f.options, origin: 'prospective_a', protocolId: 'test-protocol' }, {});
  assert.equal(report.results.linkedForecasts, 1);
  assert.equal(report.results.pendingForecasts, 1);
  assert.equal(report.results.unassociatedResults, 1);
  assert.equal(report.results.orphanForecasts, 1);
  assert.deepEqual(report.results.lifecycle, { postponed: 1, unverified: 1 });
  const codes = evaluate(report, { resultGraceHours: 0.5 }).alerts.map(alert => alert.code);
  assert.ok(codes.includes('results_pending_within_horizon'));
  assert.ok(codes.includes('result_unverified'));
  const oldReport = { ...report, coverage: { ...report.coverage, scope: { ...report.coverage.scope, cutoff: '2027-01-01T00:00:00Z' } } };
  assert.ok(evaluate(oldReport).alerts.some(alert => alert.code === 'results_outside_refresh_horizon'));
});

test('only a scoped recent successful run with stored forecasts and linked result evidence produces no alert', async t => {
  const f = await fixture(t); await match(f, 'present'); await registerCollector(f);
  const payload = registeredForecast(f, 'present');
  payload.provenance.classification = 'technical_only'; payload.provenance.rigorousEligible = false;
  await store(f, payload);
  await f.client.execute({ sql: 'INSERT INTO model_a_prospective_results VALUES (?,?,?,?,?,?,?,?,?)',
    args: ['final', 'present', 'understat', kickoff, '2026-11-04T18:30:00Z', '2026-11-04T18:31:00Z', 1, 0, '{}'] });
  await f.client.execute({ sql: 'INSERT INTO model_a_prospective_result_observations VALUES (?,?,?,?,?,?,?,?,?)',
    args: ['final', 'present', 'understat', kickoff, '2026-11-04T18:30:00Z', '2026-11-04T18:31:00Z', 'final', 'verified', JSON.stringify({ resultRow: { home_goals: 1, away_goals: 0 } })] });
  const report = inspect({ ...f.options, origin: 'prospective_a', protocolId: 'test-protocol' }, {});
  assert.deepEqual(evaluate(report).alerts, []);
  assert.equal(evaluate(report).status, 'ok');
  assert.equal(evaluate(report).scientificStatus, 'unverified');
  assert.equal(report.coverage.nonEvaluableProvenance, 1);
  assert.ok(evaluate(report).notices.some(notice => notice.code === 'temporal_provenance_unknown'));
  assert.ok(evaluate(report, { requireRigorousInputs: true }).alerts.some(alert => alert.code === 'temporal_provenance_unknown'));
  assert.throws(() => evaluate(report, { requireRigorousInputs: 'yes' }), /invalid_rigorous_requirement/);
  assert.equal(report.results.refreshRunLivenessVerified, true);
  await f.client.execute({ sql: 'INSERT INTO model_a_collection_runs(run_id,protocol_id,started_at,completed_at,status,error_code,examined,claimed) VALUES (?,?,?,?,?,?,?,?)',
    args: ['failed-run', 'test-protocol', '2026-11-04T18:40:00Z', '2026-11-04T18:41:00Z', 'failed', 'redacted', 0, 0] });
  const failed = inspect({ ...f.options, origin: 'prospective_a', protocolId: 'test-protocol' }, {});
  assert.equal(failed.collector.failedRuns, 1);
  assert.equal(failed.collector.latestRunStatus, 'failed');
  assert.ok(evaluate(failed).alerts.some(alert => alert.code === 'collector_run_failed'));
});

test('overlapping protocols never borrow each others forecasts or claim identifiers', async t => {
  const f = await fixture(t); await match(f, 'present'); await registerCollector(f);
  const other = { schema: 'model-a-operational-prospective-v1', origin: 'prospective_a',
    collection: { protocolId: 'another-protocol', manifestSha256: f.manifestHash, claimId: 'present-claim' } };
  await store(f, forecast('foreign', 'present', other));
  await store(f, forecast('wrong-claim', 'present', { ...other, collection: { protocolId: 'test-protocol', manifestSha256: f.manifestHash, claimId: 'foreign-claim' } }));
  const scoped = { ...f.options, origin: 'prospective_a', protocolId: 'test-protocol' };
  const missing = inspect(scoped, {});
  assert.equal(missing.coverage.recordedForecasts, 0);
  assert.equal(missing.coverage.overdueMissing, 1);
  await store(f, registeredForecast(f, 'present'));
  const own = inspect(scoped, {});
  assert.equal(own.coverage.recordedForecasts, 1);
  assert.equal(own.coverage.overdueMissing, 0);
});

test('a later canceled lifecycle preserves old final evidence but excludes current pairing and eligibility', async t => {
  const f = await fixture(t); await match(f, 'present'); await registerCollector(f);
  await store(f, registeredForecast(f, 'present'));
  await f.client.execute({ sql: 'INSERT INTO model_a_prospective_results VALUES (?,?,?,?,?,?,?,?,?)',
    args: ['final', 'present', 'understat', kickoff, '2026-11-04T18:30:00Z', '2026-11-04T18:31:00Z', 1, 0, '{}'] });
  for (const [id, status, observed, evidence] of [['final', 'final', '2026-11-04T18:30:00Z', { resultRow: { home_goals: 1, away_goals: 0 } }],
    ['canceled', 'canceled', '2026-11-04T18:40:00Z', {}]]) {
    await f.client.execute({ sql: 'INSERT INTO model_a_prospective_result_observations VALUES (?,?,?,?,?,?,?,?,?)',
      args: [id, 'present', 'understat', kickoff, observed, observed, status, status, JSON.stringify(evidence)] });
  }
  const report = inspect({ ...f.options, origin: 'prospective_a', protocolId: 'test-protocol' }, {});
  assert.equal(report.coverage.fixtureMatches, 1);
  assert.equal(report.coverage.eligibleFixtureMatches, 0);
  assert.equal(report.results.preservedFinalEvidence, 1);
  assert.equal(report.results.currentlyPairableForecasts, 0);
  assert.equal(report.results.invalidatedStoredFinals, 1);
  assert.equal(report.results.pendingForecasts, 0);
  assert.equal(evaluate(report).status, 'ok');
  assert.ok(evaluate(report).notices.some(notice => notice.code === 'result_lifecycle_exclusion'));
});
