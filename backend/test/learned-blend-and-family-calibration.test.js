const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCalibrationToFlatProbabilities } = require('../dist/models/value/EnhancedMarketAnalysis.js');
const { ValueBettingEngine } = require('../dist/models/value/ValueBettingEngine.js');

test('calibrazione per famiglia: usa la curva della famiglia, fallback globale per le altre', () => {
  const engine = new ValueBettingEngine();
  const flat = { homeWin: 0.5, over25: 0.5 };
  const globalPoints = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const familyCurves = {
    goal_1x2: {
      points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.3 }, { x: 1, y: 1 }],
      nObservations: 5000,
    },
  };

  const out = applyCalibrationToFlatProbabilities(flat, globalPoints, 5000, engine, familyCurves);

  // over25 (goal_over): nessuna curva famiglia -> curva globale identita, resta 0.5
  assert.ok(Math.abs(out.over25 - 0.5) < 1e-9, `over25 atteso 0.5, trovato ${out.over25}`);
  // homeWin (goal_1x2): curva famiglia spinge 0.5 -> 0.3 (alpha-blended con raw)
  assert.ok(out.homeWin < 0.40, `homeWin atteso < 0.40, trovato ${out.homeWin}`);
  assert.ok(out.homeWin > 0.25, `homeWin atteso > 0.25, trovato ${out.homeWin}`);
});

test('calibrazione per famiglia: curva degenere (<2 punti) ricade sulla globale', () => {
  const engine = new ValueBettingEngine();
  const flat = { homeWin: 0.5 };
  const globalPoints = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const familyCurves = { goal_1x2: { points: [{ x: 0.5, y: 0.1 }], nObservations: 5000 } };

  const out = applyCalibrationToFlatProbabilities(flat, globalPoints, 5000, engine, familyCurves);
  assert.ok(Math.abs(out.homeWin - 0.5) < 1e-9);
});

test('peso di blending appreso: abbassa il peso modello rispetto alla sola euristica', () => {
  const engine = new ValueBettingEngine();
  const probabilities = { homeWin: 0.62 };
  const groups = engine.buildMarketGroups({ homeWin: 2.05, draw: 3.4, awayWin: 3.9 });
  const baseContext = {
    enableMarketBlending: true,
    richnessScore: 0.8,
    teamSampleSize: { home: 22, away: 22 },
  };

  const heuristicOnly = engine.analyzeMarketsWithVigRemoval(probabilities, groups, {}, baseContext);
  const withLearned = engine.analyzeMarketsWithVigRemoval(probabilities, groups, {}, {
    ...baseContext,
    learnedBlendWeights: { goal_1x2: { modelWeight: 0.40, sampleSize: 500 } },
  });

  assert.ok(heuristicOnly.length >= 1, 'lo scenario base deve produrre una opportunita');
  assert.ok(withLearned.length >= 1, 'lo scenario con peso appreso deve produrre una opportunita');
  assert.ok(
    withLearned[0].modelWeight < heuristicOnly[0].modelWeight,
    `il peso appreso basso deve ridurre modelWeight: ${heuristicOnly[0].modelWeight} -> ${withLearned[0].modelWeight}`
  );
});

test('peso di blending appreso: campione sotto soglia viene ignorato', () => {
  const engine = new ValueBettingEngine();
  const probabilities = { homeWin: 0.62 };
  const groups = engine.buildMarketGroups({ homeWin: 2.05, draw: 3.4, awayWin: 3.9 });
  const baseContext = {
    enableMarketBlending: true,
    richnessScore: 0.8,
    teamSampleSize: { home: 22, away: 22 },
  };

  const heuristicOnly = engine.analyzeMarketsWithVigRemoval(probabilities, groups, {}, baseContext);
  const withWeakLearned = engine.analyzeMarketsWithVigRemoval(probabilities, groups, {}, {
    ...baseContext,
    learnedBlendWeights: { goal_1x2: { modelWeight: 0.40, sampleSize: 5 } },
  });

  assert.ok(heuristicOnly.length >= 1 && withWeakLearned.length >= 1);
  assert.equal(withWeakLearned[0].modelWeight, heuristicOnly[0].modelWeight);
});
