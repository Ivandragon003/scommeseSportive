"""Frozen native L2-only research with documented numerical reproduction control."""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from catboost import CatBoostRegressor, Pool, __version__ as catboost_version

HELPER = Path(__file__).resolve().parents[1] / 'c-tree-sample-projection/prepare.py'
SPEC = importlib.util.spec_from_file_location('fixed_l2_helpers', HELPER)
shared = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(shared)
ROOT, train, current = shared.ROOT, shared.train, shared.current
require, digest, encode = shared.require, shared.digest, shared.encode
PLAN_HASH = '996c9df842ad4b5e7498f10dff531b71d1eb6b21b1f769b421658b2aa74a560c'
METHOD = 'original-native-poisson-refit-l2-only-with-five-league-development-screen-v1'


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def features(rows):
    return np.asarray([row['features'] for row in rows], dtype=float)


def membership(rows):
    ids = [row['matchId'] for row in rows]
    return {'n': len(ids), 'matchIds': ids,
            'matchIdsHash': hashlib.sha256('\n'.join(sorted(ids)).encode()).hexdigest(),
            'orderedMatchIdsHash': hashlib.sha256('\n'.join(ids).encode()).hexdigest(),
            'availableThrough': max((row['availableAt'] for row in rows), key=train.timestamp)}


def effective_parameter_guard(original, refitted, l2):
    require(not original.get('features_info', {}).get('categorical_features')
            and not refitted.get('features_info', {}).get('categorical_features'),
            'categorical_features_forbid_metadata_normalization')
    before = copy.deepcopy(original['model_info']['params'])
    after = copy.deepcopy(refitted['model_info']['params'])
    require(before['tree_learner_options'].pop('l2_leaf_reg') == 3, 'unexpected_original_l2')
    require(after['tree_learner_options'].pop('l2_leaf_reg') == l2, 'unexpected_refitted_l2')
    require(before['flat_params'].pop('l2_leaf_reg', 3) == 3, 'unexpected_original_flat_l2')
    require(after['flat_params'].pop('l2_leaf_reg', None) == l2, 'explicit_refitted_l2_required')
    original_counter = before.get('cat_feature_params', {}).get('ctr_leaf_count_limit')
    native_counter = after.get('cat_feature_params', {}).get('ctr_leaf_count_limit')
    if original_counter != native_counter:
        require(original_counter == 18446744073709552000 and native_counter == 18446744073709551615,
                'undocumented_categorical_counter_change')
        after['cat_feature_params']['ctr_leaf_count_limit'] = original_counter
    require(before == after, 'effective_parameters_changed_beyond_l2')
    return True


def control_guard(original, refitted, original_raw, refitted_raw):
    require({key: value for key, value in original.items() if key not in ('model_info', 'oblivious_trees')} ==
            {key: value for key, value in refitted.items() if key not in ('model_info', 'oblivious_trees')},
            'control_inference_structure_mismatch')
    original_trees, refitted_trees = original['oblivious_trees'], refitted['oblivious_trees']
    require(len(original_trees) == len(refitted_trees), 'control_inference_structure_mismatch')
    leaf_error = 0.
    for before, after in zip(original_trees, refitted_trees):
        require({key: value for key, value in before.items() if key != 'leaf_values'} ==
                {key: value for key, value in after.items() if key != 'leaf_values'}, 'control_inference_structure_mismatch')
        original_values, new_values = np.asarray(before['leaf_values']), np.asarray(after['leaf_values'])
        require(original_values.shape == new_values.shape and original_values.size > 0
                and np.all(np.isfinite(original_values)) and np.all(np.isfinite(new_values)), 'control_nonfinite_or_malformed_leaves')
        leaf_error = max(leaf_error, float(np.max(np.abs(original_values - new_values))))
    require(leaf_error <= 1e-12, 'control_leaf_prediction_mismatch')
    original_raw, refitted_raw = np.asarray(original_raw), np.asarray(refitted_raw)
    require(original_raw.shape == refitted_raw.shape and original_raw.size > 0
            and np.all(np.isfinite(original_raw)) and np.all(np.isfinite(refitted_raw)), 'control_nonfinite_or_malformed_raw')
    error = float(np.max(np.abs(original_raw - refitted_raw)))
    require(error <= 1e-12, 'control_native_prediction_mismatch')
    effective_parameter_guard(original, refitted, 3.)
    return {'nonLeafInferenceExactlyEqual': True, 'leafMaximumError': leaf_error,
            'effectiveParametersOnlyL2AfterDocumentedMetadataNormalization': True,
            'nativeRows': len(original_raw), 'nativeMaximumError': error}


def fit_pair(rows, names, recipe, l2, output, stem):
    """Only the supplied training rows can enter either Pool; no eval set or offset."""
    x = features(rows)
    native, exported, files = {}, {}, {}
    for side in ('home', 'away'):
        pool = Pool(x, label=np.asarray([row[f'{side}Goals'] for row in rows], dtype=float), feature_names=names)
        model = CatBoostRegressor(**recipe, l2_leaf_reg=l2)
        model.fit(pool)
        path = output / f'{stem}-{side}.json'
        native[side], exported[side] = model, train.export_model(model, path)
        files[side] = {'file': f'models/{path.name}', 'sha256': digest(path)}
    return native, exported, files


def metrics(probabilities, rows):
    labels = np.array([train.class_of(row) for row in rows])
    def one(indices):
        p, y = probabilities[indices], labels[indices]
        return {'logLoss': float(-np.log(p[np.arange(len(y)), y]).mean()),
                'brier': float(((p - np.eye(3)[y]) ** 2).sum(axis=1).mean()), 'n': len(y)}
    result = one(np.arange(len(rows)))
    result['byLeague'] = {league: one(np.array([i for i, row in enumerate(rows) if row['competition'] == league]))
                          for league in sorted({row['competition'] for row in rows})}
    return result


def choose_fit(fits, identity):
    leagues = set(identity['byLeague'])
    require(len(leagues) == 5, 'exactly_five_selection_leagues_required')
    eligible = []
    for index, fit in enumerate(fits):
        candidate = fit['validationMetrics']
        require(set(candidate['byLeague']) == leagues, 'candidate_selection_leagues_mismatch')
        pairs = [(candidate, identity)] + [(candidate['byLeague'][league], identity['byLeague'][league]) for league in leagues]
        if all(all(reference[key] - value[key] > 1e-12 for key in ('logLoss', 'brier')) for value, reference in pairs):
            eligible.append(index)
    selected = None
    if eligible:
        minimum = min(fits[index]['validationMetrics']['logLoss'] for index in eligible)
        tied = [index for index in eligible if fits[index]['validationMetrics']['logLoss'] - minimum <= 1e-12]
        selected = min(tied, key=lambda index: fits[index]['l2LeafReg'])
    return {'acceptedNonIdentity': selected is not None, 'selectedFitIndex': selected,
            'selectedL2LeafReg': None if selected is None else fits[selected]['l2LeafReg']}


def raw_and_probabilities(native, rows):
    x = features(rows)
    raw = {side: np.asarray(native[side].predict(x, prediction_type='RawFormulaVal', thread_count=2)).reshape(-1)
           for side in ('home', 'away')}
    matrices = train.raw_matrices(rows, 'calibrated_ensemble', native)
    probabilities = np.array([train.result_probabilities(train.calibrated_mix(train.normalize(row['baselineMatrix']), ml, .75, .8))
                              for row, ml in zip(rows, matrices)])
    return raw, probabilities


def check_sources(plan):
    require(plan['protocol'] == 'c-tree-native-l2-research-v2' and plan['intervention']['method'] == METHOD,
            'wrong_experiment_protocol')
    require(plan['incumbentVersion'] == shared.VERSION and plan['incumbentArtifactHash'] == shared.INCUMBENT_HASH,
            'wrong_original_incumbent')
    for source, expected in plan['sourceHashes'].items():
        file = (ROOT / source).resolve()
        require(file.is_relative_to(ROOT) and digest(file) == expected, f'pinned_source_changed:{source}')
    require(plan['sourceHashes'].get(HELPER.relative_to(ROOT).as_posix()) == digest(HELPER), 'pinned_helper_required')


def write_json(path, value):
    path.write_text(encode(value), encoding='utf-8')


def run(plan_path, output):
    plan_path, output = Path(plan_path).resolve(), Path(output).resolve()
    require(not output.exists(), 'exclusive_new_output_required')
    plan_bytes = plan_path.read_bytes()
    require(hashlib.sha256(plan_bytes).hexdigest() == PLAN_HASH, 'original_frozen_plan_hash_required')
    plan = json.loads(plan_bytes)
    check_sources(plan)
    require(catboost_version == plan['intervention']['catboostVersion'] == '1.2.8', 'fixed_catboost_version_required')
    incumbent = json.loads((ROOT / shared.INCUMBENT).read_bytes())
    dataset = json.loads((ROOT / shared.DATASET).read_bytes())
    require(digest(ROOT / shared.INCUMBENT) == shared.INCUMBENT_HASH and incumbent['trainingSplit'] == plan['trainingSplit']
            and incumbent['datasetHash'] == plan['sourceHashes'][shared.DATASET], 'original_incumbent_required')
    require(incumbent['candidateKind'] == 'calibrated_ensemble' and incumbent['weight'] == .75
            and incumbent['temperature'] == .8, 'original_mixer_required')
    frozen = {'folds': [{'fold': incumbent['frozenFold'], 'trainingSplit': plan['trainingSplit']}]}
    names, groups, split, holdout, quality, fold = current.prepare_dataset(dataset, frozen, current.current_manifest())
    require(split == plan['trainingSplit'] and names == incumbent['featureNames'] and len(names) == 40
            and [len(group) for group in groups] == [5293, 317, 358, 595], 'original_partitions_required')
    require(holdout['protectedRowsUsed'] == 0 and quality['policyHash'] == incumbent['dataQualityPolicyHash'], 'clean_provenance_required')
    source_names, checked_rows, _ = train.checked_dataset(dataset, controlled=True)
    all_names, rows = train.project_feature_rows(checked_rows, source_names, [])
    require(all_names == names and len(rows) == 6577, 'all_6577_feature_rows_required')
    x = features(rows)
    output.mkdir(parents=False, exist_ok=False)
    model_dir = output / 'models'
    model_dir.mkdir()
    recipe = plan['intervention']['recipe']
    started = now()
    require(train.timestamp(started) > train.timestamp(plan['createdAt']), 'plan_must_precede_fitting')
    control_native, control_json, control_files = fit_pair(groups[0], names, recipe, 3., model_dir, 'control')
    controls, original_native, original_raw = {}, {}, {}
    for side in ('home', 'away'):
        original_native[side] = shared.load_native(incumbent['models'][side], model_dir, f'original-{side}-temporary')
        # The temporary original export is only for native loading; it is not a fitted model.
        (model_dir / f'original-{side}-temporary.json').unlink()
        original_raw[side] = original_native[side].predict(x, prediction_type='RawFormulaVal', thread_count=2)
        controls[side] = control_guard(incumbent['models'][side], control_json[side], original_raw[side],
                                       control_native[side].predict(x, prediction_type='RawFormulaVal', thread_count=2))
    identity_raw, identity_p = raw_and_probabilities(original_native, groups[1])
    selection = {'createdAt': started, 'planHash': PLAN_HASH, 'scriptHash': digest(__file__),
                 'sourceHashes': plan['sourceHashes'], 'fit': membership(groups[0]), 'validation': membership(groups[1]),
                 'identity': {'l2LeafReg': 3., 'validationMetrics': metrics(identity_p, groups[1])}, 'fits': [],
                 'control': {'l2LeafReg': 3., 'models': control_files, 'verification': controls}}
    variants, candidate_predictions = [], []
    for l2 in plan['intervention']['candidateL2']:
        native, exported, files = fit_pair(groups[0], names, recipe, l2, model_dir, f'l2-{l2:g}')
        for side in ('home', 'away'):
            effective_parameter_guard(incumbent['models'][side], exported[side], l2)
        raw, p = raw_and_probabilities(native, groups[1])
        selection['fits'].append({'l2LeafReg': l2, 'validationMetrics': metrics(p, groups[1]), 'models': files,
                                  'effectiveParametersOnlyL2Changed': True})
        variants.append((native, exported))
        candidate_predictions.append((raw, p))
    selection['decision'] = choose_fit(selection['fits'], selection['identity']['validationMetrics']) | {'frozenAt': now()}
    selection['validationRows'] = [{'matchId': row['matchId'], 'competition': row['competition'], 'actualClass': train.class_of(row),
                                     'identity': identity_p[i].tolist(), 'identityRaw': {side: [float(identity_raw[side][i])] for side in ('home', 'away')},
                                     'fits': [{'l2LeafReg': fit['l2LeafReg'], 'probabilities': p[i].tolist(),
                                               'raw': {side: [float(raw[side][i])] for side in ('home', 'away')}}
                                              for fit, (raw, p) in zip(selection['fits'], candidate_predictions)]}
                                    for i, row in enumerate(groups[1])]
    selection.update({'completedAt': now(), 'diagnosticOnly': True, 'productionAdoptionEligible': False})
    selection_text = encode(selection)
    check_sources(plan)
    require(plan_path.read_bytes() == plan_bytes, 'plan_changed_during_selection')
    (output / 'selection.json').write_text(selection_text, encoding='utf-8')
    selection_hash = hashlib.sha256(selection_text.encode()).hexdigest()
    audit = {'createdAt': now(), 'planHash': PLAN_HASH, 'sourceHashes': plan['sourceHashes'], 'selectionHash': selection_hash,
             'scriptHash': digest(__file__), 'control': selection['control'], 'fit': selection['fit'], 'validation': selection['validation'],
             'controlFits': 2, 'candidateFits': 4, 'trainingLabelsOnlyOriginal5293': True, 'noEvalSetOrOffset': True,
             'decision': selection['decision'], 'incumbentAndPinnedSourcesUnchanged': True,
             'diagnosticOnly': True, 'productionAdoptionEligible': False}
    if not selection['decision']['acceptedNonIdentity']:
        audit.update({'identitySelected': True, 'calibrationConsumed': False, 'diagnosticOutcomesScored': False})
        write_json(output / 'audit.json', audit)
        return {'identitySelected': True, 'version': None}
    index = selection['decision']['selectedFitIndex']
    native, exported = variants[index]
    chosen_l2 = selection['decision']['selectedL2LeafReg']
    candidate = copy.deepcopy(incumbent)
    candidate.pop('calibrationProfilesV2', None)
    candidate['models'] = exported
    raw, parity_audit = {}, {}
    for side in ('home', 'away'):
        raw[side] = native[side].predict(x, prediction_type='RawFormulaVal', thread_count=2)
        error = float(np.max(np.abs(raw[side] - shared.raw_predict(exported[side], x))))
        original_error = float(np.max(np.abs(original_raw[side] - shared.raw_predict(incumbent['models'][side], x))))
        require(max(error, original_error) <= shared.TOLERANCE, 'native_independent_parity_failure')
        parity_audit[side] = {'candidateNativeMaximumError': error, 'incumbentNativeMaximumError': original_error}
    calibration = {row['matchId']: row for row in groups[2]}
    require(set(calibration) == {row['matchId'] for row in incumbent['calibrationPredictions']}
            and len(incumbent['calibrationPredictions']) == 358, 'same_calibration_rows_required')
    ordered = [calibration[prediction['matchId']] for prediction in incumbent['calibrationPredictions']]
    matrices = train.raw_matrices(ordered, incumbent['candidateKind'], native)
    for prediction, row, ml in zip(candidate['calibrationPredictions'], ordered, matrices):
        require(np.max(np.abs(train.normalize(row['baselineMatrix']) - prediction['matrixA'])) <= shared.TOLERANCE, 'original_A_matrix_mismatch')
        prediction['matrixC'] = train.calibrated_mix(train.normalize(row['baselineMatrix']), ml, .75, .8).tolist()
    created = now()
    identity = {'method': METHOD, 'planHash': PLAN_HASH, 'parentArtifactHash': shared.INCUMBENT_HASH,
                'datasetHash': incumbent['datasetHash'], 'originalSplitPlanHash': incumbent['splitPlanHash'],
                'scriptHash': digest(__file__), 'helperScriptHash': digest(HELPER), 'selectionHash': selection_hash,
                'l2LeafReg': chosen_l2, 'modelsHash': hashlib.sha256(encode(exported).encode()).hexdigest(),
                'catboostVersion': catboost_version, 'createdAt': created}
    candidate.update({'version': 'C-' + train.json_stringify_hash(identity)[:16], 'parentVersion': shared.VERSION,
                      'createdAt': created, 'trainerHash': digest(__file__), 'parentTrainerHash': incumbent['trainerHash'],
                      'hyperparameters': incumbent['hyperparameters'] | {'l2LeafReg': chosen_l2},
                      'parameterSelection': {'method': METHOD, 'fit': selection['fit'], 'validation': selection['validation'],
                                             'testedL2': [10., 30.], 'selectedL2LeafReg': chosen_l2,
                                             'selectionHash': selection_hash, 'choiceFrozenAt': selection['decision']['frozenAt']},
                      'experimentPlanHash': PLAN_HASH, 'experimentIdentity': identity, 'diagnosticOnly': True,
                      'productionAdoptionEligible': False, 'productionValidated': False, 'independentEvidence': False,
                      'availability': 'local_refit_candidate', 'status': 'CANDIDATE',
                      'selectionProtocol': 'Native L2=3 reproduction control with exact nonleaf structure, finite leaves/raw within1e-12 '
                      'and documented inactive categorical-counter normalization, followed by original-training-only L2=10/30 fits. '
                      'Both raw 1X2 metrics must improve globally and separately in all five selection leagues. '
                      'No calibration or historical diagnostic labels for model choice; unchanged current calibration estimator required.'})
    parity = {'featureNames': names, 'rows': [{'matchId': row['matchId'],
              'raw': {side: [float(raw[side][i])] for side in ('home', 'away')},
              'rawIncumbent': {side: [float(original_raw[side][i])] for side in ('home', 'away')}} for i, row in enumerate(rows)],
              'nativeIndependentParity': parity_audit}
    artifact_text, parity_text = encode(candidate), encode(parity)
    check_sources(plan)
    require(plan_path.read_bytes() == plan_bytes, 'plan_changed_during_preparation')
    audit.update({'identitySelected': False, 'calibrationConsumed': True, 'version': candidate['version'], 'parentVersion': shared.VERSION,
                  'identity': identity, 'artifactHash': hashlib.sha256(artifact_text.encode()).hexdigest(),
                  'parityHash': hashlib.sha256(parity_text.encode()).hexdigest(), 'trainingSplit': split, 'frozenFold': fold,
                  'trainingRows': 5293, 'calibrationRows': 358, 'nativeIndependentParity': parity_audit,
                  'calibrationPredictionsAAndMetadataUnchanged': True, 'calibrationProfilesRemovedPendingSameEstimatorRefit': True,
                  'currentC75Unchanged': True})
    (output / 'artifact.json').write_text(artifact_text, encoding='utf-8')
    (output / 'parity.json').write_text(parity_text, encoding='utf-8')
    write_json(output / 'audit.json', audit)
    return {'identitySelected': False, 'version': candidate['version']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(run(args.plan, args.out) | {'output': str(args.out)}))


if __name__ == '__main__':
    main()
