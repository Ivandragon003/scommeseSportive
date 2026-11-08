"""Independently verify the single Ordered development candidate without fitting."""
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
PLAN_HASH = 'ea15f84c26feeab1c2fb7e3b01d7943d51f0071de97698a4b866cf19b5bac56d'
HELPER = Path(__file__).parent.parent / 'c-tree-l2-research/verify_selection.py'
SPEC = importlib.util.spec_from_file_location('l2_independent_verifier', HELPER)
COMMON = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMMON)
read, digest, timestamp = COMMON.read, COMMON.digest, COMMON.timestamp


def ordered_parameters(original, candidate):
    old, new = (copy.deepcopy(model['model_info']['params']) for model in [original, candidate])
    assert old['boosting_options'].pop('boosting_type') == 'Plain'
    assert new['boosting_options'].pop('boosting_type') == 'Ordered'
    for name, value in [('l2_leaf_reg', 3), ('boosting_type', 'Ordered'), ('bootstrap_type', 'MVS'), ('subsample', .8)]:
        assert name not in old['flat_params'] and new['flat_params'].pop(name) == value
    assert not original['features_info'].get('categorical_features')
    assert not candidate['features_info'].get('categorical_features')
    assert old['cat_feature_params'].pop('ctr_leaf_count_limit') == 18446744073709552000
    assert new['cat_feature_params'].pop('ctr_leaf_count_limit') == 18446744073709551615
    assert old == new, 'Unplanned effective training parameter difference'


def verify(plan_file, prepared):
    plan, selection, audit = read(plan_file), read(prepared / 'selection.json'), read(prepared / 'audit.json')
    assert catboost_version == '1.2.8'
    assert digest(plan_file) == PLAN_HASH == selection['planHash'] == audit['planHash']
    assert selection['sourceHashes'] == audit['sourceHashes'] == plan['sourceHashes']
    assert selection['scriptHash'] == audit['scriptHash'] == digest(Path(__file__).with_name('prepare.py'))
    assert audit['selectionHash'] == digest(prepared / 'selection.json')
    hashes = {ROOT / file: expected for file, expected in plan['sourceHashes'].items()}
    hashes.update({plan_file: PLAN_HASH, prepared / 'selection.json': digest(prepared / 'selection.json'),
                   prepared / 'audit.json': digest(prepared / 'audit.json')})
    for file, expected in hashes.items():
        assert digest(file) == expected, file
    incumbent = read(ROOT / 'backend/current-models/challenger.json')
    dataset = read(ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json')
    rows = sorted(dataset['rows'], key=lambda row: (timestamp(row['forecastAt']), row['matchId']))
    assert len(rows) == len({row['matchId'] for row in rows}) == 6577
    groups = {}
    for name, part, following in [('fit', 'train', 'selection'), ('validation', 'selection', 'calibration')]:
        split = incumbent['trainingSplit']
        group = [row for row in rows if timestamp(split[part]['from']) <= timestamp(row['forecastAt']) <= timestamp(split[part]['to'])
                 and timestamp(row['availableAt']) < timestamp(split[following]['from'])]
        manifest, ids = selection[name], [row['matchId'] for row in group]
        assert manifest == audit[name]
        assert manifest['n'] == len(ids) == split[part]['n']
        assert manifest['matchIds'] == ids
        assert manifest['matchIdsHash'] == split[part]['matchIdsHash'] == hashlib.sha256('\n'.join(sorted(ids)).encode()).hexdigest()
        assert manifest['orderedMatchIdsHash'] == hashlib.sha256('\n'.join(ids).encode()).hexdigest()
        assert manifest['availableThrough'] == max(row['availableAt'] for row in group) == split[part]['availableThrough']
        groups[name] = group
    x = np.array([[row['features'][dataset['featureNames'].index(name)] for name in incumbent['featureNames']] for row in rows])
    indices = {row['matchId']: i for i, row in enumerate(rows)}
    train_indices = [indices[row['matchId']] for row in groups['fit']]
    selection_indices = [indices[row['matchId']] for row in groups['validation']]
    evidence = {row['matchId']: row for row in selection['validationRows']}
    assert len(selection['validationRows']) == len(evidence) == 317
    assert set(evidence) == set(selection['validation']['matchIds'])
    assert len(selection['fits']) == 1 and selection['fits'][0]['variant'] == 'Ordered'
    assert selection['identity']['variant'] == selection['control']['variant'] == 'Plain'
    records = [selection['identity'], selection['control'], selection['fits'][0]]
    leaf_error, control_error, raw_error, probability_error, metric_error = 0., 0., 0., 0., 0.
    with tempfile.TemporaryDirectory(prefix='ordered-native-check-') as temporary:
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
                    base = ROOT if record_index == 1 else prepared.resolve()
                    file = (base / metadata['file']).resolve()
                    assert file.is_relative_to(base)
                    assert digest(file) == metadata['sha256']
                    hashes[file] = metadata['sha256']
                    model = read(file)
                    assert len(model['oblivious_trees']) == 120
                    if record_index == 1:
                        COMMON.parameters(original, model, 3)
                        assert {k: v for k, v in model.items() if k not in ['model_info', 'oblivious_trees']} == {
                            k: v for k, v in original.items() if k not in ['model_info', 'oblivious_trees']}
                        for old, new in zip(original['oblivious_trees'], model['oblivious_trees']):
                            assert {k: v for k, v in old.items() if k != 'leaf_values'} == {k: v for k, v in new.items() if k != 'leaf_values'}
                            leaf_error = max(leaf_error, float(np.max(np.abs(np.array(old['leaf_values']) - new['leaf_values']))))
                    else:
                        ordered_parameters(original, model)
                native = CatBoostRegressor().load_model(str(file), format='json')
                all_raw = np.asarray(native.predict(x, prediction_type='RawFormulaVal', thread_count=2))
                raw[side] = all_raw[selection_indices]
                if record_index == 0:
                    original_raw[side] = all_raw
                elif record_index == 1:
                    control_error = max(control_error, float(np.max(np.abs(all_raw - original_raw[side]))))
                else:
                    routes = native.calc_leaf_indexes(x[train_indices], thread_count=2)
                    for tree_index, tree in enumerate(model['oblivious_trees']):
                        assert np.array_equal(np.bincount(routes[:, tree_index], minlength=len(tree['leaf_values'])), tree['leaf_weights'])
            if record_index == 1:
                continue
            probabilities = np.array([COMMON.MATH.MATH.joint_probabilities(row, np.exp(raw['home'][i]), np.exp(raw['away'][i]), .75, .8)[1]
                                      for i, row in enumerate(groups['validation'])])
            metric_error = max(metric_error, COMMON.MATH.compare_metrics(COMMON.MATH.metrics(groups['validation'], probabilities), record['validationMetrics']))
            for i, row in enumerate(groups['validation']):
                observed = evidence[row['matchId']]
                actual = 0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1
                assert observed['actualClass'] == actual and observed['competition'] == row['competition']
                if record_index == 0:
                    rp, rr = observed['identity'], observed['identityRaw']
                else:
                    assert observed['fits'][0]['variant'] == 'Ordered'
                    rp, rr = observed['fits'][0]['probabilities'], observed['fits'][0]['raw']
                probability_error = max(probability_error, float(np.max(np.abs(probabilities[i] - rp))))
                raw_error = max(raw_error, *(abs(raw[side][i] - rr[side][0]) for side in ['home', 'away']))
    assert max(leaf_error, control_error, raw_error, probability_error, metric_error) < 1e-12
    original, candidate = (record['validationMetrics'] for record in [selection['identity'], selection['fits'][0]])
    assert len(original['byLeague']) == 5 and set(original['byLeague']) == set(candidate['byLeague'])
    comparisons = [(original, candidate)] + [(original['byLeague'][league], candidate['byLeague'][league]) for league in original['byLeague']]
    accepted = all(old[metric] - new[metric] > 1e-12 for old, new in comparisons for metric in ['logLoss', 'brier'])
    decision = selection['decision']
    assert decision == audit['decision']
    assert decision['acceptedNonIdentity'] is accepted
    assert decision['selectedVariant'] == ('Ordered' if accepted else None)
    assert timestamp(plan['createdAt']) < timestamp(selection['createdAt']) <= timestamp(decision['frozenAt']) <= timestamp(selection['completedAt'])
    if not accepted:
        assert not (prepared / 'artifact.json').exists() and not (prepared / 'parity.json').exists()
        assert audit['calibrationConsumed'] is False and audit['diagnosticOutcomesScored'] is False
    for file, expected in hashes.items():
        assert digest(file) == expected, file
    return {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'scriptHash': digest(__file__), 'planHash': PLAN_HASH,
            'selectionHash': digest(prepared / 'selection.json'), 'catboostVersion': catboost_version,
            'nativeControlRowsPerRegressor': 6577, 'nativeControlMaximumError': control_error,
            'nativeControlLeafMaximumError': leaf_error, 'nativeSelectionRowsPerPair': 317,
            'candidateNativeSupportRowsPerRegressor': 5293, 'nativeRawMaximumError': raw_error,
            'independentProbabilityMaximumError': probability_error, 'independentMetricMaximumError': metric_error,
            'onlyOrderedEffectiveTrainingChange': True, 'fiveLeagueSelectionReproduced': True, 'decision': decision,
            'incumbentAndPinnedSourcesUnchanged': True, 'independentPredictiveEvidence': False, 'productionAdoptionEligible': False}


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
