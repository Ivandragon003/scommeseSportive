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
