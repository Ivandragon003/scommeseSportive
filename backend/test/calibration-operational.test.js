const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { mkdtempSync, existsSync, readFileSync, readdirSync, unlinkSync, rmdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const { snapshot } = require('./fixtures/calibration-sandbox');
const { createSnapshotSandbox, tableHashes } = require('../scripts/calibration-sandbox');
const { runOperationalCalibration, targetFingerprint, guardCalibrationWrites } = require('../scripts/calibration-operational');

function cleanup(directory) {
  for (const file of readdirSync(directory)) {
    try { unlinkSync(join(directory, file)); }
    catch (error) { if (['EBUSY', 'EPERM'].includes(error.code)) return; throw error; }
  }
  rmdirSync(directory);
}

test('execute authorization and target mismatch fail before opening a client or constructing a service', async () => {
  let opens = 0;
  let constructions = 0;
  const dependencies = {
    createClient: () => { opens++; throw new Error('Must not open'); },
    createDatabase: () => { constructions++; throw new Error('Must not construct'); },
  };
  const env = { TURSO_DATABASE_URL: 'libsql://test.invalid', OPERATIONAL_CALIBRATION_ENABLED: 'true' };
  await assert.rejects(runOperationalCalibration({ execute: true, env }, dependencies), /authorization/);
  await assert.rejects(runOperationalCalibration({ execute: true, authorizeCalibrationWrites: true,
    targetSha256: 'wrong', backupFile: 'unused', env }, dependencies), /fingerprint/);
  await assert.rejects(runOperationalCalibration({ execute: true, authorizeCalibrationWrites: true,
    targetSha256: targetFingerprint(env.TURSO_DATABASE_URL), backupFile: 'unused',
    env: { ...env, OPERATIONAL_CALIBRATION_ENABLED: 'false' } }, dependencies), /authorization/);
  assert.equal(opens, 0);
  assert.equal(constructions, 0);
});

test('a missing cache schema causes SELECT-only failure, without applying a migration or bootstrap', async () => {
  const client = createClient({ url: 'file::memory:' });
  const statements = [];
  let constructions = 0;
  await assert.rejects(runOperationalCalibration({ env: { TURSO_DATABASE_URL: 'libsql://isolated-test.invalid' } }, {
    createClient: () => ({ execute: (sql) => { statements.push(sql); return client.execute(sql); }, close: () => client.close() }),
    createDatabase: () => { constructions++; throw new Error('Forbidden bootstrap'); },
  }), /schema is missing/);
  assert.ok(statements.every((sql) => /^SELECT\b/.test(sql)));
  assert.equal(constructions, 0);
});

test('missing local targets are rejected before client creation in both plan and authorized execute modes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'calibration-missing-target-'));
  try {
    const file = join(directory, 'missing.db');
    const url = pathToFileURL(file).href;
    let clients = 0;
    for (const execute of [false, true]) {
      await assert.rejects(runOperationalCalibration({
        execute, authorizeCalibrationWrites: true, targetSha256: targetFingerprint(url),
        backupFile: join(directory, 'unused-backup.json'),
        env: { TURSO_DATABASE_URL: url, OPERATIONAL_CALIBRATION_ENABLED: 'true' },
      }, {
        createClient: () => { clients++; throw new Error('Must not create a local target'); },
      }), /must already exist/);
      assert.equal(existsSync(file), false);
      assert.equal(existsSync(join(directory, 'unused-backup.json')), false);
    }
    assert.equal(clients, 0);
  } finally { cleanup(directory); }
});

test('default plan does not construct DatabaseService or write a cache backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'calibration-plan-'));
  let sandbox;
  try {
    sandbox = await createSnapshotSandbox(snapshot(), join(directory, 'isolated.db'));
    let constructions = 0;
    const result = await runOperationalCalibration({ competitions: ['Serie A'],
      env: { TURSO_DATABASE_URL: pathToFileURL(sandbox.file).href }, backupFile: join(directory, 'not-created.json') }, {
      createDatabase: () => { constructions++; throw new Error('Forbidden bootstrap'); },
    });
    assert.equal(result.mode, 'plan');
    assert.equal(result.preflight.competitions[0].status, 'MISS');
    assert.equal(result.databaseWrites, 0);
    assert.equal(constructions, 0);
    assert.equal(existsSync(join(directory, 'not-created.json')), false);
    assert.deepEqual(await tableHashes(sandbox.client), sandbox.before);
  } finally { sandbox?.client.close(); cleanup(directory); }
});

test('authorized isolated execution backs up before construction and changes only calibration cache', async (t) => {
  const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
  const params = new DixonColesModel().getParams();
  t.mock.method(DixonColesModel.prototype, 'fitModel', () => structuredClone(params));
  t.mock.method(DixonColesModel.prototype, 'computeFullProbabilities', () => ({ flatProbabilities: { homeWin: 0.45, draw: 0.25, awayWin: 0.3 } }));
  const directory = mkdtempSync(join(tmpdir(), 'calibration-execute-'));
  let sandbox;
  const originalUrl = process.env.TURSO_DATABASE_URL;
  const originalToken = process.env.TURSO_AUTH_TOKEN;
  const originalFlag = process.env.OPERATIONAL_CALIBRATION_ENABLED;
  try {
    sandbox = await createSnapshotSandbox(snapshot(), join(directory, 'isolated.db'));
    const backupFile = join(directory, 'cache-backup.json');
    process.env.TURSO_DATABASE_URL = pathToFileURL(sandbox.file).href;
    process.env.TURSO_AUTH_TOKEN = 'isolated-test-token';
    process.env.OPERATIONAL_CALIBRATION_ENABLED = 'true';
    const { DatabaseService } = require('../dist/db/DatabaseService');
    const result = await runOperationalCalibration({ execute: true, authorizeCalibrationWrites: true,
      targetSha256: targetFingerprint(process.env.TURSO_DATABASE_URL), backupFile,
      competitions: ['Serie A'], recentReplayLimit: 0 }, {
      createDatabase: (options) => {
        assert.equal(existsSync(backupFile), true);
        assert.deepEqual(options, { skipSchemaBootstrap: true });
        return new DatabaseService(options);
      },
    });
    assert.equal(result.mode, 'execute');
    assert.equal(result.verified.competitions[0].status, 'HIT');
    const backup = JSON.parse(readFileSync(backupFile, 'utf8'));
    assert.deepEqual(backup.rows, snapshot().runtime_calibration_profiles);
    const after = await tableHashes(sandbox.client);
    for (const table of ['matches', 'odds_snapshots', 'model_params']) assert.deepEqual(after[table], sandbox.before[table]);
    assert.notEqual(after.runtime_calibration_profiles.sha256, sandbox.before.runtime_calibration_profiles.sha256);
    assert.equal(result.providerRequests, 0);
    assert.equal(result.liveModelParameterWrites, 0);
  } finally {
    for (const [key, original] of [['TURSO_DATABASE_URL', originalUrl], ['TURSO_AUTH_TOKEN', originalToken], ['OPERATIONAL_CALIBRATION_ENABLED', originalFlag]]) {
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
    }
    sandbox?.client.close(); cleanup(directory);
  }
});

test('write guard rejects model updates and all DDL or bulk operations', async () => {
  let writes = 0;
  const guarded = guardCalibrationWrites({ execute: async () => { writes++; }, close: () => {} });
  await assert.rejects(guarded.execute('UPDATE model_params SET params_json=?'), /Only calibration/);
  await assert.rejects(guarded.execute('CREATE TABLE unexpected (id TEXT)'), /Only calibration/);
  assert.throws(() => guarded.executeMultiple('CREATE TABLE unexpected (id TEXT)'), /forbidden/);
  assert.equal(writes, 0);
});
