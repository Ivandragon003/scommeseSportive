const test = require('node:test');
const assert = require('node:assert/strict');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
const { BacktestingEngine } = require('../dist/models/backtesting/BacktestingEngine');
const { prepareSharedForecast, finishSharedForecast } = require('../dist/services/SharedForecastCalculator');
const { applyModelAOneXTwoForm, historicalModelAFormAdjustments, modelARecentForm } = require('../dist/services/ModelARecentForm');

const day = 24 * 60 * 60 * 1000;
const kickoff = Date.UTC(2026, 9, 1);
const target = {
  matchId: 'target', homeTeamId: 'A', awayTeamId: 'B',
  date: new Date(kickoff), competition: 'League', season: '2026/2027',
};
const match = (daysAgo, data = {}) => ({
  ...target, matchId: `past-${daysAgo}`, date: new Date(kickoff - daysAgo * day),
  homeGoals: 2, awayGoals: 0, ...data,
});

test('form requires five unique completed league games per club in the current season by the decision time', () => {
  const firstFour = [1, 2, 3, 4].map(n => match(n));
  const history = [...firstFour, ...[
    match(6, { season: '2025/2026' }),
    match(7, { competition: 'Cup' }),
    match(8, { awayGoals: undefined }),
    match(9, { matchId: target.matchId }),
    match(-1),
    { ...firstFour[0] },
    match(0.01),
    match(10, { awayTeamId: 'Other' }),
  ]];
  assert.equal(modelARecentForm(target, history), undefined);
  const fifth = match(0.25, { homeTeamId: 'B', awayTeamId: 'A', homeGoals: 0, awayGoals: 0, season: '2026-2027' });
  const complete = [...history, fifth];
  assert.equal(modelARecentForm(target, complete, new Date(kickoff - 0.2 * day)), undefined);
  assert.deepEqual(modelARecentForm(target, complete), { homeFormIndex: 13 / 15, awayFormIndex: 1 / 15 });
  assert.deepEqual(modelARecentForm(target, [...complete, match(11)]), modelARecentForm(target, complete));
});

test('explicit A replay uses the contextual matrix for 1X2 only and preserves the shared default', () => {
  const engine = new BacktestingEngine();
  const history = [1, 2, 3, 4, 5].map(n => match(n));
  const shared = engine.buildAsOfPredictionContext(target, history);
  const adjustments = historicalModelAFormAdjustments(target, history, shared.supplementaryData.competitiveness);
  assert.ok(adjustments);
  assert.equal(historicalModelAFormAdjustments(target, history.slice(0, 4)), undefined);

  const model = new DixonColesModel();
  const prepared = prepareSharedForecast(model, 'A', 'B', shared.homeXG, shared.awayXG, shared.supplementaryData);
  const ensemble = { enabled: false, weights: { default: 0 } };
  const { flatProbabilities: initial } = finishSharedForecast(prepared, null, ensemble);
  const actual = { ...initial, double_chance_1x: initial.homeWin + initial.draw };
  const before = { ...actual };
  applyModelAOneXTwoForm(actual, model, prepared, null, ensemble, shared.homeXG, shared.awayXG, adjustments);
  assert.ok(actual.homeWin > initial.homeWin);
  assert.ok(Math.abs(actual.homeWin + actual.draw + actual.awayWin - 1) < 1e-10);
  const keys = new Set(['homeWin', 'draw', 'awayWin']);
  assert.deepEqual(Object.entries(actual).filter(([k]) => !keys.has(k)), Object.entries(before).filter(([k]) => !keys.has(k)));
  assert.deepEqual(prepared.full.flatProbabilities, initial);
});
