"""Synthetic guards only; no training or scoring of research observations."""
from __future__ import annotations

import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np

SPEC = importlib.util.spec_from_file_location('ignored_samples_verifier_under_test', Path(__file__).with_name('verify_selection.py'))
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


def names():
    result = [f'feature_{index}' for index in range(40)]
    result[1], result[17] = 'home_sample', 'away_sample'
    return result


def parameter_models():
    original = {'model_info': {'params': {'boosting_options': {'boosting_type': 'Plain'},
        'tree_learner_options': {'l2_leaf_reg': 3, 'depth': 5}, 'flat_params': {'random_seed': 20261027},
        'data_processing_options': {'ignored_features': []},
        'cat_feature_params': {'ctr_leaf_count_limit': 18446744073709552000}}}, 'features_info': {}}
    candidate = copy.deepcopy(original)
    params = candidate['model_info']['params']
    params['data_processing_options']['ignored_features'] = [1, 17]
    params['flat_params'] |= {'ignored_features': ['home_sample', 'away_sample'], 'l2_leaf_reg': 3}
    params['cat_feature_params']['ctr_leaf_count_limit'] = 18446744073709551615
    return original, candidate


class VerifierTests(unittest.TestCase):
    def test_only_documented_effective_parameter_changes(self):
        original, candidate = parameter_models()
        VERIFIER.ignored_parameters(original, candidate)
        candidate['model_info']['params']['flat_params']['ignored_features'] = [1, 17]
        VERIFIER.ignored_parameters(original, candidate)
        self.assertEqual(original['model_info']['params']['data_processing_options']['ignored_features'], [])

    def test_unplanned_recipe_and_ignored_set_are_rejected(self):
        original, candidate = parameter_models()
        mutations = [
            lambda model: model['model_info']['params']['flat_params'].__setitem__('random_seed', 42),
            lambda model: model['model_info']['params']['flat_params'].__setitem__('subsample', .8),
            lambda model: model['model_info']['params']['flat_params'].__setitem__('ignored_features', [1, 18]),
            lambda model: model['model_info']['params']['data_processing_options'].__setitem__('ignored_features', [17, 1]),
            lambda model: model['model_info']['params']['tree_learner_options'].__setitem__('depth', 6),
            lambda model: model['features_info'].__setitem__('categorical_features', [{}]),
        ]
        for mutate in mutations:
            invalid = copy.deepcopy(candidate); mutate(invalid)
            with self.assertRaises(AssertionError):
                VERIFIER.ignored_parameters(original, invalid)

    def test_explicit_feature_mapping_and_ignored_split_rejection(self):
        feature_names = names()
        model = {'features_info': {'float_features': [
            {'feature_index': 4, 'flat_feature_index': 0, 'feature_id': feature_names[0]},
            {'feature_index': 8, 'flat_feature_index': 2, 'feature_id': feature_names[2]}]},
            'oblivious_trees': [{'splits': [{'split_type': 'FloatFeature', 'float_feature_index': 8, 'border': 0}],
                                'leaf_values': [.1, .2]} for _ in range(120)]}
        self.assertTrue(VERIFIER.ignored_mapping(model, feature_names)['noIgnoredFeatureSplits'])
        invalid = copy.deepcopy(model)
        invalid['features_info']['float_features'][1] |= {'flat_feature_index': 17, 'feature_id': feature_names[17]}
        with self.assertRaisesRegex(AssertionError, 'Ignored feature used'):
            VERIFIER.ignored_mapping(invalid, feature_names)
        invalid = copy.deepcopy(model)
        invalid['features_info']['float_features'][1]['feature_index'] = 4
        with self.assertRaises(AssertionError):
            VERIFIER.ignored_mapping(invalid, feature_names)

    def test_perturbations_preserve_every_other_feature(self):
        original = np.arange(80, dtype=float).reshape(2, 40)
        snapshots = list(VERIFIER.perturbations(original))
        self.assertEqual(len(snapshots), 6)
        self.assertTrue(np.array_equal(original, np.arange(80).reshape(2, 40)))
        for _, changed in snapshots:
            self.assertTrue(np.array_equal(changed[:, [index for index in range(40) if index not in [1, 17]]],
                                           original[:, [index for index in range(40) if index not in [1, 17]]]))

    def test_global_and_exactly_five_league_strict_gate(self):
        reference = {'logLoss': 1., 'brier': .7, 'byLeague': {str(index): {'logLoss': 1., 'brier': .7} for index in range(5)}}
        actual = {'logLoss': .9, 'brier': .6, 'byLeague': {str(index): {'logLoss': .9, 'brier': .6} for index in range(5)}}
        self.assertTrue(VERIFIER.accepts(actual, reference))
        actual['byLeague']['4']['brier'] = .7
        self.assertFalse(VERIFIER.accepts(actual, reference))
        del actual['byLeague']['4']
        with self.assertRaises(AssertionError):
            VERIFIER.accepts(actual, reference)

    def test_current_typescript_source_bridge_on_synthetic_model(self):
        feature_names = names()
        model = {'features_info': {'float_features': [{'feature_index': index, 'flat_feature_index': index,
            'feature_id': name} for index, name in enumerate(feature_names)]},
            'oblivious_trees': [{'splits': [], 'leaf_values': [.25]}], 'scale_and_bias': [2, [.5]]}
        models = {family: {'home': model, 'away': model} for family in ['identity', 'control', 'candidate']}
        rows = [{'matchId': 'toy_only', 'baselineMatrix': [[.2, .3], [.3, .2]]}]
        source_path = 'backend/src/research/CatBoostModel.ts'
        hashes = {source_path: VERIFIER.digest(VERIFIER.ROOT / source_path)}
        with tempfile.TemporaryDirectory(prefix='ignored-source-toy-') as directory:
            output = VERIFIER.source_predictions(models, rows, np.zeros((1, 40)), hashes, directory)
        self.assertEqual(output['baselineHashBefore'], output['baselineHashAfter'])
        self.assertEqual(output['rows'][0]['candidate'], {'home': [1], 'away': [1]})
        self.assertEqual(len(output['rows'][0]['perturbations']), 6)
        self.assertTrue(all(values == {'home': [1], 'away': [1]} for values in output['rows'][0]['perturbations'].values()))


if __name__ == '__main__':
    unittest.main()
