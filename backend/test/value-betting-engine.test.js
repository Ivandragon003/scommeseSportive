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
