'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePlan, validatePrepared, checkedWeights, rankFits, validateSelection, scaleModels, groupedRaw } = require('./evaluate.cjs');
const { evaluateGate } = require('../c-tree-sample-projection/evaluate.cjs');
const plan = require('../../../docs/performance/evidence/c-tree-weight-research-2026-11-08/plan.json');
const METHOD = plan.intervention.method;

function fixture() {
  const tree = { splits: [{ split_type: 'FloatFeature', float_feature_index: 0, border: 1 }], leaf_weights: [4, 0], leaf_values: [.25, 0] };
  const model = { features_info: { float_features: [{ feature_index: 0, flat_feature_index: 0 }] }, scale_and_bias: [1, [0]],
    oblivious_trees: Array.from({ length: 120 }, () => structuredClone(tree)) };
  const incumbent = { featureNames: ['x'], featureSchema: 'schema', weight: .75, temperature: .8,
    trainedThrough: plan.trainingSplit.train.availableThrough, trainerHash: 'original-trainer', trainingSplit: plan.trainingSplit,
    models: { home: structuredClone(model), away: structuredClone(model) },
    calibrationPredictions: [{ matchId: 'm', matrixA: [[1]], matrixC: [[1]], homeGoals: 0, awayGoals: 0 }], calibrationProfilesV2: {} };
  const weights = [.5, .75, 1.25, 1.5, 0, 2];
  const artifact = structuredClone(incumbent); delete artifact.calibrationProfilesV2;
  Object.assign(artifact, { experimentPlanHash: 'plan', diagnosticOnly: true, productionAdoptionEligible: false,
    productionValidated: false, independentEvidence: false, trainerHash: 'new-trainer', parentTrainerHash: 'original-trainer',
    trainedThrough: plan.parameterDevelopment.originalSelection.availableThrough,
    parameterAdaptation: { method: METHOD, weights },
    experimentIdentity: { planHash: 'plan', parentArtifactHash: plan.incumbentArtifactHash, method: METHOD },
    models: scaleModels(incumbent.models, weights, plan.intervention.treeBlocks) });
  return { incumbent, artifact, weights };
}
test('six bounded side/block weights scale all original leaves and preserve zeros', () => {
  const { incumbent, artifact, weights } = fixture();
  const checked = validatePrepared(artifact, incumbent, 'plan', plan, 'new-trainer', weights);
  assert.equal(checked.onlyWholeTreeScalarWeightsChanged, true);
  assert.equal(checked.originalEmptyLeavesRemainZero, true);
  assert.equal(artifact.models.home.oblivious_trees[39].leaf_values[0], .125);
  assert.equal(artifact.models.home.oblivious_trees[40].leaf_values[0], .1875);
  assert.equal(artifact.models.away.oblivious_trees[80].leaf_values[0], .5);
});
test('identity group inference reproduces the original tree contributions', () => {
  const { incumbent } = fixture();
  const identity = scaleModels(incumbent.models, [1, 1, 1, 1, 1, 1], plan.intervention.treeBlocks);
  assert.deepEqual(identity, incumbent.models);
  assert.equal(groupedRaw(identity.home, [0], [1, 1, 1], plan.intervention.treeBlocks), 30);
  assert.equal(groupedRaw(identity.home, [2], [1, 1, 1], plan.intervention.treeBlocks), 0);
});
test('model guard rejects wrong blocks, newly filled zeros and changed supports', () => {
  const { incumbent, artifact, weights } = fixture();
  for (const mutate of [
    candidate => { candidate.models.home.oblivious_trees[40].leaf_values[0] = .125; },
    candidate => { candidate.models.away.oblivious_trees[0].leaf_values[1] = .01; },
    candidate => { candidate.models.home.oblivious_trees[0].leaf_weights[0] = 5; },
    candidate => { candidate.models.home.oblivious_trees[0].splits[0].border = 2; },
    candidate => { candidate.models.away.scale_and_bias[0] = 2; },
    candidate => { candidate.calibrationPredictions[0].awayGoals = 1; },
    candidate => { candidate.calibrationProfilesV2 = {}; },
  ]) {
    const invalid = structuredClone(artifact); mutate(invalid);
    assert.throws(() => validatePrepared(invalid, incumbent, 'plan', plan, 'new-trainer', weights));
  }
});
test('lineage guard records consumed selection rows and actual parameter trainer', () => {
  const { incumbent, artifact, weights } = fixture();
  for (const mutate of [
    candidate => { candidate.trainedThrough = incumbent.trainedThrough; },
    candidate => { candidate.parentTrainerHash = 'different-parent'; },
    candidate => { candidate.trainerHash = incumbent.trainerHash; },
    candidate => { candidate.parameterAdaptation.weights[0] = 1.9; },
    candidate => { candidate.experimentPlanHash = 'other'; },
    candidate => { candidate.parameterAdaptation.method = 'other'; },
  ]) {
    const invalid = structuredClone(artifact); mutate(invalid);
    assert.throws(() => validatePrepared(invalid, incumbent, 'plan', plan, 'new-trainer', weights));
  }
});
test('bounds do not admit negative, excessive, missing or non-finite weights', () => {
  assert.deepEqual(checkedWeights([0, 1, 2, 1, 1, 1]), [0, 1, 2, 1, 1, 1]);
  for (const weights of [[1], [-.1, 1, 1, 1, 1, 1], [2.1, 1, 1, 1, 1, 1], [NaN, 1, 1, 1, 1, 1]]) assert.throws(() => checkedWeights(weights));
});
function selectionFixture() {
  const identity = { weights: [1, 1, 1, 1, 1, 1], validationMetrics: { logLoss: 1, brier: .6 } };
  const fits = plan.intervention.ridgeGrid.map((ridge, index) => ({ ridge, converged: true, optimizer: { success: true },
    weights: [.9, 1, 1, 1, 1, 1], validationMetrics: { logLoss: .99 - index * .01, brier: .59 } }));
  return { planHash: 'plan', identity, fits, decision: { acceptedNonIdentity: true, selectedFitIndex: 3, selectedRidge: .01,
    frozenAt: '2026-11-08T12:00:00Z' }, finalFit: { converged: true, optimizer: { success: true }, weights: [.9, 1, 1, 1, 1, 1], frozenAt: '2026-11-08T12:01:00Z' } };
}
test('selection requires convergence and both fixed validation metric conditions', () => {
  const record = selectionFixture();
  assert.equal(validateSelection(record, plan, 'plan').ridge, .01);
  record.fits[3].converged = false;
  record.fits[2].validationMetrics.brier = .61;
  assert.equal(rankFits(record.fits, record.identity.validationMetrics).ridge, 1);
});
test('within fixed tolerance a higher ridge wins; insufficient LL improvement is excluded', () => {
  const identity = { logLoss: 1, brier: .6 };
  const low = { ridge: .1, converged: true, validationMetrics: { logLoss: .9, brier: .59 } };
  const high = { ridge: 10, converged: true, validationMetrics: { logLoss: .9 + 5e-13, brier: .59 } };
  assert.equal(rankFits([low, high], identity).ridge, 10);
  assert.equal(rankFits([{ ...low, validationMetrics: { logLoss: 1 - 5e-13, brier: .59 } }], identity), null);
});
test('ridge ties are measured from the global minimum, without chained near-ties', () => {
  const fits = [10, 1, .1].map((ridge, index) => ({ ridge, converged: true,
    validationMetrics: { logLoss: .9 - index * 7e-13, brier: .59 } }));
  assert.equal(rankFits(fits, { logLoss: 1, brier: .6 }).ridge, 1);
  assert.equal(rankFits([...fits].reverse(), { logLoss: 1, brier: .6 }).ridge, 1);
});
test('identity/no-artifact and unsuccessful final refit stop evaluation', () => {
  const identity = selectionFixture();
  identity.fits.forEach(fit => { fit.validationMetrics.logLoss = 1; });
  identity.decision = { acceptedNonIdentity: false, selectedFitIndex: null, selectedRidge: null, frozenAt: '2026-11-08T12:00:00Z' };
  identity.finalFit = null;
  assert.throws(() => validateSelection(identity, plan, 'plan'), /no652 scoring/);
  const invalid = selectionFixture(); invalid.finalFit.converged = false;
  assert.throws(() => validateSelection(invalid, plan, 'plan'), /must converge/);
});
test('selection guard rejects changed chosen index, ridge and chronology', () => {
  for (const mutate of [
    record => { record.decision.selectedFitIndex = 0; },
    record => { record.decision.selectedRidge = 10; },
    record => { record.finalFit.frozenAt = '2026-11-08T11:59:00Z'; },
    record => { record.fits.reverse(); },
  ]) {
    const record = selectionFixture(); mutate(record);
    assert.throws(() => validateSelection(record, plan, 'plan'));
  }
});
test('frozen plan and original five-league diagnostic criterion remain strict', () => {
  validatePlan(plan);
  const invalid = structuredClone(plan); invalid.intervention.ridgeGrid.push(.001);
  assert.throws(() => validatePlan(invalid));
  const stats = () => Object.fromEntries(['raw', 'calibrated', 'decision'].map(stage => [stage, {
    deltaCandidateMinusIncumbent: { logLoss: -.01, brier: -.01, eceTopLabel10Bins: 0 },
    pairedWeekly95PercentInterval: { intervals: { logLoss: { lower: -.02, upper: -.001 }, brier: { lower: -.02, upper: -.001 } } },
  }]));
  const summary = { all: stats(), byLeague: Object.fromEntries(['L1', 'L2', 'L3', 'L4', 'L5'].map(league => [league, stats()])) };
  assert.equal(evaluateGate(summary, plan.developmentCriterion).passed, true);
  summary.byLeague.L5.calibrated.deltaCandidateMinusIncumbent.brier = 0;
  assert.equal(evaluateGate(summary, plan.developmentCriterion).passed, false);
});
