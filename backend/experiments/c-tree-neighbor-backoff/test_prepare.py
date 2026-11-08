"""Synthetic all-nearest-donor tests; no actual candidate or outcome scoring."""
import copy
import importlib.util
import itertools
import tempfile
import unittest
from pathlib import Path

import numpy as np

SPEC = importlib.util.spec_from_file_location('neighbor_backoff_prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def split(index, border=.5):
    return {'split_type': 'FloatFeature', 'float_feature_index': index, 'border': border}


def fixture(weights=None, values=None):
    weights = list(weights if weights is not None else [2, 1, 0, 3, 0, 4, 0, 0])
    values = list(values if values is not None else [10., 20., 0., 40., 0., 60., 0., 0.])
    depth = len(weights).bit_length() - 1
    model = {'oblivious_trees': [{'splits': [split(bit) for bit in range(depth)],
                                 'leaf_values': values, 'leaf_weights': weights}],
             'scale_and_bias': [2., [3.]], 'model_info': {'sentinel': 'unchanged'}}
    features = np.array([[float((leaf >> bit) & 1) for bit in range(depth)]
                         for leaf, weight in enumerate(weights) for _ in range(weight)])
    return model, features


class NeighborTests(unittest.TestCase):
    def test_all_equidistant_supported_neighbors_use_original_nonuniform_weights(self):
        model, features = fixture()
        edited, audit = prepare.backoff_model(model, features)
        records = {row['leaf']: row for row in audit['trees'][0]['emptyLeaves']}
        self.assertEqual(records[4]['minimumHammingDistance'], 1)
        self.assertEqual(records[4]['donorLeaves'], [0, 5])
        self.assertEqual(records[4]['donorCount'], 2)
        self.assertEqual(records[4]['donorSupport'], 6)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'][4], 260 / 6)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'][2], 28.)

    def test_minimum_distance_two_ignores_empty_nearer_leaves_and_new_values(self):
        model, features = fixture()
        edited, audit = prepare.backoff_model(model, features)
        record = next(row for row in audit['trees'][0]['emptyLeaves'] if row['leaf'] == 6)
        self.assertEqual(record['minimumHammingDistance'], 2)
        self.assertEqual(record['donorLeaves'], [0, 3, 5])
        self.assertEqual(record['donorSupport'], 9)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'][6], 380 / 9)
        self.assertEqual(audit['minimumHammingDistanceCounts'], {'1': 3, '2': 1})

    def test_farther_supported_donor_is_excluded(self):
        values, records = prepare.neighbor_replacements([10., 0., 0., 100.], [2, 0, 0, 3])
        self.assertEqual(values[1], 64.)
        self.assertEqual(next(row for row in records if row['leaf'] == 1)['donorLeaves'], [0, 3])
        values, records = prepare.neighbor_replacements([10., 0., 100., 0., 0., 0., 0., 0.], [2, 0, 3, 0, 0, 0, 0, 0])
        record = next(row for row in records if row['leaf'] == 1)
        self.assertEqual(record['donorLeaves'], [0])
        self.assertEqual(values[1], 10.)

    def test_supported_zero_is_donor_and_cancelling_backoff_can_remain_zero(self):
        values, records = prepare.neighbor_replacements([0., 0., 0., 8.], [2, 0, 0, 1])
        self.assertEqual(values[1], 8 / 3)
        self.assertEqual(next(row for row in records if row['leaf'] == 1)['donorLeaves'], [0, 3])
        model, features = fixture([1, 0, 0, 1], [-2., 0., 0., 2.])
        edited, audit = prepare.backoff_model(model, features)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'], [-2., 0., 0., 2.])
        self.assertEqual(audit['changedLeafCount'], 0)
        self.assertEqual(audit['emptyLeafCount'], 2)

    def test_repeated_feature_unreachable_leaf_averages_all_nearest_donors(self):
        model = {'oblivious_trees': [{'splits': [split(0, .5), split(0, 1.5)],
                                     'leaf_values': [10., 20., 0., 30.], 'leaf_weights': [2, 1, 0, 3]}],
                 'scale_and_bias': [2., [3.]]}
        features = np.array([[0.], [0.], [1.], [2.], [2.], [2.]])
        edited, audit = prepare.backoff_model(model, features)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'][2], 22.)
        self.assertEqual(audit['trees'][0]['emptyLeaves'][0]['donorLeaves'], [0, 3])
        np.testing.assert_array_equal(prepare.shared.raw_predict(model, features), prepare.shared.raw_predict(edited, features))

    def test_joint_split_bit_and_leaf_permutation_preserves_entire_transformed_function(self):
        model, features = fixture()
        edited, _ = prepare.backoff_model(model, features)
        all_features = np.array(list(itertools.product((0., 1.), repeat=3)))
        original_tree = model['oblivious_trees'][0]
        for order in itertools.permutations(range(3)):
            with self.subTest(order=order):
                permuted = copy.deepcopy(model)
                tree = permuted['oblivious_trees'][0]
                tree['splits'] = [original_tree['splits'][old_bit] for old_bit in order]
                for old_leaf in range(8):
                    new_leaf = sum(((old_leaf >> old_bit) & 1) << new_bit for new_bit, old_bit in enumerate(order))
                    tree['leaf_values'][new_leaf] = original_tree['leaf_values'][old_leaf]
                    tree['leaf_weights'][new_leaf] = original_tree['leaf_weights'][old_leaf]
                transformed, audit = prepare.backoff_model(permuted, features)
                np.testing.assert_array_equal(prepare.shared.raw_predict(transformed, all_features),
                                              prepare.shared.raw_predict(edited, all_features))
                self.assertEqual(audit['jointBitLeafPermutationMaximumError'], 0.)

    def test_input_immutability_supported_contributions_scale_bias_metadata(self):
        model, features = fixture()
        original = copy.deepcopy(model)
        edited, audit = prepare.backoff_model(model, features)
        self.assertEqual(model, original)
        self.assertEqual(edited['scale_and_bias'], original['scale_and_bias'])
        self.assertEqual(edited['model_info'], original['model_info'])
        for key in ('splits', 'leaf_weights'):
            self.assertEqual(edited['oblivious_trees'][0][key], original['oblivious_trees'][0][key])
        for index, weight in enumerate(original['oblivious_trees'][0]['leaf_weights']):
            if weight > 0:
                self.assertEqual(edited['oblivious_trees'][0]['leaf_values'][index], original['oblivious_trees'][0]['leaf_values'][index])
        self.assertEqual(audit['trainingRawMaximumDifference'], 0.)
        self.assertTrue(audit['trainingRawExactlyUnchanged'])

    def test_fully_supported_tree_is_serially_identical(self):
        model, features = fixture([1] * 8, list(range(8)))
        edited, audit = prepare.backoff_model(model, features)
        self.assertEqual(prepare.encode(model), prepare.encode(edited))
        self.assertEqual(audit['emptyLeafCount'], 0)

    def test_no_support_and_nonzero_original_empty_value_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'no_supported_donor'):
            prepare.neighbor_replacements([0., 0.], [0, 0])
        model, features = fixture()
        model['oblivious_trees'][0]['leaf_values'][2] = .01
        with self.assertRaisesRegex(ValueError, 'nonzero_empty_leaf'):
            prepare.backoff_model(model, features)

    def test_invalid_original_values_weights_and_empty_training_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'nonfinite_original_leaf_values'):
            prepare.neighbor_replacements([float('nan'), 0.], [1, 0])
        with self.assertRaisesRegex(ValueError, 'invalid_original_leaf_support'):
            prepare.neighbor_replacements([2., 0.], [1, -1])
        model, _ = fixture()
        with self.assertRaisesRegex(ValueError, 'nonempty_original_training_required'):
            prepare.backoff_model(model, [])

    def test_wrong_support_or_native_routing_is_rejected(self):
        model, features = fixture()
        model['oblivious_trees'][0]['leaf_weights'][0] += 1
        with self.assertRaisesRegex(ValueError, 'original_leaf_support_mismatch'):
            prepare.backoff_model(model, features)
        model, features = fixture()
        native_routes = prepare.shared.leaf_routes(model, features)
        native_routes[0, 0] += 1
        with self.assertRaisesRegex(ValueError, 'native_training_routing_mismatch'):
            prepare.backoff_model(model, features, native_routes)

    def test_existing_output_rejected_without_reading_missing_plan(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'exclusive_new_output_required'):
                prepare.run(Path(folder) / 'missing-plan.json', folder)

    def test_unfrozen_plan_rejected_before_any_model_access(self):
        with tempfile.TemporaryDirectory() as folder:
            plan = Path(folder) / 'plan.json'
            plan.write_text('{}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'original_frozen_plan_hash_required'):
                prepare.run(plan, Path(folder) / 'new')
            self.assertFalse((Path(folder) / 'new').exists())


if __name__ == '__main__':
    unittest.main()
