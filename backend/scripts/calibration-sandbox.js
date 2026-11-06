// Explicit file-only preparation. Operational URLs and credentials are never used.
const { createClient } = require('@libsql/client');
const { existsSync, openSync, closeSync, readFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { COMPETITIONS, loadRuntime, preflightCalibration, readOnlyDatabase } = require('./calibration-preflight');

const SNAPSHOT_FILES = {
  matches: 'calibration-input-rows-private.json', odds_snapshots: 'calibration-historical-quotes-private.json',
  runtime_calibration_profiles: 'calibration-profiles-private.json', model_params: 'latest-model-params-private.json',
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const identifier = (name) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw new Error('Invalid snapshot column');
  return `"${name}"`;
};

async function copyTable(client, table, rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error(`Missing complete snapshot table: ${table}`);
  const columns = Object.keys(rows[0]);
  if (!rows.every((row) => JSON.stringify(Object.keys(row)) === JSON.stringify(columns))) throw new Error(`Inconsistent snapshot schema: ${table}`);
  // BLOB affinity preserves exported numeric/text/null values, without coercing strings.
  const primary = table === 'matches' ? 'match_id' : table === 'odds_snapshots' ? 'snapshot_id'
    : table === 'runtime_calibration_profiles' ? 'cache_key' : 'id';
  await client.execute(`CREATE TABLE ${identifier(table)} (${columns.map((column) =>
    `${identifier(column)} BLOB${column === primary ? ' PRIMARY KEY' : ''}${table === 'runtime_calibration_profiles' && column === 'created_at'
      ? " DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))" : ''}`).join(',')})`);
  const sql = `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
  // Every chunk is atomic and a partial clone is never returned as a completed preparation.
  for (let index = 0; index < rows.length; index += 100) {
    await client.batch(rows.slice(index, index + 100).map((row) => ({ sql, args: columns.map((column) => row[column]) })), 'write');
  }
}

async function tableHashes(client) {
  const result = {};
  for (const table of Object.keys(SNAPSHOT_FILES)) {
    const rows = (await client.execute(`SELECT * FROM ${identifier(table)} ORDER BY rowid`)).rows;
    result[table] = { count: rows.length, sha256: sha256(JSON.stringify(rows)) };
  }
  return result;
}

async function createSnapshotSandbox(snapshot, outputDatabase, runtime = loadRuntime()) {
  if (String(outputDatabase).includes('://') || /^file:/i.test(String(outputDatabase))) throw new Error('A new local filesystem path is required');
  const file = resolve(outputDatabase);
  if (existsSync(file)) throw new Error('Refusing to overwrite an existing database');
  closeSync(openSync(file, 'wx'));
  const client = createClient({ url: pathToFileURL(file).href });
  try {
    for (const [table, rows] of Object.entries(snapshot)) {
      if (!Object.hasOwn(SNAPSHOT_FILES, table)) throw new Error('Unexpected snapshot table');
      await copyTable(client, table, rows);
    }
    for (const table of Object.keys(SNAPSHOT_FILES)) if (!Object.hasOwn(snapshot, table)) throw new Error(`Missing snapshot: ${table}`);
    const db = Object.create(runtime.DatabaseService.prototype);
    db.db = client;
    db.initPromise = Promise.resolve();
    const before = await tableHashes(client);
    for (const [table, rows] of Object.entries(snapshot)) {
      if (before[table].count !== rows.length || before[table].sha256 !== sha256(JSON.stringify(rows))) {
        throw new Error(`Snapshot round trip changed values or ordering: ${table}`);
      }
    }
    return { client, db, file, before };
  } catch (error) { client.close(); throw error; }
}

async function generateIsolatedProfiles(sandbox, competitions = COMPETITIONS, options = {}) {
  if (sandbox?.client?.protocol !== 'file' || sandbox.db?.db !== sandbox.client) {
    throw new Error('Isolated generation requires the same local file client for all database operations');
  }
  if (process.env.MODEL_A_PROSPECTIVE_ENABLED === 'true') throw new Error('Disable prospective collection in the sandbox process');
  const runtime = options.runtime ?? loadRuntime();
  const { warmAndVerify } = require('./warm-calibration');
  const profiles = await warmAndVerify(sandbox.db, () => new runtime.PredictionService(sandbox.db, {
    getMatchDetails: async () => { throw new Error('Provider calls are forbidden in calibration sandbox'); },
  }), competitions, options.log ?? (() => {}), { recentReplayLimit: options.recentReplayLimit ?? 0 });
  const after = await tableHashes(sandbox.client);
  for (const table of ['matches', 'odds_snapshots', 'model_params']) {
    if (JSON.stringify(after[table]) !== JSON.stringify(sandbox.before[table])) throw new Error(`Calibration changed protected table: ${table}`);
  }
  const preflight = await preflightCalibration(readOnlyDatabase(sandbox.client, runtime), competitions, { runtime });
  if (!preflight.ready) throw new Error('Prepared sandbox calibration is not reusable or has no observations');
  return { profiles, before: sandbox.before, after, preflight, liveModelParameterWrites: 0, providerRequests: 0, operationalWrites: 0 };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const directory = value('--snapshot-dir');
  const file = value('--output-db');
  if (!directory || !file) throw new Error('Use --snapshot-dir PATH --output-db NEW_LOCAL_PATH [--generate-isolated-profiles]');
  const receiptPath = join(resolve(directory), 'receipt-private.json');
  if (existsSync(receiptPath)) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    for (const [key, configured] of Object.entries(receipt.localNonSecretConfiguration ?? {})) {
      if (key.startsWith('MODEL_') || key === 'PLAYER_GOALS_XG_SHRINK') {
        if (configured == null) delete process.env[key];
        else process.env[key] = String(configured);
      }
    }
  }
  const snapshot = {};
  const inputFiles = {};
  for (const [table, name] of Object.entries(SNAPSHOT_FILES)) {
    const bytes = readFileSync(join(resolve(directory), name));
    snapshot[table] = JSON.parse(bytes);
    inputFiles[name] = sha256(bytes);
  }
  const runtime = loadRuntime();
  const sandbox = await createSnapshotSandbox(snapshot, file, runtime);
  try {
    const preflight = await preflightCalibration(readOnlyDatabase(sandbox.client, runtime), COMPETITIONS, { runtime });
    const generated = args.includes('--generate-isolated-profiles')
      ? await generateIsolatedProfiles(sandbox, COMPETITIONS, { runtime }) : null;
    console.log(JSON.stringify({ file: sandbox.file, inputFiles, before: sandbox.before, preflight, generated,
      nextStep: generated ? 'Sandbox only. Operational preparation still requires explicit authorization.'
        : 'To generate only in a new sandbox, repeat with a new output path and --generate-isolated-profiles.',
      operationalWrites: 0, providerRequests: 0 }));
  } finally { sandbox.client.close(); }
}

if (require.main === module) main().catch(() => {
  console.error('[calibration-sandbox] Failed. Existing databases and operational state were not modified.');
  process.exitCode = 1;
});

module.exports = { SNAPSHOT_FILES, createSnapshotSandbox, generateIsolatedProfiles, tableHashes };
