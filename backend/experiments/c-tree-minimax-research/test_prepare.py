import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

SPEC = importlib.util.spec_from_file_location('minimax_prepare_tested', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def score(ll=1., brier=.6):
    return {'logLoss': ll, 'brier': brier, 'n': 317,
            'byLeague': {f'league{i}': {'logLoss': ll, 'brier': brier, 'n': 50} for i in range(5)}}


def model():
    return {'oblivious_trees': [{'splits': [{'split_type': 'FloatFeature', 'float_feature_index': 0, 'border': .5}],
                                 'leaf_values': [0., (index + 1) / 100], 'leaf_weights': [1, 1]}
                                for index in range(120)], 'scale_and_bias': [2.5, [-.2]], 'model_info': {'keep': 'metadata'}}


class PrepareTests(unittest.TestCase):
    def test_strict_global_and_every_league_gate_then_higher_ridge_tie(self):
        fits = [{'ridge': .1, 'admissible': True, 'validationMetrics': score(.9, .5)},
                {'ridge': 10., 'admissible': True, 'validationMetrics': score(.9 + 5e-13, .5)}]
        self.assertEqual(prepare.choose_fit(fits, score())['selectedFitIndex'], 1)
        for league in score()['byLeague']:
            for metric in ('logLoss', 'brier'):
                rejected = copy.deepcopy(fits[0])
                rejected['validationMetrics']['byLeague'][league][metric] = score()['byLeague'][league][metric]
                self.assertFalse(prepare.choose_fit([rejected], score())['acceptedNonIdentity'])
        rejected = copy.deepcopy(fits[0])
        rejected['validationMetrics']['brier'] = .6
        self.assertFalse(prepare.choose_fit([rejected], score())['acceptedNonIdentity'])

    def test_numerically_invalid_attempt_cannot_become_eligible(self):
        fits = [{'ridge': .1, 'admissible': False, 'validationMetrics': None},
                {'ridge': 10., 'admissible': False, 'validationMetrics': score(.1, .1)}]
        self.assertEqual(prepare.choose_fit(fits, score()), {'acceptedNonIdentity': False, 'selectedFitIndex': None, 'selectedRidge': None})

    def test_optimizer_receives_only_supplied_training_labels_once_per_frozen_ridge(self):
        rng = np.random.default_rng(71)
        train_inputs = (rng.normal(.1, .1, (15, 2, 3)), np.array([0., 0.]), rng.uniform(.01, 1., (15, 11, 11)))
        rows = [{'competition': f'league{i // 3}', 'homeGoals': 1 if i % 3 == 0 else 0,
                 'awayGoals': 1 if i % 3 == 2 else 0} for i in range(15)]
        plan = {'intervention': {'ridgeGrid': [10., 1., .1, .01], 'optimizer': {'scipyVersion': '1.17.0'}, 'solutionChecks': {}}}
        calls = []
        def fake_fit(risks, ridge, optimizer, checks):
            calls.append((risks.labels.tolist(), ridge))
            return {'ridge': ridge, 'admissible': False, 'failureReasons': ['synthetic_failure']}
        with patch.object(prepare.minimax, 'fit', side_effect=fake_fit):
            _, records = prepare.fit_training_models(train_inputs, rows, plan)
        self.assertEqual(calls, [(list(np.arange(15) % 3), ridge) for ridge in (10., 1., .1, .01)])
        self.assertEqual(len(records), 4)
        self.assertTrue(all('weightsFrozenAt' in record for record in records))

    def test_entire_original_block_scaling_preserves_zero_support_metadata_scale_and_bias(self):
        original = model()
        snapshot = copy.deepcopy(original)
        candidate = prepare.scale_admitted_model(original, [.5, 1.2, 1.8], 1e-12)
        self.assertEqual(original, snapshot)
        for index, tree in enumerate(candidate['oblivious_trees']):
            self.assertEqual(tree['leaf_values'], [0., snapshot['oblivious_trees'][index]['leaf_values'][1] * [.5, 1.2, 1.8][index // 40]])
            for key in ('splits', 'leaf_weights'):
                self.assertEqual(tree[key], original['oblivious_trees'][index][key])
        self.assertEqual(candidate['scale_and_bias'], original['scale_and_bias'])
        self.assertEqual(candidate['model_info'], original['model_info'])

    def test_frozen_bounds_tolerance_does_not_clip_solver_weights(self):
        original = model()
        factor = 2. + 5e-13
        candidate = prepare.scale_admitted_model(original, [factor, 1., 1.], 1e-12)
        self.assertEqual(candidate['oblivious_trees'][0]['leaf_values'][1], original['oblivious_trees'][0]['leaf_values'][1] * factor)
        self.assertNotEqual(candidate['oblivious_trees'][0]['leaf_values'][1], original['oblivious_trees'][0]['leaf_values'][1] * 2.)
        with self.assertRaisesRegex(ValueError, 'inadmissible_block_weights'):
            prepare.scale_admitted_model(original, [2. + 2e-12, 1., 1.], 1e-12)

    def test_exclusive_output_and_frozen_plan_guards(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'exclusive_new_output_required'):
                prepare.run(Path(folder) / 'missing.json', folder)
            plan = Path(folder) / 'plan.json'
            plan.write_text('{}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'original_frozen_plan_hash_required'):
                prepare.run(plan, Path(folder) / 'new')

    def test_actual_frozen_plan_passes_runtime_version_guard_without_any_fit(self):
        plan = prepare.ROOT / 'backend/artifacts/research/c-tree-minimax-research-20261108/plan.json'
        class StopBeforeTraining(Exception):
            pass
        with tempfile.TemporaryDirectory() as folder, patch.object(prepare, 'check_sources'), \
                patch.object(prepare.current, 'current_manifest', return_value={}), \
                patch.object(prepare.current, 'prepare_dataset', side_effect=StopBeforeTraining) as prepare_data, \
                patch.object(prepare, 'fit_training_models') as fit:
            output = Path(folder) / 'new'
            with self.assertRaises(StopBeforeTraining):
                prepare.run(plan, output)
            prepare_data.assert_called_once()
            fit.assert_not_called()
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
