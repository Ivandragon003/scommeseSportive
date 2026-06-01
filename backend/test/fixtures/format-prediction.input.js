// Representative prediction object exercising every branch of formatPrediction:
// goal probs, cards (negBinParams + overUnderYellow + overUnderTotal), fouls,
// corners, home/away shots (with and without precomputed distribution), player
// shots, value/speculative opportunities, combo bets with legs, and a
// bestValueOpportunity with factorBreakdown. Used by the golden-master test.
module.exports = {
  matchId: 'm_123',
  competition: 'Serie A',
  homeTeam: 'Inter',
  awayTeam: 'Milan',
  computedAt: '2026-05-01T12:00:00.000Z',
  modelConfidence: 0.7123,
  richnessScore: 0.6555,
  riskAdjustedBestScore: 0.4444,
  probabilities: {
    homeWin: 0.512345, draw: 0.241111, awayWin: 0.246544,
    btts: 0.55, over05: 0.93, over15: 0.74, over25: 0.49, over35: 0.27, over45: 0.13,
    under15: 0.26, under25: 0.51, under35: 0.73, under45: 0.87,
    lambdaHome: 1.63421, lambdaAway: 1.21887,
    exactScore: { '1-0': 0.11, '2-1': 0.09 },
    handicap: { home_minus1: 0.33 },
    asianHandicap: { home_minus0_5: 0.51 },
    shotsTotal: { '23.5': { over: 0.481234, under: 0.518766 }, '25.5': { over: 0.371, under: 0.629 } },
    cards: {
      expectedTotalYellow: 4.321, expectedHomeYellow: 2.111, expectedAwayYellow: 2.21,
      expectedHomeRed: 0.05, expectedAwayRed: 0.04, expectedTotalCards: 4.41,
      negBinParams: { r: 12.4 },
      overUnderYellow: { '3.5': { over: 0.611, under: 0.389 }, '4.5': { over: 0.402, under: 0.598 } },
      overUnderTotal: { '3.5': { over: 0.7 }, '4.5': { over: 0.5 }, '5.5': { over: 0.31 }, '6.5': { over: 0.17 } },
    },
    fouls: {
      expectedTotalFouls: 22.5, expectedHomeFouls: 11.1, expectedAwayFouls: 11.4,
      negBinParams: { r: 13.2 },
      overUnder: { '21.5': { over: 0.55, under: 0.45 } },
    },
    corners: {
      expectedTotalCorners: 9.6, expectedHomeCorners: 5.2, expectedAwayCorners: 4.4,
      overUnder: { '8.5': { over: 0.61, under: 0.39 } },
    },
    shotsHome: {
      expected: 13.2,
      totalShots: { expected: 13.2, variance: 9.1, distribution: { 10: 0.2, 13: 0.3, 16: 0.2 } },
      shotsOnTarget: { expected: 4.8, variance: 3.2 },
    },
    shotsAway: {
      expected: 10.7,
      totalShots: { expected: 10.7, variance: 8.4 },
      shotsOnTarget: { expected: 3.9, variance: 2.7 },
    },
    playerShots: {
      home: [
        { playerId: 'p1', playerName: 'Lautaro', teamId: 'inter', positionCode: 'FW',
          expectedShots: 3.4, expectedShotsOnTarget: 1.6, prob1PlusShots: 0.92,
          prob2PlusShots: 0.71, prob3PlusShots: 0.45, prob1PlusShotsOT: 0.74, sampleSize: 20 },
      ],
      away: [
        { name: 'Leao', expectedShots: 2.8, expectedShotsOnTarget: 1.2, prob1PlusShots: 0.85, sampleSize: 18 },
      ],
    },
  },
  valueOpportunities: [
    { marketName: '1X2', selection: 'home', bookmakerOdds: 2.05, ourProbability: 0.5123,
      impliedProbability: 0.4878, expectedValue: 0.0501, edge: 0.0245, kellyFraction: 0.031, suggestedStakePercent: 1.4 },
    { marketName: 'OU', selection: 'over25', bookmakerOdds: 1.1, ourProbability: NaN }, // filtered out
  ],
  speculativeOpportunities: [
    { marketName: 'cards', selection: 'over45', bookmakerOdds: 2.4, ourProbability: 0.41,
      impliedProbability: 0.4167, expectedValue: -0.016, edge: -0.006, kellyFraction: 0, suggestedStakePercent: 0 },
  ],
  comboBets: [
    { combinedOdds: 3.21, combinedProbability: 0.3456, combinedEV: 0.108, kellyFraction: 0.0512, suggestedStakePercent: 2.1,
      legs: [
        { selection: 'home', ourProbability: 0.51, impliedProbability: 0.48, expectedValue: 0.05, kellyFraction: 0.03, suggestedStakePercent: 1.2 },
        { selection: 'over15', ourProbability: 0.74, impliedProbability: 0.7, expectedValue: 0.04, kellyFraction: 0.02, suggestedStakePercent: 0.9 },
      ] },
    { combinedOdds: 5.0, legs: [{ selection: 'solo' }] }, // filtered out (1 leg)
  ],
  bestValueOpportunity: {
    marketName: '1X2', selection: 'home', bookmakerOdds: 2.05,
    expectedValue: 0.0501, edge: 0.0245, edgeNoVig: 0.0211, score: 0.7311,
    factorBreakdown: { baseModelScore: 0.5123, contextualScore: 0.2188, totalScore: 0.7311 },
    reasons: ['edge positivo', 'forma casa'],
  },
  bestBetStatus: 'PLAYABLE',
  bestBetReason: 'valore solido su 1X2',
  bestBetDecision: 'PLACE',
  bestBetAlternatives: [{ selection: 'over15', score: 0.61 }],
  playerPropWarnings: ['campione ridotto per Leao'],
  analysisFactors: { competitiveness: 0.62, formHome: 0.7 },
};
