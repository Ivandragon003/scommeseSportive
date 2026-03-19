const test = require('node:test');
const assert = require('node:assert/strict');
const { ValueBettingEngine } = require('../dist/models/ValueBettingEngine.js');

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
