"""HS-inspired algebra and metadata tests; no prediction outcome evaluation."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np

SPEC = importlib.util.spec_from_file_location('hierarchical_prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)
shrink = prepare.shrink


def score(ll=1., brier=.6):
    return {'logLoss': ll, 'brier': brier, 'n': 317,
            'byLeague': {f'league{i}': {'logLoss': ll, 'brier': brier, 'n': 50} for i in range(5)}}


class HierarchicalTests(unittest.TestCase):
    def test_small_depth_lsb_prefix_formula_uses_parent_support(self):
        values, audit = shrink.hierarchical_values([0., 2., 4., 6.], [1, 1, 1, 1], 2.)
        np.testing.assert_allclose(values, [4 / 3, 8 / 3, 10 / 3, 14 / 3], atol=1e-15, rtol=0)
        self.assertEqual([node['mean'] for node in audit['nodeLevels'][1]], [2., 4.])
        self.assertEqual([node['support'] for node in audit['nodeLevels'][1]], [2., 2.])
        self.assertLessEqual(audit['weightedMeanMaximumError'], 1e-12)

    def test_lambda_zero_supported_limit_and_empty_ancestor_are_distinct_from_original_identity(self):
        original = [1., 9., 0., 0.]
        values, _ = shrink.hierarchical_values(original, [2, 1, 0, 0], 0.)
        np.testing.assert_allclose(values, [1., 9., 1., 9.], atol=1e-15, rtol=0)
        self.assertNotEqual(values, original)

    def test_empty_node_chain_recursively_inherits_parent_mean(self):
        values, audit = shrink.hierarchical_values([5.] + [0.] * 7, [2] + [0] * 7, 100.)
        self.assertEqual(values, [5.] * 8)
        for level in audit['nodeLevels']:
            self.assertTrue(all(node['mean'] == 5. for node in level))

    def test_unsupported_original_values_never_affect_node_means(self):
        a, _ = shrink.hierarchical_values([1., 9., 0., 0.], [2, 1, 0, 0], 10.)
        b, _ = shrink.hierarchical_values([1., 9., 100., -700.], [2, 1, 0, 0], 10.)
        self.assertEqual(a, b)

    def test_weighted_mean_preserved_for_nonuniform_support_and_all_frozen_lambdas(self):
        original, counts = [0., 2., 7., -3., 1., 0., 0., 4.], [3, 5, 2, 1, 7, 0, 0, 4]
        before = np.dot(original, counts) / sum(counts)
        for strength in (1., 10., 100.):
            values, _ = shrink.hierarchical_values(original, counts, strength)
            self.assertAlmostEqual(np.dot(values, counts) / sum(counts), before, places=12)
            self.assertNotEqual(values[0], original[0])

    def test_single_leaf_tree_has_no_path_increments(self):
        values, audit = shrink.hierarchical_values([2.], [7], 100.)
        self.assertEqual(values, [2.])
        self.assertEqual(len(audit['nodeLevels']), 1)

    def test_scale_bias_splits_weights_and_all_metadata_stay_identical(self):
        model = {'oblivious_trees': [{'splits': [{'split_type': 'FloatFeature', 'float_feature_index': 0, 'border': .5},
                                                {'split_type': 'FloatFeature', 'float_feature_index': 1, 'border': .5}],
                                     'leaf_values': [0., 2., 4., 6.], 'leaf_weights': [1, 1, 1, 1]}],
                 'scale_and_bias': [2.5, [-.7]], 'features_info': {'float_features': []}, 'model_info': {'sentinel': 'keep'}}
        before = copy.deepcopy(model)
        edited, audit = shrink.shrink_model(model, 2.)
        self.assertEqual(model, before)
        for key in ('scale_and_bias', 'features_info', 'model_info'):
            self.assertEqual(edited[key], before[key])
        for key in ('splits', 'leaf_weights'):
            self.assertEqual(edited['oblivious_trees'][0][key], before['oblivious_trees'][0][key])
        x = [[0., 0.], [1., 0.], [0., 1.], [1., 1.]]
        self.assertAlmostEqual(prepare.shared.raw_predict(edited, x).mean(), prepare.shared.raw_predict(model, x).mean(), places=12)
        self.assertTrue(audit['onlyLeafValuesChanged'])

    def test_current_artifact_structure_is_preserved_without_scoring_or_writing_candidate(self):
        source = json.loads((prepare.ROOT / prepare.shared.INCUMBENT).read_bytes())['models']['home']
        edited, audit = shrink.shrink_model(source, 1.)
        self.assertEqual(len(edited['oblivious_trees']), 120)
        self.assertEqual({key: value for key, value in edited.items() if key != 'oblivious_trees'},
                         {key: value for key, value in source.items() if key != 'oblivious_trees'})
        for before, after in zip(source['oblivious_trees'], edited['oblivious_trees']):
            self.assertEqual({key: value for key, value in before.items() if key != 'leaf_values'},
                             {key: value for key, value in after.items() if key != 'leaf_values'})
        self.assertLessEqual(audit['maximumWeightedTreeMeanError'], 1e-12)

    def test_strict_global_and_five_league_gate_and_smallest_lambda_tie(self):
        fits = [{'lambda': 100., 'validationMetrics': score(.9, .5)}, {'lambda': 1., 'validationMetrics': score(.9 + 5e-13, .5)}]
        decision = prepare.choose_fit(fits, score())
        self.assertEqual(decision['selectedLambda'], 1.)
        self.assertEqual(decision['selectedFitIndex'], 1)
        for league in score()['byLeague']:
            for key in ('logLoss', 'brier'):
                failed = copy.deepcopy(fits[0])
                failed['validationMetrics']['byLeague'][league][key] = score()['byLeague'][league][key]
                self.assertFalse(prepare.choose_fit([failed], score())['acceptedNonIdentity'])
        failed = copy.deepcopy(fits[0])
        failed['validationMetrics']['logLoss'] = 1.
        self.assertFalse(prepare.choose_fit([failed], score())['acceptedNonIdentity'])

    def test_invalid_inputs_and_root_without_support_are_rejected(self):
        for values, counts, strength in [([1., 2., 3.], [1, 1, 1], 1.), ([0., 0.], [0, 0], 1.),
                                         ([1., 2.], [1, -1], 1.), ([1., 2.], [1, 1], -1.),
                                         ([float('nan'), 0.], [1, 1], 1.)]:
            with self.subTest(values=values, counts=counts, strength=strength), self.assertRaises(ValueError):
                shrink.hierarchical_values(values, counts, strength)

    def test_exclusive_output_and_frozen_plan_guards(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'exclusive_new_output_required'):
                prepare.run(Path(folder) / 'missing.json', folder)
            path = Path(folder) / 'plan.json'
            path.write_text('{}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'original_frozen_plan_hash_required'):
                prepare.run(path, Path(folder) / 'new')


if __name__ == '__main__':
    unittest.main()
