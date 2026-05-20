const test = require('node:test');
const assert = require('node:assert/strict');
const { BacktestingEngine } = require('../dist/models/backtesting/BacktestingEngine.js');

function buildMatches() {
  const strengths = { A: 1.95, B: 1.5, C: 1.12, D: 0.82 };
  const fixtures = [
    ['A', 'B'], ['C', 'D'],
    ['A', 'C'], ['B', 'D'],
    ['A', 'D'], ['B', 'C'],
    ['B', 'A'], ['D', 'C'],
    ['C', 'A'], ['D', 'B'],
    ['D', 'A'], ['C', 'B'],
  ];

  const matches = [];
  let index = 0;
  for (let cycle = 0; cycle < 4; cycle++) {
    for (const [home, away] of fixtures) {
      const homeStrength = strengths[home];
      const awayStrength = strengths[away];
      const homeXG = Math.max(0.5, homeStrength + 0.2 - awayStrength * 0.3 + ((index + cycle) % 3 - 1) * 0.05);
      const awayXG = Math.max(0.25, awayStrength - 0.16 - homeStrength * 0.18 + ((index + cycle) % 2 ? 0.05 : -0.04));
      const homeGoals = Math.max(0, Math.round(homeXG + ((index + cycle) % 2 ? 0.12 : -0.08)));
      const awayGoals = Math.max(0, Math.round(awayXG + ((index + cycle) % 3 === 0 ? 0.1 : -0.1)));

      matches.push({
        matchId: `bt-${cycle}-${index}`,
        homeTeamId: home,
        awayTeamId: away,
        date: new Date(Date.UTC(2025, 1, 1 + index + cycle * fixtures.length)),
        homeGoals,
        awayGoals,
        homeXG: Number(homeXG.toFixed(2)),
        awayXG: Number(awayXG.toFixed(2)),
        homeShotsOnTarget: Math.max(1, Math.round(homeXG * 2.3)),
        awayShotsOnTarget: Math.max(1, Math.round(awayXG * 2.1)),
        homeTotalShots: Math.max(4, Math.round(homeXG * 7.6)),
        awayTotalShots: Math.max(3, Math.round(awayXG * 7.1)),
        homeFouls: 10 + (index % 6),
        awayFouls: 11 + ((index + 2) % 5),
        homeYellowCards: 1 + (index % 4),
        awayYellowCards: 1 + ((index + 1) % 4),
        competition: 'Serie A',
        season: '2025-2026',
      });
      index += 1;
    }
  }

  return matches;
}

function buildHistoricalOdds(matches) {
  const odds = {};
  const context = {};

  for (const [index, match] of matches.entries()) {
    odds[match.matchId] = {
      homeWin: index % 2 === 0 ? 2.3 : 2.0,
      draw: 3.45,
      awayWin: index % 2 === 0 ? 4.1 : 3.75,
      over25: 2.14,
      under25: 1.81,
      btts: 2.08,
      bttsNo: 1.83,
      shotsOver235: 2.04,
      yellowOver45: 2.01,
      foulsOver235: 2.0,
    };
    context[match.matchId] = {
      oddsSource: 'eurobet_scraper',
      snapshotSource: 'eurobet',
      capturedAt: new Date(Date.UTC(2025, 1, 1 + index)).toISOString(),
      closingOdds: Object.fromEntries(
        Object.entries(odds[match.matchId]).map(([selection, value]) => [selection, Number((value * 0.95).toFixed(2))])
      ),
      closingCapturedAt: new Date(Date.UTC(2025, 1, 1 + index, 18)).toISOString(),
      closingSource: 'eurobet_scraper',
    };
  }

  return { odds, context };
}

function runOfficialWalkForward(engine, matches, odds, context, options = {}) {
  return engine.runWalkForwardBacktest(matches, odds, {
    initialTrainMatches: 30,
    testWindowMatches: 8,
    stepMatches: 5,
    maxFolds: 3,
    confidenceLevel: 'medium_and_above',
    ...options,
  }, context);
}

test('BacktestingEngine exposes only walk-forward as official validation flow', () => {
  const engine = new BacktestingEngine();
  assert.equal(typeof engine.runBacktest, 'undefined');
  assert.equal(typeof engine.runWalkForwardBacktest, 'function');
});

test('BacktestingEngine walk-forward keeps bet-level outputs and calibration available after model refactor', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds, context } = buildHistoricalOdds(matches);

  const result = runOfficialWalkForward(engine, matches, odds, context);

  assert.ok(result.totalMatches === matches.length);
  assert.ok(result.totalFolds > 0);
  assert.ok(result.folds.every((fold) => fold.trainMatches > 0));
  assert.ok(result.folds.every((fold) => fold.testMatches > 0));
  assert.ok(Array.isArray(result.detailedBets));
  assert.ok(result.summary.totalBetsPlaced >= 0);
  assert.equal(result.detailedBets.length, result.summary.totalBetsPlaced);
});

test('BacktestingEngine walk-forward computes CLV from Eurobet closing odds', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds, context } = buildHistoricalOdds(matches);

  const result = runOfficialWalkForward(engine, matches, odds, context);

  assert.ok(result.summary.totalBetsPlaced > 0);
  assert.equal(result.detailedBets.every((bet) => bet.clvMissingReason === null), true);
  assert.ok(result.folds.some((fold) => typeof fold.averageClv === 'number' && fold.averageClv > 0));
  assert.ok(result.folds.some((fold) => typeof fold.positiveClvRate === 'number' && fold.positiveClvRate > 0));

  const betWithClv = result.detailedBets.find((bet) => typeof bet.clv === 'number');
  assert.ok(betWithClv);
  assert.equal(
    Number(betWithClv.clv.toFixed(6)),
    Number((betWithClv.odds / betWithClv.closingOdds - 1).toFixed(6))
  );
  assert.equal(betWithClv.clvMissingReason, null);
});

test('BacktestingEngine walk-forward marks CLV as missing without falsifying metrics when closing odds are unavailable', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds } = buildHistoricalOdds(matches);

  const contextWithoutClosing = Object.fromEntries(
    Object.keys(odds).map((matchId) => [matchId, {
      oddsSource: 'eurobet_scraper',
      snapshotSource: 'eurobet',
      capturedAt: '2025-02-01T12:00:00.000Z',
    }])
  );

  const result = runOfficialWalkForward(engine, matches, odds, contextWithoutClosing);

  assert.ok(result.summary.totalBetsPlaced > 0);
  assert.equal(result.folds.every((fold) => fold.averageClv === null), true);
  assert.equal(result.folds.every((fold) => fold.positiveClvRate === null), true);
  assert.equal(result.detailedBets.every((bet) => bet.clv === null), true);
  assert.equal(result.detailedBets.every((bet) => bet.clvMissingReason === 'missing_closing_odds'), true);
});

test('BacktestingEngine walk-forward uses the live vig-removal value betting path with analysis context', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds, context } = buildHistoricalOdds(matches);
  let usedCurrentPath = false;

  engine.engine.analyzeMarkets = () => {
    throw new Error('legacy analyzeMarkets should not be used by current backtest');
  };
  const original = engine.engine.analyzeMarketsWithVigRemoval.bind(engine.engine);
  engine.engine.analyzeMarketsWithVigRemoval = (probabilities, marketGroups, marketNames, analysisContext) => {
    usedCurrentPath = true;
    assert.ok(analysisContext);
    assert.ok(Number.isFinite(Number(analysisContext.richnessScore)));
    assert.ok(analysisContext.analysisFactors);
    return original(probabilities, marketGroups, marketNames, analysisContext);
  };

  const result = runOfficialWalkForward(engine, matches, odds, context);

  assert.equal(usedCurrentPath, true);
  assert.ok(result.summary.totalBetsPlaced >= 0);
});

test('BacktestingEngine walk-forward separates real Eurobet odds and synthetic odds metrics', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds, context } = buildHistoricalOdds(matches);

  for (const [index, match] of matches.entries()) {
    if (index % 2 === 1) {
      delete odds[match.matchId];
      delete context[match.matchId];
    }
  }

  const result = runOfficialWalkForward(engine, matches, odds, context);

  const realBets = result.detailedBets.filter((bet) => bet.isRealEurobetOdds);
  const syntheticBets = result.detailedBets.filter((bet) => bet.isSynthetic);
  assert.ok(result.summary.totalBetsPlaced > 0);
  assert.equal(realBets.length + syntheticBets.length, result.summary.totalBetsPlaced);
  assert.ok(result.folds.every((fold) => typeof fold.betsWithRealEurobetOdds === 'number'));
  assert.ok(result.folds.every((fold) => typeof fold.betsWithSyntheticOdds === 'number'));
});

test('BacktestingEngine walk-forward rejects Eurobet closing snapshots captured after kickoff', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds, context } = buildHistoricalOdds(matches);

  for (const match of matches) {
    context[match.matchId] = {
      ...context[match.matchId],
      closingCapturedAt: new Date(match.date.getTime() + 60 * 60 * 1000).toISOString(),
    };
  }

  const result = runOfficialWalkForward(engine, matches, odds, context);

  assert.ok(result.summary.totalBetsPlaced > 0);
  assert.equal(result.folds.every((fold) => fold.averageClv === null), true);
  assert.equal(result.detailedBets.every((bet) => bet.clv === null), true);
  assert.equal(
    result.detailedBets.every((bet) => bet.clvMissingReason === 'snapshot_after_kickoff_rejected'),
    true
  );
});

test('BacktestingEngine walk-forward can compare baseline and current value betting algorithms', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds, context } = buildHistoricalOdds(matches);

  const result = runOfficialWalkForward(engine, matches, odds, context, { compareBaseline: true });

  assert.ok(result.totalFolds > 0);
  assert.equal(result.folds.every((fold) => typeof fold.baselineRoi === 'number'), true);
  assert.equal(result.folds.every((fold) => typeof fold.currentRoi === 'number'), true);
  assert.ok(Object.prototype.hasOwnProperty.call(result.summary, 'currentBeatsBaselineFolds'));
  assert.ok(Object.prototype.hasOwnProperty.call(result.summary, 'baselineBeatsCurrentFolds'));
});

test('BacktestingEngine walk-forward records algorithm version metadata on result and detailed bets', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds, context } = buildHistoricalOdds(matches);

  const result = runOfficialWalkForward(engine, matches, odds, context);

  assert.equal(result.algorithmVersion, 'value-engine-v4');
  assert.equal(result.rankingVersion, 'ranking-edge-novig-loggrowth-v2');
  assert.equal(result.backtestEngineVersion, 'backtest-engine-v4');
  assert.ok(result.detailedBets.length > 0);
  assert.equal(result.detailedBets.every((bet) => bet.algorithmVersion === result.algorithmVersion), true);
  assert.equal(result.detailedBets.every((bet) => bet.rankingVersion === result.rankingVersion), true);
  assert.equal(result.detailedBets.every((bet) => bet.backtestEngineVersion === result.backtestEngineVersion), true);
});

test('BacktestingEngine walk-forward enriches bet details with historical context diagnostics without future leakage', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds, context } = buildHistoricalOdds(matches);

  const result = runOfficialWalkForward(engine, matches, odds, context);
  const firstBet = result.detailedBets[0];

  assert.ok(firstBet);
  assert.equal(firstBet.historicalContextUsed, true);
  assert.ok(Number.isFinite(firstBet.contextCompletenessScore));
  assert.ok(firstBet.contextCompletenessScore >= 0);
  assert.ok(firstBet.contextCompletenessScore <= 1);
  assert.ok(Array.isArray(firstBet.contextWarnings));
});

test('BacktestingEngine walk-forward exposes fold stability and algorithm metadata', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds, context } = buildHistoricalOdds(matches);

  const result = engine.runWalkForwardBacktest(matches, odds, {
    initialTrainMatches: 30,
    testWindowMatches: 8,
    stepMatches: 5,
    maxFolds: 3,
    compareBaseline: true,
  }, context);

  assert.ok(result.totalFolds > 0);
  assert.equal(result.algorithmVersion, 'value-engine-v4');
  assert.equal(result.rankingVersion, 'ranking-edge-novig-loggrowth-v2');
  assert.ok(Number.isFinite(result.summary.roiVariance));
  assert.ok(Object.prototype.hasOwnProperty.call(result.summary, 'currentBeatsBaselineFolds'));
  assert.ok(Object.prototype.hasOwnProperty.call(result.summary, 'baselineBeatsCurrentFolds'));
  assert.equal(result.folds.every((fold) => fold.algorithmVersion === result.algorithmVersion), true);
  assert.equal(result.folds.every((fold) => typeof fold.averageClv !== 'undefined'), true);
  assert.equal(result.folds.every((fold) => typeof fold.betsWithRealEurobetOdds === 'number'), true);
});

test('BacktestingEngine ranking weight search penalizes low-real-odds overfit candidates', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds, context } = buildHistoricalOdds(matches);
  const sparseOdds = {};
  const sparseContext = {};
  for (const [index, match] of matches.entries()) {
    if (index < 3) {
      sparseOdds[match.matchId] = odds[match.matchId];
      sparseContext[match.matchId] = context[match.matchId];
    }
  }

  const result = engine.runRankingWeightSearch(matches, sparseOdds, {
    minBetsPerFold: 5,
    minRealEurobetBets: 30,
    maxFolds: 3,
  }, sparseContext);

  assert.ok(result.bestWeights);
  assert.ok(result.testedWeights.length >= 2);
  assert.equal(result.overfittingRisk, 'HIGH');
  assert.ok(result.overfittingWarnings.some((warning) => /quote Eurobet reali/i.test(warning)));
  assert.ok(result.comparison.currentResult);
  assert.ok(result.comparison.tunedResult);
});

test('card line learning classifies half-card under misses as low severity', () => {
  const engine = new BacktestingEngine();

  const under55 = engine.assessCardLineLearning({
    selection: 'yellow_under_5.5',
    actualCards: 6,
    clv: null,
    wasRecommendedTooCloseToLine: false,
  });
  const under45 = engine.assessCardLineLearning({
    selection: 'yellow_under_4.5',
    actualCards: 5,
    clv: null,
    wasRecommendedTooCloseToLine: false,
  });
  const underHighMiss = engine.assessCardLineLearning({
    selection: 'yellow_under_5.5',
    actualCards: 8,
    clv: null,
    wasRecommendedTooCloseToLine: false,
  });

  assert.equal(under55.cardLineError, 0.5);
  assert.equal(under55.cardMissSeverity, 'LOW');
  assert.equal(under45.cardLineError, 0.5);
  assert.equal(under45.cardMissSeverity, 'LOW');
  assert.equal(underHighMiss.cardMissSeverity, 'HIGH');
});

test('card line learning weighs CLV and close-to-line under mistakes', () => {
  const engine = new BacktestingEngine();

  const positiveClv = engine.assessCardLineLearning({
    selection: 'yellow_under_5.5',
    actualCards: 6,
    clv: 0.04,
    wasRecommendedTooCloseToLine: false,
  });
  const negativeClv = engine.assessCardLineLearning({
    selection: 'yellow_under_5.5',
    actualCards: 6,
    clv: -0.04,
    wasRecommendedTooCloseToLine: false,
  });
  const closeToLine = engine.assessCardLineLearning({
    selection: 'yellow_under_5.5',
    actualCards: 6,
    clv: -0.04,
    wasRecommendedTooCloseToLine: true,
  });

  assert.equal(positiveClv.outcomeVsMarketAssessment, 'good_process_bad_result');
  assert.ok(positiveClv.cardLearningAdjustment < negativeClv.cardLearningAdjustment);
  assert.ok(closeToLine.cardLearningAdjustment > negativeClv.cardLearningAdjustment);
});
