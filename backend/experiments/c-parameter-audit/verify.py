"""Independent SciPy/NumPy audit; reads frozen inputs and writes one new receipt."""
from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import scipy
from scipy.optimize import isotonic_regression
from catboost import CatBoostRegressor, __version__ as catboost_version


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    assert not args.out.exists()
    plan, report = read(args.plan), read(args.run / 'comparison.json')
    artifact = read(root / 'backend/current-models/challenger.json')
    candidate = read(args.run / 'candidate.json')
    audit = read(args.run / 'calibration-audit.json')
    assert digest(args.plan) == report['planHash'] == audit['planHash']
    assert digest(args.run / 'candidate.json') == report['candidateHash']
    for path, expected in plan['sourceHashes'].items():
        assert digest(root / path) == expected, path
    for name, expected in report['sourceHashes'].items():
        assert digest(Path(__file__).parent / name) == expected, name
    allowed = {'version', 'parentVersion', 'createdAt', 'status', 'productionValidated',
               'productionAdoptionEligible', 'diagnosticOnly', 'independentEvidence',
               'availability', 'experimentIdentity', 'selectionProtocol', 'calibrationProfilesV2'}
    assert set(candidate).difference(artifact).issubset(allowed)
    for key, value in artifact.items():
        if key not in allowed:
            assert candidate[key] == value, key
    expected_profiles = json.loads(json.dumps(artifact['calibrationProfilesV2']))
    expected_profiles['C']['calibrationPoints'] = audit['correctedPoints']
    expected_profiles['C']['byFamily']['goal_1x2']['points'] = audit['correctedPoints']
    assert candidate['calibrationProfilesV2'] == expected_profiles
    assert candidate['diagnosticOnly'] is True and candidate['productionAdoptionEligible'] is False
    assert candidate['createdAt'] <= report['diagnosticStartedAt'] <= report['completedAt']
    assert datetime.fromisoformat(plan['createdAt']) < datetime.fromisoformat(candidate['createdAt'].replace('Z', '+00:00'))

    pairs = []
    for row in sorted(artifact['calibrationPredictions'], key=lambda r: (r['availableAt'], r['matchId'])):
        matrix = np.array(row['matrixC'], dtype=float)
        probabilities = np.array([np.tril(matrix, -1).sum(), matrix.trace(), np.triu(matrix, 1).sum()])
        probabilities /= probabilities.sum()
        actual = 0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1
        pairs.extend((float(p), int(i == actual)) for i, p in enumerate(probabilities))
    pairs.sort(key=lambda p: p[0])
    bucket_size = int(np.ceil(len(pairs) / 10))
    bins = [np.array(pairs[i:i + bucket_size]) for i in range(0, len(pairs), bucket_size)]
    x = np.array([b[:, 0].mean() for b in bins])
    y = np.array([b[:, 1].mean() for b in bins])
    counts = np.array([len(b) for b in bins])
    reference = isotonic_regression(y).x  # Same equal bin weights as incumbent.
    weighted_reference = isotonic_regression(y, weights=counts).x
    knots = np.array([[p['x'], p['y']] for p in candidate['calibrationProfilesV2']['C']['calibrationPoints']])
    corrected = np.interp(x, knots[:, 0], knots[:, 1])
    oracle_error = float(np.max(np.abs(corrected - reference)))
    assert oracle_error < 1e-12
    assert np.max(np.abs(reference - weighted_reference)) < 1e-12
    assert abs(float(np.sum(counts * (corrected - y) ** 2)) - audit['objective']['correctedWeightedSquaredError']) < 1e-12

    # Reconstruct post-calibration probabilities from raw values independently.
    calibration_error = 0.0
    for row in report['rows']:
        for family, model in [('incumbent', artifact), ('candidate', candidate)]:
            profile = model['calibrationProfilesV2']['C']['byFamily']['goal_1x2']
            p = np.array([row['forecasts'][family]['raw'][k] for k in ['homeWin', 'draw', 'awayWin']])
            curve = np.array([[v['x'], v['y']] for v in profile['points']])
            n = profile['nObservations']
            alpha = .90 if n < 200 else max(.10, 1 / (1 + n / 1000))
            calibrated = np.clip(alpha * p + (1 - alpha) * np.interp(p, curve[:, 0], curve[:, 1]), .01, .99)
            calibrated /= calibrated.sum()
            actual = np.array([row['forecasts'][family]['calibrated'][k] for k in ['homeWin', 'draw', 'awayWin']])
            calibration_error = max(calibration_error, float(np.max(np.abs(calibrated - actual))))
    assert calibration_error < 1e-12

    cohorts = {'all': report['rows'], 'historical': [r for r in report['rows'] if r['season'] != '2026/2027'],
               'current': [r for r in report['rows'] if r['season'] == '2026/2027']}
    targets = read(root / 'backend/artifacts/research/current-c-real-odds-backtest-20261108/quotes.json')['rows']
    target_map = {r['matchId']: r for r in targets}
    assert set(target_map) == {r['matchId'] for r in report['rows']}
    for row in report['rows']:
        target = target_map[row['matchId']]
        assert all(row[k] == target[k] for k in ['competition', 'season', 'kickoffAt', 'homeGoals', 'awayGoals'])
    cohorts.update({league: [r for r in report['rows'] if r['competition'] == league] for league in report['summary']['byLeague']})
    metric_error = 0.0
    for name, rows in cohorts.items():
        summary = report['summary'].get(name, report['summary']['byLeague'].get(name))
        labels = np.array([0 if r['homeGoals'] > r['awayGoals'] else 2 if r['homeGoals'] < r['awayGoals'] else 1 for r in rows])
        totals = np.array([int(r['homeGoals'] + r['awayGoals'] > 2.5) for r in rows])
        for family in ['incumbent', 'candidate']:
            for stage in ['raw', 'calibrated', 'decision']:
                p = np.array([[r['forecasts'][family][stage][k] for k in ['homeWin', 'draw', 'awayWin']] for r in rows])
                over = np.array([r['forecasts'][family][stage]['over25'] for r in rows])
                predicted = p.argmax(axis=1)
                confidence = p[np.arange(len(rows)), predicted]
                ece = 0.0
                for i in range(10):
                    mask = np.minimum(9, np.floor(confidence * 10)) == i
                    ece += abs(float(np.sum(confidence[mask])) - int(np.sum(predicted[mask] == labels[mask]))) / len(rows)
                values = {'logLoss': float(-np.log(p[np.arange(len(rows)), labels]).mean()),
                          'brier': float(np.sum((p - np.eye(3)[labels]) ** 2, axis=1).mean()),
                          'over25LogLoss': float(-np.log(np.where(totals, over, 1 - over)).mean()),
                          'over25Brier': float(((over - totals) ** 2).mean()), 'eceTopLabel10Bins': ece}
                for key, value in values.items():
                    metric_error = max(metric_error, abs(value - summary[stage][family][key]))
    assert metric_error < 1e-12

    # Native CatBoost check on the 595 frozen historical diagnostic inputs.
    dataset = read(root / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json')
    by_id = {r['matchId']: r for r in dataset['rows']}
    rows = cohorts['historical']
    source_rows = [by_id[r['matchId']] for r in rows]
    indices = [dataset['featureNames'].index(name) for name in artifact['featureNames']]
    features = np.array([[r['features'][i] for i in indices] for r in source_rows])
    native = {}
    with tempfile.TemporaryDirectory(prefix='c-parameter-native-') as temp:
        for side in ['home', 'away']:
            file = Path(temp) / f'{side}.json'
            file.write_text(json.dumps(artifact['models'][side]), encoding='utf-8')
            model = CatBoostRegressor().load_model(str(file), format='json')
            native[side] = np.clip(np.exp(model.predict(features, prediction_type='RawFormulaVal')), .05, 8)
    native_error = 0.0
    for i, (row, source) in enumerate(zip(rows, source_rows)):
        baseline = np.array(source['baselineMatrix']); baseline /= baseline.sum()
        marginals = []
        for side in ['home', 'away']:
            lam = native[side][i]
            pmf = [np.exp(-lam)]
            for k in range(1, len(baseline)):
                pmf.append(pmf[-1] * lam / k)
            marginals.append(pmf)
        ml = np.outer(*marginals); ml /= ml.sum()
        matrix = np.maximum(1e-15, .25 * baseline + .75 * ml) ** (1 / .8); matrix /= matrix.sum()
        p = [np.tril(matrix, -1).sum(), matrix.trace(), np.triu(matrix, 1).sum()]
        actual = [row['forecasts']['incumbent']['raw'][k] for k in ['homeWin', 'draw', 'awayWin']]
        native_error = max(native_error, float(np.max(np.abs(np.array(p) - actual))))
    assert native_error < 1e-12
    for path, expected in plan['sourceHashes'].items():
        assert digest(root / path) == expected
    result = {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'verificationScriptSha256': digest(Path(__file__)),
              'planHash': digest(args.plan), 'comparisonHash': digest(args.run / 'comparison.json'),
              'scipyVersion': scipy.__version__, 'catboostVersion': catboost_version,
              'scipyPavaMaximumError': oracle_error, 'independentCalibrationMaximumError': calibration_error,
              'independentMetricsMaximumError': metric_error, 'nativeCatBoostRows': len(rows),
              'nativeRawProbabilityMaximumError': native_error, 'matchedRows': len(report['rows']),
              'onlyPlannedParametersChanged': True, 'productionAdoptionEligible': False,
              'incumbentAndPinnedSourcesUnchanged': True, 'independentPredictiveEvidence': False}
    with args.out.open('x', encoding='utf-8') as handle:
        json.dump(result, handle, indent=2); handle.write('\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
