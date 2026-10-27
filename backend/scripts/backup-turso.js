/* Production backup reads only; all restore operations use a new local database. */
const { createClient } = require('@libsql/client');
const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { open } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolve, join, dirname } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const executeFile = promisify(execFile);

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
  await requireCompleteDump(outputFile);
  return { bytes, sha256: hash.digest('hex') };
}

async function requireCompleteDump(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 4096);
    const first = Buffer.alloc(length);
    const last = Buffer.alloc(length);
    await file.read(first, 0, length, 0);
    await file.read(last, 0, length, Math.max(0, size - length));
    if (!/^\s*PRAGMA foreign_keys=OFF;\s*BEGIN TRANSACTION;/i.test(first.toString('utf8'))
      || !/\bCOMMIT;\s*$/i.test(last.toString('utf8'))) throw new Error('Dump transaction envelope is incomplete');
  } finally { await file.close(); }
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function restoreAndVerify(dumpFile, databaseFile, { python = process.env.BACKUP_PYTHON || 'python' } = {}) {
  const target = resolve(databaseFile);
  if (existsSync(target)) throw new Error('Restore target already exists');
  await requireCompleteDump(dumpFile);
  // Python's standard SQLite library reads one complete statement at a time.
  // Never convert an entire large dump into a JavaScript string.
  const { stdout } = await executeFile(python, ['-I', join(__dirname, 'restore-turso-backup.py'), resolve(dumpFile), target],
    { encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
      // The offline restore process receives no database or provider credentials.
      env: Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
        .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])) });
  const result = JSON.parse(stdout);
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
    const verification = await restoreAndVerify(resolve(options.dump), resolve(options.database), { python: options.python });
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
  const verification = await restoreAndVerify(dumpFile, join(output, 'restore.db'), { python: options.python });
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
