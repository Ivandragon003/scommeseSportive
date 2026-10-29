const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, statSync, appendFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, dirname } = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateManifest, verifyMigrationSnapshots, optionsOf } = require('../scripts/verify-turso-migration');

const SOURCE_HOST = 'fixture-source.turso.io';
const TARGET_HOST = 'fixture-personal.turso.io';
const PYTHON = process.env.BACKUP_PYTHON || 'python';
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const SETUP = `
import json,sqlite3,sys
schema = '''
CREATE TABLE users(id TEXT PRIMARY KEY);
CREATE TABLE ledger(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),amount INTEGER,probability REAL,payload TEXT,raw BLOB);
CREATE INDEX ledger_user ON ledger(user_id);
CREATE TABLE events(value TEXT);
CREATE TABLE sequence_rows(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT);
CREATE TABLE audit(value TEXT);
CREATE TABLE sqlitex_notes(value TEXT);
CREATE TRIGGER ledger_audit AFTER INSERT ON ledger BEGIN INSERT INTO audit VALUES(NEW.id); END;
'''
rows = [('a','user',9223372036854775807,1.0000000000000002,'line; one\\nsecond 🧪',b'\\x00\\xff'),
        ('b','user',-9223372036854775808,1.0,'quoted \\'text\\'',b''),('c','user',0,None,'',None)]
scenario = sys.argv[3]
for index,path in enumerate(sys.argv[1:3]):
    connection=sqlite3.connect(path)
    connection.executescript(schema)
    connection.execute("INSERT INTO users VALUES ('user')")
    connection.executemany('INSERT INTO ledger VALUES(?,?,?,?,?,?)', list(reversed(rows)) if index else rows)
    events=[('same',),('same',),('different',)]
    if scenario=='large': events += [('item-'+str(i),) for i in range(140000)]
    connection.executemany('INSERT INTO events VALUES(?)',list(reversed(events)) if index else events)
    connection.execute("INSERT INTO sqlitex_notes VALUES('application table, not SQLite metadata')")
    connection.execute("INSERT INTO sequence_rows VALUES(1,'keep')")
    connection.execute("INSERT INTO sequence_rows VALUES(100,'remove')")
    connection.execute('DELETE FROM sequence_rows WHERE id=100')
    if index:
        if scenario=='data': connection.execute("UPDATE ledger SET amount=amount-1 WHERE id='a'")
        if scenario=='type': connection.execute("UPDATE events SET value=X'73616D65' WHERE rowid=(SELECT rowid FROM events WHERE value='same' LIMIT 1)")
        if scenario=='duplicate': connection.execute("DELETE FROM events WHERE rowid=(SELECT rowid FROM events WHERE value='same' LIMIT 1)"); connection.execute("INSERT INTO events VALUES('different')")
        if scenario=='schema': connection.execute('CREATE INDEX ledger_probability ON ledger(probability)')
        if scenario=='sequence': connection.execute("UPDATE sqlite_sequence SET seq=1 WHERE name='sequence_rows'")
    if scenario=='invalid_fk': connection.execute("UPDATE ledger SET user_id='missing' WHERE id='a'")
    connection.commit()
    counts={name:str(connection.execute('SELECT COUNT(*) FROM "'+name+'"').fetchone()[0]) for (name,) in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'")}
    connection.close()
    print(json.dumps(counts))
`;

async function fixtures(scenario, fn) {
  const directory = mkdtempSync(join(tmpdir(), 'footpredictor-migration-fixture-'));
  try {
    const sourceDir = join(directory, 'source'), targetDir = join(directory, 'target');
    mkdirSync(sourceDir); mkdirSync(targetDir);
    const sourceDatabase = join(sourceDir, 'restore.db'), targetDatabase = join(targetDir, 'restore.db');
    const created = spawnSync(PYTHON, ['-I', '-c', SETUP, sourceDatabase, targetDatabase, scenario], { encoding: 'utf8', timeout: 10000 });
    assert.equal(created.status, 0, created.stderr);
    const counts = created.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const sourceManifest = join(sourceDir, 'manifest.json'), targetManifest = join(targetDir, 'manifest.json');
    for (const [index, path, host, database] of [[0, sourceManifest, SOURCE_HOST, sourceDatabase], [1, targetManifest, TARGET_HOST, targetDatabase]]) {
      writeFileSync(path, JSON.stringify({ format: 'turso-sql-dump-v1', method: 'official_GET_dump', databaseHost: host,
        complete: true, completedAt: '2026-10-29T15:00:00.000Z', dump: { sha256: 'a'.repeat(64) },
        verification: { databaseSha256: hash(database), readable: true, integrity: ['ok'], foreignKeyViolations: 0, tableCounts: counts[index] } }));
    }
    await fn({ sourceManifest, targetManifest, expectedSourceHost: SOURCE_HOST, expectedTargetHost: TARGET_HOST,
      sourceDatabase, targetDatabase, directory });
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('offline parity preserves typed values, duplicates, constraints, triggers and sequences despite insertion order', async () => {
  await fixtures('same', async (options) => {
    const before = [hash(options.sourceDatabase), hash(options.targetDatabase)];
    const result = await verifyMigrationSnapshots(options);
    assert.equal(result.snapshotParity, true);
    assert.equal(result.schemaMatches, true);
    assert.equal(result.manifestCountsMatch, true);
    assert.equal(result.restoresUnchanged, true);
    assert.equal(result.liveParityVerified, false);
    assert.deepEqual(result.mismatchedTables, []);
    assert.equal(result.source.tables.sqlite_sequence.count, '1');
    assert.equal(result.source.tables.sqlitex_notes.count, '1');
    assert.deepEqual(result.source.integrity, ['ok']);
    assert.equal(result.target.foreignKeyViolations, 0);
    assert.deepEqual([hash(options.sourceDatabase), hash(options.targetDatabase)], before);
    assert.doesNotMatch(JSON.stringify(result), /line; one|quoted|missing|🧪/);
  });
});

for (const scenario of ['data', 'type', 'duplicate', 'sequence']) {
  test(`offline checksum rejects ${scenario} changes even with identical user-table counts`, async () => {
    await fixtures(scenario, async (options) => {
      const result = await verifyMigrationSnapshots(options);
      assert.equal(result.snapshotParity, false);
      assert.equal(result.schemaMatches, true);
      assert.equal(result.manifestCountsMatch, true);
      assert.ok(result.mismatchedTables.length > 0);
    });
  });
}

test('offline parity rejects an index mismatch and does not infer schema compatibility', async () => {
  await fixtures('schema', async (options) => {
    const result = await verifyMigrationSnapshots(options);
    assert.equal(result.snapshotParity, false);
    assert.equal(result.schemaMatches, false);
    assert.deepEqual(result.mismatchedTables, []);
  });
});

test('equal data with foreign-key violations cannot pass migration acceptance', async () => {
  await fixtures('invalid_fk', async (options) => {
    const result = await verifyMigrationSnapshots(options);
    assert.equal(result.schemaMatches, true);
    assert.deepEqual(result.mismatchedTables, []);
    assert.equal(result.source.foreignKeyViolations, 1);
    assert.equal(result.snapshotParity, false);
  });
});

test('large unordered tables compare through bounded checksum chunks without altering either restore', async () => {
  await fixtures('large', async (options) => {
    const result = await verifyMigrationSnapshots(options);
    assert.equal(result.snapshotParity, true);
    assert.equal(result.source.tables.events.count, '140003');
    assert.equal(result.restoresUnchanged, true);
  });
});

function nativeTarget(options) {
  const original = JSON.parse(readFileSync(options.targetManifest, 'utf8'));
  const root = dirname(options.targetManifest), archive = join(root, 'export');
  mkdirSync(archive);
  copyFileSync(options.targetDatabase, join(archive, 'database.db'));
  writeFileSync(join(archive, 'database.db-wal'), '');
  const files = [['database', 'export/database.db'], ['wal', 'export/database.db-wal']].map(([role, path]) => ({
    role, path, bytes: statSync(join(root, path)).size, sha256: hash(join(root, path)),
  }));
  const native = { ...original, format: 'turso-sqlite-snapshot-v1', method: 'official_CLI_db_export', engine: 'libsql',
    export: { completed: true, cliVersion: 'v1.0.34',
      command: ['turso', 'db', 'export', 'fixture-personal', '--output-file', '/export/database.db'] },
    restoration: { method: 'checkpoint_new_local_copy', archivedFilesUnchanged: true },
    snapshot: { files, sha256: createHash('sha256').update(JSON.stringify(files.map((file) =>
      [file.role, file.path, file.bytes, file.sha256]))).digest('hex') } };
  delete native.dump;
  writeFileSync(options.targetManifest, JSON.stringify(native));
  return native;
}

test('official CLI SQLite snapshot manifests verify preserved archives and match an official SQL-dump snapshot', async () => {
  await fixtures('same', async (options) => {
    nativeTarget(options);
    const result = await verifyMigrationSnapshots(options);
    assert.equal(result.snapshotParity, true);
    assert.equal(result.sourceMethod, 'official_GET_dump');
    assert.equal(result.targetMethod, 'official_CLI_db_export');
    assert.equal(result.nativeExportFilesVerified, 2);
    assert.equal(result.restoresUnchanged, true);
    assert.equal(result.liveParityVerified, false);
    appendFileSync(join(dirname(options.targetManifest), 'export/database.db'), 'fixture archive corruption');
    await assert.rejects(verifyMigrationSnapshots(options), /Archived snapshot checksum or path mismatch/);
  });
});

test('native export acceptance rejects unknown methods, engines, incomplete metadata and unsafe archive layouts', async () => {
  await fixtures('same', async (options) => {
    const native = nativeTarget(options);
    for (const invalid of [
      { ...native, method: 'official_GET_dump' }, { ...native, engine: 'tursodb' },
      { ...native, format: 'turso-sql-dump-v1' }, { ...native, export: { ...native.export, completed: false } },
      { ...native, export: { ...native.export, cliVersion: undefined } },
      { ...native, export: { ...native.export, command: [...native.export.command.slice(0, 3), null, '--output-file', '/export/database.db'] } },
      { ...native, export: { ...native.export, command: [...native.export.command, '--overwrite'] } },
      { ...native, restoration: undefined }, { ...native, snapshot: { ...native.snapshot, sha256: '0'.repeat(64) } },
      { ...native, snapshot: { ...native.snapshot, files: [native.snapshot.files[0], native.snapshot.files[0]] } },
      { ...native, snapshot: { ...native.snapshot, files: [{ ...native.snapshot.files[0], path: '../private.db' }] } },
    ]) assert.throws(() => validateManifest(invalid, TARGET_HOST));
  });
});

test('manifest identity, completeness and current restore checksum are mandatory', async () => {
  await fixtures('same', async (options) => {
    await assert.rejects(verifyMigrationSnapshots({ ...options, expectedSourceHost: TARGET_HOST }));
    await assert.rejects(verifyMigrationSnapshots({ ...options, expectedTargetHost: SOURCE_HOST }));
    const manifest = JSON.parse(readFileSync(options.sourceManifest, 'utf8'));
    assert.throws(() => validateManifest({ ...manifest, complete: false }, SOURCE_HOST));
    assert.throws(() => validateManifest({ ...manifest, databaseHost: 'other.turso.io' }, SOURCE_HOST));
    assert.throws(() => validateManifest(manifest, 'https://fixture-source.turso.io'));
    assert.throws(() => validateManifest({ ...manifest, verification: { ...manifest.verification, tableCounts: [] } }, SOURCE_HOST));
    writeFileSync(options.sourceManifest, JSON.stringify({ ...manifest,
      verification: { ...manifest.verification, tableCounts: { ...manifest.verification.tableCounts, events: '999' } } }));
    const wrongCount = await verifyMigrationSnapshots(options);
    assert.equal(wrongCount.snapshotParity, false);
    assert.equal(wrongCount.manifestCountsMatch, false);
    writeFileSync(options.sourceManifest, JSON.stringify({ ...manifest,
      verification: { ...manifest.verification, databaseSha256: '0'.repeat(64) } }));
    await assert.rejects(verifyMigrationSnapshots(options), /Restore checksum mismatch/);
  });
});

test('nonempty journals fail safely and command errors expose no SQL, row contents or credentials', async () => {
  await fixtures('same', async (options) => {
    writeFileSync(options.targetDatabase + '-wal', 'fixture pending journal');
    const result = spawnSync(process.execPath, [join(__dirname, '../scripts/verify-turso-migration.js'),
      '--source-manifest', options.sourceManifest, '--target-manifest', options.targetManifest,
      '--expected-source-host', SOURCE_HOST, '--expected-target-host', TARGET_HOST], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, TURSO_AUTH_TOKEN: 'never-print-this-fixture-token' },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Migration verification failed/);
    assert.doesNotMatch(result.stderr, /never-print|fixture pending|SELECT|line; one|Traceback/);
  });
});

test('migration CLI accepts only explicit known options and distinct expected hosts', () => {
  const args = ['--source-manifest', 'source.json', '--target-manifest', 'target.json',
    '--expected-source-host', SOURCE_HOST, '--expected-target-host', TARGET_HOST];
  assert.equal(optionsOf(args)['source-manifest'], 'source.json');
  for (const extra of [['--token', 'secret'], ['--source-manifest', 'duplicate'], ['--python']]) {
    assert.throws(() => optionsOf([...args, ...extra]));
  }
  assert.throws(() => optionsOf([]));
});
