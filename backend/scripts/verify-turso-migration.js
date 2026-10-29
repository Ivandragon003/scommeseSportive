/* Offline parity only: no credentials, network, application bootstrap or writes. */
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { readFile, stat, realpath } = require('node:fs/promises');
const { dirname, join, resolve, relative, sep, isAbsolute } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const executeFile = promisify(execFile);

function validNativeExport(manifest) {
  const files = manifest.snapshot?.files;
  const command = manifest.export?.command;
  if (manifest.engine !== 'libsql' || manifest.export?.completed !== true
    || !/^v\d+\.\d+\.\d+$/.test(manifest.export?.cliVersion ?? '')
    || !Array.isArray(command) || command.length !== 6
    || command.slice(0, 3).join(' ') !== 'turso db export'
    || typeof command[3] !== 'string' || !/^[a-z][a-z0-9_-]{0,62}$/.test(command[3])
    || command[4] !== '--output-file' || command[5] !== '/export/database.db'
    || manifest.restoration?.method !== 'checkpoint_new_local_copy'
    || manifest.restoration?.archivedFilesUnchanged !== true
    || !Array.isArray(files) || files.length < 1 || files.length > 2
    || files[0]?.role !== 'database'
    || !files.every((file) => file && ['database', 'wal'].includes(file.role)
      && file.path === `export/database.db${file.role === 'wal' ? '-wal' : ''}`
      && Number.isSafeInteger(file.bytes) && file.bytes >= (file.role === 'database' ? 1 : 0)
      && /^[a-f0-9]{64}$/.test(file.sha256))
    || new Set(files.map((file) => file.role)).size !== files.length) return false;
  const descriptor = files.map((file) => [file.role, file.path, file.bytes, file.sha256]);
  return createHash('sha256').update(JSON.stringify(descriptor)).digest('hex') === manifest.snapshot.sha256;
}

function validateManifest(manifest, expectedHost) {
  const knownMethod = manifest.format === 'turso-sql-dump-v1' && manifest.method === 'official_GET_dump'
    ? /^[a-f0-9]{64}$/.test(manifest.dump?.sha256 ?? '')
    : manifest.format === 'turso-sqlite-snapshot-v1' && manifest.method === 'official_CLI_db_export'
      && validNativeExport(manifest);
  if (typeof expectedHost !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.turso\.io$/.test(expectedHost)
    || manifest.databaseHost !== expectedHost || !knownMethod || manifest.complete !== true
    || !/^[a-f0-9]{64}$/.test(manifest.verification?.databaseSha256 ?? '')
    || manifest.verification?.readable !== true || manifest.verification?.foreignKeyViolations !== 0
    || !Array.isArray(manifest.verification?.integrity) || manifest.verification.integrity.join(',') !== 'ok'
    || !manifest.verification?.tableCounts || typeof manifest.verification.tableCounts !== 'object'
    || Array.isArray(manifest.verification.tableCounts)
    || !Object.values(manifest.verification.tableCounts).every((count) => /^\d+$/.test(String(count)))
    || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(manifest.completedAt ?? '')
    || !Number.isFinite(Date.parse(manifest.completedAt ?? ''))) {
    throw new Error('Verified manifest and exact expected database host required');
  }
  return manifest;
}

async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyNativeArchive(snapshot) {
  if (snapshot.manifest.format !== 'turso-sqlite-snapshot-v1') return 0;
  const directory = await realpath(snapshot.directory);
  for (const file of snapshot.manifest.snapshot.files) {
    const path = await realpath(join(directory, file.path));
    const child = relative(directory, path);
    const metadata = await stat(path);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || !metadata.isFile()
      || metadata.size !== file.bytes || await checksum(path) !== file.sha256) {
      throw new Error('Archived snapshot checksum or path mismatch');
    }
  }
  return snapshot.manifest.snapshot.files.length;
}

async function loadSnapshot(path, expectedHost) {
  const manifestPath = resolve(path);
  if ((await stat(manifestPath)).size > 2 * 1024 * 1024) throw new Error('Manifest exceeds allowed size');
  const text = await readFile(manifestPath, 'utf8');
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Manifest exceeds allowed size');
  const manifest = validateManifest(JSON.parse(text), expectedHost);
  const database = join(dirname(manifestPath), 'restore.db');
  if (await checksum(database) !== manifest.verification.databaseSha256) throw new Error('Restore checksum mismatch');
  const snapshot = { manifest, database, directory: dirname(manifestPath) };
  await verifyNativeArchive(snapshot);
  return snapshot;
}

function countsMatchManifest(snapshot, manifest) {
  const actual = Object.fromEntries(Object.entries(snapshot.tables).filter(([name]) => !name.startsWith('sqlite_'))
    .map(([name, table]) => [name, table.count]));
  const expected = manifest.verification.tableCounts;
  return Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(actual).every(([name, count]) => String(expected[name]) === count);
}

async function verifyMigrationSnapshots({ sourceManifest, targetManifest, expectedSourceHost, expectedTargetHost,
  python = process.env.BACKUP_PYTHON || 'python' }) {
  if (expectedSourceHost === expectedTargetHost) throw new Error('Distinct source and target hosts required');
  const [source, target] = await Promise.all([
    loadSnapshot(sourceManifest, expectedSourceHost), loadSnapshot(targetManifest, expectedTargetHost),
  ]);
  const { stdout } = await executeFile(python, ['-I', join(__dirname, 'verify-turso-migration.py'), source.database, target.database], {
    encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
    env: Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
      .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
  });
  const comparison = JSON.parse(stdout);
  comparison.manifestCountsMatch = countsMatchManifest(comparison.source, source.manifest)
    && countsMatchManifest(comparison.target, target.manifest);
  comparison.restoresUnchanged = await checksum(source.database) === source.manifest.verification.databaseSha256
    && await checksum(target.database) === target.manifest.verification.databaseSha256;
  const archivedFiles = await Promise.all([verifyNativeArchive(source), verifyNativeArchive(target)]);
  comparison.nativeExportFilesVerified = archivedFiles.reduce((sum, count) => sum + count, 0);
  comparison.snapshotParity = comparison.snapshotParity && comparison.manifestCountsMatch && comparison.restoresUnchanged;
  return { ...comparison, sourceHost: expectedSourceHost, targetHost: expectedTargetHost,
    sourceSnapshotAt: source.manifest.completedAt, targetSnapshotAt: target.manifest.completedAt,
    sourceMethod: source.manifest.method, targetMethod: target.manifest.method,
    liveParityVerified: false,
    limit: 'Compares coherent exported snapshots only. A later live source write is not covered; cutover requires a final write freeze and synchronization.' };
}

function optionsOf(args) {
  const names = new Set(['source-manifest', 'target-manifest', 'expected-source-host', 'expected-target-host', 'python']);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !names.has(name) || !args[i + 1] || args[i + 1].startsWith('--') || options[name]) {
      throw new Error('Expected unique known --option value pairs');
    }
    options[name] = args[i + 1];
  }
  for (const name of ['source-manifest', 'target-manifest', 'expected-source-host', 'expected-target-host']) {
    if (!options[name]) throw new Error('Missing required verification option');
  }
  return options;
}

async function main() {
  const options = optionsOf(process.argv.slice(2));
  const result = await verifyMigrationSnapshots({ sourceManifest: options['source-manifest'], targetManifest: options['target-manifest'],
    expectedSourceHost: options['expected-source-host'], expectedTargetHost: options['expected-target-host'], python: options.python });
  console.log(JSON.stringify(result));
  process.exitCode = result.snapshotParity ? 0 : 1;
}

module.exports = { validateManifest, verifyMigrationSnapshots, optionsOf };
if (require.main === module) main().catch(() => {
  // Never print driver errors, row values, credentials or SQL.
  console.error('Migration verification failed. Check verified manifests, exact hosts, restore checksums and the offline Python runtime. No database was modified.');
  process.exitCode = 1;
});
