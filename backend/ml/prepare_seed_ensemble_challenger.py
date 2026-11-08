"""One preregistered local seed ensemble; no tuning, adoption or provider access."""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from catboost import CatBoostRegressor, Pool, sum_models

import prepare_current_challenger as current
import train

PROTOCOL = 'fixed-seed-ensemble-v1'
RECIPE = current.RECIPE.copy()
SEEDS = [20261027, 20261028, 20261029, 20261030, 20261031]
MEMBER_WEIGHTS = [.2] * 5
AGGREGATION = 'mean_raw_log_intensity'
PARTITIONS = ('train', 'selection', 'calibration', 'test')
SELECTION_RULE = {
    'globalLogLossAndBrierBothStrictlyBetter': True,
    'minimumLeaguesBothStrictlyBetter': 4,
    'cohort': 'original reserved selection phase; raw probabilities with unchanged ML weight and temperature; no future calibrator',
}
INCUMBENT_PATH = Path(__file__).resolve().parents[1] / 'current-models/challenger.json'
RAW_TOLERANCE = 1e-10
MAX_RUNTIME_TREES = 1000


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def match_ids_hash(rows):
    return sha256('\n'.join(sorted(row['matchId'] for row in rows)).encode('utf-8'))


def checked_plan(plan, dataset_hash, baseline_version, incumbent_raw):
    """Bind the only allowed strategy to the incumbent and its original windows."""
    if (plan.get('protocol') != PROTOCOL or plan.get('baseRecipe') != RECIPE
            or plan.get('seeds') != SEEDS or plan.get('memberWeights') != MEMBER_WEIGHTS
            or plan.get('aggregation') != AGGREGATION
            or plan.get('selectionGate') != SELECTION_RULE
            or plan.get('maximumStrategies') != 1 or plan.get('maximumMemberFits') != 5
            or plan.get('productionAdoption') is not False):
        raise ValueError('fixed_seed_ensemble_plan_required')
    if plan.get('datasetHash') != dataset_hash or plan.get('baselineVersion') != baseline_version:
        raise ValueError('ensemble_plan_dataset_mismatch')
    incumbent = json.loads(incumbent_raw)
    if (not str(incumbent.get('version', '')).startswith('C-')
            or incumbent.get('baselineVersion') != baseline_version
            or incumbent.get('datasetHash') != dataset_hash
            or incumbent.get('hyperparameters') != RECIPE
            or incumbent.get('featureNames') != train.LEGACY_FEATURES
            or incumbent.get('candidateKind') != RECIPE['kind']
            or incumbent.get('weight') != RECIPE['weight']
            or incumbent.get('temperature') != RECIPE['temperature']
            or plan.get('incumbentVersion') != incumbent.get('version')
            or plan.get('incumbentArtifactHash') != sha256(incumbent_raw)):
        raise ValueError('ensemble_plan_incumbent_mismatch')
    if plan.get('trainingSplit') != incumbent.get('trainingSplit'):
        raise ValueError('ensemble_plan_original_split_required')
    train.checked_split_plan({'folds': [{'fold': 0, 'trainingSplit': plan['trainingSplit']}]})
    expected = plan.get('expectedPartitions')
    if (not isinstance(expected, dict) or set(expected) != set(PARTITIONS)
            or any(expected[part] != {key: plan['trainingSplit'][part][key] for key in ('n', 'matchIdsHash')}
                   for part in PARTITIONS)):
        raise ValueError('ensemble_plan_partition_evidence_required')
    for side in ('home', 'away'):
        if len(incumbent.get('models', {}).get(side, {}).get('oblivious_trees', [])) != RECIPE['iterations']:
            raise ValueError('ensemble_incumbent_tree_recipe_mismatch')
    return incumbent


def split_rows(rows, plan):
    """Preserve all four original forecast windows and purge unavailable labels."""
    frozen = plan['trainingSplit']
    fold = next(train.fixed_window_folds(rows, {'folds': [{'fold': 0, 'trainingSplit': frozen}]}))
    groups = dict(zip(PARTITIONS, fold[1:]))
    split = train.frozen_split_manifest([groups[part] for part in PARTITIONS], frozen)
    for part in PARTITIONS:
        evidence = {'n': len(groups[part]), 'matchIdsHash': match_ids_hash(groups[part])}
        if evidence != plan['expectedPartitions'][part] or split[part] != frozen[part]:
            raise ValueError(f'ensemble_plan_partition_mismatch: {part}')
    return groups, split


def prepare_dataset(dataset, plan, manifest):
    baseline = dataset.get('baselineManifest', {})
    if (baseline != manifest or baseline.get('protocolVersion') != 'current-a-statistical-asof-v2'
            or not str(baseline.get('version', '')).startswith('A-')
            or not isinstance(baseline.get('fingerprint'), str) or len(baseline['fingerprint']) != 64):
        raise ValueError('current_baseline_manifest_required')
    names, rows, holdout = train.checked_dataset(dataset, controlled=True)
    quality = train.checked_data_quality(dataset)
    if quality is None or holdout['protectedRowsUsed'] != 0:
        raise ValueError('clean_dataset_provenance_required')
    if any(row.get('baselineVersion') != baseline['version'] for row in rows):
        raise ValueError('dataset_baseline_mismatch')
    names, rows = train.project_feature_rows(rows, names, [])
    groups, split = split_rows(rows, plan)
    return names, rows, groups, split, holdout, quality


def train_members(rows, names):
    """Same training population for every seed; no resampling or member selection."""
    x = np.array([row['features'] for row in rows], dtype=float)
    members = []
    for seed in SEEDS:
        pair = {}
        for side in ('home', 'away'):
            y = np.array([row[f'{side}Goals'] for row in rows], dtype=float)
            model = CatBoostRegressor(loss_function='Poisson', iterations=RECIPE['iterations'],
                depth=RECIPE['depth'], learning_rate=RECIPE['learningRate'], random_seed=seed,
                thread_count=RECIPE['threadCount'], verbose=False, allow_writing_files=False)
            model.fit(Pool(x, label=y, baseline=None, feature_names=names))
            pair[side] = model
        members.append(pair)
    combined = {side: sum_models([member[side] for member in members], weights=MEMBER_WEIGHTS)
                for side in ('home', 'away')}
    for side, model in combined.items():
        if model.tree_count_ != len(SEEDS) * RECIPE['iterations'] or model.tree_count_ > MAX_RUNTIME_TREES:
            raise ValueError(f'ensemble_runtime_tree_limit: {side}')
    return members, combined


def incumbent_models(incumbent, output):
    """Load unchanged incumbent JSON into native CatBoost for the control check."""
    models = {}
    for side in ('home', 'away'):
        path = output / f'incumbent-{side}.json'
        with path.open('x', encoding='utf-8') as stream:
            json.dump(incumbent['models'][side], stream, allow_nan=False)
        models[side] = CatBoostRegressor().load_model(str(path), format='json')
        path.unlink()
    return models


def raw_predictions(models, features):
    values = {side: np.asarray(model.predict(features, prediction_type='RawFormulaVal'), dtype=float).reshape(-1)
              for side, model in models.items()}
    if any(len(raw) != len(features) or not np.all(np.isfinite(raw)) for raw in values.values()):
        raise ValueError('invalid_native_raw_predictions')
    return values


def parity_rows(rows, groups, members, combined, incumbent):
    """Check every retained feature row without evaluating any target label."""
    x = np.array([row['features'] for row in rows], dtype=float)
    raw = raw_predictions(combined, x)
    raw_members = [raw_predictions(member, x) for member in members]
    raw_incumbent = raw_predictions(incumbent, x)
    control_error = max(float(np.max(np.abs(raw_members[0][side] - raw_incumbent[side])))
                        for side in ('home', 'away'))
    aggregation_error = max(float(np.max(np.abs(raw[side] - np.average(
        [member[side] for member in raw_members], axis=0, weights=MEMBER_WEIGHTS))))
        for side in ('home', 'away'))
    if control_error > RAW_TOLERANCE:
        raise ValueError('ensemble_control_incumbent_raw_parity_failed')
    if aggregation_error > RAW_TOLERANCE:
        raise ValueError('ensemble_native_aggregation_parity_failed')
    diversity = {}
    for side in ('home', 'away'):
        spread = np.std([member[side] for member in raw_members], axis=0)
        diversity[side] = {'meanRawStandardDeviation': float(spread.mean()),
                           'maximumRawStandardDeviation': float(spread.max()),
                           'rowsWithDistinctMembers': int(np.sum(spread > RAW_TOLERANCE))}
    by_id = {row['matchId']: index for index, row in enumerate(rows)}
    sample = [row for part in PARTITIONS for row in groups[part][:6]]
    return {'protocol': 'catboost-native-json-raw-parity-v1', 'featureNames': train.LEGACY_FEATURES,
        'checkedRows': len(rows), 'maximumControlIncumbentError': control_error,
        'maximumNativeAggregationError': aggregation_error, 'memberDiversity': diversity,
        'aggregation': AGGREGATION, 'seeds': SEEDS, 'memberWeights': MEMBER_WEIGHTS,
        'rows': [{'matchId': row['matchId'], 'features': row['features'],
            'raw': {side: [float(raw[side][by_id[row['matchId']]])] for side in ('home', 'away')},
            'rawControl': {side: [float(raw_members[0][side][by_id[row['matchId']]])] for side in ('home', 'away')},
            'rawMembers': [{'seed': seed, 'raw': {
                side: [float(member[side][by_id[row['matchId']]])] for side in ('home', 'away')}}
                for seed, member in zip(SEEDS, raw_members)]} for row in sample]}


def candidate_matrices(rows, models):
    raw = train.raw_matrices(rows, RECIPE['kind'], models)
    if len(raw) != len(rows):
        raise ValueError('incomplete_ensemble_predictions')
    return [train.calibrated_mix(train.normalize(row['baselineMatrix']), ml,
                                RECIPE['weight'], RECIPE['temperature']) for row, ml in zip(rows, raw)]


def selection_gate(control, ensemble):
    """A single preregistered pass/fail decision; never tune to these labels."""
    metrics = ('logLoss', 'brier')
    leagues = set(control['byLeague'])
    if len(leagues) != 5 or leagues != set(ensemble['byLeague']):
        raise ValueError('ensemble_selection_requires_five_leagues')
    values = [summary[metric] for summary in (control, ensemble) for metric in metrics]
    values += [summary['byLeague'][league][metric]
               for summary in (control, ensemble) for league in leagues for metric in metrics]
    if not all(np.isfinite(value) for value in values):
        raise ValueError('invalid_ensemble_selection_metrics')
    global_better = all(ensemble[key] < control[key] for key in metrics)
    improved = sorted(league for league in leagues
                      if all(ensemble['byLeague'][league][key] < control['byLeague'][league][key] for key in metrics))
    return {'passed': global_better and len(improved) >= 4,
        'globalBothStrictlyBetter': global_better, 'leaguesBothStrictlyBetter': improved,
        'requiredLeagues': 4, 'totalLeagues': 5, 'rule': SELECTION_RULE,
        'usedForMemberOrHyperparameterSelection': False}


def source_paths():
    root = Path(train.__file__).resolve().parents[1]
    return {'trainer': Path(train.__file__).resolve(), 'ensembleScript': Path(__file__).resolve(),
        'recipeScript': Path(current.__file__).resolve(),
        'holdoutPolicy': root / 'src/research/original-holdout-policy.json',
        'qualityPolicy': root / 'src/research/challenger-data-quarantine.json'}


def run(input_path, output, plan_path):
    input_path, output, plan_path = Path(input_path).resolve(), Path(output).resolve(), Path(plan_path).resolve()
    paths = {'dataset': input_path, 'plan': plan_path, 'incumbent': INCUMBENT_PATH.resolve(), **source_paths()}
    if output.exists() or any(output == path or output in path.parents for path in paths.values()):
        raise ValueError('new_output_directory_required')
    snapshots = {name: path.read_bytes() for name, path in paths.items()}
    dataset, plan = json.loads(snapshots['dataset']), json.loads(snapshots['plan'])
    incumbent = checked_plan(plan, sha256(snapshots['dataset']), dataset.get('baselineManifest', {}).get('version'), snapshots['incumbent'])
    manifest = current.current_manifest()
    names, rows, groups, split, holdout, quality = prepare_dataset(dataset, plan, manifest)
    if train.catboost_version != '1.2.8':
        raise ValueError('fixed_recipe_requires_catboost_1_2_8')
    output.mkdir(parents=False, exist_ok=False)
    members, combined = train_members(groups['train'], names)
    parity = parity_rows(rows, groups, members, combined, incumbent_models(incumbent, output))
    selection_metrics = {name: train.matrix_metrics(groups['selection'], candidate_matrices(groups['selection'], models))[0]
                         for name, models in (('control', members[0]), ('ensemble', combined))}
    gate = selection_gate(selection_metrics['control'], selection_metrics['ensemble'])
    predictions = []
    for row, matrix in zip(groups['calibration'], candidate_matrices(groups['calibration'], combined)):
        predictions.append({key: row[key] for key in ('matchId', 'availableAt', 'forecastAt', 'kickoffAt', 'competition', 'homeGoals', 'awayGoals')}
            | {'season': row.get('season'), 'matrixA': train.normalize(row['baselineMatrix']).tolist(),
               'matrixC': matrix.tolist(), 'probabilitiesA': row['baselineProbabilities']})
    exported = {}
    for side in ('home', 'away'):
        path = output / f'ensemble-{side}.json'
        exported[side] = train.export_model(combined[side], path)
        path.unlink()
        count = len(exported[side].get('oblivious_trees', []))
        if count != len(SEEDS) * RECIPE['iterations'] or count > MAX_RUNTIME_TREES:
            raise ValueError('ensemble_exported_tree_count_mismatch')
    if any(path.read_bytes() != snapshots[name] for name, path in paths.items()) or current.current_manifest() != manifest:
        raise ValueError('ensemble_sources_changed_during_training')
    hashes = {name: sha256(raw) for name, raw in snapshots.items()}
    created = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    identity = {'protocol': PROTOCOL, 'sourceHashes': hashes, 'datasetHash': hashes['dataset'],
        'baselineManifest': manifest, 'trainingSplit': split, 'baseRecipe': RECIPE,
        'seeds': SEEDS, 'memberWeights': MEMBER_WEIGHTS, 'aggregation': AGGREGATION,
        'incumbentVersion': incumbent['version'], 'createdAt': created,
        'catboostVersion': train.catboost_version, 'featureNames': names}
    version = 'C-' + train.json_stringify_hash(identity)[:16]
    artifact = {'version': version, 'family': 'C', 'featureNames': names, 'featureSchema': 'prematch-numeric-v1',
        'baselineVersion': manifest['version'], 'baselineManifest': manifest,
        'trainedThrough': split['train']['availableThrough'], 'validationThrough': split['calibration']['availableThrough'],
        'createdAt': created, 'candidateKind': RECIPE['kind'], 'weight': RECIPE['weight'], 'temperature': RECIPE['temperature'],
        'models': exported, 'datasetHash': hashes['dataset'], 'trainerHash': hashes['trainer'],
        'sourceHashes': hashes, 'identity': identity, 'trainingSplit': split, 'splitPlanHash': hashes['plan'],
        'trainingForecastTiming': dataset['forecastTiming'], 'holdoutProtection': holdout,
        'dataQualityPolicyHash': quality['policyHash'], 'dataQualityBaselineClean': True, 'dataQualityEvidence': quality['evidence'],
        'hyperparameters': {'baseRecipe': RECIPE, 'seeds': SEEDS, 'memberWeights': MEMBER_WEIGHTS, 'aggregation': AGGREGATION},
        'parentRecipeOrigin': train.C906_RECIPE_ORIGIN, 'calibrationPredictions': predictions,
        'status': 'CANDIDATE', 'productionValidated': False, 'availability': 'local_seed_ensemble_candidate',
        'independentEvidence': False, 'oddsAsFeatures': False, 'selectionGate': gate,
        'diagnosticOnly': not gate['passed'],
        'selectionProtocol': 'One fixed seed ensemble; unchanged original partitions; reserved selection pass/fail only; no tuning.'}
    if not gate['passed']:
        artifact['productionAdoptionEligible'] = False
    report = {'modelVersion': version, 'identity': identity, 'plan': plan, 'holdoutProtection': holdout,
        'quarantinePolicyHash': quality['policyHash'], 'selectionGate': gate, 'selectionMetrics': selection_metrics,
        'partitionPurpose': {'train': 'fit all five members', 'selection': 'preregistered pass/fail only',
                             'calibration': 'calibration export only', 'test': 'already consulted; no target evaluation in this trainer'},
        'independentValidation': False, 'productionAdoption': False,
        'outcome': 'AWAITING_INDEPENDENT_VALIDATION' if gate['passed'] else 'REJECTED_AT_DEVELOPMENT_GATE',
        'inputIntegrityVerified': True, 'baselineManifestVerified': True,
        'maximumControlIncumbentError': parity['maximumControlIncumbentError'],
        'maximumNativeAggregationError': parity['maximumNativeAggregationError'], 'memberDiversity': parity['memberDiversity']}
    for filename, value in (('artifact.json', artifact), ('report.json', report), ('parity.json', parity)):
        with (output / filename).open('x', encoding='utf-8') as stream:
            json.dump(value, stream, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
            stream.write('\n')
    return version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--plan', required=True)
    args = parser.parse_args()
    print(json.dumps({'version': run(args.input, args.output, args.plan), 'output': args.output}))


if __name__ == '__main__':
    main()
