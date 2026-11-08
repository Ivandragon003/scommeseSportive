"""Check frozen L2 development results with native models; never fit models."""
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
from catboost import CatBoostRegressor, __version__ as catboost_version

ROOT = Path(__file__).resolve().parents[3]
PLAN_HASH = '996c9df842ad4b5e7498f10dff531b71d1eb6b21b1f769b421658b2aa74a560c'
SPEC = importlib.util.spec_from_file_location('independent_selection_math',
    Path(__file__).parent.parent / 'c-tree-weight-research/verify_selection.py')
MATH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATH)


def read(file):
    return json.loads(Path(file).read_text(encoding='utf-8'))


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def parameters(original, candidate, l2):
    before = copy.deepcopy(original['model_info']['params'])
    after = copy.deepcopy(candidate['model_info']['params'])
    assert before['tree_learner_options'].pop('l2_leaf_reg') == 3
    assert after['tree_learner_options'].pop('l2_leaf_reg') == l2
    assert before['flat_params'].pop('l2_leaf_reg', 3) == 3
    assert after['flat_params'].pop('l2_leaf_reg') == l2
    assert not original['features_info'].get('categorical_features')
    assert not candidate['features_info'].get('categorical_features')
    assert before['cat_feature_params'].pop('ctr_leaf_count_limit') == 18446744073709552000
    assert after['cat_feature_params'].pop('ctr_leaf_count_limit') == 18446744073709551615
    assert before == after, 'Another effective training parameter changed'


def verify(plan_file, prepared):
    plan, result, audit = read(plan_file), read(prepared / 'selection.json'), read(prepared / 'audit.json')
    assert catboost_version == '1.2.8'
    assert digest(plan_file) == PLAN_HASH == result['planHash'] == audit['planHash']
    assert digest(prepared / 'selection.json') == audit['selectionHash']
    assert result['scriptHash'] == audit['scriptHash'] == digest(Path(__file__).with_name('prepare.py'))
    assert result['sourceHashes'] == plan['sourceHashes'] == audit['sourceHashes']
    file_hashes = {plan_file: PLAN_HASH, prepared / 'selection.json': digest(prepared / 'selection.json'),
                   prepared / 'audit.json': digest(prepared / 'audit.json')}
    for name, expected in plan['sourceHashes'].items():
        file_hashes[ROOT / name] = expected
    for file, expected in file_hashes.items():
        assert digest(file) == expected, file
    incumbent = read(ROOT / 'backend/current-models/challenger.json')
    dataset = read(ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json')
    split = incumbent['trainingSplit']
    all_rows = sorted(dataset['rows'], key=lambda row: (timestamp(row['forecastAt']), row['matchId']))
    assert len(all_rows) == 6577 and len({row['matchId'] for row in all_rows}) == 6577
    groups = {}
    for name, part, following in [('fit', 'train', 'selection'), ('validation', 'selection', 'calibration')]:
        rows = [row for row in all_rows if timestamp(split[part]['from']) <= timestamp(row['forecastAt']) <= timestamp(split[part]['to'])
                and timestamp(row['availableAt']) < timestamp(split[following]['from'])]
        ids = [row['matchId'] for row in rows]
        manifest = result[name]
        assert manifest['matchIds'] == ids and manifest['n'] == len(ids) == split[part]['n']
        assert manifest['matchIdsHash'] == split[part]['matchIdsHash'] == hashlib.sha256('\n'.join(sorted(ids)).encode()).hexdigest()
        assert manifest['orderedMatchIdsHash'] == hashlib.sha256('\n'.join(ids).encode()).hexdigest()
        assert manifest['availableThrough'] == max(row['availableAt'] for row in rows) == split[part]['availableThrough']
        assert audit[name] == manifest
        groups[name] = rows
    assert set(result['fit']['matchIds']).isdisjoint(result['validation']['matchIds'])
    x = np.array([[row['features'][dataset['featureNames'].index(name)] for name in incumbent['featureNames']]
                  for row in all_rows])
    index = {row['matchId']: i for i, row in enumerate(all_rows)}
    validation_indices = [index[row['matchId']] for row in groups['validation']]
    train_indices = [index[row['matchId']] for row in groups['fit']]
    evidence = {row['matchId']: row for row in result['validationRows']}
    assert len(evidence) == len(result['validationRows']) == 317
    assert set(evidence) == set(result['validation']['matchIds'])
    assert [record['l2LeafReg'] for record in result['fits']] == [10., 30.]
    assert result['control']['l2LeafReg'] == result['identity']['l2LeafReg'] == 3
    raw_error, probability_error, metric_error, control_error = 0., 0., 0., 0.
    support_rows = 0
    with tempfile.TemporaryDirectory(prefix='c-l2-native-check-') as temporary:
        records = [result['identity'], result['control']] + result['fits']
        original_raw = {}
        for record_index, record in enumerate(records):
            raw = {}
            for side in ['home', 'away']:
                original = incumbent['models'][side]
                if record_index == 0:
                    file = Path(temporary) / f'original-{side}.json'
                    file.write_text(json.dumps(original), encoding='utf-8')
                    model = original
                else:
                    metadata = record['models'][side]
                    file = (prepared / metadata['file']).resolve()
                    assert file.is_relative_to(prepared.resolve())
                    assert digest(file) == metadata['sha256']
                    file_hashes[file] = metadata['sha256']
                    model = read(file)
                    parameters(original, model, record['l2LeafReg'])
                    assert len(model['oblivious_trees']) == 120
                native = CatBoostRegressor().load_model(str(file), format='json')
                all_raw = np.asarray(native.predict(x, prediction_type='RawFormulaVal', thread_count=2))
                raw[side] = all_raw[validation_indices]
                if record_index == 0:
                    original_raw[side] = all_raw
                elif record_index == 1:
                    assert {k: v for k, v in model.items() if k not in ['model_info', 'oblivious_trees']} == {
                        k: v for k, v in original.items() if k not in ['model_info', 'oblivious_trees']}
                    leaf_error = 0.
                    for old, new in zip(original['oblivious_trees'], model['oblivious_trees']):
                        assert {k: v for k, v in old.items() if k != 'leaf_values'} == {
                            k: v for k, v in new.items() if k != 'leaf_values'}
                        assert np.isfinite(new['leaf_values']).all()
                        leaf_error = max(leaf_error, float(np.max(np.abs(np.array(old['leaf_values']) - new['leaf_values']))))
                    assert leaf_error <= 1e-12
                    control_error = max(control_error, float(np.max(np.abs(all_raw - original_raw[side]))))
                    assert record['verification'][side]['nonLeafInferenceExactlyEqual'] is True
                    assert record['verification'][side]['effectiveParametersOnlyL2AfterDocumentedMetadataNormalization'] is True
                    assert abs(record['verification'][side]['leafMaximumError'] - leaf_error) < 1e-12
                    assert record['verification'][side]['nativeRows'] == 6577
                    assert abs(record['verification'][side]['nativeMaximumError'] - control_error) < 1e-12
                if record_index > 0:
                    routes = native.calc_leaf_indexes(x[train_indices], thread_count=2)
                    for tree_index, tree in enumerate(model['oblivious_trees']):
                        counts = np.bincount(routes[:, tree_index], minlength=len(tree['leaf_values']))
                        assert np.array_equal(counts, tree['leaf_weights'])
                    support_rows += len(train_indices)
            if record_index == 1:
                continue
            rates = {side: np.exp(values) for side, values in raw.items()}
            p = np.array([MATH.MATH.joint_probabilities(row, rates['home'][i], rates['away'][i], .75, .8)[1]
                          for i, row in enumerate(groups['validation'])])
            metric_error = max(metric_error, MATH.compare_metrics(MATH.metrics(groups['validation'], p), record['validationMetrics']))
            for i, row in enumerate(groups['validation']):
                observed = evidence[row['matchId']]
                expected_class = 0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1
                assert observed['actualClass'] == expected_class and observed['competition'] == row['competition']
                if record_index == 0:
                    recorded_raw, recorded_p = observed['identityRaw'], observed['identity']
                else:
                    fitted = observed['fits'][record_index - 2]
                    assert fitted['l2LeafReg'] == record['l2LeafReg']
                    recorded_raw, recorded_p = fitted['raw'], fitted['probabilities']
                probability_error = max(probability_error, float(np.max(np.abs(p[i] - recorded_p))))
                raw_error = max(raw_error, *(abs(raw[side][i] - recorded_raw[side][0]) for side in ['home', 'away']))
    assert max(control_error, raw_error, probability_error, metric_error) < 1e-12
    baseline = result['identity']['validationMetrics']
    assert len(baseline['byLeague']) == 5
    eligible = []
    for i, record in enumerate(result['fits']):
        current = record['validationMetrics']
        pairs = [(current, baseline)] + [(current['byLeague'][league], baseline['byLeague'][league]) for league in baseline['byLeague']]
        if all(reference[metric] - candidate[metric] > 1e-12 for candidate, reference in pairs for metric in ['logLoss', 'brier']):
            eligible.append(i)
    selected = None
    if eligible:
        minimum = min(result['fits'][i]['validationMetrics']['logLoss'] for i in eligible)
        selected = min((i for i in eligible if result['fits'][i]['validationMetrics']['logLoss'] - minimum <= 1e-12),
                       key=lambda i: result['fits'][i]['l2LeafReg'])
    decision = result['decision']
    assert decision == audit['decision']
    assert decision['selectedFitIndex'] == selected and decision['acceptedNonIdentity'] is (selected is not None)
    assert decision['selectedL2LeafReg'] == (None if selected is None else result['fits'][selected]['l2LeafReg'])
    assert timestamp(plan['createdAt']) < timestamp(result['createdAt']) <= timestamp(decision['frozenAt']) <= timestamp(result['completedAt'])
    if selected is None:
        assert not (prepared / 'artifact.json').exists() and not (prepared / 'parity.json').exists()
        assert audit['calibrationConsumed'] is False and audit['diagnosticOutcomesScored'] is False
    else:
        candidate = read(prepared / 'artifact.json')
        assert candidate['trainedThrough'] == incumbent['trainedThrough']
        assert candidate['trainingSplit'] == incumbent['trainingSplit']
        assert candidate['hyperparameters'] == incumbent['hyperparameters'] | {'l2LeafReg': decision['selectedL2LeafReg']}
    for file, expected in file_hashes.items():
        assert digest(file) == expected, file
    return {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'scriptHash': digest(__file__), 'planHash': PLAN_HASH,
            'selectionHash': digest(prepared / 'selection.json'), 'catboostVersion': catboost_version,
            'nativeControlRowsPerRegressor': 6577, 'nativeControlMaximumError': control_error,
            'nativeTrainingSupportRowsAcrossSixRegressors': support_rows,
            'nativeSelectionRowsPerPair': 317, 'nativeRawMaximumError': raw_error,
            'independentProbabilityMaximumError': probability_error, 'independentMetricMaximumError': metric_error,
            'allFiveLeagueSelectionReproduced': True, 'decision': decision,
            'incumbentAndPinnedSourcesUnchanged': True, 'independentPredictiveEvidence': False, 'productionAdoptionEligible': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    assert not args.out.exists()
    verified = verify(args.plan, args.prepared)
    with args.out.open('x', encoding='utf-8') as output:
        json.dump(verified, output, indent=2); output.write('\n')
    print(json.dumps(verified))
