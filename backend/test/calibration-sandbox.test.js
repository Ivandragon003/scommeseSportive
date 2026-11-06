const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readdirSync, unlinkSync, rmdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createSnapshotSandbox, generateIsolatedProfiles } = require('../scripts/calibration-sandbox');
const { preflightCalibration, readOnlyDatabase } = require('../scripts/calibration-preflight');

const { snapshot } = require('./fixtures/calibration-sandbox');
async function cleanup(directory) {
  // Native libSQL handles finish closing on the next event-loop turn on Windows.
  await new Promise((resolve) => setImmediate(resolve));
  for (const file of readdirSync(directory)) {
    try { unlinkSync(join(directory, file)); }
    catch (error) {
      // A closed native libSQL handle can remain locked until process exit.
      if (['EBUSY', 'EPERM'].includes(error.code)) return;
      throw error;
    }
  }
  rmdirSync(directory);
}

test('sandbox rejects remote destinations and refuses to overwrite any existing file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'calibration-sandbox-'));
  try {
    const existing = join(directory, 'existing.db');
    writeFileSync(existing, 'preserved');
    await assert.rejects(createSnapshotSandbox(snapshot(), existing), /overwrite/);
    await assert.rejects(createSnapshotSandbox(snapshot(), 'libsql://operational.invalid'), /local filesystem/);
    await assert.rejects(createSnapshotSandbox(snapshot(), 'file:existing.db'), /local filesystem/);
    await assert.rejects(generateIsolatedProfiles({ client: { protocol: 'https' }, db: {} }), /same local file client/);
  } finally { await cleanup(directory); }
});

test('isolated calibration prepares reusable profiles and leaves fixtures, simulated quotes and saved parameters unchanged', async (t) => {
  const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
  const params = new DixonColesModel().getParams();
  t.mock.method(DixonColesModel.prototype, 'fitModel', () => structuredClone(params));
  t.mock.method(DixonColesModel.prototype, 'computeFullProbabilities', () => ({
    flatProbabilities: { homeWin: 0.45, draw: 0.25, awayWin: 0.3 },
  }));
  const directory = mkdtempSync(join(tmpdir(), 'calibration-sandbox-'));
  let sandbox;
  try {
    sandbox = await createSnapshotSandbox(snapshot(), join(directory, 'new.db'));
    const before = await preflightCalibration(readOnlyDatabase(sandbox.client), ['Serie A']);
    assert.equal(before.competitions[0].status, 'MISS');
    const result = await generateIsolatedProfiles(sandbox, ['Serie A']);
    assert.equal(result.preflight.ready, true);
    assert.equal(result.preflight.competitions[0].status, 'HIT');
    assert.ok(result.profiles[0].observations > 0);
    for (const table of ['matches', 'odds_snapshots', 'model_params']) assert.deepEqual(result.before[table], result.after[table]);
    assert.equal(result.operationalWrites, 0);
    assert.equal(result.providerRequests, 0);
  } finally {
    sandbox?.client.close();
    await cleanup(directory);
  }
});
