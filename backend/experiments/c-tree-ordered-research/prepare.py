"""One frozen Ordered-boosting candidate, reusing the verified Plain control."""
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
PLAN_HASH = 'ea15f84c26feeab1c2fb7e3b01d7943d51f0071de97698a4b866cf19b5bac56d'
METHOD = 'ordered-poisson-boosting-only-with-five-league-development-screen-v1'


def ordered_parameter_guard(original, candidate):
    adjusted = copy.deepcopy(candidate)
    original_params = original['model_info']['params']
    params = adjusted['model_info']['params']
    require(original_params['boosting_options']['boosting_type'] == 'Plain'
            and params['boosting_options']['boosting_type'] == 'Ordered', 'only_plain_to_ordered_required')
    params['boosting_options']['boosting_type'] = 'Plain'
    for key, expected in [('boosting_type', 'Ordered'), ('bootstrap_type', 'MVS'), ('subsample', .8)]:
        require(params['flat_params'].pop(key, None) == expected, f'frozen_explicit_ordered_parameter_required:{key}')
        require(key not in original_params['flat_params'], f'unexpected_original_explicit_parameter:{key}')
    l2.effective_parameter_guard(original, adjusted, 3.)
    return True


def choose_candidate(candidate, identity):
    result = l2.choose_fit([{'l2LeafReg': 3., 'validationMetrics': candidate}], identity)
    return {'acceptedNonIdentity': result['acceptedNonIdentity'],
            'selectedVariant': 'Ordered' if result['acceptedNonIdentity'] else None}


def check_sources(plan):
    require(plan['protocol'] == 'c-tree-ordered-boosting-research-v1' and plan['intervention']['method'] == METHOD,
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
    controls, original_native, original_raw, control_files = {}, {}, {}, {}
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
        control_files[side] = {'file': control_path.relative_to(ROOT).as_posix(), 'sha256': info['sha256']}
    native, exported, files = fit_pair(groups[0], names, recipe, 3., model_dir, 'ordered')
    supports = {}
    for side in ('home', 'away'):
        ordered_parameter_guard(incumbent['models'][side], exported[side])
        routes = shared.leaf_routes(exported[side], features(groups[0]))
        require(np.array_equal(routes, native[side].calc_leaf_indexes(features(groups[0]), thread_count=2)), 'candidate_native_training_route_mismatch')
        counts = [np.bincount(routes[:, i], minlength=len(tree['leaf_values'])).tolist()
                  for i, tree in enumerate(exported[side]['oblivious_trees'])]
        require(all(count == tree['leaf_weights'] for count, tree in zip(counts, exported[side]['oblivious_trees'])), 'candidate_leaf_support_mismatch')
        supports[side] = {'allLeafSupportsMatch': True, 'trainingLeafCounts': counts, 'treeCount': len(counts)}
    identity_raw, identity_p = raw_and_probabilities(original_native, groups[1])
    selection = {'createdAt': started, 'planHash': PLAN_HASH, 'scriptHash': digest(__file__),
                 'sourceHashes': plan['sourceHashes'], 'fit': membership(groups[0]), 'validation': membership(groups[1]),
                 'identity': {'variant': 'Plain', 'validationMetrics': metrics(identity_p, groups[1])}, 'fits': [],
                 'control': {'variant': 'Plain', 'sourceSelection': plan['reproductionControl']['source'], 'models': control_files, 'verification': controls}}
    raw, p = raw_and_probabilities(native, groups[1])
    selection['fits'].append({'variant': 'Ordered', 'validationMetrics': metrics(p, groups[1]), 'models': files,
                              'effectiveParametersOnlyOrderedChanged': True})
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
             'controlFits': 0, 'candidateFits': 2, 'reusedControlModels': 2, 'models': supports, 'trainingLabelsOnlyOriginal5293': True, 'noEvalSetOrOffset': True,
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
                'boostingType': 'Ordered', 'modelsHash': hashlib.sha256(encode(exported).encode()).hexdigest(),
                'catboostVersion': shared.catboost_version, 'createdAt': created}
    candidate.update({'version': 'C-' + train.json_stringify_hash(identity)[:16], 'parentVersion': shared.VERSION,
                      'createdAt': created, 'trainerHash': digest(__file__), 'parentTrainerHash': incumbent['trainerHash'],
                      'hyperparameters': incumbent['hyperparameters'] | {'boostingType': 'Ordered'},
                      'parameterSelection': {'method': METHOD, 'fit': selection['fit'], 'validation': selection['validation'],
                                             'testedVariants': ['Ordered'], 'selectedVariant': 'Ordered',
                                             'selectionHash': selection_hash, 'choiceFrozenAt': selection['decision']['frozenAt']},
                      'experimentPlanHash': PLAN_HASH, 'experimentIdentity': identity, 'diagnosticOnly': True,
                      'productionAdoptionEligible': False, 'productionValidated': False, 'independentEvidence': False,
                      'availability': 'local_refit_candidate', 'status': 'CANDIDATE',
                      'selectionProtocol': 'Reused pinned Plain reproduction control with exact nonleaf structure and finite leaf/raw parity1e-12. '
                      'One original-training-only Ordered pair, all other effective parameters unchanged after documented metadata normalization. '
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
