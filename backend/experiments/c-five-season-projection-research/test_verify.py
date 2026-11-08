"""Synthetic-only tests of the five-season independent verifier."""
import copy
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
import numpy as np

SPEC = importlib.util.spec_from_file_location('five_season_verifier_under_test', Path(__file__).with_name('verify.py'))
V = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(V)


class VerifierTests(unittest.TestCase):
    def test_explicit_source56_to_original40_mapping(self):
        names = V.ML.LEGACY_FEATURES
        source = names + [f'extra_{i}' for i in range(16)]
        row = {'features': list(range(56))}
        self.assertTrue(np.array_equal(V.project_inputs([row], source, names), np.asarray([list(range(40))])))
        with self.assertRaises(AssertionError): V.project_inputs([{'features': list(range(40))}], source, names)
        with self.assertRaises(ValueError): V.project_inputs([row], source[:39] + ['missing'] + source[40:], names)
        row['features'][55] = float('nan')
        with self.assertRaises(AssertionError): V.project_inputs([row], source, names)

    def test_frozen_chronology_and_label_purging(self):
        limits = {'trainBefore': '2021-03-01T00:00:00Z', 'calibrationFrom': '2021-05-01T00:00:00Z',
                  'testFrom': '2021-07-01T00:00:00Z', 'testTo': '2022-07-01T00:00:00Z'}
        def p(forecast, available): return V.partition({'forecastAt': forecast, 'availableAt': available}, limits)
        self.assertEqual(p('2021-02-28T03:07:00Z', '2021-02-28T22:00:00Z'), 'train')
        self.assertIsNone(p('2021-02-28T03:07:00Z', '2021-03-01T00:00:00Z'))
        self.assertEqual(p('2021-03-01T03:07:00Z', '2021-03-01T22:00:00Z'), 'reserved')
        self.assertEqual(p('2021-05-01T03:07:00Z', '2021-05-01T22:00:00Z'), 'calibration')
        self.assertIsNone(p('2021-06-30T03:07:00Z', '2021-07-01T00:00:00Z'))
        self.assertEqual(p('2021-07-01T03:07:00Z', '2021-07-01T22:00:00Z'), 'test')

    def test_conditional_expectation_projection_and_forbidden_changes(self):
        names = [f'feature{i}' for i in range(40)]; names[1], names[17] = 'home_sample', 'away_sample'
        tree = {'splits': [{'split_type': 'FloatFeature', 'float_feature_index': 8, 'border': 1},
                          {'split_type': 'FloatFeature', 'float_feature_index': 2, 'border': 0}],
                'leaf_values': [1, 3, 5, 7], 'leaf_weights': [1, 3, 2, 2]}
        original = {'features_info': {'float_features': [{'feature_index': 8, 'flat_feature_index': 1},
                                                       {'feature_index': 2, 'flat_feature_index': 0}]},
                    'scale_and_bias': [1, [0]], 'oblivious_trees': [copy.deepcopy(tree) for _ in range(120)]}
        projected = copy.deepcopy(original)
        for item in projected['oblivious_trees']: item['leaf_values'] = [2.5, 2.5, 6, 6]
        result = V.projection_check(original, projected, names)
        self.assertLess(result['maximumProjectionError'], 1e-12)
        self.assertLess(result['maximumWeightedTreeMeanError'], 1e-12)
        changed = copy.deepcopy(projected); changed['oblivious_trees'][0]['leaf_values'][0] = 3
        with self.assertRaises(AssertionError): V.projection_check(original, changed, names)
        changed = copy.deepcopy(projected); changed['oblivious_trees'][0]['leaf_weights'][0] = 2
        with self.assertRaises(AssertionError): V.projection_check(original, changed, names)

    def test_season_week_bootstrap_and_partial_quote_metrics_match_javascript(self):
        rows = []
        for i in range(6):
            forecasts = {}
            for arm, probabilities in [('original', [.4, .3, .3]), ('projected', [.45, .3, .25])]:
                p = dict(zip(['homeWin', 'draw', 'awayWin'], probabilities)) | {'over25': .55, 'under25': .45, 'btts': .6, 'bttsNo': .4}
                forecasts[arm] = {'raw': p, 'calibrated': p, 'decision': p if i % 2 else None}
            rows.append({'matchId': str(i), 'testSeason': '2021/2022' if i < 3 else '2022/2023',
                         'kickoffAt': f'2021-08-{1+i:02d}T12:00:00Z', 'homeGoals': i % 3, 'awayGoals': i % 2,
                         'closingQuoteAvailable': bool(i % 2), 'forecasts': forecasts})
        code = "const {compareRows}=require('./backend/experiments/c-five-season-projection-research/evaluate.cjs');process.stdout.write(JSON.stringify(compareRows(JSON.parse(process.argv[1]),{replications:200,seed:20261108})));"
        expected = json.loads(subprocess.run(['node', '-e', code, json.dumps(rows)], cwd=V.ROOT, capture_output=True, text=True, check=True).stdout)
        self.assertLess(V.compare_metrics(rows, expected, replications=200), 1e-12)
        self.assertEqual(expected['raw']['n'], 6); self.assertEqual(expected['decision']['n'], 3)
        self.assertGreaterEqual(expected['raw']['pairedWeekly95PercentInterval']['blocks'], 2)

    def test_current_pipeline_replay_preserves_missing_decision(self):
        points = [{'x': 0, 'y': 0}, {'x': 1, 'y': 1}]
        profile = {'protocol': 'existing-isotonic-v1', 'targetProtocol': 'joint_1x2_normalized-v2', 'calibrationPoints': points,
                   'byFamily': {}, 'nObservations': 30, 'matches': 10, 'fittedThrough': '2021-06-30T20:00:00Z', 'learnedBlendWeights': {}}
        self.assertIn('goal_1x2', V.effective_profile(profile)['byFamily']); self.assertEqual(profile['byFamily'], {})
        payload = {'profiles': {'2021': {'original': profile, 'projected': profile}}, 'rows': [{'matchId': 'synthetic-only',
            'year': 2021, 'forecastAt': '2021-08-01T03:07:00Z', 'quotes': [], 'matrices': {arm: [[1 / 9] * 3 for _ in range(3)] for arm in ['original', 'projected']}}]}
        with tempfile.TemporaryDirectory(prefix='five-season-replay-toy-') as directory:
            file = Path(directory) / 'toy.json'; file.write_text(json.dumps(payload))
            output = json.loads(subprocess.run(['node', '-e', V.REPLAY, str(V.ROOT), str(file)], cwd=V.ROOT, capture_output=True, text=True, check=True).stdout)
        self.assertIsNone(output['rows'][0]['forecasts']['original']['decision'])
        self.assertEqual(output['rows'][0]['forecasts']['original'], output['rows'][0]['forecasts']['projected'])


if __name__ == '__main__': unittest.main()
