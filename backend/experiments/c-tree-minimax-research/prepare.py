"""Frozen minimax tree-block weights trained only on original5293 labels."""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import numpy as np
import scipy

HERE = Path(__file__).resolve().parent
WEIGHT_HELPER = HERE.parent / 'c-tree-weight-research/prepare.py'
L2_HELPER = HERE.parent / 'c-tree-l2-research/prepare.py'
MINIMAX_PATH = HERE / 'minimax.py'


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


weight_helper = load_module('frozen_minimax_weight_helpers', WEIGHT_HELPER)
l2 = load_module('frozen_minimax_metrics', L2_HELPER)
minimax = load_module('minimax_optimization', MINIMAX_PATH)
probability_math = minimax.probability_math
shared = weight_helper.shared
ROOT, train, current = shared.ROOT, shared.train, shared.current
require, digest, encode = shared.require, shared.digest, shared.encode
now, features, membership, metrics = l2.now, l2.features, l2.membership, l2.metrics
raw_and_probabilities = l2.raw_and_probabilities
PLAN_HASH = '146b9f41cf66d8613de6dffc4ff30c08f70696b02ca9264342e9794270b88c75'
METHOD = 'six-original-tree-block-weights-minimax-training-relative-regret-v1'


def fit_training_models(train_inputs, training_rows, plan):
    require(scipy.__version__ == plan['intervention']['optimizer']['scipyVersion'] == '1.17.0', 'fixed_scipy_version_required')
    risks = minimax.TrainingRisks(*train_inputs, np.array([train.class_of(row) for row in training_rows]),
                                  [row['competition'] for row in training_rows])
    require(np.max(np.abs(risks.constraints(np.r_[np.ones(6), 0.]))) <= 1e-15, 'identity_epigraph_not_feasible')
    fitted = []
    for ridge in plan['intervention']['ridgeGrid']:
        receipt = minimax.fit(risks, ridge, plan['intervention']['optimizer'], plan['intervention']['solutionChecks'])
        fitted.append(receipt | {'weightsFrozenAt': now()})
    return risks, fitted


def scale_admitted_model(model, side_weights, tolerance):
    require(len(side_weights) == 3 and all(np.isfinite(value) and -tolerance <= value <= 2 + tolerance for value in side_weights),
            'inadmissible_block_weights')
    if all(0 <= value <= 2 for value in side_weights):
        return weight_helper.scale_model(model, side_weights)
    # Preserve solver values within the frozen bounds tolerance without clipping them.
    candidate = copy.deepcopy(model)
    require(len(model['oblivious_trees']) == 120, 'original_120_trees_required')
    for index, tree in enumerate(candidate['oblivious_trees']):
        tree['leaf_values'] = [value * side_weights[index // 40] for value in model['oblivious_trees'][index]['leaf_values']]
    return candidate


def choose_fit(fits, identity):
    leagues = set(identity['byLeague'])
    require(len(leagues) == 5, 'exactly_five_selection_leagues_required')
    eligible = []
    for index, fit in enumerate(fits):
        if not fit['admissible']:
            continue
        candidate = fit['validationMetrics']
        require(set(candidate['byLeague']) == leagues, 'candidate_selection_leagues_mismatch')
        pairs = [(candidate, identity)] + [(candidate['byLeague'][league], identity['byLeague'][league]) for league in leagues]
        if all(all(reference[key] - value[key] > 1e-12 for key in ('logLoss', 'brier')) for value, reference in pairs):
            eligible.append(index)
    selected = None
    if eligible:
        minimum = min(fits[index]['validationMetrics']['logLoss'] for index in eligible)
        tied = [index for index in eligible if fits[index]['validationMetrics']['logLoss'] - minimum <= 1e-12]
        selected = max(tied, key=lambda index: fits[index]['ridge'])
    return {'acceptedNonIdentity': selected is not None, 'selectedFitIndex': selected,
            'selectedRidge': None if selected is None else fits[selected]['ridge']}


def check_sources(plan):
    require(plan['protocol'] == 'c-tree-minimax-weight-research-v1' and plan['intervention']['method'] == METHOD,
            'wrong_experiment_protocol')
    require(plan['incumbentVersion'] == shared.VERSION and plan['incumbentArtifactHash'] == shared.INCUMBENT_HASH,
            'wrong_original_incumbent')
    require(plan['intervention']['ridgeGrid'] == [10., 1., .1, .01], 'frozen_ridge_grid_required')
    for source, expected in plan['sourceHashes'].items():
        file = (ROOT / source).resolve()
        require(file.is_relative_to(ROOT) and digest(file) == expected, f'pinned_source_changed:{source}')
    require(plan['sourceHashes'].get(WEIGHT_HELPER.relative_to(ROOT).as_posix()) == digest(WEIGHT_HELPER), 'pinned_weight_helper_required')
    require(plan['sourceHashes'].get(L2_HELPER.relative_to(ROOT).as_posix()) == digest(L2_HELPER), 'pinned_metrics_helper_required')


def write_json(path, value):
    path.write_text(encode(value), encoding='utf-8')


def run(plan_path, output):
    plan_path, output = Path(plan_path).resolve(), Path(output).resolve()
    require(not output.exists(), 'exclusive_new_output_required')
    plan_bytes = plan_path.read_bytes()
    require(hashlib.sha256(plan_bytes).hexdigest() == PLAN_HASH, 'original_frozen_plan_hash_required')
    plan = json.loads(plan_bytes)
    check_sources(plan)
    require(shared.catboost_version == '1.2.8', 'fixed_catboost_version_required')
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
    train_inputs = weight_helper.inputs(incumbent['models'], groups[0])
    identity_training = probability_math.raw_probabilities(np.ones(6), *train_inputs)
    _, native_training = raw_and_probabilities(original_native, groups[0])
    identity_error = float(np.max(np.abs(identity_training - native_training)))
    require(identity_error <= shared.TOLERANCE, 'identity_training_pipeline_mismatch')
    risks, fits = fit_training_models(train_inputs, groups[0], plan)
    variants, candidate_predictions = {}, {}
    for index, fitted in enumerate(fits):
        fitted.update({'models': None, 'validationMetrics': None, 'nativeIndependentParity': None})
        if not fitted['admissible']:
            continue
        native, exported, files, parity = {}, {}, {}, {}
        for side_index, side in enumerate(('home', 'away')):
            side_weights = fitted['weights'][side_index * 3:side_index * 3 + 3]
            exported[side] = scale_admitted_model(incumbent['models'][side], side_weights, plan['intervention']['solutionChecks']['boundsTolerance'])
            path = model_dir / f"minimax-ridge-{fitted['ridge']:g}-{side}.json"
            write_json(path, exported[side])
            files[side] = {'file': f'models/{path.name}', 'sha256': digest(path)}
            native[side] = shared.CatBoostRegressor().load_model(str(path), format='json')
            raw_all = native[side].predict(x, prediction_type='RawFormulaVal', thread_count=2)
            error = float(np.max(np.abs(raw_all - shared.raw_predict(exported[side], x))))
            original_error = float(np.max(np.abs(original_raw[side] - shared.raw_predict(incumbent['models'][side], x))))
            require(max(error, original_error) <= shared.TOLERANCE, 'variant_native_independent_parity_failure')
            parity[side] = {'candidateNativeMaximumError': error, 'incumbentNativeMaximumError': original_error}
        fitted.update({'models': files, 'nativeIndependentParity': parity})
        variants[index] = (native, exported)
    # Invalid optimization attempts never reach either export or selection outcomes.
    identity_raw, identity_p = raw_and_probabilities(original_native, groups[1])
    selection = {'createdAt': started, 'planHash': PLAN_HASH, 'scriptHash': digest(__file__),
                 'minimaxScriptHash': digest(MINIMAX_PATH), 'sourceHashes': plan['sourceHashes'],
                 'fit': membership(groups[0]), 'validation': membership(groups[1]),
                 'identity': {'variant': 'originalC75', 'validationMetrics': metrics(identity_p, groups[1]),
                              'trainingRisks': risks.records(np.ones(6))}, 'fits': fits,
                 'identityTrainingPipelineMaximumError': identity_error}
    for index, (native, exported) in variants.items():
        raw, p = raw_and_probabilities(native, groups[1])
        fits[index]['validationMetrics'] = metrics(p, groups[1])
        candidate_predictions[index] = (raw, p)
    selection['decision'] = choose_fit(fits, selection['identity']['validationMetrics']) | {'frozenAt': now()}
    selection['validationRows'] = [{'matchId': row['matchId'], 'competition': row['competition'], 'actualClass': train.class_of(row),
                                     'identity': identity_p[i].tolist(), 'identityRaw': {side: [float(identity_raw[side][i])] for side in ('home', 'away')},
                                     'fits': [{'fitIndex': index, 'ridge': fits[index]['ridge'], 'probabilities': p[i].tolist(),
                                               'raw': {side: [float(raw[side][i])] for side in ('home', 'away')}}
                                              for index, (raw, p) in candidate_predictions.items()]}
                                    for i, row in enumerate(groups[1])]
    selection.update({'completedAt': now(), 'diagnosticOnly': True, 'productionAdoptionEligible': False})
    selection_text = encode(selection)
    check_sources(plan)
    require(plan_path.read_bytes() == plan_bytes, 'plan_changed_during_selection')
    (output / 'selection.json').write_text(selection_text, encoding='utf-8')
    selection_hash = hashlib.sha256(selection_text.encode()).hexdigest()
    audit = {'createdAt': now(), 'planHash': PLAN_HASH, 'sourceHashes': plan['sourceHashes'], 'selectionHash': selection_hash,
             'scriptHash': digest(__file__), 'minimaxScriptHash': digest(MINIMAX_PATH),
             'fit': selection['fit'], 'validation': selection['validation'], 'originalSupport': supports,
             'fits': fits, 'identityTrainingPipelineMaximumError': identity_error,
             'controlFits': 0, 'candidateFits': 0, 'optimizationFits': 4, 'finalRefits': 0,
             'preparedVariants': len(variants), 'newTreeFits': 0, 'onlyOriginal5293LabelsInOptimizer': True,
             'decision': selection['decision'], 'incumbentAndPinnedSourcesUnchanged': True,
             'diagnosticOnly': True, 'productionAdoptionEligible': False}
    if not selection['decision']['acceptedNonIdentity']:
        audit.update({'identitySelected': True, 'calibrationConsumed': False, 'diagnosticOutcomesScored': False})
        write_json(output / 'audit.json', audit)
        return {'identitySelected': True, 'version': None}
    index = selection['decision']['selectedFitIndex']
    native, exported = variants[index]
    chosen_ridge = selection['decision']['selectedRidge']
    chosen = fits[index]['weights']
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
                'scriptHash': digest(__file__), 'helperScriptHash': digest(L2_HELPER), 'minimaxScriptHash': digest(MINIMAX_PATH), 'selectionHash': selection_hash,
                'ridge': chosen_ridge, 'weights': chosen, 'modelsHash': hashlib.sha256(encode(exported).encode()).hexdigest(),
                'catboostVersion': shared.catboost_version, 'createdAt': created}
    candidate.update({'version': 'C-' + train.json_stringify_hash(identity)[:16], 'parentVersion': shared.VERSION,
                      'createdAt': created, 'trainerHash': digest(__file__), 'parentTrainerHash': incumbent['trainerHash'],
                      'hyperparameters': incumbent['hyperparameters'] | {'postprocessing': {'method': METHOD, 'ridge': chosen_ridge, 'weights': chosen}},
                      'parameterAdaptation': {'method': METHOD, 'ridge': chosen_ridge, 'weights': chosen, 'fit': selection['fit'],
                                              'objective': plan['intervention']['objective'], 'optimizer': fits[index]['optimizer'],
                                              'trainingRisks': fits[index]['trainingRisks'], 'epigraph': fits[index]['epigraph'],
                                              'penalizedObjective': fits[index]['objective'], 'worstRelativeRegret': fits[index]['worstRelativeRegret'],
                                              'weightsFrozenAt': fits[index]['weightsFrozenAt'], 'finalRefits': 0,
                                              'source': shared.INCUMBENT, 'minimaxScriptHash': digest(MINIMAX_PATH)},
                      'parameterSelection': {'method': METHOD, 'fit': selection['fit'], 'validation': selection['validation'],
                                             'testedRidges': [10., 1., .1, .01], 'selectedRidge': chosen_ridge, 'finalRefits': 0,
                                             'selectionHash': selection_hash, 'choiceFrozenAt': selection['decision']['frozenAt']},
                      'experimentPlanHash': PLAN_HASH, 'experimentIdentity': identity, 'diagnosticOnly': True,
                      'productionAdoptionEligible': False, 'productionValidated': False, 'independentEvidence': False,
                      'availability': 'local_parameter_candidate', 'status': 'CANDIDATE',
                      'selectionProtocol': 'Four frozen single-start SLSQP minimax relative-regret weight fits on original5293 training labels only. '
                      'No global optimum claim, retries, clipping, new tree fits or refit on317. '
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
