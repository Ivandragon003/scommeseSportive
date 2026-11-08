"""Independent checks of one selected tree-block model; no optimization or adoption."""
from __future__ import annotations

import argparse
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
PLAN_HASH = 'acd4e01698d5a61a70843192cdb6e156997c0d7da81c865e2aac8380c910c483'
METHOD = 'six-nonnegative-original-tree-block-weights-with-chronological-ridge-selection-v1'
KEYS = ['homeWin', 'draw', 'awayWin']
STAGES = ['raw', 'calibrated', 'decision']


def load_module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


SHARED = load_module('tree_weight_independent_probability_math', HERE.parent / 'c-tree-sample-projection/verify.py')
SELECTION = load_module('tree_weight_independent_selection', HERE / 'verify_selection.py')


def read(file):
    return json.loads(Path(file).read_text(encoding='utf-8'))


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def ids_hash(rows):
    return hashlib.sha256('\n'.join(sorted(row['matchId'] for row in rows)).encode()).hexdigest()


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def numeric_error(actual, expected):
    """Compare numerical records while rejecting missing or extra fields."""
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys()
        return max((numeric_error(actual[key], expected[key]) for key in expected), default=0.)
    if isinstance(expected, list):
        assert len(actual) == len(expected)
        return max((numeric_error(a, b) for a, b in zip(actual, expected)), default=0.)
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert math.isfinite(actual) and math.isfinite(expected)
        return abs(actual - expected)
    assert actual == expected
    return 0.


def verify_scaling(original, candidate, weights):
    assert len(weights) == 3 and all(math.isfinite(w) and 0 <= w <= 2 for w in weights)
    assert {k: v for k, v in original.items() if k != 'oblivious_trees'} == {
        k: v for k, v in candidate.items() if k != 'oblivious_trees'}
    assert len(original['oblivious_trees']) == len(candidate['oblivious_trees']) == 120
    changed, empty = 0, 0
    for index, (old, new) in enumerate(zip(original['oblivious_trees'], candidate['oblivious_trees'])):
        assert {k: v for k, v in old.items() if k != 'leaf_values'} == {
            k: v for k, v in new.items() if k != 'leaf_values'}
        before, after = np.asarray(old['leaf_values']), np.asarray(new['leaf_values'])
        support = np.asarray(old['leaf_weights'])
        assert before.shape == after.shape == support.shape
        assert np.isfinite(before).all() and np.isfinite(after).all()
        assert np.isfinite(support).all() and (support >= 0).all()
        assert len(before) == 2 ** len(old.get('splits', [])) and support.sum() == 5293
        assert np.array_equal(after, before * weights[index // 40]), 'Wrong tree-block scale'
        assert np.all(before[support == 0] == 0) and np.all(after[support == 0] == 0)
        empty += int(np.sum(support == 0))
        changed += int(np.sum(before != after))
    return {'changedLeaves': changed, 'emptyLeavesStillZero': empty, 'entireTreeScalingExact': True}


def markets(matrix):
    matrix = np.asarray(matrix, dtype=float)
    assert matrix.ndim == 2 and matrix.shape[0] == matrix.shape[1]
    assert np.isfinite(matrix).all() and (matrix >= 0).all() and abs(matrix.sum() - 1) < 1e-12
    goals = np.indices(matrix.shape).sum(axis=0)
    over = float(matrix[goals > 2.5].sum())
    btts = float(matrix[1:, 1:].sum())
    return {'homeWin': float(np.tril(matrix, -1).sum()), 'draw': float(matrix.trace()),
            'awayWin': float(np.triu(matrix, 1).sum()), 'over25': over, 'under25': 1 - over,
            'btts': btts, 'bttsNo': 1 - btts}


def project_partition(matrix, probabilities):
    matrix = np.asarray(matrix, dtype=float)
    current = markets(matrix)
    target = np.asarray(probabilities, dtype=float)
    assert np.isfinite(target).all() and (target > 0).all()
    target /= target.sum()
    home, away = np.indices(matrix.shape)
    partition = np.where(home > away, 0, np.where(home == away, 1, 2))
    result = matrix * (target / np.array([current[key] for key in KEYS]))[partition]
    return result / result.sum()


def original_binned_curve(rows, matrix_key):
    """Reconstruct the existing ten-bucket PAVA representation, including its endpoints."""
    observations = []
    for row in sorted(rows, key=lambda r: (timestamp(r['availableAt']), r['matchId'])):
        values = markets(np.asarray(row[matrix_key]) / np.asarray(row[matrix_key]).sum())
        probabilities = [values[key] for key in KEYS]
        total = sum(probabilities)
        outcome = 0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1
        observations.extend((probability / total, int(index == outcome)) for index, probability in enumerate(probabilities))
    observations.sort(key=lambda pair: pair[0])
    buckets = min(10, len(observations) // 5)
    size = math.ceil(len(observations) / buckets)
    pools = []
    for start in range(0, len(observations), size):
        group = observations[start:start + size]
        pools.append([sum(p for p, _ in group) / len(group), sum(y for _, y in group) / len(group), 1])
    while True:
        violation = next((i for i in range(len(pools) - 1) if pools[i][1] > pools[i + 1][1]), None)
        if violation is None:
            break
        left, right = pools[violation:violation + 2]
        weight = left[2] + right[2]
        pools[violation:violation + 2] = [[(left[0] * left[2] + right[0] * right[2]) / weight,
                                         (left[1] * left[2] + right[1] * right[2]) / weight, weight]]
    return [{'x': 0, 'y': 0}] + [{'x': x, 'y': y} for x, y, _ in pools] + [{'x': 1, 'y': 1}]


def calibrated_partition(matrix, profile):
    raw = np.array([markets(matrix)[key] for key in KEYS])
    raw /= raw.sum()
    family = profile['byFamily']['goal_1x2']
    points = np.array([[point['x'], point['y']] for point in family['points']])
    count = family['nObservations']
    alpha = .90 if count < 200 else max(.10, 1 / (1 + count / 1000))
    corrected = np.clip(alpha * raw + (1 - alpha) * np.interp(raw, points[:, 0], points[:, 1]), .01, .99)
    return corrected / corrected.sum()


def loss_rows(rows, family, stage):
    result = []
    for row in rows:
        p = row['forecasts'][family][stage]
        values = np.array([p[key] for key in KEYS])
        assert np.isfinite(values).all() and (values > 0).all() and (values < 1).all()
        assert abs(values.sum() - 1) < 1e-10 and abs(p['over25'] + p['under25'] - 1) < 1e-10
        assert abs(p['btts'] + p['bttsNo'] - 1) < 1e-10 and 0 < p['over25'] < 1
        outcome = 0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1
        total = int(row['homeGoals'] + row['awayGoals'] > 2.5)
        result.append({'logLoss': -math.log(values[outcome]), 'brier': sum((values[i] - int(i == outcome)) ** 2 for i in range(3)),
                       'over25LogLoss': -math.log(p['over25'] if total else 1 - p['over25']),
                       'over25Brier': (p['over25'] - total) ** 2,
                       'confidence': float(values.max()), 'correct': int(int(values.argmax()) == outcome)})
    return result


def metrics(rows, family, stage):
    losses = loss_rows(rows, family, stage)
    scores = {key: sum(loss[key] for loss in losses) / len(rows)
              for key in ['logLoss', 'brier', 'over25LogLoss', 'over25Brier']}
    bins = [[0., 0.] for _ in range(10)]
    for loss in losses:
        bin_index = min(9, math.floor(loss['confidence'] * 10))
        bins[bin_index][0] += loss['confidence']
        bins[bin_index][1] += loss['correct']
    return {'n': len(rows), **scores, 'eceTopLabel10Bins': sum(abs(p - y) for p, y in bins) / len(rows)}


def paired_intervals(rows, stage, replications, seed):
    weeks = {}
    current, candidate = loss_rows(rows, 'incumbent', stage), loss_rows(rows, 'candidate', stage)
    for row, old, new in zip(rows, current, candidate):
        key = math.floor(timestamp(row['kickoffAt']) / (7 * 86400))
        block = weeks.setdefault(key, {'n': 0, 'logLoss': 0., 'brier': 0.})
        block['n'] += 1
        for metric in ['logLoss', 'brier']:
            block[metric] += new[metric] - old[metric]
    blocks = list(weeks.values())
    if len(blocks) < 2:
        return {'blocks': len(blocks), 'intervals': None}
    state = seed & 0xffffffff
    draws = {'logLoss': [], 'brier': []}
    for _ in range(replications):
        n, ll, brier = 0, 0., 0.
        for _ in blocks:
            state ^= (state << 13) & 0xffffffff
            state ^= state >> 17
            state ^= (state << 5) & 0xffffffff
            state &= 0xffffffff
            block = blocks[math.floor(state / 4294967296 * len(blocks))]
            n += block['n']; ll += block['logLoss']; brier += block['brier']
        draws['logLoss'].append(ll / n); draws['brier'].append(brier / n)
    intervals = {metric: {'lower': float(np.quantile(values, .025)), 'upper': float(np.quantile(values, .975))}
                 for metric, values in draws.items()}
    return {'blocks': len(blocks), 'replications': replications, 'seed': seed,
            'independentEvidence': False, 'intervals': intervals}


RECONSTRUCT = r"""
const fs=require('node:fs'),path=require('node:path');
const root=process.argv[1],run=process.argv[2],plan=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const backend=path.join(root,'backend');
const {baselineManifest,buildForecastInput}=require(path.join(backend,'dist/research/ForecastCore'));
const {filterChallengerHistory,CHALLENGER_DATA_QUALITY_POLICY_HASH}=require(path.join(backend,'dist/research/ChallengerDataQuality'));
const {resolveNightlyForecastAt}=require(path.join(backend,'dist/research/ForecastDecisionTime'));
const ts=require(path.join(backend,'node_modules/typescript'));
const buildParity=Object.fromEntries(Object.keys(plan.sourceHashes).filter(f=>f.endsWith('.ts')).map(f=>{
const expected=ts.transpileModule(fs.readFileSync(path.join(root,f),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText.replace(/\r\n/g,'\n').trim();
const actual=fs.readFileSync(path.join(root,f.replace('/src/','/dist/').replace(/\.ts$/,'.js')),'utf8').replace(/\r\n/g,'\n').trim();return [f,expected===actual];}));
const original=read('backend/current-models/challenger.json');
const dataset=read('backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json');
const byId=new Map(dataset.rows.map(r=>[r.matchId,r]));
const history=filterChallengerHistory(read('backend/artifacts/research/current-c-real-odds-backtest-20261108/history.json'));
const historyById=new Map(history.map(r=>[r.matchId,r]));
const targets=JSON.parse(fs.readFileSync(path.join(run,'comparison.json'),'utf8')).rows;
const rows=targets.map(target=>{let input=byId.get(target.matchId),source='pinned_dataset';
if(!input){source='pure_forecast_core_rebuild';const m=historyById.get(target.matchId);if(!m)throw Error('Missing target');
input={...buildForecastInput(history,{matchId:m.matchId,homeTeamId:m.homeTeamId,awayTeamId:m.awayTeamId,date:m.date,competition:m.competition,season:m.season},resolveNightlyForecastAt(m.date,{hour:3,minute:7})),dataQualityPolicyHash:CHALLENGER_DATA_QUALITY_POLICY_HASH,dataQualityBaselineClean:true};}
const indices=original.featureNames.map(name=>input.featureNames.indexOf(name));if(indices.some(i=>i<0))throw Error('Missing feature');
return {matchId:target.matchId,source,forecastAt:input.forecastAt,featureNames:original.featureNames,features:indices.map(i=>input.features[i]),baselineMatrix:input.baselineMatrix,lambdaHome:input.lambdaHome,lambdaAway:input.lambdaAway,maxTrainingAvailableAt:input.maxTrainingAvailableAt,baselineVersion:input.baselineVersion,dataQualityPolicyHash:input.dataQualityPolicyHash,dataQualityBaselineClean:input.dataQualityBaselineClean};});
const adapter=require(path.join(backend,'experiments/current-c-real-odds-backtest/selector-math.cjs'));
process.stdout.write(JSON.stringify({rows,buildParity,baselineManifest:baselineManifest(),adapterIdentity:adapter.identities()}));
"""


def check_hashes(plan, report, prepared):
    for file, expected in plan['sourceHashes'].items():
        assert digest(ROOT / file) == expected, file
    for file, expected in report['sourceHashes'].items():
        assert digest(HERE / file) == expected, file
    for file, expected in report['inputHashes'].items():
        directory = HERE if file.endswith('.py') else prepared
        assert digest(directory / file) == expected, file


def verify(plan_file, prepared, run, inputs_file):
    assert digest(plan_file) == PLAN_HASH
    comparison_hash = digest(run / 'comparison.json')
    candidate_hash = digest(run / 'candidate.json')
    plan, report = read(plan_file), read(run / 'comparison.json')
    assert plan['protocol'] == report['protocol'] == 'c-tree-block-weight-research-v1'
    assert plan['intervention']['method'] == METHOD
    assert report['planHash'] == PLAN_HASH
    check_hashes(plan, report, prepared)
    original_file = ROOT / 'backend/current-models/challenger.json'
    original, candidate = read(original_file), read(run / 'candidate.json')
    pre_scoring = read(run / 'pre-scoring-checks.json')
    assert pre_scoring['candidateHash'] == candidate_hash and pre_scoring['planHash'] == PLAN_HASH
    assert pre_scoring['identity'] == candidate['experimentIdentity']
    assert pre_scoring['candidateFrozenAt'] == report['candidateFrozenAt']
    staged, audit, parity = (read(prepared / name) for name in ['artifact.json', 'audit.json', 'parity.json'])
    selection = read(prepared / 'selection.json')
    assert selection['decision']['acceptedNonIdentity'] is True and selection['finalFit']['converged'] is True
    assert digest(original_file) == plan['incumbentArtifactHash']
    assert original['version'] == plan['incumbentVersion'] == candidate['parentVersion']
    assert report['incumbentVersion'] == original['version'] and report['candidateVersion'] == candidate['version']
    assert report['candidateHash'] == digest(run / 'candidate.json')
    assert candidate['experimentPlanHash'] == PLAN_HASH
    assert candidate['experimentIdentity'] == report['identity']
    assert candidate['models'] == staged['models']
    assert report['inputHashes']['artifact.json'] == audit['artifactHash']
    assert report['inputHashes']['parity.json'] == audit['parityHash']
    assert digest(prepared / 'selection.json') == staged['experimentIdentity']['selectionHash'] == audit['selectionHash']
    for key in ['diagnosticOnly', 'productionAdoptionEligible', 'productionValidated', 'independentEvidence']:
        assert candidate[key] is (key == 'diagnosticOnly')
    assert report['productionAdoption'] is False and report['databaseWrites'] == 0
    assert timestamp(plan['createdAt']) < timestamp(candidate['createdAt']) <= timestamp(report['candidateFrozenAt'])
    assert timestamp(report['candidateFrozenAt']) <= timestamp(report['diagnosticStartedAt']) <= timestamp(report['completedAt'])
    assert timestamp(selection['decision']['frozenAt']) <= timestamp(selection['finalFit']['frozenAt']) <= timestamp(staged['createdAt'])
    assert candidate['trainedThrough'] == plan['parameterDevelopment']['originalSelection']['availableThrough']
    assert candidate['parentTrainerHash'] == original['trainerHash']
    assert candidate['trainerHash'] == digest(HERE / 'prepare.py')
    for key in ['featureNames', 'featureSchema', 'weight', 'temperature', 'trainingSplit', 'baselineVersion',
                'validationThrough', 'datasetHash', 'hyperparameters', 'splitPlanHash', 'frozenFold']:
        assert candidate[key] == original[key], key
    assert candidate['weight'] == .75 and candidate['temperature'] == .8
    mutable = {'version', 'createdAt', 'parentVersion', 'status', 'productionValidated', 'availability',
               'independentEvidence', 'selectionProtocol', 'diagnosticOnly', 'productionAdoptionEligible',
               'experimentIdentity', 'experimentPlanHash', 'trainedThrough', 'trainerHash', 'parentTrainerHash',
               'parameterAdaptation', 'models', 'calibrationPredictions', 'calibrationProfilesV2'}
    for key in set(candidate) | set(original):
        if key not in mutable:
            assert candidate.get(key) == original.get(key), key
    assert candidate['calibrationProfilesV2']['A'] == original['calibrationProfilesV2']['A']
    assert candidate['parameterAdaptation'] == staged['parameterAdaptation'] == audit['parameterAdaptation']
    adaptation = candidate['parameterAdaptation']
    weights = selection['finalFit']['weights']
    assert adaptation['method'] == METHOD and adaptation['weights'] == weights
    assert adaptation['ridge'] == selection['decision']['selectedRidge']
    assert adaptation['choiceFrozenAt'] == selection['decision']['frozenAt']
    assert adaptation['weightsFrozenAt'] == selection['finalFit']['frozenAt']
    for name in ['fit', 'validation', 'refit']:
        assert adaptation[name] == selection['manifests'][name]
    selection_checks = SELECTION.verify(plan_file, prepared)  # Replays native predictions; never optimizes.
    scaling = {side: verify_scaling(original['models'][side], candidate['models'][side], weights[index * 3:index * 3 + 3])
               for index, side in enumerate(['home', 'away'])}
    assert scaling['home']['emptyLeavesStillZero'] == 805 and scaling['away']['emptyLeavesStillZero'] == 838

    previous = read(ROOT / 'backend/artifacts/research/c-tree-neighbor-backoff-20261108/run/comparison.json')
    previous_rows = {row['matchId']: row for row in previous['rows']}
    rows = report['rows']
    assert len(rows) == len({row['matchId'] for row in rows}) == plan['diagnosticCohort']['n'] == 652
    assert ids_hash(rows) == plan['diagnosticCohort']['matchIdsHash']
    quotes = {row['matchId']: row for row in read(ROOT / 'backend/artifacts/research/current-c-real-odds-backtest-20261108/quotes.json')['rows']}
    protected = set(read(ROOT / 'backend/src/research/original-holdout-policy.json')['protectedOriginalFinalMatchIds'])
    quarantined = {row['matchId'] for row in read(ROOT / 'backend/src/research/challenger-data-quarantine.json')['entries']}
    assert {row['matchId'] for row in rows} == set(previous_rows) == set(quotes)
    assert not ({row['matchId'] for row in rows} & (protected | quarantined))
    for row in rows:
        old = previous_rows[row['matchId']]
        assert {k: v for k, v in row.items() if k != 'forecasts'} == {k: v for k, v in old.items() if k != 'forecasts'}
        assert row['forecasts']['incumbent'] == old['forecasts']['incumbent']
        target = quotes[row['matchId']]
        for index, quote in enumerate(row['quoteEvidence']):
            assert quote == {'selection': KEYS[index], 'market': '1x2', 'side': ['home', 'draw', 'away'][index],
                             'bookmaker': 'Bet365', 'source': 'football_data_csv', 'priceType': 'closing',
                             'capturedAt': target['archiveAcquiredAt'], 'timestampEvidence': 'observed_snapshot',
                             'odds': target['sheets']['1x2']['prices'][index]}
        assert row['quoteTiming'] == 'closing_download_observation_not_forecast_capture'

    reconstruction = subprocess.run(['node', '-e', RECONSTRUCT, str(ROOT), str(run), str(plan_file)],
                                    cwd=ROOT, capture_output=True, text=True, check=True)
    frozen_inputs = json.loads(reconstruction.stdout)
    assert len(frozen_inputs['buildParity']) == 8 and all(frozen_inputs['buildParity'].values())
    assert frozen_inputs['buildParity'] == report['buildParity']
    assert frozen_inputs['adapterIdentity'] == report['adapterIdentity']
    assert frozen_inputs['adapterIdentity']['probabilityPipelineHash'] == original['pipelineHashV2']
    assert frozen_inputs['baselineManifest']['version'] == original['baselineVersion']
    assert not inputs_file.exists()
    with inputs_file.open('x', encoding='utf-8', newline='\n') as handle:
        json.dump(frozen_inputs, handle, separators=(',', ':'), allow_nan=False); handle.write('\n')
    frozen_inputs_hash = digest(inputs_file)
    input_by_id = {row['matchId']: row for row in frozen_inputs['rows']}
    assert sum(row['source'] == 'pure_forecast_core_rebuild' for row in input_by_id.values()) == 43
    for row in rows:
        source = input_by_id[row['matchId']]
        assert source['forecastAt'] == row['forecastAt']
        assert timestamp(source['forecastAt']) > timestamp(candidate['validationThrough'])
        assert timestamp(source['maxTrainingAvailableAt']) <= timestamp(source['forecastAt']) < timestamp(row['kickoffAt'])
        assert source['dataQualityPolicyHash'] == candidate['dataQualityPolicyHash'] and source['dataQualityBaselineClean'] is True

    dataset = read(ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json')
    data_by_id = {row['matchId']: row for row in dataset['rows']}
    assert len(data_by_id) == len(parity['rows']) == 6577
    assert parity['featureNames'] == original['featureNames']
    assert ids_hash(parity['rows']) == ids_hash(dataset['rows'])
    parity_by_id = {row['matchId']: row for row in parity['rows']}
    indices = [dataset['featureNames'].index(name) for name in original['featureNames']]
    all_features = np.asarray([[row['features'][i] for i in indices] for row in dataset['rows']])
    diagnostic_features = np.asarray([input_by_id[row['matchId']]['features'] for row in rows])
    split = original['trainingSplit']
    train = [row for row in dataset['rows'] if split['train']['from'] <= row['forecastAt'] <= split['train']['to']
             and row['availableAt'] < split['selection']['from']]
    assert len(train) == 5293 and ids_hash(train) == split['train']['matchIdsHash']
    training_features = np.asarray([[row['features'][i] for i in indices] for row in train])
    calibration = candidate['calibrationPredictions']
    assert len(calibration) == 358 and ids_hash(calibration) == split['calibration']['matchIdsHash']
    assert candidate['calibrationPredictions'] == staged['calibrationPredictions']
    for old, new in zip(original['calibrationPredictions'], calibration):
        assert {k: v for k, v in old.items() if k != 'matrixC'} == {k: v for k, v in new.items() if k != 'matrixC'}
        assert timestamp(new['availableAt']) <= timestamp(candidate['validationThrough'])
        assert all(new[key] == data_by_id[new['matchId']][key] for key in ['forecastAt', 'availableAt', 'homeGoals', 'awayGoals'])
    native, native_diagnostic, support_error, native_parity_error = {}, {}, 0., 0.
    with tempfile.TemporaryDirectory(prefix='c-tree-block-final-verification-') as temporary:
        for family, artifact in [('incumbent', original), ('candidate', candidate)]:
            native[family], native_diagnostic[family] = {}, {}
            for side in ['home', 'away']:
                file = Path(temporary) / f'{family}-{side}.json'
                file.write_text(json.dumps(artifact['models'][side]), encoding='utf-8')
                model = CatBoostRegressor().load_model(str(file), format='json')
                raw = model.predict(all_features, prediction_type='RawFormulaVal', thread_count=2)
                native[family][side] = {row['matchId']: float(value) for row, value in zip(dataset['rows'], raw)}
                field = 'raw' if family == 'candidate' else 'rawIncumbent'
                expected = np.array([parity_by_id[row['matchId']][field][side][0] for row in dataset['rows']])
                native_parity_error = max(native_parity_error, float(np.max(np.abs(raw - expected))))
                native_diagnostic[family][side] = np.exp(model.predict(diagnostic_features, prediction_type='RawFormulaVal', thread_count=2))
                if family == 'incumbent':
                    routes = model.calc_leaf_indexes(training_features, thread_count=2)
                    for index, tree in enumerate(artifact['models'][side]['oblivious_trees']):
                        counts = np.bincount(routes[:, index], minlength=len(tree['leaf_values']))
                        support_error = max(support_error, float(np.max(np.abs(counts - tree['leaf_weights']))))
    assert support_error == 0 and native_parity_error < 1e-10
    calibration_matrix_error, raw_error, projection_error = 0., 0., 0.
    for family, artifact in [('incumbent', original), ('candidate', candidate)]:
        family_calibration = artifact['calibrationPredictions']
        for row in family_calibration:
            matrix, _ = SHARED.joint_probabilities(data_by_id[row['matchId']], np.exp(native[family]['home'][row['matchId']]),
                np.exp(native[family]['away'][row['matchId']]), .75, .8)
            calibration_matrix_error = max(calibration_matrix_error, float(np.max(np.abs(matrix - row['matrixC']))))
        for profile_family, matrix_key in [('A', 'matrixA'), ('C', 'matrixC')]:
            profile = artifact['calibrationProfilesV2'][profile_family]
            expected_curve = original_binned_curve(family_calibration, matrix_key)
            assert numeric_error(expected_curve, profile['calibrationPoints']) < 1e-12
            assert numeric_error(expected_curve, profile['byFamily']['goal_1x2']['points']) < 1e-12
            assert profile['matches'] == 358 and profile['nObservations'] == profile['byFamily']['goal_1x2']['nObservations'] == 1074
            assert profile['fittedThrough'] == max(row['availableAt'] for row in family_calibration)
            assert profile['protocol'] == 'existing-isotonic-v1' and profile['targetProtocol'] == 'joint_1x2_normalized-v2'
            assert profile['learnedBlendWeights'] == {}
        for index, row in enumerate(rows):
            matrix, _ = SHARED.joint_probabilities(input_by_id[row['matchId']], native_diagnostic[family]['home'][index],
                                                  native_diagnostic[family]['away'][index], .75, .8)
            raw_error = max(raw_error, numeric_error(markets(matrix), row['forecasts'][family]['raw']))
            calibrated = project_partition(matrix, calibrated_partition(matrix, artifact['calibrationProfilesV2']['C']))
            projection_error = max(projection_error, numeric_error(markets(calibrated), row['forecasts'][family]['calibrated']))
            decision = project_partition(calibrated, [row['forecasts'][family]['decision'][key] for key in KEYS])
            projection_error = max(projection_error, numeric_error(markets(decision), row['forecasts'][family]['decision']))
    assert max(calibration_matrix_error, raw_error, projection_error) < 1e-12

    historical = [row for row in rows if row['season'] != '2026/2027']
    current = [row for row in rows if row['season'] == '2026/2027']
    assert len(historical) == 595 and len(current) == 57 and ids_hash(historical) == split['test']['matchIdsHash']
    assert len(report['summary']['byLeague']) == 5
    cohorts = [('all', rows, report['summary']['all']), ('historical', historical, report['summary']['historical']),
               ('current', current, report['summary']['current'])]
    cohorts += [(league, [row for row in rows if row['competition'] == league], summary)
                for league, summary in report['summary']['byLeague'].items()]
    metric_error, interval_error = 0., 0.
    for _, cohort, summary in cohorts:
        for stage in STAGES:
            actual = {family: metrics(cohort, family, stage) for family in ['incumbent', 'candidate']}
            for family in actual:
                metric_error = max(metric_error, numeric_error(actual[family], summary[stage][family]))
            deltas = {key: actual['candidate'][key] - actual['incumbent'][key] for key in actual['candidate'] if key != 'n'}
            metric_error = max(metric_error, numeric_error(deltas, summary[stage]['deltaCandidateMinusIncumbent']))
            intervals = paired_intervals(cohort, stage, plan['metrics']['intervals']['replications'], plan['metrics']['intervals']['seed'])
            interval_error = max(interval_error, numeric_error(intervals, summary[stage]['pairedWeekly95PercentInterval']))
    assert max(metric_error, interval_error) < 1e-12
    criterion = report['developmentCriterion']
    expected_gates = ['exactly_five_leagues']
    for stage in ['calibrated', 'decision']:
        for metric in ['logLoss', 'brier']:
            expected_gates += [f'all.{stage}.{metric}.strictly_lower', f'all.{stage}.{metric}.paired95_upper_below_zero']
            expected_gates += [f'{league}.{stage}.{metric}.strictly_lower' for league in sorted(report['summary']['byLeague'])]
        expected_gates.append(f'all.{stage}.ece.not_worse')
    assert [gate['name'] for gate in criterion['gates']] == expected_gates
    failed = []
    for gate in criterion['gates']:
        name = gate['name']
        if name == 'exactly_five_leagues':
            passed = len(report['summary']['byLeague']) == 5
        elif name.startswith('all.'):
            _, stage, metric, kind = name.split('.')
            values = report['summary']['all'][stage]
            if kind == 'paired95_upper_below_zero':
                passed = values['pairedWeekly95PercentInterval']['intervals'][metric]['upper'] < 0
            elif metric == 'ece':
                passed = values['deltaCandidateMinusIncumbent']['eceTopLabel10Bins'] <= 0
            else:
                passed = values['deltaCandidateMinusIncumbent'][metric] < 0
        else:
            league, stage, metric, _ = name.split('.')
            passed = report['summary']['byLeague'][league][stage]['deltaCandidateMinusIncumbent'][metric] < 0
        assert gate['passed'] is bool(passed)
        if not passed:
            failed.append(name)
    assert failed == [gate['name'] for gate in criterion['failedGates']]
    assert criterion['passed'] is (not failed) and criterion['productionAdoptionEligible'] is False
    improved = [league for league, summary in sorted(report['summary']['byLeague'].items())
                if all(summary[stage]['deltaCandidateMinusIncumbent'][metric] < 0
                       for stage in ['calibrated', 'decision'] for metric in ['logLoss', 'brier'])]
    assert criterion['improvedLeagues'] == improved
    check_hashes(plan, report, prepared)
    assert digest(run / 'comparison.json') == comparison_hash and digest(run / 'candidate.json') == candidate_hash
    assert digest(inputs_file) == frozen_inputs_hash
    return {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'scriptHash': digest(Path(__file__)),
            'planHash': PLAN_HASH, 'comparisonHash': comparison_hash, 'candidateHash': candidate_hash,
            'frozenDiagnosticInputsFile': str(inputs_file), 'frozenDiagnosticInputsHash': frozen_inputs_hash,
            'inputReconstructionCodeHash': hashlib.sha256(RECONSTRUCT.encode()).hexdigest(),
            'catboostVersion': catboost_version, 'scalingChecks': scaling, 'selectionChecks': selection_checks,
            'nativeParityRowsPerModel': 6577, 'nativeRawParityMaximumError': native_parity_error,
            'nativeOriginalTrainingSupportRows': 5293, 'nativeOriginalTrainingSupportMaximumError': support_error,
            'nativeDiagnosticRowsPerModel': 652, 'pureForecastCoreInputsRebuilt': 43,
            'nativeCalibrationRowsPerModel': 358, 'nativeCalibrationMatrixMaximumError': calibration_matrix_error,
            'independentRawProbabilityMaximumError': raw_error, 'independentCalibrationAndPartitionMaximumError': projection_error,
            'independentAllMetricMaximumError': metric_error, 'independentWeeklyIntervalMaximumError': interval_error,
            'fixedCriterionReproduced': True, 'sameQuotesCohortAndIncumbentAsPrevious': True,
            'decisionVerification': 'Pinned current adapter identity, independent result-partition coherence and all metrics; no separate reimplementation of market-blend heuristics.',
            'incumbentAndPinnedSourcesUnchanged': True, 'independentPredictiveEvidence': False, 'productionAdoptionEligible': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--prepared', required=True, type=Path)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    assert not args.out.exists(), 'Exclusive new output required'
    inputs_file = args.out.with_name(args.out.stem + '-inputs.json')
    assert not inputs_file.exists(), 'Exclusive frozen input output required'
    result = verify(args.plan.resolve(), args.prepared.resolve(), args.run.resolve(), inputs_file.resolve())
    with args.out.open('x', encoding='utf-8', newline='\n') as handle:
        json.dump(result, handle, indent=2, allow_nan=False); handle.write('\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
