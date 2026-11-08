"""Technical projection tests. No outcome scores or candidate artifact generation."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

SPEC = importlib.util.spec_from_file_location('sample_projection_prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def split(index, border):
    return {'split_type': 'FloatFeature', 'float_feature_index': index, 'border': border}


def fixture(empty_group=False):
    names = ['home_sample', 'quality', 'away_sample']
    features = np.array([[count, quality, 10] for quality in ([0] if empty_group else [0, 1])
                         for count in [0, 1, 2]], dtype=float)
    # Repeated target feature at bits 0 and 2 leaves two impossible combinations.
    trees = [{'splits': [split(5, .5), split(9, .5), split(5, 1.5)],
              'leaf_values': [1., 2., 3., 4., 0., 6., 0., 8.]},
             {'splits': [split(9, .5)], 'leaf_values': [5., 9.]}]
    if empty_group:
        for leaf in (2, 3, 6, 7):
            trees[0]['leaf_values'][leaf] = 0.
    model = {'features_info': {'float_features': [{'feature_index': 5, 'flat_feature_index': 0},
                                                 {'feature_index': 9, 'flat_feature_index': 1}]},
             'oblivious_trees': trees, 'scale_and_bias': [2., [3.]], 'model_info': {'keep': 'verbatim'}}
    for index, routes in enumerate(prepare.leaf_routes(model, features).T):
        trees[index]['leaf_weights'] = np.bincount(routes, minlength=len(trees[index]['leaf_values'])).tolist()
    return model, names, features


class ProjectionTests(unittest.TestCase):
    def test_repeated_target_bits_group_by_all_remaining_bits(self):
        model, names, features = fixture()
        edited, audit = prepare.project_model(model, names, features)
        leaves = edited['oblivious_trees'][0]['leaf_values']
        self.assertEqual([leaves[i] for i in [0, 1, 4, 5]], [3.] * 4)
        self.assertEqual([leaves[i] for i in [2, 3, 6, 7]], [5.] * 4)
        self.assertEqual(audit['targetTreesBefore'], 1)
        self.assertEqual(audit['targetSplitsBefore'], 2)
        self.assertEqual(audit['effectiveCountDependentGroupsAfter'], 0)

    def test_weighted_training_mean_preserved_and_nontarget_tree_unchanged(self):
        model, names, features = fixture()
        # Unequal support prevents an unweighted mean from passing.
        features = np.concatenate([features, features[[0, 0, 5]]])
        for index, routes in enumerate(prepare.leaf_routes(model, features).T):
            model['oblivious_trees'][index]['leaf_weights'] = np.bincount(routes, minlength=len(model['oblivious_trees'][index]['leaf_values'])).tolist()
        before = prepare.encode(model['oblivious_trees'][1])
        edited, audit = prepare.project_model(model, names, features)
        self.assertEqual(prepare.encode(edited['oblivious_trees'][1]), before)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'][0], 11 / 5)
        self.assertLessEqual(audit['maximumWeightedMeanError'], 1e-12)
        self.assertAlmostEqual(float(prepare.raw_predict(model, features).mean()),
                               float(prepare.raw_predict(edited, features).mean()), places=12)

    def test_projection_does_not_mutate_input_or_non_leaf_parameters(self):
        model, names, features = fixture()
        snapshot = copy.deepcopy(model)
        edited, _ = prepare.project_model(model, names, features)
        self.assertEqual(model, snapshot)
        self.assertIsNot(edited, model)
        for key in ('features_info', 'scale_and_bias', 'model_info'):
            self.assertEqual(edited[key], model[key])
        for original, projected in zip(model['oblivious_trees'], edited['oblivious_trees']):
            self.assertEqual(original['leaf_weights'], projected['leaf_weights'])
            self.assertEqual(original['splits'], projected['splits'])

    def test_zero_support_groups_stay_zero(self):
        model, names, features = fixture(empty_group=True)
        edited, audit = prepare.project_model(model, names, features)
        self.assertEqual(audit['zeroSupportGroups'], 1)
        self.assertTrue(all(edited['oblivious_trees'][0]['leaf_values'][i] == 0 for i in (2, 3, 6, 7)))

    def test_nonzero_empty_group_rejected(self):
        model, names, features = fixture(empty_group=True)
        model['oblivious_trees'][0]['leaf_values'][6] = .1
        with self.assertRaisesRegex(ValueError, 'nonzero_empty_group'):
            prepare.project_model(model, names, features)

    def test_any_leaf_support_mismatch_rejected(self):
        for tree in (0, 1):
            with self.subTest(tree=tree):
                model, names, features = fixture()
                model['oblivious_trees'][tree]['leaf_weights'][0] += 1
                with self.assertRaisesRegex(ValueError, 'original_leaf_support_mismatch'):
                    prepare.project_model(model, names, features)

    def test_native_routing_mismatch_rejected(self):
        model, names, features = fixture()
        routes = prepare.leaf_routes(model, features)
        routes[0, 0] += 1
        with self.assertRaisesRegex(ValueError, 'native_training_routing_mismatch'):
            prepare.project_model(model, names, features, routes)

    def test_count_invariance_including_impossible_original_combinations(self):
        model, names, features = fixture()
        edited, _ = prepare.project_model(model, names, features)
        changed = features.copy()
        changed[:, 0] += 38
        changed[:, 2] += 38
        np.testing.assert_array_equal(prepare.raw_predict(edited, features), prepare.raw_predict(edited, changed))

    def test_home_and_away_count_bits_are_projected_together(self):
        names = ['home_sample', 'quality', 'away_sample']
        features = np.array([[home, quality, away] for away in (0, 1)
                             for quality in (0, 1) for home in (0, 1)], dtype=float)
        model = {'oblivious_trees': [{'splits': [split(0, .5), split(1, .5), split(2, .5)],
                                     'leaf_values': [float(i) for i in range(8)], 'leaf_weights': [1] * 8}],
                 'scale_and_bias': [1., [0.]]}
        edited, audit = prepare.project_model(model, names, features)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'], [2.5, 2.5, 4.5, 4.5, 2.5, 2.5, 4.5, 4.5])
        self.assertEqual(audit['targetSplitsBefore'], 2)
        self.assertEqual(audit['effectiveCountDependentGroupsBefore'], 2)

    def test_float32_boundary_and_scale_bias(self):
        model = {'oblivious_trees': [{'splits': [split(0, 1.)], 'leaf_values': [2., 7.]}],
                 'scale_and_bias': [3., [4.]]}
        np.testing.assert_array_equal(prepare.raw_predict(model, [[1 + 1e-8], [1 + 1e-6]]), [10., 25.])

    def test_existing_output_rejected_before_plan_or_model_reads(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'exclusive_new_output_required'):
                prepare.run(Path(folder) / 'missing-plan.json', folder)

    def test_native_json_load_without_training_matches_independent_traversal(self):
        # The incumbent is only read for this inference parity test; no projection is generated.
        model = json.loads((prepare.ROOT / prepare.INCUMBENT).read_bytes())['models']['home']
        features = np.array([[0.] * 40, [1.] * 40, [100.] * 40])
        with tempfile.TemporaryDirectory() as folder:
            native = prepare.load_native(model, folder, 'incumbent')
            np.testing.assert_allclose(native.predict(features, prediction_type='RawFormulaVal'),
                                       prepare.raw_predict(model, features), rtol=0, atol=1e-12)


if __name__ == '__main__':
    unittest.main()
