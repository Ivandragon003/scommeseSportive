import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prepare_current_challenger as task
import train


def fixtures():
    months = ['2025-01', '2025-03', '2025-05', '2025-07']
    names = ['train', 'selection', 'calibration', 'test']
    parts, rows = {}, []
    for name, month in zip(names, months):
        parts[name] = {'n': 5, 'from': f'{month}-01T00:00:00Z', 'to': f'{month}-20T00:00:00Z',
                       'availableThrough': f'{month}-21T00:00:00Z', 'matchIdsHash': 'a' * 64}
        for day in range(2, 7):
            rows.append({'matchId': f'{name}-{day}', 'forecastAt': f'{month}-{day:02}T00:00:00Z',
                         'availableAt': f'{month}-{day:02}T04:00:00Z'})
    plan = {'folds': [{'fold': 5, 'trainingSplit': {'protocol': train.SPLIT_PROTOCOL, **parts}}]}
    return rows, plan


class CurrentChallengerTests(unittest.TestCase):
    def test_last_frozen_fold_and_boundary_purge(self):
        rows, plan = fixtures()
        rows.append({'matchId': 'late-label', 'forecastAt': '2025-01-10T00:00:00Z',
                     'availableAt': '2025-03-01T00:00:00Z'})
        original = copy.deepcopy((rows, plan))
        groups, manifest, fold = task.split_rows(rows, plan)
        self.assertEqual((rows, plan), original)
        self.assertEqual(fold, 5)
        self.assertEqual([len(g) for g in groups], [5, 5, 5, 5])
        self.assertNotIn('late-label', [r['matchId'] for g in groups for r in g])
        self.assertEqual(manifest['train']['from'], plan['folds'][0]['trainingSplit']['train']['from'])

    def test_invalid_plan_and_insufficient_split_fail(self):
        rows, plan = fixtures()
        plan['folds'][0]['trainingSplit']['selection']['from'] = '2025-01-01T00:00:00Z'
        with self.assertRaises(ValueError): task.split_rows(rows, plan)
        rows, plan = fixtures()
        with self.assertRaises(ValueError): task.split_rows(rows[:5], plan)

    def test_manifest_and_clean_provenance_are_required(self):
        rows, plan = fixtures()
        baseline = {'protocolVersion': 'current-a-statistical-asof-v2', 'version': 'A-real', 'fingerprint': 'a' * 64}
        dataset = {'baselineManifest': baseline}
        with self.assertRaisesRegex(ValueError, 'current_baseline_manifest_required'):
            task.prepare_dataset(dataset, plan, {**baseline, 'version': 'A-other'})
        with patch.object(train, 'checked_dataset', return_value=(train.LEGACY_FEATURES, rows, {'protectedRowsUsed': 0})), \
             patch.object(train, 'checked_data_quality', return_value=None):
            with self.assertRaisesRegex(ValueError, 'clean_dataset_provenance_required'):
                task.prepare_dataset(dataset, plan, baseline)

    def test_fixed_recipe_and_protected_exclusion(self):
        self.assertEqual(task.RECIPE, {'kind': 'calibrated_ensemble', 'iterations': 120, 'depth': 5,
            'learningRate': .05, 'seed': 20261027, 'threadCount': 2, 'weight': .75, 'temperature': .8})
        protected = train.protected_holdout_policy()['protectedOriginalFinalMatchIds'][0]
        row = {'matchId': 'clean', 'features': [1], 'featureNames': ['x'], 'featureSchema': 'v',
               'forecastAt': '2025-01-01T10:00:00Z', 'kickoffAt': '2025-01-01T12:00:00Z',
               'availableAt': '2025-01-01T14:00:00Z', 'modelFitAt': '2025-01-01T09:00:00Z',
               'homeGoals': 1, 'awayGoals': 0}
        dataset = {'featureNames': ['x'], 'schemaVersion': 'v', 'asOf': '2025-01-02T00:00:00Z',
                   'rows': [row, {**row, 'matchId': protected}]}
        _, retained, protection = train.checked_dataset(dataset)
        self.assertEqual([r['matchId'] for r in retained], ['clean'])
        self.assertEqual(protection['protectedRowsUsed'], 0)


if __name__ == '__main__': unittest.main()
