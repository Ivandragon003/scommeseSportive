"""One frozen post-fit count-feature projection; no training or outcome scoring."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from catboost import CatBoostRegressor, __version__ as catboost_version

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'backend/ml'))
import train  # noqa: E402
import prepare_current_challenger as current  # noqa: E402

INCUMBENT = 'backend/current-models/challenger.json'
DATASET = 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json'
VERSION = 'C-75fd74eb875e9d0e'
INCUMBENT_HASH = '772049b0d4462faa94c785390222501c609f7887a9b7e005c737c3c8988700d2'
TARGETS = ('home_sample', 'away_sample')
METHOD = 'original-training-count-weighted-leaf-projection-by-non-count-split-bits-v1'
TOLERANCE = 1e-12


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def encode(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def float_indexes(model):
    info = model.get('features_info', {})
    require(not any(info.get(key) for key in ('categorical_features', 'text_features', 'embedding_features')),
            'numeric_models_required')
    return {feature['feature_index']: feature['flat_feature_index'] for feature in info.get('float_features', [])}


def split_index(split, indexes, feature_count):
    require(split.get('split_type') == 'FloatFeature' and math.isfinite(split['border']), 'unsupported_split')
    index = indexes.get(split['float_feature_index'], split['float_feature_index'])
    require(type(index) is int and 0 <= index < feature_count, 'invalid_feature_index')
    return index


def leaf_routes(model, features):
    """Independent routing: CatBoost first quantizes numeric inputs to float32."""
    x = np.asarray(features, dtype=np.float32)
    require(x.ndim == 2 and np.all(np.isfinite(x)), 'invalid_features')
    indexes = float_indexes(model)
    routes = []
    for tree in model['oblivious_trees']:
        splits = tree.get('splits', [])
        require(len(splits) <= 16 and len(tree['leaf_values']) == 2 ** len(splits), 'scalar_oblivious_tree_required')
        leaves = np.zeros(len(x), dtype=np.int64)
        for depth, split in enumerate(splits):
            index = split_index(split, indexes, x.shape[1])
            leaves += (x[:, index].astype(np.float64) > split['border']) * (1 << depth)
        routes.append(leaves)
    return np.column_stack(routes)


def raw_predict(model, features):
    routes = leaf_routes(model, features)
    result = np.zeros(len(routes), dtype=np.float64)
    for index, tree in enumerate(model['oblivious_trees']):
        values = np.asarray(tree['leaf_values'], dtype=np.float64)
        require(np.all(np.isfinite(values)), 'nonfinite_leaf_values')
        result += values[routes[:, index]]
    scale, bias = model['scale_and_bias']
    require(len(bias) == 1 and math.isfinite(scale) and math.isfinite(bias[0]), 'invalid_scalar_scale_bias')
    return result * scale + bias[0]


def project_model(model, names, training_features, native_routes=None):
    """Return a deep clone, replacing only targeted trees' leaf_values."""
    routes = leaf_routes(model, training_features)
    if native_routes is not None:
        require(np.array_equal(routes, native_routes), 'native_training_routing_mismatch')
    projected = copy.deepcopy(model)
    indexes = float_indexes(model)
    targets = {names.index(name) for name in TARGETS}
    trees = []
    total_changes = 0
    dependent_groups_before = 0
    maximum_mean_error = 0.0
    for number, (original, edited) in enumerate(zip(model['oblivious_trees'], projected['oblivious_trees'])):
        splits = original.get('splits', [])
        counts = np.bincount(routes[:, number], minlength=len(original['leaf_values']))
        require(np.array_equal(counts, original['leaf_weights']), f'original_leaf_support_mismatch:{number}')
        positions = [depth for depth, split in enumerate(splits)
                     if split_index(split, indexes, len(names)) in targets]
        record = {'tree': number, 'targetSplitBits': positions, 'leafCount': len(counts),
                  'supportCount': int(counts.sum()), 'supportParity': True, 'trainingLeafCounts': counts.tolist(),
                  'changedLeaves': [], 'zeroSupportGroups': 0, 'groups': []}
        if positions:
            mask = sum(1 << depth for depth in range(len(splits)) if depth not in positions)
            groups = {}
            for leaf in range(len(counts)):
                groups.setdefault(leaf & mask, []).append(leaf)
            values = original['leaf_values']
            for key, leaves in groups.items():
                dependent_groups_before += len({values[leaf] for leaf in leaves}) > 1
                support = sum(int(counts[leaf]) for leaf in leaves)
                if support:
                    value = math.fsum(values[leaf] * int(counts[leaf]) for leaf in leaves) / support
                else:
                    require(all(values[leaf] == 0 for leaf in leaves), f'nonzero_empty_group:{number}:{key}')
                    value = 0
                    record['zeroSupportGroups'] += 1
                for leaf in leaves:
                    edited['leaf_values'][leaf] = value
                    if values[leaf] != value:
                        record['changedLeaves'].append({'leaf': leaf, 'before': values[leaf], 'after': value,
                                                        'trainingCount': int(counts[leaf])})
                require(len({edited['leaf_values'][leaf] for leaf in leaves}) == 1, 'count_invariance_failure')
                record['groups'].append({'nonTargetBits': key, 'leaves': leaves, 'trainingCount': support,
                                         'value': value})
            before = math.fsum(value * int(count) for value, count in zip(values, counts)) / len(training_features)
            after = math.fsum(value * int(count) for value, count in zip(edited['leaf_values'], counts)) / len(training_features)
            error = abs(before - after)
            require(error <= TOLERANCE, 'weighted_mean_not_preserved')
            maximum_mean_error = max(maximum_mean_error, error)
            record.update({'weightedMeanBefore': before, 'weightedMeanAfter': after, 'weightedMeanError': error})
            require({k: v for k, v in edited.items() if k != 'leaf_values'} ==
                    {k: v for k, v in original.items() if k != 'leaf_values'}, 'non_leaf_tree_mutation')
        else:
            require(encode(original) == encode(edited), 'untargeted_tree_mutation')
        record['changedLeafCount'] = len(record['changedLeaves'])
        total_changes += record['changedLeafCount']
        trees.append(record)
    require({k: v for k, v in projected.items() if k != 'oblivious_trees'} ==
            {k: v for k, v in model.items() if k != 'oblivious_trees'}, 'non_tree_model_mutation')
    targeted_trees = sum(bool(tree['targetSplitBits']) for tree in trees)
    target_splits = sum(len(tree['targetSplitBits']) for tree in trees)
    return projected, {'trees': trees, 'treeCount': len(trees), 'targetTreesBefore': targeted_trees,
                       'targetTreesAfter': targeted_trees, 'targetSplitsBefore': target_splits,
                       'targetSplitsAfter': target_splits, 'effectiveCountDependentGroupsBefore': dependent_groups_before,
                       'effectiveCountDependentGroupsAfter': 0,
                       'changedLeafCount': total_changes, 'zeroSupportGroups': sum(t['zeroSupportGroups'] for t in trees),
                       'maximumWeightedMeanError': maximum_mean_error, 'allLeafSupportsMatch': True,
                       'untargetedTreesUnchanged': True, 'onlyLeafValuesChanged': True}


def check_sources(plan):
    require(plan.get('protocol') == 'c-tree-sample-projection-v1', 'wrong_experiment_protocol')
    require(plan.get('incumbentVersion') == VERSION and plan.get('incumbentArtifactHash') == INCUMBENT_HASH,
            'wrong_original_incumbent')
    require(plan['sourceHashes'].get(INCUMBENT) == INCUMBENT_HASH and DATASET in plan['sourceHashes'], 'missing_source_hash')
    for source, expected in plan['sourceHashes'].items():
        file = (ROOT / source).resolve()
        require(file.is_relative_to(ROOT) and digest(file) == expected, f'pinned_source_changed:{source}')


def load_native(model, directory, name):
    file = Path(directory) / f'{name}.json'
    file.write_text(encode(model), encoding='utf-8')
    return CatBoostRegressor().load_model(str(file), format='json')


def run(plan_path, output):
    plan_path, output = Path(plan_path).resolve(), Path(output).resolve()
    require(not output.exists(), 'exclusive_new_output_required')
    plan_bytes = plan_path.read_bytes()
    plan = json.loads(plan_bytes)
    check_sources(plan)
    require(catboost_version == '1.2.8', 'catboost_1_2_8_required')
    incumbent = json.loads((ROOT / INCUMBENT).read_bytes())
    dataset = json.loads((ROOT / DATASET).read_bytes())
    require(incumbent['version'] == VERSION and incumbent['trainingSplit'] == plan['trainingSplit'], 'incumbent_split_mismatch')
    require(incumbent['datasetHash'] == plan['sourceHashes'][DATASET], 'incumbent_dataset_mismatch')
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
    selection = np.array([row['features'] for row in groups[1]], dtype=float)
    counterfactual = selection.copy()
    for name in TARGETS:
        counterfactual[:, names.index(name)] += 38
    candidate = copy.deepcopy(incumbent)
    candidate.pop('calibrationProfilesV2', None)
    audit_sides, raw, raw_incumbent, parity_sides = {}, {}, {}, {}
    with tempfile.TemporaryDirectory(prefix='c-tree-sample-projection-') as temp:
        native_candidate = {}
        for side in ('home', 'away'):
            original = incumbent['models'][side]
            native_original = load_native(original, temp, f'original-{side}')
            native_routes = native_original.calc_leaf_indexes(x_train, thread_count=2)
            projected, audit_sides[side] = project_model(original, names, x_train, native_routes)
            require(audit_sides[side]['targetTreesBefore'] == plan['originalAudit'][f'sampleTrees{side.title()}']
                    and audit_sides[side]['targetSplitsBefore'] == plan['originalAudit'][f'sampleSplits{side.title()}'],
                    'original_target_split_audit_mismatch')
            candidate['models'][side] = projected
            native_candidate[side] = load_native(projected, temp, f'candidate-{side}')
            raw[side] = np.asarray(native_candidate[side].predict(x, prediction_type='RawFormulaVal')).reshape(-1)
            raw_incumbent[side] = np.asarray(native_original.predict(x, prediction_type='RawFormulaVal')).reshape(-1)
            original_error = float(np.max(np.abs(raw_incumbent[side] - raw_predict(original, x))))
            modified_error = float(np.max(np.abs(raw[side] - raw_predict(projected, x))))
            stress_raw = np.asarray(native_candidate[side].predict(counterfactual, prediction_type='RawFormulaVal')).reshape(-1)
            stress_error = float(np.max(np.abs(stress_raw - raw_predict(projected, counterfactual))))
            selection_raw = np.asarray(native_candidate[side].predict(selection, prediction_type='RawFormulaVal')).reshape(-1)
            invariance_error = float(np.max(np.abs(stress_raw - selection_raw)))
            require(max(original_error, modified_error, stress_error, invariance_error) <= TOLERANCE,
                    f'native_or_count_invariance_parity_failure:{side}')
            parity_sides[side] = {'incumbentNativeMaximumError': original_error,
                                  'candidateNativeMaximumError': modified_error,
                                  'counterfactualNativeMaximumError': stress_error,
                                  'countCounterfactualMaximumDifference': invariance_error}
        calibration_rows = {row['matchId']: row for row in groups[2]}
        require(set(calibration_rows) == {row['matchId'] for row in incumbent['calibrationPredictions']}
                and len(incumbent['calibrationPredictions']) == 358, 'same_calibration_rows_required')
        ordered = [calibration_rows[row['matchId']] for row in incumbent['calibrationPredictions']]
        matrices = train.raw_matrices(ordered, incumbent['candidateKind'], native_candidate)
        for prediction, row, ml in zip(candidate['calibrationPredictions'], ordered, matrices):
            require(np.max(np.abs(train.normalize(row['baselineMatrix']) - np.asarray(prediction['matrixA']))) <= TOLERANCE,
                    'original_calibration_A_matrix_mismatch')
            for key in ('availableAt', 'forecastAt', 'kickoffAt', 'competition', 'homeGoals', 'awayGoals', 'season'):
                require(prediction.get(key) == row.get(key), f'original_calibration_metadata_mismatch:{key}')
            prediction['matrixC'] = train.calibrated_mix(train.normalize(row['baselineMatrix']), ml, .75, .8).tolist()
    created = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    require(train.timestamp(created) > train.timestamp(plan['createdAt']), 'plan_must_precede_candidate')
    plan_hash = hashlib.sha256(plan_bytes).hexdigest()
    identity = {'method': METHOD, 'targetFeatures': list(TARGETS), 'planHash': plan_hash,
                'parentArtifactHash': INCUMBENT_HASH, 'datasetHash': incumbent['datasetHash'],
                'originalSplitPlanHash': incumbent['splitPlanHash'], 'scriptHash': digest(__file__),
                'modelsHash': hashlib.sha256(encode(candidate['models']).encode()).hexdigest(),
                'catboostVersion': catboost_version, 'createdAt': created}
    candidate.update({'version': 'C-' + train.json_stringify_hash(identity)[:16], 'parentVersion': VERSION,
                      'createdAt': created, 'experimentPlanHash': plan_hash, 'experimentIdentity': identity,
                      'diagnosticOnly': True, 'productionAdoptionEligible': False, 'productionValidated': False,
                      'independentEvidence': False, 'availability': 'local_parameter_candidate', 'status': 'CANDIDATE',
                      'selectionProtocol': 'One frozen post-fit count-feature leaf projection; no new tree fits, '
                      'hyperparameter search or data-driven feature selection. Same original train and calibration membership; '
                      'current unchanged isotonic estimator must be refitted before outcome evaluation.'})
    parity = {'featureNames': names, 'rows': [
        {'matchId': row['matchId'], 'raw': {side: [float(raw[side][i])] for side in ('home', 'away')},
         'rawIncumbent': {side: [float(raw_incumbent[side][i])] for side in ('home', 'away')}}
        for i, row in enumerate(rows)], 'nativeIndependentParity': parity_sides,
        'counterfactualRows': 317, 'counterfactualIncrementBothCounts': 38}
    check_sources(plan)
    require(plan_path.read_bytes() == plan_bytes, 'plan_changed_during_projection')
    artifact_text, parity_text = encode(candidate), encode(parity)
    audit = {'createdAt': created, 'version': candidate['version'], 'parentVersion': VERSION,
             'planHash': plan_hash, 'identity': identity, 'sourceHashes': plan['sourceHashes'],
             'artifactHash': hashlib.sha256(artifact_text.encode()).hexdigest(),
             'parityHash': hashlib.sha256(parity_text.encode()).hexdigest(),
             'trainingSplit': split, 'frozenFold': fold, 'trainingRows': 5293, 'calibrationRows': 358,
             'calibrationPredictionsAAndMetadataUnchanged': True, 'calibrationProfilesRemovedPendingSameEstimatorRefit': True,
             'models': audit_sides, 'nativeIndependentParity': parity_sides,
             'countInvariance': {'selectionFeatureRows': 317, 'bothCountsIncrement': 38,
                                 'structuralGroupEquality': True, 'scoredOutcomes': False},
             'incumbentAndPinnedSourcesUnchanged': True, 'currentC75Unchanged': digest(ROOT / INCUMBENT) == INCUMBENT_HASH,
             'diagnosticOnly': True, 'productionAdoptionEligible': False, 'newTreeFits': 0}
    # Nothing is written until every technical check has passed. Never overwrite a prior candidate.
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
