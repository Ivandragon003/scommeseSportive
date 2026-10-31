const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const AT = '2026-10-31T12:00:00Z';

async function fixture() {
  const client = createClient({ url: 'file::memory:' });
  await client.executeMultiple(readFileSync(join(__dirname, '../migrations/015_research_platform.sql'), 'utf8'));
  const calls = [];
  const execute = client.execute.bind(client);
  client.execute = async (statement) => {
    calls.push(typeof statement === 'string' ? statement : statement.sql);
    return execute(statement);
  };
  const store = new ResearchStore(client, async () => {}, { now: () => new Date(AT) });
  const insertBenchmark = async (id, report, overrides = {}) => client.execute({ sql:
    'INSERT INTO research_benchmarks(id,family,model_version,report_json,report_hash,validated,created_at) VALUES(?,?,?,?,?,?,?)',
  args: [id, overrides.family ?? 'C', overrides.version ?? 'C-fixture', typeof report === 'string' ? report : JSON.stringify(report),
    'benchmark-hash', 0, overrides.createdAt ?? '2026-10-30T12:00:00Z'] });
  const insertModel = async (version, overrides = {}) => {
    const artifact = { family: 'C', version, createdAt: '2026-10-01T00:00:00Z', models: { weights: [1, 2, 3] }, ...overrides.artifact };
    await client.execute({ sql: 'INSERT INTO research_models(family,version,artifact_json,artifact_hash,created_at) VALUES(?,?,?,?,?)',
      args: ['C', version, JSON.stringify(artifact), overrides.hash ?? researchHash(artifact), overrides.createdAt ?? '2026-10-02T00:00:00Z'] });
    return artifact;
  };
  return { client, store, calls, insertBenchmark, insertModel };
}

test('C preview calibration projection preserves JSON types, row selection and required evidence without predictions', async () => {
  const f = await fixture();
  try {
    const report = { version: 'calibration-version', probabilityProtocol: 'joint-goal-coherent-v2', pipelineHashV2: 'pipeline',
      baselineVersion: 'baseline', validation: { baselineHash: 'hash', irrelevant: 'excluded' },
      calibrationProfilesV2: { C: { classes: { homeWin: { points: [[.1, .2], [.7, .8]] } } } },
      probabilityCalibrationMode: 'isotonic_1x2', probabilityTemperature: 1.2,
      diagnosticOnly: false, runtimeCompatible: true, predictions: Array(1000).fill({ probabilities: [.3, .3, .4] }) };
    await f.insertBenchmark('earlier-same-time', { ...report, probabilityTemperature: 9 });
    await f.insertBenchmark('expected', report);
    await f.insertBenchmark('other-model', { probabilityTemperature: 8 }, { version: 'C-other', createdAt: AT });
    await f.insertBenchmark('other-family', { probabilityTemperature: 7 }, { family: 'A', createdAt: AT });
    const full = await f.store.getLatestBenchmark('C', 'C-fixture');
    const projected = await f.store.getLatestPreviewBenchmarkC('C-fixture');
    assert.equal(full.id, 'expected'); assert.equal(projected.id, full.id);
    for (const key of ['family', 'modelVersion', 'reportHash', 'validated', 'createdAt']) assert.deepEqual(projected[key], full[key]);
    for (const key of ['version', 'probabilityProtocol', 'pipelineHashV2', 'baselineVersion', 'calibrationProfilesV2',
      'probabilityCalibrationMode', 'probabilityTemperature', 'diagnosticOnly', 'runtimeCompatible']) {
      assert.deepEqual(projected.report[key], full.report[key], key);
    }
    assert.deepEqual(projected.report.validation, { baselineHash: 'hash' });
    assert.ok(!('reportJson' in projected) && !('predictions' in projected.report));
    assert.ok(JSON.stringify(projected).length < JSON.stringify(full).length / 10);
    assert.equal(await f.store.getLatestPreviewBenchmarkC('C-missing'), null);
  } finally { f.client.close(); }
});

test('C calibration projection preserves false, true, explicit null and missing compatibility fields', async () => {
  const f = await fixture();
  try {
    for (const [index, values] of [
      { diagnosticOnly: true, runtimeCompatible: false, probabilityTemperature: null },
      { diagnosticOnly: false, runtimeCompatible: true, probabilityTemperature: 0 },
      {},
    ].entries()) {
      await f.insertBenchmark(`case-${index}`, values, { version: `C-case-${index}` });
      const record = await f.store.getLatestPreviewBenchmarkC(`C-case-${index}`);
      for (const key of Object.keys(values)) assert.deepEqual(record.report[key], values[key]);
    }
    await f.insertBenchmark('invalid', '{invalid', { version: 'C-invalid' });
    await assert.rejects(f.store.getLatestPreviewBenchmarkC('C-invalid'));
    await assert.rejects(f.store.getLatestBenchmark('C', 'C-invalid'));
  } finally { f.client.close(); }
});

test('preview artifact cache coalesces full reads, verifies metadata each time and shares only immutable parsed data', async () => {
  const f = await fixture();
  try {
    const artifact = await f.insertModel('C-one');
    const [one, two] = await Promise.all([f.store.getPreviewModelC('C-one'), f.store.getPreviewModelC('C-one')]);
    assert.deepEqual(one.artifact, artifact); assert.equal(one.artifact, two.artifact);
    assert.ok(Object.isFrozen(one.artifact) && Object.isFrozen(one.artifact.models.weights));
    assert.ok(!('artifactJson' in one));
    one.createdAt = 'tampered';
    const three = await f.store.getPreviewModelC('C-one');
    assert.equal(three.createdAt, '2026-10-02T00:00:00Z');
    assert.equal(f.calls.filter((sql) => /SELECT m\.\*/.test(sql)).length, 1);
    assert.equal(f.calls.filter((sql) => /SELECT m\.family,m\.version,m\.artifact_hash/.test(sql)).length, 3);
    assert.equal(await f.store.getPreviewModelC('C-missing'), null);
    const generic = await f.store.getModelByVersion('C', 'C-one');
    assert.ok('artifactJson' in generic); assert.ok(!Object.isFrozen(generic.artifact));
  } finally { f.client.close(); }
});

test('preview artifact cache is bounded and never uses a stale immutable identity', async () => {
  const f = await fixture();
  try {
    await f.insertModel('C-one'); await f.insertModel('C-two');
    await f.store.getPreviewModelC('C-one');
    await f.store.getPreviewModelC('C-two');
    await f.store.getPreviewModelC('C-one');
    assert.equal(f.calls.filter((sql) => /SELECT m\.\*/.test(sql)).length, 3);
    const execute = f.client.execute.bind(f.client);
    f.client.execute = async (statement) => {
      const result = await execute(statement);
      if (/SELECT m\.family,m\.version,m\.artifact_hash/.test(statement.sql)) {
        return { ...result, rows: result.rows.map((row) => ({ ...row, artifact_hash: 'changed-registry-identity' })) };
      }
      return result;
    };
    await assert.rejects(f.store.getPreviewModelC('C-one'), /identity_unavailable/);
  } finally { f.client.close(); }
});

test('future registrations, future artifacts and corrupt hashes fail closed and failed loads are retryable', async () => {
  const f = await fixture();
  try {
    await f.insertModel('C-future-registry', { createdAt: '2026-11-01T00:00:00Z' });
    await assert.rejects(f.store.getPreviewModelC('C-future-registry'), /registry_unavailable/);
    assert.equal(f.calls.filter((sql) => /SELECT m\.\*/.test(sql)).length, 0);
    await f.insertModel('C-future-artifact', { artifact: { createdAt: '2026-11-01T00:00:00Z' } });
    await assert.rejects(f.store.getPreviewModelC('C-future-artifact'), /identity_unavailable/);
    await f.insertModel('C-corrupt', { hash: 'incorrect' });
    await assert.rejects(f.store.getPreviewModelC('C-corrupt'), /identity_unavailable/);
    await assert.rejects(f.store.getPreviewModelC('C-corrupt'), /identity_unavailable/);
    assert.equal(f.calls.filter((sql) => /SELECT m\.\*/.test(sql)).length, 3);
    assert.equal(f.store.previewModelLoadsC.size, 0);
    assert.equal(f.store.previewModelsC.size, 0);
  } finally { f.client.close(); }
});

test('at most two different preview artifact loads may be pending, while identical requests coalesce', async () => {
  const f = await fixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    for (const version of ['C-one', 'C-two', 'C-three']) await f.insertModel(version);
    const load = f.store.getModelByVersion.bind(f.store);
    const started = [];
    f.store.getModelByVersion = async (family, version) => {
      started.push(version); await gate; return load(family, version);
    };
    const one = f.store.getPreviewModelC('C-one');
    const same = f.store.getPreviewModelC('C-one');
    const two = f.store.getPreviewModelC('C-two');
    while (started.length < 2) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(f.store.getPreviewModelC('C-three'), /load_busy/);
    assert.deepEqual(started.sort(), ['C-one', 'C-two']);
    release();
    const results = await Promise.all([one, same, two]);
    assert.equal(results[0].artifact, results[1].artifact);
  } finally { release(); f.client.close(); }
});
