const test = require('node:test');
const assert = require('node:assert/strict');
const { PredictionService } = require('../dist/services/PredictionService.js');

test('statistical market can become final recommended pick when data reliability is strong', () => {
  const service = new PredictionService({});

  const opportunities = [
    {
      marketName: '1X2 - Vittoria Casa',
      selection: 'homeWin',
      marketCategory: 'goal_1x2',
      marketTier: 'CORE',
      ourProbability: 56,
      bookmakerOdds: 1.92,
      impliedProbability: 52.08,
      impliedProbabilityNoVig: 50.5,
      expectedValue: 7.52,
      kellyFraction: 1.9,
      suggestedStakePercent: 1.1,
      confidence: 'HIGH',
      isValueBet: true,
      edge: 3.92,
      edgeNoVig: 5.5,
      adaptiveRankMultiplier: 1,
    },
    {
      marketName: 'Tiri Totali Over 23.5',
      selection: 'shots_total_over_23.5',
      marketCategory: 'shots',
      marketTier: 'SECONDARY',
      ourProbability: 61,
      bookmakerOdds: 2.16,
      impliedProbability: 46.3,
      impliedProbabilityNoVig: 45.7,
      expectedValue: 11.1,
      kellyFraction: 4.4,
      suggestedStakePercent: 1.8,
      confidence: 'HIGH',
      isValueBet: true,
      edge: 14.7,
      edgeNoVig: 15.3,
      adaptiveRankMultiplier: 1,
    },
  ];

  const factors = {
    homeAdvantageIndex: 0.12,
    formDelta: 0.26,
    motivationDelta: 0.18,
    restDelta: 0.05,
    scheduleLoadDelta: 0,
    suspensionsDelta: 0,
    disciplinaryDelta: 0.04,
    atRiskPlayersDelta: 0,
    competitiveness: 0.52,
    statSampleStrength: 0.92,
    shotsReliability: 0.93,
    cornersReliability: 0.9,
    disciplineReliability: 0.72,
    notes: [],
  };

  const best = service.computeBestValueOpportunity(opportunities, factors);

  assert.ok(best);
  assert.equal(best.selection, 'shots_total_over_23.5');
  assert.equal(best.marketTier, 'SECONDARY');
});
