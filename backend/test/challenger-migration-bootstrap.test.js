const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const databaseModule = resolve(__dirname, process.env.RESEARCH_TEST_DIST || '../dist', 'db/DatabaseService.js');
const { DatabaseService } = require(databaseModule);
const split = (sql) => DatabaseService.prototype.splitMigrationStatements.call({}, sql);

test('migration splitter ignores semicolons and keywords in comments and quoted SQL', () => {
  const sql = `-- a comment ; CREATE TRIGGER BEGIN END
    CREATE TABLE [table;name] ("column;name" TEXT, \`another;column\` TEXT);
    /* ; ' BEGIN END */ INSERT INTO [table;name] VALUES ('it''s; SQL', 'BEGIN; END');
    SELECT '";--', "escaped"";name", \`escaped\`\`;name\`; -- trailing ; comment`;
  const statements = split(sql);
  assert.equal(statements.length, 3);
  assert.match(statements[0], /CREATE TABLE \[table;name\]/);
  assert.match(statements[1], /'it''s; SQL'/);
  assert.match(statements[2], /escaped"";name/);
  assert.deepEqual(split('-- comment only;\n/* another; */'), []);
});

test('migration splitter keeps complete trigger bodies including nested CASE END and multiple commands', () => {
  const sql = `CREATE TEMPORARY TRIGGER "guard;name" BEFORE UPDATE ON evidence
    WHEN CASE WHEN OLD.id IS NULL THEN 0 ELSE 1 END = 1
    BEGIN
      SELECT CASE WHEN NEW.id IS NULL THEN RAISE(ABORT, 'bad; id')
        ELSE CASE WHEN OLD.id = NEW.id THEN 1 ELSE 0 END END;
      -- BEGIN END ; CASE
      INSERT INTO audit VALUES ('END;'); /* ; END */
    END;
    CREATE TRIGGER second_guard BEFORE DELETE ON evidence BEGIN
      SELECT RAISE(ABORT, 'immutable');
    END;
    SELECT 1;`;
  const statements = split(sql);
  assert.equal(statements.length, 3);
  assert.match(statements[0], /INSERT INTO audit/);
  assert.match(statements[0], /END$/);
  assert.match(statements[1], /^CREATE TRIGGER second_guard/);
  assert.equal(statements[2], 'SELECT 1');
  const migration = readFileSync(join(__dirname, '../migrations/025_challenger_adoption.sql'), 'utf8');
  const triggers = split(migration).filter((statement) => /^CREATE TRIGGER/i.test(statement));
  assert.equal(triggers.length, 10);
  assert.ok(triggers.every((statement) => /BEGIN SELECT RAISE\(.+\); END$/.test(statement)));
});

test('migration splitter rejects unterminated SQL before executing a partial migration', () => {
  for (const sql of ["SELECT 'unclosed;", 'SELECT 1; /* unclosed',
    'CREATE TRIGGER guard BEFORE DELETE ON evidence BEGIN SELECT 1;',
    'CREATE TRIGGER guard BEFORE DELETE ON evidence BEGIN SELECT CASE WHEN 1 THEN 2 END;']) {
    assert.throws(() => split(sql), /Unterminated SQL/);
  }
});

test('real DatabaseService bootstrap installs all 025 guards and reopening preserves evidence and migration markers', () => {
  // A child owns the native SQLite handles, so Windows can remove the fixture
  // only after every connection and the process itself have finished.
  const directory = mkdtempSync(join(tmpdir(), 'challenger-migration-bootstrap-'));
  const script = `
    const assert = require('node:assert/strict');
    const { DatabaseService } = require(process.env.TEST_DATABASE_MODULE);
    const tables = ['challenger_candidates', 'challenger_paired_forecasts',
      'challenger_forecast_results', 'challenger_candidate_reviews', 'challenger_adoption_events'];
    (async () => {
      let service = new DatabaseService();
      try {
        await service.initPromise;
        const client = service.db;
        const markersBefore = (await client.execute('SELECT * FROM schema_migrations ORDER BY version')).rows;
        assert.equal(markersBefore.filter(row => row.version === '025_challenger_adoption.sql').length, 1);
        const guardsBefore = (await client.execute("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'challenger_%' ORDER BY name")).rows;
        assert.equal(guardsBefore.length, 10);
        await client.execute("INSERT INTO challenger_candidates VALUES ('candidate', 'C-new', 'C-old', '{}', 'hash', '2026-11-01T02:07:00Z')");
        await client.execute("INSERT INTO challenger_paired_forecasts VALUES ('forecast', 'candidate', 'match', 'EPL', '2026-11-02T02:07:00Z', '2026-11-02T18:00:00Z', '2026-11-01T02:07:00Z', 'FUTURE_TEST', '{}', 'hash')");
        await client.execute("INSERT INTO challenger_forecast_results VALUES ('forecast', 1, 0, 'understat', '2026-11-02T18:00:00Z', '2026-11-02T20:00:00Z')");
        await client.execute("INSERT INTO challenger_candidate_reviews VALUES ('candidate', 'REJECT', '{}', 'hash', '2026-11-03T00:00:00Z')");
        await client.execute("INSERT INTO challenger_adoption_events(id, action, candidate_id, deployment_json, previous_json, evidence_json, evidence_hash, created_at) VALUES ('event', 'SUSPEND', 'candidate', '{}', '{}', '{}', 'hash', '2026-11-03T00:00:00Z')");
        for (const table of tables) {
          const column = (await client.execute('PRAGMA table_info(' + table + ')')).rows[0].name;
          await assert.rejects(client.execute('UPDATE ' + table + ' SET ' + column + ' = ' + column), /challenger evidence is immutable/);
          await assert.rejects(client.execute('DELETE FROM ' + table), /challenger evidence is immutable/);
        }
        const evidenceBefore = await Promise.all(tables.map(async table => (await client.execute('SELECT * FROM ' + table)).rows));
        // Execute parsed commands too: CASE END must not truncate this trigger.
        for (const statement of service.splitMigrationStatements(
          "CREATE TABLE trigger_fixture(id INTEGER); CREATE TABLE trigger_audit(value INTEGER); " +
          "CREATE TEMP TRIGGER case_guard AFTER INSERT ON trigger_fixture BEGIN " +
          "INSERT INTO trigger_audit SELECT CASE WHEN NEW.id > 0 THEN CASE WHEN NEW.id=1 THEN 10 ELSE 20 END ELSE 0 END; " +
          "INSERT INTO trigger_audit VALUES (30); END; INSERT INTO trigger_fixture VALUES (1);")) {
          await client.execute(statement);
        }
        assert.deepEqual((await client.execute('SELECT value FROM trigger_audit ORDER BY value')).rows.map(row => Number(row.value)), [10, 30]);
        await service.close();
        service = new DatabaseService();
        await service.initPromise;
        assert.deepEqual((await service.db.execute('SELECT * FROM schema_migrations ORDER BY version')).rows, markersBefore);
        assert.deepEqual((await service.db.execute("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'challenger_%' ORDER BY name")).rows, guardsBefore);
        assert.deepEqual(await Promise.all(tables.map(async table => (await service.db.execute('SELECT * FROM ' + table)).rows)), evidenceBefore);
      } finally {
        await service.close();
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: directory,
      env: { ...process.env, TEST_DATABASE_MODULE: databaseModule,
        TURSO_DATABASE_URL: 'file:bootstrap.db', TURSO_AUTH_TOKEN: 'local-test-token' },
      encoding: 'utf8', timeout: 60000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
