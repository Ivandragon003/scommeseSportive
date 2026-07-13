const test = require('node:test');
const assert = require('node:assert/strict');
const { learnBlendWeights, noVigProbability } = require('../dist/services/MarketBlendLearningService.js');

function buildSamples({ category, modelProb, marketProb, winRate, count }) {
  const winners = Math.round(count * winRate);
  return Array.from({ length: count }, (_, i) => ({
    category,
    modelProb,
    marketProbNoVig: marketProb,
    outcome: i < winners ? 1 : 0,
  }));
}

test('learnBlendWeights: mercato perfetto e modello biased -> peso modello al minimo', () => {
  // Il mercato dice 0.50 e ha ragione (50% di vittorie), il modello dice 0.70.
  const samples = buildSamples({ category: 'goal_1x2', modelProb: 0.70, marketProb: 0.50, winRate: 0.50, count: 200 });
  const learned = learnBlendWeights(samples, { minSamples: 100 });

  assert.ok(learned.goal_1x2, 'la categoria deve essere appresa');
  assert.ok(learned.goal_1x2.modelWeight <= 0.42, `atteso peso ~0.40, trovato ${learned.goal_1x2.modelWeight}`);
  assert.ok(learned.goal_1x2.logLossLearned < learned.goal_1x2.logLossModelOnly);
  assert.equal(learned.goal_1x2.sampleSize, 200);
});

test('learnBlendWeights: modello perfetto e mercato biased -> peso modello al massimo', () => {
  const samples = buildSamples({ category: 'goal_over', modelProb: 0.70, marketProb: 0.50, winRate: 0.70, count: 200 });
  const learned = learnBlendWeights(samples, { minSamples: 100 });

  assert.ok(learned.goal_over);
  assert.ok(learned.goal_over.modelWeight >= 0.82, `atteso peso ~0.84, trovato ${learned.goal_over.modelWeight}`);
});

test('learnBlendWeights: campione insufficiente -> nessun peso appreso', () => {
  const samples = buildSamples({ category: 'btts_yes', modelProb: 0.6, marketProb: 0.5, winRate: 0.5, count: 30 });
  const learned = learnBlendWeights(samples, { minSamples: 100 });
  assert.equal(Object.keys(learned).length, 0);
});

test('learnBlendWeights: scarta campioni con probabilita non valide', () => {
  const valid = buildSamples({ category: 'goal_1x2', modelProb: 0.6, marketProb: 0.5, winRate: 0.5, count: 120 });
  const invalid = [
    { category: 'goal_1x2', modelProb: 0, marketProbNoVig: 0.5, outcome: 1 },
    { category: 'goal_1x2', modelProb: 1.2, marketProbNoVig: 0.5, outcome: 0 },
    { category: 'goal_1x2', modelProb: 0.6, marketProbNoVig: Number.NaN, outcome: 1 },
    { category: '', modelProb: 0.6, marketProbNoVig: 0.5, outcome: 1 },
  ];
  const learned = learnBlendWeights([...valid, ...invalid], { minSamples: 100 });
  assert.equal(learned.goal_1x2.sampleSize, 120);
});

test('noVigProbability: coppia 2-way simmetrica -> 0.5', () => {
  const p = noVigProbability(2.0, [2.0]);
  assert.ok(Math.abs(p - 0.5) < 1e-9);
});

test('noVigProbability: trio 1X2 normalizzato', () => {
  const p = noVigProbability(2.4, [3.2, 3.4]);
  // 1/2.4 / (1/2.4 + 1/3.2 + 1/3.4) ~ 0.4072
  assert.ok(Math.abs(p - 0.4072) < 0.001, `trovato ${p}`);
});

test('noVigProbability: senza companion -> null', () => {
  assert.equal(noVigProbability(2.0, []), null);
  assert.equal(noVigProbability(2.0, [1.0]), null);
  assert.equal(noVigProbability(1.0, [2.0]), null);
});
