const test = require('node:test');
const assert = require('node:assert/strict');
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.TURSO_AUTH_TOKEN = 'fixture-only';
const { DatabaseService } = require('../dist/db/DatabaseService');

test('legacy unverified shots are quarantined in reads while new observed shots survive', async () => {
  const db = new DatabaseService();
  try {
    await db.initPromise;
    await db.upsertMatch({ matchId: 'q-match', homeTeamId: 'home', awayTeamId: 'away', homeTeamName: 'Home',
      awayTeamName: 'Away', date: '2026-10-31T15:00:00.000Z', competition: 'Serie A', season: '2026/2027',
      homeGoals: 1, awayGoals: 0, source: 'understat' });
    const sheet = { 'shots_total_over_8.5': 1.22, 'shots_total_under_7.5': 1.8, homeWin: 2 };
    const input = { matchId: 'q-match', homeTeamName: 'Home', awayTeamName: 'Away', source: 'odds_api',
      selectedBookmakerKey: 'book', selectedBookmakerName: 'Book', selectedOdds: sheet, liveSelectedOdds: sheet,
      allBookmakerOdds: { Book: sheet }, capturedAt: '2026-10-31T12:00:00.000Z' };
    await db.saveOddsSnapshot({ ...input, snapshotId: 'legacy' });
    await db.db.execute("UPDATE odds_snapshots SET market_mapping_version='legacy-unverified-v1' WHERE snapshot_id='legacy'");
    const before = await db.db.execute("SELECT selected_odds_json, all_bookmaker_odds_json FROM odds_snapshots WHERE snapshot_id='legacy'");
    const legacy = await db.getLatestOddsSnapshotForMatch('q-match');
    assert.equal(legacy.marketMappingVersion, 'legacy-unverified-v1');
    assert.equal(legacy.oddsQuarantine.reason, 'legacy_shots_total_unverified');
    assert.equal(legacy.liveSelectedOdds['shots_total_over_8.5'], undefined);
    assert.equal(JSON.parse(legacy.selected_odds_json)['shots_total_over_8.5'], undefined);
    assert.equal(legacy.allBookmakerOdds.Book['shots_total_over_8.5'], undefined);
    assert.equal(legacy.liveSelectedOdds['shots_total_under_7.5'], 1.8);
    assert.equal(legacy.liveSelectedOdds.homeWin, 2);
    const history = await db.getHistoricalOddsDetailMap();
    assert.equal(history['q-match'].odds['shots_total_over_8.5'], undefined);
    assert.equal(history['q-match'].odds.homeWin, 2);
    assert.deepEqual((await db.db.execute("SELECT selected_odds_json, all_bookmaker_odds_json FROM odds_snapshots WHERE snapshot_id='legacy'")).rows, before.rows);
    await db.saveOddsSnapshot({ ...input, snapshotId: 'new', capturedAt: '2026-10-31T12:30:00.000Z' });
    const current = await db.getLatestOddsSnapshotForMatch('q-match');
    assert.equal(current.marketMappingVersion, 'provider-market-semantics-v2');
    assert.equal(current.liveSelectedOdds['shots_total_over_8.5'], 1.22);
    assert.equal(current.oddsQuarantine, null);
    assert.equal((await db.getHistoricalOddsDetailMap())['q-match'].odds['shots_total_over_8.5'], 1.22);
  } finally { await db.close(); }
});
