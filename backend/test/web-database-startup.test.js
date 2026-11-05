const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const startupModule = resolve(__dirname, '../dist/db/WebDatabaseStartup.js');
const { createWebDatabase } = require(startupModule);

test('invalid web bootstrap configuration fails before database construction', () => {
  for (const value of ['flase', '1', 'yes']) {
    let constructed = false;
    assert.throws(() => createWebDatabase({ WEB_DATABASE_SCHEMA_BOOTSTRAP_ENABLED: value }, () => {
      constructed = true;
    }), /WEB_DATABASE_SCHEMA_BOOTSTRAP_ENABLED must be true or false/);
    assert.equal(constructed, false);
  }
});

test('web bootstrap bypass preserves schema and rows; default and true bootstrap normally', () => {
  // A child process releases native SQLite handles before Windows removes the fixture.
  const directory = mkdtempSync(join(tmpdir(), 'web-db-startup-'));
  const script = `
    const assert = require('node:assert/strict');
    const { createClient } = require(process.env.TEST_CLIENT_MODULE);
    const { createWebDatabase } = require(process.env.TEST_STARTUP_MODULE);
    (async () => {
      const client = createClient({ url: 'file:fixture.db' });
      await client.execute('CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT)');
      await client.execute("INSERT INTO evidence VALUES (1, 'preserve')");
      const snapshot = async () => ({
        schema: (await client.execute("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")).rows,
        rows: (await client.execute('SELECT * FROM evidence ORDER BY id')).rows,
      });
      const before = await snapshot();
      let service = createWebDatabase({ WEB_DATABASE_SCHEMA_BOOTSTRAP_ENABLED: 'false' });
      await service.initPromise;
      await service.close();
      assert.deepEqual(await snapshot(), before);
      client.close();
      for (const value of [undefined, 'true']) {
        process.env.TURSO_DATABASE_URL = value === undefined ? 'file:default.db' : 'file:true.db';
        service = createWebDatabase({ WEB_DATABASE_SCHEMA_BOOTSTRAP_ENABLED: value });
        await service.initPromise;
        const markers = await service.db.execute('SELECT version FROM schema_migrations');
        assert.ok(markers.rows.length > 0);
        await service.close();
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: directory,
      env: { ...process.env, TEST_STARTUP_MODULE: startupModule,
        TEST_CLIENT_MODULE: require.resolve('@libsql/client'),
        TURSO_DATABASE_URL: 'file:fixture.db', TURSO_AUTH_TOKEN: 'local-test-token' },
      encoding: 'utf8', timeout: 60000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
