"""One frozen nearest-supported-prefix backoff; no fitting or outcome scoring."""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import math
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

HELPER = Path(__file__).resolve().parents[1] / 'c-tree-sample-projection/prepare.py'
SPEC = importlib.util.spec_from_file_location('sample_projection_helpers', HELPER)
shared = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(shared)
ROOT, train, current = shared.ROOT, shared.train, shared.current
require, digest, encode = shared.require, shared.digest, shared.encode
PLAN_HASH = '74a9f4a1d01d5e7b39ab0671b267775349de563c5f7302a3aced84b68d8d21a6'
METHOD = 'nearest-supported-prefix-ancestor-original-training-weighted-mean-v1'


def backoff_model(model, training_features, native_routes=None):
    """Fill empty leaves from original supported prefixes, preserving supported leaves."""
    require(len(training_features) > 0, 'nonempty_original_training_required')
    routes = shared.leaf_routes(model, training_features)
    if native_routes is not None:
        require(np.array_equal(routes, native_routes), 'native_training_routing_mismatch')
    candidate = copy.deepcopy(model)
    tree_audits = []
    for number, (original, edited) in enumerate(zip(model['oblivious_trees'], candidate['oblivious_trees'])):
        values = original['leaf_values']
        require(all(math.isfinite(value) for value in values), 'nonfinite_original_leaf_values')
        counts = np.bincount(routes[:, number], minlength=len(values))
        require(np.array_equal(counts, original['leaf_weights']), f'original_leaf_support_mismatch:{number}')
        depth = len(original.get('splits', []))
        audit = {'tree': number, 'leafCount': len(values), 'supportCount': int(counts.sum()),
                 'supportParity': True, 'trainingLeafCounts': counts.tolist(), 'emptyLeaves': [], 'changedLeaves': []}
        for leaf, count in enumerate(counts):
            if count:
                continue
            require(values[leaf] == 0, f'nonzero_empty_leaf:{number}:{leaf}')
            found = False
            for prefix_length in range(depth - 1, -1, -1):
                mask = (1 << prefix_length) - 1
                prefix_bits = leaf & mask
                ancestor_leaves = [index for index in range(len(values)) if index & mask == prefix_bits]
                support = sum(int(counts[index]) for index in ancestor_leaves)
                if support == 0:
                    continue
                # Always use original leaf values and counts, never earlier replacements.
                value = math.fsum(values[index] * int(counts[index]) for index in ancestor_leaves) / support
                require(math.isfinite(value), 'nonfinite_backoff_value')
                edited['leaf_values'][leaf] = value
                record = {'leaf': leaf, 'before': values[leaf], 'after': value, 'trainingCount': 0,
                          'prefixLength': prefix_length, 'prefixBits': prefix_bits,
                          'ancestorSupport': support, 'ancestorLeaves': ancestor_leaves}
                audit['emptyLeaves'].append(record)
                if values[leaf] != value:
                    audit['changedLeaves'].append(record)
                found = True
                break
            require(found, f'no_supported_ancestor:{number}:{leaf}')
        require(all(edited['leaf_values'][leaf] == values[leaf] for leaf in range(len(values)) if counts[leaf] > 0),
                'supported_leaf_changed')
        require({key: value for key, value in edited.items() if key != 'leaf_values'} ==
                {key: value for key, value in original.items() if key != 'leaf_values'}, 'non_leaf_tree_mutation')
        if not audit['emptyLeaves']:
            require(encode(original) == encode(edited), 'fully_supported_tree_mutation')
        audit.update({'emptyLeafCount': len(audit['emptyLeaves']), 'changedLeafCount': len(audit['changedLeaves']),
                      'supportedLeavesUnchanged': True})
        tree_audits.append(audit)
    require({key: value for key, value in candidate.items() if key != 'oblivious_trees'} ==
            {key: value for key, value in model.items() if key != 'oblivious_trees'}, 'non_tree_model_mutation')
    original_train_raw = shared.raw_predict(model, training_features)
    candidate_train_raw = shared.raw_predict(candidate, training_features)
    require(np.array_equal(original_train_raw, candidate_train_raw), 'original_training_raw_changed')
    return candidate, {'trees': tree_audits, 'treeCount': len(tree_audits),
                       'emptyLeafCount': sum(tree['emptyLeafCount'] for tree in tree_audits),
                       'changedLeafCount': sum(tree['changedLeafCount'] for tree in tree_audits),
                       'supportedLeavesUnchanged': True, 'onlyOriginallyEmptyLeavesChanged': True,
                       'onlyLeafValuesChanged': True, 'allLeafSupportsMatch': True,
                       'trainingRawExactlyUnchanged': True,
                       'trainingRawMaximumDifference': float(np.max(np.abs(candidate_train_raw - original_train_raw)))}


def check_sources(plan):
    require(plan.get('protocol') == 'c-tree-empty-leaf-backoff-v1', 'wrong_experiment_protocol')
    require(plan.get('incumbentVersion') == shared.VERSION
            and plan.get('incumbentArtifactHash') == shared.INCUMBENT_HASH, 'wrong_original_incumbent')
    require(plan['intervention']['method'] == METHOD and plan['intervention']['maximumCandidates'] == 1
            and plan['intervention']['newTreeFits'] == plan['intervention']['leafValueFits'] == 0,
            'fixed_backoff_method_required')
    require(plan['sourceHashes'].get(shared.INCUMBENT) == shared.INCUMBENT_HASH
            and shared.DATASET in plan['sourceHashes']
            and plan['sourceHashes'].get(HELPER.relative_to(ROOT).as_posix()) == digest(HELPER), 'missing_source_hash')
    for source, expected in plan['sourceHashes'].items():
        file = (ROOT / source).resolve()
        require(file.is_relative_to(ROOT) and digest(file) == expected, f'pinned_source_changed:{source}')


def native_raw(model, features):
    return np.asarray(model.predict(features, prediction_type='RawFormulaVal', thread_count=2)).reshape(-1)


def run(plan_path, output):
    plan_path, output = Path(plan_path).resolve(), Path(output).resolve()
    require(not output.exists(), 'exclusive_new_output_required')
    plan_bytes = plan_path.read_bytes()
    plan_hash = hashlib.sha256(plan_bytes).hexdigest()
    require(plan_hash == PLAN_HASH, 'original_frozen_plan_hash_required')
    plan = json.loads(plan_bytes)
    check_sources(plan)
    require(shared.catboost_version == '1.2.8', 'catboost_1_2_8_required')
    incumbent = json.loads((ROOT / shared.INCUMBENT).read_bytes())
    dataset = json.loads((ROOT / shared.DATASET).read_bytes())
    require(incumbent['version'] == shared.VERSION and incumbent['trainingSplit'] == plan['trainingSplit'],
            'incumbent_split_mismatch')
    require(incumbent['datasetHash'] == plan['sourceHashes'][shared.DATASET], 'incumbent_dataset_mismatch')
    require(incumbent['candidateKind'] == 'calibrated_ensemble' and incumbent['weight'] == .75
            and incumbent['temperature'] == .8, 'fixed_recipe_mismatch')
    split_plan = {'folds': [{'fold': incumbent['frozenFold'], 'trainingSplit': plan['trainingSplit']}]}
    names, groups, split, holdout, quality, fold = current.prepare_dataset(dataset, split_plan, current.current_manifest())
    require(split == plan['trainingSplit'] and names == incumbent['featureNames'] and len(names) == 40,
            'fixed_partition_or_feature_mismatch')
    require([len(group) for group in groups] == [5293, 317, 358, 595], 'fixed_partition_size_mismatch')
    require(quality['policyHash'] == incumbent['dataQualityPolicyHash'] and holdout['protectedRowsUsed'] == 0,
            'provenance_mismatch')
    source_names, checked_rows, _ = train.checked_dataset(dataset, controlled=True)
    all_names, rows = train.project_feature_rows(checked_rows, source_names, [])
    require(names == all_names and len(rows) == len(dataset['rows']) == 6577, 'all_rows_required')
    x = np.array([row['features'] for row in rows], dtype=float)
    x_train = np.array([row['features'] for row in groups[0]], dtype=float)
    candidate = copy.deepcopy(incumbent)
    candidate.pop('calibrationProfilesV2', None)
    audit_sides, raw, raw_incumbent, parity_sides = {}, {}, {}, {}
    with tempfile.TemporaryDirectory(prefix='c-tree-empty-leaf-backoff-') as temp:
        native_candidate = {}
        for side in ('home', 'away'):
            original = incumbent['models'][side]
            native_original = shared.load_native(original, temp, f'original-{side}')
            native_routes = native_original.calc_leaf_indexes(x_train, thread_count=2)
            modified, audit_sides[side] = backoff_model(original, x_train, native_routes)
            require(audit_sides[side]['emptyLeafCount'] == plan['originalAudit'][f'{side}EmptyLeaves'],
                    'original_empty_leaf_audit_mismatch')
            candidate['models'][side] = modified
            native_candidate[side] = shared.load_native(modified, temp, f'candidate-{side}')
            raw[side] = native_raw(native_candidate[side], x)
            raw_incumbent[side] = native_raw(native_original, x)
            original_error = float(np.max(np.abs(raw_incumbent[side] - shared.raw_predict(original, x))))
            modified_error = float(np.max(np.abs(raw[side] - shared.raw_predict(modified, x))))
            require(max(original_error, modified_error) <= shared.TOLERANCE, f'native_parity_failure:{side}')
            original_training = native_raw(native_original, x_train)
            candidate_training = native_raw(native_candidate[side], x_train)
            require(np.array_equal(original_training, candidate_training), f'native_training_raw_changed:{side}')
            parity_sides[side] = {'incumbentNativeMaximumError': original_error,
                                  'candidateNativeMaximumError': modified_error,
                                  'trainingNativeExactlyUnchanged': True,
                                  'trainingNativeMaximumDifference': float(np.max(np.abs(candidate_training - original_training)))}
        calibration_rows = {row['matchId']: row for row in groups[2]}
        require(set(calibration_rows) == {row['matchId'] for row in incumbent['calibrationPredictions']}
                and len(incumbent['calibrationPredictions']) == 358, 'same_calibration_rows_required')
        ordered = [calibration_rows[row['matchId']] for row in incumbent['calibrationPredictions']]
        matrices = train.raw_matrices(ordered, incumbent['candidateKind'], native_candidate)
        for prediction, row, ml in zip(candidate['calibrationPredictions'], ordered, matrices):
            require(np.max(np.abs(train.normalize(row['baselineMatrix']) - np.asarray(prediction['matrixA']))) <= shared.TOLERANCE,
                    'original_calibration_A_matrix_mismatch')
            for key in ('availableAt', 'forecastAt', 'kickoffAt', 'competition', 'homeGoals', 'awayGoals', 'season'):
                require(prediction.get(key) == row.get(key), f'original_calibration_metadata_mismatch:{key}')
            prediction['matrixC'] = train.calibrated_mix(train.normalize(row['baselineMatrix']), ml, .75, .8).tolist()
    created = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    require(train.timestamp(created) > train.timestamp(plan['createdAt']), 'plan_must_precede_candidate')
    identity = {'method': METHOD, 'planHash': plan_hash, 'parentArtifactHash': shared.INCUMBENT_HASH,
                'datasetHash': incumbent['datasetHash'], 'originalSplitPlanHash': incumbent['splitPlanHash'],
                'scriptHash': digest(__file__), 'helperScriptHash': digest(HELPER),
                'modelsHash': hashlib.sha256(encode(candidate['models']).encode()).hexdigest(),
                'catboostVersion': shared.catboost_version, 'createdAt': created}
    candidate.update({'version': 'C-' + train.json_stringify_hash(identity)[:16], 'parentVersion': shared.VERSION,
                      'createdAt': created, 'experimentPlanHash': plan_hash, 'experimentIdentity': identity,
                      'diagnosticOnly': True, 'productionAdoptionEligible': False, 'productionValidated': False,
                      'independentEvidence': False, 'availability': 'local_parameter_candidate', 'status': 'CANDIDATE',
                      'selectionProtocol': 'One frozen nearest-supported-prefix empty-leaf backoff from original training support; '
                      'no new tree or leaf fits, hyperparameter search or data-driven feature selection. '
                      'Every supported leaf and all original training raw predictions remain exactly unchanged. '
                      'Same original train and calibration membership; current unchanged isotonic estimator must be '
                      'refitted before outcome evaluation.'})
    parity = {'featureNames': names, 'rows': [
        {'matchId': row['matchId'], 'raw': {side: [float(raw[side][i])] for side in ('home', 'away')},
         'rawIncumbent': {side: [float(raw_incumbent[side][i])] for side in ('home', 'away')}}
        for i, row in enumerate(rows)], 'nativeIndependentParity': parity_sides}
    check_sources(plan)
    require(plan_path.read_bytes() == plan_bytes, 'plan_changed_during_backoff')
    artifact_text, parity_text = encode(candidate), encode(parity)
    audit = {'createdAt': created, 'version': candidate['version'], 'parentVersion': shared.VERSION,
             'planHash': plan_hash, 'identity': identity, 'sourceHashes': plan['sourceHashes'],
             'artifactHash': hashlib.sha256(artifact_text.encode()).hexdigest(),
             'parityHash': hashlib.sha256(parity_text.encode()).hexdigest(),
             'trainingSplit': split, 'frozenFold': fold, 'trainingRows': 5293, 'calibrationRows': 358,
             'calibrationPredictionsAAndMetadataUnchanged': True, 'calibrationProfilesRemovedPendingSameEstimatorRefit': True,
             'models': audit_sides, 'nativeIndependentParity': parity_sides,
             'trainingRawExactlyUnchanged': True, 'allSupportedLeavesExactlyUnchanged': True,
             'incumbentAndPinnedSourcesUnchanged': True,
             'currentC75Unchanged': digest(ROOT / shared.INCUMBENT) == shared.INCUMBENT_HASH,
             'diagnosticOnly': True, 'productionAdoptionEligible': False, 'newTreeFits': 0, 'leafValueFits': 0}
    output.mkdir(parents=False, exist_ok=False)
    (output / 'artifact.json').write_text(artifact_text, encoding='utf-8')
    (output / 'parity.json').write_text(parity_text, encoding='utf-8')
    (output / 'audit.json').write_text(json.dumps(audit, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    return candidate['version']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps({'version': run(args.plan, args.out), 'output': str(args.out)}))


if __name__ == '__main__':
    main()
