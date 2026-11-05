const test = require('node:test');
const assert = require('node:assert/strict');
const { BacktestingEngine } = require('../dist/models/backtesting/BacktestingEngine.js');
const { PredictionContextBuilder } = require('../dist/services/PredictionContextBuilder.js');
const { SpecializedModels } = require('../dist/models/markets/SpecializedModels.js');
const day = 86400000;
const row = (id, home, away, offset, stats = {}) => ({ matchId: id, homeTeamId: home, awayTeamId: away, date: new Date(Date.UTC(2025, 0, 1) + offset * day), homeGoals: 1, awayGoals: 0, homeXG: 1, awayXG: 1, ...stats });

test('as-of aggregates use observed weights and preserve zeros and defaults', () => {
  const engine = new BacktestingEngine(), target = row('t', 'A', 'B', 10);
  const known = row('h', 'A', 'C', 0, { homeYellowCards: 0, homeRedCards: 0, homeTotalShots: 0, homeShotsOnTarget: 0, awayFouls: 0 });
  const missing = row('a', 'C', 'A', 1, { awayYellowCards: null, awayRedCards: null, awayTotalShots: null, homeFouls: null });
  const partial = engine.buildAsOfSupp(target, [known, missing]).homeTeamStats;
  for (const key of ['avgYellowCards', 'avgRedCards', 'avgShots', 'avgShotsOT', 'avgFoulsDrawn']) assert.equal(partial[key], 0, key);
  assert.equal(partial.sampleSize, 1);
  const absent = engine.buildAsOfSupp(target, [missing]).homeTeamStats;
  assert.equal(absent.avgYellowCards, 1.9); assert.equal(absent.avgRedCards, 0.11); assert.equal(absent.avgFoulsDrawn, undefined);
  const complete = engine.buildAsOfSupp(target, [known, { ...missing, awayYellowCards: 4 }]).homeTeamStats;
  const w1 = Math.exp(-0.005 * 10), w2 = Math.exp(-0.005 * 9);
  assert.ok(Math.abs(complete.avgYellowCards - 4 * w2 / (w1 + w2)) < 1e-12);
});

test('settlement abstains for incomplete or invalid counts and handles zero', () => {
  const engine = new BacktestingEngine();
  const match = row('t', 'A', 'B', 10, { homeTotalShots: 0, awayTotalShots: 0, homeShotsOnTarget: 0, awayShotsOnTarget: 0, homeYellowCards: 0, awayYellowCards: 0, homeRedCards: 0, awayRedCards: 0 });
  for (const selection of ['shotsUnder155', 'shots_total_under_155', 'shotsOTUnder55', 'yellowUnder45', 'cardsTotalUnder45', 'cards_total_under_45']) assert.equal(engine.evaluateBetNullable(selection, match), true, selection);
  for (const [selection, key] of [['shotsUnder155', 'awayTotalShots'], ['shots_total_under_155', 'awayTotalShots'], ['shotsOTUnder55', 'awayShotsOnTarget'], ['yellowUnder45', 'awayYellowCards'], ['cardsTotalUnder45', 'awayRedCards'], ['cards_total_under_45', 'awayRedCards']]) {
    for (const value of [null, undefined, -1, NaN]) {
      const incomplete = { ...match, [key]: value };
      assert.equal(engine.evaluateBetNullable(selection, incomplete), null, `${selection} ${value}`);
      assert.equal(engine.evaluateBet(selection, incomplete), null, `legacy ${selection} ${value}`);
    }
  }
  assert.equal(engine.evaluateBetNullable('shotsHomeUnder55', { ...match, awayTotalShots: null }), true);
  assert.equal(engine.evaluateBetNullable('cardsTotalOver15', { ...match, homeRedCards: 1 }), true);
});

test('player share shrinkage uses measured coverage while legacy remains compatible', () => {
  const builder = new PredictionContextBuilder(), model = new SpecializedModels();
  const player = { player_id: '1', name: 'One', team_id: 'A', games_played: 20, shot_share_of_team: 0, avg_shots_per_game: 0, position_code: 'FW' };
  const observed = builder.toPlayerData({ ...player, stats_json: JSON.stringify({ coverage: { shotShare: 20 } }) });
  const missing = builder.toPlayerData({ ...player, shot_share_of_team: null, stats_json: JSON.stringify({ coverage: { shotShare: 0 } }) });
  const legacy = builder.toPlayerData(player);
  assert.equal(observed.shotShareSampleSize, 20); assert.equal(missing.shotShareSampleSize, 0); assert.equal(legacy.shotShareSampleSize, undefined);
  const other = builder.toPlayerData({ ...player, player_id: '2', position_code: 'MF', shot_share_of_team: 0.1 });
  const share = (candidate) => model.computePlayerShotsPredictions([candidate, other], 12, 4).find((p) => p.playerId === '1').shotShareOfTeam;
  assert.ok(share(missing) > share(observed)); assert.equal(share(observed), share(legacy));
});

test('referee effects use observed field samples and retain complete-data behavior', () => {
  const builder = new PredictionContextBuilder();
  const input = { request: {}, homeTeam: {}, awayTeam: {}, homePlayers: [], awayPlayers: [], referee: { total_games: 20, yellow_games: 2, red_games: 0, fouls_games: 0, avg_yellow_cards_per_game: 6, avg_red_cards_per_game: null, avg_fouls_per_game: null } };
  const ref = builder.build(input).supplementaryData.refereeStats;
  assert.deepEqual([ref.sampleSize, ref.sampleSizeYellow, ref.sampleSizeRed, ref.sampleSizeFouls], [20, 2, 0, 0]);
  const model = new SpecializedModels();
  const data = { homeTeamAvgYellow: 2, awayTeamAvgYellow: 2, homeTeamAvgRed: 0.1, awayTeamAvgRed: 0.1, refereeAvgYellow: 6, refereeAvgRed: 0.7, leagueAvgYellow: 4, competitiveness: 0.5, refereeAvgFouls: 40, leagueAvgFouls: 20, refereeSampleSize: 20 };
  const legacy = model.computeCardsDistribution(data);
  assert.deepEqual(model.computeCardsDistribution({ ...data, refereeYellowSampleSize: 20, refereeRedSampleSize: 20, refereeFoulsSampleSize: 20 }), legacy);
  const sparse = model.computeCardsDistribution({ ...data, refereeYellowSampleSize: 2, refereeRedSampleSize: 0, refereeFoulsSampleSize: 0 });
  const neutral = model.computeCardsDistribution({ ...data, refereeAvgYellow: 4, refereeAvgRed: 0, refereeYellowSampleSize: 0, refereeRedSampleSize: 0, refereeFoulsSampleSize: 0 });
  assert.ok(sparse.expectedTotalYellow < legacy.expectedTotalYellow);
  assert.equal(sparse.expectedHomeRed, neutral.expectedHomeRed);
  const fouls = { homeTeamAvgFouls: 10, awayTeamAvgFouls: 10, homePossessionEst: 0.5, refereeAvgFouls: 40, leagueAvgFouls: 20 };
  assert.deepEqual(model.computeFoulsDistribution({ ...fouls, refereeFoulsSampleSize: 0 }), model.computeFoulsDistribution({ ...fouls, refereeAvgFouls: 20 }));
});

test('identity-only roster records do not claim statistical coverage', () => {
  const builder = new PredictionContextBuilder();
  const identity = { player_id: '1', games_played: 0, shot_share_of_team: 0, avg_shots_per_game: 0, stats_json: JSON.stringify({ identityOnly: true }) };
  const base = { request: {}, homeTeam: {}, awayTeam: {}, referee: null };
  const empty = builder.build({ ...base, homePlayers: [], awayPlayers: [] });
  const onlyIdentities = builder.build({ ...base, homePlayers: [identity], awayPlayers: [identity] });
  assert.equal(onlyIdentities.richnessScore, empty.richnessScore);
  assert.deepEqual(onlyIdentities.supplementaryData.homePlayers, []);
  assert.deepEqual(onlyIdentities.supplementaryData.awayPlayers, []);
  const uncovered = { ...identity, stats_json: JSON.stringify({ coverage: { shots: 0, shotsOnTarget: 0, yellowCards: 0, redCards: 0, shotShare: 0 } }) };
  assert.equal(builder.build({ ...base, homePlayers: [uncovered], awayPlayers: [uncovered] }).richnessScore, empty.richnessScore);
  const actual = { ...identity, games_played: 4, stats_json: JSON.stringify({ coverage: { shotShare: 4 } }) };
  const observed = builder.build({ ...base, homePlayers: [actual], awayPlayers: [actual] });
  assert.equal(observed.richnessScore, empty.richnessScore + 0.1);
  assert.equal(observed.supplementaryData.homePlayers[0].shotShareSampleSize, 4);
});

test('per-market samples use actual observations rather than all venue games', () => {
  const builder = new PredictionContextBuilder();
  const home = { avg_home_shots: 12, avg_home_shots_ot: 4, avg_yellow_cards: 2, avg_red_cards: 0, team_stats_json: JSON.stringify({ computed: { home: { sampleSize: 20 }, venueMarketSampleSizes: { home: { shots: 1, shotsOnTarget: 0 } }, marketSampleSizes: { yellowCards: 1, redCards: 0 } } }) };
  const stats = builder.build({ request: {}, homeTeam: home, awayTeam: {}, referee: null, homePlayers: [], awayPlayers: [] }).supplementaryData.homeTeamStats;
  assert.deepEqual([stats.sampleSize, stats.sampleSizeShots, stats.sampleSizeShotsOT, stats.sampleSizeYellow, stats.sampleSizeRed], [20, 1, 0, 1, 0]);
  const model = new SpecializedModels();
  const shots = { homeTeamAvgShots: 12, awayTeamAvgShots: 11, homeTeamAvgShotsOT: 5, awayTeamAvgShotsOT: 4, homeTeamShotsSuppression: 1, awayTeamShotsSuppression: 1, homeAdvantageShots: 1, homeTeamVarShots: 70, awayTeamVarShots: 70, homeTeamVarShotsOT: 30, awayTeamVarShotsOT: 30, homeTeamSampleSize: 20, awayTeamSampleSize: 20 };
  const partial = model.computeShotsDistribution({ ...shots, homeTeamShotsSampleSize: 1, awayTeamShotsSampleSize: 1, homeTeamShotsOTSampleSize: 1, awayTeamShotsOTSampleSize: 1 });
  const baseline = model.computeShotsDistribution({ ...shots, homeTeamSampleSize: 1, awayTeamSampleSize: 1 });
  assert.deepEqual(partial, baseline);
  assert.deepEqual(model.computeShotsDistribution({ ...shots, homeTeamShotsSampleSize: 20, awayTeamShotsSampleSize: 20, homeTeamShotsOTSampleSize: 20, awayTeamShotsOTSampleSize: 20 }), model.computeShotsDistribution(shots));
  const cards = { homeTeamAvgYellow: 4, awayTeamAvgYellow: 4, homeTeamAvgRed: 0.1, awayTeamAvgRed: 0.1, refereeAvgYellow: 4, refereeAvgRed: 0.2, leagueAvgYellow: 4, competitiveness: 0.5, homeTeamSampleSize: 20, awayTeamSampleSize: 20 };
  assert.deepEqual(model.computeCardsDistribution({ ...cards, homeTeamYellowSampleSize: 1, awayTeamYellowSampleSize: 1 }), model.computeCardsDistribution({ ...cards, homeTeamSampleSize: 1, awayTeamSampleSize: 1 }));
  assert.deepEqual(model.computeCardsDistribution({ ...cards, homeTeamYellowSampleSize: 20, awayTeamYellowSampleSize: 20 }), model.computeCardsDistribution(cards));
});

test('count observations exclude fractional, boolean and array values but continuous xG and possession remain valid', () => {
  const engine = new BacktestingEngine(), target = row('t', 'A', 'B', 30);
  for (const bad of [1.5, true, []]) {
    const game = row('bad', 'A', 'C', 0, { homeTotalShots: bad, homeYellowCards: bad, homeRedCards: bad, homeShotsOnTarget: bad, homePossession: 0.63, homeXG: 1.5 });
    const supp = engine.buildAsOfSupp(target, [game]);
    assert.equal(supp.homeTeamStats.sampleSizeShots, 0);
    assert.equal(supp.homeTeamStats.sampleSizeShotsOT, 0);
    assert.equal(supp.homeTeamStats.sampleSizeYellow, 0);
    assert.equal(supp.homeTeamStats.sampleSizeRed, 0);
    assert.equal(supp.homeTeamStats.avgPossession, 0.63);
    assert.equal(engine.evaluateBetNullable('shotsHomeUnder55', { ...target, homeTotalShots: bad }), null);
  }
});


test('missing and invalid legacy team means cannot inherit the match sample', () => {
  const builder = new PredictionContextBuilder();
  const build = (row) => builder.build({ request: {}, homeTeam: { ...row, team_stats_json: JSON.stringify({ computed: { home: { sampleSize: 20 } } }) }, awayTeam: {}, referee: null, homePlayers: [], awayPlayers: [] }).supplementaryData.homeTeamStats;
  for (const value of [null, undefined, '', NaN, -1, false]) {
    const stats = build({ avg_home_shots: value, avg_home_shots_ot: value, avg_yellow_cards: value, avg_red_cards: value });
    assert.deepEqual([stats.sampleSizeShots, stats.sampleSizeShotsOT, stats.sampleSizeYellow, stats.sampleSizeRed], [0, 0, 0, 0]);
    assert.deepEqual([stats.avgShots, stats.avgShotsOT, stats.avgYellowCards, stats.avgRedCards], [12.1, 4.8, 1.9, 0.11]);
  }
  const valid = build({ avg_home_shots: 0, avg_home_shots_ot: 1.5, avg_yellow_cards: 0, avg_red_cards: 0.1 });
  assert.equal(valid.sampleSizeShots, undefined);
  assert.equal(valid.avgShots, 0);
  assert.equal(valid.avgShotsOT, 1.5);
});

test('invalid referee means and player shares cannot inherit legacy samples', () => {
  const builder = new PredictionContextBuilder();
  for (const value of [null, undefined, '', NaN, -1, false]) {
    const result = builder.build({ request: {}, homeTeam: {}, awayTeam: {}, homePlayers: [{ games_played: 20, shot_share_of_team: value }], awayPlayers: [], referee: { total_games: 20, avg_yellow_cards_per_game: value, avg_red_cards_per_game: value, avg_fouls_per_game: value } });
    const ref = result.supplementaryData.refereeStats;
    assert.deepEqual([ref.avgYellow, ref.avgRed, ref.avgFouls], [3.8, 0.22, 22.4]);
    assert.deepEqual([ref.sampleSizeYellow, ref.sampleSizeRed, ref.sampleSizeFouls], [0, 0, 0]);
    assert.equal(result.supplementaryData.homePlayers[0].shotShareSampleSize, 0);
  }
  const valid = builder.build({ request: {}, homeTeam: {}, awayTeam: {}, homePlayers: [{ games_played: 20, shot_share_of_team: 0 }], awayPlayers: [], referee: { total_games: 20, avg_yellow_cards_per_game: 0, avg_red_cards_per_game: 0.2, avg_fouls_per_game: 0 } });
  assert.equal(valid.supplementaryData.refereeStats.sampleSizeYellow, undefined);
  assert.equal(valid.supplementaryData.refereeStats.avgYellow, 0);
  assert.equal(valid.supplementaryData.homePlayers[0].shotShareSampleSize, undefined);
});
