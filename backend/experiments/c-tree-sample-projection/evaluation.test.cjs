'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateGate, validatePlan, validatePrepared, projectInput, assertNumericEquivalent } = require('./evaluate.cjs');

function statistics() {
  return Object.fromEntries(['raw', 'calibrated', 'decision'].map(stage => [stage, {
    deltaCandidateMinusIncumbent: { logLoss: -.01, brier: -.01, eceTopLabel10Bins: 0 },
    pairedWeekly95PercentInterval: { intervals: { logLoss: { lower: -.02, upper: -.001 }, brier: { lower: -.02, upper: -.001 } } },
  }]));
}
function summary() {
  return { all: statistics(), byLeague: Object.fromEntries(['L1', 'L2', 'L3', 'L4', 'L5'].map(league => [league, statistics()])) };
}
const criterion = { minimumLeaguesWithBothLowerAtBothStages: 5 };

test('fixed gate passes only with both metrics at both stages in all five leagues', () => {
  const result = evaluateGate(summary(), criterion);
  assert.equal(result.passed, true);
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.productionAdoptionEligible, false);
  assert.equal(result.improvedLeagues.length, 5);
  assert.deepEqual(result.failedGates, []);
});
test('four improved leagues fail; equality is insufficient', () => {
  const input = summary();
  input.byLeague.L5.decision.deltaCandidateMinusIncumbent.brier = 0;
  const result = evaluateGate(input, criterion);
  assert.equal(result.passed, false);
  assert.deepEqual(result.improvedLeagues, ['L1', 'L2', 'L3', 'L4']);
  assert(result.failedGates.some(gate => gate.name === 'L5.decision.brier.strictly_lower'));
});
test('missing fifth league fails even when every observed league improves', () => {
  const input = summary(); delete input.byLeague.L5;
  assert(evaluateGate(input, criterion).failedGates.some(gate => gate.name === 'exactly_five_leagues'));
});
test('global primary metrics, ECE and strict paired interval gates are independently enforced', () => {
  const input = summary();
  input.all.calibrated.deltaCandidateMinusIncumbent.logLoss = 0;
  input.all.decision.deltaCandidateMinusIncumbent.eceTopLabel10Bins = .001;
  input.all.calibrated.pairedWeekly95PercentInterval.intervals.logLoss.upper = 0;
  input.all.decision.pairedWeekly95PercentInterval.intervals = null;
  const failures = evaluateGate(input, criterion).failedGates.map(gate => gate.name);
  assert(failures.includes('all.calibrated.logLoss.strictly_lower'));
  assert(failures.includes('all.decision.ece.not_worse'));
  assert(failures.includes('all.calibrated.logLoss.paired95_upper_below_zero'));
  assert(failures.includes('all.decision.brier.paired95_upper_below_zero'));
});
test('raw-stage improvement cannot substitute for calibrated/decision improvement', () => {
  const input = summary();
  input.all.raw.deltaCandidateMinusIncumbent.logLoss = -1;
  input.byLeague.L3.calibrated.deltaCandidateMinusIncumbent.logLoss = .01;
  assert.equal(evaluateGate(input, criterion).passed, false);
});
test('feature projection rejects missing, duplicate and non-finite values', () => {
  const artifact = { featureNames: ['x', 'y'], featureSchema: 'v1' };
  assert.deepEqual(projectInput({ featureNames: ['y', 'z', 'x'], features: [2, 9, 1] }, artifact).features, [1, 2]);
  assert.throws(() => projectInput({ featureNames: ['x'], features: [1] }, artifact), /Missing required feature/);
  assert.throws(() => projectInput({ featureNames: ['x', 'x', 'y'], features: [1, 1, 2] }, artifact));
  assert.throws(() => projectInput({ featureNames: ['x', 'y'], features: [1, NaN] }, artifact), /Non-finite/);
});
test('prepared model rejects stale calibration profiles and wrong plan identity before scoring', () => {
  assert.throws(() => validatePrepared({ experimentPlanHash: 'wrong' }, {}, 'expected', {}));
  const artifact = { experimentPlanHash: 'expected', diagnosticOnly: true, productionAdoptionEligible: false,
    independentEvidence: false, experimentIdentity: { parentArtifactHash: 'parent', planHash: 'expected' }, calibrationProfilesV2: {} };
  assert.throws(() => validatePrepared(artifact, {}, 'expected', { incumbentArtifactHash: 'parent' }), /stale profiles/);
});
test('prepared structure guard enforces weighted means and rejects unrelated edits', () => {
  const model = { scale_and_bias: [1, [0]], features_info: { float_features: [{ feature_index: 0, flat_feature_index: 0 }] },
    oblivious_trees: [{ splits: [{ split_type: 'FloatFeature', float_feature_index: 0, border: 1 }],
      leaf_values: [1, 3], leaf_weights: [1, 3] }, { splits: [], leaf_values: [.2], leaf_weights: [4] }] };
  const incumbent = { featureNames: ['home_sample', 'away_sample'], weight: .75, temperature: .8, trainingSplit: {},
    models: { home: structuredClone(model), away: structuredClone(model) },
    calibrationPredictions: [{ matchId: 'm', matrixA: [[1]], matrixC: [[1]], homeGoals: 0, awayGoals: 0 }], calibrationProfilesV2: {} };
  const plan = { incumbentArtifactHash: 'parent', trainingSplit: {}, intervention: { features: ['home_sample', 'away_sample'] } };
  const prepared = structuredClone(incumbent); delete prepared.calibrationProfilesV2;
  Object.assign(prepared, { experimentPlanHash: 'plan', diagnosticOnly: true, productionAdoptionEligible: false,
    independentEvidence: false, experimentIdentity: { planHash: 'plan', parentArtifactHash: 'parent' } });
  for (const side of ['home', 'away']) prepared.models[side].oblivious_trees[0].leaf_values = [2.5, 2.5];
  assert.equal(validatePrepared(prepared, incumbent, 'plan', plan).onlyModelLeafValuesChanged, true);
  const cases = [
    artifact => { artifact.models.home.oblivious_trees[0].leaf_values = [2, 2]; },
    artifact => { artifact.models.home.oblivious_trees[0].splits[0].border = 2; },
    artifact => { artifact.models.away.oblivious_trees[1].leaf_values[0] = .3; },
    artifact => { artifact.models.home.scale_and_bias = [2, [0]]; },
    artifact => { artifact.calibrationPredictions[0].homeGoals = 1; },
    artifact => { artifact.arbitraryMetadata = true; },
  ];
  for (const mutate of cases) {
    const invalid = structuredClone(prepared); mutate(invalid);
    assert.throws(() => validatePrepared(invalid, incumbent, 'plan', plan));
  }
});
test('numerical profile comparison checks all nested fields', () => {
  assertNumericEquivalent({ points: [{ x: .1 + 1e-14, y: .2 }], n: 3, label: 'A' }, { points: [{ x: .1, y: .2 }], n: 3, label: 'A' });
  assert.throws(() => assertNumericEquivalent({ points: [{ x: .101 }] }, { points: [{ x: .1 }] }));
  assert.throws(() => assertNumericEquivalent({ points: [] }, { points: [], extra: true }));
});
test('plan validation rejects weakened league or uncertainty requirements', () => {
  const plan = { protocol: 'c-tree-sample-projection-v1', productionAdoption: false,
    intervention: { maximumCandidates: 1, hyperparameterSearch: false, newTreeFits: 0, features: ['home_sample', 'away_sample'] },
    developmentCriterion: { minimumLeaguesWithBothLowerAtBothStages: 5, bothPrimaryMetricsLowerAtCalibratedAndDecision: true,
      overallTopLabelECENotWorseAtBothStages: true, overallPaired95IntervalsUpperBelowZeroAtBothStages: true },
    metrics: { intervals: { replications: 2000, seed: 20261108 } } };
  validatePlan(plan);
  const weak = structuredClone(plan); weak.developmentCriterion.minimumLeaguesWithBothLowerAtBothStages = 4;
  assert.throws(() => validatePlan(weak));
  const noIntervals = structuredClone(plan); noIntervals.developmentCriterion.overallPaired95IntervalsUpperBelowZeroAtBothStages = false;
  assert.throws(() => validatePlan(noIntervals));
});
