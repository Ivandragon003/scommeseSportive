"""Five frozen annual expanding-window fits and one fixed count-leaf projection."""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
L2_HELPER = HERE.parent / 'c-tree-l2-research/prepare.py'
SPEC = importlib.util.spec_from_file_location('annual_projection_training_helpers', L2_HELPER)
l2 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(l2)
shared, ml, current = l2.shared, l2.train, l2.current
ROOT, require, digest, encode = shared.ROOT, shared.require, shared.digest, shared.encode
YEARS = tuple(range(2021, 2026))
LEAGUES = ('Bundesliga', 'La Liga', 'Ligue 1', 'Premier League', 'Serie A')
PROTOCOL = 'c-five-season-projection-research-v1'
SPLIT_PROTOCOL = 'annual-expanding-train-reserved-calibration-test-v1'
RECIPE = {'iterations': 120, 'depth': 5, 'learning_rate': .05, 'random_seed': 20261027,
          'thread_count': 2, 'verbose': False, 'allow_writing_files': False, 'loss_function': 'Poisson'}


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def boundaries(year):
    require(year in YEARS, 'only_five_declared_years_supported')
    return {'trainBefore': f'{year}-03-01T00:00:00.000Z', 'reservedFrom': f'{year}-03-01T00:00:00.000Z',
            'reservedTo': f'{year}-05-01T00:00:00.000Z', 'calibrationFrom': f'{year}-05-01T00:00:00.000Z',
            'calibrationTo': f'{year}-07-01T00:00:00.000Z', 'testFrom': f'{year}-07-01T00:00:00.000Z',
            'testTo': f'{year + 1}-07-01T00:00:00.000Z'}


def membership(rows):
    ids = [row['matchId'] for row in rows]
    result = {'n': len(rows), 'matchIds': ids, 'matchIdsHash': hashlib.sha256('\n'.join(sorted(ids)).encode()).hexdigest(),
              'orderedMatchIdsHash': hashlib.sha256('\n'.join(ids).encode()).hexdigest(),
              'competitionCounts': {league: sum(row['competition'] == league for row in rows) for league in LEAGUES},
              'seasonCounts': {season: sum(row['season'] == season for row in rows) for season in sorted({row['season'] for row in rows})}}
    for key, source in [('from', 'forecastAt'), ('to', 'forecastAt'), ('availableThrough', 'availableAt')]:
        result[key] = (min if key == 'from' else max)((row[source] for row in rows), key=ml.timestamp) if rows else None
    return result


def partition_rows(rows, year):
    limits = boundaries(year)
    train_end, calibration_start, test_start, test_end = [ml.timestamp(limits[key]) for key in ('trainBefore', 'calibrationFrom', 'testFrom', 'testTo')]
    ordered = sorted(rows, key=lambda row: (ml.timestamp(row['forecastAt']), row['matchId']))
    groups = {key: [] for key in ('train', 'reserved', 'calibration', 'test')}
    purged = {'train': [], 'calibration': []}
    for row in ordered:
        forecast, available = ml.timestamp(row['forecastAt']), ml.timestamp(row['availableAt'])
        if forecast < train_end:
            (groups['train'] if available < train_end else purged['train']).append(row)
        elif forecast < calibration_start:
            groups['reserved'].append(row)
        elif forecast < test_start:
            (groups['calibration'] if available < test_start else purged['calibration']).append(row)
        elif forecast < test_end:
            groups['test'].append(row)
    for part in ('train', 'calibration', 'test'):
        require(groups[part] and {row['competition'] for row in groups[part]} == set(LEAGUES),
                f'complete_five_league_partition_required:{year}:{part}')
    require(all(row['season'] == f'{year}/{year + 1}' for row in groups['test']), f'test_season_mismatch:{year}')
    require(all(row['season'] == f'{year - 1}/{year}' for row in groups['calibration']), f'calibration_season_mismatch:{year}')
    seen = set()
    for part, group in groups.items():
        ids = {row['matchId'] for row in group}
        require(len(ids) == len(group) and not seen.intersection(ids), f'overlapping_or_duplicate_partition:{year}:{part}')
        seen.update(ids)
    return groups, {part: membership(group) for part, group in groups.items()}, {
        part: [row['matchId'] for row in group] for part, group in purged.items()}


def checked_folds(rows, plan):
    folds = plan.get('folds')
    require(isinstance(folds, list) and [fold.get('year') for fold in folds] == list(YEARS), 'exactly_five_annual_folds_required')
    prepared = []
    for fold in folds:
        groups, actual, purged = partition_rows(rows, fold['year'])
        require(set(fold.get('memberships', {})) == set(actual), 'all_four_frozen_memberships_required')
        for part, manifest in actual.items():
            expected = fold['memberships'][part]
            require(all(expected.get(key) == manifest[key] for key in ('n', 'matchIdsHash', 'orderedMatchIdsHash')),
                    f'frozen_membership_mismatch:{fold["year"]}:{part}')
            for key in ('from', 'to', 'availableThrough', 'competitionCounts', 'seasonCounts'):
                if key in expected:
                    require(expected[key] == manifest[key], f'frozen_membership_metadata_mismatch:{fold["year"]}:{part}:{key}')
        prepared.append((fold['year'], groups, actual, purged))
    return prepared


def checked_plan(plan, dataset_path, dataset_hash):
    require(plan.get('protocol') == PROTOCOL, 'wrong_execution_protocol')
    require(plan.get('phase') == 'execution', 'final_execution_plan_required')
    require(plan.get('datasetHash') == dataset_hash, 'frozen_dataset_hash_required')
    require(plan.get('recipe') == RECIPE and plan.get('l2LeafReg') == 3, 'original_c75_recipe_required')
    require(isinstance(plan.get('inputsPlanHash'), str) and re.fullmatch('[0-9a-f]{64}', plan['inputsPlanHash']), 'inputs_plan_hash_required')
    for source, expected in plan.get('sourceHashes', {}).items():
        file = (ROOT / source).resolve()
        require(file.is_relative_to(ROOT) and digest(file) == expected, f'pinned_source_changed:{source}')
    require(dataset_path.is_relative_to(ROOT) and plan['sourceHashes'].get(dataset_path.relative_to(ROOT).as_posix()) == dataset_hash,
            'dataset_must_be_pinned_source')
    for path in (L2_HELPER, Path(shared.__file__), Path(ml.__file__), Path(current.__file__)):
        require(plan['sourceHashes'].get(path.relative_to(ROOT).as_posix()) == digest(path), 'training_helpers_must_be_pinned')
    require(digest(ROOT / shared.INCUMBENT) == shared.INCUMBENT_HASH, 'original_c75_reference_changed')
    require(shared.catboost_version == '1.2.8', 'catboost_1_2_8_required')


def checked_dataset(dataset, plan):
    manifest = current.current_manifest()
    require(dataset.get('baselineManifest') == manifest == plan.get('baselineManifest'), 'current_baseline_manifest_required')
    require(dataset.get('reproduction', {}).get('planHash') == plan['inputsPlanHash'], 'dataset_inputs_plan_mismatch')
    source_names, rows, holdout = ml.checked_dataset(dataset, controlled=True)
    quality = ml.checked_data_quality(dataset)
    require(quality is not None and holdout['protectedRowsUsed'] == 0 and holdout['protectedFinalCount'] == 745,
            'clean_protected_holdout_provenance_required')
    protected = set(ml.protected_holdout_policy()['protectedOriginalFinalMatchIds'])
    quarantine = {entry['matchId'] for entry in ml.challenger_data_quality_policy()['entries']}
    require(len(quarantine) == 22 and all(row['matchId'] not in protected | quarantine for row in rows), 'all_protected_and_quarantined_targets_must_be_excluded')
    require(all(row.get('baselineVersion') == manifest['version'] and re.fullmatch(r'20\d\d/20\d\d', row['season']) for row in rows),
            'row_baseline_or_season_schema_mismatch')
    names, projected_rows = ml.project_feature_rows(rows, source_names, [])
    require(len(names) == 40 and [names[index] for index in (1, 17)] == list(shared.TARGETS), 'original40_features_required')
    return names, projected_rows, holdout, quality


def fit_original_pair(rows, names, directory):
    return l2.fit_pair(rows, names, RECIPE, 3., directory, 'original')[:2]


def project_pair(original, native, names, training_rows):
    x = l2.features(training_rows)
    projected, audit = {}, {}
    for side in ('home', 'away'):
        projected[side], audit[side] = shared.project_model(original[side], names, x, native[side].calc_leaf_indexes(x, thread_count=2))
    return projected, audit


def artifact(models, arm, year, plan, plan_hash, dataset_hash, memberships, baseline, created, quality, parent=None):
    split = {'protocol': SPLIT_PROTOCOL, **{part: {key: value for key, value in item.items() if key != 'matchIds'} for part, item in memberships.items()}}
    identity = {'method': 'original-count-leaf-projection' if arm == 'projected' else 'original-c75-recipe-fold-fit',
                'year': year, 'arm': arm, 'planHash': plan_hash, 'datasetHash': dataset_hash,
                'scriptHash': digest(__file__), 'projectionHelperHash': digest(Path(shared.__file__)),
                'modelsHash': hashlib.sha256(encode(models).encode()).hexdigest(), 'memberships': split, 'createdAt': created}
    result = {'version': 'C-' + ml.json_stringify_hash(identity)[:16], 'family': 'C', 'models': models,
              'featureNames': ml.LEGACY_FEATURES, 'featureSchema': 'prematch-numeric-v1', 'candidateKind': 'calibrated_ensemble',
              'weight': .75, 'temperature': .8, 'baselineVersion': baseline['version'],
              'trainedThrough': memberships['train']['availableThrough'], 'validationThrough': memberships['calibration']['availableThrough'],
              'createdAt': created, 'datasetHash': dataset_hash, 'trainerHash': digest(__file__), 'trainingSplit': split,
              'splitPlanHash': plan_hash, 'foldYear': year, 'testSeason': f'{year}/{year + 1}', 'foldBoundaries': boundaries(year),
              'hyperparameters': copy.deepcopy(RECIPE) | {'l2LeafReg': 3., 'weight': .75, 'temperature': .8},
              'parentRecipeOrigin': {'version': shared.VERSION, 'artifactHash': shared.INCUMBENT_HASH, 'role': 'Recipe reference only; new fold models.'},
              'experimentIdentity': identity, 'dataQualityPolicyHash': quality['policyHash'], 'dataQualityBaselineClean': True,
              'dataQualityEvidence': quality.get('evidence'),
              'status': 'CANDIDATE', 'availability': 'local_retrospective_fold_candidate', 'retrospectiveFold': True,
              'diagnosticOnly': True, 'productionValidated': False, 'productionAdoptionEligible': False, 'independentEvidence': False,
              'calibrationPredictionsFile': 'predictions.json', 'calibrationPartition': 'calibration',
              'selectionProtocol': 'Five frozen annual expanding folds; no variant search. March-April reserved, May-June calibration for both arms.'}
    if parent:
        result['parentVersion'] = parent
        result['parameterExperiment'] = {'method': shared.METHOD, 'targets': list(shared.TARGETS), 'trainingSupportOnly': True, 'newTreeFits': 0}
    require(ml.timestamp(result['trainedThrough']) < ml.timestamp(boundaries(year)['trainBefore'])
            and ml.timestamp(result['validationThrough']) < ml.timestamp(boundaries(year)['testFrom']), 'model_availability_boundaries_invalid')
    return result


def write_json(path, value):
    path.write_text(encode(value), encoding='utf-8')


def run(plan_path, dataset_path, output):
    plan_path, dataset_path, output = Path(plan_path).resolve(), Path(dataset_path).resolve(), Path(output).resolve()
    require(not output.exists(), 'exclusive_new_output_required')
    plan_bytes, data_bytes = plan_path.read_bytes(), dataset_path.read_bytes()
    plan_hash, dataset_hash = hashlib.sha256(plan_bytes).hexdigest(), hashlib.sha256(data_bytes).hexdigest()
    plan, dataset = json.loads(plan_bytes), json.loads(data_bytes)
    checked_plan(plan, dataset_path, dataset_hash)
    names, rows, holdout, quality = checked_dataset(dataset, plan)
    folds = checked_folds(rows, plan)  # All coverage/purging checks precede every fit.
    row_indices = {row['matchId']: index for index, row in enumerate(dataset['rows'])}
    recipe_reference = json.loads((ROOT / shared.INCUMBENT).read_bytes())
    output.mkdir(parents=False, exist_ok=False)
    summaries = []
    for year, groups, memberships, purged in folds:
        fold_dir = output / f'fold-{year}'
        fold_dir.mkdir()
        with tempfile.TemporaryDirectory(prefix=f'annual-count-projection-{year}-') as temporary:
            temporary = Path(temporary)
            original_native, original_models = fit_original_pair(groups['train'], names, temporary)
            for side in ('home', 'away'):
                l2.effective_parameter_guard(recipe_reference['models'][side], original_models[side], 3.)
                require(original_native[side].feature_names_ == names, 'native_feature_schema_mismatch')
            projected_models, support_audit = project_pair(original_models, original_native, names, groups['train'])
            projected_native = {side: shared.load_native(projected_models[side], temporary, f'projected-{side}') for side in ('home', 'away')}
            predictions, parity_rows, errors = [], [], {arm: {} for arm in ('original', 'projected')}
            for part in ('train', 'calibration', 'test'):
                x = l2.features(groups[part])
                raw = {arm: {} for arm in ('original', 'projected')}
                for arm, native, models in [('original', original_native, original_models), ('projected', projected_native, projected_models)]:
                    for side in ('home', 'away'):
                        values = np.asarray(native[side].predict(x, prediction_type='RawFormulaVal', thread_count=2)).reshape(-1)
                        error = float(np.max(np.abs(values - shared.raw_predict(models[side], x))))
                        require(error <= 1e-12, f'native_independent_parity_failure:{year}:{part}:{arm}:{side}')
                        errors[arm][side] = max(errors[arm].get(side, 0.), error)
                        raw[arm][side] = values
                for index, row in enumerate(groups[part]):
                    rates = {arm: {side: [float(raw[arm][side][index])] for side in ('home', 'away')} for arm in ('original', 'projected')}
                    parity_rows.append({'matchId': row['matchId'], 'partition': part, 'raw': rates})
                    if part != 'train':
                        predictions.append({key: row[key] for key in ('matchId', 'competition', 'season', 'forecastAt', 'kickoffAt', 'availableAt', 'homeGoals', 'awayGoals')}
                                           | {'partition': part, 'datasetRowIndex': row_indices[row['matchId']],
                                              'baselineMatrix': row['baselineMatrix'], 'probabilitiesA': row['baselineProbabilities'], 'raw': rates})
        created = now()
        original_artifact = artifact(original_models, 'original', year, plan, plan_hash, dataset_hash, memberships, dataset['baselineManifest'], created, quality)
        projected_artifact = artifact(projected_models, 'projected', year, plan, plan_hash, dataset_hash, memberships, dataset['baselineManifest'], created, quality, original_artifact['version'])
        write_json(fold_dir / 'original.json', original_artifact)
        write_json(fold_dir / 'projected.json', projected_artifact)
        write_json(fold_dir / 'membership.json', {'year': year, 'boundaries': boundaries(year), 'memberships': memberships, 'purgedMatchIds': purged})
        write_json(fold_dir / 'predictions.json', {'year': year, 'featureNames': names, 'rows': predictions})
        write_json(fold_dir / 'parity.json', {'featureNames': names, 'rows': parity_rows})
        audit = {'year': year, 'planHash': plan_hash, 'datasetHash': dataset_hash, 'scriptHash': digest(__file__),
                 'supportProjection': support_audit, 'nativeIndependentMaximumErrors': errors,
                 'trainingRows': len(groups['train']), 'calibrationRows': len(groups['calibration']), 'testRows': len(groups['test']),
                 'newRegressorFits': 2, 'projectedRegressorFits': 0, 'holdoutProtection': holdout, 'dataQualityPolicyHash': quality['policyHash'],
                 'fileHashes': {name: digest(fold_dir / name) for name in ('original.json', 'projected.json', 'membership.json', 'predictions.json', 'parity.json')},
                 'productionAdoptionEligible': False, 'independentEvidence': False}
        write_json(fold_dir / 'audit.json', audit)
        summaries.append({'year': year, 'testSeason': f'{year}/{year + 1}', 'directory': fold_dir.name,
                          'memberships': memberships, 'auditHash': digest(fold_dir / 'audit.json')})
        require(plan_path.read_bytes() == plan_bytes and digest(dataset_path) == dataset_hash, 'frozen_execution_inputs_changed')
        checked_plan(plan, dataset_path, dataset_hash)
    report = {'protocol': PROTOCOL, 'planHash': plan_hash, 'datasetHash': dataset_hash, 'scriptHash': digest(__file__),
              'folds': summaries, 'createdAt': now(), 'newRegressorFits': 10, 'projectedRegressorFits': 0,
              'sourceHashes': plan['sourceHashes'], 'allFiveDeclaredSeasonsCompleted': True,
              'diagnosticOnly': True, 'productionAdoptionEligible': False, 'independentEvidence': False}
    write_json(output / 'training.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    result = run(args.plan, args.dataset, args.out)
    print(json.dumps({'folds': len(result['folds']), 'output': str(args.out), 'planHash': result['planHash']}))


if __name__ == '__main__':
    main()
