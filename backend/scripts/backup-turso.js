/* Production backup reads only; all restore operations use a new local database. */
const { createClient } = require('@libsql/client');
const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } = require('node:fs');
const { resolve, join, dirname } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function databaseEndpoint(value, expectedHost) {
  const url = new URL(String(value).replace(/^libsql:/, 'https:'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || !expectedHost || url.hostname !== expectedHost) {
    throw new Error('Invalid database endpoint or unexpected host');
  }
  return url;
}

async function preflight(client) {
  // No application bootstrap: no migrations, initialization or wallet writes.
  const schema = await client.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name");
  const pageSize = Number((await client.execute('PRAGMA page_size')).rows[0].page_size);
  const pageCount = Number((await client.execute('PRAGMA page_count')).rows[0].page_count);
  return { approximateDatabaseBytes: pageSize * pageCount, pageSize, pageCount,
    schemaObjects: schema.rows.length, tables: schema.rows.filter((row) => row.type === 'table').map((row) => row.name),
    schemaSha256: createHash('sha256').update(JSON.stringify(schema.rows)).digest('hex'),
    quotaVerified: false, note: 'Database credentials cannot verify account billing or remaining transfer/read quotas.' };
}

async function downloadDump({ endpoint, token, outputFile, maxBytes, fetchImpl = fetch }) {
  if (!token || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || existsSync(outputFile)) {
    throw new Error('Token, positive byte limit and a new output file are required');
  }
  const url = new URL('/dump', endpoint);
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
    signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Dump download failed with HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (length && length > maxBytes) throw new Error('Dump exceeds configured download limit');
  const hash = createHash('sha256');
  let bytes = 0;
  const counter = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) return callback(new Error('Dump exceeds configured download limit'));
    hash.update(chunk); callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(outputFile, { flags: 'wx', mode: 0o600 }));
  // A truncated export is never accepted as a complete backup.
  const sql = readFileSync(outputFile, 'utf8');
  requireCompleteDump(sql);
  return { bytes, sha256: hash.digest('hex') };
}

function requireCompleteDump(sql) {
  if (!/^\s*PRAGMA foreign_keys=OFF;\s*BEGIN TRANSACTION;/i.test(sql) || !/\bCOMMIT;\s*$/i.test(sql)) {
    throw new Error('Dump transaction envelope is incomplete');
  }
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function restoreAndVerify(dumpFile, databaseFile) {
  const target = resolve(databaseFile);
  if (existsSync(target)) throw new Error('Restore target already exists');
  const sql = readFileSync(dumpFile, 'utf8');
  requireCompleteDump(sql);
  const client = createClient({ url: `file:${target}`, intMode: 'bigint' });
  let result;
  try {
    await client.executeMultiple(sql);
    const integrity = (await client.execute('PRAGMA integrity_check')).rows.map((row) => String(row.integrity_check));
    const foreignKeys = (await client.execute('PRAGMA foreign_key_check')).rows;
    const tables = (await client.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows;
    const counts = {};
    for (const row of tables) {
      const quoted = `"${String(row.name).replaceAll('"', '""')}"`;
      counts[row.name] = String((await client.execute(`SELECT COUNT(*) AS count FROM ${quoted}`)).rows[0].count);
    }
    result = { integrity, foreignKeyViolations: foreignKeys.length, tableCounts: counts,
      readable: integrity.length === 1 && integrity[0] === 'ok' };
  } finally { client.close(); if (existsSync(target)) chmodSync(target, 0o600); }
  return { ...result, databaseSha256: await fileHash(target) };
}

function optionsOf(args) {
  const options = { command: args[0] };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--quota-reviewed') { options.quotaReviewed = true; continue; }
    if (!args[i].startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Expected --option value');
    options[args[i].slice(2)] = args[++i];
  }
  return options;
}

async function main(args = process.argv.slice(2)) {
  const options = optionsOf(args);
  if (!['preflight', 'backup', 'verify'].includes(options.command)) throw new Error('Expected preflight, backup or verify');
  if (options.command === 'verify') {
    if (!options.dump || !options.database) throw new Error('--dump and a new --database path are required');
    const verification = await restoreAndVerify(resolve(options.dump), resolve(options.database));
    console.log(JSON.stringify({ action: 'isolated_restore', ...verification }));
    if (!verification.readable || verification.foreignKeyViolations) process.exitCode = 1;
    return;
  }
  const endpoint = databaseEndpoint(process.env.TURSO_DATABASE_URL, options['expected-host']);
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!token) throw new Error('Database token required in environment');
  const client = createClient({ url: endpoint.href, authToken: token });
  let inspection;
  try { inspection = await preflight(client); } finally { client.close(); }
  if (options.command === 'preflight') {
    console.log(JSON.stringify({ action: 'read_only_preflight', databaseHost: endpoint.hostname, ...inspection }));
    return;
  }
  if (!options.quotaReviewed) throw new Error('Review account read/transfer quotas and costs before passing --quota-reviewed');
  if (!options.out) throw new Error('A new private --out directory is required');
  const maxBytes = Number(options['max-bytes']);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('--max-bytes must be a positive integer');
  const output = resolve(options.out);
  if (!existsSync(dirname(output))) throw new Error('Output parent directory must already exist');
  mkdirSync(output, { mode: 0o700 });
  const startedAt = new Date().toISOString();
  const dumpFile = join(output, 'database.sql');
  const dump = await downloadDump({ endpoint, token, outputFile: dumpFile, maxBytes });
  const verification = await restoreAndVerify(dumpFile, join(output, 'restore.db'));
  const manifest = { format: 'turso-sql-dump-v1', startedAt, completedAt: new Date().toISOString(),
    databaseHost: endpoint.hostname, method: 'official_GET_dump', quotaReviewedByOperator: true,
    preflight: inspection, dump, verification,
    complete: verification.readable && verification.foreignKeyViolations === 0 };
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ action: 'backup_and_isolated_restore', manifest: join(output, 'manifest.json'),
    complete: manifest.complete, bytes: dump.bytes, sha256: dump.sha256, tables: Object.keys(verification.tableCounts).length,
    integrity: verification.integrity, foreignKeyViolations: verification.foreignKeyViolations }));
  if (!manifest.complete) process.exitCode = 1;
}

module.exports = { databaseEndpoint, preflight, downloadDump, restoreAndVerify, optionsOf };
if (require.main === module) main().catch(() => {
  // Driver and HTTP errors may contain SQL, URLs or credentials. Never print them.
  console.error('Backup not completed. Check environment, expected host, quota review, output path and available storage. Partial files must not be treated as verified backups.');
  process.exitCode = 1;
});
