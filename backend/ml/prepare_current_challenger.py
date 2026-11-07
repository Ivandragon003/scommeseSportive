"""One fixed, local challenger refit; no selection, adoption, network or database access."""
from __future__ import annotations
import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import train

RECIPE = {"kind": "calibrated_ensemble", "iterations": 120, "depth": 5,
          "learningRate": .05, "seed": 20261027, "threadCount": 2, "weight": .75, "temperature": .8}
def split_rows(rows, plan):
    """Use the last already-frozen fold with label purging at every boundary."""
    folds = train.checked_split_plan(plan)
    selected = folds[-1]
    matches = list(train.fixed_window_folds(rows, {'folds': [selected]}))
    if len(matches) != 1:
        raise ValueError('last_frozen_fold_unavailable')
    groups = list(matches[0][1:])
    if any(len(group) < 5 for group in groups):
        raise ValueError('insufficient_fixed_split_rows')
    return groups, train.frozen_split_manifest(groups, selected['trainingSplit']), selected['fold']


def current_manifest():
    module = Path(__file__).resolve().parents[1] / 'dist/research/ForecastCore.js'
    command = "process.stdout.write(JSON.stringify(require(process.argv[1]).baselineManifest()))"
    result = subprocess.run(['node', '-e', command, str(module)], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


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
    groups, split, fold = split_rows(rows, plan)
    return names, groups, split, holdout, quality, fold


def run(input_path, output, split_plan):
    input_path, output = Path(input_path), Path(output)
    raw = input_path.read_bytes()
    dataset = json.loads(raw)
    plan_raw = Path(split_plan).read_bytes()
    plan = json.loads(plan_raw)
    names, groups, split, holdout, quality, fold = prepare_dataset(dataset, plan, current_manifest())
    if train.catboost_version != '1.2.8':
        raise ValueError('fixed_recipe_requires_catboost_1_2_8')
    # Exclusive creation protects any existing user artifacts.
    output.mkdir(parents=False, exist_ok=False)
    models, exported = train.train_candidates(groups[0], names, output, RECIPE['iterations'], RECIPE['depth'],
                                               kinds=(RECIPE['kind'],))
    raw_matrices = train.raw_matrices(groups[2], RECIPE['kind'], models[RECIPE['kind']])
    predictions = []
    for row, ml in zip(groups[2], raw_matrices):
        base = train.normalize(row['baselineMatrix'])
        matrix = train.calibrated_mix(base, ml, RECIPE['weight'], RECIPE['temperature'])
        predictions.append({key: row[key] for key in ('matchId', 'availableAt', 'forecastAt', 'kickoffAt', 'competition', 'homeGoals', 'awayGoals')}
                           | {'season': row.get('season'), 'matrixA': base.tolist(), 'matrixC': matrix.tolist(),
                              'probabilitiesA': row['baselineProbabilities']})
    dataset_hash = hashlib.sha256(raw).hexdigest()
    trainer_hash = hashlib.sha256(Path(train.__file__).read_bytes()).hexdigest()
    script_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    created = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    identity = {'datasetHash': dataset_hash, 'trainerHash': trainer_hash, 'scriptHash': script_hash,
                'baselineManifest': dataset['baselineManifest'], 'split': split, 'splitPlanHash': hashlib.sha256(plan_raw).hexdigest(),
                'frozenFold': fold, 'recipe': RECIPE, 'createdAt': created}
    version = 'C-' + train.json_stringify_hash(identity)[:16]
    artifact = {'version': version, 'family': 'C', 'featureNames': names, 'featureSchema': 'prematch-numeric-v1',
        'baselineVersion': dataset['baselineManifest']['version'], 'trainedThrough': split['train']['availableThrough'],
        'validationThrough': max((split[p]['availableThrough'] for p in ('selection', 'calibration')), key=train.timestamp),
        'createdAt': created, 'candidateKind': RECIPE['kind'], 'weight': RECIPE['weight'], 'temperature': RECIPE['temperature'],
        'models': exported[RECIPE['kind']], 'datasetHash': dataset_hash, 'trainerHash': trainer_hash,
        'trainingSplit': split, 'splitPlanHash': hashlib.sha256(plan_raw).hexdigest(), 'frozenFold': fold, 'trainingForecastTiming': dataset['forecastTiming'], 'holdoutProtection': holdout,
        'dataQualityPolicyHash': quality['policyHash'], 'dataQualityBaselineClean': True, 'dataQualityEvidence': quality['evidence'],
        'hyperparameters': RECIPE, 'parentRecipeOrigin': train.C906_RECIPE_ORIGIN, 'calibrationPredictions': predictions,
        'status': 'CANDIDATE', 'productionValidated': False, 'availability': 'local_refit_candidate', 'independentEvidence': False,
        'oddsAsFeatures': False, 'selectionProtocol': 'Fixed recipe and fixed temporal partitions; no hyperparameter selection.'}
    report = {'modelVersion': version, 'identity': identity, 'holdoutProtection': holdout,
        'quarantinePolicyHash': quality['policyHash'], 'partitionPurpose': {'train': 'fit', 'selection': 'reserved',
        'calibration': 'calibration only', 'test': 'historical diagnostic only'}, 'independentValidation': False,
        'productionAdoption': False, 'metrics': None}
    (output / 'artifact.json').write_text(json.dumps(artifact, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    (output / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    # train_candidates exports these transient files before embedding them in the artifact.
    for side in ('home', 'away'):
        (output / f"{RECIPE['kind']}-{side}.json").unlink()
    return version


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--split-plan', required=True)
    args = parser.parse_args()
    print(json.dumps({'version': run(args.input, args.output, args.split_plan), 'output': args.output}))


if __name__ == '__main__':
    main()
