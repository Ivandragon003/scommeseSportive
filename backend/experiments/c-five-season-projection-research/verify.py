"""Independent native, temporal and probability audit of five fixed annual folds."""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
import math
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
from catboost import CatBoostRegressor, __version__ as catboost_version

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
YEARS = tuple(range(2021, 2026))
ARMS = ('original', 'projected')


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


MATH = load('five_season_probability_math', HERE.parent / 'c-tree-weight-research/verify.py')
NEWTON = load('five_season_serialization_guard', HERE.parent / 'c-tree-newton-one-research/verify.py')
SOURCE = load('five_season_independent_routes', HERE.parent / 'c-tree-ignored-samples-research/verify_selection.py')
read, digest, timestamp = MATH.read, MATH.digest, MATH.timestamp
ML = load('five_season_controlled_dataset_contract', ROOT / 'backend/ml/train.py')


def project_inputs(rows, source_names, model_names):
    assert len(source_names) == len(set(source_names)) == 56
    assert model_names == ML.LEGACY_FEATURES and len(model_names) == 40
    indices = [source_names.index(name) for name in model_names]
    assert all(len(row['features']) == 56 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in row['features']) for row in rows)
    return np.asarray([[row['features'][index] for index in indices] for row in rows], dtype=float)


def partition(row, limits):
    forecast, available = timestamp(row['forecastAt']), timestamp(row['availableAt'])
    start, calibration, test, end = (timestamp(limits[key]) for key in ['trainBefore', 'calibrationFrom', 'testFrom', 'testTo'])
    if forecast < start: return 'train' if available < start else None
    if forecast < calibration: return 'reserved'
    if forecast < test: return 'calibration' if available < test else None
    return 'test' if forecast < end else None


def projection_check(original, projected, names):
    assert {key: value for key, value in original.items() if key != 'oblivious_trees'} == {
        key: value for key, value in projected.items() if key != 'oblivious_trees'}
    assert len(original['oblivious_trees']) == len(projected['oblivious_trees']) == 120
    mapping = {feature['feature_index']: feature['flat_feature_index'] for feature in original['features_info']['float_features']}
    maximum, mean_error, edited = 0., 0., 0
    for before, after in zip(original['oblivious_trees'], projected['oblivious_trees']):
        assert {key: value for key, value in before.items() if key != 'leaf_values'} == {key: value for key, value in after.items() if key != 'leaf_values'}
        values, changed, support = map(np.asarray, [before['leaf_values'], after['leaf_values'], before['leaf_weights']])
        assert values.shape == changed.shape == support.shape and np.isfinite(changed).all()
        bits = [bit for bit, split in enumerate(before.get('splits', [])) if names[mapping[split['float_feature_index']]] in ['home_sample', 'away_sample']]
        if not bits:
            assert before == after
            continue
        mask = sum(1 << bit for bit in bits)
        groups = np.asarray([leaf & ~mask for leaf in range(len(values))])
        # A conditional-expectation matrix independently encodes the projection.
        operator = np.zeros((len(values), len(values)))
        for group in np.unique(groups):
            members = np.flatnonzero(groups == group)
            total = support[members].sum()
            if total:
                operator[np.ix_(members, members)] = np.broadcast_to(support[members] / total, (len(members), len(members)))
            else:
                assert np.all(values[members] == 0)
            assert np.all(changed[members] == changed[members][0])
        maximum = max(maximum, float(np.max(np.abs(operator @ values - changed))))
        mean_error = max(mean_error, abs(float(np.average(values, weights=support)) - float(np.average(changed, weights=support))))
        edited += int(np.sum(values != changed))
    assert maximum <= 1e-12 and mean_error <= 1e-12
    return {'maximumProjectionError': maximum, 'maximumWeightedTreeMeanError': mean_error, 'changedLeaves': edited,
            'onlyLeafValuesChanged': True, 'noLaterLabelsInProjection': True}


def intervals(rows, stage, replications=2000, seed=20261108):
    blocks = {}
    old, new = MATH.loss_rows(rows, 'original', stage), MATH.loss_rows(rows, 'projected', stage)
    for row, baseline, candidate in zip(rows, old, new):
        key = (row['testSeason'], math.floor(timestamp(row['kickoffAt']) / (7 * 86400)))
        block = blocks.setdefault(key, {'n': 0, 'logLoss': 0., 'brier': 0.})
        block['n'] += 1
        for metric in ['logLoss', 'brier']: block[metric] += candidate[metric] - baseline[metric]
    values = list(blocks.values())
    if len(values) < 2: return {'blocks': len(values), 'intervals': None}
    state, draws = seed & 0xffffffff, {'logLoss': [], 'brier': []}
    for _ in range(replications):
        n, ll, brier = 0, 0., 0.
        for _ in values:
            state ^= (state << 13) & 0xffffffff; state ^= state >> 17; state ^= (state << 5) & 0xffffffff; state &= 0xffffffff
            block = values[math.floor(state / 4294967296 * len(values))]
            n += block['n']; ll += block['logLoss']; brier += block['brier']
        draws['logLoss'].append(ll / n); draws['brier'].append(brier / n)
    return {'blocks': len(values), 'replications': replications, 'seed': seed, 'independentEvidence': False,
            'grouping': 'test-season-and-UTC-epoch-week', 'intervals': {metric: {'lower': float(np.quantile(sample, .025)),
            'upper': float(np.quantile(sample, .975))} for metric, sample in draws.items()}}


def compare_metrics(rows, summary, replications=2000):
    error = 0.
    for stage in ['raw', 'calibrated', 'decision']:
        cohort = [row for row in rows if row['closingQuoteAvailable']] if stage == 'decision' else rows
        if not cohort:
            assert summary[stage]['n'] == 0 and summary[stage]['unavailable'] is True
            continue
        assert summary[stage]['n'] == len(cohort) and summary[stage]['allTestRows'] == len(rows)
        assert summary[stage]['quotedRows'] == sum(row['closingQuoteAvailable'] for row in rows)
        metrics = {arm: MATH.metrics(cohort, arm, stage) for arm in ARMS}
        for arm in ARMS: error = max(error, MATH.numeric_error(metrics[arm], summary[stage][arm]))
        delta = {key: metrics['projected'][key] - metrics['original'][key] for key in metrics['original'] if key != 'n'}
        error = max(error, MATH.numeric_error(delta, summary[stage]['deltaProjectedMinusOriginal']))
        error = max(error, MATH.numeric_error(intervals(cohort, stage, replications), summary[stage]['pairedWeekly95PercentInterval']))
    assert error <= 1e-12
    return error


def effective_profile(profile):
    if 'goal_1x2' in profile['byFamily']: return profile
    return profile | {'byFamily': {'goal_1x2': {'points': profile['calibrationPoints'], 'nObservations': profile['nObservations']}}}


REPLAY = r"""
const fs=require('node:fs'),path=require('node:path'),p=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const adapter=require(path.join(process.argv[1],'backend/experiments/current-c-real-odds-backtest/selector-math.cjs'));
const {applyCoherentProbabilityPipeline}=require(path.join(process.argv[1],'backend/dist/research/CoherentProbabilityPipeline'));
const keys=['homeWin','draw','awayWin','over25','under25','btts','bttsNo'];
const rows=p.rows.map(row=>({matchId:row.matchId,forecasts:Object.fromEntries(['original','projected'].map(arm=>{
const input={matrix:row.matrices[arm],profile:p.profiles[row.year][arm],mode:'isotonic_1x2',forecastAt:row.forecastAt,quotes:row.quotes};
const result=row.quotes.length?adapter.calibrateAndBlend(input):applyCoherentProbabilityPipeline(input);
if(row.quotes.length&&!result.marketBlendingApplied)throw Error('Closing quote blend absent');
return [arm,{calibrated:Object.fromEntries(keys.map(key=>[key,result.calibrated[key]])),decision:row.quotes.length?Object.fromEntries(keys.map(key=>[key,result.decision[key]])):null}];}))}));
process.stdout.write(JSON.stringify({rows,adapterIdentity:adapter.identities()}));
"""


def verify(plan_file, dataset_file, trained, quotes_file, run):
    plan_file, dataset_file, trained, quotes_file, run = (Path(file).resolve() for file in [plan_file, dataset_file, trained, quotes_file, run])
    plan, dataset, report = read(plan_file), read(dataset_file), read(run / 'comparison.json')
    plan_hash = digest(plan_file)
    assert plan['protocol'] == report['protocol'] == 'c-five-season-projection-research-v1' and plan['phase'] == 'execution'
    assert report['planHash'] == plan_hash and digest(dataset_file) == plan['datasetHash']
    assert dataset['reproduction']['planHash'] == plan['inputsPlanHash'] == report['inputsPlanHash']
    assert catboost_version == '1.2.8'
    hashes = {plan_file: plan_hash, dataset_file: digest(dataset_file), quotes_file: digest(quotes_file),
              run / 'comparison.json': digest(run / 'comparison.json'), trained / 'training.json': digest(trained / 'training.json')}
    for file, expected in plan['sourceHashes'].items(): hashes[ROOT / file] = expected
    for file, expected in report['trainedFileHashes'].items(): hashes[Path(file)] = expected
    for file, expected in report['quoteSourceHashes'].items(): hashes[Path(file)] = expected
    for file, expected in report['sourceHashes'].items(): hashes[HERE / file] = expected
    for file, expected in hashes.items(): assert digest(file) == expected, file
    assert report['inputHashes'] == {'dataset': digest(dataset_file), 'quotes': digest(quotes_file), 'training': digest(trained / 'training.json')}
    assert dataset['baselineManifest'] == plan['baselineManifest']
    dependencies = [HERE.parent / 'c-tree-weight-research/verify.py', HERE.parent / 'c-tree-newton-one-research/verify.py',
                    HERE.parent / 'c-tree-ignored-samples-research/verify_selection.py', HERE.parent / 'c-tree-hierarchical-research/verify_selection.py',
                    HERE.parent / 'c-tree-l2-research/verify_selection.py', HERE.parent / 'c-tree-weight-research/verify_selection.py',
                    HERE.parent / 'c-tree-sample-projection/verify.py', ROOT / 'backend/ml/train.py']
    for file in dependencies:
        hashes[file] = digest(file)
    training = read(trained / 'training.json'); assert training['planHash'] == plan_hash
    assert training['allFiveDeclaredSeasonsCompleted'] is True and training['newRegressorFits'] == 10 and training['projectedRegressorFits'] == 0
    assert [fold['year'] for fold in training['folds']] == list(YEARS)
    source_names, checked_rows, _ = ML.checked_dataset(dataset, controlled=True)
    assert len(source_names) == 56 and len(checked_rows) == len(dataset['rows'])
    model_names = ML.LEGACY_FEATURES
    feature_projection = {'sourceFeatures': 56, 'modelFeatures': 40, 'modelFeatureNames': model_names, 'unusedSourceFeatures': [name for name in source_names if name not in model_names], 'baselineUsesCanonicalPerMatchFit': True}
    assert report['featureProjection'] == feature_projection
    project_inputs(dataset['rows'], source_names, model_names)
    data_by_id = {row['matchId']: row for row in dataset['rows']}; assert len(data_by_id) == len(dataset['rows'])
    protected = set(read(ROOT / 'backend/src/research/original-holdout-policy.json')['protectedOriginalFinalMatchIds'])
    quarantined = {row['matchId'] for row in read(ROOT / 'backend/src/research/challenger-data-quarantine.json')['entries']}
    study_excluded = set(plan.get('studyExcludedMatchIds', []))
    assert not (set(data_by_id) & (protected | quarantined | study_excluded))
    for row in dataset['rows']:
        assert timestamp(row['maxTrainingAvailableAt']) <= timestamp(row['forecastAt']) < timestamp(row['kickoffAt'])
        assert timestamp(row['modelFitAt']) <= timestamp(row['forecastAt'])
    quotes = read(quotes_file)['rows']; quote_by_id = {row['matchId']: row for row in quotes}; assert len(quote_by_id) == len(quotes)
    for quote in quotes:
        assert quote['bookmaker'] == 'Bet365' and quote['source'] == 'football_data_csv' and quote['priceType'] == 'closing'
        assert len(quote['prices']) == 3 and all(math.isfinite(price) and price > 1 for price in quote['prices'])
        file = Path(quote['sourceFile']); file = file if file.is_absolute() else ROOT / file
        if file in hashes: assert hashes[file] == quote['sourceSha256']
        else: assert digest(file) == quote['sourceSha256']; hashes[file] = quote['sourceSha256']
    frozen = read(run / 'frozen-models.json'); assert frozen['planHash'] == plan_hash and frozen['frozenAt'] == report['frozenAt']
    hashes[run / 'frozen-models.json'] = digest(run / 'frozen-models.json')
    assert len(frozen['models']) == len(report['models']) == 10 and frozen['models'] == report['models']
    assert timestamp(report['frozenAt']) <= timestamp(report['diagnosticStartedAt']) <= timestamp(report['completedAt'])
    assert report['diagnosticOnly'] is True and report['independentEvidence'] is False and report['productionAdoptionEligible'] is False
    reference = read(ROOT / 'backend/current-models/challenger.json')
    errors = {'nativeRaw': 0., 'projection': 0., 'calibrationCurve': 0., 'rawForecast': 0., 'calibratedForecast': 0., 'decisionReplay': 0., 'metricsAndIntervals': 0.}
    audit_checks, expected_tests, replay_rows, profiles = {}, [], [], {}
    report_by_id = {row['matchId']: row for row in report['rows']}; assert len(report_by_id) == len(report['rows'])
    expected_native_rows = 0
    with tempfile.TemporaryDirectory(prefix='five-season-independent-native-') as temporary:
        for year in YEARS:
            directory = trained / f'fold-{year}'
            membership, predictions, parity, audit = (read(directory / file) for file in ['membership.json', 'predictions.json', 'parity.json', 'audit.json'])
            declared = next(fold for fold in plan['folds'] if fold['year'] == year)
            assert membership['boundaries'] == declared['boundaries']
            limits = declared['boundaries']
            assert limits['trainBefore'] == limits['reservedFrom'] and limits['reservedTo'] == limits['calibrationFrom'] and limits['calibrationTo'] == limits['testFrom']
            assert timestamp(limits['trainBefore']) < timestamp(limits['calibrationFrom']) < timestamp(limits['testFrom']) < timestamp(limits['testTo'])
            ordered = sorted(dataset['rows'], key=lambda row: (timestamp(row['forecastAt']), row['matchId']))
            groups = {part: [row for row in ordered if partition(row, limits) == part] for part in ['train', 'reserved', 'calibration', 'test']}
            seen = set()
            for part, rows in groups.items():
                record = membership['memberships'][part]; ids = [row['matchId'] for row in rows]
                assert not (seen & set(ids)); seen.update(ids)
                assert record['n'] == len(ids) == declared['memberships'][part]['n']
                assert record['matchIds'] == ids and record['matchIdsHash'] == MATH.ids_hash(rows) == declared['memberships'][part]['matchIdsHash']
                assert record['orderedMatchIdsHash'] == hashlib.sha256('\n'.join(ids).encode()).hexdigest() == declared['memberships'][part]['orderedMatchIdsHash']
                if part in ['train', 'calibration', 'test']: assert len({row['competition'] for row in rows}) == 5
                if rows: assert record['availableThrough'] == max(row['availableAt'] for row in rows)
            assert len(groups['train']) and len(groups['calibration']) and len(groups['test'])
            expected_purged = {'train': [row['matchId'] for row in ordered if timestamp(row['forecastAt']) < timestamp(limits['trainBefore']) and timestamp(row['availableAt']) >= timestamp(limits['trainBefore'])],
                'calibration': [row['matchId'] for row in ordered if timestamp(limits['calibrationFrom']) <= timestamp(row['forecastAt']) < timestamp(limits['testFrom']) and timestamp(row['availableAt']) >= timestamp(limits['testFrom'])]}
            assert membership['purgedMatchIds'] == expected_purged
            for part in ['train', 'calibration']:
                cutoff = limits['trainBefore'] if part == 'train' else limits['testFrom']
                assert all(timestamp(row['availableAt']) < timestamp(cutoff) for row in groups[part])
            artifacts = {arm: read(directory / f'{arm}.json') for arm in ARMS}
            calibrated_artifacts = {arm: read(run / f'fold-{year}/{arm}.json') for arm in ARMS}
            for arm in ARMS:
                output = next(row for row in frozen['models'] if row['year'] == year and row['arm'] == arm)
                assert digest(run / output['file']) == output['sha256']; hashes[run / output['file']] = output['sha256']
                NEWTON.verify_staged_models(artifacts[arm]['models'], calibrated_artifacts[arm]['models'])
                for key, value in artifacts[arm].items():
                    if key != 'models': assert calibrated_artifacts[arm][key] == value
                assert artifacts[arm]['weight'] == .75 and artifacts[arm]['temperature'] == .8
                assert artifacts[arm]['trainerHash'] == digest(HERE / 'train.py') and artifacts[arm]['datasetHash'] == digest(dataset_file)
                assert artifacts[arm]['featureNames'] == model_names
                assert artifacts[arm]['baselineVersion'] == dataset['baselineManifest']['version']
                assert timestamp(artifacts[arm]['trainedThrough']) < timestamp(limits['trainBefore'])
                assert timestamp(artifacts[arm]['validationThrough']) < timestamp(limits['testFrom'])
                assert calibrated_artifacts[arm]['diagnosticOnly'] is True and calibrated_artifacts[arm]['productionAdoptionEligible'] is False
            assert calibrated_artifacts['original']['calibrationProfilesV2']['A'] == calibrated_artifacts['projected']['calibrationProfilesV2']['A']
            audit_checks[year] = {}
            for side in ['home', 'away']:
                SOURCE.L2.parameters(reference['models'][side], artifacts['original']['models'][side], 3.)
                checked = projection_check(artifacts['original']['models'][side], artifacts['projected']['models'][side], model_names)
                audit_checks[year][side] = checked; errors['projection'] = max(errors['projection'], checked['maximumProjectionError'])
            check_rows = groups['train'] + groups['calibration'] + groups['test']
            x = project_inputs(check_rows, source_names, model_names); lookup = {row['matchId']: index for index, row in enumerate(check_rows)}
            expected_native_rows += len(check_rows)
            evidence = {row['matchId']: row for row in parity['rows']}; assert len(evidence) == len(parity['rows']) == len(check_rows)
            assert set(evidence) == set(lookup)
            native = {}
            for arm in ARMS:
                native[arm] = {}
                for side in ['home', 'away']:
                    model = artifacts[arm]['models'][side]; file = Path(temporary) / f'{year}-{arm}-{side}.json'; file.write_text(json.dumps(model), encoding='utf-8')
                    predictor = CatBoostRegressor().load_model(str(file), format='json'); assert predictor.feature_names_ == model_names
                    raw = np.asarray(predictor.predict(x, prediction_type='RawFormulaVal', thread_count=2)); native[arm][side] = raw
                    expected = np.asarray([evidence[row['matchId']]['raw'][arm][side][0] for row in check_rows])
                    errors['nativeRaw'] = max(errors['nativeRaw'], float(np.max(np.abs(raw - expected))), float(np.max(np.abs(raw - SOURCE.traverse_raw(model, x)))))
                    routes = predictor.calc_leaf_indexes(x[:len(groups['train'])], thread_count=2)
                    for index, tree in enumerate(model['oblivious_trees']): assert np.array_equal(np.bincount(routes[:, index], minlength=len(tree['leaf_values'])), tree['leaf_weights'])
            prediction_by_id = {row['matchId']: row for row in predictions['rows']}; assert set(prediction_by_id) == {row['matchId'] for row in groups['calibration'] + groups['test']}
            for row in predictions['rows']:
                source = data_by_id[row['matchId']]
                assert dataset['rows'][row['datasetRowIndex']]['matchId'] == row['matchId']
                for key in ['homeGoals', 'awayGoals', 'competition', 'season', 'forecastAt', 'kickoffAt', 'availableAt']: assert row[key] == source[key]
                assert row['baselineMatrix'] == source['baselineMatrix'] and row['raw'] == evidence[row['matchId']]['raw']
                assert row['partition'] == partition(source, limits)
            profiles[year] = {arm: calibrated_artifacts[arm]['calibrationProfilesV2']['C'] for arm in ARMS}
            for arm in ARMS:
                calibration = []
                for source in groups['calibration']:
                    index = lookup[source['matchId']]
                    matrix, _ = MATH.SHARED.joint_probabilities(source, np.exp(native[arm]['home'][index]), np.exp(native[arm]['away'][index]), .75, .8)
                    calibration.append(source | {'matrixA': source['baselineMatrix'], 'matrixC': matrix.tolist()})
                for label, matrix_key in [('A', 'matrixA'), ('C', 'matrixC')]:
                    profile = calibrated_artifacts[arm]['calibrationProfilesV2'][label]
                    curve = MATH.original_binned_curve(calibration, matrix_key)
                    errors['calibrationCurve'] = max(errors['calibrationCurve'], MATH.numeric_error(curve, profile['calibrationPoints']))
                    if 'goal_1x2' in profile['byFamily']: errors['calibrationCurve'] = max(errors['calibrationCurve'], MATH.numeric_error(curve, profile['byFamily']['goal_1x2']['points']))
                    assert profile['matches'] == len(calibration) and profile['nObservations'] == 3 * len(calibration)
                    assert profile['fittedThrough'] == max(row['availableAt'] for row in calibration)
                    assert profile['protocol'] == 'existing-isotonic-v1' and profile['targetProtocol'] == 'joint_1x2_normalized-v2'
                    assert profile['learnedBlendWeights'] == {}
            for source in groups['test']:
                match_id, index = source['matchId'], lookup[source['matchId']]; expected_tests.append(match_id)
                record = report_by_id[match_id]
                assert record['year'] == year and record['testSeason'] == f'{year}/{year + 1}'
                for key in ['homeGoals', 'awayGoals', 'competition', 'season', 'forecastAt', 'kickoffAt', 'availableAt']: assert record[key] == source[key]
                quote = quote_by_id.get(match_id); assert record['closingQuoteAvailable'] is bool(quote)
                if quote:
                    for key in ['competition', 'season', 'kickoffAt']: assert quote[key] == source[key]
                    assert record['quoteSource'] == quote and len(record['quoteEvidence']) == 3
                    for i, item in enumerate(record['quoteEvidence']): assert item == {'selection': MATH.KEYS[i], 'market': '1x2', 'side': ['home', 'draw', 'away'][i], 'bookmaker': 'Bet365', 'source': 'football_data_csv', 'priceType': 'closing', 'capturedAt': quote['archiveAcquiredAt'], 'timestampEvidence': 'observed_snapshot', 'odds': quote['prices'][i]}
                else:
                    assert record['quoteEvidence'] == [] and record['quoteSource'] is None
                    assert all(record['forecasts'][arm]['decision'] is None for arm in ARMS)
                replay = {'matchId': match_id, 'year': year, 'forecastAt': source['forecastAt'], 'quotes': record['quoteEvidence'], 'matrices': {}}
                for arm in ARMS:
                    matrix, _ = MATH.SHARED.joint_probabilities(source, np.exp(native[arm]['home'][index]), np.exp(native[arm]['away'][index]), .75, .8)
                    replay['matrices'][arm] = matrix.tolist()
                    errors['rawForecast'] = max(errors['rawForecast'], MATH.numeric_error(MATH.markets(matrix), record['forecasts'][arm]['raw']))
                    calibrated = MATH.project_partition(matrix, MATH.calibrated_partition(matrix, effective_profile(profiles[year][arm])))
                    errors['calibratedForecast'] = max(errors['calibratedForecast'], MATH.numeric_error(MATH.markets(calibrated), record['forecasts'][arm]['calibrated']))
                replay_rows.append(replay)
        assert expected_tests == [row['matchId'] for row in report['rows']] and len(set(expected_tests)) == len(expected_tests)
        replay_file = Path(temporary) / 'native-replay.json'; replay_file.write_text(json.dumps({'profiles': profiles, 'rows': replay_rows}, allow_nan=False), encoding='utf-8')
        replay = json.loads(subprocess.run(['node', '-e', REPLAY, str(ROOT), str(replay_file)], cwd=ROOT, capture_output=True, text=True, check=True).stdout)
        assert replay['adapterIdentity'] == report['adapterIdentity']
        for actual, expected in zip(replay['rows'], report['rows']):
            assert actual['matchId'] == expected['matchId']
            for arm in ARMS:
                for stage in ['calibrated', 'decision']:
                    errors['decisionReplay'] = max(errors['decisionReplay'], MATH.numeric_error(actual['forecasts'][arm][stage], expected['forecasts'][arm][stage]))
    cohorts = [(report['rows'], report['summary']['all'])]
    assert len(report['summary']['bySeason']) == len(report['summary']['bySeasonAndLeague']) == 5 and len(report['summary']['byLeague']) == 5
    for year in YEARS:
        season = f'{year}/{year + 1}'; group = [row for row in report['rows'] if row['year'] == year]
        cohorts.append((group, report['summary']['bySeason'][season]))
        assert len(report['summary']['bySeasonAndLeague'][season]) == 5
        for league, summary in report['summary']['bySeasonAndLeague'][season].items(): cohorts.append(([row for row in group if row['competition'] == league], summary))
    for league, summary in report['summary']['byLeague'].items(): cohorts.append(([row for row in report['rows'] if row['competition'] == league], summary))
    for cohort, summary in cohorts: errors['metricsAndIntervals'] = max(errors['metricsAndIntervals'], compare_metrics(cohort, summary))
    assert report['coverage']['allTestRows'] == len(report['rows']) and report['coverage']['realClosingQuotedRows'] == sum(row['closingQuoteAvailable'] for row in report['rows'])
    assert max(errors.values()) <= 1e-12
    for file, expected in hashes.items(): assert digest(file) == expected, file
    return {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'scriptHash': digest(__file__), 'planHash': plan_hash,
        'comparisonHash': hashes[run / 'comparison.json'], 'datasetHash': digest(dataset_file), 'quotesHash': digest(quotes_file),
        'catboostVersion': catboost_version, 'featureProjection': feature_projection, 'nativeRowsAcrossFoldsPerArmRegressor': expected_native_rows, 'projectionChecks': audit_checks,
        'errors': errors, 'fiveCompleteSeasonsAndLeaguesVerified': True, 'chronologicalMembershipsAndUnusedReservedRowsVerified': True,
        'allModelsFrozenBeforeTestScoring': True, 'noSyntheticQuotesOrDecisionFallbacks': True, 'noFitsOrOptimizerCalls': True,
        'incumbentAndPinnedSourcesUnchanged': True, 'independentPredictiveEvidence': False, 'productionAdoptionEligible': False,
        'dependencyHashes': {str(file.relative_to(ROOT)): digest(file) for file in dependencies}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ['plan', 'dataset', 'trained', 'quotes', 'run', 'out']: parser.add_argument('--' + key, required=True, type=Path)
    args = parser.parse_args(); assert not args.out.exists()
    result = verify(args.plan, args.dataset, args.trained, args.quotes, args.run)
    with args.out.open('x', encoding='utf-8', newline='\n') as handle: json.dump(result, handle, indent=2, allow_nan=False); handle.write('\n')
    print(json.dumps(result))
