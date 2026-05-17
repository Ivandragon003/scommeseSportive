const test = require('node:test');
const assert = require('node:assert/strict');
const { ShotsModel } = require('../dist/models/markets/ShotsModel.js');
const { BacktestingEngine } = require('../dist/models/backtesting/BacktestingEngine.js');
const { ValueBettingEngine } = require('../dist/models/value/ValueBettingEngine.js');
const { PredictionContextBuilder } = require('../dist/services/PredictionContextBuilder.js');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel.js');

function playerProfile() {
  return {
    playerId: 'p1', playerName: 'Forward', teamId: 'T1', position: 'FWD',
    zipPi: 0.25, zipLambda: 2.6, onTargetPi: 0.42, onTargetLambda: 0.85,
    avgMinutesPlayed: 78, homeMultiplier: 1.06,
    avgShotsVsTopDefence: 1.9, avgShotsVsWeakDefence: 3.2,
    sampleSize: 24, lastUpdated: new Date('2026-01-01T00:00:00Z'),
  };
}

test('player shots and shots-on-target have separate prediction pipelines and outputs', () => {
  const model = new ShotsModel();
  const profile = playerProfile();

  const shots = model.predictPlayerShots(profile, true, 1, true, 82, 0.12, {
    playerShotsDistribution: 'ZIP',
    teamShotsMean: 18,
    leagueAvgTeamShots: 12,
  });
  const sot = model.predictPlayerShotsOnTarget(profile, {
    isHome: true,
    expectedMinutes: 82,
    minutesDistributionMode: 'triangular',
    historicalShotAccuracy: 0.34,
    teamShotsOnTargetMean: 6.2,
    opponentShotsOnTargetAllowed: 5.8,
    leagueAvgTeamShotsOnTarget: 4.6,
  });

  for (const result of [shots, sot]) {
    assert.ok(result.expectedValue > 0);
    assert.ok(result.fullDistribution);
    assert.ok(result.probabilityOver0_5 >= result.probabilityOver1_5);
    assert.ok(result.probabilityOver1_5 >= result.probabilityOver2_5);
    assert.ok(result.confidence > 0 && result.confidence <= 1);
    assert.ok(result.sampleSize > 0);
    assert.ok(result.modelUsed);
  }
  assert.notDeepEqual(shots.fullDistribution, sot.fullDistribution);

  const sparseSot = model.predictPlayerShotsOnTarget({ ...profile, sampleSize: 1 }, {
    expectedMinutes: 70,
    historicalShotAccuracy: 0.90,
    leagueAvgShotAccuracy: 0.34,
  });
  assert.ok(sparseSot.expectedValue > 0);
  assert.ok(sparseSot.confidence > 0);
});

test('empirical minutes distribution uses dated starter/substitute samples and falls back when sparse', () => {
  const model = new ShotsModel();
  const rich = model.estimateMinutesDistribution({
    mode: 'empirical',
    expectedMinutes: 75,
    isLikelyStarter: true,
    observations: [
      { minutes: 90, date: new Date('2026-04-01'), isStarter: true },
      { minutes: 82, date: new Date('2026-04-08'), isStarter: true },
      { minutes: 76, date: new Date('2026-04-15'), isStarter: true },
      { minutes: 88, date: new Date('2026-04-22'), isStarter: true },
      { minutes: 65, date: new Date('2026-04-29'), isStarter: true },
    ],
    asOf: new Date('2026-05-01'),
  });
  const sparse = model.estimateMinutesDistribution({ mode: 'empirical', expectedMinutes: 75, observations: [{ minutes: 20 }] });

  assert.equal(rich.modeUsed, 'empirical');
  assert.ok(rich.mean > 70);
  assert.ok(rich.std >= 0);
  assert.ok(rich.quantiles.q25 <= rich.quantiles.q50 && rich.quantiles.q50 <= rich.quantiles.q75);
  assert.equal(sparse.modeUsed, 'triangular');
});

test('hierarchical team-to-player shots uses weighted shot share and beta-binomial overdispersion', () => {
  const model = new ShotsModel();
  const prediction = model.predictHierarchicalPlayerShots(
    { mean: 16, dispersion: 9 },
    {
      playerId: 'p1', playerName: 'Forward', teamId: 'T1', role: 'forward', expectedMinutes: 80,
      observations: [
        { playerShots: 4, teamShots: 18, playerMinutes: 82, date: new Date('2026-04-01') },
        { playerShots: 0, teamShots: 17, playerMinutes: 75, date: new Date('2026-04-08') },
        { playerShots: 5, teamShots: 14, playerMinutes: 88, date: new Date('2026-04-15') },
        { playerShots: 1, teamShots: 19, playerMinutes: 80, date: new Date('2026-04-22') },
      ],
      minMinutesForShotShare: 20,
      useBetaBinomial: true,
      asOf: new Date('2026-05-01'),
    }
  );

  assert.ok(prediction.expectedShots > 0);
  assert.ok(prediction.probabilityOver0_5 >= prediction.probabilityOver1_5);
  assert.ok(['hierarchical_binomial', 'hierarchical_beta_binomial'].includes(prediction.modelUsed));
  assert.ok(prediction.tau > 0 && prediction.tau < 1);
  assert.ok(prediction.fullDistribution[0] >= 0);
});

test('backtesting exposes calibration by market with fallback and market-level reports', () => {
  const engine = new BacktestingEngine();
  const bets = [];
  for (let i = 0; i < 30; i++) bets.push({ ourProb: 0.35 + i * 0.01, won: i % 3 !== 0, marketCategory: 'goal_1x2', stake: 2, odds: 2.1, profit: i % 3 !== 0 ? 2.2 : -2, matchDate: new Date(2026, 0, i + 1) });
  for (let i = 0; i < 8; i++) bets.push({ ourProb: 0.45, won: i % 2 === 0, marketCategory: 'shots', stake: 1, odds: 2.4, profit: i % 2 === 0 ? 1.4 : -1, matchDate: new Date(2026, 1, i + 1) });

  const calibration = engine.computeCalibrationByMarket(bets, { desiredBuckets: 5, minBucketSize: 10 });
  const reports = engine.computeMarketLevelReports(bets, 'stake');

  assert.ok(calibration.global.length > 0);
  assert.ok(calibration.byMarket.goal_1x2.length > 0);
  assert.deepEqual(calibration.byMarket.shots, calibration.global);
  assert.ok(calibration.blending.goal_1x2.alpha >= 0.10);
  assert.ok(reports.goal_1x2.weightedBrierScore >= 0);
  assert.ok('edgeDecayByMonth' in reports.goal_1x2);
  assert.equal(reports.goal_1x2.usedSyntheticOddsOnly, false);
});

test('adaptive tuning evDelta is clamped and applied to effective EV threshold', () => {
  const engine = new ValueBettingEngine();
  engine.setAdaptiveTuning({
    source: 'test', generatedAt: new Date().toISOString(), totalReviews: 20,
    categories: { shots: { evDelta: 0.05, coherenceDelta: 0, rankingMultiplier: 1, sampleSize: 20, rankingErrorRate: 0, filterRejectionRate: 0, confirmationRate: 0, wrongPickRate: 100 } },
  });

  const threshold = engine.getEffectiveEvThreshold('shots', undefined, 'shotsOver235');
  assert.equal(Number(threshold.toFixed(3)), 0.048);
});

test('combo covariance mode is deterministic proxy, falls back without correlations and scales stake with configured covariance', () => {
  const legs = [
    { marketName: 'A', selection: 'homeWin', marketCategory: 'goal_1x2', marketTier: 'CORE', ourProbability: 62, bookmakerOdds: 2.1, impliedProbability: 47, impliedProbabilityNoVig: 47, expectedValue: 30, kellyFraction: 2, suggestedStakePercent: 1, confidence: 'HIGH', isValueBet: true, edge: 15, edgeNoVig: 15, matchId: 'm1' },
    { marketName: 'B', selection: 'over25', marketCategory: 'goal_ou', marketTier: 'CORE', ourProbability: 58, bookmakerOdds: 2.0, impliedProbability: 50, impliedProbabilityNoVig: 50, expectedValue: 16, kellyFraction: 2, suggestedStakePercent: 1, confidence: 'HIGH', isValueBet: true, edge: 8, edgeNoVig: 8, matchId: 'm2' },
  ];
  const fallback = new ValueBettingEngine({ comboRiskMode: 'covarianceMonteCarlo' }).buildCombinations(legs, 2, 0.01)[0];
  const covarianceEngine = new ValueBettingEngine({ comboRiskMode: 'covarianceMonteCarlo', comboCorrelationMatrix: { 'goal_1x2|goal_ou': 0.75 } });
  const covariance = covarianceEngine.buildCombinations(legs, 2, 0.01)[0];
  const covarianceRepeat = covarianceEngine.buildCombinations(legs, 2, 0.01)[0];

  assert.ok(fallback.suggestedStakePercent >= covariance.suggestedStakePercent);
  assert.equal(fallback.comboRiskMode, 'sqrtLegs');
  assert.equal(covariance.comboRiskMode, 'covarianceMonteCarlo');
  assert.equal(covariance.suggestedStakePercent, covarianceRepeat.suggestedStakePercent);
  assert.equal(covariance.returnVariance, covarianceRepeat.returnVariance);
  assert.ok(covariance.returnVariance > 0);
});

test('learnContextWeights and optimizeTemporalWeights use temporal training folds and fallback safely', () => {
  const builder = new PredictionContextBuilder();
  assert.equal(builder.learnContextWeights([]).usedFallback, true);

  const rows = [];
  for (let i = 0; i < 28; i++) {
    rows.push({
      date: new Date(Date.UTC(2025, 0, i + 1)),
      features: { formDelta: i % 2 ? 0.4 : -0.2, motivationDelta: 0.1, absencesDelta: -0.1, disciplineDelta: 0, restDelta: 0.1, scheduleLoadDelta: 0 },
      outcome: i % 2 ? 1 : 0,
    });
  }
  const learned = builder.learnContextWeights(rows, { minSamples: 20 });
  assert.equal(learned.usedFallback, false);
  assert.ok(learned.weights.w_form >= 0);
  assert.equal(learned.trainSamples + learned.validationSamples, rows.length);

  const model = new DixonColesModel();
  const matches = [];
  for (let i = 0; i < 36; i++) {
    matches.push({ matchId: `tw-${i}`, homeTeamId: i % 2 ? 'A' : 'B', awayTeamId: i % 2 ? 'B' : 'A', date: new Date(Date.UTC(2025, 0, i + 1)), homeGoals: i % 3, awayGoals: (i + 1) % 2, season: i < 18 ? '2024-2025' : '2025-2026' });
  }
  const optimized = model.optimizeTemporalWeights(matches, undefined, 'logLoss');
  assert.ok(optimized.best.currentSeasonDecay >= 0);
  assert.ok(optimized.folds.length > 0);
  const sortedMatches = [...matches].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const fold of optimized.folds) {
    assert.equal(fold.startDate.getTime(), sortedMatches[fold.trainMatches].date.getTime());
    assert.equal(fold.endDate.getTime(), sortedMatches[fold.trainMatches + fold.validationMatches - 1].date.getTime());
  }
});
