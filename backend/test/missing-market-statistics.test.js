const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createClient } = require('@libsql/client');
const { DatabaseService } = require('../dist/db/DatabaseService');
const { rebuildPlayerDerivedStats } = require('../dist/services/PlayerDerivedStatsService');
const { rebuildRefereeDerivedStats } = require('../dist/services/RefereeDerivedStatsService');

test('team recent averages and field rates exclude absent observations but preserve zero', () => {
  const service = Object.create(DatabaseService.prototype);
  const home = { n: 2, total_weight: 2, count_shots: 1, count_shots_ot: 1, count_yellow: 1, count_red: 1,
    total_shots: 10, total_shots_ot: 4, total_yellow: 2, total_red: 0,
    paired_shots: 10, paired_shots_ot: 4, avg_yellow: 2, weight_yellow: 1, avg_red: 0, weight_red: 1,
    avg_shots_conceded: 10, weight_shots_conceded: 1 };
  const away = { n: 1, total_weight: 1, count_shots: 1, count_shots_ot: 0, count_yellow: 0, count_red: 0,
    total_shots: 0, weight_yellow: 0, weight_red: 0, weight_shots_conceded: 0 };
  const recent = [
    { shots: 10, shots_ot: 4, yellow_cards: 2, goals_for: 1, goals_against: 0 },
    { shots: null, shots_ot: null, yellow_cards: null, goals_for: 0, goals_against: 1 },
    { shots: 0, shots_ot: null, yellow_cards: null, goals_for: 0, goals_against: 0 },
  ];
  const { args } = service.teamAverageUpdateStatement('team', {}, home, away, recent);
  const computed = JSON.parse(args.teamStatsJson).computed;
  assert.deepEqual(computed.marketSampleSizes, { shots: 2, shotsOnTarget: 1, yellowCards: 1, redCards: 1 });
  assert.deepEqual(computed.venueMarketSampleSizes, {
    home: { shots: 1, shotsOnTarget: 1, yellowCards: 1, redCards: 1 },
    away: { shots: 1, shotsOnTarget: 0, yellowCards: 0, redCards: 0 },
  });
  assert.equal(computed.recent.last5.avgShots, 5); // old: 10/3
  assert.equal(computed.recent.last5.avgShotsOT, 4); // old: 4/3
  assert.equal(computed.recent.last5.avgYellowCards, 2); // old: 2/3
  assert.equal(computed.rates.shotsPerMatch, 5);
  assert.equal(computed.rates.shotsOnTargetPerMatch, 4);
  assert.equal(args.yellow, 2); // old: (2*2 + 1.9)/3
  assert.equal(args.red, 0);
  assert.equal(args.shotsPct, 0.4);
  const empty = service.teamAverageUpdateStatement('team', {}, { n: 1 }, null, [{ shots: null, shots_ot: null, yellow_cards: null }]);
  assert.equal(JSON.parse(empty.args.teamStatsJson).computed.recent.last5.avgShots, null);
  assert.equal(empty.args.shotsTotal, null);
});

test('league booking points require all four card observations in an isolated libSQL database', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute(`CREATE TABLE matches (competition TEXT, date TEXT, home_goals INTEGER, away_goals INTEGER,
      home_xg REAL, away_xg REAL, home_shots INTEGER, away_shots INTEGER, home_yellow_cards INTEGER,
      away_yellow_cards INTEGER, home_red_cards INTEGER, away_red_cards INTEGER, home_fouls INTEGER, away_fouls INTEGER)`);
    await client.execute("INSERT INTO matches VALUES ('Test','2025-01-01',1,0,1,0,10,5,2,1,1,0,10,10), ('Test','2025-01-02',0,0,0,0,0,0,2,1,NULL,0,10,10)");
    const service = Object.create(DatabaseService.prototype);
    service.all = async (sql, args) => (await client.execute({ sql, args })).rows;
    const [summary] = await service.getLeagueSummaries(['Test']);
    assert.equal(summary.avgTotalCards, 5); // old: (5 + 3)/2 = 4
    assert.equal(summary.avgTotalShots, 7.5);
  } finally { client.close(); }
});

test('match persistence distinguishes invalid and missing counts from real zeros', () => {
  const service = Object.create(DatabaseService.prototype);
  const args = service.getMatchUpsertArgs({ homeTotalShots: ' ', awayTotalShots: 0, homeShotsOnTarget: 'NaN',
    awayShotsOnTarget: '0', homeYellowCards: -1, awayYellowCards: null, homeRedCards: false, awayRedCards: 1 });
  assert.equal(args.homeShots, null);
  assert.equal(args.awayShots, 0);
  assert.equal(args.homeShotsOT, null);
  assert.equal(args.awayShotsOT, 0);
  assert.equal(args.homeYellow, null);
  assert.equal(args.awayYellow, null);
  assert.equal(args.homeRed, null);
  assert.equal(args.awayRed, 1);
});

test('player rebuild counts only observable statistics and pairs share inputs', async () => {
  const roster = (shots, yellow, red) => ({ h: { p: { player: 'Player', player_id: '7', time: '90', shots, yellow_card: yellow, red_card: red } }, a: {} });
  const base = { home_goals: 1, away_goals: 0, home_team_id: 'h', away_team_id: 'a' };
  const matches = [
    { ...base, match_id: '1', date: '2025-01-01', home_shots: 10, raw_json: JSON.stringify({ details: { rosters: roster(2, 1, 0), shots: { h: [{ player_id: '7', result: 'SavedShot' }, { player_id: '7', result: 'MissedShots' }], a: [] } } }) },
    { ...base, match_id: '2', date: '2025-01-02', home_shots: null, raw_json: JSON.stringify({ details: { rosters: roster(null, null, null) } }) },
    { ...base, match_id: '3', date: '2025-01-03', home_shots: 0, raw_json: JSON.stringify({ details: { rosters: roster(0, 0, 0), shots: { h: [], a: [] } } }) },
  ];
  let result;
  await rebuildPlayerDerivedStats({ getMatches: async () => matches, markPlayersUnavailable: async () => 0, upsertPlayer: async (value) => { result = value; } });
  assert.deepEqual(JSON.parse(result.statsJson).coverage, { shots: 2, shotsOnTarget: 2, yellowCards: 2, redCards: 2, shotShare: 2 });
  assert.equal(result.avgShotsPerGame, 1); // old: 2/3
  assert.equal(result.avgShotsOnTargetPerGame, 0.5); // old: 1/3
  assert.equal(result.shotShareOfTeam, 0.2);
  assert.equal(result.cardsPer90, 0.5);
});

test('referee averages preserve zero and reject incomplete or invalid pairs', async () => {
  let row;
  const base = { home_goals: 0, away_goals: 0, referee: 'Ref' };
  await rebuildRefereeDerivedStats({ getMatches: async () => [
    { ...base, home_yellow_cards: 0, away_yellow_cards: 2, home_red_cards: 0, away_red_cards: 0 },
    { ...base, home_yellow_cards: ' ', away_yellow_cards: 2, home_red_cards: null, away_red_cards: 0 },
  ], upsertReferee: async (value) => { row = value; } });
  assert.equal(row.avgYellow, 2);
  assert.equal(row.avgRed, 0);
  assert.equal(row.games, 2);
});

test('weighted team aggregation reads only observed rows in isolated SQLite', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute(`CREATE TABLE teams (team_id TEXT PRIMARY KEY, team_stats_json TEXT, avg_home_shots REAL, avg_away_shots REAL,
      avg_home_shots_ot REAL, avg_away_shots_ot REAL, avg_home_xg REAL, avg_away_xg REAL, avg_yellow_cards REAL,
      avg_red_cards REAL, avg_fouls REAL, avg_home_corners REAL, avg_away_corners REAL, shots_total INTEGER,
      shots_on_target INTEGER, shots_pct REAL, shots_per90 REAL, sot_per90 REAL, xg REAL, xga REAL,
      fouls_committed INTEGER, fouls_drawn INTEGER, yellow_cards INTEGER, red_cards INTEGER, corners INTEGER,
      shots_suppression REAL, last_updated TEXT)`);
    await client.execute(`CREATE TABLE matches (home_team_id TEXT, away_team_id TEXT, date TEXT, home_goals INTEGER, away_goals INTEGER,
      home_shots INTEGER, away_shots INTEGER, home_shots_on_target INTEGER, away_shots_on_target INTEGER, home_xg REAL, away_xg REAL,
      home_yellow_cards INTEGER, away_yellow_cards INTEGER, home_red_cards INTEGER, away_red_cards INTEGER,
      home_fouls INTEGER, away_fouls INTEGER, home_corners INTEGER, away_corners INTEGER, home_possession REAL, away_possession REAL)`);
    await client.execute("INSERT INTO teams (team_id) VALUES ('h')");
    await client.execute("INSERT INTO matches (home_team_id,away_team_id,date,home_goals,away_goals,home_shots,away_shots,home_shots_on_target,home_yellow_cards,home_red_cards) VALUES ('h','a','2025-01-01',1,0,10,8,4,2,0),('h','a','2025-01-01',0,0,NULL,NULL,NULL,NULL,NULL)");
    const service = Object.create(DatabaseService.prototype);
    service.db = client;
    service.initPromise = Promise.resolve();
    service.getTeamsByIds = async () => (await client.execute('SELECT * FROM teams')).rows;
    service.all = async (sql, args) => (await client.execute({ sql, args })).rows;
    await service.loadTeamAveragesBatch(['h']);
    const team = (await client.execute('SELECT * FROM teams')).rows[0];
    const computed = JSON.parse(team.team_stats_json).computed;
    assert.equal(team.avg_home_shots, 10);
    assert.equal(team.avg_yellow_cards, 2);
    assert.equal(computed.recent.last10.avgShots, 10);
    assert.equal(computed.marketSampleSizes.shots, 1);
  } finally { client.close(); }
});

test('match upsert retains observed values when new values are missing and accepts a real zero', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute(`CREATE TABLE matches (match_id TEXT PRIMARY KEY, home_team_id TEXT, away_team_id TEXT, home_team_name TEXT, away_team_name TEXT,
      date TEXT, home_goals INTEGER, away_goals INTEGER, home_xg REAL, away_xg REAL, home_shots INTEGER, away_shots INTEGER,
      home_shots_on_target INTEGER, away_shots_on_target INTEGER, home_possession REAL, away_possession REAL, home_fouls INTEGER,
      away_fouls INTEGER, home_yellow_cards INTEGER, away_yellow_cards INTEGER, home_red_cards INTEGER, away_red_cards INTEGER,
      home_corners INTEGER, away_corners INTEGER, referee TEXT, competition TEXT, season TEXT, source TEXT, source_match_id TEXT, raw_json TEXT)`);
    const service = Object.create(DatabaseService.prototype);
    await client.execute('CREATE TABLE final_observations (match_id TEXT, field TEXT, value, PRIMARY KEY(match_id,field))');
    await client.execute('CREATE TABLE final_observation_conflicts (match_id TEXT, field TEXT, existing_value, attempted_value)');
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations/036_match_kickoff_observations.sql'), 'utf8'));
    service.db = client;
    service.initPromise = Promise.resolve();
    service.markTeamAveragesDirty = () => {};
    const base = { matchId: 'm', homeTeamId: 'h', awayTeamId: 'a', date: '2025-01-01' };
    await service.upsertMatch({ ...base, homeTotalShots: 5, homeYellowCards: 2, homeRedCards: 1 });
    await service.upsertMatch({ ...base, homeTotalShots: '', homeYellowCards: null, homeRedCards: 'invalid' });
    let row = (await client.execute('SELECT * FROM matches')).rows[0];
    assert.deepEqual([row.home_shots, row.home_yellow_cards, row.home_red_cards], [5, 2, 1]);
    await service.upsertMatch({ ...base, homeTotalShots: 0, homeYellowCards: 0, homeRedCards: 0 });
    row = (await client.execute('SELECT * FROM matches')).rows[0];
    assert.deepEqual([row.home_shots, row.home_yellow_cards, row.home_red_cards], [0, 0, 0]);
  } finally { client.close(); }
});

test('player missing shotmap and roster counts stay unavailable, not zero', async () => {
  let result;
  await rebuildPlayerDerivedStats({ getMatches: async () => [{ match_id: 'm', home_goals: 0, away_goals: 0,
    home_team_id: 'h', away_team_id: 'a', raw_json: JSON.stringify({ details: { rosters: {
      h: { p: { player: 'Player', player_id: '7', time: '90' } }, a: {} } } }) }],
  markPlayersUnavailable: async () => 0, upsertPlayer: async (value) => { result = value; } });
  assert.deepEqual(JSON.parse(result.statsJson).coverage, { shots: 0, shotsOnTarget: 0, yellowCards: 0, redCards: 0, shotShare: 0 });
  assert.equal(result.avgShotsPerGame, null);
  assert.equal(result.avgShotsOnTargetPerGame, null);
  assert.equal(result.yellowCardsTotal, null);
  assert.equal(result.shotShareOfTeam, null);
});

test('referee observed stats reconstruct paired samples strictly before cutoff and within competition', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute(`CREATE TABLE matches (referee TEXT, competition TEXT, date TEXT, home_goals INTEGER, away_goals INTEGER,
      home_yellow_cards INTEGER, away_yellow_cards INTEGER, home_red_cards INTEGER, away_red_cards INTEGER, home_fouls INTEGER, away_fouls INTEGER)`);
    await client.execute(`INSERT INTO matches VALUES
      ('Ref','League','2025-01-01',1,0,0,2,0,0,10,12),
      ('Ref','League','2025-01-02',0,0,NULL,2,0,1,NULL,9),
      ('Ref','League','2025-01-03',0,0,8,8,1,1,20,20),
      ('Ref','Other','2025-01-01',0,0,9,9,0,0,0,0),
      ('Ref','League','2025-01-01',NULL,NULL,9,9,0,0,0,0)`);
    const service = Object.create(DatabaseService.prototype);
    service.get = async (sql, args) => (await client.execute({ sql, args })).rows[0] ?? null;
    const stats = await service.getRefereeObservedStats(' ref ', { competition: 'League', asOf: '2025-01-03' });
    assert.equal(stats.total_games, 2);
    assert.equal(stats.yellow_games, 1);
    assert.equal(stats.red_games, 2);
    assert.equal(stats.fouls_games, 1);
    assert.equal(stats.avg_yellow_cards_per_game, 2);
    assert.equal(stats.avg_red_cards_per_game, 0.5);
    assert.equal(stats.avg_fouls_per_game, 22);
    const absent = await service.getRefereeObservedStats('Nobody', { asOf: '2025-01-03' });
    assert.equal(absent.yellow_games, 0);
    assert.equal(absent.avg_yellow_cards_per_game, null);
  } finally { client.close(); }
});

test('player yellow totals and minutes use paired observations', async () => {
  let result;
  const make = (id, time, yellow) => ({ match_id: id, home_goals: 0, away_goals: 0,
    home_team_id: 'h', away_team_id: 'a', raw_json: JSON.stringify({ details: { rosters: {
      h: { p: { player: 'Player', player_id: '7', time, yellow_card: yellow } }, a: {} } } }) });
  await rebuildPlayerDerivedStats({ getMatches: async () => [make('1', 45, 1), make('2', 90, null), make('3', null, 1)],
    markPlayersUnavailable: async () => 0, upsertPlayer: async (value) => { result = value; } });
  const stats = JSON.parse(result.statsJson);
  assert.equal(stats.observedMinutes.yellowCards, 45);
  assert.equal(stats.observedTotals.yellowCards, 1);
  assert.equal(stats.coverage.yellowCards, 2);
});

test('own goals are excluded from player shotmap consistency and on-target shots', async () => {
  let result;
  const make = (id, shots, events) => ({ match_id: id, home_goals: 1, away_goals: 0, home_team_id: 'h', away_team_id: 'a',
    raw_json: JSON.stringify({ details: { rosters: { h: { p: { player: 'Player', player_id: '7', time: 90, shots } }, a: {} },
      shots: { h: events.map((event) => ({ player_id: '7', result: event })), a: [] } } }) });
  await rebuildPlayerDerivedStats({ getMatches: async () => [make('1', 0, ['OwnGoal']), make('2', 1, ['SavedShot', 'OwnGoal'])],
    markPlayersUnavailable: async () => 0, upsertPlayer: async (value) => { result = value; } });
  assert.equal(JSON.parse(result.statsJson).coverage.shotsOnTarget, 2);
  assert.equal(result.totalShotsOnTarget, 1);
  assert.equal(result.avgShotsOnTargetPerGame, 0.5);
});

test('partial shotmaps, absent roster shots and duplicates do not assert player shot coverage', async () => {
  const written = [];
  const match = (id, roster, events, teamShots = null) => ({ match_id: id, home_goals: 0, away_goals: 0, home_team_id: 'h', away_team_id: 'a', home_shots: teamShots,
    raw_json: JSON.stringify({ details: { rosters: { h: roster, a: {} }, shots: { h: events, a: [] } } }) });
  const player = (shots) => ({ player: 'Player', player_id: '7', time: 90, shots });
  await rebuildPlayerDerivedStats({ getMatches: async () => [
    match('1', { p: player(null) }, []),
    match('2', { p: player(null) }, [{ id: 's', player_id: '7', result: 'SavedShot' }]),
    match('3', { p: player(2) }, [{ id: 's', player_id: '7', result: 'SavedShot' }]),
    match('4', { p: player(2) }, [{ id: 'd', player_id: '7', result: 'SavedShot' }, { id: 'd', player_id: '7', result: 'SavedShot' }]),
    match('5', { p: player(1), duplicate: player(1) }, [{ id: 's', player_id: '7', result: 'SavedShot' }]),
  ], markPlayersUnavailable: async () => 0, upsertPlayer: async (value) => { written.push(value); } });
  const result = written[0];
  const coverage = JSON.parse(result.statsJson).coverage;
  assert.equal(coverage.shotsOnTarget, 0);
  assert.equal(result.avgShotsOnTargetPerGame, null);
  assert.equal(coverage.shotShare, 0);
  assert.equal(result.shotShareOfTeam, null);
});

test('own goals do not alter a supplied team shot total for player share', async () => {
  let result;
  const raw = { details: { rosters: { h: { p: { player: 'Player', player_id: '7', time: 90, shots: 1 } }, a: {} },
    shots: { h: [{ id: '1', player_id: '7', result: 'SavedShot' }, { id: '2', player_id: '7', result: 'OwnGoal' }], a: [] } } };
  await rebuildPlayerDerivedStats({ getMatches: async () => [{ match_id: 'm', home_goals: 1, away_goals: 0, home_team_id: 'h', away_team_id: 'a', home_shots: 10, raw_json: JSON.stringify(raw) }],
    markPlayersUnavailable: async () => 0, upsertPlayer: async (value) => { result = value; } });
  assert.equal(result.shotShareOfTeam, 0.1);
  assert.equal(result.avgShotsOnTargetPerGame, 1);
});

test('player goal conversion pairs goals and shots in the same matches', async () => {
  let result;
  const make = (id, shots, goals) => ({ match_id: id, home_goals: 1, away_goals: 0, home_team_id: 'h', away_team_id: 'a',
    raw_json: JSON.stringify({ details: { rosters: { h: { p: { player: 'Player', player_id: '7', shots, goals } }, a: {} } } }) });
  await rebuildPlayerDerivedStats({ getMatches: async () => [make('1', 4, 1), make('2', null, 2), make('3', 3, null)],
    markPlayersUnavailable: async () => 0, upsertPlayer: async (value) => { result = value; } });
  assert.equal(result.goalConversion, 0.25);
});
