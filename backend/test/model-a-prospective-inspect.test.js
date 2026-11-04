const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { localDatabasePath } = require('../scripts/model-a-prospective-inspect');
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || (major === 22 && minor >= 13);
const test = (name, fn) => nodeTest(name, { skip: supported ? false : 'Read-only inspector requires Node >=22.13; backend Node 20 remains supported.' }, fn);

// The actual CLI is a short-lived operator process; process isolation also releases
// native SQLite statement handles deterministically before Windows temp cleanup.
function inspect(config, environment) {
  const names = { dbUrl: '--db-url', competition: '--competition', season: '--season', from: '--from', to: '--to', cutoff: '--cutoff', origin: '--origin', spoolDir: '--spool-dir' };
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

test('schema inspection detects absent columns and guards without applying schema', async t => {
  const f = await fixture(t, false);
  f.client.close();
  const before = fs.readFileSync(f.filename);
  const report = inspect(f.options, {});
  assert.equal(report.schema.compatible, false);
  assert.equal(report.coverage, null);
  assert.ok(report.schema.issues.includes('missing_table:model_a_prospective_forecasts'));
  assert.deepEqual(fs.readFileSync(f.filename), before);
  f.client = createLocalClient(f.options.dbUrl);
  await f.client.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
  await f.client.execute('DROP TRIGGER model_a_prospective_no_update');
  await f.client.execute("CREATE TRIGGER model_a_prospective_no_update BEFORE UPDATE ON model_a_prospective_forecasts WHEN 0 BEGIN SELECT RAISE(ABORT, 'fake'); END");
  f.client.close();
  assert.ok(inspect(f.options, {}).schema.issues.includes('missing_or_unverified_trigger:model_a_prospective_no_update'));
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
