'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ancestorReplacement, validatePrepared, validatePlan } = require('./evaluate.cjs');
const { evaluateGate } = require('../c-tree-sample-projection/evaluate.cjs');
const METHOD = 'nearest-supported-prefix-ancestor-original-training-weighted-mean-v1';

function tree(weights, values) {
  const depth = Math.log2(weights.length);
  return { splits: Array.from({ length: depth }, (_, index) => ({ split_type: 'FloatFeature', float_feature_index: index, border: 1 })),
    leaf_weights: weights, leaf_values: values };
}
test('nearest ancestor drops highest bits, preserving original split prefix', () => {
  const original = tree([1, 0, 3, 0], [2, 0, 8, 0]);
  // Both odd-index leaves have an empty one-bit prefix. The root mean is 6.5;
  // dropping bit zero first would incorrectly choose a single supported sibling.
  for (const leaf of [1, 3]) assert.deepEqual(ancestorReplacement(original, leaf),
    { value: 6.5, prefixLength: 0, prefixBits: 0, support: 4, leaves: [0, 1, 2, 3] });
});
test('backoff stops at first supported prefix and weights original contributions', () => {
  const original = tree([2, 0, 0, 1, 6, 0, 0, 0], [1, 0, 0, 9, 5, 0, 0, 0]);
  assert.deepEqual(ancestorReplacement(original, 2),
    { value: 4, prefixLength: 1, prefixBits: 0, support: 8, leaves: [0, 2, 4, 6] });
  assert.deepEqual(ancestorReplacement(original, 7),
    { value: 9, prefixLength: 2, prefixBits: 3, support: 1, leaves: [3, 7] });
  assert.deepEqual(original.leaf_values, [1, 0, 0, 9, 5, 0, 0, 0]);
});
test('no unsupported or nonzero-empty leaf may be silently used', () => {
  assert.throws(() => ancestorReplacement(tree([1, 1], [2, 3]), 0), /unsupported/);
  assert.throws(() => ancestorReplacement(tree([1, 0], [2, 3]), 1), /must be zero/);
  assert.throws(() => ancestorReplacement(tree([0, 0], [0, 0]), 1), /No supported ancestor/);
});

function fixture() {
  const model = { scale_and_bias: [1, [0]], features_info: { float_features: [{ feature_index: 0, flat_feature_index: 0 },
    { feature_index: 1, flat_feature_index: 1 }] }, oblivious_trees: [tree([1, 0, 3, 0], [2, 0, 8, 0])] };
  const incumbent = { featureNames: ['x', 'y'], weight: .75, temperature: .8, trainingSplit: {},
    models: { home: structuredClone(model), away: structuredClone(model) },
    calibrationPredictions: [{ matchId: 'm', matrixA: [[1]], matrixC: [[1]], homeGoals: 0, awayGoals: 0 }], calibrationProfilesV2: {} };
  const artifact = structuredClone(incumbent); delete artifact.calibrationProfilesV2;
  Object.assign(artifact, { experimentPlanHash: 'plan', diagnosticOnly: true, productionAdoptionEligible: false,
    productionValidated: false, independentEvidence: false,
    experimentIdentity: { planHash: 'plan', parentArtifactHash: 'parent', method: METHOD } });
  for (const side of ['home', 'away']) artifact.models[side].oblivious_trees[0].leaf_values = [2, 6.5, 8, 6.5];
  return { incumbent, artifact, plan: { incumbentArtifactHash: 'parent', trainingSplit: {}, originalAudit: { homeEmptyLeaves: 2, awayEmptyLeaves: 2 } } };
}
test('prepared guard accepts only original-support prefix backoff', () => {
  const { incumbent, artifact, plan } = fixture();
  const checked = validatePrepared(artifact, incumbent, 'plan', plan);
  assert.equal(checked.onlyOriginallyEmptyLeavesChanged, true);
  assert.deepEqual(checked.bySide.home, { emptyLeaves: 2, changedLeaves: 2 });
  const invalid = structuredClone(artifact); invalid.models.home.oblivious_trees[0].leaf_values[1] = 2;
  assert.throws(() => validatePrepared(invalid, incumbent, 'plan', plan), /nearest-supported-prefix/);
});
test('prepared guard rejects supported leaves, support counts, tree routing and scale edits', () => {
  const { incumbent, artifact, plan } = fixture();
  const mutations = [
    candidate => { candidate.models.home.oblivious_trees[0].leaf_values[0] = 3; },
    candidate => { candidate.models.home.oblivious_trees[0].leaf_weights[1] = 1; },
    candidate => { candidate.models.home.oblivious_trees[0].splits.reverse(); },
    candidate => { candidate.models.away.scale_and_bias[0] = 2; },
    candidate => { candidate.calibrationPredictions[0].homeGoals = 1; },
    candidate => { candidate.arbitraryMetadata = true; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(artifact); mutate(invalid);
    assert.throws(() => validatePrepared(invalid, incumbent, 'plan', plan));
  }
});
test('prepared guard rejects stale profile and wrong artifact identity', () => {
  const { incumbent, artifact, plan } = fixture();
  for (const mutate of [
    candidate => { candidate.calibrationProfilesV2 = {}; },
    candidate => { candidate.experimentPlanHash = 'other'; },
    candidate => { candidate.experimentIdentity.parentArtifactHash = 'other'; },
    candidate => { candidate.experimentIdentity.method = 'different-method'; },
    candidate => { candidate.productionAdoptionEligible = true; },
  ]) {
    const invalid = structuredClone(artifact); mutate(invalid);
    assert.throws(() => validatePrepared(invalid, incumbent, 'plan', plan));
  }
});

const frozenPlan = require('../../../docs/performance/evidence/c-tree-empty-leaf-backoff-2026-11-08/plan.json');
test('plan accepts frozen protocol and rejects changed intervention or relaxed criterion', () => {
  validatePlan(frozenPlan);
  for (const mutate of [
    plan => { plan.protocol = 'c-tree-sample-projection-v1'; },
    plan => { plan.intervention.minimumSupport = 2; },
    plan => { plan.intervention.preserveSupportedLeafValuesExactly = false; },
    plan => { plan.intervention.newTreeFits = 1; },
    plan => { plan.developmentCriterion.minimumLeaguesWithBothLowerAtBothStages = 4; },
    plan => { plan.developmentCriterion.overallPaired95IntervalsUpperBelowZeroAtBothStages = false; },
    plan => { plan.metrics.intervals.seed++; },
  ]) {
    const invalid = structuredClone(frozenPlan); mutate(invalid);
    assert.throws(() => validatePlan(invalid));
  }
});
test('shared immutable gate still requires five leagues and strict global uncertainty', () => {
  const stats = () => Object.fromEntries(['raw', 'calibrated', 'decision'].map(stage => [stage, {
    deltaCandidateMinusIncumbent: { logLoss: -.01, brier: -.01, eceTopLabel10Bins: 0 },
    pairedWeekly95PercentInterval: { intervals: { logLoss: { lower: -.02, upper: -.001 }, brier: { lower: -.02, upper: -.001 } } },
  }]));
  const summary = { all: stats(), byLeague: Object.fromEntries(['L1', 'L2', 'L3', 'L4', 'L5'].map(league => [league, stats()])) };
  assert.equal(evaluateGate(summary, frozenPlan.developmentCriterion).passed, true);
  summary.byLeague.L5.calibrated.deltaCandidateMinusIncumbent.brier = 0;
  summary.all.decision.pairedWeekly95PercentInterval.intervals.logLoss.upper = 0;
  const result = evaluateGate(summary, frozenPlan.developmentCriterion);
  assert.equal(result.passed, false);
  assert.equal(result.productionAdoptionEligible, false);
  assert.equal(result.improvedLeagues.length, 4);
  assert(result.failedGates.some(gate => gate.name === 'all.decision.logLoss.paired95_upper_below_zero'));
});
