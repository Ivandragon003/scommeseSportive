const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.TURSO_AUTH_TOKEN = 'synthetic-local-token';
const { DatabaseService } = require('../dist/db/DatabaseService');

const match = {
  matchId: 'io-fixture', homeTeamId: 'home', awayTeamId: 'away',
  homeTeamName: 'Home', awayTeamName: 'Away', date: '2026-10-01T18:00:00.000Z',
  homeGoals: 2, awayGoals: 1, homeXG: 1.5, awayXG: .8,
  homeTotalShots: 12, awayTotalShots: 7, homeShotsOnTarget: 5, awayShotsOnTarget: 2,
  homePossession: 55, awayPossession: 45, homeFouls: 10, awayFouls: 9,
  homeYellowCards: 2, awayYellowCards: 1, homeRedCards: 0, awayRedCards: 0,
  homeCorners: 7, awayCorners: 2, referee: 'Fixture Referee', competition: 'Serie A',
  season: '2026/2027', source: 'understat', sourceMatchId: 'fixture', rawJson: '{"fixture":true}',
};

async function fixture(work) {
  const db = new DatabaseService();
  try { await db.initPromise; return await work(db); }
  finally { await db.close(); }
}

test('identical match upserts perform no UPDATE and retain batch committed-count semantics', () => fixture(async (db) => {
  const writes = [];
  const execute = db.execute.bind(db);
  db.execute = async (sql, args, skipInit) => {
    const result = await execute(sql, args, skipInit);
    if (sql.includes('ON CONFLICT(match_id) DO UPDATE')) writes.push(Number(result.rowsAffected));
    return result;
  };
  await db.upsertMatch(match);
  const before = await db.getMatchById(match.matchId);
  await db.upsertMatch(match);
  const missing = Object.fromEntries(Object.entries(match).map(([key]) => [key, null]));
  await db.upsertMatch({ ...missing, matchId: match.matchId, homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId, date: match.date, source: match.source });
  assert.deepEqual(writes, [1, 0, 0]);
  assert.deepEqual(await db.getMatchById(match.matchId), before);

  const batch = db.db.batch.bind(db.db);
  const batchWrites = [];
  db.db.batch = async (statements, mode) => {
    const results = await batch(statements, mode);
    batchWrites.push(...results.map((result) => Number(result.rowsAffected)));
    return results;
  };
  assert.deepEqual(await db.upsertMatches([match, match]), { committedCount: 2 });
  assert.deepEqual(batchWrites, [0, 0]);
  assert.deepEqual(await db.getMatchById(match.matchId), before);
}));

test('every non-null match field still updates independently, including zero and raw data', () => fixture(async (db) => {
  for (const [key, original] of Object.entries(match)) {
    if (key === 'matchId') continue;
    await db.upsertMatch(match);
    const value = typeof original === 'number' ? original === 0 ? 1 : 0
      : key === 'date' ? '2026-10-02T18:00:00.000Z' : `${original}-changed`;
    const writes = [];
    const execute = db.execute.bind(db);
    db.execute = async (sql, args, skipInit) => {
      const result = await execute(sql, args, skipInit);
      if (sql.includes('ON CONFLICT(match_id) DO UPDATE')) writes.push(Number(result.rowsAffected));
      return result;
    };
    await db.upsertMatch({ ...match, [key]: value });
    db.execute = execute;
    assert.deepEqual(writes, [1], key);
    const actual = await db.getMatchById(match.matchId);
    // Compare against the same input written to a previously absent row, where
    // the conflict predicate cannot affect the values or SQLite affinity.
    await db.upsertMatch({ ...match, [key]: value, matchId: 'insert-reference' });
    const expected = await db.getMatchById('insert-reference');
    delete actual.match_id; delete expected.match_id;
    delete actual.created_at; delete expected.created_at;
    assert.deepEqual(actual, expected, key);
    await db.db.execute("DELETE FROM matches WHERE match_id = 'insert-reference'");
  }
}));

test('historical calibration projection preserves real quotes, provenance and closing selection', () => fixture(async (db) => {
  await db.upsertMatch(match);
  for (const snapshot of [
    { snapshotId: 'before', source: 'odds_api', capturedAt: '2026-10-01T17:45:00.000Z', odds: 2.1 },
    { snapshotId: 'closing', source: 'odds_api', capturedAt: '2026-10-01T17:59:00.000Z', odds: 2 },
    { snapshotId: 'after', source: 'odds_api', capturedAt: '2026-10-01T18:01:00.000Z', odds: 1.7 },
    { snapshotId: 'completion', source: 'odds_api_plus_model_completion', capturedAt: '2026-10-01T17:59:30.000Z', odds: 3 },
  ]) {
    await db.saveOddsSnapshot({ ...snapshot, matchId: match.matchId, homeTeamName: 'Home', awayTeamName: 'Away',
      selectedBookmakerKey: 'fixture-bookmaker', selectedBookmakerName: 'Fixture Bookmaker',
      selectedOdds: { homeWin: snapshot.odds }, liveSelectedOdds: { homeWin: snapshot.odds },
      allBookmakerOdds: { unused: { homeWin: 999 } }, fallbackOdds: { homeWin: 888 },
      estimatedOdds: { homeWin: 777 }, marketsRequested: ['unused-diagnostic'] });
  }
  const read = db.all.bind(db);
  const optimized = await db.getHistoricalOddsDetailMap({ competition: 'Serie A', season: '2026/2027' });
  let projectedSql;
  db.all = async (sql, args) => {
    projectedSql = sql;
    // The pre-optimization SELECT included every snapshot field and parsed all
    // bookmaker/fallback/diagnostic JSON even though none entered this result.
    return read(sql.replace(/SELECT[\s\S]*?FROM odds_snapshots/, 'SELECT os.*, m.date AS match_date FROM odds_snapshots'), args);
  };
  const reference = await db.getHistoricalOddsDetailMap({ competition: 'Serie A', season: '2026/2027' });
  assert.deepEqual(optimized, reference);
  assert.equal(optimized[match.matchId].odds.homeWin, 2);
  assert.equal(optimized[match.matchId].closingCapturedAt, '2026-10-01T17:59:00.000Z');
  assert.equal(optimized[match.matchId].selectedBookmakerName, 'Fixture Bookmaker');
  assert.doesNotMatch(projectedSql, /os\.\*|all_bookmaker_odds_json|fallback_odds_json|estimated_odds_json|markets_requested_json/);
}));
