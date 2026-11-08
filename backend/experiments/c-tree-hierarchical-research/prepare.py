"""Frozen HS-inspired postprocessing of original Poisson tree contributions."""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
L2_HELPER = HERE.parent / 'c-tree-l2-research/prepare.py'
SHRINK_PATH = HERE / 'shrink.py'


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


l2 = load_module('fixed_hierarchical_helpers', L2_HELPER)
shrink = load_module('hierarchical_math', SHRINK_PATH)
shared = l2.shared
ROOT, train, current = shared.ROOT, shared.train, shared.current
require, digest, encode = shared.require, shared.digest, shared.encode
now, features, membership, metrics = l2.now, l2.features, l2.membership, l2.metrics
raw_and_probabilities = l2.raw_and_probabilities
PLAN_HASH = 'f70c68205145454d95af140205fada013941a503ae838c2cf367ab205229441a'
METHOD = 'support-weighted-hierarchical-leaf-contribution-shrinkage-v1'


def choose_fit(fits, identity):
    result = l2.choose_fit([{'l2LeafReg': fit['lambda'], 'validationMetrics': fit['validationMetrics']} for fit in fits], identity)
    return {'acceptedNonIdentity': result['acceptedNonIdentity'], 'selectedFitIndex': result['selectedFitIndex'],
            'selectedLambda': result['selectedL2LeafReg']}


def check_sources(plan):
    require(plan['protocol'] == 'c-tree-hierarchical-shrinkage-research-v1' and plan['intervention']['method'] == METHOD,
            'wrong_experiment_protocol')
    require(plan['incumbentVersion'] == shared.VERSION and plan['incumbentArtifactHash'] == shared.INCUMBENT_HASH,
            'wrong_original_incumbent')
    require(plan['intervention']['lambdas'] == [1., 10., 100.], 'frozen_lambda_grid_required')
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
    started = now()
    require(train.timestamp(started) > train.timestamp(plan['createdAt']), 'plan_must_precede_fitting')
    original_native, original_raw, supports = {}, {}, {}
    x_train = features(groups[0])
    for side in ('home', 'away'):
        original = incumbent['models'][side]
        original_native[side] = shared.load_native(original, model_dir, f'original-{side}-temporary')
        (model_dir / f'original-{side}-temporary.json').unlink()
        routes = shared.leaf_routes(original, x_train)
        require(np.array_equal(routes, original_native[side].calc_leaf_indexes(x_train, thread_count=2)), 'original_native_route_mismatch')
        counts = [np.bincount(routes[:, i], minlength=len(tree['leaf_values'])).tolist()
                  for i, tree in enumerate(original['oblivious_trees'])]
        require(all(count == tree['leaf_weights'] for count, tree in zip(counts, original['oblivious_trees'])), 'original_leaf_support_mismatch')
        supports[side] = {'allLeafSupportsMatch': True, 'trainingLeafCounts': counts, 'treeCount': len(counts)}
        original_raw[side] = original_native[side].predict(x, prediction_type='RawFormulaVal', thread_count=2)
    variants, technical_audits, files_by_variant, parity_by_variant = [], [], [], []
    for strength in plan['intervention']['lambdas']:
        native, exported, files, model_audits, native_parity = {}, {}, {}, {}, {}
        for side in ('home', 'away'):
            exported[side], model_audits[side] = shrink.shrink_model(incumbent['models'][side], strength)
            path = model_dir / f'hierarchical-{strength:g}-{side}.json'
            write_json(path, exported[side])
            files[side] = {'file': f'models/{path.name}', 'sha256': digest(path)}
            native[side] = shared.CatBoostRegressor().load_model(str(path), format='json')
            raw_all = native[side].predict(x, prediction_type='RawFormulaVal', thread_count=2)
            error = float(np.max(np.abs(raw_all - shared.raw_predict(exported[side], x))))
            original_error = float(np.max(np.abs(original_raw[side] - shared.raw_predict(incumbent['models'][side], x))))
            require(max(error, original_error) <= shared.TOLERANCE, 'variant_native_independent_parity_failure')
            native_parity[side] = {'candidateNativeMaximumError': error, 'incumbentNativeMaximumError': original_error}
        variants.append((native, exported))
        files_by_variant.append(files)
        technical_audits.append({'lambda': strength, 'models': model_audits})
        parity_by_variant.append(native_parity)
    # No317 labels are scored until all three variants passed technical parity.
    identity_raw, identity_p = raw_and_probabilities(original_native, groups[1])
    selection = {'createdAt': started, 'planHash': PLAN_HASH, 'scriptHash': digest(__file__),
                 'shrinkScriptHash': digest(SHRINK_PATH), 'sourceHashes': plan['sourceHashes'],
                 'fit': membership(groups[0]), 'validation': membership(groups[1]),
                 'identity': {'variant': 'originalC75', 'validationMetrics': metrics(identity_p, groups[1])}, 'fits': []}
    candidate_predictions = []
    for strength, (native, exported), files, native_parity in zip(plan['intervention']['lambdas'], variants, files_by_variant, parity_by_variant):
        raw, p = raw_and_probabilities(native, groups[1])
        selection['fits'].append({'lambda': strength, 'validationMetrics': metrics(p, groups[1]),
                                  'models': files, 'nativeIndependentParity': native_parity})
        candidate_predictions.append((raw, p))
    selection['decision'] = choose_fit(selection['fits'], selection['identity']['validationMetrics']) | {'frozenAt': now()}
    selection['validationRows'] = [{'matchId': row['matchId'], 'competition': row['competition'], 'actualClass': train.class_of(row),
                                     'identity': identity_p[i].tolist(), 'identityRaw': {side: [float(identity_raw[side][i])] for side in ('home', 'away')},
                                     'fits': [{'lambda': fit['lambda'], 'probabilities': p[i].tolist(),
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
             'scriptHash': digest(__file__), 'shrinkScriptHash': digest(SHRINK_PATH),
             'fit': selection['fit'], 'validation': selection['validation'], 'originalSupport': supports,
             'variantAudits': technical_audits, 'variantNativeIndependentParity': parity_by_variant,
             'controlFits': 0, 'candidateFits': 0, 'preparedVariants': 3, 'newTreeFits': 0, 'nodeStatisticsFromOriginalValuesAndSupportsOnly': True,
             'decision': selection['decision'], 'incumbentAndPinnedSourcesUnchanged': True,
             'diagnosticOnly': True, 'productionAdoptionEligible': False}
    if not selection['decision']['acceptedNonIdentity']:
        audit.update({'identitySelected': True, 'calibrationConsumed': False, 'diagnosticOutcomesScored': False})
        write_json(output / 'audit.json', audit)
        return {'identitySelected': True, 'version': None}
    index = selection['decision']['selectedFitIndex']
    native, exported = variants[index]
    chosen_lambda = selection['decision']['selectedLambda']
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
                'scriptHash': digest(__file__), 'helperScriptHash': digest(L2_HELPER), 'shrinkScriptHash': digest(SHRINK_PATH), 'selectionHash': selection_hash,
                'lambda': chosen_lambda, 'modelsHash': hashlib.sha256(encode(exported).encode()).hexdigest(),
                'catboostVersion': shared.catboost_version, 'createdAt': created}
    candidate.update({'version': 'C-' + train.json_stringify_hash(identity)[:16], 'parentVersion': shared.VERSION,
                      'createdAt': created, 'trainerHash': digest(__file__), 'parentTrainerHash': incumbent['trainerHash'],
                      'hyperparameters': incumbent['hyperparameters'] | {'postprocessing': {'method': METHOD, 'lambda': chosen_lambda}},
                      'parameterAdaptation': {'method': METHOD, 'lambda': chosen_lambda, 'formula': plan['intervention']['formula'],
                                              'source': shared.INCUMBENT, 'shrinkScriptHash': digest(SHRINK_PATH)},
                      'parameterSelection': {'method': METHOD, 'fit': selection['fit'], 'validation': selection['validation'],
                                             'testedLambdas': [1., 10., 100.], 'selectedLambda': chosen_lambda,
                                             'selectionHash': selection_hash, 'choiceFrozenAt': selection['decision']['frozenAt']},
                      'experimentPlanHash': PLAN_HASH, 'experimentIdentity': identity, 'diagnosticOnly': True,
                      'productionAdoptionEligible': False, 'productionValidated': False, 'independentEvidence': False,
                      'availability': 'local_parameter_candidate', 'status': 'CANDIDATE',
                      'selectionProtocol': 'Three frozen support-weighted hierarchical shrinkage variants of original fitted tree contributions. '
                      'This is an HS-inspired contribution adaptation without new CatBoost fits; no response-mean or ridge-equivalence claim. '
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
