const test = require('node:test');
const assert = require('node:assert/strict');
const { ShortReadCache } = require('../dist/services/ShortReadCache.js');
const { DatabaseService } = require('../dist/db/DatabaseService.js');

test('default cache preserves reads for ten minutes and then reloads', async () => {
  let now = 0;
  let reads = 0;
  const cache = new ShortReadCache(undefined, 128, () => now);
  const load = async () => ++reads;
  assert.equal(await cache.get('overview', load), 1);
  now = 9 * 60_000;
  assert.equal(await cache.get('overview', load), 1);
  now = 10 * 60_000;
  assert.equal(await cache.get('overview', load), 2);
});

test('two users share one read, expiration reloads and capacity bounds cached entries', async () => {
  let now = 0;
  let reads = 0;
  const cache = new ShortReadCache(60, 2, () => now);
  const load = async () => ++reads;
  assert.deepEqual(await Promise.all([cache.get('a', load), cache.get('a', load)]), [1, 1]);
  assert.equal(await cache.get('a', load), 1);
  now = 61;
  assert.equal(await cache.get('a', load), 2);
  await cache.get('b', load);
  await cache.get('c', load);
  assert.equal(await cache.get('a', load), 5);
});

test('errors are retryable and invalidation cannot be undone by an older pending read', async () => {
  const cache = new ShortReadCache();
  await assert.rejects(cache.get('a', async () => { throw new Error('database unavailable'); }));
  assert.equal(await cache.get('a', async () => 'recovered'), 'recovered');
  let release;
  const old = cache.get('pending', () => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  cache.clear();
  assert.equal(await cache.get('pending', async () => 'new'), 'new');
  release('old');
  assert.equal(await old, 'old');
  assert.equal(await cache.get('pending', async () => assert.fail('stale reload')), 'new');
});

test('DB coverage deduplicates reversed team order, isolates callers and invalidates after match changes', async () => {
  const db = Object.create(DatabaseService.prototype);
  db.teamAverageLoads = new Map();
  db.dirtyTeamAverageLoads = new Set();
  let queries = 0;
  db.all = async (sql) => {
    queries++;
    return sql.includes('FROM matches') ? [{ team_id: 'home', season: '2026/2027' }] : [];
  };
  const [first, second] = await Promise.all([
    db.getTeamHistoricalCoverageBatch(['home', 'away'], '2026/2027'),
    db.getTeamHistoricalCoverageBatch(['away', 'home'], '2026/2027'),
  ]);
  assert.equal(queries, 2);
  first.home.coveragePercent = 999;
  assert.equal(second.home.coveragePercent, 20);
  assert.equal((await db.getTeamHistoricalCoverageBatch(['home', 'away'], '2026/2027')).home.coveragePercent, 20);
  db.markTeamAveragesDirty(['home']);
  await db.getTeamHistoricalCoverageBatch(['home', 'away'], '2026/2027');
  assert.equal(queries, 4);
});
