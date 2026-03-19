const test = require('node:test');
const assert = require('node:assert/strict');
const { PredictionService } = require('../dist/services/PredictionService.js');

test('completed match review flags ranking error when a winning value bet was already available', () => {
  const service = new PredictionService({});

  const prediction = {
    probabilities: {
      flatProbabilities: {
        homeWin: 0.52,
        draw: 0.26,
        awayWin: 0.22,
      },
    },
    valueOpportunities: [
      {
        marketName: 'Esito Finale',
        selection: 'homeWin',
        marketCategory: 'goal_1x2',
        marketTier: 'CORE',
        adaptiveRankMultiplier: 1,
        ourProbability: 52,
        bookmakerOdds: 2.2,
        impliedProbability: 45.45,
        impliedProbabilityNoVig: 45.45,
        expectedValue: 14.4,
        kellyFraction: 1.5,
        suggestedStakePercent: 1,
        confidence: 'HIGH',
        isValueBet: true,
        edge: 6.55,
        edgeNoVig: 6.55,
      },
    ],
    bestValueOpportunity: {
      selection: 'draw',
      selectionLabel: 'Pareggio (X)',
      marketName: 'Esito Finale',
      marketTier: 'CORE',
      bookmakerOdds: 3.1,
      expectedValue: 5,
      edge: 2,
      confidence: 'MEDIUM',
      score: 0.63,
      humanSummary: 'Test summary',
      humanReasons: [],
      reasons: [],
      factorBreakdown: { baseModelScore: 0.5, contextualScore: 0.13, totalScore: 0.63 },
    },
  };

  const matchRow = {
    home_goals: 2,
    away_goals: 0,
  };

  const review = service.buildCompletedMatchLearningReview(prediction, matchRow, {
    homeWin: 2.2,
    draw: 3.1,
    awayWin: 3.8,
  });

  assert.equal(review.reviewType, 'ranking_error');
  assert.equal(review.missedWinningSelection.selection, 'homeWin');
  assert.equal(review.missedWinningSelection.wasAlreadyValueBet, true);
});
