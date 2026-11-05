const test = require('node:test');
const assert = require('node:assert/strict');
const { PredictionService } = require('../dist/services/PredictionService');
const service = Object.create(PredictionService.prototype);
const key = (market) => `player_understat_player_7_${market}_under_0_5`;
const settle = (market, raw) => service.getPlayerMatchStat(key(market), { raw_json: JSON.stringify(raw) });

test('normalized player outcomes distinguish unavailable, invalid and observed zero', () => {
  for (const missing of [null, undefined, '', ' ', 'invalid', -1, .5, false]) {
    const player = { playerId: 'understat_player_7', shots: missing, shotsOnTarget: missing, yellowCards: missing, goals: missing };
    for (const market of ['shots', 'sot', 'yellow', 'goals']) {
      assert.equal(settle(market, { playerStats: [player] }), null, `${market}: ${String(missing)}`);
    }
  }
  for (const zero of [0, '0']) {
    const player = { playerId: 'understat_player_7', shots: zero, shotsOnTarget: zero, yellowCards: zero, goals: zero };
    for (const market of ['shots', 'sot', 'yellow', 'goals']) assert.equal(settle(market, { playerStats: [player] }).value, 0);
  }
});

test('raw player SOT require consistent evidence, retaining own-goal semantics', () => {
  const player = { player_id: 7, player: 'Synthetic Player', shots: '1', goals: '0', yellow_card: '0' };
  const raw = { rosters: { h: { 7: player }, a: {} } };
  assert.equal(settle('sot', raw), null);
  assert.equal(settle('yellow', raw).value, 0);
  assert.equal(settle('sot', { ...raw, shots: { h: [{ player_id: 7, result: '' }] } }), null);
  assert.equal(settle('sot', { ...raw, shots: { h: [] } }), null);
  const saved = { player_id: 7, result: 'SavedShot' }, own = { player_id: 7, result: 'OwnGoal' };
  assert.equal(settle('sot', { ...raw, shots: { h: [saved, own] } }).value, 1);
  assert.equal(settle('sot', { rosters: { h: { 7: { ...player, shots: 2 } } },
    shots: { h: [{ ...saved, id: 1 }, { ...saved, id: 1 }] } }), null);
  assert.equal(settle('sot', { rosters: { h: { 7: { ...player, shots: 0 } } }, shots: { h: [own] } }).value, 0);
  assert.equal(settle('shots', { rosters: { h: { 7: player, duplicate: player } } }), null);
});

test('calibration outcomes abstain on blank or invalid commercial counts', () => {
  const row = { home_goals: 0, away_goals: 0, home_shots: 0, away_shots: 0,
    home_yellow_cards: 0, away_yellow_cards: 0, home_red_cards: 0, away_red_cards: 0 };
  for (const [selection, field] of [['shotsUnder155', 'home_shots'], ['cardsTotalUnder45', 'home_red_cards']]) {
    assert.equal(service.didSelectionWinInRow(selection, row), true);
    for (const value of [null, undefined, '', ' ', 'bad', -1, .5, false]) {
      assert.equal(service.didSelectionWinInRow(selection, { ...row, [field]: value }), null);
    }
  }
});

test('player market sample is metric-specific without relabelling legacy coverage', () => {
  const player = { games_played: 10, stats_json: JSON.stringify({ coverage: { shots: 6, shotsOnTarget: 2, yellowCards: 0 } }) };
  assert.equal(service.getPlayerSampleSize(player, 'shots'), 6);
  assert.equal(service.getPlayerSampleSize(player, 'sot'), 2);
  assert.equal(service.getPlayerSampleSize(player, 'yellow'), 0);
  assert.equal(service.getPlayerSampleSize({ games_played: 10 }, 'shots'), 10);
  assert.equal(service.getPlayerSampleSize({ games_played: 0, stats_json: '{"identityOnly":true}' }, 'shots'), 0);
});

test('market gates and reliability use observed fields with unchanged thresholds', () => {
  const side = { sampleSize: 20, sampleSizeShots: 20, sampleSizeShotsOT: 1, sampleSizeYellow: 20, sampleSizeRed: 0 };
  const supplementary = { homeTeamStats: side, awayTeamStats: { ...side } };
  const flat = { homeWin: .5, shotsUnder155: .5, shotsOTUnder55: .5, yellowUnder45: .5, cardsTotalUnder45: .5 };
  const filtered = service.dropInsufficientStatMarkets(flat, true, supplementary);
  assert.deepEqual(Object.keys(filtered), ['homeWin', 'shotsUnder155', 'yellowUnder45']);
  assert.equal(service.shouldEnableStatMarkets(supplementary, ['sampleSizeShotsOT']), false);
  const legacy = { homeTeamStats: { sampleSize: 20 }, awayTeamStats: { sampleSize: 20 } };
  assert.deepEqual(service.dropInsufficientStatMarkets(flat, true, legacy), flat);
  const complete = service.buildAnalysisFactors({}, { lambdaHome: 1, lambdaAway: 1 }, {}, {}, .5, legacy);
  const partial = service.buildAnalysisFactors({}, { lambdaHome: 1, lambdaAway: 1 }, {}, {}, .5, supplementary);
  assert.ok(partial.shotsReliability < complete.shotsReliability);
  assert.ok(partial.disciplineReliability < complete.disciplineReliability);
});

test('real model, service family gate and API formatter retain only supported markets', () => {
  const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
  const { formatPrediction } = require('../dist/api/predictionPayloadFormatter');
  const fixture = require('./fixtures/format-prediction.input');
  const side = { avgShots: 12, avgShotsOT: 4, avgYellowCards: 2, avgRedCards: .1,
    avgFouls: 11, shotsSuppression: 1, sampleSize: 20, sampleSizeShots: 20,
    sampleSizeShotsOT: 0, sampleSizeYellow: 20, sampleSizeRed: 0 };
  const supp = { homeTeamStats: side, awayTeamStats: { ...side } };
  const probs = new DixonColesModel().computeFullProbabilities('A', 'B', 1, 1, supp);
  const goal = probs.flatProbabilities.over25;
  service.applyStatMarketAvailability(probs, supp);
  assert.equal(probs.flatProbabilities.over25, goal);
  assert.equal(probs.flatProbabilities.shotsOTUnder55, undefined);
  assert.deepEqual(probs.cards.overUnderTotal, {});
  assert.ok(Object.keys(probs.cards.overUnderYellow).length > 0);
  const formatted = formatPrediction({ ...structuredClone(fixture), probabilities: probs });
  assert.deepEqual(formatted.shotsPrediction.combined.onTargetOverUnder, {});
  assert.equal(formatted.shotsPrediction.home.shotsOnTarget.available, false);
  assert.equal(formatted.cardsPrediction.totalCardsWeighted.available, false);
  assert.ok(Object.keys(formatted.shotsPrediction.combined.overUnder).length > 0);
  const complete = { homeTeamStats: { ...side, sampleSizeShotsOT: 20, sampleSizeRed: 20 },
    awayTeamStats: { ...side, sampleSizeShotsOT: 20, sampleSizeRed: 20 } };
  const supported = new DixonColesModel().computeFullProbabilities('A', 'B', 1, 1, complete);
  const before = JSON.stringify(supported);
  service.applyStatMarketAvailability(supported, complete);
  assert.equal(JSON.stringify(supported), before, 'complete-data probabilities and payload remain identical');
});

test('referee coverage cannot replace a legacy profile with another history window', async () => {
  const subject = Object.create(PredictionService.prototype);
  const stored = { name: 'Synthetic Referee', total_games: 20, avg_yellow_cards_per_game: 4,
    avg_red_cards_per_game: 0, avg_fouls_per_game: 22 };
  const observed = { ...stored, yellow_games: 5, red_games: 20, fouls_games: 20 };
  subject.db = { getRefereeByName: async () => stored, getRefereeObservedStats: async () => observed };
  const matched = await subject.getPredictionReferee('Synthetic Referee', 'Serie A', new Date());
  assert.equal(matched.avg_yellow_cards_per_game, 4);
  assert.equal(matched.yellow_games, 5);
  assert.equal(matched.red_games, 20);
  subject.db.getRefereeObservedStats = async () => ({ ...observed, total_games: 99, avg_yellow_cards_per_game: 7 });
  assert.deepEqual(await subject.getPredictionReferee('Synthetic Referee', 'Serie A', new Date()), stored);
  subject.db.getRefereeObservedStats = async () => ({ ...observed, avg_yellow_cards_per_game: 7 });
  const differentMean = await subject.getPredictionReferee('Synthetic Referee', 'Serie A', new Date());
  assert.equal(differentMean.avg_yellow_cards_per_game, 4);
  assert.equal(differentMean.yellow_games, undefined);
});

test('yellow-card props use paired observed minutes and actual referee coverage', () => {
  const previous = process.env.PLAYER_DATA_ENABLED;
  process.env.PLAYER_DATA_ENABLED = 'true';
  const calls = [];
  service.playerCardsModel = { predictPlayerYellowCards(input) {
    calls.push(input); return { probabilityYellowOver0_5: .3, expectedPlayerYellows: .35 };
  } };
  try {
    const player = { player_id: 'understat_player_7', name: 'Synthetic Player', games_played: 10,
      avg_minutes: 90, minutes_total: 900, yellow_cards_total: 4,
      stats_json: JSON.stringify({ coverage: { yellowCards: 5 }, observedTotals: { yellowCards: 0 }, observedMinutes: { yellowCards: 450 } }) };
    const options = { homePlayers: [player], awayPlayers: [], homeTeamName: 'Synthetic Home', awayTeamName: 'Synthetic Away',
      probabilities: { cards: { expectedHomeYellow: 1.8 } }, leagueAvgYellowPerMatch: 3.8,
      referee: { avg_yellow_cards_per_game: 0, total_games: 20, yellow_games: 0 },
      lineupStatuses: new Map([['understat_player_7', { status: 'confirmed_starter', probability: 1 }]]),
      odds: { [key('yellow')]: 2 } };
    const result = service.buildPlayerPropMarkets(options);
    assert.ok(Object.keys(result.probabilities).length > 0);
    assert.equal(calls[0].playerYellowCards, 0);
    assert.equal(calls[0].playerMinutes, 450);
    assert.equal(calls[0].refereeCoverage, 0);
    assert.equal(calls[0].refereeYellowAvg, 0);
    for (const missing of [null, undefined, '', ' ', 'bad', -1, false]) {
      service.buildPlayerPropMarkets({ ...options, referee: { total_games: 20, avg_yellow_cards_per_game: missing } });
      assert.equal(calls.at(-1).refereeYellowAvg, options.leagueAvgYellowPerMatch);
      assert.equal(calls.at(-1).refereeCoverage, 0);
    }
    const noPair = { ...player, stats_json: JSON.stringify({ coverage: { yellowCards: 5 } }) };
    const skipped = service.buildPlayerPropMarkets({ ...options, homePlayers: [noPair] });
    assert.equal(Object.keys(skipped.probabilities).length, 0);
  } finally {
    if (previous === undefined) delete process.env.PLAYER_DATA_ENABLED;
    else process.env.PLAYER_DATA_ENABLED = previous;
  }
});
