"""Temporal and provenance checks; synthetic rows do not measure performance."""
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
import prepare_refreshed_challenger as task
import train


def fixture():
    baseline = {'protocolVersion': 'current-a-statistical-asof-v2', 'version': 'A-fixture', 'fingerprint': 'a' * 64}
    names = train.LEGACY_FEATURES + train.FEATURE_BLOCKS['recent_xg'] + train.FEATURE_BLOCKS['schedule']
    policy = train.challenger_data_quality_policy()
    digest = train.json_stringify_hash(policy)
    schedule = {'hour': 3, 'minute': 7, 'timezone': 'Europe/Rome'}
    rows = []
    for part, month, count in (('train', '2025-12', 5), ('calibration', '2026-01', 5), ('diagnostic', '2026-08', 2)):
        for day in range(2, count + 2):
            kickoff = f'{month}-{day:02}T16:00:00Z'
            rows.append({'matchId': f'{part}-{day}', 'features': list(range(len(names))), 'featureNames': names,
                'featureSchema': train.CHALLENGER_SCHEMA,
                'forecastAt': datetime.fromtimestamp(train.resolve_nightly_forecast_at(kickoff, schedule), timezone.utc).isoformat().replace('+00:00', 'Z'),
                'kickoffAt': kickoff, 'availableAt': f'{month}-{day:02}T18:00:00Z',
                'modelFitAt': '2025-01-01T00:00:00Z', 'baselineVersion': baseline['version'],
                'homeGoals': 1, 'awayGoals': 0, 'competition': 'Serie A', 'season': 'synthetic',
                'baselineMatrix': [[.4, .1], [.2, .3]], 'baselineProbabilities': {'homeWin': .2, 'draw': .7, 'awayWin': .1},
                'lambdaHome': 1.2, 'lambdaAway': .8,
                'dataQualityPolicyHash': digest, 'dataQualityBaselineClean': True})
    population = {'inputRows': len(rows), 'retainedRows': len(rows), 'excludedRows': 0, 'excludedMatchIds': []}
    dataset = {'schemaVersion': train.CHALLENGER_SCHEMA, 'featureNames': names, 'rows': rows,
        'featureBlocks': ['recent_xg', 'schedule'], 'baselineManifest': baseline, 'asOf': '2026-09-01T00:00:00Z',
        'forecastTiming': {'policy': 'nightly-europe-rome-v1', 'forecastBeforeKickoff': True, 'resultDelayMs': 7200000},
        'decisionSchedule': schedule, 'dataQualityPolicy': policy, 'dataQualityPolicyHash': digest,
        'dataQualityBaselineClean': True, 'dataQualityEvidence': {'policyVersion': policy['version'], 'policyHash': digest,
            'action': 'quarantine_not_timestamp_correction', 'history': copy.deepcopy(population), 'targets': copy.deepcopy(population)}}
    incumbent_raw = json.dumps({'version': 'C-incumbent', 'baselineVersion': baseline['version']}).encode()
    plan = {'protocol': task.PROTOCOL, 'recipe': copy.deepcopy(task.RECIPE), 'datasetHash': task.sha256(json.dumps(dataset).encode()),
        'baselineVersion': baseline['version'], 'incumbentVersion': 'C-incumbent', 'incumbentArtifactHash': task.sha256(incumbent_raw),
        'trainBefore': task.TRAIN_BEFORE, 'calibrationFrom': task.TRAIN_BEFORE, 'calibrationBefore': task.CALIBRATION_BEFORE,
        'expectedPartitions': {part: {'n': 5, 'matchIdsHash': task.match_ids_hash([r for r in rows if r['matchId'].startswith(part)])}
                               for part in ('train', 'calibration')}}
    return dataset, plan, incumbent_raw


class FakeModel:
    def predict(self, features, prediction_type):
        if prediction_type != 'RawFormulaVal':
            raise AssertionError('native parity must use raw prediction')
        return np.zeros(len(features))


class RefreshedChallengerTests(unittest.TestCase):
    def test_temporal_boundaries_purge_labels_and_reserve_diagnostics(self):
        dataset, plan, _ = fixture()
        rows = dataset['rows']
        rows.extend([
            {'matchId': 'late-train-label', 'forecastAt': '2025-12-31T22:00:00Z', 'availableAt': task.TRAIN_BEFORE},
            {'matchId': 'late-cal-label', 'forecastAt': '2026-06-30T22:00:00Z', 'availableAt': task.CALIBRATION_BEFORE},
            {'matchId': 'exact-diagnostic-boundary', 'forecastAt': task.CALIBRATION_BEFORE, 'availableAt': '2026-07-01T04:00:00Z'}])
        before = copy.deepcopy(rows)
        groups, split = task.split_rows(rows, plan)
        self.assertEqual(rows, before)
        self.assertEqual([len(groups[p]) for p in ('train', 'calibration', 'diagnostic', 'purged')], [5, 5, 3, 2])
        self.assertEqual(split['independentTest']['n'], 0)
        self.assertNotIn('selection', split)
        self.assertNotIn('test', split)
        self.assertLess(train.timestamp(split['train']['availableThrough']), train.timestamp(task.TRAIN_BEFORE))
        self.assertLess(train.timestamp(split['calibration']['availableThrough']), train.timestamp(task.CALIBRATION_BEFORE))
        # A forecast exactly at the lower calibration boundary belongs to calibration.
        rows[5]['forecastAt'] = task.TRAIN_BEFORE
        self.assertEqual(len(task.split_rows(rows, plan)[0]['calibration']), 5)

    def test_plan_binds_recipe_input_incumbent_and_partition_identity(self):
        dataset, plan, incumbent = fixture()
        task.checked_plan(plan, plan['datasetHash'], plan['baselineVersion'], incumbent)
        for key, value, error in (
                ('recipe', {**task.RECIPE, 'depth': 6}, 'fixed_temporal'),
                ('trainBefore', '2026-02-01T00:00:00Z', 'fixed_temporal'),
                ('calibrationFrom', '2025-12-01T00:00:00Z', 'fixed_temporal'),
                ('calibrationBefore', '2026-08-01T00:00:00Z', 'fixed_temporal'),
                ('datasetHash', 'b' * 64, 'dataset_mismatch'),
                ('baselineVersion', 'A-other', 'dataset_mismatch'),
                ('incumbentArtifactHash', 'b' * 64, 'incumbent_mismatch'),
                ('incumbentVersion', 'C-other', 'incumbent_mismatch'),
                ('expectedPartitions', {}, 'partition_evidence')):
            changed = {**plan, key: value}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, error):
                task.checked_plan(changed, plan['datasetHash'], plan['baselineVersion'], incumbent)
        changed = copy.deepcopy(plan)
        changed['expectedPartitions']['train']['matchIdsHash'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'partition_mismatch'):
            task.split_rows(dataset['rows'], changed)

    def test_controlled_validation_projection_and_protected_exclusion(self):
        dataset, plan, _ = fixture()
        protected = train.protected_holdout_policy()['protectedOriginalFinalMatchIds'][0]
        dataset['rows'].append({**dataset['rows'][0], 'matchId': protected})
        names, groups, _, holdout, _ = task.prepare_dataset(dataset, plan, dataset['baselineManifest'])
        self.assertEqual(names, train.LEGACY_FEATURES)
        self.assertEqual(len(groups['train'][0]['features']), 40)
        self.assertEqual(holdout['excludedInTrainer'], 1)
        self.assertEqual(holdout['protectedRowsUsed'], 0)
        self.assertNotIn(protected, [r['matchId'] for rows in groups.values() for r in rows])
        with self.assertRaisesRegex(ValueError, 'current_baseline_manifest_required'):
            task.prepare_dataset(dataset, plan, {**dataset['baselineManifest'], 'additionalCurrentField': 1})
        dataset['rows'][0]['baselineVersion'] = 'A-other'
        with self.assertRaisesRegex(ValueError, 'dataset_baseline_mismatch'):
            task.prepare_dataset(dataset, plan, dataset['baselineManifest'])

    def test_unclean_quarantined_and_future_information_fail(self):
        for change, error in (
                (lambda d: d.update(dataQualityBaselineClean=False), 'data_quality_policy'),
                (lambda d: d['rows'][0].update(matchId=d['dataQualityPolicy']['entries'][0]['matchId']), 'quarantined'),
                (lambda d: d['rows'][0].update(maxTrainingAvailableAt='2026-09-02T00:00:00Z'), 'future_feature'),
                (lambda d: d['rows'][0].update(forecastAt='2025-12-02T01:00:00Z'), 'nightly')):
            dataset, plan, _ = fixture()
            change(dataset)
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                task.prepare_dataset(dataset, plan, dataset['baselineManifest'])

    def test_run_fits_only_train_and_exports_only_calibration_predictions(self):
        dataset, plan, incumbent = fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inputs = root / 'input.json'
            inputs.write_text(json.dumps(dataset), encoding='utf-8')
            plan_path = root / 'plan.json'
            plan_path.write_text(json.dumps(plan), encoding='utf-8')
            incumbent_path = root / 'incumbent.json'
            incumbent_path.write_bytes(incumbent)
            output = root / 'result'
            bundle = {'home': FakeModel(), 'away': FakeModel()}
            with patch.object(task, 'INCUMBENT_PATH', incumbent_path), \
                 patch.object(task.current, 'current_manifest', return_value=dataset['baselineManifest']), \
                 patch.object(train, 'catboost_version', '1.2.8'), \
                 patch.object(train, 'train_candidates', return_value=({task.RECIPE['kind']: bundle}, {task.RECIPE['kind']: {'home': {}, 'away': {}}})) as fit, \
                 patch.object(train, 'raw_matrices', side_effect=lambda rows, *_: [np.array([[.4, .1], [.2, .3]]) for _ in rows]) as predict:
                version = task.run(inputs, output, plan_path)
                self.assertTrue(version.startswith('C-'))
                self.assertEqual([r['matchId'] for r in fit.call_args.args[0]], [f'train-{i}' for i in range(2, 7)])
                self.assertEqual(fit.call_args.args[3:5], (120, 5))
                self.assertEqual(fit.call_args.kwargs, {'kinds': ('calibrated_ensemble',)})
                self.assertEqual([r['matchId'] for r in predict.call_args.args[0]], [f'calibration-{i}' for i in range(2, 7)])
                artifact = json.loads((output / 'artifact.json').read_text())
                report = json.loads((output / 'report.json').read_text())
                parity = json.loads((output / 'parity.json').read_text())
                self.assertEqual(len(artifact['calibrationPredictions']), 5)
                self.assertEqual(artifact['availability'], 'local_refreshed_candidate')
                self.assertFalse(artifact['productionValidated'])
                self.assertFalse(artifact['independentEvidence'])
                self.assertIsNone(report['metrics'])
                self.assertEqual(len(parity['rows']), 12)
                self.assertEqual(json.loads(inputs.read_text()), dataset)
                with self.assertRaisesRegex(ValueError, 'new_output_directory_required'):
                    task.run(inputs, output, plan_path)
                with self.assertRaisesRegex(ValueError, 'new_output_directory_required'):
                    task.run(inputs, inputs, plan_path)

    def test_input_changed_during_fit_prevents_artifact(self):
        dataset, plan, incumbent = fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inputs, plan_path, incumbent_path = (root / name for name in ('input.json', 'plan.json', 'incumbent.json'))
            inputs.write_text(json.dumps(dataset), encoding='utf-8')
            plan_path.write_text(json.dumps(plan), encoding='utf-8')
            incumbent_path.write_bytes(incumbent)
            def mutate_input(*args, **kwargs):
                inputs.write_text('{}', encoding='utf-8')
                return {task.RECIPE['kind']: {'home': FakeModel(), 'away': FakeModel()}}, {task.RECIPE['kind']: {}}
            with patch.object(task, 'INCUMBENT_PATH', incumbent_path), \
                 patch.object(task.current, 'current_manifest', return_value=dataset['baselineManifest']), \
                 patch.object(train, 'catboost_version', '1.2.8'), \
                 patch.object(train, 'train_candidates', side_effect=mutate_input), \
                 patch.object(train, 'raw_matrices', return_value=[np.array([[.4, .1], [.2, .3]])] * 5):
                with self.assertRaisesRegex(ValueError, 'sources_changed_during_training'):
                    task.run(inputs, root / 'result', plan_path)
            self.assertFalse((root / 'result/artifact.json').exists())


if __name__ == '__main__':
    unittest.main()
