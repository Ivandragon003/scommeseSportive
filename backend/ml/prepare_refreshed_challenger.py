"""Fit one local temporal refresh; never select, adopt, or contact a provider."""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import prepare_current_challenger as current
import train

RECIPE = current.RECIPE
PROTOCOL = 'fixed-temporal-refresh-v1'
TRAIN_BEFORE = '2026-01-01T00:00:00.000Z'
CALIBRATION_BEFORE = '2026-07-01T00:00:00.000Z'
INCUMBENT_PATH = Path(__file__).resolve().parents[1] / 'current-models/challenger.json'


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def match_ids_hash(rows):
    return sha256('\n'.join(sorted(row['matchId'] for row in rows)).encode('utf-8'))


def checked_plan(plan, dataset_hash, baseline_version, incumbent_raw):
    incumbent = json.loads(incumbent_raw)
    if (plan.get('protocol') != PROTOCOL or plan.get('recipe') != RECIPE
            or plan.get('trainBefore') != TRAIN_BEFORE or plan.get('calibrationFrom') != TRAIN_BEFORE
            or plan.get('calibrationBefore') != CALIBRATION_BEFORE):
        raise ValueError('fixed_temporal_refresh_plan_required')
    if plan.get('datasetHash') != dataset_hash or plan.get('baselineVersion') != baseline_version:
        raise ValueError('refresh_plan_dataset_mismatch')
    if (not str(incumbent.get('version', '')).startswith('C-')
            or incumbent.get('baselineVersion') != baseline_version
            or plan.get('incumbentVersion') != incumbent.get('version')
            or plan.get('incumbentArtifactHash') != sha256(incumbent_raw)):
        raise ValueError('refresh_plan_incumbent_mismatch')
    expected = plan.get('expectedPartitions')
    if not isinstance(expected, dict) or set(expected) != {'train', 'calibration'}:
        raise ValueError('refresh_plan_partition_evidence_required')
    for part in expected.values():
        if (not isinstance(part, dict) or set(part) != {'n', 'matchIdsHash'}
                or type(part['n']) is not int or part['n'] < 5
                or not isinstance(part['matchIdsHash'], str) or len(part['matchIdsHash']) != 64
                or any(character not in '0123456789abcdef' for character in part['matchIdsHash'])):
            raise ValueError('refresh_plan_partition_evidence_required')


def interval(rows):
    return {'n': len(rows), 'from': min((row['forecastAt'] for row in rows), key=train.timestamp),
            'to': max((row['forecastAt'] for row in rows), key=train.timestamp),
            'availableThrough': max((row['availableAt'] for row in rows), key=train.timestamp),
            'matchIdsHash': match_ids_hash(rows)}


def split_rows(rows, plan):
    """Purge labels at the fixed boundaries; later rows are diagnostics only."""
    boundary, end = train.timestamp(TRAIN_BEFORE), train.timestamp(CALIBRATION_BEFORE)
    groups = {'train': [], 'calibration': [], 'diagnostic': [], 'purged': []}
    for row in sorted(rows, key=lambda item: (train.timestamp(item['forecastAt']), item['matchId'])):
        forecast, available = train.timestamp(row['forecastAt']), train.timestamp(row['availableAt'])
        if forecast < boundary and available < boundary:
            groups['train'].append(row)
        elif boundary <= forecast < end and available < end:
            groups['calibration'].append(row)
        elif forecast >= end:
            groups['diagnostic'].append(row)
        else:
            groups['purged'].append(row)
    for part in ('train', 'calibration'):
        expected = plan['expectedPartitions'][part]
        if len(groups[part]) != expected['n'] or match_ids_hash(groups[part]) != expected['matchIdsHash']:
            raise ValueError(f'refresh_plan_partition_mismatch: {part}')
        if len(groups[part]) < 5:
            raise ValueError(f'insufficient_refresh_rows: {part}')
    split = {'protocol': PROTOCOL, 'train': interval(groups['train']),
             'calibration': interval(groups['calibration']),
             'boundaries': {'trainBefore': TRAIN_BEFORE, 'calibrationFrom': TRAIN_BEFORE,
                            'calibrationBefore': CALIBRATION_BEFORE},
             'independentTest': {'n': 0, 'available': False, 'reason': 'no_unseen_test_used'},
             'diagnostic': {'n': len(groups['diagnostic']), 'matchIdsHash': match_ids_hash(groups['diagnostic']),
                            'usedForFit': False, 'usedForCalibration': False},
             'purged': {'n': len(groups['purged']), 'matchIdsHash': match_ids_hash(groups['purged'])}}
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
    return names, groups, split, holdout, quality


def source_paths():
    return {'trainer': Path(train.__file__).resolve(), 'refreshScript': Path(__file__).resolve(),
            'recipeScript': Path(current.__file__).resolve(),
            'holdoutPolicy': Path(train.__file__).resolve().parents[1] / 'src/research/original-holdout-policy.json',
            'qualityPolicy': Path(train.__file__).resolve().parents[1] / 'src/research/challenger-data-quarantine.json'}


def parity_rows(groups, models):
    """Native raw predictions bind JSON inference checks without evaluating targets."""
    rows = groups['train'][:8] + groups['calibration'][:8] + groups['diagnostic'][:8]
    features = np.array([row['features'] for row in rows], dtype=float)
    raw = {side: models[side].predict(features, prediction_type='RawFormulaVal') for side in ('home', 'away')}
    return {'protocol': 'catboost-native-json-raw-parity-v1', 'rows': [
        {'matchId': row['matchId'], 'features': row['features'],
         'raw': {side: [float(raw[side][index])] for side in ('home', 'away')}}
        for index, row in enumerate(rows)]}


def run(input_path, output, plan_path):
    input_path, output, plan_path = Path(input_path).resolve(), Path(output).resolve(), Path(plan_path).resolve()
    paths = {'dataset': input_path, 'plan': plan_path, 'incumbent': INCUMBENT_PATH.resolve(), **source_paths()}
    if output.exists() or any(output == path or output in path.parents for path in paths.values()):
        raise ValueError('new_output_directory_required')
    snapshots = {name: path.read_bytes() for name, path in paths.items()}
    dataset, plan = json.loads(snapshots['dataset']), json.loads(snapshots['plan'])
    checked_plan(plan, sha256(snapshots['dataset']), dataset.get('baselineManifest', {}).get('version'), snapshots['incumbent'])
    manifest = current.current_manifest()
    names, groups, split, holdout, quality = prepare_dataset(dataset, plan, manifest)
    if train.catboost_version != '1.2.8':
        raise ValueError('fixed_recipe_requires_catboost_1_2_8')
    output.mkdir(parents=False, exist_ok=False)
    models, exported = train.train_candidates(groups['train'], names, output, RECIPE['iterations'], RECIPE['depth'],
                                               kinds=(RECIPE['kind'],))
    raw = train.raw_matrices(groups['calibration'], RECIPE['kind'], models[RECIPE['kind']])
    if len(raw) != len(groups['calibration']):
        raise ValueError('incomplete_refresh_calibration_predictions')
    predictions = []
    for row, ml in zip(groups['calibration'], raw):
        base = train.normalize(row['baselineMatrix'])
        matrix = train.calibrated_mix(base, ml, RECIPE['weight'], RECIPE['temperature'])
        predictions.append({key: row[key] for key in ('matchId', 'availableAt', 'forecastAt', 'kickoffAt', 'competition', 'homeGoals', 'awayGoals')}
                           | {'season': row.get('season'), 'matrixA': base.tolist(), 'matrixC': matrix.tolist(),
                              'probabilitiesA': row['baselineProbabilities']})
    parity = parity_rows(groups, models[RECIPE['kind']])
    if any(path.read_bytes() != snapshots[name] for name, path in paths.items()) or current.current_manifest() != manifest:
        raise ValueError('refresh_sources_changed_during_training')
    hashes = {name: sha256(raw_bytes) for name, raw_bytes in snapshots.items()}
    created = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    identity = {'protocol': PROTOCOL, 'sourceHashes': hashes, 'baselineManifest': manifest, 'split': split,
                'recipe': RECIPE, 'incumbentVersion': plan['incumbentVersion'], 'createdAt': created,
                'catboostVersion': train.catboost_version, 'featureNames': names}
    version = 'C-' + train.json_stringify_hash(identity)[:16]
    artifact = {'version': version, 'family': 'C', 'featureNames': names, 'featureSchema': 'prematch-numeric-v1',
        'baselineVersion': manifest['version'], 'baselineManifest': manifest,
        'trainedThrough': split['train']['availableThrough'], 'validationThrough': split['calibration']['availableThrough'],
        'createdAt': created, 'candidateKind': RECIPE['kind'], 'weight': RECIPE['weight'], 'temperature': RECIPE['temperature'],
        'models': exported[RECIPE['kind']], 'datasetHash': hashes['dataset'], 'trainerHash': hashes['trainer'],
        'sourceHashes': hashes, 'identity': identity, 'trainingSplit': split, 'splitPlanHash': hashes['plan'],
        'trainingForecastTiming': dataset['forecastTiming'], 'holdoutProtection': holdout,
        'dataQualityPolicyHash': quality['policyHash'], 'dataQualityBaselineClean': True, 'dataQualityEvidence': quality['evidence'],
        'hyperparameters': RECIPE, 'parentRecipeOrigin': train.C906_RECIPE_ORIGIN, 'calibrationPredictions': predictions,
        'status': 'CANDIDATE', 'productionValidated': False, 'availability': 'local_refreshed_candidate',
        'independentEvidence': False, 'oddsAsFeatures': False,
        'selectionProtocol': 'Fixed temporal refresh; one fixed recipe; no hyperparameter selection or independent test.'}
    report = {'modelVersion': version, 'identity': identity, 'plan': plan, 'holdoutProtection': holdout,
        'quarantinePolicyHash': quality['policyHash'], 'partitionPurpose': {'train': 'fit',
        'calibration': 'calibration only', 'diagnostic': 'not used for fit or calibration', 'purged': 'excluded'},
        'independentValidation': False, 'productionAdoption': False, 'metrics': None,
        'inputIntegrityVerified': True, 'baselineManifestVerified': True}
    for name, value in (('artifact.json', artifact), ('report.json', report), ('parity.json', parity)):
        with (output / name).open('x', encoding='utf-8') as stream:
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
