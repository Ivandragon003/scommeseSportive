const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createClient } = require('@libsql/client');
// Use the exact serializer used by the installed HTTP client, without a server.
const { stmtToHrana } = require(path.join(path.dirname(require.resolve('@libsql/client')), 'hrana.js'));
const dist = process.env.NIGHTLY_TEST_DIST ?? path.resolve(__dirname, '../dist');
const { SourceFeedStore, SOURCE_FEED_CACHE_MARKER } = require(path.join(dist, 'services/SourceFeedStore'));
const { NightlyCsvCache } = require(path.join(dist, 'services/NightlyCsvCache'));

function serializedClient(client) {
  const batches = [];
  return {
    batches,
    execute(statement) {
      stmtToHrana(statement);
      return client.execute(statement);
    },
    batch(statements, mode) {
      statements.forEach(statement => stmtToHrana(statement));
      batches.push({ statements, mode });
      return client.batch(statements, mode);
    },
  };
}

test('source feed bootstrap passes the real HTTP serializer and preserves shared data on reinitialization', async t => {
  const local = createClient({ url: 'file::memory:' });
  t.after(() => local.close());
  await local.execute('CREATE TABLE unrelated(id INTEGER)');
  await local.execute('INSERT INTO unrelated VALUES(42)');
  const client = serializedClient(local);
  const store = new SourceFeedStore(client);
  await store.initialize({ shared: true, allowCreate: true });
  assert.equal(client.batches.length, 1);
  assert.equal(client.batches[0].mode, 'write');
  assert.equal(client.batches[0].statements.length, 5);
  assert.equal((await local.execute("SELECT value FROM source_feed_meta WHERE key='cache_marker'")).rows[0].value,
    SOURCE_FEED_CACHE_MARKER);
  const before = (await local.execute('SELECT type,name,sql FROM sqlite_master ORDER BY type,name')).rows;
  await new SourceFeedStore(client).initialize({ shared: true });
  assert.equal(client.batches.length, 1);
  assert.deepEqual((await local.execute('SELECT type,name,sql FROM sqlite_master ORDER BY type,name')).rows, before);
  assert.equal((await local.execute('SELECT id FROM unrelated')).rows[0].id, 42);
  const now = new Date().toISOString();
  const attempt = await store.beginAttempt('PL', 2026, now);
  assert.ok(attempt);
  await store.fail(attempt, 'source_feed_fetch_failed', now);
  assert.equal((await store.read('PL', 2026, now)).status, 'failure');
});

test('CSV bootstrap passes the real HTTP serializer without resetting the cutover or creating attempts', async t => {
  const local = createClient({ url: 'file::memory:' });
  t.after(() => local.close());
  const client = serializedClient(local);
  const cache = new NightlyCsvCache(client);
  await cache.initialize({ allowCreate: true });
  assert.equal(client.batches.length, 1);
  assert.equal(client.batches[0].mode, 'write');
  assert.equal(client.batches[0].statements.length, 5);
  const anchor = (await local.execute("SELECT value FROM nightly_csv_meta WHERE key='collection_not_before'")).rows[0].value;
  assert.ok(Date.parse(anchor) > Date.now() + 6 * 86400000);
  await new NightlyCsvCache(client).initialize();
  assert.equal(client.batches.length, 1);
  assert.equal((await local.execute("SELECT value FROM nightly_csv_meta WHERE key='collection_not_before'")).rows[0].value, anchor);
  assert.equal(await cache.reserve(2026), null);
  assert.equal((await local.execute('SELECT COUNT(*) AS count FROM nightly_csv_attempts')).rows[0].count, 0);
  assert.equal((await local.execute('PRAGMA foreign_key_check')).rows.length, 0);
});
