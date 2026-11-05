const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { createLibsqlFootballDataDb, parseFootballDataCsv, matchKey } = require('../dist/services/FootballDataService');

// Synthetic, isolated reproduction of the four public fixture identities in
// the read-only audit. No provider calls, credentials or persistent database.
const fixtures = [
  { competition: 'Serie A', csvHome: 'Sassuolo', dbHome: 'Sassuolo', away: 'Fiorentina', homeGoals: 2, awayGoals: 4 },
  { competition: 'Premier League', csvHome: 'Newcastle', dbHome: 'Newcastle United', away: 'Everton', homeGoals: 0, awayGoals: 1 },
  { competition: 'La Liga', csvHome: 'La Coruna', dbHome: 'Deportivo La Coruna', away: 'Osasuna', homeGoals: 2, awayGoals: 1 },
  { competition: 'Ligue 1', csvHome: 'Lorient', dbHome: 'Lorient', away: 'Brest', homeGoals: 0, awayGoals: 2 },
];

test('unresolved primary fixtures cannot satisfy CSV coverage despite exact identities and dates', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    const supplementalColumns = ['home_shots', 'away_shots', 'home_shots_on_target', 'away_shots_on_target',
      'home_fouls', 'away_fouls', 'home_corners', 'away_corners', 'home_yellow_cards', 'away_yellow_cards',
      'home_red_cards', 'away_red_cards'].map((name) => `${name} INTEGER`).join(', ');
    await client.execute(`CREATE TABLE matches (match_id TEXT PRIMARY KEY, date TEXT, competition TEXT, season TEXT,
      home_team_name TEXT, away_team_name TEXT, home_team_id TEXT, away_team_id TEXT,
      home_goals INTEGER, away_goals INTEGER, ${supplementalColumns}, referee TEXT, fd_odds_json TEXT)`);
    const adapter = createLibsqlFootballDataDb(client);
    for (const [index, fixture] of fixtures.entries()) {
      const id = `synthetic-${index}`;
      const [row] = parseFootballDataCsv(`Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,HST,AST,HY,AY,HR,AR\n02/11/2026,${fixture.csvHome},${fixture.away},${fixture.homeGoals},${fixture.awayGoals},0,0,0,0,0,0,0,0`);
      assert.equal(row.homeGoals, fixture.homeGoals);
      assert.equal(row.awayGoals, fixture.awayGoals);
      assert.equal(row.homeShots, 0, 'a measured zero remains observed');
      const date = '2026-11-02T20:00:00.000Z';
      assert.equal(matchKey(row.date, row.homeTeam, row.awayTeam), matchKey(date, fixture.dbHome, fixture.away));
      await client.execute({
        sql: `INSERT INTO matches (match_id,date,competition,season,home_team_name,away_team_name,home_goals,away_goals)
          VALUES (?,?,?,?,?,?,NULL,NULL)`,
        args: [id, date, fixture.competition, '2026/2027', fixture.dbHome, fixture.away],
      });
      assert.deepEqual(await adapter.getMatchesForCompetition(fixture.competition, [2026]), [],
        'the supplementary source must not mark an unresolved primary fixture as completed');

      // Only the synthetic primary fixture is completed; the real database and
      // the supplementary writer are never used in this regression.
      await client.execute({ sql: 'UPDATE matches SET home_goals=?,away_goals=? WHERE match_id=?', args: [fixture.homeGoals, fixture.awayGoals, id] });
      const [completed] = await adapter.getMatchesForCompetition(fixture.competition, [2026]);
      assert.equal(completed.match_id, id);
      assert.equal(matchKey(completed.date, completed.home_team_name, completed.away_team_name), matchKey(row.date, row.homeTeam, row.awayTeam));
    }
  } finally { client.close(); }
});
