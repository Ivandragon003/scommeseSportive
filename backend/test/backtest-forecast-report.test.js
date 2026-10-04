const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeBacktestProbabilityMetrics } = require('../dist/services/PredictionService.js');
const { buildBacktestReport } = require('../dist/services/BacktestReportService.js');

function metrics(nMatches, brierScore, logLoss) {
  const goals = { nMatches, nObservations: nMatches * 7, brierScore, logLoss };
  return { scope: 'all_common_forecasts', primaryFamily: 'goals', ...goals, byFamily: { goals } };
}

test('Top5 forecast metrics are pooled by observations, including leagues without bets', () => {
  const pooled = mergeBacktestProbabilityMetrics([metrics(10, .1, .3), metrics(90, .2, .9)]);
  assert.equal(pooled.nMatches, 100);
  assert.equal(pooled.nObservations, 700);
  assert.ok(Math.abs(pooled.brierScore - .19) < 1e-12);
  assert.ok(Math.abs(pooled.logLoss - .84) < 1e-12);
  assert.equal(mergeBacktestProbabilityMetrics([]), undefined);
});

test('report keeps forecast metrics separate from the filtered bet population', () => {
  const forecast = metrics(100, .19, .84);
  const report = buildBacktestReport({ kind: 'walk_forward', probabilityMetrics: forecast, detailedBets: [] });
  assert.deepEqual(report.probabilityMetrics, forecast);
  assert.equal(report.summary.totalBets, 0);
  const filtered = buildBacktestReport({ probabilityMetrics: forecast, detailedBets: [] }, { market: 'goal_1x2' });
  assert.deepEqual(filtered.probabilityMetrics, forecast);
  assert.equal(buildBacktestReport({}).probabilityMetrics, null);
});
