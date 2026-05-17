const test = require('node:test');
const assert = require('node:assert/strict');
const { ValueBettingEngine } = require('../dist/models/value/ValueBettingEngine.js');
const { AdaptiveTuningService } = require('../dist/services/AdaptiveTuningService.js');
const { BacktestingEngine } = require('../dist/models/backtesting/BacktestingEngine.js');

test('ValueBettingEngine applies operational MAX_ODDS to shots when enabled', () => {
  const engine = new ValueBettingEngine({ operational: { maxOdds: 8, applyMaxOddsToAllMarkets: true } });
  const diag = engine.diagnoseSelection(
    { shotsOver235: 0.2 },
    { shotsOver235: 9.5 },
    'shotsOver235',
    { shotsOver235: 'Shots Over 23.5' }
  );

  assert.equal(diag.filterSettings.maxOdds, 8);
  assert.equal(diag.passed, false);
  assert.ok(diag.rejectionCodes.includes('odds_out_of_range'));
});

test('dynamic EV threshold increases with low richness, variance and calibration penalty', () => {
  const engine = new ValueBettingEngine({ dynamicEvThresholdEnabled: true });
  const base = engine.computeDynamicEvThreshold('shots', { richnessScore: 0.93 });
  const penalized = engine.computeDynamicEvThreshold('shots', {
    richnessScore: 0.4,
    marketVariance: 1.8,
    calibrationPenalty: 1.4,
  });

  assert.ok(base >= 0.04);
  assert.ok(penalized > base);
});

test('AdaptiveTuningService computes v4 evDelta formula and clamps', () => {
  const service = new AdaptiveTuningService();

  const highRejection = service.computeCategoryTuning({ filterRejectionRate: 1, totalWeight: 12 });
  assert.ok(highRejection.evDelta < 0);

  const highWrong = service.computeCategoryTuning({ wrongPickRate: 10, totalWeight: 12 });
  assert.equal(highWrong.evDelta, 0.008);

  const highNegative = service.computeCategoryTuning({ filterRejectionRate: 10, totalWeight: 12 });
  assert.equal(highNegative.evDelta, -0.012);

  const lowWeight = service.computeCategoryTuning({ wrongPickRate: 1, totalWeight: 1 });
  assert.equal(lowWeight.confidenceScale, 0.2);
});

test('BacktestingEngine exposes weighted metric helper', () => {
  const engine = new BacktestingEngine();
  const metrics = engine.computeWeightedProbabilityMetrics([
    { ourProb: 0.7, won: true, stake: 4, odds: 1.8, marketCategory: 'goal_1x2' },
    { ourProb: 0.3, won: false, stake: 1, odds: 3.4, marketCategory: 'goal_1x2' },
  ], 'stake');

  assert.ok(metrics.weightedBrierScore >= 0);
  assert.ok(metrics.weightedLogLoss >= 0);
  assert.equal(metrics.weightMode, 'stake');
});
