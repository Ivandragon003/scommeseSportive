"""Independent numeric check of the one frozen tree edit and its diagnostic scores."""
from __future__ import annotations
import argparse
import hashlib
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from catboost import CatBoostRegressor, __version__ as catboost_version


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def joint_probabilities(source, home, away, weight, temperature):
    base = np.array(source['baselineMatrix'], dtype=float)
    base /= base.sum()
    margins = []
    for intensity in [home, away]:
        lam = np.clip(intensity, .05, 8)
        p = [np.exp(-lam)]
        for k in range(1, len(base)):
            p.append(p[-1] * lam / k)
        margins.append(p)
    ml = np.outer(*margins); ml /= ml.sum()
    matrix = np.maximum(1e-15, (1 - weight) * base + weight * ml) ** (1 / temperature)
    matrix /= matrix.sum()
    return matrix, np.array([np.tril(matrix, -1).sum(), matrix.trace(), np.triu(matrix, 1).sum()])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    assert not args.out.exists()
    root = Path(__file__).resolve().parents[3]
    plan = read(args.plan)
    report = read(args.run / 'comparison.json')
    current_file = root / 'backend/current-models/challenger.json'
    current = read(current_file)
    candidate = read(args.run / 'candidate.json')
    assert report['planHash'] == digest(args.plan)
    assert report['candidateHash'] == digest(args.run / 'candidate.json')
    assert digest(current_file) == plan['incumbentArtifactHash']
    assert candidate['experimentPlanHash'] == digest(args.plan)
    assert candidate['diagnosticOnly'] is True and candidate['productionAdoptionEligible'] is False
    assert candidate['productionValidated'] is False
    assert datetime.fromisoformat(plan['createdAt']) < datetime.fromisoformat(candidate['createdAt'].replace('Z', '+00:00'))
    assert candidate['createdAt'] <= report['diagnosticStartedAt'] <= report['completedAt']
    for name, expected in plan['sourceHashes'].items():
        assert digest(root / name) == expected, name
    for key in ['featureNames', 'featureSchema', 'weight', 'temperature', 'trainingSplit', 'baselineVersion',
                'trainedThrough', 'validationThrough', 'datasetHash', 'hyperparameters']:
        assert candidate[key] == current[key], key
    assert candidate['calibrationProfilesV2']['A'] == current['calibrationProfilesV2']['A']

    target_feature_indices = {current['featureNames'].index(f) for f in plan['intervention']['features']}
    projection_error = 0.0
    edited_trees = {}
    for side in ['home', 'away']:
        original, edited = current['models'][side], candidate['models'][side]
        assert {k: v for k, v in original.items() if k != 'oblivious_trees'} == {k: v for k, v in edited.items() if k != 'oblivious_trees'}
        assert len(original['oblivious_trees']) == len(edited['oblivious_trees'])
        mapping = {f['feature_index']: f['flat_feature_index'] for f in original['features_info']['float_features']}
        affected = 0
        for tree, new_tree in zip(original['oblivious_trees'], edited['oblivious_trees']):
            assert {k: v for k, v in tree.items() if k != 'leaf_values'} == {k: v for k, v in new_tree.items() if k != 'leaf_values'}
            bits = [i for i, split in enumerate(tree['splits']) if mapping[split['float_feature_index']] in target_feature_indices]
            if not bits:
                assert tree == new_tree
                continue
            affected += 1
            mask = sum(2 ** i for i in bits)
            labels = np.array([i & ~mask for i in range(len(tree['leaf_values']))])
            old_values, new_values = np.array(tree['leaf_values']), np.array(new_tree['leaf_values'])
            weights = np.array(tree['leaf_weights'])
            for group in np.unique(labels):
                members = labels == group
                if weights[members].sum() == 0:
                    assert np.all(old_values[members] == 0)
                    expected = 0.0
                else:
                    expected = np.average(old_values[members], weights=weights[members])
                projection_error = max(projection_error, float(np.max(np.abs(new_values[members] - expected))))
                assert np.all(new_values[members] == new_values[members][0])
        edited_trees[side] = affected
    assert projection_error < 1e-12

    dataset = read(root / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json')
    by_id = {r['matchId']: r for r in dataset['rows']}
    indices = [dataset['featureNames'].index(f) for f in current['featureNames']]
    split = current['trainingSplit']
    train = [r for r in dataset['rows'] if split['train']['from'] <= r['forecastAt'] <= split['train']['to']
             and r['availableAt'] < split['selection']['from']]
    assert len(train) == 5293
    train_ids_hash = hashlib.sha256('\n'.join(sorted(r['matchId'] for r in train)).encode()).hexdigest()
    assert train_ids_hash == split['train']['matchIdsHash']
    historical = [r for r in report['rows'] if r['season'] != '2026/2027']
    calibration = candidate['calibrationPredictions']
    assert {r['matchId'] for r in calibration} == {r['matchId'] for r in current['calibrationPredictions']}
    assert len(calibration) == 358 and len(historical) == 595
    for row in calibration:
        source = by_id[row['matchId']]
        assert all(row[k] == source[k] for k in ['homeGoals', 'awayGoals', 'availableAt', 'forecastAt'])
        assert row['availableAt'] <= candidate['validationThrough']
    check_rows = [by_id[r['matchId']] for r in historical] + [by_id[r['matchId']] for r in calibration]
    features = np.array([[r['features'][i] for i in indices] for r in check_rows])
    train_features = np.array([[r['features'][i] for i in indices] for r in train])
    native, support_error = {}, 0
    with tempfile.TemporaryDirectory(prefix='c-tree-projection-verify-') as temp:
        for family, artifact in [('incumbent', current), ('candidate', candidate)]:
            native[family] = {}
            for side in ['home', 'away']:
                file = Path(temp) / f'{family}-{side}.json'
                file.write_text(json.dumps(artifact['models'][side]), encoding='utf-8')
                model = CatBoostRegressor().load_model(str(file), format='json')
                native[family][side] = np.exp(model.predict(features, prediction_type='RawFormulaVal'))
                if family == 'incumbent':
                    leaves = model.calc_leaf_indexes(train_features, thread_count=2)
                    for i, tree in enumerate(artifact['models'][side]['oblivious_trees']):
                        counts = np.bincount(leaves[:, i], minlength=len(tree['leaf_values']))
                        support_error = max(support_error, float(np.max(np.abs(counts - tree['leaf_weights']))))
    assert support_error == 0
    native_error, calibration_matrix_error = 0.0, 0.0
    for i, source in enumerate(check_rows):
        for family in ['incumbent', 'candidate']:
            matrix, p = joint_probabilities(source, native[family]['home'][i], native[family]['away'][i], current['weight'], current['temperature'])
            if i < len(historical):
                actual = np.array([historical[i]['forecasts'][family]['raw'][k] for k in ['homeWin', 'draw', 'awayWin']])
                native_error = max(native_error, float(np.max(np.abs(p - actual))))
            elif family == 'candidate':
                calibration_matrix_error = max(calibration_matrix_error, float(np.max(np.abs(matrix - calibration[i - len(historical)]['matrixC']))))
    assert native_error < 1e-12 and calibration_matrix_error < 1e-12

    metric_error, calibration_error = 0.0, 0.0
    cohorts = {'all': report['rows'], 'historical': historical,
               'current': [r for r in report['rows'] if r['season'] == '2026/2027']}
    cohorts.update({league: [r for r in report['rows'] if r['competition'] == league] for league in report['summary']['byLeague']})
    for cohort, rows in cohorts.items():
        summary = report['summary'].get(cohort, report['summary']['byLeague'].get(cohort))
        labels = np.array([0 if r['homeGoals'] > r['awayGoals'] else 2 if r['homeGoals'] < r['awayGoals'] else 1 for r in rows])
        for family, model in [('incumbent', current), ('candidate', candidate)]:
            raw = np.array([[r['forecasts'][family]['raw'][k] for k in ['homeWin', 'draw', 'awayWin']] for r in rows])
            profile = model['calibrationProfilesV2']['C']['byFamily']['goal_1x2']
            knots = np.array([[v['x'], v['y']] for v in profile['points']])
            n = profile['nObservations']; alpha = .90 if n < 200 else max(.10, 1 / (1 + n / 1000))
            calibrated = np.clip(alpha * raw + (1 - alpha) * np.interp(raw, knots[:, 0], knots[:, 1]), .01, .99)
            calibrated /= calibrated.sum(axis=1)[:, None]
            actual = np.array([[r['forecasts'][family]['calibrated'][k] for k in ['homeWin', 'draw', 'awayWin']] for r in rows])
            calibration_error = max(calibration_error, float(np.max(np.abs(calibrated - actual))))
            for stage in ['raw', 'calibrated', 'decision']:
                p = np.array([[r['forecasts'][family][stage][k] for k in ['homeWin', 'draw', 'awayWin']] for r in rows])
                scores = {'logLoss': float(-np.log(p[np.arange(len(rows)), labels]).mean()),
                          'brier': float(((p - np.eye(3)[labels]) ** 2).sum(axis=1).mean())}
                for key, value in scores.items():
                    metric_error = max(metric_error, abs(value - summary[stage][family][key]))
    assert metric_error < 1e-12 and calibration_error < 1e-12
    for name, expected in plan['sourceHashes'].items():
        assert digest(root / name) == expected
    result = {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'scriptHash': digest(Path(__file__)),
              'planHash': digest(args.plan), 'comparisonHash': digest(args.run / 'comparison.json'),
              'candidateHash': digest(args.run / 'candidate.json'), 'catboostVersion': catboost_version,
              'editedTrees': edited_trees, 'independentProjectionMaximumError': projection_error,
              'nativeOriginalLeafSupportMaximumError': support_error, 'nativeHistoricalRowsPerModel': 595,
              'nativeRawProbabilityMaximumError': native_error, 'nativeCalibrationMatrixRows': 358,
              'nativeCalibrationMatrixMaximumError': calibration_matrix_error,
              'independentCalibrationMaximumError': calibration_error, 'independentPrimaryMetricsMaximumError': metric_error,
              'incumbentAndPinnedSourcesUnchanged': True, 'independentPredictiveEvidence': False,
              'productionAdoptionEligible': False}
    with args.out.open('x', encoding='utf-8') as handle:
        json.dump(result, handle, indent=2); handle.write('\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
