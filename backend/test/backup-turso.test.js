const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createClient } = require('@libsql/client');
const { databaseEndpoint, preflight, downloadDump, restoreAndVerify } = require('../scripts/backup-turso');

function verify(dump, database) {
  return spawnSync(process.execPath, [join(__dirname, '../scripts/backup-turso.js'), 'verify', '--dump', dump, '--database', database],
    { encoding: 'utf8', timeout: 10000 });
}

const DUMP = `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT);
INSERT INTO users VALUES('u1','fixture only');
CREATE TABLE bets(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), stake INTEGER, payload BLOB);
INSERT INTO bets VALUES('b1','u1',1000,X'0102');
CREATE INDEX bets_user ON bets(user_id);
COMMIT;
`;

async function withTemp(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'footpredictor-backup-fixture-'));
  try { await fn(directory); } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('backup accepts only HTTPS expected database without embedded credentials', () => {
  assert.equal(databaseEndpoint('libsql://fixture.turso.io', 'fixture.turso.io').href, 'https://fixture.turso.io/');
  for (const url of ['http://fixture.turso.io', 'file:production.db', 'https://other.turso.io',
    'https://secret@fixture.turso.io', 'https://fixture.turso.io?token=secret', 'https://fixture.turso.io/path']) {
    assert.throws(() => databaseEndpoint(url, 'fixture.turso.io'));
  }
  assert.throws(() => databaseEndpoint('https://fixture.turso.io'));
});

test('preflight only reads schema and page metadata without initializing application tables', async () => {
  const db = createClient({ url: ':memory:' });
  try {
    await db.execute('CREATE TABLE fixture (id INTEGER)');
    const queries = [];
    const info = await preflight({ execute: (sql) => { queries.push(sql); return db.execute(sql); } });
    assert.deepEqual(info.tables, ['fixture']);
    assert.ok(info.approximateDatabaseBytes > 0);
    assert.equal(info.quotaVerified, false);
    assert.ok(queries.every((sql) => /^(SELECT|PRAGMA)\b/.test(sql)));
    assert.match(info.schemaSha256, /^[a-f0-9]{64}$/);
  } finally { db.close(); }
});

test('official dump is downloaded once without redirect or token in URL, and restores locally with full counts', async () => {
  await withTemp(async (directory) => {
    const dumpFile = join(directory, 'database.sql');
    let calls = 0;
    const downloaded = await downloadDump({ endpoint: new URL('https://fixture.turso.io/'), token: 'fixture-secret',
      outputFile: dumpFile, maxBytes: 10000, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url.href, 'https://fixture.turso.io/dump');
        assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
        assert.equal(options.redirect, 'error');
        return new Response(DUMP, { status: 200 });
      } });
    assert.equal(calls, 1);
    assert.equal(readFileSync(dumpFile, 'utf8'), DUMP);
    assert.equal(downloaded.bytes, Buffer.byteLength(DUMP));
    assert.equal(downloaded.sha256, createHash('sha256').update(DUMP).digest('hex'));
    const target = join(directory, 'restore.db');
    const restored = verify(dumpFile, target);
    assert.equal(restored.status, 0, restored.stderr);
    const verified = JSON.parse(restored.stdout);
    assert.equal(verified.readable, true);
    assert.deepEqual(verified.integrity, ['ok']);
    assert.equal(verified.foreignKeyViolations, 0);
    assert.deepEqual(verified.tableCounts, { bets: '1', users: '1' });
    assert.match(verified.databaseSha256, /^[a-f0-9]{64}$/);
    assert.equal(verify(dumpFile, target).status, 1);
  });
});

test('partial, oversized and HTTP-error downloads cannot be accepted as backup', async () => {
  await withTemp(async (directory) => {
    for (const [name, body, status, maxBytes] of [
      ['partial', DUMP.replace(/COMMIT;\n$/, ''), 200, 10000],
      ['oversized', DUMP, 200, 5], ['http-error', 'denied', 401, 10000],
    ]) {
      await assert.rejects(downloadDump({ endpoint: new URL('https://fixture.turso.io/'), token: 'fixture-token',
        outputFile: join(directory, `${name}.sql`), maxBytes, fetchImpl: async () => new Response(body, { status }) }));
    }
    assert.equal(existsSync(join(directory, 'http-error.sql')), false);
  });
});

test('restore reports existing foreign-key violations without hiding them', async () => {
  await withTemp(async (directory) => {
    const path = join(directory, 'invalid.sql');
    writeFileSync(path, DUMP.replace("'b1','u1'", "'b1','missing'"));
    const restored = verify(path, join(directory, 'invalid.db'));
    assert.equal(restored.status, 1);
    const result = JSON.parse(restored.stdout);
    assert.equal(result.readable, true);
    assert.equal(result.foreignKeyViolations, 1);
  });
});

test('offline restore rejects a truncated dump before creating a database', async () => {
  await withTemp(async (directory) => {
    const path = join(directory, 'partial.sql');
    const target = join(directory, 'partial.db');
    writeFileSync(path, DUMP.replace(/COMMIT;\n$/, ''));
    const restored = verify(path, target);
    assert.equal(restored.status, 1);
    assert.equal(existsSync(target), false);
    assert.doesNotMatch(restored.stderr, /fixture only|INSERT INTO|Bearer/);
  });
});

test('large overall dump streams through download and restore without whole-file JavaScript reads', async () => {
  await withTemp(async (directory) => {
    const rows = 8000;
    const sql = `PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE many_rows(id INTEGER PRIMARY KEY, value TEXT);\n${
      Array.from({ length: rows }, (_, i) => `INSERT INTO many_rows VALUES(${i},'${'fixture-'.repeat(32)}');\n`).join('')}COMMIT;\n`;
    const encoded = Buffer.from(sql);
    const dump = join(directory, 'streamed.sql');
    let chunks = 0;
    const body = new ReadableStream({ pull(controller) {
      const start = chunks++ * 4096;
      if (start < encoded.length) controller.enqueue(encoded.subarray(start, start + 4096));
      else controller.close();
    } });
    const fs = require('node:fs');
    const originalRead = fs.readFileSync;
    try {
      fs.readFileSync = () => { throw new Error('Whole-file reads are forbidden in this test'); };
      const result = await downloadDump({ endpoint: new URL('https://fixture.turso.io/'), token: 'fixture-token', outputFile: dump,
        maxBytes: encoded.length, fetchImpl: async () => new Response(body) });
      const restored = await restoreAndVerify(dump, join(directory, 'streamed.db'));
      assert.equal(result.bytes, encoded.length);
      assert.ok(chunks > 100);
      assert.deepEqual(restored.tableCounts, { many_rows: String(rows) });
      assert.deepEqual(restored.integrity, ['ok']);
    } finally { fs.readFileSync = originalRead; }
  });
});

test('streamed SQL parser preserves trigger bodies, quotes, semicolons and multiline Unicode text', async () => {
  await withTemp(async (directory) => {
    const dump = join(directory, 'triggers.sql');
    const target = join(directory, 'triggers.db');
    writeFileSync(dump, `PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;
CREATE TABLE events(id INTEGER PRIMARY KEY, value TEXT);
CREATE TABLE audit(value TEXT);
CREATE TRIGGER events_audit AFTER INSERT ON events BEGIN
  INSERT INTO audit VALUES(NEW.value);
  INSERT INTO audit VALUES('trigger; ''quoted''');
END;
INSERT INTO events VALUES(1,'first; line
second ''quoted'' 🧪');
COMMIT;
`);
    const restored = await restoreAndVerify(dump, target);
    assert.deepEqual(restored.tableCounts, { audit: '2', events: '1' });
    const check = spawnSync(process.env.BACKUP_PYTHON || 'python', ['-I', '-c',
      'import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute("SELECT value FROM audit ORDER BY rowid").fetchall())); c.close()', target],
    { encoding: 'utf8', timeout: 10000 });
    assert.equal(check.status, 0);
    assert.deepEqual(JSON.parse(check.stdout), [["first; line\nsecond 'quoted' 🧪"], ["trigger; 'quoted'"]]);
  });
});

test('malformed SQL fails even when its transaction envelope looks complete', async () => {
  await withTemp(async (directory) => {
    const dump = join(directory, 'malformed.sql');
    writeFileSync(dump, DUMP.replace('CREATE TABLE users', 'NOT VALID SQL users'));
    const result = verify(dump, join(directory, 'malformed.db'));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /fixture only|NOT VALID SQL|INSERT INTO|Bearer|Traceback/);
  });
});
