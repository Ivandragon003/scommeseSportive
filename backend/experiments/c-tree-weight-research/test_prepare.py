import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

SPEC = importlib.util.spec_from_file_location('weight_prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def model():
    return {'oblivious_trees': [{'splits': [{'split_type': 'FloatFeature', 'float_feature_index': 0, 'border': .5}],
                                 'leaf_values': [0., (index + 1) / 100], 'leaf_weights': [1, 1]}
                                for index in range(120)], 'scale_and_bias': [2.5, [-.2]],
             'model_info': {'sentinel': 'same'}}


def row(match_id, forecast, available, home=1, away=0):
    return {'matchId': match_id, 'forecastAt': forecast, 'availableAt': available, 'competition': 'league',
            'homeGoals': home, 'awayGoals': away, 'features': [1.], 'baselineMatrix': np.ones((11, 11)).tolist()}


class PrepareTests(unittest.TestCase):
    def test_entire_tree_scaling_only_correct_blocks_and_zero_leaves_stay_zero(self):
        original = model()
        before = copy.deepcopy(original)
        scaled = prepare.scale_model(original, [.5, 1.2, 2.])
        self.assertEqual(original, before)
        for index, tree in enumerate(scaled['oblivious_trees']):
            self.assertEqual(tree['leaf_values'], [0., before['oblivious_trees'][index]['leaf_values'][1] * [.5, 1.2, 2.][index // 40]])
            for key in ('leaf_weights', 'splits'):
                self.assertEqual(tree[key], original['oblivious_trees'][index][key])
        self.assertEqual(scaled['scale_and_bias'], original['scale_and_bias'])
        self.assertEqual(scaled['model_info'], original['model_info'])

    def test_blocks_reconstruct_scaled_inference_with_nonunit_scale_and_bias(self):
        original = model()
        x = np.array([[0.], [1.]])
        blocks, bias = prepare.block_features(original, x)
        point = np.array([.5, 1.2, 1.8])
        scaled = prepare.scale_model(original, point)
        np.testing.assert_allclose(blocks @ point + bias, prepare.shared.raw_predict(scaled, x), atol=1e-12, rtol=0)
        np.testing.assert_allclose(blocks.sum(axis=1) + bias, prepare.shared.raw_predict(original, x), atol=1e-12, rtol=0)

    def test_membership_fixed_and_fit_labels_available_before_cutoff(self):
        fit = row('fit', '2025-09-20T00:00:00Z', '2025-09-21T00:00:00Z')
        validation = row('validation', '2025-10-02T00:00:00Z', '2025-10-03T00:00:00Z')
        rows = [fit, validation]
        plan = {'parameterDevelopment': {'cutoff': '2025-10-01T00:00:00Z', 'fit': prepare.manifest([fit]),
                                         'validation': prepare.manifest([validation]), 'originalSelection': prepare.manifest(rows)}}
        a, b, manifests = prepare.development_rows(rows, plan)
        self.assertEqual(a, [fit])
        self.assertEqual(b, [validation])
        self.assertEqual(manifests['refit']['n'], 2)
        broken = copy.deepcopy(rows)
        broken[0]['availableAt'] = '2025-10-01T00:00:00Z'
        with self.assertRaisesRegex(ValueError, 'unpurged_parameter_development'):
            prepare.development_rows(broken, plan)

    def test_only_selection_rows_supply_optimizer_labels_and_identity_stops_at_four_fits(self):
        fit = row('fit', '2025-09-20T00:00:00Z', '2025-09-21T00:00:00Z', 2, 1)
        validation = row('validation', '2025-10-02T00:00:00Z', '2025-10-03T00:00:00Z', 0, 2)
        selection = [fit, validation]
        plan = {'parameterDevelopment': {'cutoff': '2025-10-01T00:00:00Z', 'fit': prepare.manifest([fit]),
                                         'validation': prepare.manifest([validation]), 'originalSelection': prepare.manifest(selection)},
                'intervention': {'ridgeGrid': [10., 1., .1, .01], 'optimizer': {}}}
        calls = []
        def fake_fit(blocks, biases, baseline, labels, ridge, optimizer):
            calls.append((len(blocks), labels.tolist(), ridge))
            return {'weights': [1.] * 6, 'converged': True, 'optimizer': {'success': True}}
        with patch.object(prepare.weights, 'fit_weights', side_effect=fake_fit):
            report = prepare.select_weights({'home': model(), 'away': model()}, selection, plan)
        self.assertEqual(calls, [(1, [0], ridge) for ridge in (10., 1., .1, .01)])
        self.assertFalse(report['decision']['acceptedNonIdentity'])
        self.assertIsNone(report['finalFit'])
        self.assertEqual(report['validationRows'][0]['actualClass'], 2)

    def test_identity_stop_writes_only_selection_exclusively(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'new'
            prepare.write_selection_only(output, '{"identity":true}')
            self.assertEqual([file.name for file in output.iterdir()], ['selection.json'])
            with self.assertRaises(FileExistsError):
                prepare.write_selection_only(output, '{}')

    def test_final_refit_consumes_all_selection_labels_only_after_choice(self):
        fit = row('fit', '2025-09-20T00:00:00Z', '2025-09-21T00:00:00Z', 2, 1)
        validation = row('validation', '2025-10-02T00:00:00Z', '2025-10-03T00:00:00Z', 0, 2)
        selection = [fit, validation]
        plan = {'parameterDevelopment': {'cutoff': '2025-10-01T00:00:00Z', 'fit': prepare.manifest([fit]),
                                         'validation': prepare.manifest([validation]), 'originalSelection': prepare.manifest(selection)},
                'intervention': {'ridgeGrid': [10., 1., .1, .01], 'optimizer': {}}}
        events = []
        def fake_fit(blocks, biases, baseline, labels, ridge, optimizer):
            events.append(('fit', labels.tolist(), ridge))
            return {'weights': [1.] * 6, 'converged': True, 'optimizer': {'success': True}}
        def fake_choice(fits, identity):
            events.append(('choice',))
            return {'acceptedNonIdentity': True, 'selectedFitIndex': 1, 'selectedRidge': 1.}
        with patch.object(prepare.weights, 'fit_weights', side_effect=fake_fit), patch.object(prepare.weights, 'choose_fit', side_effect=fake_choice):
            report = prepare.select_weights({'home': model(), 'away': model()}, selection, plan)
        self.assertEqual(events[:4], [('fit', [0], ridge) for ridge in (10., 1., .1, .01)])
        self.assertEqual(events[4:], [('choice',), ('fit', [0, 2], 1.)])
        self.assertTrue(report['finalFit']['converged'])
        self.assertEqual(report['finalFit']['metrics']['n'], 2)

    def test_invalid_weights_and_wrong_tree_count_rejected(self):
        with self.assertRaisesRegex(ValueError, 'invalid_block_weights'):
            prepare.scale_model(model(), [1., 1., -1.])
        original = model()
        original['oblivious_trees'].pop()
        with self.assertRaisesRegex(ValueError, 'original_120_trees_required'):
            prepare.block_features(original, [[0.]])

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
