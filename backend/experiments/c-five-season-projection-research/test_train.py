"""Synthetic calendar, membership and projection tests; never fit real models."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

SPEC = importlib.util.spec_from_file_location('annual_fold_training', Path(__file__).with_name('train.py'))
trainer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trainer)


def row(match_id, date, competition, season, available=None):
    return {'matchId': match_id, 'forecastAt': f'{date}T03:07:00Z',
            'availableAt': available or f'{date}T23:00:00Z', 'kickoffAt': f'{date}T18:00:00Z',
            'competition': competition, 'season': season, 'features': [0.] * 40, 'baselineVersion': 'A-test',
            'homeGoals': 1, 'awayGoals': 0}


def synthetic_rows():
    rows = [row(f'initial-{i}', '2019-11-01', league, '2019/2020') for i, league in enumerate(trainer.LEAGUES)]
    for year in trainer.YEARS:
        for i, league in enumerate(trainer.LEAGUES):
            rows.extend([row(f'reserved-{year}-{i}', f'{year}-04-01', league, f'{year - 1}/{year}'),
                         row(f'calibration-{year}-{i}', f'{year}-06-01', league, f'{year - 1}/{year}'),
                         row(f'test-{year}-{i}', f'{year}-09-01', league, f'{year}/{year + 1}')])
    return rows


def frozen_folds(rows):
    return {'folds': [{'year': year, 'memberships': trainer.partition_rows(rows, year)[1]} for year in trainer.YEARS]}


class CalendarTests(unittest.TestCase):
    def test_all_five_folds_and_expanding_training_have_exact_calendar_boundaries(self):
        rows = synthetic_rows()
        folds = trainer.checked_folds(rows, frozen_folds(rows))
        self.assertEqual([year for year, *_ in folds], [2021, 2022, 2023, 2024, 2025])
        self.assertEqual([len(groups['train']) for _, groups, *_ in folds], [5, 20, 35, 50, 65])
        for year, groups, manifests, _ in folds:
            self.assertEqual({part: len(groups[part]) for part in ('reserved', 'calibration', 'test')},
                             {'reserved': 5, 'calibration': 5, 'test': 5 if year == 2025 else 15})
            self.assertTrue(all(trainer.ml.timestamp(row['availableAt']) < trainer.ml.timestamp(trainer.boundaries(year)['trainBefore']) for row in groups['train']))
            reserved = set(manifests['reserved']['matchIds'])
            self.assertFalse(reserved.intersection(manifests['train']['matchIds'] + manifests['calibration']['matchIds'] + manifests['test']['matchIds']))

    def test_inclusive_starts_exclusive_ends_and_label_purging(self):
        rows = synthetic_rows()
        league = trainer.LEAGUES[0]
        late_train = row('late-train', '2021-02-28', league, '2020/2021', '2021-03-01T00:00:00Z')
        february_train = row('february-train', '2021-02-01', league, '2020/2021')
        late_cal = row('late-cal', '2021-06-30', league, '2020/2021', '2021-07-01T00:00:00Z')
        march = row('march-start', '2021-03-01', league, '2020/2021')
        may = row('may-start', '2021-05-01', league, '2020/2021')
        july = row('july-start', '2021-07-01', league, '2021/2022')
        following = row('next-july-start', '2022-07-01', league, '2022/2023')
        groups, manifests, purged = trainer.partition_rows(rows + [late_train, february_train, late_cal, march, may, july, following], 2021)
        self.assertIn('late-train', purged['train'])
        self.assertIn('february-train', manifests['train']['matchIds'])
        self.assertIn('late-cal', purged['calibration'])
        self.assertIn('march-start', manifests['reserved']['matchIds'])
        self.assertIn('may-start', manifests['calibration']['matchIds'])
        self.assertIn('july-start', manifests['test']['matchIds'])
        self.assertNotIn('next-july-start', manifests['test']['matchIds'])
        self.assertEqual(sum(len(group) for group in groups.values()), len(set(sum([item['matchIds'] for item in manifests.values()], []))))

    def test_missing_year_league_or_mismatched_membership_fails_without_scope_reduction(self):
        rows = synthetic_rows()
        plan = frozen_folds(rows)
        plan['folds'].pop()
        with self.assertRaisesRegex(ValueError, 'exactly_five_annual_folds_required'):
            trainer.checked_folds(rows, plan)
        missing = [item for item in rows if not (item['competition'] == trainer.LEAGUES[0]
                   and '2021-07-01' <= item['forecastAt'] < '2022-07-01')]
        with self.assertRaisesRegex(ValueError, 'complete_five_league_partition_required:2021:test'):
            trainer.checked_folds(missing, frozen_folds(rows))
        plan = frozen_folds(rows)
        plan['folds'][0]['memberships']['test']['n'] += 1
        with self.assertRaisesRegex(ValueError, 'frozen_membership_mismatch:2021:test'):
            trainer.checked_folds(rows, plan)

    def test_test_and_calibration_season_mismatches_are_rejected(self):
        rows = synthetic_rows()
        rows[-1]['season'] = '2024/2025'
        with self.assertRaisesRegex(ValueError, 'test_season_mismatch:2025'):
            trainer.partition_rows(rows, 2025)
        rows = synthetic_rows()
        next(item for item in rows if item['matchId'] == 'calibration-2021-0')['season'] = '2021/2022'
        with self.assertRaisesRegex(ValueError, 'calibration_season_mismatch:2021'):
            trainer.partition_rows(rows, 2021)

    def test_membership_order_is_canonical_and_does_not_mutate_rows(self):
        rows = synthetic_rows()[::-1]
        before = copy.deepcopy(rows)
        a = trainer.partition_rows(rows, 2021)[1]
        b = trainer.partition_rows(rows[::-1], 2021)[1]
        self.assertEqual(a, b)
        self.assertEqual(rows, before)


class ProjectionAndRecipeTests(unittest.TestCase):
    def test_projection_uses_variable_training_count_and_original_supports(self):
        names = trainer.ml.LEGACY_FEATURES
        x = np.zeros((5, 40))
        x[:, 1] = [1., 2., 3., 1., 2.]
        x[:, 0] = [0., 0., 0., 1., 1.]
        model = {'oblivious_trees': [{'splits': [{'split_type': 'FloatFeature', 'float_feature_index': 1, 'border': 1.5},
                                                {'split_type': 'FloatFeature', 'float_feature_index': 0, 'border': .5}],
                                     'leaf_values': [.1, .2, .3, .4], 'leaf_weights': [1, 2, 1, 1]}],
                 'scale_and_bias': [1., [0.]]}
        class Native:
            def calc_leaf_indexes(self, features, thread_count):
                return trainer.shared.leaf_routes(model, features)
        original = {'home': copy.deepcopy(model), 'away': copy.deepcopy(model)}
        before = copy.deepcopy(original)
        edited, audit = trainer.project_pair(original, {'home': Native(), 'away': Native()}, names, [{'features': item} for item in x])
        self.assertEqual(original, before)
        np.testing.assert_allclose(edited['home']['oblivious_trees'][0]['leaf_values'], [1 / 6, 1 / 6, .35, .35], atol=1e-15)
        self.assertEqual(audit['home']['trees'][0]['supportCount'], 5)
        self.assertTrue(audit['home']['allLeafSupportsMatch'])

    def test_native_recipe_and_pool_receive_only_given_train_order_no_offset_or_eval_set(self):
        rows = [{'features': [2.] * 40, 'homeGoals': 3, 'awayGoals': 1}, {'features': [1.] * 40, 'homeGoals': 0, 'awayGoals': 2}]
        pools, constructors, calls = [], [], []
        def pool(x, **kwargs):
            pools.append((x.copy(), kwargs))
            return len(pools)
        class Native:
            def __init__(self, **kwargs):
                constructors.append(kwargs)
            def fit(self, *args, **kwargs):
                calls.append((args, kwargs))
        def export(native, path):
            path.write_text('{}', encoding='utf-8')
            return {}
        with tempfile.TemporaryDirectory() as folder, patch.object(trainer.l2, 'Pool', side_effect=pool), \
                patch.object(trainer.l2, 'CatBoostRegressor', Native), patch.object(trainer.ml, 'export_model', side_effect=export):
            trainer.fit_original_pair(rows, trainer.ml.LEGACY_FEATURES, Path(folder))
        self.assertEqual(constructors, [trainer.RECIPE | {'l2_leaf_reg': 3.}] * 2)
        np.testing.assert_array_equal(pools[0][0], [[2.] * 40, [1.] * 40])
        np.testing.assert_array_equal(pools[0][1]['label'], [3., 0.])
        self.assertEqual(set(pools[0][1]), {'label', 'feature_names'})
        self.assertEqual(calls, [((1,), {}), ((2,), {})])

    def test_fold_artifact_has_honest_fresh_split_and_availability_not_c75_partitions(self):
        _, memberships, _ = trainer.partition_rows(synthetic_rows(), 2021)
        models = {'home': {'fold': True}, 'away': {'fold': True}}
        original = trainer.artifact(models, 'original', 2021, {}, 'plan', 'dataset', memberships,
                                    {'version': 'A-test'}, '2026-11-08T00:00:00Z', {'policyHash': 'quality'})
        projected = trainer.artifact(models, 'projected', 2021, {}, 'plan', 'dataset', memberships,
                                     {'version': 'A-test'}, '2026-11-08T00:00:00Z', {'policyHash': 'quality'}, original['version'])
        self.assertEqual(original['trainingSplit']['train']['n'], 5)
        self.assertNotEqual(original['trainingSplit']['protocol'], trainer.ml.SPLIT_PROTOCOL)
        self.assertEqual(original['testSeason'], '2021/2022')
        self.assertEqual(projected['parentVersion'], original['version'])
        self.assertNotIn('parentVersion', original)
        self.assertLess(trainer.ml.timestamp(original['trainedThrough']), trainer.ml.timestamp(trainer.boundaries(2021)['trainBefore']))
        self.assertLess(trainer.ml.timestamp(original['validationThrough']), trainer.ml.timestamp(trainer.boundaries(2021)['testFrom']))
        self.assertFalse(original['productionAdoptionEligible'])


class DatasetAndPlanTests(unittest.TestCase):
    def test_dataset_reproduction_matches_inputs_plan_not_final_execution_hash(self):
        names, rows = trainer.ml.LEGACY_FEATURES, [row('clean', '2020-11-01', trainer.LEAGUES[0], '2020/2021')]
        dataset = {'baselineManifest': {'version': 'A-test'}, 'reproduction': {'planHash': 'inputs'}, 'rows': rows}
        plan = {'inputsPlanHash': 'inputs', 'baselineManifest': dataset['baselineManifest'], 'executionPlanHash': 'different'}
        with patch.object(trainer.current, 'current_manifest', return_value=dataset['baselineManifest']), \
                patch.object(trainer.ml, 'checked_dataset', return_value=(names, rows, {'protectedRowsUsed': 0, 'protectedFinalCount': 745})), \
                patch.object(trainer.ml, 'checked_data_quality', return_value={'policyHash': 'quality'}), \
                patch.object(trainer.ml, 'protected_holdout_policy', return_value={'protectedOriginalFinalMatchIds': ['protected']}), \
                patch.object(trainer.ml, 'challenger_data_quality_policy', return_value={'entries': [{'matchId': f'q{i}'} for i in range(22)]}):
            actual_names, projected_rows, _, _ = trainer.checked_dataset(dataset, plan)
            self.assertEqual(actual_names, names)
            self.assertEqual(len(projected_rows), 1)
            dataset['reproduction']['planHash'] = 'different'
            with self.assertRaisesRegex(ValueError, 'dataset_inputs_plan_mismatch'):
                trainer.checked_dataset(dataset, plan)

    def test_execution_requires_frozen_dataset_hash_and_exclusive_output_before_fit(self):
        with self.assertRaisesRegex(ValueError, 'frozen_dataset_hash_required'):
            trainer.checked_plan({'protocol': trainer.PROTOCOL, 'phase': 'execution', 'datasetHash': 'wrong'}, Path('missing'), 'actual')
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'exclusive_new_output_required'):
                trainer.run(Path(folder) / 'missing-plan', Path(folder) / 'missing-dataset', folder)
            plan, dataset = Path(folder) / 'plan.json', Path(folder) / 'dataset.json'
            plan.write_text('{}', encoding='utf-8')
            dataset.write_text('{}', encoding='utf-8')
            with patch.object(trainer, 'fit_original_pair') as fit, self.assertRaisesRegex(ValueError, 'wrong_execution_protocol'):
                trainer.run(plan, dataset, Path(folder) / 'new')
            fit.assert_not_called()


if __name__ == '__main__':
    unittest.main()
