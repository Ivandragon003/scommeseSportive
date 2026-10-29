const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { ResearchStore } = require('../dist/research/ResearchStore');
const { buildResearchOverview } = require('../dist/research/ResearchOverview');

const NOW = '2026-10-29T18:00:00.000Z';
async function setup(t) {
  const client = createClient({ url: 'file::memory:' });
  t.after(() => client.close());
  await client.executeMultiple(readFileSync(join(__dirname, '../migrations/015_research_platform.sql'), 'utf8'));
  return { client, store: new ResearchStore(client) };
}
async function model(client, version, artifact) {
  await client.execute({ sql: 'INSERT INTO research_models VALUES (?,?,?,?,?)',
    args: ['C', version, artifact, 'fixture-hash', NOW] });
}
async function benchmark(client, id, family, report, createdAt = NOW) {
  await client.execute({ sql: 'INSERT INTO research_benchmarks VALUES (?,?,?,?,?,?,?)',
    args: [id, family, id, report, 'fixture-hash', 0, createdAt] });
}
function database(store, compact) {
  const methods = ['listPortfolios', 'listBets', 'listMarkets', 'listJobs', 'listLedger', 'listDecisions',
    'listModelEvents', 'getLatestBenchmark'];
  const research = Object.fromEntries(methods.map((name) => [name, store[name].bind(store)]));
  if (compact) {
    research.getOverviewModels = store.getOverviewModels.bind(store);
    research.getLatestValidationSummary = store.getLatestValidationSummary.bind(store);
    for (const name of ['getModels', 'listBenchmarks']) research[name] = () => {
      throw new Error(`Overview must not load full ${name}`);
    };
  } else {
    research.getModels = store.getModels.bind(store);
    research.listBenchmarks = store.listBenchmarks.bind(store);
  }
  return { research, researchMonitoring: { read: async () => ({ notifications: [], incidents: [] }) },
    researchExperiments: { list: async () => [{ kind: 'DIAGNOSTIC_RUN', report: { findings: [{ code: 'existing' }] } }] },
    listRecentSchedulerRuns: async () => [], listRecentSchedulerRunsByName: async () => [] };
}

for (const scenario of ['empty', 'C', 'PAIR', 'null', 'scalar']) {
  test(`compact overview preserves the entire DTO with ${scenario} benchmark selection`, async (t) => {
    const { client, store } = await setup(t);
    const artifacts = [null, 'raw-string', [], {}, { trainedThrough: null, metrics: null },
      { trainedThrough: '2026-10-28', metrics: { n: 12, nested: [true, null, .4] } },
      { trainedThrough: false, metrics: false }, { metrics: 0 }, { metrics: 'unmeasured' }];
    for (const [index, artifact] of artifacts.entries()) await model(client, `v${index}`, JSON.stringify(artifact));
    if (scenario !== 'empty') {
      await benchmark(client, 'pair', 'PAIR', JSON.stringify({ A: { n: 10, logLoss: 1 }, C: { n: 10, logLoss: .99 },
        byLeague: { EPL: { n: 10 } }, conclusion: 'inconclusive', warnings: [] }), '2026-10-28T18:00:00.000Z');
      const report = scenario === 'null' ? null : scenario === 'scalar' ? 'raw-string' : {
        warnings: [{ invalidating: true, code: 'protected_original_final_reused' }],
        unusedCalibrationSamples: new Array(100).fill({ predicted: .3, observed: 0 }),
      };
      await benchmark(client, 'earlier-same-time', 'C', JSON.stringify({ warnings: [{ invalidating: true, code: 'old' }] }));
      await benchmark(client, 'latest', scenario === 'PAIR' ? 'PAIR' : 'C', JSON.stringify(report));
    }
    const options = { now: NOW, nightlyEnabled: false };
    const before = await buildResearchOverview(database(store, false), options);
    const after = await buildResearchOverview(database(store, true), options);
    assert.deepEqual(after, before);
    assert.equal(after.models[3].metrics, undefined);
    assert.equal(after.models[4].metrics, null);
    assert.equal(after.models[6].metrics, false);
    if (scenario === 'C' || scenario === 'PAIR') {
      assert.match(after.latestDiagnostics.report.findings[1].message, /^latest:/);
      assert.equal(after.latestDiagnostics.report.findings[1].code, 'protected_original_final_reused');
    }
  });
}

test('metadata readers retain invalid JSON failures instead of hiding corrupted evidence', async (t) => {
  const { client, store } = await setup(t);
  await model(client, 'invalid', '{invalid');
  await benchmark(client, 'invalid', 'C', '{invalid');
  await assert.rejects(store.getModels(), SyntaxError);
  await assert.rejects(store.getOverviewModels(), SyntaxError);
  await assert.rejects(store.listBenchmarks({ limit: 1 }), SyntaxError);
  await assert.rejects(store.getLatestValidationSummary(), SyntaxError);
});

test('overview SQL excludes large unused payloads while full lifecycle readers retain them', async (t) => {
  const { client, store } = await setup(t);
  const unused = 'x'.repeat(1_000_000);
  await model(client, 'large', JSON.stringify({ trainedThrough: '2026-10-28', metrics: { n: 12 }, trees: unused }));
  await benchmark(client, 'large', 'C', JSON.stringify({ warnings: [], calibrationSamples: unused }));
  await client.execute({ sql: 'INSERT INTO research_champions VALUES (?,?,?,?)', args: ['C', 'large', 'large', NOW] });
  const queries = [];
  const originalExecute = client.execute.bind(client);
  client.execute = async (statement) => { queries.push(typeof statement === 'string' ? statement : statement.sql);
    return originalExecute(statement); };
  const compact = [await store.getOverviewModels(), await store.getLatestValidationSummary()];
  assert.ok(queries.filter((sql) => /FROM research_(models|benchmarks)/.test(sql)).every((sql) => !/SELECT (?:m\.)?\*/.test(sql)));
  assert.equal(compact[0][0].isChampion, 1);
  assert.equal(compact[0][0].artifact.trees, undefined);
  assert.equal(compact[1].report.calibrationSamples, undefined);
  const full = [await store.getModels(), await store.listBenchmarks({ limit: 1 })];
  assert.equal(full[0][0].artifact.trees, unused);
  assert.equal(full[1][0].report.calibrationSamples, unused);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(full)) * .001);
});
