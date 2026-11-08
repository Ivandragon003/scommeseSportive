"""Ordered-only parameter and development guards; no real model fitting."""
import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

SPEC = importlib.util.spec_from_file_location('ordered_prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def original_model():
    return {'features_info': {'float_features': []}, 'oblivious_trees': [{'leaf_values': [1.], 'leaf_weights': [2], 'splits': []}],
            'scale_and_bias': [1., [0.]], 'model_info': {'params': {
                'boosting_options': {'boosting_type': 'Plain', 'fold_len_multiplier': 2},
                'tree_learner_options': {'l2_leaf_reg': 3, 'depth': 5, 'bootstrap': {'type': 'MVS', 'subsample': .800000011920929}},
                'cat_feature_params': {'ctr_leaf_count_limit': 18446744073709552000},
                'flat_params': {'loss_function': 'Poisson'}, 'random_seed': 20261027}}}


def ordered_model():
    result = original_model()
    params = result['model_info']['params']
    params['boosting_options']['boosting_type'] = 'Ordered'
    params['flat_params'].update({'boosting_type': 'Ordered', 'bootstrap_type': 'MVS', 'subsample': .8, 'l2_leaf_reg': 3.})
    params['cat_feature_params']['ctr_leaf_count_limit'] = 18446744073709551615
    return result


def score(ll=1., brier=.6):
    return {'logLoss': ll, 'brier': brier, 'n': 317,
            'byLeague': {f'league{i}': {'logLoss': ll, 'brier': brier, 'n': 50} for i in range(5)}}


class OrderedTests(unittest.TestCase):
    def test_only_ordered_and_frozen_explicit_defaults_are_permitted_without_mutation(self):
        original, candidate = original_model(), ordered_model()
        before = copy.deepcopy(candidate)
        self.assertTrue(prepare.ordered_parameter_guard(original, candidate))
        self.assertEqual(candidate, before)
        self.assertEqual(original, original_model())

    def test_any_other_effective_parameter_change_is_rejected(self):
        for section, key, value in [('boosting_options', 'fold_len_multiplier', 3),
                                     ('tree_learner_options', 'depth', 6), ('tree_learner_options', 'l2_leaf_reg', 10)]:
            candidate = ordered_model()
            candidate['model_info']['params'][section][key] = value
            with self.subTest(section=section, key=key), self.assertRaises(ValueError):
                prepare.ordered_parameter_guard(original_model(), candidate)
        candidate = ordered_model()
        candidate['model_info']['params']['random_seed'] += 1
        with self.assertRaisesRegex(ValueError, 'effective_parameters_changed_beyond_l2'):
            prepare.ordered_parameter_guard(original_model(), candidate)

    def test_missing_or_wrong_explicit_defaults_are_rejected(self):
        for key, wrong in [('boosting_type', 'Plain'), ('bootstrap_type', 'Bernoulli'), ('subsample', .9), ('l2_leaf_reg', 10)]:
            for missing in (False, True):
                candidate = ordered_model()
                if missing:
                    candidate['model_info']['params']['flat_params'].pop(key)
                else:
                    candidate['model_info']['params']['flat_params'][key] = wrong
                with self.subTest(key=key, missing=missing), self.assertRaises(ValueError):
                    prepare.ordered_parameter_guard(original_model(), candidate)

    def test_exact_inactive_counter_pair_only_and_no_categorical_features(self):
        candidate = ordered_model()
        candidate['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] -= 1
        with self.assertRaisesRegex(ValueError, 'undocumented_categorical_counter_change'):
            prepare.ordered_parameter_guard(original_model(), candidate)
        candidate = ordered_model()
        candidate['features_info']['categorical_features'] = [{'feature_index': 0}]
        with self.assertRaisesRegex(ValueError, 'categorical_features_forbid_metadata_normalization'):
            prepare.ordered_parameter_guard(original_model(), candidate)

    def test_gate_both_metrics_globally_and_every_one_of_five_leagues(self):
        identity, candidate = score(), score(.9, .5)
        self.assertEqual(prepare.choose_candidate(candidate, identity), {'acceptedNonIdentity': True, 'selectedVariant': 'Ordered'})
        for league in identity['byLeague']:
            for key in ('logLoss', 'brier'):
                failed = copy.deepcopy(candidate)
                failed['byLeague'][league][key] = identity['byLeague'][league][key] - 5e-13
                self.assertEqual(prepare.choose_candidate(failed, identity), {'acceptedNonIdentity': False, 'selectedVariant': None})
        for key in ('logLoss', 'brier'):
            failed = copy.deepcopy(candidate)
            failed[key] = identity[key]
            self.assertFalse(prepare.choose_candidate(failed, identity)['acceptedNonIdentity'])
        candidate['byLeague'].pop('league0')
        with self.assertRaisesRegex(ValueError, 'candidate_selection_leagues_mismatch'):
            prepare.choose_candidate(candidate, identity)

    def test_reused_plain_control_uses_pinned_numerical_guard(self):
        original = original_model()
        plain = copy.deepcopy(original)
        plain['model_info']['params']['flat_params']['l2_leaf_reg'] = 3.
        plain['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] = 18446744073709551615
        plain['oblivious_trees'][0]['leaf_values'][0] += 1e-14
        receipt = prepare.l2.control_guard(original, plain, [1.], [1. + 1e-14])
        self.assertTrue(receipt['nonLeafInferenceExactlyEqual'])
        self.assertLessEqual(receipt['leafMaximumError'], 1e-12)
        plain['oblivious_trees'][0]['leaf_weights'][0] += 1
        with self.assertRaisesRegex(ValueError, 'control_inference_structure_mismatch'):
            prepare.l2.control_guard(original, plain, [1.], [1.])

    def test_frozen_recipe_and_only_supplied_training_order_enter_two_pool_fits(self):
        rows = [{'features': [2., 20.], 'homeGoals': 3, 'awayGoals': 1}, {'features': [1., 10.], 'homeGoals': 0, 'awayGoals': 2}]
        recipe = {'iterations': 120, 'depth': 5, 'learning_rate': .05, 'random_seed': 20261027, 'thread_count': 2,
                  'verbose': False, 'allow_writing_files': False, 'loss_function': 'Poisson',
                  'boosting_type': 'Ordered', 'bootstrap_type': 'MVS', 'subsample': .8}
        pools, constructors, calls = [], [], []
        def pool(x, **kwargs):
            pools.append((x.copy(), kwargs))
            return len(pools)
        class Model:
            def __init__(self, **kwargs):
                constructors.append(kwargs)
            def fit(self, *args, **kwargs):
                calls.append((args, kwargs))
        def export(native, path):
            path.write_text('{}', encoding='utf-8')
            return {}
        with tempfile.TemporaryDirectory() as folder, patch.object(prepare.l2, 'Pool', side_effect=pool), \
                patch.object(prepare.l2, 'CatBoostRegressor', Model), patch.object(prepare.train, 'export_model', side_effect=export):
            prepare.fit_pair(rows, ['a', 'b'], recipe, 3., Path(folder), 'ordered')
        self.assertEqual(constructors, [recipe | {'l2_leaf_reg': 3.}] * 2)
        self.assertEqual(calls, [((1,), {}), ((2,), {})])
        np.testing.assert_array_equal(pools[0][0], [[2, 20], [1, 10]])
        np.testing.assert_array_equal(pools[0][1]['label'], [3, 0])
        np.testing.assert_array_equal(pools[1][1]['label'], [1, 2])
        self.assertEqual(set(pools[0][1]), {'label', 'feature_names'})

    def test_exclusive_output_and_frozen_plan_guards(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'exclusive_new_output_required'):
                prepare.run(Path(folder) / 'missing.json', folder)
            plan = Path(folder) / 'plan.json'
            plan.write_text('{}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'original_frozen_plan_hash_required'):
                prepare.run(plan, Path(folder) / 'new')


if __name__ == '__main__':
    unittest.main()
