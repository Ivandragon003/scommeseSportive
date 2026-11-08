"""Synthetic backoff checks; no experiment artifact or outcome scoring."""
import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np

SPEC = importlib.util.spec_from_file_location('empty_leaf_backoff_prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def split(index, border=.5):
    return {'split_type': 'FloatFeature', 'float_feature_index': index, 'border': border}


def fixture(weights=None, values=None):
    weights = weights if weights is not None else [2, 1, 0, 3, 0, 4, 0, 0]
    values = values if values is not None else [10., 20., 0., 40., 0., 60., 0., 0.]
    model = {'oblivious_trees': [{'splits': [split(0), split(1), split(2)],
                                 'leaf_values': list(values), 'leaf_weights': list(weights)}],
             'scale_and_bias': [2., [3.]], 'model_info': {'sentinel': 'unchanged'}}
    features = np.array([[float((leaf >> bit) & 1) for bit in range(3)]
                         for leaf, weight in enumerate(weights) for _ in range(weight)])
    return model, features


class BackoffTests(unittest.TestCase):
    def test_nearest_prefix_keeps_low_depth_bits_not_high_bits(self):
        model, features = fixture()
        edited, audit = prepare.backoff_model(model, features)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'], [10., 20., 10., 40., 10., 60., 10., 40.])
        records = {row['leaf']: row for row in audit['trees'][0]['emptyLeaves']}
        self.assertEqual(records[4]['prefixLength'], 2)
        self.assertEqual(records[4]['prefixBits'], 0)
        self.assertEqual(records[4]['ancestorLeaves'], [0, 4])
        self.assertEqual(records[7]['ancestorLeaves'], [3, 7])

    def test_empty_parent_requires_first_supported_grandparent(self):
        model, features = fixture()
        _, audit = prepare.backoff_model(model, features)
        records = {row['leaf']: row for row in audit['trees'][0]['emptyLeaves']}
        self.assertEqual(records[2]['prefixLength'], 1)
        self.assertEqual(records[2]['ancestorLeaves'], [0, 2, 4, 6])
        self.assertEqual(records[2]['ancestorSupport'], 2)
        self.assertEqual(records[2]['after'], 10.)

    def test_root_backoff_when_every_more_specific_prefix_is_empty(self):
        model, features = fixture([2, 0, 0, 0, 0, 0, 0, 0], [10., 0., 0., 0., 0., 0., 0., 0.])
        edited, audit = prepare.backoff_model(model, features)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'], [10.] * 8)
        record = next(row for row in audit['trees'][0]['emptyLeaves'] if row['leaf'] == 1)
        self.assertEqual(record['prefixLength'], 0)
        self.assertEqual(record['ancestorSupport'], 2)

    def test_nonuniform_original_support_and_no_replacement_feedback(self):
        model, features = fixture([2, 1, 0, 0, 0, 4, 0, 0], [10., 20., 0., 0., 0., 60., 0., 0.])
        edited, audit = prepare.backoff_model(model, features)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'][3], 52.)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'][7], 52.)
        for row in audit['trees'][0]['emptyLeaves']:
            if row['leaf'] in (3, 7):
                self.assertEqual(row['prefixLength'], 1)
                self.assertEqual(row['ancestorSupport'], 5)

    def test_repeated_split_and_unreachable_leaf_preserve_training_raw(self):
        model = {'oblivious_trees': [{'splits': [split(0, .5), split(0, 1.5)],
                                     'leaf_values': [10., 20., 0., 30.], 'leaf_weights': [2, 1, 0, 3]}],
                 'scale_and_bias': [2., [3.]]}
        features = np.array([[0.], [0.], [1.], [2.], [2.], [2.]])
        edited, audit = prepare.backoff_model(model, features)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'][2], 10.)
        self.assertEqual(audit['emptyLeafCount'], 1)
        self.assertEqual(audit['trainingRawMaximumDifference'], 0.)
        np.testing.assert_array_equal(prepare.shared.raw_predict(model, features), prepare.shared.raw_predict(edited, features))

    def test_supported_zero_unchanged_and_zero_backoff_can_remain_zero(self):
        model, features = fixture([2, 1, 0, 0, 0, 0, 0, 0], [0., 4., 0., 0., 0., 0., 0., 0.])
        edited, audit = prepare.backoff_model(model, features)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'][0], 0.)
        self.assertEqual(edited['oblivious_trees'][0]['leaf_values'][4], 0.)
        self.assertLess(audit['changedLeafCount'], audit['emptyLeafCount'])

    def test_input_immutability_scale_bias_and_all_non_leaf_parameters(self):
        model, features = fixture()
        original = copy.deepcopy(model)
        edited, audit = prepare.backoff_model(model, features)
        self.assertEqual(model, original)
        self.assertEqual(edited['scale_and_bias'], original['scale_and_bias'])
        self.assertEqual(edited['model_info'], original['model_info'])
        self.assertEqual(edited['oblivious_trees'][0]['splits'], original['oblivious_trees'][0]['splits'])
        self.assertEqual(edited['oblivious_trees'][0]['leaf_weights'], original['oblivious_trees'][0]['leaf_weights'])
        self.assertEqual(prepare.shared.raw_predict(edited, [[0, 0, 1]])[0], 23.)
        self.assertTrue(audit['supportedLeavesUnchanged'])

    def test_fully_supported_tree_is_serially_identical(self):
        model, features = fixture([1] * 8, list(range(8)))
        edited, audit = prepare.backoff_model(model, features)
        self.assertEqual(prepare.encode(model), prepare.encode(edited))
        self.assertEqual(audit['emptyLeafCount'], 0)

    def test_nonzero_original_empty_leaf_is_rejected(self):
        model, features = fixture()
        model['oblivious_trees'][0]['leaf_values'][2] = .01
        with self.assertRaisesRegex(ValueError, 'nonzero_empty_leaf'):
            prepare.backoff_model(model, features)

    def test_wrong_original_support_or_native_routing_is_rejected(self):
        model, features = fixture()
        model['oblivious_trees'][0]['leaf_weights'][0] += 1
        with self.assertRaisesRegex(ValueError, 'original_leaf_support_mismatch'):
            prepare.backoff_model(model, features)
        model, features = fixture()
        native_routes = prepare.shared.leaf_routes(model, features)
        native_routes[0, 0] += 1
        with self.assertRaisesRegex(ValueError, 'native_training_routing_mismatch'):
            prepare.backoff_model(model, features, native_routes)

    def test_nonfinite_original_values_and_empty_training_are_rejected(self):
        model, features = fixture()
        model['oblivious_trees'][0]['leaf_values'][0] = float('nan')
        with self.assertRaisesRegex(ValueError, 'nonfinite_original_leaf_values'):
            prepare.backoff_model(model, features)
        with self.assertRaisesRegex(ValueError, 'nonempty_original_training_required'):
            prepare.backoff_model(model, [])

    def test_existing_output_is_rejected_without_reading_missing_plan(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'exclusive_new_output_required'):
                prepare.run(Path(folder) / 'missing-plan.json', folder)

    def test_unfrozen_plan_is_rejected_before_model_access(self):
        with tempfile.TemporaryDirectory() as folder:
            plan = Path(folder) / 'plan.json'
            plan.write_text('{}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'original_frozen_plan_hash_required'):
                prepare.run(plan, Path(folder) / 'new')
            self.assertFalse((Path(folder) / 'new').exists())


if __name__ == '__main__':
    unittest.main()
