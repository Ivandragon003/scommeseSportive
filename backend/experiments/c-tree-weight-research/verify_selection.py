"""Recompute development selection scores with native edited CatBoost models."""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from catboost import CatBoostRegressor

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    'independent_probability_math', Path(__file__).parent.parent / 'c-tree-sample-projection/verify.py')
MATH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATH)


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metrics(rows, probabilities):
    labels = np.array([0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1
                       for row in rows])
    losses = -np.log(probabilities[np.arange(len(rows)), labels])
    brier = ((probabilities - np.eye(3)[labels]) ** 2).sum(axis=1)
    result = {'n': len(rows), 'logLoss': float(losses.mean()), 'brier': float(brier.mean())}
    result['byLeague'] = {}
    for league in sorted({row['competition'] for row in rows}):
        indices = [i for i, row in enumerate(rows) if row['competition'] == league]
        result['byLeague'][league] = {'n': len(indices), 'logLoss': float(losses[indices].mean()),
                                     'brier': float(brier[indices].mean())}
    return result


def compare_metrics(actual, recorded):
    assert actual['n'] == recorded['n']
    error = max(abs(actual[key] - recorded[key]) for key in ['logLoss', 'brier'])
    assert set(actual['byLeague']) == set(recorded['byLeague'])
    for league, values in actual['byLeague'].items():
        reference = recorded['byLeague'][league]
        assert values['n'] == reference['n']
        error = max(error, *(abs(values[key] - reference[key]) for key in ['logLoss', 'brier']))
    assert error < 1e-12
    return error


def native_probabilities(incumbent, weights, rows, features):
    weights = np.asarray(weights)
    assert weights.shape == (6,) and np.isfinite(weights).all()
    assert (weights >= 0).all() and (weights <= 2).all()
    rates = []
    with tempfile.TemporaryDirectory(prefix='c-block-weight-native-check-') as temporary:
        for side_index, side in enumerate(['home', 'away']):
            model = copy.deepcopy(incumbent['models'][side])
            assert len(model['oblivious_trees']) == 120
            for index, tree in enumerate(model['oblivious_trees']):
                factor = float(weights[side_index * 3 + index // 40])
                tree['leaf_values'] = [value * factor for value in tree['leaf_values']]
            file = Path(temporary) / f'{side}.json'
            file.write_text(json.dumps(model), encoding='utf-8')
            native = CatBoostRegressor().load_model(str(file), format='json')
            rates.append(np.exp(native.predict(features, prediction_type='RawFormulaVal', thread_count=2)))
    return np.array([MATH.joint_probabilities(row, rates[0][i], rates[1][i], incumbent['weight'],
                                             incumbent['temperature'])[1] for i, row in enumerate(rows)])


def verify(plan_file, prepared):
    plan, selection = read(plan_file), read(prepared / 'selection.json')
    assert plan['protocol'] == 'c-tree-block-weight-research-v1'
    assert selection['planHash'] == digest(plan_file)
    for file, expected in plan['sourceHashes'].items():
        assert digest(ROOT / file) == expected, file
    assert selection['scriptHash'] == digest(Path(__file__).with_name('prepare.py'))
    assert selection['weightsScriptHash'] == digest(Path(__file__).with_name('weights.py'))
    incumbent = read(ROOT / 'backend/current-models/challenger.json')
    dataset = read(ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json')
    split = incumbent['trainingSplit']
    rows = [row for row in dataset['rows'] if split['selection']['from'] <= row['forecastAt'] <= split['selection']['to']
            and row['availableAt'] < split['calibration']['from']]
    cutoff = plan['parameterDevelopment']['cutoff']
    groups = {'fit': [row for row in rows if row['forecastAt'] < cutoff and row['availableAt'] < cutoff],
              'validation': [row for row in rows if row['forecastAt'] >= cutoff], 'refit': rows}
    assert [len(groups[key]) for key in ['fit', 'validation', 'refit']] == [152, 165, 317]
    for name, group in groups.items():
        manifest = selection['manifests'][name]
        ids = sorted(row['matchId'] for row in group)
        assert sorted(manifest['matchIds']) == ids
        assert manifest['n'] == len(ids)
        assert manifest['matchIdsHash'] == hashlib.sha256('\n'.join(ids).encode()).hexdigest()
        assert manifest['availableThrough'] == max(row['availableAt'] for row in group)
    assert set(selection['manifests']['fit']['matchIds']).isdisjoint(selection['manifests']['validation']['matchIds'])
    assert selection['manifests']['fit']['availableThrough'] < cutoff
    assert selection['manifests']['refit']['availableThrough'] < split['calibration']['from']
    features = np.array([[row['features'][dataset['featureNames'].index(name)] for name in incumbent['featureNames']]
                         for row in rows])
    id_to_index = {row['matchId']: index for index, row in enumerate(rows)}
    indices = {name: [id_to_index[row['matchId']] for row in group] for name, group in groups.items()}
    validations = selection['validationRows']
    assert {row['matchId'] for row in validations} == set(selection['manifests']['validation']['matchIds'])
    by_id = {row['matchId']: row for row in validations}
    metric_error, probability_error = 0.0, 0.0
    records = [selection['identity']] + selection['fits']
    assert selection['identity']['weights'] == [1.0] * 6
    assert [record['ridge'] for record in selection['fits']] == plan['intervention']['ridgeGrid']
    for record_index, record in enumerate(records):
        probabilities = native_probabilities(incumbent, record['weights'], rows, features)
        for group, field in [('fit', 'fitMetrics'), ('validation', 'validationMetrics')]:
            actual = metrics(groups[group], probabilities[indices[group]])
            metric_error = max(metric_error, compare_metrics(actual, record[field]))
        for row in groups['validation']:
            recorded = by_id[row['matchId']]
            actual_class = 0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1
            assert recorded['actualClass'] == actual_class and recorded['competition'] == row['competition']
            if record_index == 0:
                p = recorded['identity']
            else:
                fitted = recorded['fits'][record_index - 1]
                assert fitted['ridge'] == record['ridge']
                p = fitted['probabilities']
            probability_error = max(probability_error, float(np.max(np.abs(probabilities[id_to_index[row['matchId']]] - p))))
    assert probability_error < 1e-12
    baseline = selection['identity']['validationMetrics']
    eligible = [i for i, record in enumerate(selection['fits']) if record['converged']
                and record['validationMetrics']['logLoss'] < baseline['logLoss'] - 1e-12
                and record['validationMetrics']['brier'] <= baseline['brier'] + 1e-12]
    chosen = None
    if eligible:
        best = min(selection['fits'][i]['validationMetrics']['logLoss'] for i in eligible)
        ties = [i for i in eligible if selection['fits'][i]['validationMetrics']['logLoss'] <= best + 1e-12]
        chosen = max(ties, key=lambda i: selection['fits'][i]['ridge'])
    decision = selection['decision']
    assert decision['selectedFitIndex'] == chosen
    assert decision['acceptedNonIdentity'] is (chosen is not None)
    assert decision['selectedRidge'] == (None if chosen is None else selection['fits'][chosen]['ridge'])
    if chosen is None:
        assert selection['finalFit'] is None
        assert not (prepared / 'artifact.json').exists(), 'Identity winner must not force a candidate'
    else:
        final = selection['finalFit']
        assert final['converged'] is True and decision['frozenAt'] <= final['frozenAt']
        p = native_probabilities(incumbent, final['weights'], rows, features)
        metric_error = max(metric_error, compare_metrics(metrics(rows, p), final['metrics']))
    for file, expected in plan['sourceHashes'].items():
        assert digest(ROOT / file) == expected, file
    return {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'scriptHash': digest(Path(__file__)),
            'planHash': digest(plan_file), 'selectionHash': digest(prepared / 'selection.json'),
            'nativeDevelopmentRowsPerFit': len(rows), 'fitsChecked': 4,
            'nativeProbabilityMaximumError': probability_error, 'independentMetricsMaximumError': metric_error,
            'deterministicSelectionReproduced': True, 'decision': decision,
            'originalDevelopmentIdsAndChronologyVerified': True, 'incumbentAndPinnedSourcesUnchanged': True,
            'independentPredictiveEvidence': False, 'productionAdoptionEligible': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    assert not args.out.exists()
    result = verify(args.plan, args.prepared)
    with args.out.open('x', encoding='utf-8') as output:
        json.dump(result, output, indent=2); output.write('\n')
    print(json.dumps(result))
