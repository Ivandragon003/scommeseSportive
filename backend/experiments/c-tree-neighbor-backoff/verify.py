"""Independent verification of nearest-neighbor leaf editing and retrospective probabilities."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from catboost import CatBoostRegressor, __version__ as catboost_version

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    'previous_numeric_verification', Path(__file__).parent.parent / 'c-tree-sample-projection/verify.py')
SHARED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SHARED)


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_leaves(original, candidate):
    """Independently enumerate binary split decisions and minimize their L1 distance."""
    assert {k: v for k, v in original.items() if k != 'oblivious_trees'} == {
        k: v for k, v in candidate.items() if k != 'oblivious_trees'}
    assert len(original['oblivious_trees']) == len(candidate['oblivious_trees'])
    error, edited, empty, affected = 0.0, 0, 0, 0
    distances = {}
    for old, new in zip(original['oblivious_trees'], candidate['oblivious_trees']):
        assert {k: v for k, v in old.items() if k != 'leaf_values'} == {
            k: v for k, v in new.items() if k != 'leaf_values'}
        weights = np.asarray(old['leaf_weights'], dtype=float)
        before, after = np.asarray(old['leaf_values']), np.asarray(new['leaf_values'])
        assert before.shape == after.shape == weights.shape
        assert np.isfinite(after).all() and np.isfinite(weights).all() and (weights >= 0).all()
        depth = len(old['splits'])
        assert len(before) == 2 ** depth and weights.sum() == 5293
        supported = weights > 0
        assert supported.any() and np.array_equal(before[supported], after[supported])
        assert np.all(before[~supported] == 0)
        decisions = np.array([[int(bit) for bit in format(index, f'0{depth}b')]
                              for index in range(len(weights))])
        for leaf in np.flatnonzero(~supported):
            empty += 1
            differences = np.abs(decisions[supported] - decisions[leaf]).sum(axis=1)
            distance = int(differences.min())
            assert distance >= 1
            distances[distance] = distances.get(distance, 0) + 1
            nearest = differences == distance
            expected = np.average(before[supported][nearest], weights=weights[supported][nearest])
            error = max(error, abs(float(after[leaf]) - float(expected)))
        edited += int(np.sum(after != before))
        affected += int(np.any(after != before))
    assert error < 1e-12
    return {'emptyLeaves': empty, 'changedLeaves': edited, 'editedTrees': affected,
            'minimumDistanceCounts': distances, 'maximumReplacementError': error,
            'supportedLeavesIdentical': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    assert not args.out.exists()
    plan, report = read(args.plan), read(args.run / 'comparison.json')
    current_file = ROOT / 'backend/current-models/challenger.json'
    current, candidate = read(current_file), read(args.run / 'candidate.json')
    assert plan['protocol'] == report['protocol'] == 'c-tree-neighbor-backoff-v1'
    assert report['planHash'] == candidate['experimentPlanHash'] == digest(args.plan)
    assert report['candidateHash'] == digest(args.run / 'candidate.json')
    assert digest(current_file) == plan['incumbentArtifactHash']
    for key in ['diagnosticOnly', 'productionAdoptionEligible', 'productionValidated', 'independentEvidence']:
        assert candidate[key] is (key == 'diagnosticOnly')
    assert datetime.fromisoformat(plan['createdAt']) < datetime.fromisoformat(candidate['createdAt'].replace('Z', '+00:00'))
    assert candidate['createdAt'] <= report['diagnosticStartedAt'] <= report['completedAt']
    for source, expected in plan['sourceHashes'].items():
        assert digest(ROOT / source) == expected, source
    for key in ['featureNames', 'featureSchema', 'weight', 'temperature', 'trainingSplit', 'baselineVersion',
                'trainedThrough', 'validationThrough', 'datasetHash', 'hyperparameters']:
        assert candidate[key] == current[key], key
    assert candidate['calibrationProfilesV2']['A'] == current['calibrationProfilesV2']['A']
    leaf_checks = {side: verify_leaves(current['models'][side], candidate['models'][side])
                   for side in ['home', 'away']}
    assert leaf_checks['home']['emptyLeaves'] == 805 and leaf_checks['away']['emptyLeaves'] == 838

    previous = read(ROOT / 'backend/artifacts/research/c-tree-empty-leaf-backoff-20261108/run/comparison.json')
    previous_rows = {row['matchId']: row for row in previous['rows']}
    assert set(previous_rows) == {row['matchId'] for row in report['rows']} and len(report['rows']) == 652
    for row in report['rows']:
        old = previous_rows[row['matchId']]
        assert {k: v for k, v in row.items() if k != 'forecasts'} == {k: v for k, v in old.items() if k != 'forecasts'}
        assert row['forecasts']['incumbent'] == old['forecasts']['incumbent']

    dataset = read(ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json')
    by_id = {row['matchId']: row for row in dataset['rows']}
    indices = [dataset['featureNames'].index(name) for name in current['featureNames']]
    split = current['trainingSplit']
    train = [row for row in dataset['rows'] if split['train']['from'] <= row['forecastAt'] <= split['train']['to']
             and row['availableAt'] < split['selection']['from']]
    assert len(train) == 5293
    assert hashlib.sha256('\n'.join(sorted(row['matchId'] for row in train)).encode()).hexdigest() == split['train']['matchIdsHash']
    historical = [row for row in report['rows'] if row['season'] != '2026/2027']
    calibration = candidate['calibrationPredictions']
    assert {row['matchId'] for row in calibration} == {row['matchId'] for row in current['calibrationPredictions']}
    assert len(calibration) == 358 and len(historical) == 595
    for row in calibration:
        source = by_id[row['matchId']]
        assert all(row[k] == source[k] for k in ['homeGoals', 'awayGoals', 'availableAt', 'forecastAt'])
        assert row['availableAt'] <= candidate['validationThrough']
    check_rows = [by_id[row['matchId']] for row in historical] + [by_id[row['matchId']] for row in calibration]
    features = np.asarray([[row['features'][i] for i in indices] for row in check_rows])
    training_features = np.asarray([[row['features'][i] for i in indices] for row in train])
    native, training_raw, support_error = {}, {}, 0.0
    with tempfile.TemporaryDirectory(prefix='c-neighbor-leaf-verify-') as temp:
        for family, artifact in [('incumbent', current), ('candidate', candidate)]:
            native[family], training_raw[family] = {}, {}
            for side in ['home', 'away']:
                file = Path(temp) / f'{family}-{side}.json'
                file.write_text(json.dumps(artifact['models'][side]), encoding='utf-8')
                model = CatBoostRegressor().load_model(str(file), format='json')
                native[family][side] = np.exp(model.predict(features, prediction_type='RawFormulaVal'))
                training_raw[family][side] = model.predict(training_features, prediction_type='RawFormulaVal')
                if family == 'incumbent':
                    routes = model.calc_leaf_indexes(training_features, thread_count=2)
                    for index, tree in enumerate(artifact['models'][side]['oblivious_trees']):
                        counts = np.bincount(routes[:, index], minlength=len(tree['leaf_values']))
                        support_error = max(support_error, float(np.max(np.abs(counts - tree['leaf_weights']))))
    assert support_error == 0
    assert all(np.array_equal(training_raw['incumbent'][side], training_raw['candidate'][side]) for side in ['home', 'away'])
    native_error, calibration_matrix_error = 0.0, 0.0
    for index, source in enumerate(check_rows):
        for family in ['incumbent', 'candidate']:
            matrix, probabilities = SHARED.joint_probabilities(source, native[family]['home'][index],
                native[family]['away'][index], current['weight'], current['temperature'])
            if index < len(historical):
                actual = np.array([historical[index]['forecasts'][family]['raw'][key] for key in ['homeWin', 'draw', 'awayWin']])
                native_error = max(native_error, float(np.max(np.abs(probabilities - actual))))
            elif family == 'candidate':
                expected = calibration[index - len(historical)]['matrixC']
                calibration_matrix_error = max(calibration_matrix_error, float(np.max(np.abs(matrix - expected))))
    assert native_error < 1e-12 and calibration_matrix_error < 1e-12

    metric_error, calibration_error = 0.0, 0.0
    cohorts = {'all': report['rows'], 'historical': historical,
               'current': [row for row in report['rows'] if row['season'] == '2026/2027']}
    cohorts.update({league: [row for row in report['rows'] if row['competition'] == league]
                    for league in report['summary']['byLeague']})
    for cohort, rows in cohorts.items():
        summary = report['summary'].get(cohort, report['summary']['byLeague'].get(cohort))
        labels = np.array([0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1 for row in rows])
        for family, artifact in [('incumbent', current), ('candidate', candidate)]:
            raw = np.array([[row['forecasts'][family]['raw'][key] for key in ['homeWin', 'draw', 'awayWin']] for row in rows])
            profile = artifact['calibrationProfilesV2']['C']['byFamily']['goal_1x2']
            knots = np.array([[point['x'], point['y']] for point in profile['points']])
            count = profile['nObservations']
            alpha = .90 if count < 200 else max(.10, 1 / (1 + count / 1000))
            calibrated = np.clip(alpha * raw + (1 - alpha) * np.interp(raw, knots[:, 0], knots[:, 1]), .01, .99)
            calibrated /= calibrated.sum(axis=1)[:, None]
            actual = np.array([[row['forecasts'][family]['calibrated'][key] for key in ['homeWin', 'draw', 'awayWin']] for row in rows])
            calibration_error = max(calibration_error, float(np.max(np.abs(calibrated - actual))))
            for stage in ['raw', 'calibrated', 'decision']:
                p = np.array([[row['forecasts'][family][stage][key] for key in ['homeWin', 'draw', 'awayWin']] for row in rows])
                scores = {'logLoss': float(-np.log(p[np.arange(len(rows)), labels]).mean()),
                          'brier': float(((p - np.eye(3)[labels]) ** 2).sum(axis=1).mean())}
                for key, value in scores.items():
                    metric_error = max(metric_error, abs(value - summary[stage][family][key]))
    assert metric_error < 1e-12 and calibration_error < 1e-12
    for source, expected in plan['sourceHashes'].items():
        assert digest(ROOT / source) == expected
    result = {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'scriptHash': digest(Path(__file__)),
              'planHash': digest(args.plan), 'comparisonHash': digest(args.run / 'comparison.json'),
              'candidateHash': digest(args.run / 'candidate.json'), 'catboostVersion': catboost_version,
              'leafChecks': leaf_checks, 'nativeOriginalLeafSupportMaximumError': support_error,
              'nativeTrainingRawPredictionsExactlyUnchanged': True, 'nativeTrainingRows': len(train),
              'nativeHistoricalRowsPerModel': len(historical), 'nativeRawProbabilityMaximumError': native_error,
              'nativeCalibrationMatrixRows': len(calibration), 'nativeCalibrationMatrixMaximumError': calibration_matrix_error,
              'independentCalibrationMaximumError': calibration_error, 'independentPrimaryMetricsMaximumError': metric_error,
              'sameCohortQuotesAndIncumbentForecastsAsPrevious': True, 'incumbentAndPinnedSourcesUnchanged': True,
              'independentPredictiveEvidence': False, 'productionAdoptionEligible': False}
    with args.out.open('x', encoding='utf-8') as handle:
        json.dump(result, handle, indent=2); handle.write('\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
