const test = require('node:test');
const assert = require('node:assert/strict');
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.TURSO_AUTH_TOKEN = 'test-token';
const { DatabaseService } = require('../dist/db/DatabaseService.js');
const { PredictionService } = require('../dist/services/PredictionService.js');
const { shouldRetryBootstrapSync } = require('../dist/services/SchedulerRetryPolicy.js');

test('bootstrap retries temporary failures but not plan blocks or immediate rate limits', () => {
  for (const error of [
    { code: 'BLOCKED', message: 'operation blocked' },
    { cause: { code: 'BLOCKED' } },
    new Error('SQL read operations are forbidden (reads are blocked, do you need to upgrade your plan?)'),
    'Quota exhausted',
  ]) assert.equal(shouldRetryBootstrapSync(error), false);
  for (const status of [400, 401, 403, 404, 429]) {
    assert.equal(shouldRetryBootstrapSync('HTTP error', status), false);
  }
  for (const status of [408, 500, 502, 503]) {
    assert.equal(shouldRetryBootstrapSync('temporary error', status), true);
  }
  assert.equal(shouldRetryBootstrapSync(new Error('fetch failed')), true);
});

test('CI backend explicitly disables every periodic collector', () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const script = readFileSync(join(__dirname, '../../scripts/ci/nightly-sync.sh'), 'utf8');
  const startup = script.slice(script.indexOf('NODE_ENV=ci'), script.indexOf('BACKEND_PID=$!'));
  for (const flag of [
    'AUTO_SYNC_ON_BOOT', 'UNDERSTAT_SCHEDULER_ENABLED', 'ODDS_SNAPSHOT_SCHEDULER_ENABLED',
    'LEARNING_REVIEW_SCHEDULER_ENABLED', 'LINEUP_REFRESH_SCHEDULER_ENABLED',
  ]) assert.ok(startup.includes(flag + '=false'), flag);
});

test('unchanged learning sync skips snapshots and reuses cached adaptive tuning', async () => {
  let snapshotReads = 0;
  let tuningReads = 0;
  const service = new PredictionService({
    getRecentCompletedMatches: async () => [{ match_id: 'a' }, { match_id: 'b' }],
    getLearningReviewsByMatchIds: async () => ({ a: { review: {} }, b: { review: {} } }),
    getLatestOddsSnapshotsForMatches: async () => { snapshotReads++; return {}; },
    getLearningReviews: async () => { tuningReads++; return []; },
  });
  for (let i = 0; i < 2; i++) {
    const result = await service.syncCompletedMatchLearningReviews();
    assert.equal(result.considered, 2);
    assert.equal(result.skippedExisting, 2);
    assert.equal(result.created, 0);
  }
  assert.equal(snapshotReads, 0);
  assert.equal(tuningReads, 1);
});

test('learning prefetch targets missing reviews; force refresh still loads all snapshots', async () => {
  const snapshotRequests = [];
  const writes = [];
  const service = new PredictionService({
    getRecentCompletedMatches: async () => ['a', 'b'].map((id) => ({
      match_id: id, home_team_id: 'home', away_team_id: 'away', competition: 'Serie A',
    })),
    getLearningReviewsByMatchIds: async () => ({ a: { review: {} } }),
    getLatestOddsSnapshotsForMatches: async (ids) => {
      snapshotRequests.push(ids);
      return Object.fromEntries(ids.map((id) => [id, { liveSelectedOdds: { homeWin: 2.1 } }]));
    },
    saveLearningReviews: async (rows) => writes.push(rows),
    getLearningReviews: async () => [],
  });
  service.predict = async () => ({ probabilities: { flatProbabilities: {} } });
  service.buildCompletedMatchLearningReview = () => ({ reviewType: 'no_actionable_signal' });
  const first = await service.syncCompletedMatchLearningReviews();
  assert.equal(first.created, 1);
  assert.deepEqual(snapshotRequests[0], ['b']);
  assert.deepEqual(writes[0].map((row) => row.matchId), ['b']);
  const refresh = await service.syncCompletedMatchLearningReviews({ forceRefresh: true });
  assert.equal(refresh.refreshed, 1);
  assert.deepEqual(snapshotRequests[1], ['a', 'b']);
});

test('indexed latest-snapshot seeks preserve timestamp ordering, ties and provenance', async () => {
  const db = new DatabaseService();
  await db.initPromise;
  try {
    for (let i = 0; i < 30; i++) {
      await db.saveOddsSnapshot({
        snapshotId: `old-${i}`, matchId: 'a', homeTeamName: 'A', awayTeamName: 'B',
        source: 'odds_api', capturedAt: '2026-08-01T00:00:00Z',
      });
    }
    for (const [id, capturedAt] of [
      ['offset', '2026-09-01T12:00:00+02:00'],
      ['latest-a', '2026-09-01T10:30:00Z'],
      ['latest-z', '2026-09-01T10:30:00Z'],
    ]) await db.saveOddsSnapshot({
      snapshotId: id, matchId: 'a', homeTeamName: 'A', awayTeamName: 'B',
      source: 'odds_api', capturedAt, selectedOdds: { homeWin: 2.1 }, selectedBookmakerName: 'Real bookmaker',
    });
    const originalAll = db.all.bind(db);
    const queries = [];
    db.all = async (sql, args) => { queries.push({ sql, args }); return originalAll(sql, args); };
    const result = await db.getLatestOddsSnapshotsForMatches(['a', 'missing', 'a']);
    assert.deepEqual(Object.keys(result), ['a']);
    assert.equal(result.a.snapshot_id, 'latest-z');
    assert.equal(result.a.selectedBookmakerName, 'Real bookmaker');
    assert.equal(result.a.selectedOdds.homeWin, 2.1);
    assert.equal(queries.length, 1);
    const plan = await db.db.execute({ sql: 'EXPLAIN QUERY PLAN ' + queries[0].sql, args: queries[0].args });
    const details = plan.rows.map((row) => row.detail).join('\n');
    assert.match(details, /idx_odds_snapshots_latest/);
    assert.doesNotMatch(details, /USE TEMP B-TREE/);
    await db.getLatestOddsSnapshotsForMatches([]);
    assert.equal(queries.length, 1);
  } finally { db.db.close(); }
});

test('completed counts and upcoming scheduler queries use additive partial indexes', async () => {
  const db = new DatabaseService();
  // Optional schema compatibility is process-scoped; use the first initialized
  // database only for dependent optional columns (these queries use base columns).
  await db.initPromise;
  try {
    for (const [id, season, home, away, competition] of [
      ['complete-1', '2026/2027', 2, 1, 'Serie A'],
      ['complete-2', '2026-2027', 0, 0, 'Serie A'],
      ['partial', '2026/2027', 1, null, 'Serie A'],
      ['other-league', '2026/2027', 2, 1, 'La Liga'],
      ['old-season', '2025/2026', 2, 1, 'Serie A'],
      ['fixture', '2026/2027', null, null, 'Serie A'],
    ]) await db.db.execute({
      sql: 'INSERT INTO matches (match_id, home_team_id, away_team_id, date, season, competition, home_goals, away_goals) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [id, 'home', 'away', '2026-09-20T12:00:00.000Z', season, competition, home, away],
    });
    const originalAll = db.all.bind(db);
    const queries = [];
    db.all = async (sql, args) => { queries.push({ sql, args }); return originalAll(sql, args); };
    assert.equal(await db.countCompletedMatches('Serie A', '2026/2027'), 2);
    assert.equal(await db.countCompletedMatches('Serie A', '2026-2027'), 2);
    const fixtures = await db.getUpcomingMatches({
      nowIso: '2026-09-20T10:00:00Z', untilIso: '2026-09-20T14:00:00Z', limit: 10,
    });
    assert.equal(fixtures.length, 1);
    for (const [query, index] of [
      [queries[0], 'idx_matches_completed_scope'], [queries[2], 'idx_matches_upcoming_date'],
    ]) {
      const plan = await db.db.execute({ sql: 'EXPLAIN QUERY PLAN ' + query.sql, args: query.args });
      const details = plan.rows.map((row) => row.detail).join('\n');
      assert.ok(details.includes(index), details);
      assert.doesNotMatch(details, /USE TEMP B-TREE/);
    }
  } finally { db.db.close(); }
});
