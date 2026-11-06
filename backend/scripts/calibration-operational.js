// Default: read-only plan. Execution is explicit, existing-schema-only and cache-only.
const { createClient } = require('@libsql/client');
const { createHash } = require('node:crypto');
const { openSync, writeFileSync, fsyncSync, closeSync, readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { fileURLToPath } = require('node:url');
const { COMPETITIONS, loadRuntime, readOnlyDatabase, preflightCalibration } = require('./calibration-preflight');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const targetFingerprint = (url) => sha256(String(url).trim());

function requireExistingTarget(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Database target URL is invalid'); }
  if (!['libsql:', 'https:', 'file:'].includes(parsed.protocol)) throw new Error('Database target protocol is invalid');
  if (parsed.protocol === 'file:') {
    let file;
    try { file = fileURLToPath(parsed); } catch { throw new Error('Local database target URL is invalid'); }
    if (!existsSync(file)) throw new Error('Local database target must already exist');
  }
}

function authorizeExecution(options, env) {
  if (!options.execute) return;
  if (options.authorizeCalibrationWrites !== true || env.OPERATIONAL_CALIBRATION_ENABLED !== 'true') {
    throw new Error('Explicit calibration-write authorization and OPERATIONAL_CALIBRATION_ENABLED=true are required');
  }
  if (options.targetSha256 !== targetFingerprint(env.TURSO_DATABASE_URL)) throw new Error('Target fingerprint does not match');
  if (!options.backupFile) throw new Error('A new explicit backup file is required');
}

async function requireExistingSchema(client) {
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_calibration_profiles'");
  if (tables.rows.length !== 1) throw new Error('Calibration cache schema is missing; this command never applies migrations');
  const columns = new Set((await client.execute("SELECT name FROM pragma_table_info('runtime_calibration_profiles')")).rows.map((row) => row.name));
  if (!['cache_key', 'competition', 'payload_json', 'payload_sha256', 'created_at'].every((name) => columns.has(name))) {
    throw new Error('Calibration cache schema is incompatible; this command never applies migrations');
  }
}

function writeBackup(file, payload) {
  const absolutePath = resolve(file);
  const serialized = JSON.stringify(payload, null, 2) + '\n';
  const descriptor = openSync(absolutePath, 'wx', 0o600);
  try { writeFileSync(descriptor, serialized); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  const checksum = sha256(serialized);
  if (sha256(readFileSync(absolutePath)) !== checksum) throw new Error('Backup read-back checksum does not match');
  return { file: absolutePath, sha256: checksum, rows: payload.rows.length, rowsSha256: payload.rowsSha256 };
}

/** Block any accidentally introduced write outside the disposable calibration cache. */
function guardCalibrationWrites(client) {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'execute') return async (statement) => {
        const sql = typeof statement === 'string' ? statement : statement.sql;
        const read = /^\s*SELECT\b/i.test(sql);
        const cacheInsert = /^\s*INSERT\s+INTO\s+runtime_calibration_profiles\s*\(/i.test(sql);
        const cacheDelete = /^\s*DELETE\s+FROM\s+runtime_calibration_profiles\b/i.test(sql);
        if ((!read && !cacheInsert && !cacheDelete) || /;\s*\S/.test(sql)) throw new Error('Only calibration cache writes are authorized');
        return target.execute(statement);
      };
      if (['executeMultiple', 'batch', 'transaction', 'migrate', 'sync'].includes(property)) return () => { throw new Error('Schema and bulk operations are forbidden'); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function runOperationalCalibration(options = {}, dependencies = {}) {
  const env = options.env ?? process.env;
  if (!String(env.TURSO_DATABASE_URL ?? '').trim()) throw new Error('Missing database configuration');
  authorizeExecution(options, env);
  requireExistingTarget(env.TURSO_DATABASE_URL.trim());
  const runtime = options.runtime ?? loadRuntime();
  const targetSha256 = targetFingerprint(env.TURSO_DATABASE_URL);
  const competitions = options.competitions ?? COMPETITIONS;
  const client = (dependencies.createClient ?? createClient)({
    url: env.TURSO_DATABASE_URL.trim(), authToken: env.TURSO_AUTH_TOKEN,
  });
  let db;
  try {
    await requireExistingSchema(client);
    const preflight = await preflightCalibration(readOnlyDatabase(client, runtime), competitions, { runtime });
    const plan = {
      mode: options.execute ? 'execute' : 'plan', targetSha256, preflight,
      existingSchemaOnly: true, providerRequests: 0,
      backupPlan: { table: 'runtime_calibration_profiles', selection: 'all rows, no limit, ordered by cache_key',
        fileMustBeNew: true, completeBeforeConstruction: true },
      permittedWrites: ['runtime_calibration_profiles'],
      requiredAuthorization: ['--execute', '--authorize-calibration-writes', '--target-sha256', '--backup-file', 'OPERATIONAL_CALIBRATION_ENABLED=true'],
    };
    if (!options.execute) return { ...plan, databaseWrites: 0, databaseServiceConstructed: false };
    const rows = (await client.execute('SELECT cache_key, competition, payload_json, payload_sha256, created_at FROM runtime_calibration_profiles ORDER BY cache_key')).rows;
    const backup = writeBackup(options.backupFile, {
      format: 'footpredictor-calibration-cache-backup-v1', createdAt: new Date().toISOString(),
      targetSha256, codeRevision: preflight.runtime.codeRevision,
      configurationSha256: preflight.runtime.configurationSha256,
      rowsSha256: sha256(JSON.stringify(rows)), rows,
    });
    // The actual constructor reads process.env; never let an injected plan env select a second target.
    if (!dependencies.createDatabase && String(process.env.TURSO_DATABASE_URL ?? '').trim() !== env.TURSO_DATABASE_URL.trim()) {
      throw new Error('Database constructor environment does not match the authorized target');
    }
    db = dependencies.createDatabase ? dependencies.createDatabase({ skipSchemaBootstrap: true })
      : new runtime.DatabaseService({ skipSchemaBootstrap: true });
    await db.initPromise;
    db.db = guardCalibrationWrites(db.db);
    const previousProspectiveFlag = process.env.MODEL_A_PROSPECTIVE_ENABLED;
    process.env.MODEL_A_PROSPECTIVE_ENABLED = 'false';
    try {
      const warm = dependencies.warmAndVerify ?? require('./warm-calibration').warmAndVerify;
      const profiles = await warm(db, () => new runtime.PredictionService(db, {
        getMatchDetails: async () => { throw new Error('Provider requests are forbidden in calibration preparation'); },
      }, { allowCalibrationRebuild: true }), competitions, options.log ?? (() => {}),
      { recentReplayLimit: options.recentReplayLimit ?? 10 });
      const verified = await preflightCalibration(readOnlyDatabase(client, runtime), competitions, { runtime });
      if (!verified.ready) throw new Error('Prepared cache cannot be reused by the exact runtime');
      return { ...plan, backup, profiles, verified, databaseServiceConstructed: true,
        writesConfinedTo: 'runtime_calibration_profiles', liveModelParameterWrites: 0, prospectiveCollection: false };
    } finally {
      if (previousProspectiveFlag === undefined) delete process.env.MODEL_A_PROSPECTIVE_ENABLED;
      else process.env.MODEL_A_PROSPECTIVE_ENABLED = previousProspectiveFlag;
    }
  } finally {
    if (db) await db.close();
    client.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (args.includes('--execute') && args.includes('--plan')) throw new Error('Select either plan or execute');
  const result = await runOperationalCalibration({
    execute: args.includes('--execute'), authorizeCalibrationWrites: args.includes('--authorize-calibration-writes'),
    targetSha256: value('--target-sha256'), backupFile: value('--backup-file'),
  });
  console.log(JSON.stringify(result));
}

if (require.main === module) main().catch((error) => {
  const failure = error.code === 'EEXIST' ? 'backup_already_exists'
    : /^Explicit calibration-write authorization/.test(error.message) ? 'authorization_required'
      : /^Target fingerprint/.test(error.message) ? 'target_mismatch'
        : /^A new explicit backup/.test(error.message) ? 'backup_required'
          : /^Calibration cache schema is missing/.test(error.message) ? 'existing_schema_missing'
            : /^Calibration cache schema is incompatible/.test(error.message) ? 'existing_schema_incompatible'
                : /^Local database target must already exist/.test(error.message) ? 'existing_target_missing'
              : 'preparation_failed';
  console.error(`[calibration-operational] ${failure}. Inspect the private backup before retrying; no provider requests or migrations are permitted.`);
  process.exitCode = 1;
});

module.exports = { targetFingerprint, authorizeExecution, requireExistingSchema, guardCalibrationWrites, runOperationalCalibration, main };
