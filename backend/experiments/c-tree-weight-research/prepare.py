"""Frozen chronological selection of six tree-block weights; no new tree fitting."""
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
import scipy

HERE = Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


HELPER = HERE.parent / 'c-tree-sample-projection/prepare.py'
shared = module('fixed_tree_helpers', HELPER)
weights = module('tree_weight_math', HERE / 'weights.py')
ROOT, train, current = shared.ROOT, shared.train, shared.current
require, digest, encode = shared.require, shared.digest, shared.encode
PLAN_HASH = 'acd4e01698d5a61a70843192cdb6e156997c0d7da81c865e2aac8380c910c483'
METHOD = 'six-nonnegative-original-tree-block-weights-with-chronological-ridge-selection-v1'


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def manifest(rows):
    ids = sorted(row['matchId'] for row in rows)
    return {'n': len(rows), 'matchIdsHash': hashlib.sha256('\n'.join(ids).encode()).hexdigest(),
            'availableThrough': max((row['availableAt'] for row in rows), key=train.timestamp), 'matchIds': ids}


def development_rows(selection, plan):
    cutoff = train.timestamp(plan['parameterDevelopment']['cutoff'])
    fit = [row for row in selection if train.timestamp(row['forecastAt']) < cutoff and train.timestamp(row['availableAt']) < cutoff]
    validation = [row for row in selection if train.timestamp(row['forecastAt']) >= cutoff]
    require(len(fit) + len(validation) == len(selection), 'unpurged_parameter_development')
    manifests = {key: manifest(rows) for key, rows in [('fit', fit), ('validation', validation), ('refit', selection)]}
    for key, expected_key in [('fit', 'fit'), ('validation', 'validation'), ('refit', 'originalSelection')]:
        expected = plan['parameterDevelopment'][expected_key]
        require(all(manifests[key][field] == expected[field] for field in ('n', 'matchIdsHash', 'availableThrough')),
                f'parameter_membership_mismatch:{key}')
    return fit, validation, manifests


def block_features(model, features):
    require(len(model['oblivious_trees']) == 120, 'original_120_trees_required')
    routes = shared.leaf_routes(model, features)
    scale, bias = model['scale_and_bias']
    require(len(bias) == 1, 'scalar_model_required')
    result = np.zeros((len(features), 3))
    for block, (start, stop) in enumerate(weights.BLOCKS):
        for tree in range(start, stop):
            result[:, block] += np.asarray(model['oblivious_trees'][tree]['leaf_values'])[routes[:, tree]] * scale
    return result, bias[0]


def scale_model(model, side_weights):
    require(len(side_weights) == 3 and all(np.isfinite(value) and 0 <= value <= 2 for value in side_weights),
            'invalid_block_weights')
    require(len(model['oblivious_trees']) == 120, 'original_120_trees_required')
    candidate = copy.deepcopy(model)
    for index, tree in enumerate(candidate['oblivious_trees']):
        tree['leaf_values'] = [value * side_weights[index // 40] for value in model['oblivious_trees'][index]['leaf_values']]
    return candidate


def features(rows):
    return np.asarray([row['features'] for row in rows], dtype=float)


def inputs(models, rows):
    result = [block_features(models[side], features(rows)) for side in ('home', 'away')]
    return np.stack([value[0] for value in result], axis=1), np.array([value[1] for value in result]), np.asarray([row['baselineMatrix'] for row in rows])


def metrics_by_league(probabilities, rows):
    labels = [train.class_of(row) for row in rows]
    result = weights.metrics(probabilities, labels)
    result['byLeague'] = {}
    for league in sorted({row['competition'] for row in rows}):
        indices = [index for index, row in enumerate(rows) if row['competition'] == league]
        result['byLeague'][league] = weights.metrics(probabilities[indices], np.array(labels)[indices])
    return result


def select_weights(models, selection, plan):
    """Only this selection-row payload can supply labels to the optimizer."""
    fit, validation, manifests = development_rows(selection, plan)
    fit_data, validation_data = inputs(models, fit), inputs(models, validation)
    fit_labels = np.array([train.class_of(row) for row in fit])
    validation_identity = weights.raw_probabilities(np.ones(6), *validation_data)
    report = {'createdAt': now(), 'manifests': manifests,
              'identity': {'weights': [1.] * 6,
                           'fitMetrics': metrics_by_league(weights.raw_probabilities(np.ones(6), *fit_data), fit),
                           'validationMetrics': metrics_by_league(validation_identity, validation)},
              'fits': [], 'finalFit': None}
    validation_probabilities = []
    for ridge in plan['intervention']['ridgeGrid']:
        fitted = weights.fit_weights(*fit_data, fit_labels, ridge, plan['intervention']['optimizer'])
        p_validation = weights.raw_probabilities(fitted['weights'], *validation_data)
        fitted.update({'ridge': ridge, 'fitMetrics': metrics_by_league(weights.raw_probabilities(fitted['weights'], *fit_data), fit),
                       'validationMetrics': metrics_by_league(p_validation, validation)})
        report['fits'].append(fitted)
        validation_probabilities.append(p_validation)
    report['decision'] = weights.choose_fit(report['fits'], report['identity']['validationMetrics']) | {'frozenAt': now()}
    report['validationRows'] = [{'matchId': row['matchId'], 'competition': row['competition'],
                                 'actualClass': train.class_of(row), 'identity': validation_identity[i].tolist(),
                                 'fits': [{'ridge': fitted['ridge'], 'probabilities': p[i].tolist()}
                                          for fitted, p in zip(report['fits'], validation_probabilities)]}
                                for i, row in enumerate(validation)]
    if report['decision']['acceptedNonIdentity']:
        refit_data = inputs(models, selection)
        final = weights.fit_weights(*refit_data, np.array([train.class_of(row) for row in selection]),
                                    report['decision']['selectedRidge'], plan['intervention']['optimizer'])
        final.update({'metrics': metrics_by_league(weights.raw_probabilities(final['weights'], *refit_data), selection), 'frozenAt': now()})
        report['finalFit'] = final
    report['completedAt'] = now()
    return report


def check_sources(plan):
    require(plan.get('protocol') == 'c-tree-block-weight-research-v1' and plan['intervention']['method'] == METHOD,
            'wrong_experiment_protocol')
    require(plan['incumbentVersion'] == shared.VERSION and plan['incumbentArtifactHash'] == shared.INCUMBENT_HASH,
            'wrong_original_incumbent')
    require(plan['intervention']['treeBlocks'] == [list(block) for block in weights.BLOCKS]
            and plan['intervention']['ridgeGrid'] == [10., 1., .1, .01], 'frozen_weight_recipe_required')
    for source, expected in plan['sourceHashes'].items():
        path = (ROOT / source).resolve()
        require(path.is_relative_to(ROOT) and digest(path) == expected, f'pinned_source_changed:{source}')
    require(plan['sourceHashes'].get(HELPER.relative_to(ROOT).as_posix()) == digest(HELPER), 'pinned_helper_required')


def write_selection_only(output, text):
    output.mkdir(parents=False, exist_ok=False)
    (output / 'selection.json').write_text(text, encoding='utf-8')


def run(plan_path, output):
    plan_path, output = Path(plan_path).resolve(), Path(output).resolve()
    require(not output.exists(), 'exclusive_new_output_required')
    plan_bytes = plan_path.read_bytes()
    require(hashlib.sha256(plan_bytes).hexdigest() == PLAN_HASH, 'original_frozen_plan_hash_required')
    plan = json.loads(plan_bytes)
    check_sources(plan)
    require(scipy.__version__ == plan['intervention']['optimizer']['scipyVersion'] == '1.17.0'
            and shared.catboost_version == '1.2.8', 'fixed_numerical_versions_required')
    incumbent = json.loads((ROOT / shared.INCUMBENT).read_bytes())
    dataset = json.loads((ROOT / shared.DATASET).read_bytes())
    require(digest(ROOT / shared.INCUMBENT) == shared.INCUMBENT_HASH and incumbent['trainingSplit'] == plan['trainingSplit']
            and incumbent['datasetHash'] == plan['sourceHashes'][shared.DATASET], 'original_incumbent_required')
    require(incumbent['weight'] == .75 and incumbent['temperature'] == .8 and incumbent['candidateKind'] == 'calibrated_ensemble', 'fixed_mixer_required')
    split_plan = {'folds': [{'fold': incumbent['frozenFold'], 'trainingSplit': plan['trainingSplit']}]}
    names, groups, split, holdout, quality, fold = current.prepare_dataset(dataset, split_plan, current.current_manifest())
    require(split == plan['trainingSplit'] and names == incumbent['featureNames'] and len(names) == 40
            and [len(group) for group in groups] == [5293, 317, 358, 595], 'fixed_partition_or_feature_mismatch')
    require(holdout['protectedRowsUsed'] == 0 and quality['policyHash'] == incumbent['dataQualityPolicyHash'], 'clean_provenance_required')
    support_audit = {}
    with tempfile.TemporaryDirectory(prefix='tree-weight-native-') as temp:
        native_original = {}
        for side in ('home', 'away'):
            model = incumbent['models'][side]
            native_original[side] = shared.load_native(model, temp, f'original-{side}')
            routes = shared.leaf_routes(model, features(groups[0]))
            require(np.array_equal(routes, native_original[side].calc_leaf_indexes(features(groups[0]), thread_count=2)), 'native_training_routing_mismatch')
            counts = [np.bincount(routes[:, i], minlength=len(tree['leaf_values'])).tolist() for i, tree in enumerate(model['oblivious_trees'])]
            require(all(count == tree['leaf_weights'] for count, tree in zip(counts, model['oblivious_trees'])), 'original_leaf_support_mismatch')
            support_audit[side] = {'allLeafSupportsMatch': True, 'trainingLeafCounts': counts, 'treeCount': 120}
        # Identity is verified against the original native mixer before any parameter fit.
        identity = weights.raw_probabilities(np.ones(6), *inputs(incumbent['models'], groups[1]))
        original_matrices = train.raw_matrices(groups[1], incumbent['candidateKind'], native_original)
        reference = np.asarray([train.result_probabilities(train.calibrated_mix(train.normalize(row['baselineMatrix']), ml, .75, .8))
                                for row, ml in zip(groups[1], original_matrices)])
        identity_error = float(np.max(np.abs(identity - reference)))
        require(identity_error <= shared.TOLERANCE, 'identity_pipeline_parity_failure')
        selection = select_weights(incumbent['models'], groups[1], plan)
        selection.update({'planHash': PLAN_HASH, 'sourceHashes': plan['sourceHashes'], 'scriptHash': digest(__file__),
                          'weightsScriptHash': digest(HERE / 'weights.py'), 'identityPipelineMaximumError': identity_error,
                          'diagnosticOnly': True, 'productionAdoptionEligible': False})
        selection_text = encode(selection)  # Frozen before calibration rows are consumed below.
        check_sources(plan)
        require(plan_path.read_bytes() == plan_bytes, 'plan_changed_during_selection')
        require(train.timestamp(selection['createdAt']) > train.timestamp(plan['createdAt']), 'plan_must_precede_selection')
        if not selection['decision']['acceptedNonIdentity']:
            write_selection_only(output, selection_text)
            return {'identitySelected': True, 'version': None}
        if not selection['finalFit']['converged']:
            write_selection_only(output, selection_text)
            raise ValueError('selected_ridge_final_refit_did_not_converge')
        chosen = selection['finalFit']['weights']
        candidate = copy.deepcopy(incumbent)
        candidate.pop('calibrationProfilesV2', None)
        raw, raw_original, parity_audit, native_candidate = {}, {}, {}, {}
        source_names, rows, _ = train.checked_dataset(dataset, controlled=True)
        all_names, rows = train.project_feature_rows(rows, source_names, [])
        require(all_names == names and len(rows) == 6577, 'all_6577_rows_required')
        x = features(rows)
        for s, side in enumerate(('home', 'away')):
            candidate['models'][side] = scale_model(incumbent['models'][side], chosen[s * 3:s * 3 + 3])
            native_candidate[side] = shared.load_native(candidate['models'][side], temp, f'candidate-{side}')
            raw[side] = native_candidate[side].predict(x, prediction_type='RawFormulaVal', thread_count=2)
            raw_original[side] = native_original[side].predict(x, prediction_type='RawFormulaVal', thread_count=2)
            error = float(np.max(np.abs(raw[side] - shared.raw_predict(candidate['models'][side], x))))
            original_error = float(np.max(np.abs(raw_original[side] - shared.raw_predict(incumbent['models'][side], x))))
            require(max(error, original_error) <= shared.TOLERANCE, 'native_parameter_model_parity_failure')
            parity_audit[side] = {'candidateNativeMaximumError': error, 'incumbentNativeMaximumError': original_error}
        calibration = {row['matchId']: row for row in groups[2]}
        require(set(calibration) == {row['matchId'] for row in incumbent['calibrationPredictions']}
                and len(incumbent['calibrationPredictions']) == 358, 'same_calibration_rows_required')
        ordered = [calibration[row['matchId']] for row in incumbent['calibrationPredictions']]
        matrices = train.raw_matrices(ordered, incumbent['candidateKind'], native_candidate)
        for prediction, row, ml in zip(candidate['calibrationPredictions'], ordered, matrices):
            require(np.max(np.abs(train.normalize(row['baselineMatrix']) - prediction['matrixA'])) <= shared.TOLERANCE, 'original_A_matrix_mismatch')
            prediction['matrixC'] = train.calibrated_mix(train.normalize(row['baselineMatrix']), ml, .75, .8).tolist()
    created = now()
    selection_hash = hashlib.sha256(selection_text.encode()).hexdigest()
    identity = {'method': METHOD, 'planHash': PLAN_HASH, 'parentArtifactHash': shared.INCUMBENT_HASH,
                'datasetHash': incumbent['datasetHash'], 'originalSplitPlanHash': incumbent['splitPlanHash'],
                'scriptHash': digest(__file__), 'weightsScriptHash': digest(HERE / 'weights.py'),
                'helperScriptHash': digest(HELPER), 'selectionHash': selection_hash, 'weights': chosen,
                'modelsHash': hashlib.sha256(encode(candidate['models']).encode()).hexdigest(),
                'scipyVersion': scipy.__version__, 'catboostVersion': shared.catboost_version, 'createdAt': created}
    adaptation = {'method': METHOD, 'ridge': selection['decision']['selectedRidge'], 'weights': chosen,
                  **selection['manifests'], 'choiceFrozenAt': selection['decision']['frozenAt'],
                  'weightsFrozenAt': selection['finalFit']['frozenAt']}
    candidate.update({'version': 'C-' + train.json_stringify_hash(identity)[:16], 'parentVersion': shared.VERSION,
                      'createdAt': created, 'trainedThrough': split['selection']['availableThrough'],
                      'parentTrainerHash': incumbent['trainerHash'], 'trainerHash': digest(__file__),
                      'parameterAdaptation': adaptation, 'experimentPlanHash': PLAN_HASH, 'experimentIdentity': identity,
                      'diagnosticOnly': True, 'productionAdoptionEligible': False, 'productionValidated': False,
                      'independentEvidence': False, 'availability': 'local_parameter_candidate', 'status': 'CANDIDATE',
                      'selectionProtocol': 'Six shared tree-block weights; four frozen ridge fits on September152, '
                      'selection on October165 against identity, selected ridge refit on all317. Original trainingSplit '
                      'describes base trees; parameterAdaptation records subsequently consumed selection labels. '
                      'No new tree fits or outcome-driven changes after selection; same current calibration estimator required.'})
    parity = {'featureNames': names, 'rows': [{'matchId': row['matchId'],
              'raw': {side: [float(raw[side][i])] for side in ('home', 'away')},
              'rawIncumbent': {side: [float(raw_original[side][i])] for side in ('home', 'away')}} for i, row in enumerate(rows)],
              'nativeIndependentParity': parity_audit}
    check_sources(plan)
    require(plan_path.read_bytes() == plan_bytes, 'plan_changed_during_preparation')
    artifact_text, parity_text = encode(candidate), encode(parity)
    audit = {'createdAt': created, 'version': candidate['version'], 'parentVersion': shared.VERSION,
             'planHash': PLAN_HASH, 'identity': identity, 'sourceHashes': plan['sourceHashes'],
             'selectionHash': selection_hash, 'artifactHash': hashlib.sha256(artifact_text.encode()).hexdigest(),
             'parityHash': hashlib.sha256(parity_text.encode()).hexdigest(), 'trainingSplit': split, 'frozenFold': fold,
             'trainingRows': 5293, 'calibrationRows': 358, 'models': support_audit, 'weights': chosen,
             'parameterAdaptation': adaptation, 'nativeIndependentParity': parity_audit,
             'identityPipelineMaximumError': identity_error, 'onlyEntireTreeBlockScaling': True,
             'calibrationPredictionsAAndMetadataUnchanged': True, 'calibrationProfilesRemovedPendingSameEstimatorRefit': True,
             'incumbentAndPinnedSourcesUnchanged': True, 'currentC75Unchanged': True,
             'diagnosticOnly': True, 'productionAdoptionEligible': False, 'newTreeFits': 0}
    output.mkdir(parents=False, exist_ok=False)
    for filename, text in [('artifact.json', artifact_text), ('parity.json', parity_text), ('selection.json', selection_text), ('audit.json', encode(audit))]:
        (output / filename).write_text(text, encoding='utf-8')
    return {'identitySelected': False, 'version': candidate['version']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(run(args.plan, args.out) | {'output': str(args.out)}))


if __name__ == '__main__':
    main()
