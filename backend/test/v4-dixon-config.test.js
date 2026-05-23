const test = require('node:test');
const assert = require('node:assert/strict');
const { predictionEngineConfig } = require('../dist/config/PredictionEngineConfig.js');
const { DixonColesModel, ClassicDixonColesDependence, NoDependence } = require('../dist/models/core/DixonColesModel.js');

test('PredictionEngineConfig exposes v4 defaults and operational alignment', () => {
  assert.equal(predictionEngineConfig.dixonColes.dynamicTeamStrengths.enableDynamicTeamStrengths, false);
  assert.equal(predictionEngineConfig.dixonColes.temporalWeights.currentSeasonDecay, 0.002);
  assert.equal(predictionEngineConfig.valueBetting.operational.maxOdds, 8.0);
  assert.equal(predictionEngineConfig.operational.primaryOddsProvider, 'odds_api');
  assert.equal(predictionEngineConfig.operational.sofascoreSupplementalEnabled, false);
  assert.equal(predictionEngineConfig.operational.understatOnlyMarkets.cornersEnabled, false);
  assert.equal(predictionEngineConfig.operational.understatOnlyMarkets.foulsEnabled, false);
});

test('score dependence models keep classic Dixon-Coles tau pluggable', () => {
  const classic = new ClassicDixonColesDependence();
  const none = new NoDependence();

  assert.equal(Number(classic.correction(0, 0, 1.2, 0.9, -0.13).toFixed(4)), 1.1404);
  assert.equal(Number(classic.correction(1, 0, 1.2, 0.9, -0.13).toFixed(4)), 0.8830);
  assert.equal(Number(classic.correction(0, 1, 1.2, 0.9, -0.13).toFixed(4)), 0.8440);
  assert.equal(Number(classic.correction(1, 1, 1.2, 0.9, -0.13).toFixed(4)), 1.1300);
  assert.equal(none.correction(0, 0, 1.2, 0.9, -0.13), 1);
});

test('Dixon-Coles score matrix is normalized and non-negative with dependence model', () => {
  const model = new DixonColesModel({ rho: -0.13 }, { scoreDependenceModel: new ClassicDixonColesDependence() });
  const matrix = model.buildScoreMatrix('A', 'B', 1.4, 1.1);
  const sum = matrix.probabilities.flat().reduce((acc, value) => acc + value, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(matrix.probabilities.flat().every((value) => value >= 0));
});

test('automatic structural break detection uses measurable rolling stats', () => {
  const model = new DixonColesModel();
  const matches = [];
  for (let i = 0; i < 12; i++) {
    matches.push({
      matchId: `m-${i}`,
      homeTeamId: 'A',
      awayTeamId: 'B',
      date: new Date(Date.UTC(2025, 0, 1 + i)),
      homeGoals: i < 6 ? 0 : 3,
      awayGoals: i < 6 ? 2 : 0,
      homeXG: i < 6 ? 0.4 : 2.4,
      awayXG: i < 6 ? 1.8 : 0.5,
      homeTotalShots: i < 6 ? 6 : 18,
      awayTotalShots: i < 6 ? 15 : 7,
    });
  }

  const breaks = model.detectStructuralBreaks(matches, { teamId: 'A', minWindow: 3 });
  assert.ok(breaks.length >= 1);
  assert.equal(breaks[0].teamId, 'A');
  assert.ok(['attack', 'defence', 'global'].includes(breaks[0].breakType));
  assert.ok(breaks[0].confidence >= 0 && breaks[0].confidence <= 1);
  assert.ok(breaks[0].suggestedWeightMultiplier > 0 && breaks[0].suggestedWeightMultiplier <= 1);
});

test('bootstrap lambdas supports configured mode while preserving legacy fields', () => {
  const model = new DixonColesModel({
    attackParams: { A: 0.2, B: -0.1 },
    defenceParams: { A: -0.05, B: 0.08 },
    homeAdvantage: 0.1,
  });

  const result = model.bootstrapLambdas('A', 'B', { bootstrapMode: 'jackknife', bootstrapSamples: 20 });
  assert.ok(result.lambdaHomeMean > 0);
  assert.ok(result.lambdaAwayMean > 0);
  assert.ok(result.lambdaHomeStd >= 0);
  assert.ok(result.lambdaAwayStd >= 0);
  assert.ok(result.uncertaintyFactor >= 0 && result.uncertaintyFactor <= 1);
  assert.equal(result.lambda_home_mean, result.lambdaHomeMean);
  assert.equal(result.CV_max, result.cvMax);
});

test('bootstrap jackknife and hessian modes are deterministic compatibility fallbacks', () => {
  const model = new DixonColesModel({
    attackParams: { A: 0.2, B: -0.1 },
    defenceParams: { A: -0.05, B: 0.08 },
    homeAdvantage: 0.1,
  });

  const jackknifeA = model.bootstrapLambdas('A', 'B', { bootstrapMode: 'jackknife', bootstrapSamples: 20 });
  const jackknifeB = model.bootstrapLambdas('A', 'B', { bootstrapMode: 'jackknife', bootstrapSamples: 20 });
  const hessianA = model.bootstrapLambdas('A', 'B', { bootstrapMode: 'hessian', bootstrapSamples: 20 });
  const hessianB = model.bootstrapLambdas('A', 'B', { bootstrapMode: 'hessian', bootstrapSamples: 20 });

  assert.deepEqual(jackknifeA, jackknifeB);
  assert.deepEqual(hessianA, hessianB);
  assert.ok(jackknifeA.lambdaHomeStd >= 0);
  assert.ok(hessianA.lambdaAwayStd >= 0);
});

test('dynamic team strengths are feature-flagged and disabled path matches base fitting', () => {
  const matches = [];
  for (let i = 0; i < 24; i++) {
    matches.push({
      matchId: `dyn-${i}`,
      homeTeamId: i % 2 === 0 ? 'A' : 'B',
      awayTeamId: i % 2 === 0 ? 'B' : 'A',
      date: new Date(Date.UTC(2025, 0, 1 + i)),
      homeGoals: i % 3,
      awayGoals: (i + 1) % 2,
      season: '2025-2026',
    });
  }
  const base = new DixonColesModel();
  const flaggedOff = new DixonColesModel();
  const baseParams = base.fitModel(matches, ['A', 'B'], 20, 0.02);
  const offParams = flaggedOff.fitModel(matches, ['A', 'B'], 20, 0.02, { enableDynamicTeamStrengths: false });

  for (const team of ['A', 'B']) {
    assert.ok(Math.abs(offParams.attackParams[team] - baseParams.attackParams[team]) < 1e-12);
    assert.ok(Math.abs(offParams.defenceParams[team] - baseParams.defenceParams[team]) < 1e-12);
  }

  const dynamic = new DixonColesModel();
  const snapshots = dynamic.fitDynamicTeamStrengths(matches, ['A', 'B'], { windowSize: 8, maxIter: 10 });
  assert.ok(snapshots.length > 0);
  assert.ok(snapshots.every((snapshot) => snapshot.smoothingPenalty >= 0));
});

