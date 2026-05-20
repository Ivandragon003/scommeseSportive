const test = require('node:test');
const assert = require('node:assert/strict');
const { ValueBettingEngine } = require('../dist/models/value/ValueBettingEngine.js');

test('adaptive tuning adjusts coherence and rank multiplier by category', () => {
  const engine = new ValueBettingEngine();
  const baseDiagnostics = engine.diagnoseSelection(
    { 'shots_total_over_23.5': 0.54 },
    { 'shots_total_over_23.5': 2.05 },
    'shots_total_over_23.5',
    { 'shots_total_over_23.5': 'Tiri Totali Over 23.5' }
  );

  assert.equal(baseDiagnostics.filterSettings.coherenceRatio, 0.55);
  assert.equal(baseDiagnostics.adaptiveRankMultiplier, 1);

  engine.setAdaptiveTuning({
    source: 'test',
    generatedAt: new Date().toISOString(),
    totalReviews: 12,
    categories: {
      shots: {
        evDelta: -0.006,
        coherenceDelta: -0.05,
        rankingMultiplier: 1.14,
        sampleSize: 12,
        rankingErrorRate: 30,
        filterRejectionRate: 20,
        confirmationRate: 50,
        wrongPickRate: 10,
      },
    },
  });

  const tunedDiagnostics = engine.diagnoseSelection(
    { 'shots_total_over_23.5': 0.54 },
    { 'shots_total_over_23.5': 2.05 },
    'shots_total_over_23.5',
    { 'shots_total_over_23.5': 'Tiri Totali Over 23.5' }
  );

  assert.equal(tunedDiagnostics.filterSettings.coherenceRatio, 0.5);
  assert.equal(tunedDiagnostics.adaptiveRankMultiplier, 1.14);
});

test('adaptive tuning can promote a specific selection family without affecting the opposite side', () => {
  const engine = new ValueBettingEngine();

  engine.setAdaptiveTuning({
    source: 'test',
    generatedAt: new Date().toISOString(),
    totalReviews: 8,
    categories: {},
    selectionFamilies: {
      shots_total_over: {
        evDelta: -0.004,
        coherenceDelta: -0.03,
        rankingMultiplier: 1.1,
        sampleSize: 8,
        rankingErrorRate: 25,
        filterRejectionRate: 25,
        confirmationRate: 50,
        wrongPickRate: 0,
      },
    },
  });

  const overDiagnostics = engine.diagnoseSelection(
    { 'shots_total_over_23.5': 0.54 },
    { 'shots_total_over_23.5': 2.05 },
    'shots_total_over_23.5',
    { 'shots_total_over_23.5': 'Tiri Totali Over 23.5' }
  );

  const underDiagnostics = engine.diagnoseSelection(
    { 'shots_total_under_23.5': 0.54 },
    { 'shots_total_under_23.5': 2.05 },
    'shots_total_under_23.5',
    { 'shots_total_under_23.5': 'Tiri Totali Under 23.5' }
  );

  assert.equal(overDiagnostics.selectionFamily, 'shots_total_over');
  assert.equal(overDiagnostics.filterSettings.coherenceRatio, 0.52);
  assert.equal(overDiagnostics.adaptiveRankMultiplier, 1.1);

  assert.equal(underDiagnostics.selectionFamily, 'shots_total_under');
  assert.equal(underDiagnostics.filterSettings.coherenceRatio, 0.55);
  assert.equal(underDiagnostics.adaptiveRankMultiplier, 1);
});

test('player prop selections are categorized and staked more prudently', () => {
  const engine = new ValueBettingEngine();
  const opportunities = engine.analyzeMarketsWithVigRemoval(
    {
      player_understat_player_10_shots_over_1_5: 0.64,
      player_understat_player_10_shots_under_1_5: 0.36,
      player_understat_player_10_sot_over_0_5: 0.52,
      player_understat_player_10_sot_under_0_5: 0.48,
    },
    {
      player_understat_player_10_shots_over_1_5: {
        selection: 'player_understat_player_10_shots_over_1_5',
        odds: 2.1,
        companions: [1.78],
      },
      player_understat_player_10_shots_under_1_5: {
        selection: 'player_understat_player_10_shots_under_1_5',
        odds: 1.78,
        companions: [2.1],
      },
      player_understat_player_10_sot_over_0_5: {
        selection: 'player_understat_player_10_sot_over_0_5',
        odds: 2.25,
        companions: [1.68],
      },
      player_understat_player_10_sot_under_0_5: {
        selection: 'player_understat_player_10_sot_under_0_5',
        odds: 1.68,
        companions: [2.25],
      },
    },
    {
      player_understat_player_10_shots_over_1_5: 'Lautaro Martinez Over 1.5 tiri',
      player_understat_player_10_sot_over_0_5: 'Lautaro Martinez Over 0.5 tiri in porta',
    },
    {
      richnessScore: 0.9,
      teamSampleSize: { home: 30, away: 30 },
      hasXg: true,
      hasPlayerData: true,
      hasRefereeData: true,
      analysisFactors: {
        shotsReliability: 0.9,
        disciplineReliability: 0.7,
        statSampleStrength: 0.9,
        competitiveness: 0.7,
      },
    }
  );

  const shots = opportunities.find((opp) => opp.selection === 'player_understat_player_10_shots_over_1_5');
  const sot = opportunities.find((opp) => opp.selection === 'player_understat_player_10_sot_over_0_5');
  assert.ok(shots);
  assert.ok(sot);
  assert.equal(engine.categorizeSelection(shots.selection), 'player_shots');
  assert.equal(engine.categorizeSelection(sot.selection), 'player_shots_ot');
  assert.ok(shots.suggestedStakePercent <= 1.5);
  assert.ok(sot.suggestedStakePercent <= 1.0);
  assert.ok(shots.uncertaintyFactor > 0);
});

test('ranking prioritizes edgeNoVig over raw EV when bookmaker margin changes the signal quality', () => {
  const engine = new ValueBettingEngine();
  const opportunities = engine.analyzeMarketsWithVigRemoval(
    {
      over15: 0.62,
      under15: 0.38,
      over25: 0.205,
      under25: 0.795,
    },
    {
      over15: { selection: 'over15', odds: 1.8, companions: [2.1] },
      under15: { selection: 'under15', odds: 2.1, companions: [1.8] },
      over25: { selection: 'over25', odds: 5.5, companions: [1.22] },
      under25: { selection: 'under25', odds: 1.22, companions: [5.5] },
    },
    {
      over15: 'Over 1.5',
      over25: 'Over 2.5',
    },
    { richnessScore: 0.86 }
  );

  assert.equal(opportunities[0].selection, 'over15');
  assert.ok(opportunities[0].edgeNoVig > opportunities.find((opp) => opp.selection === 'over25').edgeNoVig);
  assert.ok(Number.isFinite(opportunities[0].rankingScore));
});

test('high odds can pass with strong sporting context but keep a prudent stake', () => {
  const engine = new ValueBettingEngine();
  const opportunities = engine.analyzeMarketsWithVigRemoval(
    {
      homeWin: 0.18,
      draw: 0.17,
      awayWin: 0.65,
    },
    {
      homeWin: { selection: 'homeWin', odds: 9.5, companions: [6.0, 1.2] },
      draw: { selection: 'draw', odds: 6.0, companions: [9.5, 1.2] },
      awayWin: { selection: 'awayWin', odds: 1.2, companions: [9.5, 6.0] },
    },
    { homeWin: '1X2 - Vittoria Casa' },
    {
      richnessScore: 0.88,
      analysisFactors: {
        homeAdvantageIndex: 0.24,
        formDelta: 0.42,
        motivationDelta: 0.55,
        restDelta: 0.25,
        scheduleLoadDelta: 0.18,
        suspensionsDelta: 0.22,
        disciplinaryDelta: 0.08,
        atRiskPlayersDelta: 0.14,
        competitiveness: 0.92,
        statSampleStrength: 0.9,
        shotsReliability: 0.86,
        cornersReliability: 0.7,
        disciplineReliability: 0.74,
        notes: [],
      },
    }
  );

  const highOdds = opportunities.find((opp) => opp.selection === 'homeWin');
  assert.ok(highOdds, 'quota alta con contesto forte dovrebbe poter essere candidata');
  assert.ok(highOdds.bookmakerOdds > 8);
  assert.ok(highOdds.suggestedStakePercent < highOdds.kellyFraction);
  assert.ok(highOdds.uncertaintyFactor > 0);
  assert.ok(highOdds.riskPenalty > 0);
});

test('weak data increases uncertainty and reduces stake and ranking', () => {
  const engine = new ValueBettingEngine();
  const probabilities = { over25: 0.57, under25: 0.43 };
  const marketGroups = {
    over25: { selection: 'over25', odds: 2.15, companions: [1.78] },
    under25: { selection: 'under25', odds: 1.78, companions: [2.15] },
  };
  const names = { over25: 'Over 2.5' };

  const strong = engine.analyzeMarketsWithVigRemoval(probabilities, marketGroups, names, {
    richnessScore: 0.92,
    teamSampleSize: { home: 30, away: 30 },
    hasXg: true,
    hasPlayerData: true,
    hasRefereeData: true,
  }).find((opp) => opp.selection === 'over25');

  const weak = engine.analyzeMarketsWithVigRemoval(probabilities, marketGroups, names, {
    richnessScore: 0.28,
    teamSampleSize: { home: 6, away: 5 },
    hasXg: false,
    hasPlayerData: false,
    hasRefereeData: false,
  }).find((opp) => opp.selection === 'over25');

  assert.ok(strong);
  assert.ok(weak);
  assert.ok(weak.uncertaintyFactor > strong.uncertaintyFactor);
  assert.ok(weak.suggestedStakePercent < strong.suggestedStakePercent);
  assert.ok(weak.rankingScore < strong.rankingScore);
});

test('dynamic EV threshold is stricter when richnessScore is low', () => {
  const engine = new ValueBettingEngine();
  const probabilities = { over25: 0.522, under25: 0.478 };
  const marketGroups = {
    over25: { selection: 'over25', odds: 2.0, companions: [2.0] },
    under25: { selection: 'under25', odds: 2.0, companions: [2.0] },
  };

  const highRichness = engine.analyzeMarketsWithVigRemoval(probabilities, marketGroups, { over25: 'Over 2.5' }, {
    richnessScore: 0.92,
  });
  const lowRichness = engine.analyzeMarketsWithVigRemoval(probabilities, marketGroups, { over25: 'Over 2.5' }, {
    richnessScore: 0.25,
  });

  assert.ok(highRichness.some((opp) => opp.selection === 'over25'));
  assert.equal(lowRichness.some((opp) => opp.selection === 'over25'), false);
});

test('expected log growth prevents a very volatile high-EV price from automatically ranking first', () => {
  const engine = new ValueBettingEngine();
  const opportunities = engine.analyzeMarketsWithVigRemoval(
    {
      over25: 0.57,
      under25: 0.43,
      homeWin: 0.15,
      draw: 0.17,
      awayWin: 0.68,
    },
    {
      over25: { selection: 'over25', odds: 2.1, companions: [1.78] },
      under25: { selection: 'under25', odds: 1.78, companions: [2.1] },
      homeWin: { selection: 'homeWin', odds: 11.0, companions: [5.8, 1.22] },
      draw: { selection: 'draw', odds: 5.8, companions: [11.0, 1.22] },
      awayWin: { selection: 'awayWin', odds: 1.22, companions: [11.0, 5.8] },
    },
    {
      over25: 'Over 2.5',
      homeWin: '1X2 - Vittoria Casa',
    },
    {
      richnessScore: 0.9,
      analysisFactors: {
        homeAdvantageIndex: 0.22,
        formDelta: 0.36,
        motivationDelta: 0.5,
        restDelta: 0.15,
        scheduleLoadDelta: 0.1,
        suspensionsDelta: 0.1,
        disciplinaryDelta: 0,
        atRiskPlayersDelta: 0.04,
        competitiveness: 0.86,
        statSampleStrength: 0.88,
        shotsReliability: 0.86,
        cornersReliability: 0.7,
        disciplineReliability: 0.7,
        notes: [],
      },
    }
  );

  const highRisk = opportunities.find((opp) => opp.selection === 'homeWin');
  assert.ok(highRisk);
  assert.equal(opportunities[0].selection, 'over25');
  assert.ok(highRisk.expectedValue > opportunities[0].expectedValue);
  assert.ok(highRisk.riskPenalty > opportunities[0].riskPenalty);
  assert.ok(Number.isFinite(opportunities[0].logGrowth));
});

test('ranking weights support category-specific overrides with global fallback', () => {
  const engine = new ValueBettingEngine({
    rankingWeights: {
      global: {
        edgeNoVig: 0.5,
        edgeRaw: 0.01,
        ev: 0.12,
        kelly: 0.1,
        confidence: 0.05,
        logGrowth: 0.18,
        riskPenalty: 0.4,
        uncertainty: 0.2,
        contextStrength: 0.08,
      },
      byCategory: {
        yellow_cards: {
          riskPenalty: 0.8,
          uncertainty: 0.45,
        },
        exact_score: {
          riskPenalty: 1.1,
          uncertainty: 0.6,
          ev: 0.05,
        },
      },
    },
  });

  const fallback = engine.getRankingWeightsForCategory('goal_ou');
  const yellowCards = engine.getRankingWeightsForCategory('yellow_cards');
  const exactScore = engine.getRankingWeightsForCategory('exact_score');

  assert.equal(fallback.edgeNoVig, 0.5);
  assert.equal(fallback.logGrowth, 0.18);
  assert.equal(yellowCards.edgeNoVig, 0.5);
  assert.ok(yellowCards.riskPenalty > fallback.riskPenalty);
  assert.ok(exactScore.riskPenalty > yellowCards.riskPenalty);
  assert.ok(exactScore.ev < fallback.ev);
});

test('custom category ranking weights penalize speculative exact score markets more than goal markets', () => {
  const engine = new ValueBettingEngine({
    rankingWeights: {
      byCategory: {
        exact_score: {
          riskPenalty: 1.2,
          uncertainty: 0.7,
          ev: 0.04,
        },
      },
    },
  });

  const opportunities = engine.analyzeMarketsWithVigRemoval(
    {
      over25: 0.56,
      under25: 0.44,
      exact_2_1: 0.16,
      exact_other: 0.84,
    },
    {
      over25: { selection: 'over25', odds: 2.05, companions: [1.85] },
      under25: { selection: 'under25', odds: 1.85, companions: [2.05] },
      exact_2_1: { selection: 'exact_2_1', odds: 7.5, companions: [1.08] },
      exact_other: { selection: 'exact_other', odds: 1.08, companions: [7.5] },
    },
    {
      over25: 'Over 2.5',
      exact_2_1: 'Risultato esatto 2-1',
    },
    {
      richnessScore: 0.86,
      teamSampleSize: { home: 28, away: 29 },
      hasXg: true,
      hasPlayerData: true,
    }
  );

  const goal = opportunities.find((opp) => opp.selection === 'over25');
  const exact = opportunities.find((opp) => opp.selection === 'exact_2_1');
  assert.ok(goal);
  assert.ok(exact);
  assert.ok(exact.riskPenalty > goal.riskPenalty);
  assert.ok(exact.rankingScore < goal.rankingScore);
});

test('under cartellini usa soglia EV piu alta degli over cartellini', () => {
  const engine = new ValueBettingEngine();
  const opportunities = engine.analyzeMarketsWithVigRemoval(
    {
      'yellow_over_4.5': 0.62,
      'yellow_under_4.5': 0.62,
    },
    {
      'yellow_over_4.5': { selection: 'yellow_over_4.5', odds: 2.0, companions: [2.0] },
      'yellow_under_4.5': { selection: 'yellow_under_4.5', odds: 2.0, companions: [2.0] },
    },
    {
      'yellow_over_4.5': 'Gialli Over 4.5',
      'yellow_under_4.5': 'Gialli Under 4.5',
    },
    {
      richnessScore: 0.9,
      expectedCards: 3.2,
      hasRefereeData: true,
      analysisFactors: {
        disciplineReliability: 0.86,
        competitiveness: 0.45,
      },
    }
  );

  const over = opportunities.find((opp) => opp.selection === 'yellow_over_4.5');
  const under = opportunities.find((opp) => opp.selection === 'yellow_under_4.5');
  assert.ok(over);
  assert.ok(under);
  assert.ok(under.dynamicEvThreshold > over.dynamicEvThreshold);
  assert.ok(under.suggestedStakePercent < over.suggestedStakePercent);
});

test('under cartellini vicino alla linea viene scartato come fragile', () => {
  const engine = new ValueBettingEngine();
  const opportunities = engine.analyzeMarketsWithVigRemoval(
    {
      'yellow_under_4.5': 0.68,
      'yellow_over_4.5': 0.32,
      'yellow_under_5.5': 0.70,
      'yellow_over_5.5': 0.30,
    },
    {
      'yellow_under_4.5': { selection: 'yellow_under_4.5', odds: 1.7, companions: [2.2] },
      'yellow_over_4.5': { selection: 'yellow_over_4.5', odds: 2.2, companions: [1.7] },
      'yellow_under_5.5': { selection: 'yellow_under_5.5', odds: 1.62, companions: [2.35] },
      'yellow_over_5.5': { selection: 'yellow_over_5.5', odds: 2.35, companions: [1.62] },
    },
    {
      'yellow_under_4.5': 'Gialli Under 4.5',
      'yellow_under_5.5': 'Gialli Under 5.5',
    },
    {
      richnessScore: 0.9,
      expectedCardsByLine: {
        '4.5': 4.2,
        '5.5': 5.1,
      },
      hasRefereeData: true,
      analysisFactors: {
        disciplineReliability: 0.88,
        competitiveness: 0.42,
      },
    }
  );

  assert.equal(opportunities.some((opp) => opp.selection === 'yellow_under_4.5'), false);
  assert.equal(opportunities.some((opp) => opp.selection === 'yellow_under_5.5'), false);
});

test('under cartellini con margine ampio puo ancora passare ma con warning disciplinari sintetici', () => {
  const engine = new ValueBettingEngine();
  const opportunities = engine.analyzeMarketsWithVigRemoval(
    {
      'yellow_under_5.5': 0.72,
      'yellow_over_5.5': 0.28,
    },
    {
      'yellow_under_5.5': { selection: 'yellow_under_5.5', odds: 1.75, companions: [2.12] },
      'yellow_over_5.5': { selection: 'yellow_over_5.5', odds: 2.12, companions: [1.75] },
    },
    {
      'yellow_under_5.5': 'Gialli Under 5.5',
    },
    {
      richnessScore: 0.9,
      expectedCards: 4.1,
      hasRefereeData: true,
      analysisFactors: {
        disciplineReliability: 0.88,
        competitiveness: 0.4,
      },
    }
  );

  const under = opportunities.find((opp) => opp.selection === 'yellow_under_5.5');
  assert.ok(under);
  assert.equal(under.marketCategory, 'yellow_cards');
  assert.ok((under.dataWarnings ?? []).length === 0);
});

test('rischio disciplinare alto e arbitro severo penalizzano gli under cartellini', () => {
  const engine = new ValueBettingEngine();
  const opportunities = engine.analyzeMarketsWithVigRemoval(
    {
      'yellow_under_5.5': 0.74,
      'yellow_over_5.5': 0.26,
    },
    {
      'yellow_under_5.5': { selection: 'yellow_under_5.5', odds: 1.72, companions: [2.18] },
      'yellow_over_5.5': { selection: 'yellow_over_5.5', odds: 2.18, companions: [1.72] },
    },
    {
      'yellow_under_5.5': 'Gialli Under 5.5',
    },
    {
      richnessScore: 0.88,
      expectedCards: 4.2,
      hasRefereeData: true,
      refereeAvgYellow: 5.3,
      refereeAvgFouls: 28,
      refereeSampleSize: 18,
      leagueAvgYellow: 3.8,
      leagueAvgFouls: 22.4,
      analysisFactors: {
        disciplineReliability: 0.82,
        competitiveness: 0.88,
        disciplinaryDelta: 0.45,
        atRiskPlayersDelta: 0.55,
        scheduleLoadDelta: 0.45,
      },
    }
  );

  assert.equal(opportunities.some((opp) => opp.selection === 'yellow_under_5.5'), false);
});

test('assenza o campione basso arbitro abbassa confidence degli under cartellini', () => {
  const engine = new ValueBettingEngine();
  const opportunities = engine.analyzeMarketsWithVigRemoval(
    {
      'yellow_under_5.5': 0.76,
      'yellow_over_5.5': 0.24,
    },
    {
      'yellow_under_5.5': { selection: 'yellow_under_5.5', odds: 1.7, companions: [2.2] },
      'yellow_over_5.5': { selection: 'yellow_over_5.5', odds: 2.2, companions: [1.7] },
    },
    {
      'yellow_under_5.5': 'Gialli Under 5.5',
    },
    {
      richnessScore: 0.86,
      expectedCards: 4.0,
      hasRefereeData: false,
      refereeSampleSize: 0,
      analysisFactors: {
        disciplineReliability: 0.74,
        competitiveness: 0.44,
      },
    }
  );

  const under = opportunities.find((opp) => opp.selection === 'yellow_under_5.5');
  assert.ok(under);
  assert.notEqual(under.confidence, 'HIGH');
  assert.ok((under.dataWarnings ?? []).includes('missing_referee_data'));
});
