"""Ignored-feature recipe, mapping and evaluation guards; no real model fits."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

SPEC = importlib.util.spec_from_file_location('ignored_samples_prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def names():
    values = [f'feature_{index}' for index in range(40)]
    values[1], values[17] = 'home_sample', 'away_sample'
    return values


def model():
    return {'features_info': {'float_features': [
                {'feature_index': 0, 'flat_feature_index': 0, 'feature_id': names()[0]},
                {'feature_index': 1, 'flat_feature_index': 2, 'feature_id': names()[2]},
                {'feature_index': 2, 'flat_feature_index': 1, 'feature_id': names()[1]}]},
            'oblivious_trees': [{'splits': [{'split_type': 'FloatFeature', 'float_feature_index': 1, 'border': .5}],
                                 'leaf_values': [0., 2.], 'leaf_weights': [1, 1]}], 'scale_and_bias': [1., [0.]],
            'model_info': {'params': {
                'boosting_options': {'boosting_type': 'Plain'}, 'data_processing_options': {'ignored_features': []},
                'tree_learner_options': {'l2_leaf_reg': 3, 'depth': 5},
                'cat_feature_params': {'ctr_leaf_count_limit': 18446744073709552000},
                'flat_params': {'loss_function': 'Poisson'}, 'random_seed': 20261027}}}


def candidate_model(flat=None):
    result = model()
    p = result['model_info']['params']
    p['data_processing_options']['ignored_features'] = [1, 17]
    p['flat_params'].update({'ignored_features': ['home_sample', 'away_sample'] if flat is None else flat, 'l2_leaf_reg': 3.})
    p['cat_feature_params']['ctr_leaf_count_limit'] = 18446744073709551615
    return result


def feature_rows():
    x = np.zeros((2, 40))
    x[:, 1], x[:, 17] = [31., 40.], [25., 36.]
    x[1, 2] = 1.
    return x


class Native:
    def __init__(self, value):
        self.value = value
    def calc_leaf_indexes(self, x, thread_count):
        return prepare.shared.leaf_routes(self.value, x)
    def predict(self, x, **kwargs):
        return prepare.shared.raw_predict(self.value, x)


def score(ll=1., brier=.6):
    return {'logLoss': ll, 'brier': brier, 'n': 317,
            'byLeague': {f'league{i}': {'logLoss': ll, 'brier': brier, 'n': 50} for i in range(5)}}


class IgnoredSamplesTests(unittest.TestCase):
    def test_only_exact_ignored_names_or_resolved_indices_are_allowed(self):
        for flat in (['home_sample', 'away_sample'], [1, 17]):
            candidate = candidate_model(flat)
            before = copy.deepcopy(candidate)
            self.assertTrue(prepare.ignored_parameter_guard(model(), candidate))
            self.assertEqual(candidate, before)
        for flat in (['home_sample'], [1], [1, 2], ['away_sample', 'home_sample'], [17, 1]):
            with self.subTest(flat=flat), self.assertRaisesRegex(ValueError, 'explicit_ignored_names_or_indices_mismatch'):
                prepare.ignored_parameter_guard(model(), candidate_model(flat))
        candidate = candidate_model()
        candidate['model_info']['params']['data_processing_options']['ignored_features'] = [1, 2]
        with self.assertRaisesRegex(ValueError, 'effective_ignored_indices_mismatch'):
            prepare.ignored_parameter_guard(model(), candidate)

    def test_no_other_effective_recipe_change_or_counter_normalization_is_allowed(self):
        candidate = candidate_model()
        candidate['model_info']['params']['random_seed'] += 1
        with self.assertRaisesRegex(ValueError, 'effective_parameters_changed_beyond_l2'):
            prepare.ignored_parameter_guard(model(), candidate)
        candidate = candidate_model()
        candidate['model_info']['params']['boosting_options']['boosting_type'] = 'Ordered'
        with self.assertRaisesRegex(ValueError, 'plain_boosting_required'):
            prepare.ignored_parameter_guard(model(), candidate)
        candidate = candidate_model()
        candidate['model_info']['params']['flat_params']['bootstrap_type'] = 'MVS'
        with self.assertRaisesRegex(ValueError, 'effective_parameters_changed_beyond_l2'):
            prepare.ignored_parameter_guard(model(), candidate)
        candidate = candidate_model()
        candidate['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] -= 1
        with self.assertRaisesRegex(ValueError, 'undocumented_categorical_counter_change'):
            prepare.ignored_parameter_guard(model(), candidate)

    def test_compressed_float_mapping_is_resolved_before_ignored_split_check(self):
        report = prepare.ignored_mapping_guard(candidate_model(), names())
        self.assertTrue(report['noIgnoredFeatureSplits'])
        candidate = candidate_model()
        candidate['oblivious_trees'][0]['splits'][0]['float_feature_index'] = 2
        with self.assertRaisesRegex(ValueError, 'ignored_feature_used_in_split'):
            prepare.ignored_mapping_guard(candidate, names())
        candidate['oblivious_trees'][0]['splits'][0]['float_feature_index'] = 10
        with self.assertRaisesRegex(ValueError, 'unmapped_float_split'):
            prepare.ignored_mapping_guard(candidate, names())

    def test_ambiguous_mapping_wrong_names_and_nonnumeric_features_are_rejected(self):
        candidate = candidate_model()
        candidate['features_info']['float_features'][1]['feature_id'] = 'wrong'
        with self.assertRaisesRegex(ValueError, 'float_feature_name_mapping_mismatch'):
            prepare.ignored_mapping_guard(candidate, names())
        candidate = candidate_model()
        candidate['features_info']['float_features'][1]['flat_feature_index'] = 0
        with self.assertRaisesRegex(ValueError, 'invalid_or_ambiguous_float_feature_mapping'):
            prepare.ignored_mapping_guard(candidate, names())
        candidate = candidate_model()
        candidate['features_info']['text_features'] = [{}]
        with self.assertRaisesRegex(ValueError, 'numeric_features_only_required'):
            prepare.ignored_mapping_guard(candidate, names())

    def test_candidate_supports_must_match_both_routing_and_stored_weights(self):
        candidate = candidate_model()
        rows = [{'features': row.tolist()} for row in feature_rows()]
        self.assertTrue(prepare.support_guard(candidate, Native(candidate), rows)['allLeafSupportsMatch'])
        changed = copy.deepcopy(candidate)
        changed['oblivious_trees'][0]['leaf_weights'] = [2, 0]
        with self.assertRaisesRegex(ValueError, 'candidate_leaf_support_mismatch'):
            prepare.support_guard(changed, Native(changed), rows)
        class WrongRoutes(Native):
            def calc_leaf_indexes(self, x, thread_count):
                return np.zeros((len(x), 1))
        with self.assertRaisesRegex(ValueError, 'candidate_native_training_route_mismatch'):
            prepare.support_guard(candidate, WrongRoutes(candidate), rows)

    def test_both_ignored_perturbations_preserve_raw_outputs_and_other_columns(self):
        candidate, x = candidate_model(), feature_rows()
        before = x.copy()
        report = prepare.inference_guards(candidate, Native(candidate), x)
        self.assertEqual(set(report['ignoredPerturbations']), {'-1000', '1000'})
        np.testing.assert_array_equal(x, before)
        self.assertEqual(report['candidateNativeMaximumError'], 0.)
        candidate['oblivious_trees'][0]['splits'][0]['float_feature_index'] = 2
        with self.assertRaisesRegex(ValueError, 'ignored_feature_perturbation_changes_raw'):
            prepare.inference_guards(candidate, Native(candidate), x)

    def test_input40_and_frozen_minimal_recipe_enter_two_fits_without_offset_or_eval_set(self):
        rows = [{'features': x.tolist(), 'homeGoals': home, 'awayGoals': away}
                for x, home, away in zip(feature_rows(), [2, 0], [1, 2])]
        recipe = {'iterations': 120, 'depth': 5, 'learning_rate': .05, 'random_seed': 20261027, 'thread_count': 2,
                  'verbose': False, 'allow_writing_files': False, 'loss_function': 'Poisson',
                  'ignored_features': ['home_sample', 'away_sample']}
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
            prepare.fit_pair(rows, names(), recipe, 3., Path(folder), 'ignored-samples')
        self.assertEqual(constructors, [recipe | {'l2_leaf_reg': 3.}] * 2)
        np.testing.assert_array_equal(pools[0][0], feature_rows())
        self.assertEqual(pools[0][0].shape, (2, 40))
        self.assertEqual(pools[0][1]['feature_names'], names())
        self.assertEqual(set(pools[0][1]), {'label', 'feature_names'})
        self.assertEqual(calls, [((1,), {}), ((2,), {})])

    def test_global_and_five_league_both_metric_gate_remains_strict(self):
        self.assertTrue(prepare.choose_candidate(score(.9, .5), score())['acceptedNonIdentity'])
        for league in score()['byLeague']:
            for metric in ('logLoss', 'brier'):
                candidate = score(.9, .5)
                candidate['byLeague'][league][metric] = score()['byLeague'][league][metric]
                self.assertFalse(prepare.choose_candidate(candidate, score())['acceptedNonIdentity'])
        candidate = score(.9, .6)
        self.assertFalse(prepare.choose_candidate(candidate, score())['acceptedNonIdentity'])

    def test_mismatched_pinned_source_and_nonexclusive_output_are_rejected(self):
        plan_file = prepare.ROOT / 'docs/performance/evidence/c-tree-ignored-samples-research-2026-11-08/plan.json'
        plan = json.loads(plan_file.read_bytes())
        plan['sourceHashes'] = {prepare.shared.INCUMBENT: '0' * 64}
        with self.assertRaisesRegex(ValueError, 'pinned_source_changed'):
            prepare.check_sources(plan)
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'exclusive_new_output_required'):
                prepare.run(plan_file, folder)

    def test_real_frozen_plan_passes_startup_schema_without_entering_training(self):
        plan_file = prepare.ROOT / 'docs/performance/evidence/c-tree-ignored-samples-research-2026-11-08/plan.json'
        class StopBeforeTraining(Exception):
            pass
        with tempfile.TemporaryDirectory() as folder, patch.object(prepare, 'check_sources'), \
                patch.object(prepare.current, 'current_manifest', return_value={}), \
                patch.object(prepare.current, 'prepare_dataset', side_effect=StopBeforeTraining) as data, \
                patch.object(prepare, 'fit_pair') as fit:
            output = Path(folder) / 'new'
            with self.assertRaises(StopBeforeTraining):
                prepare.run(plan_file, output)
            data.assert_called_once()
            fit.assert_not_called()
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
