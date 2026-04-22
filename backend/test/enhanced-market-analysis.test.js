const test = require('node:test');
const assert = require('node:assert/strict');
const { ValueBettingEngine } = require('../dist/models/value/ValueBettingEngine.js');
const {
  analyzeMarketsEnhanced,
  applyCalibrationToFlatProbabilities,
} = require('../dist/models/value/EnhancedMarketAnalysis.js');

test('Enhanced market analysis keeps stable value logic after removing the temporary Fixes name', () => {
  const engine = new ValueBettingEngine();
  const flatProbabilities = {
    homeWin: 0.56,
    draw: 0.24,
    awayWin: 0.20,
    over25: 0.58,
    under25: 0.42,
    shotsOver235: 0.55,
    yellowOver45: 0.54,
  };
  const marketGroups = engine.buildMarketGroups({
    homeWin: 2.15,
    draw: 3.55,
    awayWin: 4.45,
    over25: 2.08,
    under25: 1.84,
    shotsOver235: 2.02,
    yellowOver45: 2.01,
  });
  const marketNames = {
    homeWin: '1',
    draw: 'X',
    awayWin: '2',
    over25: 'Over 2.5',
    under25: 'Under 2.5',
    shotsOver235: 'Tiri Totali Over 23.5',
    yellowOver45: 'Cartellini Over 4.5',
  };

  const calibrated = applyCalibrationToFlatProbabilities(
    flatProbabilities,
    [{ x: 0.5, y: 0.52 }, { x: 0.65, y: 0.63 }],
    80,
    engine
  );
  assert.ok(calibrated.homeWin > 0 && calibrated.homeWin < 1);

  const result = analyzeMarketsEnhanced({
    flatProbabilities,
    marketGroups,
    marketNames,
    matchId: 'match-1',
    richnessScore: 0.71,
    calibrationPoints: [{ x: 0.5, y: 0.52 }, { x: 0.65, y: 0.63 }],
    nCalibrationObs: 80,
    engine,
  });

  assert.ok(result.allBets.length > 0);
  assert.equal(new Set(result.allBets.map((bet) => `${bet.selection}:${bet.marketName}`)).size, result.allBets.length);
  assert.ok(result.coreBets.length >= 1);
});
