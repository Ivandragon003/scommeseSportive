"""Synthetic tests of independent verification; never scores experiment observations."""
import copy
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('newton_verify_under_test', Path(__file__).with_name('verify.py'))
V = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(V)


def models():
    old = {'features_info': {}, 'oblivious_trees': [{'splits': []} for _ in range(120)],
           'model_info': {'params': {'tree_learner_options': {'leaf_estimation_iterations': 10, 'leaf_estimation_backtracking': 'AnyImprovement', 'l2_leaf_reg': 3},
                'flat_params': {'random_seed': 20261027}, 'cat_feature_params': {'ctr_leaf_count_limit': 18446744073709552000}}}}
    new = copy.deepcopy(old)
    new['model_info']['params']['tree_learner_options']['leaf_estimation_iterations'] = 1
    new['model_info']['params']['flat_params'] |= {'leaf_estimation_iterations': 1, 'l2_leaf_reg': 3}
    new['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] = 18446744073709551615
    return old, new


class VerifyTests(unittest.TestCase):
    def test_exact_documented_counter_rounding_only(self):
        original, model = models()
        model['features_info'] = {'float_features': []}
        model['oblivious_trees'][0]['leaf_values'] = [.25]
        staged = {side: copy.deepcopy(model) for side in ['home', 'away']}
        final = copy.deepcopy(staged)
        for side in ['home', 'away']:
            final[side]['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] = 18446744073709552000
        receipt = V.verify_staged_models(staged, final)
        self.assertTrue(all(row['normalizationApplied'] for row in receipt.values()))
        self.assertEqual(staged['home']['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'], 18446744073709551615)
        self.assertFalse(V.verify_staged_models(staged, staged)['home']['normalizationApplied'])
        guard_models, normalized_receipt = V.parameter_guard_models(staged, final)
        self.assertEqual(normalized_receipt, receipt)
        V.parameter_guard(original, guard_models['home'])
        self.assertEqual(final['home']['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'], 18446744073709552000)
        self.assertEqual(guard_models['home']['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'], 18446744073709551615)
        changed = copy.deepcopy(final)
        changed['home']['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] = 18446744073709552001
        with self.assertRaisesRegex(AssertionError, 'Undocumented counter'):
            V.verify_staged_models(staged, changed)
        for kind in ['categorical_features', 'text_features', 'embedding_features']:
            active_staged, active_final = copy.deepcopy(staged), copy.deepcopy(final)
            active_staged['home']['features_info'][kind] = [{}]
            active_final['home']['features_info'][kind] = [{}]
            with self.assertRaisesRegex(AssertionError, 'Active feature type'):
                V.verify_staged_models(active_staged, active_final)
        changed = copy.deepcopy(final)
        changed['home']['oblivious_trees'][0]['leaf_values'][0] += .001
        with self.assertRaisesRegex(AssertionError, 'beyond documented'):
            V.verify_staged_models(staged, changed)

    def test_only_leaf_iteration_parameter_changes(self):
        old, new = models(); V.parameter_guard(old, new)
        for mutate in [lambda m: m['model_info']['params']['flat_params'].__setitem__('random_seed', 1),
                       lambda m: m['model_info']['params']['tree_learner_options'].__setitem__('leaf_estimation_backtracking', 'No'),
                       lambda m: m['model_info']['params']['tree_learner_options'].__setitem__('leaf_estimation_iterations', 2)]:
            invalid = copy.deepcopy(new); mutate(invalid)
            with self.assertRaises(AssertionError): V.parameter_guard(old, invalid)

    def test_negative_development_still_requires_full_comparison(self):
        for passed in [False, True]:
            self.assertTrue(V.fixed_decision({'variantFixedBeforeOutcomes': True, 'variant': V.VARIANT,
                'fullDiagnosticRequired': True, 'developmentFiveLeagueCriterionPassed': passed}))
        with self.assertRaises(AssertionError): V.fixed_decision({'variantFixedBeforeOutcomes': True, 'variant': V.VARIANT,
                'fullDiagnosticRequired': False, 'developmentFiveLeagueCriterionPassed': False})

    def test_each_pinned_target_field_is_checked(self):
        target = {'matchId': 'toy', 'homeGoals': 2, 'awayGoals': 1, 'competition': 'League', 'season': '2026/2027', 'kickoffAt': '2026-01-01T12:00:00Z'}
        V.verify_target_row(target, target)
        for key, value in [('homeGoals', 3), ('awayGoals', 0), ('competition', 'Other'), ('season', '2025/2026'), ('kickoffAt', '2026-01-02T12:00:00Z')]:
            changed = dict(target); changed[key] = value
            with self.assertRaisesRegex(AssertionError, key): V.verify_target_row(changed, target)

    def test_all31_gate_flags_match_current_pinned_javascript(self):
        def stats(): return {stage: {'deltaCandidateMinusIncumbent': {'logLoss': -.01, 'brier': -.01, 'eceTopLabel10Bins': 0},
                'pairedWeekly95PercentInterval': {'intervals': {metric: {'lower': -.02, 'upper': -.001} for metric in ['logLoss', 'brier']}}}
                for stage in ['raw', 'calibrated', 'decision']}
        summary = {'all': stats(), 'byLeague': {str(i): stats() for i in range(5)}}
        code = "const {evaluateGate}=require('./backend/experiments/c-tree-sample-projection/evaluate.cjs');process.stdout.write(JSON.stringify(evaluateGate(JSON.parse(process.argv[1]),{minimumLeaguesWithBothLowerAtBothStages:5})));"
        criterion = json.loads(subprocess.run(['node', '-e', code, json.dumps(summary)], cwd=V.ROOT, capture_output=True, text=True, check=True).stdout)
        V.verify_gates(summary, criterion)
        self.assertEqual(len(criterion['gates']), 31)
        criterion['gates'][1]['passed'] = False
        with self.assertRaises(AssertionError): V.verify_gates(summary, criterion)

    def test_current_pipeline_replay_on_synthetic_native_matrix(self):
        points = [{'x': 0, 'y': 0}, {'x': 1, 'y': 1}]
        profile = {'protocol': 'existing-isotonic-v1', 'targetProtocol': 'joint_1x2_normalized-v2', 'calibrationPoints': points,
            'byFamily': {'goal_1x2': {'points': points, 'nObservations': 1074}}, 'nObservations': 1074, 'matches': 358,
            'fittedThrough': '2025-12-30T22:15:00.000Z', 'learnedBlendWeights': {}}
        quotes = [{'selection': selection, 'side': side, 'market': '1x2', 'bookmaker': 'Bet365', 'source': 'football_data_csv',
            'priceType': 'closing', 'capturedAt': '2026-11-08T12:00:00Z', 'timestampEvidence': 'observed_snapshot', 'odds': odds}
            for selection, side, odds in [('homeWin', 'home', 2.1), ('draw', 'draw', 3.1), ('awayWin', 'away', 3.7)]]
        matrix = [[1 / 9] * 3 for _ in range(3)]
        payload = {'profiles': {'incumbent': profile, 'candidate': profile}, 'rows': [{'matchId': 'synthetic_only',
            'forecastAt': '2026-01-02T03:07:00Z', 'quotes': quotes, 'matrices': {'incumbent': matrix, 'candidate': matrix}}]}
        with tempfile.TemporaryDirectory(prefix='newton-replay-toy-') as directory:
            file = Path(directory) / 'toy.json'; file.write_text(json.dumps(payload))
            output = json.loads(subprocess.run(['node', '-e', V.REPLAY, str(V.ROOT), str(file)], cwd=V.ROOT, capture_output=True, text=True, check=True).stdout)
        result = output['rows'][0]['forecasts']
        self.assertEqual(result['incumbent'], result['candidate'])
        self.assertAlmostEqual(sum(result['candidate']['decision'][key] for key in ['homeWin', 'draw', 'awayWin']), 1)


if __name__ == '__main__': unittest.main()
