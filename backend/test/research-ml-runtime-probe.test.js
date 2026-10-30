const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createClient } = require('@libsql/client');
const { probeRuntime, main, EXPECTED_HOST, MODEL_QUERY } = require('../scripts/probe-research-ml-runtime');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = require('../dist/research/ForecastCore');
const { COHERENT_PROBABILITY_PROTOCOL, coherentProbabilityPipelineHash } = require('../dist/research/CoherentProbabilityPipeline');

const TOKEN = 'synthetic-readonly-token-never-log', URL = `libsql://${EXPECTED_HOST}`;
const env = () => ({ TURSO_DATABASE_URL: URL, TURSO_WATCHDOG_READONLY_TOKEN: TOKEN });
const clock = () => new Date('2026-10-29T20:00:00.000Z');
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function artifact(version = 'C-probe-fixture') {
  const tree = { oblivious_trees: [{ leaf_values: [.1] }], scale_and_bias: [1, [0]] };
  return { family: 'C', version, featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
    baselineVersion: baselineManifest().version, candidateKind: 'intensity_correction', weight: .5, temperature: 1,
    trainedThrough: '2026-09-01T00:00:00Z', validationThrough: '2026-10-01T00:00:00Z', createdAt: '2026-10-02T00:00:00Z',
    models: { home: tree, away: tree }, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2: coherentProbabilityPipelineHash() };
}
const row = (model = artifact()) => ({ version: model.version, artifact_json: JSON.stringify(model), artifact_hash: hash(model),
  created_at: '2026-10-03T00:00:00Z', is_champion: 0 });
function fakeReadClient(selected = row()) {
  const calls = [], state = { closed: 0, factoryCalls: 0 };
  return { calls, state, createClient: (configuration) => {
    state.factoryCalls++;
    assert.equal(configuration.authToken, TOKEN); assert.equal(configuration.url, URL);
    return { execute: async (sql) => {
      calls.push(sql); assert.match(sql, /^SELECT\s/i); assert.doesNotMatch(sql, /;|\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|PRAGMA)\b/i);
      assert.doesNotMatch(sql, /\b(?:matches|research_inputs|research_bets|research_ledger|research_benchmarks)\b/i);
      return { rows: selected ? [selected] : [] };
    }, close: () => { state.closed++; } };
  } };
}

test('probe executes one SELECT and real Node inference with only synthetic RAM inputs and whitelisted output', async () => {
  const f = fakeReadClient();
  const report = await probeRuntime({ env: env(), clock, createClient: f.createClient });
  assert.equal(f.calls.length, 1); assert.equal(f.state.closed, 1);
  assert.equal(report.model.version, 'C-probe-fixture'); assert.equal(report.checks.finiteProbabilities, true);
  assert.ok(Math.abs(report.checks.matrixMass - 1) < 1e-9); assert.ok(Math.abs(report.checks.oneXTwoMass - 1) < 1e-9);
  assert.equal(report.inference.samples, 100); assert.ok(Number.isFinite(report.inference.p95Ms));
  assert.equal(report.syntheticInput, true); assert.equal(report.databaseWrites, 0); assert.equal(report.providerRequests, 0);
  assert.equal(report.fixtureCycleVerified, false); assert.equal(report.nativeParityExecuted, false);
  assert.deepEqual(Object.keys(report).sort(), ['ok', 'probe', 'node', 'platform', 'model', 'checks', 'inference', 'resources',
    'syntheticInput', 'databaseSelects', 'databaseWrites', 'providerRequests', 'fixtureCycleVerified', 'nativeParityExecuted'].sort());
  assert.doesNotMatch(JSON.stringify(report), /synthetic-readonly-token-never-log|artifact_json|oblivious_trees|features_info|libsql:\/\//);
});

test('actual SELECT gives the champion precedence and otherwise selects the latest candidate with version tie-break', async () => {
  const sqlite = createClient({ url: 'file::memory:' });
  await sqlite.executeMultiple(`CREATE TABLE research_models(family TEXT,version TEXT,artifact_json TEXT,artifact_hash TEXT,created_at TEXT);
    CREATE TABLE research_champions(family TEXT,version TEXT);`);
  for (const [version, createdAt] of [['C-older', '2026-10-02T00:00:00Z'], ['C-newer', '2026-10-03T00:00:00Z'], ['C-z', '2026-10-03T00:00:00Z']]) {
    const model = artifact(version);
    await sqlite.execute({ sql: 'INSERT INTO research_models VALUES (?,?,?,?,?)', args: ['C', version, JSON.stringify(model), hash(model), createdAt] });
  }
  await sqlite.execute("INSERT INTO research_champions VALUES ('C','C-older')");
  let selects = 0, closes = 0;
  // The fake RO adapter rejects writes; fixture setup above is isolated in RAM.
  const factory = () => ({ execute: (sql) => {
    selects++; assert.equal(sql, MODEL_QUERY); assert.match(sql, /^SELECT\s/i);
    assert.doesNotMatch(sql, /;|\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|PRAGMA)\b/i); return sqlite.execute(sql);
  }, close: () => { closes++; } });
  try {
    const champion = await probeRuntime({ env: env(), clock, createClient: factory });
    assert.equal(champion.model.version, 'C-older'); assert.equal(champion.model.role, 'CHAMPION');
    await sqlite.execute('DELETE FROM research_champions');
    const candidate = await probeRuntime({ env: env(), clock, createClient: factory });
    assert.equal(candidate.model.version, 'C-z'); assert.equal(candidate.model.role, 'CANDIDATE');
    assert.equal(selects, 2); assert.equal(closes, 2);
  } finally { sqlite.close(); }
});

test('wrong host, URI credentials and missing RO token fail before connecting, even with a write token present', async () => {
  for (const invalid of [
    { TURSO_DATABASE_URL: 'libsql://scomessesportive-ivandragon003.aws-eu-west-1.turso.io' },
    { TURSO_DATABASE_URL: `libsql://user:secret@${EXPECTED_HOST}` },
    { TURSO_DATABASE_URL: `${URL}?auth=secret` },
    { TURSO_DATABASE_URL: `${URL}/unexpected` },
    { TURSO_DATABASE_URL: URL, TURSO_WATCHDOG_READONLY_TOKEN: '', TURSO_AUTH_TOKEN: TOKEN },
  ]) {
    let connected = false;
    await assert.rejects(probeRuntime({ env: { ...env(), ...invalid }, clock,
      createClient: () => { connected = true; throw new Error(TOKEN); } }), /runtime_probe_configuration_invalid/);
    assert.equal(connected, false);
  }
});

test('missing C, invalid artifact identities and future or diagnostic artifacts cannot produce a successful probe', async () => {
  const invalidRows = [null, { ...row(), artifact_json: '{secret-invalid-json' }, { ...row(), artifact_hash: '0'.repeat(64) },
    { ...row(), version: 'C-wrong-version' }, row({ ...artifact(), baselineVersion: 'A-wrong' }),
    row({ ...artifact(), diagnosticOnly: true }), row({ ...artifact(), runtimeCompatible: false }),
    row({ ...artifact(), featureSchema: 'wrong' }), row({ ...artifact(), pipelineHashV2: '0'.repeat(64) }),
    row({ ...artifact(), validationThrough: '2026-10-30T00:00:00Z' }),
    { ...row(), created_at: '2026-10-30T00:00:00Z' }];
  for (const selected of invalidRows) {
    const f = fakeReadClient(selected);
    await assert.rejects(probeRuntime({ env: env(), clock, createClient: f.createClient }), /^Error: runtime_probe_(?:model_missing|artifact_invalid|identity_invalid)$/);
    assert.equal(f.state.closed, 1); assert.equal(f.calls.length, 1);
  }
});

test('CLI reports only safe error codes and closes its client when driver errors contain token, URI and raw stack', async () => {
  const output = [], errors = [];
  let closed = 0;
  const code = await main({ env: env(), clock, log: (value) => output.push(value), error: (value) => errors.push(value),
    createClient: () => ({ execute: async (sql) => { assert.match(sql, /^SELECT\s/i); throw new Error(`${URL}?auth=${TOKEN}\nRAW_STACK`); },
      close: () => { closed++; } }) });
  assert.equal(code, 1); assert.equal(closed, 1); assert.equal(output.length, 0);
  assert.deepEqual(JSON.parse(errors[0]), { ok: false, code: 'runtime_probe_read_failed', syntheticInput: true, databaseWrites: 0, providerRequests: 0 });
  assert.doesNotMatch(errors.join(''), /synthetic-readonly-token|libsql|RAW_STACK|artifact_json/);
});

test('a close failure is also sanitized and cannot turn a failed probe into success', async () => {
  const errors = [], f = fakeReadClient();
  const code = await main({ env: env(), clock, error: (value) => errors.push(value), createClient: (configuration) => {
    const client = f.createClient(configuration); return { ...client, close: () => { throw new Error(TOKEN); } };
  } });
  assert.equal(code, 1); assert.equal(JSON.parse(errors[0]).code, 'runtime_probe_close_failed'); assert.doesNotMatch(errors[0], /never-log/);
});

test('manual registered-C job remains isolated from preview write credentials, training and betting bootstrap', () => {
  const workflow = readFileSync(join(__dirname, '../../.github/workflows/research-runtime-verification.yml'), 'utf8');
  const script = readFileSync(join(__dirname, '../scripts/probe-research-ml-runtime.js'), 'utf8');
  assert.match(workflow, /on:\s*\n\s+workflow_dispatch:/);
  assert.match(workflow, /contents: read/); assert.match(workflow, /timeout-minutes: 5/); assert.match(workflow, /node-version: 20/);
  assert.match(workflow, /secrets\.TURSO_WATCHDOG_READONLY_TOKEN/);
  const readOnlyJob = workflow.slice(workflow.indexOf('  verify-runtime:'), workflow.indexOf('  preview-recommendations:'));
  assert.match(readOnlyJob, /inputs\.mode == 'registered-c'/);
  assert.match(readOnlyJob, /secrets\.TURSO_WATCHDOG_READONLY_TOKEN/);
  assert.doesNotMatch(readOnlyJob, /TURSO_AUTH_TOKEN|ODDS_API_KEY|preview-recommendations\.js/);
  assert.doesNotMatch(workflow, /schedule:|workflow_run:|push:|pull_request:|upload-artifact|research-nightly|research-lifecycle|pip install/);
  assert.doesNotMatch(script, /require\([^\n]*(?:DatabaseService|ResearchStore|OddsApi)|writeFile|mkdir|child_process/);
});
