"""Fixed Newton-one comparison checks; no real model fitting or outcome scoring."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

SPEC = importlib.util.spec_from_file_location('newton_one_prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)
PLAN = prepare.ROOT / 'docs/performance/evidence/c-tree-newton-one-research-2026-11-08/plan.json'


def original_model():
    return {'features_info': {'float_features': []}, 'model_info': {'params': {
        'tree_learner_options': {'leaf_estimation_iterations': 10, 'leaf_estimation_method': 'Newton',
                                 'leaf_estimation_backtracking': 'AnyImprovement', 'l2_leaf_reg': 3, 'depth': 5},
        'cat_feature_params': {'ctr_leaf_count_limit': 18446744073709552000},
        'flat_params': {'loss_function': 'Poisson'}, 'random_seed': 20261027}}}


def candidate_model():
    candidate = original_model()
    p = candidate['model_info']['params']
    p['tree_learner_options']['leaf_estimation_iterations'] = 1
    p['flat_params'].update({'leaf_estimation_iterations': 1, 'l2_leaf_reg': 3.})
    p['cat_feature_params']['ctr_leaf_count_limit'] = 18446744073709551615
    return candidate


def score(ll=1., brier=.6):
    return {'logLoss': ll, 'brier': brier, 'n': 317,
            'byLeague': {f'league{i}': {'logLoss': ll, 'brier': brier, 'n': 50} for i in range(5)}}


class NewtonOneTests(unittest.TestCase):
    def test_only_leaf_iterations_change_and_inactive_backtracking_is_documented(self):
        original, candidate = original_model(), candidate_model()
        before = copy.deepcopy(candidate)
        receipt = prepare.newton_parameter_guard(original, candidate)
        self.assertEqual(candidate, before)
        self.assertEqual(receipt['leafEstimationIterations'], 1)
        self.assertEqual(receipt['backtrackingConfigured'], 'AnyImprovement')
        self.assertFalse(receipt['backtrackingActive'])

    def test_other_changes_wrong_budget_or_changed_backtracking_are_rejected(self):
        for key, value in [('leaf_estimation_iterations', 2), ('leaf_estimation_method', 'Gradient'),
                           ('leaf_estimation_backtracking', 'No'), ('l2_leaf_reg', 10), ('depth', 6)]:
            candidate = candidate_model()
            candidate['model_info']['params']['tree_learner_options'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                prepare.newton_parameter_guard(original_model(), candidate)
        candidate = candidate_model()
        candidate['model_info']['params']['flat_params'].pop('leaf_estimation_iterations')
        with self.assertRaisesRegex(ValueError, 'explicit_single_leaf_iteration_required'):
            prepare.newton_parameter_guard(original_model(), candidate)
        candidate = candidate_model()
        candidate['model_info']['params']['random_seed'] += 1
        with self.assertRaisesRegex(ValueError, 'effective_parameters_changed_beyond_l2'):
            prepare.newton_parameter_guard(original_model(), candidate)

    def test_only_exact_inactive_counter_pair_and_no_categoricals_are_allowed(self):
        candidate = candidate_model()
        candidate['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] -= 1
        with self.assertRaisesRegex(ValueError, 'undocumented_categorical_counter_change'):
            prepare.newton_parameter_guard(original_model(), candidate)
        candidate = candidate_model()
        candidate['features_info']['categorical_features'] = [{'feature_index': 0}]
        with self.assertRaisesRegex(ValueError, 'categorical_features_forbid_metadata_normalization'):
            prepare.newton_parameter_guard(original_model(), candidate)

    def test_worse_development_never_suppresses_the_user_fixed_full_comparison(self):
        decision = prepare.development_decision(score(1.2, .8), score())
        self.assertFalse(decision['developmentFiveLeagueCriterionPassed'])
        self.assertTrue(decision['variantFixedBeforeOutcomes'])
        self.assertTrue(decision['fullDiagnosticRequired'])
        self.assertNotIn('acceptedNonIdentity', decision)
        self.assertNotIn('selectedVariant', decision)
        self.assertNotIn('identityFallback', decision)
        self.assertTrue(prepare.development_decision(score(.9, .5), score())['developmentFiveLeagueCriterionPassed'])

    def test_artifact_and358_calibration_are_completed_even_when_development_is_worse(self):
        base = np.ones((2, 2)) / 4
        calibration = [{'matchId': f'cal{i}', 'baselineMatrix': base.tolist(), 'homeGoals': i % 3, 'awayGoals': (i + 1) % 3}
                       for i in range(358)]
        predictions = [{'matchId': row['matchId'], 'matrixA': base.tolist(), 'matrixC': base.tolist(),
                        'homeGoals': row['homeGoals'], 'awayGoals': row['awayGoals'], 'metadata': {'unchanged': i}}
                       for i, row in enumerate(calibration)]
        incumbent = {'trainerHash': 'parent', 'trainedThrough': '2025-08-31T21:30:00Z', 'candidateKind': 'calibrated_ensemble',
                     'hyperparameters': {'iterations': 120}, 'trainingSplit': {'sentinel': 'base partitions'},
                     'calibrationProfilesV2': {'stale': True}, 'calibrationPredictions': predictions,
                     'featureNames': ['same40'], 'models': {'old': True}}
        before = copy.deepcopy(incumbent)
        development = {'fit': {'n': 5293}, 'development': {'n': 317},
                       'decision': prepare.development_decision(score(1.2, .8), score())}
        exported = {'home': {'new': True}, 'away': {'new': True}}
        ml = np.array([[.6, .1], [.1, .2]])
        with patch.object(prepare.train, 'raw_matrices', return_value=[ml] * 358) as raw:
            candidate = prepare.complete_fixed_artifact(incumbent, exported, calibration, {},
                {'createdAt': '2026-11-08T00:00:00Z'}, development, 'development-hash', {'fixed': True}, '2026-11-08T01:00:00Z')
        self.assertEqual(raw.call_count, 1)
        self.assertEqual(len(candidate['calibrationPredictions']), 358)
        self.assertEqual(candidate['trainedThrough'], incumbent['trainedThrough'])
        self.assertEqual(candidate['trainingSplit'], incumbent['trainingSplit'])
        self.assertEqual(candidate['featureNames'], incumbent['featureNames'])
        self.assertNotIn('calibrationProfilesV2', candidate)
        self.assertNotIn('parameterSelection', candidate)
        self.assertFalse(candidate['parameterExperiment']['developmentFiveLeagueCriterionPassed'])
        self.assertTrue(candidate['parameterExperiment']['fullComparisonRegardlessOfDevelopment'])
        self.assertTrue(candidate['diagnosticOnly'])
        self.assertFalse(candidate['productionAdoptionEligible'])
        for original, changed in zip(predictions, candidate['calibrationPredictions']):
            self.assertEqual({key: value for key, value in original.items() if key != 'matrixC'},
                             {key: value for key, value in changed.items() if key != 'matrixC'})
            self.assertNotEqual(original['matrixC'], changed['matrixC'])
        self.assertEqual(incumbent, before)
        candidate['models']['home']['new'] = False
        self.assertTrue(exported['home']['new'])

    def test_frozen_recipe_pool40_order_and_train_labels_no_offset_or_eval_set(self):
        plan = json.loads(PLAN.read_bytes())
        recipe = plan['intervention']['recipe']
        self.assertEqual(recipe['leaf_estimation_iterations'], 1)
        self.assertNotIn('leaf_estimation_backtracking', recipe)
        rows = [{'features': [float(i)] * 40, 'homeGoals': home, 'awayGoals': away} for i, home, away in [(2, 3, 1), (1, 0, 2)]]
        names = [f'f{i}' for i in range(40)]
        constructors, pools, fits = [], [], []
        def pool(x, **kwargs):
            pools.append((x.copy(), kwargs))
            return len(pools)
        class Model:
            def __init__(self, **kwargs):
                constructors.append(kwargs)
            def fit(self, *args, **kwargs):
                fits.append((args, kwargs))
        def export(native, path):
            path.write_text('{}', encoding='utf-8')
            return {}
        with tempfile.TemporaryDirectory() as folder, patch.object(prepare.l2, 'Pool', side_effect=pool), \
                patch.object(prepare.l2, 'CatBoostRegressor', Model), patch.object(prepare.train, 'export_model', side_effect=export):
            prepare.fit_pair(rows, names, recipe, 3., Path(folder), 'newton-one')
        self.assertEqual(constructors, [recipe | {'l2_leaf_reg': 3.}] * 2)
        np.testing.assert_array_equal(pools[0][0], [[2.] * 40, [1.] * 40])
        np.testing.assert_array_equal(pools[0][1]['label'], [3., 0.])
        self.assertEqual(set(pools[0][1]), {'label', 'feature_names'})
        self.assertEqual(fits, [((1,), {}), ((2,), {})])

    def test_membership_retains_order_and_hash_without_mutating_rows(self):
        rows = [{'matchId': 'b', 'availableAt': '2025-01-02T00:00:00Z'}, {'matchId': 'a', 'availableAt': '2025-01-01T00:00:00Z'}]
        before = copy.deepcopy(rows)
        a, b = prepare.membership(rows), prepare.membership(rows[::-1])
        self.assertEqual(a['matchIdsHash'], b['matchIdsHash'])
        self.assertNotEqual(a['orderedMatchIdsHash'], b['orderedMatchIdsHash'])
        self.assertEqual(rows, before)

    def test_real_frozen_plan_startup_and_exclusive_output_without_any_fit(self):
        class StopBeforeTraining(Exception):
            pass
        with tempfile.TemporaryDirectory() as folder, patch.object(prepare, 'check_sources'), \
                patch.object(prepare.current, 'current_manifest', return_value={}), \
                patch.object(prepare.current, 'prepare_dataset', side_effect=StopBeforeTraining) as data, \
                patch.object(prepare, 'fit_pair') as fit:
            with self.assertRaisesRegex(ValueError, 'exclusive_new_output_required'):
                prepare.run(PLAN, folder)
            output = Path(folder) / 'new'
            with self.assertRaises(StopBeforeTraining):
                prepare.run(PLAN, output)
            data.assert_called_once()
            fit.assert_not_called()
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
