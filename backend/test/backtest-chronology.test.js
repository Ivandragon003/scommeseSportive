const test = require('node:test');
const assert = require('node:assert/strict');
const { BacktestingEngine } = require('../dist/models/backtesting/BacktestingEngine.js');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel.js');
const { PoissonXgModel } = require('../dist/models/core/PoissonXgModel.js');
const { blendGoalProbabilities } = require('../dist/services/ProbabilityEnsembleService.js');
const { predictionEngineConfig } = require('../dist/config/PredictionEngineConfig.js');
const { predictionConfig } = require('../dist/config/predictionConfig.js');

const DAY = 86400000;
const HOUR = 3600000;
const START = Date.UTC(2024, 7, 1);
const GOALS = ['homeWin', 'draw', 'awayWin', 'over15', 'over25', 'over35', 'btts'];

function fixtures(n = 60) {
  return Array.from({ length: n }, (_, i) => ({
    matchId: `chronology-${i}`, homeTeamId: i % 2 ? 'B' : 'A', awayTeamId: i % 2 ? 'A' : 'B',
    date: new Date(START + i * DAY), competition: 'Serie A', season: '2024/2025',
    homeGoals: i % 4, awayGoals: i % 3, homeXG: 0.8 + (i % 5) / 3, awayXG: 0.7 + (i % 4) / 4,
    homeTotalShots: 10 + i % 5, awayTotalShots: 9 + i % 5,
    homeShotsOnTarget: 4 + i % 2, awayShotsOnTarget: 3 + i % 2,
    homeYellowCards: 2, awayYellowCards: 1, homeRedCards: 1, awayRedCards: 0,
    homeFouls: 12, awayFouls: 10,
  }));
}

function run(matches, odds = {}, contexts = {}) {
  return new BacktestingEngine().runWalkForwardBacktest(matches, odds, {
    initialTrainMatches: 30, testWindowMatches: 10, stepMatches: 5, maxFolds: 4, includeProbabilityObservations: true,
  }, contexts);
}

function simulate(engine, train, targets, odds, confidence, context = {}) {
  return engine.simulateBacktestScenario(train, targets, odds, confidence, context, { includeProbabilityObservations: true });
}

function probabilities(result, id, stage = 'raw') {
  return Object.fromEntries(result.probabilityObservations.filter((row) => row.matchId === id && row.stage === stage)
    .map((row) => [row.selection, row.probability]));
}

test('all goal forecasts are scored without odds or bets and overlapping folds count each fixture once', () => {
  const result = run(fixtures());
  assert.equal(result.summary.totalBetsPlaced, 0);
  assert.equal(result.summary.totalStaked, 0);
  assert.equal(result.probabilityMetrics.nMatches, 25);
  assert.equal(result.probabilityMetrics.nObservations, 25 * GOALS.length);
  const rows = result.probabilityObservations.filter((row) => row.stage === 'blended' && GOALS.includes(row.selection));
  assert.equal(new Set(rows.map((row) => `${row.matchId}:${row.selection}`)).size, rows.length);
  const brier = rows.reduce((sum, row) => sum + (row.probability - row.outcome) ** 2, 0) / rows.length;
  const loss = rows.reduce((sum, row) => sum - Math.log(row.outcome ? row.probability : 1 - row.probability), 0) / rows.length;
  assert.ok(Math.abs(result.probabilityMetrics.brierScore - brier) < 1e-12);
  assert.ok(Math.abs(result.probabilityMetrics.logLoss - loss) < 1e-12);
  assert.equal(result.summary.averageBrierScore, Number(brier.toFixed(4)));
  assert.equal(result.folds.reduce((sum, fold) => sum + fold.probabilityMetrics.nMatches, 0), 25);
  assert.deepEqual(result.folds.map((fold) => fold.trainMatches), [30, 40, 45, 50]);
});

test('default persisted payload omits full forecast rows while opt-in preserves the same OOS metrics', () => {
  const matches = fixtures();
  const compact = new BacktestingEngine().runWalkForwardBacktest(matches, {}, {
    initialTrainMatches: 30, testWindowMatches: 10, stepMatches: 5, maxFolds: 4,
  });
  const exported = run(matches);
  assert.equal(Object.hasOwn(compact, 'probabilityObservations'), false);
  assert.equal(JSON.stringify(compact).includes('probabilityObservations'), false);
  assert.ok(exported.probabilityObservations.length > 0);
  const { probabilityObservations: omittedRows, ...withoutExport } = exported;
  assert.ok(omittedRows.some((row) => row.stage === 'raw'));
  assert.deepEqual(compact, withoutExport); // Includes later-fold calibrated/blended metrics: internal history still exists.
  const firstFold = new BacktestingEngine().simulateBacktestScenario(matches.slice(0, 30), [matches[30]], {}, 'high_only');
  assert.equal(Object.hasOwn(firstFold, 'probabilityObservations'), false);
  assert.equal(firstFold.probabilityMetrics.nMatches, 1);
});

test('target realized xG and all future outcomes cannot change the first prematch forecast', () => {
  const original = fixtures();
  const changed = original.map((row, i) => i < 30 ? row : ({ ...row,
    homeXG: 999, awayXG: 777, homeGoals: 15, awayGoals: 13,
    homeTotalShots: 999, awayShotsOnTarget: 999, homeYellowCards: 99,
  }));
  assert.deepEqual(probabilities(run(original), 'chronology-30'), probabilities(run(changed), 'chronology-30'));
});

test('context and fitting reject simultaneous, unfinished and future results; exact two-hour boundary is available', () => {
  const engine = new BacktestingEngine();
  const train = fixtures(30);
  const target = fixtures(31)[30];
  const near = { ...train[0], matchId: 'one-hour', date: new Date(target.date.getTime() - HOUR), homeXG: 999 };
  const simultaneous = { ...near, matchId: 'same-time', date: target.date };
  const future = { ...near, matchId: 'future', date: new Date(target.date.getTime() + DAY) };
  const unfinished = { ...train[0], matchId: 'unfinished', homeGoals: null, homeXG: 999 };
  const polluted = [...train, near, simultaneous, future, unfinished, target];
  assert.deepEqual(engine.buildAsOfPredictionContext(target, polluted), engine.buildAsOfPredictionContext(target, train));
  const actual = simulate(engine, polluted, [target], {}, 'medium_and_above');
  const expected = simulate(new BacktestingEngine(), train, [target], {}, 'medium_and_above');
  assert.deepEqual(probabilities(actual, target.matchId), probabilities(expected, target.matchId));
  assert.equal(actual.trainingMatches, 30);
  const boundary = { ...near, matchId: 'two-hours', date: new Date(target.date.getTime() - 2 * HOUR), homeXG: 3 };
  const context = engine.buildAsOfPredictionContext(target, [boundary, near, simultaneous, future]);
  assert.equal(context.homeXG, 3);
  assert.equal(context.supplementaryData.homeTeamStats.sampleSize, 1);
});

test('raw forecast matches current production DC scale and configured Poisson ensemble on prior venue xG', () => {
  const matches = fixtures(31), train = matches.slice(0, 30), target = matches[30];
  const engine = new BacktestingEngine();
  const context = engine.buildAsOfPredictionContext(target, train);
  const dc = new DixonColesModel();
  const params = dc.fitModel(train, ['A', 'B'], 280, 0.04, { referenceDate: target.date });
  dc.setParams({ ...params, homeAdvantage: Math.max(-0.8, Math.min(1.2, params.homeAdvantage * predictionConfig.model.homeAdvantageScale)) });
  const poisson = new PoissonXgModel(); poisson.fit(train);
  const raw = blendGoalProbabilities(dc.computeFullProbabilities('A', 'B', context.homeXG, context.awayXG,
    context.supplementaryData).flatProbabilities, poisson.computeGoalProbabilities('A', 'B'), predictionEngineConfig.ensemble);
  const actual = probabilities(simulate(engine, train, [target], {}, 'medium_and_above'), target.matchId);
  for (const key of GOALS) assert.ok(Math.abs(actual[key] - raw[key]) < 1e-12, key);
});

test('missing count outcomes are excluded and total cards settle on yellow plus twice red', () => {
  const matches = fixtures(31), target = matches[30];
  const engine = new BacktestingEngine();
  const complete = simulate(engine, matches.slice(0, 30), [target], {}, 'medium_and_above');
  const cards = complete.probabilityObservations.find((row) => row.selection === 'cardsTotalOver45' && row.stage === 'raw');
  assert.equal(cards.outcome, 1); // 2 + 1 + 2*1 = 5 booking points, only 3 yellow.
  assert.equal(engine.evaluateBetNullable('yellowOver45', target), false);
  assert.equal(engine.evaluateBetNullable('dnb_home', { ...target, homeGoals: 1, awayGoals: 1 }), null);
  const missing = simulate(engine, matches.slice(0, 30), [{ ...target, homeYellowCards: null,
    awayShotsOnTarget: null, awayTotalShots: null }], {}, 'medium_and_above');
  assert.equal(missing.probabilityMetrics.nMatches, 1);
  for (const family of ['cards', 'yellow', 'shots', 'shots_ot']) assert.equal(missing.probabilityMetrics.byFamily[family].nMatches, 0);
  assert.equal(engine.evaluateBetNullable('cardsTotalOver45', { ...target, homeRedCards: null }), null);
});

test('card learning uses booking points for total cards and preserves yellow-only line errors', () => {
  const engine = new BacktestingEngine(), target = fixtures(31)[30];
  const cardsActual = engine.getActualCards(target, 'cardsTotalUnder45');
  const yellowActual = engine.getActualCards(target, 'yellowUnder45');
  assert.equal(cardsActual, 5);
  assert.equal(engine.getActualCards(target, 'cards_total_under_45'), 5);
  assert.equal(yellowActual, 3);
  const cards = engine.assessCardLineLearning({ selection: 'cardsTotalUnder45', actualCards: cardsActual, clv: 0.02 });
  const yellow = engine.assessCardLineLearning({ selection: 'yellowUnder45', actualCards: yellowActual, clv: 0.02 });
  assert.equal(cards.cardLineError, 0.5);
  assert.equal(yellow.cardLineError, -1.5);
  assert.notEqual(cards.cardLearningAdjustment, yellow.cardLearningAdjustment);
  assert.equal(engine.getActualCards({ ...target, homeRedCards: null }, 'cardsTotalUnder45'), null);
  assert.equal(engine.getActualCards({ ...target, homeRedCards: null }, 'yellowUnder45'), 3);
});

test('first fold has no fitted calibration and later folds use only available earlier OOS forecasts', () => {
  const result = run(fixtures());
  const firstId = 'chronology-30';
  const raw = probabilities(result, firstId), calibrated = probabilities(result, firstId, 'calibrated');
  for (const key of GOALS) assert.ok(Math.abs(raw[key] - calibrated[key]) < 1e-12);
  const engine = new BacktestingEngine();
  const cutoff = new Date(START + 40 * DAY);
  const previous = result.probabilityObservations.filter((row) => row.date.getTime() < cutoff.getTime());
  const baseline = engine.buildOutOfSampleCalibrationProfile(previous, cutoff);
  const injected = ['one-hour', 'same-time', 'future'].flatMap((matchId, i) => ['raw', 'calibrated'].map((stage) => ({
    matchId, date: new Date(cutoff.getTime() + (i - 1) * HOUR), selection: 'homeWin',
    probability: 0.99, outcome: 0, stage,
  })));
  assert.ok(baseline.nObservations > 0);
  assert.deepEqual(engine.buildOutOfSampleCalibrationProfile([...previous, ...injected], cutoff), baseline);
});

test('unknown, synthetic and post-kickoff prices never produce financial bets', () => {
  const matches = fixtures();
  const odds = Object.fromEntries(matches.map((row) => [row.matchId, { homeWin: 2.3, draw: 3.8, awayWin: 4.1, over25: 2.14, under25: 1.81 }]));
  const cases = [
    {},
    { oddsSource: 'synthetic', snapshotSource: 'odds_api_plus_model_completion', selectedBookmakerName: 'Pinnacle', usedSyntheticOdds: true },
    { oddsSource: 'synthetic', snapshotSource: 'eurobet', capturedAt: new Date(START).toISOString() },
    { oddsSource: 'odds_api', snapshotSource: 'odds_api', selectedBookmakerName: 'Pinnacle', usedFallbackBookmaker: true },
    { oddsSource: 'odds_api', snapshotSource: 'odds_api', selectedBookmakerName: 'Pinnacle', capturedAt: 'invalid-date' },
    { oddsSource: 'odds_api', snapshotSource: 'odds_api', selectedBookmakerName: 'Pinnacle', capturedAt: null },
  ];
  for (const entry of cases) {
    const result = run(matches, odds, Object.fromEntries(matches.map((row) => [row.matchId, entry])));
    assert.equal(result.summary.totalBetsPlaced, 0);
    assert.equal(result.probabilityMetrics.nMatches, 25);
    assert.equal(result.folds.every((fold) => fold.singleBestAlways.totalBets === 0), true);
  }
  const afterKickoff = Object.fromEntries(matches.map((row) => [row.matchId, {
    oddsSource: 'odds_api', snapshotSource: 'odds_api', selectedBookmakerName: 'Pinnacle', capturedAt: row.date.toISOString(),
  }]));
  assert.equal(run(matches, odds, afterKickoff).summary.totalBetsPlaced, 0);
  const fd = Object.fromEntries(matches.map((row) => [row.matchId, {
    oddsSource: 'fallback', snapshotSource: 'football_data_market_average', capturedAt: null,
  }]));
  const real = run(matches, odds, fd);
  assert.ok(real.summary.totalBetsPlaced > 0);
  assert.equal(real.detailedBets.every((bet) => bet.isRealBookmakerOdds && !bet.isSynthetic), true);
  assert.equal(new Set(real.detailedBets.map((bet) => `${bet.matchId}:${bet.selection}`)).size, real.detailedBets.length);
});

test('as-of aggregates retain current production possession, variance, missing-venue defaults and fouls-drawn semantics', () => {
  const engine = new BacktestingEngine(), target = fixtures(31)[30];
  const home = { ...fixtures(1)[0], homePossession: 40, awayFouls: 10, homeYellowCards: 4 };
  const olderAway = { ...home, matchId: 'away-history', date: new Date(START + 5 * DAY),
    homeTeamId: 'C', awayTeamId: 'A', homeFouls: null, awayYellowCards: null };
  const anotherHome = { ...home, matchId: 'later-home', date: new Date(START + 10 * DAY), homePossession: 60, awayFouls: 20 };
  const supp = engine.buildAsOfSupp(target, [home, olderAway, anotherHome]);
  assert.equal(supp.homeTeamStats.avgPossession, 50);
  assert.equal(supp.homeTeamStats.avgFoulsDrawn, 10); // (10 + 0 + 20)/3, missing count is not an observed zero sample.
  const homeWeight = Math.exp(-0.005 * 30) + Math.exp(-0.005 * 20), awayWeight = Math.exp(-0.005 * 25);
  assert.ok(Math.abs(supp.homeTeamStats.avgYellowCards - (4 * homeWeight + 1.9 * awayWeight) / (homeWeight + awayWeight)) < 1e-12);
  const single = engine.buildAsOfSupp(target, [home]);
  assert.equal(single.homeTeamStats.varShots, 0);
});

test('probability metrics include the actual market blend before EV filters reject bets', () => {
  const engine = new BacktestingEngine();
  const matches = fixtures(31), target = matches[30];
  const actualBlends = new Map();
  const originalBlend = engine.engine.blendForecastProbability.bind(engine.engine);
  engine.engine.blendForecastProbability = (selection, probability, group, context) => {
    const blended = originalBlend(selection, probability, group, context);
    actualBlends.set(selection, blended);
    return blended;
  };
  const odds = { [target.matchId]: { homeWin: 1.11, draw: 1.11, awayWin: 1.11 } };
  const context = { [target.matchId]: { oddsSource: 'odds_api', snapshotSource: 'odds_api',
    selectedBookmakerName: 'Pinnacle', capturedAt: new Date(target.date.getTime() - HOUR).toISOString() } };
  const result = simulate(engine, matches.slice(0, 30), [target], odds, 'high_only', context);
  assert.equal(result.betsPlaced, 0);
  assert.equal(result.probabilityMetrics.nMatches, 1);
  const blended = probabilities(result, target.matchId, 'blended');
  for (const key of GOALS) assert.equal(blended[key], actualBlends.get(key));
  assert.notEqual(blended.homeWin, probabilities(result, target.matchId, 'calibrated').homeWin);
  assert.equal(blended.over25, probabilities(result, target.matchId, 'calibrated').over25);
  const brier = GOALS.reduce((sum, selection) => {
    const row = result.probabilityObservations.find((candidate) => candidate.selection === selection && candidate.stage === 'blended');
    return sum + (row.probability - row.outcome) ** 2;
  }, 0) / 7;
  assert.equal(result.brierScore, brier);
});

test('CLV accepts verified same-bookmaker odds_api closing and rejects mismatched or invalid captures', () => {
  const engine = new BacktestingEngine(), target = fixtures(31)[30];
  const entry = { oddsSource: 'odds_api', snapshotSource: 'odds_api', selectedBookmakerKey: 'pinnacle',
    selectedBookmakerName: 'Pinnacle', capturedAt: new Date(target.date.getTime() - 2 * HOUR).toISOString(),
    closingSource: 'odds_api', closingBookmakerKey: 'pinnacle', closingBookmakerName: 'Pinnacle',
    closingCapturedAt: new Date(target.date.getTime() - HOUR).toISOString(), closingOdds: { homeWin: 2.1 } };
  assert.equal(engine.resolveClosingOdds(entry, 'homeWin', target.date).closingOdds, 2.1);
  assert.equal(engine.resolveClosingOdds({ ...entry, closingBookmakerKey: 'betfair' }, 'homeWin', target.date).closingOdds, null);
  assert.equal(engine.resolveClosingOdds({ ...entry, closingCapturedAt: null }, 'homeWin', target.date).closingOdds, null);
  assert.equal(engine.resolveClosingOdds({ ...entry, closingCapturedAt: 'invalid' }, 'homeWin', target.date).closingOdds, null);
  assert.equal(engine.resolveClosingOdds({ ...entry, closingCapturedAt: new Date(target.date.getTime() + HOUR).toISOString() }, 'homeWin', target.date).closingOdds, null);
  assert.equal(engine.resolveClosingOdds({ ...entry, closingCapturedAt: new Date(target.date.getTime() - 3 * HOUR).toISOString() }, 'homeWin', target.date).closingOdds, null);
});
