const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@libsql/client');
const { ResearchExperimentStore } = require('../dist/research/ResearchExperimentStore');

const database = () => {
  const path = join(tmpdir(), `footpredictor-experiments-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  return { client, close: () => { client.close(); try { rmSync(path, { force: true }); }
    catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; } } };
};
test('diagnostic experiments remain immutable, idempotent and outside operational model selection', async () => {
  const { client, close } = database();
  try {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations/017_research_experiments.sql'), 'utf8'));
    const store = new ResearchExperimentStore(client);
    const input = { id: 'fixture-experiment', runId: 'fixture-run', kind: 'intensity_correction', phase: 'development',
      datasetHash: 'a'.repeat(64), originalReportHash: 'b'.repeat(64),
      report: { metricsA: { n: 200, logLoss: 1 }, runtimeCompatible: true, eligibleForPromotion: true } };
    assert.deepEqual(await store.saveBatch([input]), { inserted: 1, existing: 0 });
    assert.deepEqual(await store.saveBatch([input]), { inserted: 0, existing: 1 });
    const row = (await store.list())[0];
    assert.equal(row.runtimeCompatible, false); assert.equal(row.eligibleForPromotion, false);
    assert.equal(row.report.runtimeCompatible, false); assert.equal(row.report.eligibleForPromotion, false);
    assert.equal(row.report.metricsA.n, 200);
    await assert.rejects(store.saveBatch([{ ...input, report: { metricsA: { n: 1 } } }]), /immutable/);
    await assert.rejects(client.execute("UPDATE research_experiments SET kind='operational'"), /immutable/);
    await assert.rejects(client.execute('DELETE FROM research_experiments'), /immutable/);
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='research_models'");
    assert.equal(tables.rows.length, 0);
  } finally { close(); }
});

test('an invalid batch rolls back the experiment registry atomically', async () => {
  const { client, close } = database();
  try {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations/017_research_experiments.sql'), 'utf8'));
    const store = new ResearchExperimentStore(client);
    const row = { id: 'good', runId: 'fixture', kind: 'full', phase: 'development', datasetHash: 'a'.repeat(64),
      originalReportHash: 'b'.repeat(64), report: { n: 100 } };
    await assert.rejects(store.saveBatch([row, { ...row, id: 'bad', datasetHash: 'not-a-hash' }]), /provenance/);
    assert.equal((await store.list()).length, 0);
  } finally { close(); }
});
