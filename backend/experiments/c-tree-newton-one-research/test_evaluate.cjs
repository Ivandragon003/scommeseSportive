'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { validatePlan, validateParameters, validateDevelopmentDecision } = require('./evaluate.cjs');
const plan = require('../../../docs/performance/evidence/c-tree-newton-one-research-2026-11-08/plan.json');
function models() {
  const old = { features_info: {}, model_info: { params: { tree_learner_options: { leaf_estimation_iterations: 10,
    leaf_estimation_backtracking: 'AnyImprovement', l2_leaf_reg: 3 }, flat_params: { random_seed: 20261027 },
    cat_feature_params: { ctr_leaf_count_limit: 18446744073709552000 } } }, oblivious_trees: Array.from({ length: 120 }, () => ({})) };
  const current = structuredClone(old); current.model_info.params.tree_learner_options.leaf_estimation_iterations = 1;
  Object.assign(current.model_info.params.flat_params, { leaf_estimation_iterations: 1, l2_leaf_reg: 3 }); return [old, current];
}
test('fixed protocol preserves one variant and the full comparison', () => { validatePlan(plan); const bad = structuredClone(plan); bad.parameterDevelopment.noSelectionGate = false; assert.throws(() => validatePlan(bad)); });
test('Newton iterations alone may change; backtracking stays configured', () => { const [a, b] = models(); validateParameters(a, b); assert.equal(a.model_info.params.tree_learner_options.leaf_estimation_iterations, 10); });
test('other effective recipe, iteration and modality changes fail', () => {
  for (const mutate of [m => { m.model_info.params.flat_params.random_seed = 1; }, m => { m.model_info.params.tree_learner_options.leaf_estimation_iterations = 2; }, m => { m.model_info.params.tree_learner_options.leaf_estimation_backtracking = 'No'; }, m => { m.features_info.categorical_features = [{}]; }]) {
    const [a, b] = models(); mutate(b); assert.throws(() => validateParameters(a, b));
  }
});
test('negative development results still require the diagnostic', () => {
  for (const passed of [false, true]) assert.equal(validateDevelopmentDecision({ variantFixedBeforeOutcomes: true,
    variant: 'newton_one_step', developmentFiveLeagueCriterionPassed: passed, fullDiagnosticRequired: true }), true);
});
test('a development-based stop or changed variant is rejected', () => {
  assert.throws(() => validateDevelopmentDecision({ variantFixedBeforeOutcomes: true, variant: 'newton_one_step', developmentFiveLeagueCriterionPassed: false, fullDiagnosticRequired: false }));
  assert.throws(() => validateDevelopmentDecision({ variantFixedBeforeOutcomes: true, variant: 'other', developmentFiveLeagueCriterionPassed: true, fullDiagnosticRequired: true }));
});
