"""Control, native-recipe and five-league gates without any real model training."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

SPEC = importlib.util.spec_from_file_location('l2_prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def model():
    return {'features_info': {'float_features': []}, 'oblivious_trees': [{'leaf_values': [1.], 'leaf_weights': [2], 'splits': []}],
            'scale_and_bias': [1., [0.]], 'model_info': {'params': {'tree_learner_options': {'l2_leaf_reg': 3, 'depth': 5},
                                                               'cat_feature_params': {'ctr_leaf_count_limit': 18446744073709552000},
                                                               'flat_params': {'loss_function': 'Poisson'}, 'random_seed': 20261027}}}


def explicit_model(l2):
    value = model()
    value['model_info']['params']['tree_learner_options']['l2_leaf_reg'] = l2
    value['model_info']['params']['flat_params']['l2_leaf_reg'] = l2
    value['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] = 18446744073709551615
    return value


def score(ll=1., brier=.6):
    return {'logLoss': ll, 'brier': brier, 'n': 317,
            'byLeague': {f'league{i}': {'logLoss': ll, 'brier': brier, 'n': 50} for i in range(5)}}


class L2Tests(unittest.TestCase):
    def test_gate_requires_both_metrics_globally_and_in_every_league(self):
        baseline = score()
        fit = {'l2LeafReg': 10., 'validationMetrics': score(.9, .5)}
        self.assertTrue(prepare.choose_fit([fit], baseline)['acceptedNonIdentity'])
        for metric in ('logLoss', 'brier'):
            for league in baseline['byLeague']:
                candidate = copy.deepcopy(fit)
                candidate['validationMetrics']['byLeague'][league][metric] = baseline['byLeague'][league][metric]
                with self.subTest(metric=metric, league=league):
                    self.assertFalse(prepare.choose_fit([candidate], baseline)['acceptedNonIdentity'])
            candidate = copy.deepcopy(fit)
            candidate['validationMetrics'][metric] = baseline[metric] - 5e-13
            self.assertFalse(prepare.choose_fit([candidate], baseline)['acceptedNonIdentity'])

    def test_gate_requires_exactly_same_five_leagues(self):
        baseline = score()
        baseline['byLeague'].pop('league0')
        with self.assertRaisesRegex(ValueError, 'exactly_five_selection_leagues_required'):
            prepare.choose_fit([], baseline)
        fit = {'l2LeafReg': 10., 'validationMetrics': score(.9, .5)}
        fit['validationMetrics']['byLeague'].pop('league0')
        with self.assertRaisesRegex(ValueError, 'candidate_selection_leagues_mismatch'):
            prepare.choose_fit([fit], score())

    def test_minimum_global_ll_and_ties_prefer_lower_l2(self):
        fits = [{'l2LeafReg': 30., 'validationMetrics': score(.9, .5)},
                {'l2LeafReg': 10., 'validationMetrics': score(.9 + 5e-13, .5)}]
        decision = prepare.choose_fit(fits, score())
        self.assertEqual(decision['selectedFitIndex'], 1)
        self.assertEqual(decision['selectedL2LeafReg'], 10.)
        fits[1]['validationMetrics']['logLoss'] = .91
        self.assertEqual(prepare.choose_fit(fits, score())['selectedFitIndex'], 0)

    def test_control_ignores_only_model_info_and_rejects_every_inference_mutation(self):
        original, refitted = model(), explicit_model(3.)
        refitted['model_info']['arbitrary_nondeterministic_guid'] = 'different'
        self.assertTrue(prepare.control_guard(original, refitted, [1., 2.], [1., 2.])['nonLeafInferenceExactlyEqual'])
        for field in ('features_info', 'oblivious_trees', 'scale_and_bias'):
            changed = copy.deepcopy(refitted)
            changed[field] = []
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'control_inference_structure_mismatch'):
                prepare.control_guard(original, changed, [1.], [1.])
        with self.assertRaisesRegex(ValueError, 'control_native_prediction_mismatch'):
            prepare.control_guard(original, refitted, [1.], [1. + 1e-8])

    def test_control_accepts_documented_leaf_roundoff_but_rejects_larger_or_nonfinite_changes(self):
        original, refitted = model(), explicit_model(3.)
        refitted['oblivious_trees'][0]['leaf_values'][0] += 5e-14
        receipt = prepare.control_guard(original, refitted, [1.], [1. + 5e-14])
        self.assertTrue(receipt['nonLeafInferenceExactlyEqual'])
        self.assertGreater(receipt['leafMaximumError'], 0)
        self.assertLessEqual(receipt['leafMaximumError'], 1e-12)
        self.assertTrue(receipt['effectiveParametersOnlyL2AfterDocumentedMetadataNormalization'])
        refitted['oblivious_trees'][0]['leaf_values'][0] = 1 + 2e-12
        with self.assertRaisesRegex(ValueError, 'control_leaf_prediction_mismatch'):
            prepare.control_guard(original, refitted, [1.], [1.])
        refitted['oblivious_trees'][0]['leaf_values'][0] = float('nan')
        with self.assertRaisesRegex(ValueError, 'control_nonfinite_or_malformed_leaves'):
            prepare.control_guard(original, refitted, [1.], [1.])
        with self.assertRaisesRegex(ValueError, 'control_nonfinite_or_malformed_raw'):
            prepare.control_guard(original, explicit_model(3.), [1.], [float('inf')])

    def test_control_rejects_changed_support_splits_and_scale(self):
        for change in ('support', 'split', 'scale'):
            refitted = explicit_model(3.)
            if change == 'support':
                refitted['oblivious_trees'][0]['leaf_weights'][0] += 1
            elif change == 'split':
                refitted['oblivious_trees'][0]['splits'] = [{'border': .5}]
            else:
                refitted['scale_and_bias'][0] = 2
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'control_inference_structure_mismatch'):
                prepare.control_guard(model(), refitted, [1.], [1.])

    def test_only_documented_counter_pair_and_no_categoricals_can_be_normalized(self):
        original, candidate = model(), explicit_model(10.)
        before = copy.deepcopy(candidate)
        self.assertTrue(prepare.effective_parameter_guard(original, candidate, 10.))
        self.assertEqual(candidate, before)
        candidate['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] = 18446744073709551614
        with self.assertRaisesRegex(ValueError, 'undocumented_categorical_counter_change'):
            prepare.effective_parameter_guard(original, candidate, 10.)
        original['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] = 18446744073709552001
        with self.assertRaisesRegex(ValueError, 'undocumented_categorical_counter_change'):
            prepare.effective_parameter_guard(original, explicit_model(10.), 10.)
        original = model()
        original['features_info']['categorical_features'] = [{'feature_index': 0}]
        with self.assertRaisesRegex(ValueError, 'categorical_features_forbid_metadata_normalization'):
            prepare.effective_parameter_guard(original, explicit_model(10.), 10.)
        candidate = explicit_model(10.)
        candidate['features_info']['categorical_features'] = [{'feature_index': 0}]
        with self.assertRaisesRegex(ValueError, 'categorical_features_forbid_metadata_normalization'):
            prepare.effective_parameter_guard(model(), candidate, 10.)

    def test_effective_parameters_change_only_l2_and_explicit_flat_entry(self):
        original, candidate = model(), explicit_model(30.)
        self.assertTrue(prepare.effective_parameter_guard(original, candidate, 30.))
        candidate['model_info']['params']['tree_learner_options']['depth'] = 6
        with self.assertRaisesRegex(ValueError, 'effective_parameters_changed_beyond_l2'):
            prepare.effective_parameter_guard(original, candidate, 30.)
        candidate = explicit_model(30.)
        candidate['model_info']['params']['flat_params'].pop('l2_leaf_reg')
        with self.assertRaisesRegex(ValueError, 'explicit_refitted_l2_required'):
            prepare.effective_parameter_guard(original, candidate, 30.)

    def test_native_fit_uses_only_supplied_ordered_training_rows_no_eval_set_or_offset(self):
        rows = [{'matchId': 'second', 'features': [2., 20.], 'homeGoals': 3, 'awayGoals': 1},
                {'matchId': 'first', 'features': [1., 10.], 'homeGoals': 0, 'awayGoals': 2}]
        recipe = {'iterations': 120, 'depth': 5, 'learning_rate': .05, 'random_seed': 20261027,
                  'thread_count': 2, 'verbose': False, 'allow_writing_files': False, 'loss_function': 'Poisson'}
        pools, constructors, fit_calls = [], [], []
        def fake_pool(x, **kwargs):
            pools.append((x.copy(), kwargs))
            return ('pool', len(pools))
        class FakeModel:
            def __init__(self, **kwargs):
                constructors.append(kwargs)
            def fit(self, *args, **kwargs):
                fit_calls.append((args, kwargs))
        def fake_export(native, path):
            path.write_text('{}', encoding='utf-8')
            return {}
        with tempfile.TemporaryDirectory() as folder, patch.object(prepare, 'Pool', side_effect=fake_pool), \
                patch.object(prepare, 'CatBoostRegressor', FakeModel), patch.object(prepare.train, 'export_model', side_effect=fake_export):
            prepare.fit_pair(rows, ['a', 'b'], recipe, 10., Path(folder), 'l2-10')
        self.assertEqual(constructors, [recipe | {'l2_leaf_reg': 10.}] * 2)
        np.testing.assert_array_equal(pools[0][0], [[2., 20.], [1., 10.]])
        np.testing.assert_array_equal(pools[0][1]['label'], [3., 0.])
        np.testing.assert_array_equal(pools[1][1]['label'], [1., 2.])
        self.assertEqual(set(pools[0][1]), {'label', 'feature_names'})
        self.assertEqual(fit_calls, [((('pool', 1),), {}), ((('pool', 2),), {})])

    def test_membership_hashes_capture_order_and_canonical_set(self):
        rows = [{'matchId': 'b', 'availableAt': '2025-01-02T00:00:00Z'}, {'matchId': 'a', 'availableAt': '2025-01-01T00:00:00Z'}]
        before, after = prepare.membership(rows), prepare.membership(rows[::-1])
        self.assertEqual(before['matchIdsHash'], after['matchIdsHash'])
        self.assertNotEqual(before['orderedMatchIdsHash'], after['orderedMatchIdsHash'])

    def test_metrics_use_only_provided_selection_labels(self):
        rows = [{'competition': 'one', 'homeGoals': 2, 'awayGoals': 0}, {'competition': 'two', 'homeGoals': 0, 'awayGoals': 1}]
        values = prepare.metrics(np.array([[.6, .2, .2], [.2, .3, .5]]), rows)
        self.assertEqual(values['n'], 2)
        self.assertAlmostEqual(values['logLoss'], (-np.log(.6) - np.log(.5)) / 2)
        self.assertEqual(set(values['byLeague']), {'one', 'two'})

    def test_exclusive_output_and_frozen_plan_guards(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'exclusive_new_output_required'):
                prepare.run(Path(folder) / 'missing.json', folder)
            plan = Path(folder) / 'plan.json'
            plan.write_text('{}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'original_frozen_plan_hash_required'):
                prepare.run(plan, Path(folder) / 'new')
            self.assertFalse((Path(folder) / 'new').exists())


if __name__ == '__main__':
    unittest.main()
