"""Protocol and data-boundary tests; mock predictions do not prove accuracy."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prepare_seed_ensemble_challenger as task
import train


def fixture():
    baseline = {'protocolVersion': 'current-a-statistical-asof-v2', 'version': 'A-fixture', 'fingerprint': 'a' * 64}
    names = train.LEGACY_FEATURES + train.FEATURE_BLOCKS['recent_xg'] + train.FEATURE_BLOCKS['schedule']
    policy = train.challenger_data_quality_policy()
    digest = train.json_stringify_hash(policy)
    schedule = {'hour': 3, 'minute': 7, 'timezone': 'Europe/Rome'}
    rows, groups = [], []
    for part, month in zip(task.PARTITIONS, ('2025-01', '2025-03', '2025-05', '2025-07')):
        group = []
        for day in range(2, 7):
            kickoff = f'{month}-{day:02}T16:00:00Z'
            group.append({'matchId': f'{part}-{day}', 'features': list(range(len(names))), 'featureNames': names,
                'featureSchema': train.CHALLENGER_SCHEMA,
                'forecastAt': datetime.fromtimestamp(train.resolve_nightly_forecast_at(kickoff, schedule), timezone.utc).isoformat().replace('+00:00', 'Z'),
                'kickoffAt': kickoff, 'availableAt': f'{month}-{day:02}T18:00:00Z',
                'modelFitAt': '2024-01-01T00:00:00Z', 'baselineVersion': baseline['version'],
                'homeGoals': 1, 'awayGoals': 0, 'competition': f'League {day}', 'season': 'synthetic',
                'baselineMatrix': [[.4, .1], [.2, .3]], 'baselineProbabilities': {'homeWin': .2, 'draw': .7, 'awayWin': .1},
                'lambdaHome': 1.2, 'lambdaAway': .8,
                'dataQualityPolicyHash': digest, 'dataQualityBaselineClean': True})
        rows.extend(group)
        groups.append(group)
    population = {'inputRows': len(rows), 'retainedRows': len(rows), 'excludedRows': 0, 'excludedMatchIds': []}
    dataset = {'schemaVersion': train.CHALLENGER_SCHEMA, 'featureNames': names, 'rows': rows,
        'featureBlocks': ['recent_xg', 'schedule'], 'baselineManifest': baseline, 'asOf': '2025-08-01T00:00:00Z',
        'forecastTiming': {'policy': 'nightly-europe-rome-v1', 'forecastBeforeKickoff': True, 'resultDelayMs': 7200000},
        'decisionSchedule': schedule, 'dataQualityPolicy': policy, 'dataQualityPolicyHash': digest,
        'dataQualityBaselineClean': True, 'dataQualityEvidence': {'policyVersion': policy['version'], 'policyHash': digest,
            'action': 'quarantine_not_timestamp_correction', 'history': copy.deepcopy(population), 'targets': copy.deepcopy(population)}}
    split = train.split_manifest(*groups)
    for part in task.PARTITIONS:
        split[part].update(observedFrom=split[part]['from'], observedTo=split[part]['to'])
    incumbent = {'version': 'C-incumbent', 'baselineVersion': baseline['version'],
        'datasetHash': task.sha256(json.dumps(dataset).encode()), 'trainingSplit': split,
        'hyperparameters': task.RECIPE.copy(), 'featureNames': train.LEGACY_FEATURES,
        'candidateKind': task.RECIPE['kind'], 'weight': task.RECIPE['weight'], 'temperature': task.RECIPE['temperature'],
        'models': {side: {'oblivious_trees': [{}] * 120} for side in ('home', 'away')}}
    incumbent_raw = json.dumps(incumbent).encode()
    plan = {'protocol': task.PROTOCOL, 'baseRecipe': task.RECIPE.copy(),
        'datasetHash': incumbent['datasetHash'], 'baselineVersion': baseline['version'],
        'incumbentVersion': incumbent['version'], 'incumbentArtifactHash': task.sha256(incumbent_raw),
        'seeds': task.SEEDS.copy(), 'memberWeights': task.MEMBER_WEIGHTS.copy(), 'aggregation': task.AGGREGATION,
        'trainingSplit': copy.deepcopy(split), 'selectionGate': copy.deepcopy(task.SELECTION_RULE),
        'maximumStrategies': 1, 'maximumMemberFits': 5, 'productionAdoption': False,
        'expectedPartitions': {part: {key: split[part][key] for key in ('n', 'matchIdsHash')} for part in task.PARTITIONS}}
    return dataset, plan, incumbent_raw


class FakeModel:
    def __init__(self, raw=0., trees=120):
        self.raw = raw
        self.tree_count_ = trees

    def predict(self, features, prediction_type):
        if prediction_type != 'RawFormulaVal':
            raise AssertionError('native predictions must use raw log intensity')
        return np.full(len(features), self.raw)


def model_bundles():
    members = [{side: FakeModel(index * .1) for side in ('home', 'away')} for index in range(5)]
    combined = {side: FakeModel(.2, 600) for side in ('home', 'away')}
    return members, combined


def metric_fixture():
    return {'logLoss': 1., 'brier': .6,
            'byLeague': {f'League {i}': {'logLoss': 1., 'brier': .6} for i in range(5)}}


class SeedEnsembleTests(unittest.TestCase):
    def test_plan_rejects_seed_weight_recipe_aggregation_and_gate_tuning(self):
        _, plan, incumbent = fixture()
        self.assertEqual(task.checked_plan(plan, plan['datasetHash'], plan['baselineVersion'], incumbent)['version'], 'C-incumbent')
        for key, value in (
                ('baseRecipe', {**task.RECIPE, 'depth': 6}), ('seeds', [20261028] * 5),
                ('memberWeights', [.4, .3, .1, .1, .1]), ('aggregation', 'mean_exp_intensity'),
                ('selectionGate', {**task.SELECTION_RULE, 'minimumLeaguesBothStrictlyBetter': 3}),
                ('maximumStrategies', 2), ('maximumMemberFits', 6), ('productionAdoption', True)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'fixed_seed_ensemble_plan'):
                task.checked_plan({**plan, key: value}, plan['datasetHash'], plan['baselineVersion'], incumbent)
        for key in ('datasetHash', 'baselineVersion', 'incumbentVersion', 'incumbentArtifactHash'):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'mismatch'):
                task.checked_plan({**plan, key: 'changed'}, plan['datasetHash'], plan['baselineVersion'], incumbent)
        changed = copy.deepcopy(plan)
        changed['trainingSplit']['train']['n'] += 1
        with self.assertRaisesRegex(ValueError, 'original_split'):
            task.checked_plan(changed, plan['datasetHash'], plan['baselineVersion'], incumbent)
        changed = copy.deepcopy(plan)
        changed['expectedPartitions']['selection']['matchIdsHash'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'partition_evidence'):
            task.checked_plan(changed, plan['datasetHash'], plan['baselineVersion'], incumbent)

    def test_original_frozen_partitions_identity_and_label_purge(self):
        dataset, plan, _ = fixture()
        before = copy.deepcopy(dataset)
        groups, split = task.split_rows(dataset['rows'], plan)
        self.assertEqual(dataset, before)
        self.assertEqual(split, plan['trainingSplit'])
        self.assertEqual(list(groups), list(task.PARTITIONS))
        self.assertEqual([len(group) for group in groups.values()], [5] * 4)
        for change in ('identity', 'late-label', 'forecast-window'):
            rows = copy.deepcopy(dataset['rows'])
            if change == 'identity':
                rows[0]['matchId'] = 'another-match'
            elif change == 'late-label':
                rows[0]['availableAt'] = split['selection']['from']
            else:
                rows[0]['forecastAt'] = '2024-12-31T00:00:00Z'
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'partition_mismatch'):
                task.split_rows(rows, plan)
        changed = copy.deepcopy(plan)
        changed['trainingSplit']['train']['availableThrough'] = plan['trainingSplit']['selection']['from']
        with self.assertRaisesRegex(ValueError, 'leaky'):
            task.split_rows(dataset['rows'], changed)

    def test_controlled_features_protection_quality_and_future_information(self):
        dataset, plan, _ = fixture()
        protected = train.protected_holdout_policy()['protectedOriginalFinalMatchIds'][0]
        dataset['rows'].append({**dataset['rows'][0], 'matchId': protected})
        names, rows, groups, _, protection, _ = task.prepare_dataset(dataset, plan, dataset['baselineManifest'])
        self.assertEqual(names, train.LEGACY_FEATURES)
        self.assertTrue(all(len(row['features']) == 40 for row in rows))
        self.assertEqual(protection['excludedInTrainer'], 1)
        self.assertEqual(protection['protectedRowsUsed'], 0)
        self.assertNotIn(protected, [r['matchId'] for group in groups.values() for r in group])
        with self.assertRaisesRegex(ValueError, 'current_baseline_manifest'):
            task.prepare_dataset(dataset, plan, {**dataset['baselineManifest'], 'version': 'A-other'})
        for change, error in (
                (lambda d: d.update(dataQualityBaselineClean=False), 'data_quality_policy'),
                (lambda d: d['rows'][0].update(matchId=d['dataQualityPolicy']['entries'][0]['matchId']), 'quarantined'),
                (lambda d: d['rows'][0].update(maxTrainingAvailableAt='2025-09-01T00:00:00Z'), 'future_feature'),
                (lambda d: d['rows'][0].update(baselineVersion='A-other'), 'dataset_baseline_mismatch')):
            dataset, plan, _ = fixture()
            change(dataset)
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                task.prepare_dataset(dataset, plan, dataset['baselineManifest'])

    def test_five_fixed_seed_members_use_identical_training_population(self):
        dataset, plan, _ = fixture()
        names, _, groups, *_ = task.prepare_dataset(dataset, plan, dataset['baselineManifest'])
        fitted = []
        class Estimator(FakeModel):
            def __init__(self, **params):
                super().__init__()
                self.params = params
            def fit(self, pool):
                fitted.append((self.params, pool.get_features(), pool.get_label()))
        def combine(models, weights):
            self.assertEqual(len(models), 5)
            self.assertEqual(weights, [.2] * 5)
            return FakeModel(0., 600)
        with patch.object(task, 'CatBoostRegressor', Estimator), patch.object(task, 'sum_models', side_effect=combine) as combine_mock:
            members, combined = task.train_members(groups['train'], names)
        self.assertEqual(len(members), 5)
        self.assertEqual(combine_mock.call_count, 2)
        self.assertEqual([params['random_seed'] for params, _, _ in fitted], [seed for seed in task.SEEDS for _ in range(2)])
        for params, features, labels in fitted:
            self.assertEqual(params['iterations'], 120)
            self.assertEqual(params['depth'], 5)
            self.assertEqual(params['learning_rate'], .05)
            self.assertEqual(params['loss_function'], 'Poisson')
            np.testing.assert_array_equal(features, [row['features'] for row in groups['train']])
            self.assertEqual(len(labels), 5)
        self.assertEqual(combined['home'].tree_count_, 600)
        for trees in (599, 1001):
            with patch.object(task, 'CatBoostRegressor', Estimator), patch.object(task, 'sum_models', return_value=FakeModel(trees=trees)):
                with self.subTest(trees=trees), self.assertRaisesRegex(ValueError, 'runtime_tree_limit'):
                    task.train_members(groups['train'], names)

    def test_raw_aggregation_control_parity_and_member_diversity(self):
        dataset, plan, _ = fixture()
        _, rows, groups, *_ = task.prepare_dataset(dataset, plan, dataset['baselineManifest'])
        members, combined = model_bundles()
        parity = task.parity_rows(rows, groups, members, combined, members[0])
        self.assertEqual(parity['checkedRows'], 20)
        self.assertEqual(parity['maximumControlIncumbentError'], 0.)
        self.assertLess(parity['maximumNativeAggregationError'], 1e-12)
        self.assertGreater(parity['memberDiversity']['home']['meanRawStandardDeviation'], 0.)
        self.assertEqual(parity['rows'][0]['raw']['home'], [.2])
        self.assertNotAlmostEqual(np.exp(.2), np.mean(np.exp([0., .1, .2, .3, .4])))
        self.assertEqual(len(parity['rows'][0]['rawMembers']), 5)
        combined['home'] = FakeModel(.3)
        with self.assertRaisesRegex(ValueError, 'aggregation_parity_failed'):
            task.parity_rows(rows, groups, members, combined, members[0])
        members, combined = model_bundles()
        with self.assertRaisesRegex(ValueError, 'control_incumbent_raw_parity_failed'):
            task.parity_rows(rows, groups, members, combined, {side: FakeModel(.01) for side in ('home', 'away')})

    def test_selection_gate_requires_both_metrics_global_and_four_leagues(self):
        control, candidate = metric_fixture(), metric_fixture()
        self.assertFalse(task.selection_gate(control, candidate)['passed'])
        candidate.update(logLoss=.99, brier=.59)
        for index in range(4):
            candidate['byLeague'][f'League {index}'].update(logLoss=.99, brier=.59)
        self.assertTrue(task.selection_gate(control, candidate)['passed'])
        self.assertFalse(task.selection_gate(control, candidate)['usedForMemberOrHyperparameterSelection'])
        candidate['brier'] = control['brier']
        self.assertFalse(task.selection_gate(control, candidate)['passed'])
        candidate['brier'] = .59
        candidate['byLeague']['League 3']['brier'] = .6
        self.assertFalse(task.selection_gate(control, candidate)['passed'])
        candidate['byLeague'].pop('League 4')
        with self.assertRaisesRegex(ValueError, 'five_leagues'):
            task.selection_gate(control, candidate)

    def run_fixture(self, directory, mutate=False):
        dataset, plan, incumbent_raw = fixture()
        root = Path(directory)
        inputs, plan_path, incumbent_path = (root / name for name in ('input.json', 'plan.json', 'incumbent.json'))
        inputs.write_text(json.dumps(dataset), encoding='utf-8')
        plan_path.write_text(json.dumps(plan), encoding='utf-8')
        incumbent_path.write_bytes(incumbent_raw)
        members, combined = model_bundles()
        def fit(*_):
            if mutate:
                inputs.write_text('{}', encoding='utf-8')
            return members, combined
        def export(_, path):
            value = {'oblivious_trees': [{}] * 600}
            path.write_text(json.dumps(value), encoding='utf-8')
            return value
        with patch.object(task, 'INCUMBENT_PATH', incumbent_path), \
             patch.object(task.current, 'current_manifest', return_value=dataset['baselineManifest']), \
             patch.object(train, 'catboost_version', '1.2.8'), \
             patch.object(task, 'train_members', side_effect=fit) as fitting, \
             patch.object(task, 'incumbent_models', return_value=members[0]), \
             patch.object(train, 'export_model', side_effect=export) as exporting, \
             patch.object(train, 'matrix_metrics', wraps=train.matrix_metrics) as metrics, \
             patch.object(train, 'raw_matrices', wraps=train.raw_matrices) as predictions:
            if mutate:
                with self.assertRaisesRegex(ValueError, 'sources_changed_during_training'):
                    task.run(inputs, root / 'result', plan_path)
                self.assertFalse((root / 'result/artifact.json').exists())
                return
            version = task.run(inputs, root / 'result', plan_path)
            self.assertTrue(version.startswith('C-'))
            self.assertTrue(all(row['matchId'].startswith('train-') for row in fitting.call_args.args[0]))
            self.assertEqual(fitting.call_count, 1)
            self.assertEqual(exporting.call_count, 2)
            self.assertTrue(all(row['matchId'].startswith('selection-') for call in metrics.call_args_list for row in call.args[0]))
            self.assertEqual([call.args[0][0]['matchId'].split('-')[0] for call in predictions.call_args_list],
                             ['selection', 'selection', 'calibration'])
        artifact = json.loads((root / 'result/artifact.json').read_text())
        report = json.loads((root / 'result/report.json').read_text())
        self.assertEqual(artifact['trainingSplit'], plan['trainingSplit'])
        self.assertTrue(all(row['matchId'].startswith('calibration-') for row in artifact['calibrationPredictions']))
        self.assertEqual(len(artifact['calibrationPredictions']), 5)
        self.assertEqual(artifact['featureNames'], train.LEGACY_FEATURES)
        self.assertEqual(artifact['status'], 'CANDIDATE')
        self.assertFalse(artifact['productionValidated'])
        self.assertFalse(artifact['independentEvidence'])
        if report['selectionGate']['passed']:
            self.assertNotIn('productionAdoptionEligible', artifact)
        else:
            self.assertFalse(artifact['productionAdoptionEligible'])
        self.assertEqual(artifact['diagnosticOnly'], not report['selectionGate']['passed'])
        self.assertFalse(report['productionAdoption'])
        self.assertEqual(report['outcome'], 'AWAITING_INDEPENDENT_VALIDATION'
                         if report['selectionGate']['passed'] else 'REJECTED_AT_DEVELOPMENT_GATE')
        self.assertIsInstance(report['selectionGate']['passed'], bool)
        self.assertEqual(json.loads(inputs.read_text()), dataset)
        self.assertEqual({path.name for path in (root / 'result').iterdir()}, {'artifact.json', 'report.json', 'parity.json'})
        with self.assertRaisesRegex(ValueError, 'new_output_directory_required'):
            task.run(inputs, root / 'result', plan_path)
        with self.assertRaisesRegex(ValueError, 'new_output_directory_required'):
            task.run(inputs, inputs, plan_path)

    def test_only_training_labels_fit_and_calibration_predictions_export(self):
        with tempfile.TemporaryDirectory() as directory:
            self.run_fixture(directory)

    def test_input_drift_prevents_any_candidate_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            self.run_fixture(directory, mutate=True)


if __name__ == '__main__':
    unittest.main()
