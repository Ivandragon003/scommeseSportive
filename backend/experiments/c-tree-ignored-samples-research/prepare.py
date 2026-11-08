"""One frozen ignored-sample retrain, reusing the verified original Plain control."""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import numpy as np

L2_HELPER = Path(__file__).resolve().parents[1] / 'c-tree-l2-research/prepare.py'
SPEC = importlib.util.spec_from_file_location('frozen_l2_helpers', L2_HELPER)
l2 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(l2)
shared = l2.shared
ROOT, train, current = shared.ROOT, shared.train, shared.current
require, digest, encode = shared.require, shared.digest, shared.encode
now, features, membership, metrics = l2.now, l2.features, l2.membership, l2.metrics
fit_pair, raw_and_probabilities = l2.fit_pair, l2.raw_and_probabilities
PLAN_HASH = '9c3243479fc915a8ec10425a3445c1bf33d3ada8a93b0af838d03677f5b98f3f'
METHOD = 'ignored-sample-features-native-refit-five-league-screen-v1'
IGNORED_NAMES = ['home_sample', 'away_sample']
IGNORED_INDICES = [1, 17]
VARIANT = 'ignored_samples'


def ignored_parameter_guard(original, candidate):
    adjusted = copy.deepcopy(candidate)
    before = original['model_info']['params']
    after = adjusted['model_info']['params']
    require(before['boosting_options']['boosting_type'] == after['boosting_options']['boosting_type'] == 'Plain',
            'plain_boosting_required')
    require(before['data_processing_options']['ignored_features'] == [], 'original_ignored_features_must_be_empty')
    require(after['data_processing_options']['ignored_features'] == IGNORED_INDICES, 'effective_ignored_indices_mismatch')
    after['data_processing_options']['ignored_features'] = []
    require('ignored_features' not in before['flat_params'], 'unexpected_original_explicit_ignored_features')
    require(after['flat_params'].pop('ignored_features', None) in (IGNORED_NAMES, IGNORED_INDICES), 'explicit_ignored_names_or_indices_mismatch')
    l2.effective_parameter_guard(original, adjusted, 3.)
    return True


def ignored_mapping_guard(model, names):
    require(len(names) == 40 and [names[index] for index in IGNORED_INDICES] == IGNORED_NAMES, 'original40_feature_schema_required')
    info = model['features_info']
    require(not any(info.get(kind) for kind in ('categorical_features', 'text_features', 'embedding_features')), 'numeric_features_only_required')
    float_features = info['float_features']
    indexes, flat_indexes = {}, set()
    for feature in float_features:
        index, flat = feature['feature_index'], feature['flat_feature_index']
        require(type(index) is int and type(flat) is int and 0 <= flat < 40
                and index not in indexes and flat not in flat_indexes, 'invalid_or_ambiguous_float_feature_mapping')
        require(feature['feature_id'] == names[flat], 'float_feature_name_mapping_mismatch')
        indexes[index] = flat
        flat_indexes.add(flat)
    for tree in model['oblivious_trees']:
        for split in tree.get('splits', []):
            require(split['split_type'] == 'FloatFeature' and np.isfinite(split['border']), 'numeric_splits_required')
            require(split['float_feature_index'] in indexes, 'unmapped_float_split')
            require(indexes[split['float_feature_index']] not in IGNORED_INDICES, 'ignored_feature_used_in_split')
    return {'schemaSize': 40, 'ignoredNames': IGNORED_NAMES, 'ignoredFlatIndices': IGNORED_INDICES,
            'mappedFloatFeatures': len(indexes), 'noIgnoredFeatureSplits': True}


def support_guard(model, native, rows):
    x_train = features(rows)
    routes = shared.leaf_routes(model, x_train)
    require(np.array_equal(routes, native.calc_leaf_indexes(x_train, thread_count=2)), 'candidate_native_training_route_mismatch')
    counts = [np.bincount(routes[:, i], minlength=len(tree['leaf_values'])).tolist()
              for i, tree in enumerate(model['oblivious_trees'])]
    require(all(count == tree['leaf_weights'] for count, tree in zip(counts, model['oblivious_trees'])), 'candidate_leaf_support_mismatch')
    return {'allLeafSupportsMatch': True, 'trainingLeafCounts': counts, 'treeCount': len(counts)}


def inference_guards(model, native, x):
    raw = np.asarray(native.predict(x, prediction_type='RawFormulaVal', thread_count=2)).reshape(-1)
    parity_error = float(np.max(np.abs(raw - shared.raw_predict(model, x))))
    require(parity_error <= shared.TOLERANCE, 'native_independent_parity_failure')
    errors = {}
    for delta in (-1000., 1000.):
        changed = x.copy()
        changed[:, IGNORED_INDICES] += delta
        native_changed = np.asarray(native.predict(changed, prediction_type='RawFormulaVal', thread_count=2)).reshape(-1)
        independent_changed = shared.raw_predict(model, changed)
        error = float(np.max(np.abs(native_changed - raw)))
        independent_error = float(np.max(np.abs(independent_changed - raw)))
        require(max(error, independent_error) <= shared.TOLERANCE, 'ignored_feature_perturbation_changes_raw')
        errors[f'{delta:g}'] = {'nativeMaximumError': error, 'independentMaximumError': independent_error}
    return {'candidateNativeMaximumError': parity_error, 'rows': len(x), 'ignoredPerturbations': errors,
            'baselineFrozen': True, 'onlyIgnoredInputsPerturbed': True}


def choose_candidate(candidate, identity):
    result = l2.choose_fit([{'l2LeafReg': 3., 'validationMetrics': candidate}], identity)
    return {'acceptedNonIdentity': result['acceptedNonIdentity'],
            'selectedVariant': VARIANT if result['acceptedNonIdentity'] else None}


def check_sources(plan):
    require(plan['protocol'] == 'c-tree-ignored-samples-research-v1' and plan['intervention']['method'] == METHOD,
            'wrong_experiment_protocol')
    require(plan['incumbentVersion'] == shared.VERSION and plan['incumbentArtifactHash'] == shared.INCUMBENT_HASH,
            'wrong_original_incumbent')
    for source, expected in plan['sourceHashes'].items():
        file = (ROOT / source).resolve()
        require(file.is_relative_to(ROOT) and digest(file) == expected, f'pinned_source_changed:{source}')
    require(plan['sourceHashes'].get(L2_HELPER.relative_to(ROOT).as_posix()) == digest(L2_HELPER), 'pinned_l2_helper_required')


def write_json(path, value):
    path.write_text(encode(value), encoding='utf-8')


def run(plan_path, output):
    plan_path, output = Path(plan_path).resolve(), Path(output).resolve()
    require(not output.exists(), 'exclusive_new_output_required')
    plan_bytes = plan_path.read_bytes()
    require(hashlib.sha256(plan_bytes).hexdigest() == PLAN_HASH, 'original_frozen_plan_hash_required')
    plan = json.loads(plan_bytes)
    check_sources(plan)
    require(shared.catboost_version == plan['intervention']['catboostVersion'] == '1.2.8', 'fixed_catboost_version_required')
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
    controls, original_native, original_raw, control_files, original_parity = {}, {}, {}, {}, {}
    control_source = (ROOT / plan['reproductionControl']['source']).resolve()
    source_selection = json.loads(control_source.read_bytes())
    for side in ('home', 'away'):
        info = source_selection['control']['models'][side]
        control_path = (control_source.parent / info['file']).resolve()
        require(control_path.is_relative_to(ROOT) and digest(control_path) == info['sha256']
                and plan['sourceHashes'].get(control_path.relative_to(ROOT).as_posix()) == info['sha256'], 'pinned_reused_control_required')
        control_json = json.loads(control_path.read_bytes())
        control_native = shared.CatBoostRegressor().load_model(str(control_path), format='json')
        original_native[side] = shared.load_native(incumbent['models'][side], model_dir, f'original-{side}-temporary')
        (model_dir / f'original-{side}-temporary.json').unlink()
        original_raw[side] = original_native[side].predict(x, prediction_type='RawFormulaVal', thread_count=2)
        controls[side] = l2.control_guard(incumbent['models'][side], control_json, original_raw[side],
                                         control_native.predict(x, prediction_type='RawFormulaVal', thread_count=2))
        original_parity[side] = float(np.max(np.abs(original_raw[side] - shared.raw_predict(incumbent['models'][side], x))))
        require(original_parity[side] <= shared.TOLERANCE, 'original_native_independent_parity_failure')
        control_files[side] = {'file': control_path.relative_to(ROOT).as_posix(), 'sha256': info['sha256']}
    native, exported, files = fit_pair(groups[0], names, recipe, 3., model_dir, 'ignored-samples')
    supports, candidate_inference = {}, {}
    for side in ('home', 'away'):
        ignored_parameter_guard(incumbent['models'][side], exported[side])
        mapping = ignored_mapping_guard(exported[side], names)
        require(native[side].feature_names_ == names, 'native_feature_names_must_preserve40_schema')
        supports[side] = support_guard(exported[side], native[side], groups[0]) | {'featureMapping': mapping}
        candidate_inference[side] = inference_guards(exported[side], native[side], x)
        candidate_inference[side]['incumbentNativeMaximumError'] = original_parity[side]
    identity_raw, identity_p = raw_and_probabilities(original_native, groups[1])
    selection = {'createdAt': started, 'planHash': PLAN_HASH, 'scriptHash': digest(__file__),
                 'sourceHashes': plan['sourceHashes'], 'fit': membership(groups[0]), 'validation': membership(groups[1]),
                 'identity': {'variant': 'Plain', 'validationMetrics': metrics(identity_p, groups[1])}, 'fits': [],
                 'control': {'variant': 'Plain', 'sourceSelection': plan['reproductionControl']['source'], 'models': control_files, 'verification': controls}}
    raw, p = raw_and_probabilities(native, groups[1])
    selection['fits'].append({'variant': VARIANT, 'validationMetrics': metrics(p, groups[1]), 'models': files,
                              'effectiveParametersOnlyIgnoredFeaturesChanged': True, 'nativeIndependentParity': candidate_inference})
    candidate_predictions = [(raw, p)]
    selection['decision'] = choose_candidate(selection['fits'][0]['validationMetrics'], selection['identity']['validationMetrics']) | {'frozenAt': now()}
    selection['validationRows'] = [{'matchId': row['matchId'], 'competition': row['competition'], 'actualClass': train.class_of(row),
                                     'identity': identity_p[i].tolist(), 'identityRaw': {side: [float(identity_raw[side][i])] for side in ('home', 'away')},
                                     'fits': [{'variant': fit['variant'], 'probabilities': p[i].tolist(),
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
             'controlFits': 0, 'candidateFits': 2, 'reusedControlModels': 2, 'models': supports,
             'candidateInferenceChecks': candidate_inference, 'trainingLabelsOnlyOriginal5293': True, 'noEvalSetOrOffset': True,
             'decision': selection['decision'], 'incumbentAndPinnedSourcesUnchanged': True,
             'diagnosticOnly': True, 'productionAdoptionEligible': False}
    if not selection['decision']['acceptedNonIdentity']:
        audit.update({'identitySelected': True, 'calibrationConsumed': False, 'diagnosticOutcomesScored': False})
        write_json(output / 'audit.json', audit)
        return {'identitySelected': True, 'version': None}
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
                'scriptHash': digest(__file__), 'helperScriptHash': digest(L2_HELPER), 'selectionHash': selection_hash,
                'ignoredFeatures': IGNORED_NAMES, 'ignoredFeatureIndices': IGNORED_INDICES, 'modelsHash': hashlib.sha256(encode(exported).encode()).hexdigest(),
                'catboostVersion': shared.catboost_version, 'createdAt': created}
    candidate.update({'version': 'C-' + train.json_stringify_hash(identity)[:16], 'parentVersion': shared.VERSION,
                      'createdAt': created, 'trainerHash': digest(__file__), 'parentTrainerHash': incumbent['trainerHash'],
                      'hyperparameters': incumbent['hyperparameters'] | {'ignoredFeatures': IGNORED_NAMES, 'ignoredFeatureIndices': IGNORED_INDICES},
                      'parameterSelection': {'method': METHOD, 'fit': selection['fit'], 'validation': selection['validation'],
                                             'testedVariants': [VARIANT], 'selectedVariant': VARIANT,
                                             'ignoredFeatures': IGNORED_NAMES, 'ignoredFlatIndices': IGNORED_INDICES,
                                             'selectionHash': selection_hash, 'choiceFrozenAt': selection['decision']['frozenAt']},
                      'experimentPlanHash': PLAN_HASH, 'experimentIdentity': identity, 'diagnosticOnly': True,
                      'productionAdoptionEligible': False, 'productionValidated': False, 'independentEvidence': False,
                      'availability': 'local_refit_candidate', 'status': 'CANDIDATE',
                      'selectionProtocol': 'Reused pinned Plain reproduction control with exact nonleaf structure and finite leaf/raw parity1e-12. '
                      'One original-training-only ignored-sample pair preserving the40-feature input schema; other effective parameters unchanged after documented normalization. '
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
