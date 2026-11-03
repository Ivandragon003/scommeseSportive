import unittest
import argparse
import gzip
import tempfile
from pathlib import Path
import numpy as np
import benchmark


class BenchmarkTests(unittest.TestCase):
    def test_metrics_top_label_ece_and_brier(self):
        result = benchmark.metrics([[.8, .1, .1], [.2, .5, .3]], [0, 2])
        self.assertAlmostEqual(result['accuracy'], .5)
        self.assertAlmostEqual(result['ece'], .35)
        self.assertAlmostEqual(result['brier'], (.06 + .78) / 2)

    def test_feature_cohort_and_finite_values(self):
        doc = {'schemaVersion': 'timesfm-xg-features-v1', 'datasetHash': 'abc', 'featureNames': benchmark.FEATURES,
               'metadata': {'protocolHash': 'protocol', 'sourceMatchesHash': '249233a01c52ddd2578b676ae0a464ecbcce01907e34b89138a23c15e1178dc9',
                            'protectedCount': 745, 'quarantineCount': 22},
               'rows': [{'matchId': 'm', 'wma': [1] * 4, 'timesfm': [2] * 4}]}
        self.assertEqual(len(benchmark.validate_features(doc, 'abc', [{'matchId': 'm'}], 'protocol')), 1)
        with self.assertRaises(ValueError):
            benchmark.validate_features(doc, 'abc', [{'matchId': 'other'}], 'protocol')
        with self.assertRaises(ValueError):
            benchmark.validate_features(doc, 'abc', [{'matchId': 'm'}], 'different-protocol')
        doc['metadata']['quarantineCount'] = 21
        with self.assertRaises(ValueError):
            benchmark.validate_features(doc, 'abc', [{'matchId': 'm'}], 'protocol')
        doc['metadata']['quarantineCount'] = 22
        doc['rows'][0]['timesfm'][0] = float('nan')
        with self.assertRaises(ValueError):
            benchmark.validate_features(doc, 'abc', [{'matchId': 'm'}], 'protocol')

    def test_paired_bootstrap_identical_arms_zero_intervals(self):
        rows = []
        for i in range(16):
            date = np.datetime64('2023-01-02') + np.timedelta64(i * 7, 'D')
            p = [.5, .3, .2]
            rows.append({'kickoffAt': str(date) + 'T12:00:00Z', 'homeGoals': i % 2,
                         'awayGoals': 0, 'predictions': {a: p for a in benchmark.ARMS}})
        for block in (1, 4):
            result = benchmark.bootstrap(rows, block, draws=100)
            for values in result['comparisons'].values():
                for intervals in values.values():
                    self.assertEqual(intervals['0.9'], [0.0, 0.0])
            self.assertEqual(set(result['absolute95']), set(benchmark.ARMS))

    def test_improvement_requires_every_comparator_and_metric(self):
        comparison = {ref: {metric: {'0.9875': [-.01, -.002]} for metric in ('logLoss', 'brier')}
                      for ref in ('c_recipe', 'c_wma')}
        self.assertTrue(benchmark.passes_improvement({'comparisons': comparison}))
        comparison['c_wma']['brier']['0.9875'][1] = -.001
        self.assertFalse(benchmark.passes_improvement({'comparisons': comparison}))

    def test_replay_rejects_incomplete_cohort_before_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prediction_file = root / 'predictions.jsonl.gz'
            prediction_file.write_bytes(gzip.compress(b''))
            output = root / 'output'
            with self.assertRaises(ValueError):
                benchmark.analyze(argparse.Namespace(predictions=prediction_file, out=output))
            self.assertFalse(output.exists())

    def test_league_gate_uses_intersection_of_both_comparisons(self):
        scores = {}
        for index in range(5):
            scores[str(index)] = {'c_timesfm': {'logLoss': 1, 'brier': 1},
                                  'c_recipe': {'logLoss': 2 if index != 0 else .9, 'brier': 2},
                                  'c_wma': {'logLoss': 2 if index != 1 else .9, 'brier': 2}}
        counts, joint = benchmark.improving_leagues(scores)
        self.assertEqual(counts, {'c_recipe': 4, 'c_wma': 4})
        self.assertEqual(joint, ['2', '3', '4'])
        self.assertLess(len(joint), 4)


if __name__ == '__main__':
    unittest.main()
