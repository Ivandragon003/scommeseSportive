"""Independent verification of the one fixed Newton comparison; no fits or search."""
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
PLAN_HASH = 'f073f545685a147607e5fd05bb25e49d25f0a461e15952bae8908aaff06e09d1'
METHOD = 'single-newton-update-original-training-full-probability-comparison-v1'
VARIANT = 'newton_one_step'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


COMMON = load('newton_independent_pipeline_math', HERE.parent / 'c-tree-weight-research/verify.py')
SOURCE = load('newton_current_source_bridge', HERE.parent / 'c-tree-ignored-samples-research/verify_selection.py')
read, digest, timestamp = COMMON.read, COMMON.digest, COMMON.timestamp


def parameter_guard(original, candidate):
    adjusted = copy.deepcopy(candidate)
    before, after = original['model_info']['params'], adjusted['model_info']['params']
    assert before['tree_learner_options']['leaf_estimation_iterations'] == 10
    assert after['tree_learner_options']['leaf_estimation_iterations'] == 1
    assert before['tree_learner_options']['leaf_estimation_backtracking'] == after['tree_learner_options']['leaf_estimation_backtracking'] == 'AnyImprovement'
    assert 'leaf_estimation_iterations' not in before['flat_params']
    assert after['flat_params'].pop('leaf_estimation_iterations') == 1
    after['tree_learner_options']['leaf_estimation_iterations'] = 10
    SOURCE.L2.parameters(original, adjusted, 3.)
    assert len(candidate['oblivious_trees']) == 120
    assert all(len(tree.get('splits', [])) <= 5 for tree in candidate['oblivious_trees'])
    assert not any(candidate['features_info'].get(key) for key in ['categorical_features', 'text_features', 'embedding_features'])


def fixed_decision(decision):
    assert decision['variantFixedBeforeOutcomes'] is True and decision['variant'] == VARIANT
    assert decision['fullDiagnosticRequired'] is True
    assert isinstance(decision['developmentFiveLeagueCriterionPassed'], bool)
    return True


def verify_staged_models(staged, final):
    """Permit only the documented inactive uint64 serialization pair on final export."""
    assert staged.keys() == final.keys() == {'home', 'away'}
    receipts = {}
    for side in ['home', 'away']:
        original, exported = staged[side], copy.deepcopy(final[side])
        before = original['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit']
        after = exported['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit']
        applied = before != after
        if applied:
            assert type(before) is int and type(after) is int
            assert (before, after) == (18446744073709551615, 18446744073709552000), 'Undocumented counter serialization change'
            for model in [original, exported]:
                assert not any(model['features_info'].get(key) for key in ['categorical_features', 'text_features', 'embedding_features']), 'Active feature type forbids counter normalization'
            exported['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] = before
        assert exported == original, 'Final model changed beyond documented inactive counter serialization'
        receipts[side] = {'normalizationApplied': applied, 'stagedCounter': before, 'finalCounter': after,
                          'allOtherModelValuesExactlyUnchanged': True}
    return receipts


def parameter_guard_models(staged, final):
    receipts = verify_staged_models(staged, final)
    normalized = copy.deepcopy(final)
    for side, receipt in receipts.items():
        if receipt['normalizationApplied']:
            normalized[side]['model_info']['params']['cat_feature_params']['ctr_leaf_count_limit'] = receipt['stagedCounter']
    return normalized, receipts


def verify_target_row(row, target):
    assert row['matchId'] == target['matchId']
    for key in ['homeGoals', 'awayGoals', 'competition', 'season', 'kickoffAt']:
        assert row[key] == target[key], f'Diagnostic target mismatch: {key}'
    for key in ['homeGoals', 'awayGoals']:
        assert type(row[key]) is int and row[key] >= 0


def verify_gates(summary, criterion):
    gates = [{'name': 'exactly_five_leagues', 'passed': len(summary['byLeague']) == 5, 'value': len(summary['byLeague'])}]
    leagues = sorted(summary['byLeague'])
    for stage in ['calibrated', 'decision']:
        for metric in ['logLoss', 'brier']:
            delta = summary['all'][stage]['deltaCandidateMinusIncumbent'][metric]
            gates.append({'name': f'all.{stage}.{metric}.strictly_lower', 'passed': delta < 0, 'value': delta})
            interval = summary['all'][stage]['pairedWeekly95PercentInterval']['intervals'][metric]
            gates.append({'name': f'all.{stage}.{metric}.paired95_upper_below_zero', 'passed': interval['upper'] < 0, 'value': interval})
            for league in leagues:
                value = summary['byLeague'][league][stage]['deltaCandidateMinusIncumbent'][metric]
                gates.append({'name': f'{league}.{stage}.{metric}.strictly_lower', 'passed': value < 0, 'value': value})
        delta = summary['all'][stage]['deltaCandidateMinusIncumbent']['eceTopLabel10Bins']
        gates.append({'name': f'all.{stage}.ece.not_worse', 'passed': delta <= 0, 'value': delta})
    assert COMMON.numeric_error(gates, criterion['gates']) < 1e-12
    failed = [gate for gate in gates if not gate['passed']]
    assert criterion['failedGates'] == failed and criterion['passed'] is (not failed)
    assert criterion['diagnosticOnly'] is True and criterion['productionAdoptionEligible'] is False
    improved = [league for league in leagues if all(summary['byLeague'][league][stage]['deltaCandidateMinusIncumbent'][metric] < 0
                for stage in ['calibrated', 'decision'] for metric in ['logLoss', 'brier'])]
    assert criterion['improvedLeagues'] == improved


REPLAY = r"""
const fs=require('node:fs'),path=require('node:path');const p=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const adapter=require(path.join(process.argv[1],'backend/experiments/current-c-real-odds-backtest/selector-math.cjs'));
const keys=['homeWin','draw','awayWin','over25','under25','btts','bttsNo'];
const rows=p.rows.map(row=>({matchId:row.matchId,forecasts:Object.fromEntries(['incumbent','candidate'].map(name=>{
const result=adapter.calibrateAndBlend({matrix:row.matrices[name],profile:p.profiles[name],mode:'isotonic_1x2',forecastAt:row.forecastAt,quotes:row.quotes});
if(!result.marketBlendingApplied||result.bookmaker.bookmaker!=='Bet365'||!result.retrospectiveOnly)throw Error('Unexpected retrospective pipeline result');
return [name,Object.fromEntries(['calibrated','decision'].map(stage=>[stage,Object.fromEntries(keys.map(key=>[key,result[stage][key]]))]))];}))}));
process.stdout.write(JSON.stringify({adapterIdentity:adapter.identities(),rows}));
"""


def verify(plan_file, prepared, run, inputs_file):
    plan_file, prepared, run = Path(plan_file).resolve(), Path(prepared).resolve(), Path(run).resolve()
    assert digest(plan_file) == PLAN_HASH and catboost_version == '1.2.8'
    plan, report = read(plan_file), read(run / 'comparison.json')
    assert plan['protocol'] == report['protocol'] == 'c-tree-newton-one-research-v1'
    assert plan['intervention']['method'] == METHOD and plan['parameterDevelopment']['noSelectionGate'] is True
    original = read(ROOT / 'backend/current-models/challenger.json')
    candidate, staged = read(run / 'candidate.json'), read(prepared / 'artifact.json')
    audit, development, parity = (read(prepared / name) for name in ['audit.json', 'development.json', 'parity.json'])
    hashes = {plan_file: PLAN_HASH, run / 'comparison.json': digest(run / 'comparison.json'), run / 'candidate.json': digest(run / 'candidate.json'),
              prepared / 'artifact.json': digest(prepared / 'artifact.json'), prepared / 'audit.json': digest(prepared / 'audit.json'),
              prepared / 'development.json': digest(prepared / 'development.json'), prepared / 'parity.json': digest(prepared / 'parity.json')}
    for file, value in plan['sourceHashes'].items(): hashes[ROOT / file] = value
    for file, value in report['sourceHashes'].items(): hashes[HERE / file] = value
    for file, value in report['inputHashes'].items(): assert hashes[prepared / file] == value
    for file, value in hashes.items(): assert digest(file) == value, file
    assert report['planHash'] == candidate['experimentPlanHash'] == staged['experimentPlanHash'] == PLAN_HASH
    assert report['candidateHash'] == hashes[run / 'candidate.json'] and candidate['experimentIdentity'] == report['identity']
    pre_scoring = read(run / 'pre-scoring-checks.json')
    assert pre_scoring['candidateHash'] == hashes[run / 'candidate.json'] and pre_scoring['planHash'] == PLAN_HASH
    assert pre_scoring['identity'] == candidate['experimentIdentity'] and pre_scoring['candidateFrozenAt'] == report['candidateFrozenAt']
    assert audit['artifactHash'] == hashes[prepared / 'artifact.json'] and audit['parityHash'] == hashes[prepared / 'parity.json']
    assert audit['developmentHash'] == hashes[prepared / 'development.json'] == staged['experimentIdentity']['developmentHash']
    guard_models, serialization_checks = parameter_guard_models(staged['models'], candidate['models'])
    assert candidate['calibrationPredictions'] == staged['calibrationPredictions']
    assert digest(ROOT / 'backend/current-models/challenger.json') == plan['incumbentArtifactHash']
    assert candidate['parentVersion'] == original['version'] == plan['incumbentVersion']
    assert candidate['trainerHash'] == digest(HERE / 'prepare.py') and candidate['parentTrainerHash'] == original['trainerHash']
    assert candidate['trainedThrough'] == original['trainedThrough'] and candidate['trainingSplit'] == original['trainingSplit']
    assert candidate['hyperparameters'] == original['hyperparameters'] | {'leafEstimationIterations': 1}
    assert candidate['diagnosticOnly'] is True and candidate['productionAdoptionEligible'] is False
    assert candidate['productionValidated'] is False and candidate['independentEvidence'] is False
    assert candidate['calibrationProfilesV2']['A'] == original['calibrationProfilesV2']['A']
    assert candidate['parameterExperiment'] == staged['parameterExperiment']
    mutable = {'version', 'parentVersion', 'createdAt', 'trainerHash', 'parentTrainerHash', 'hyperparameters', 'models',
               'calibrationPredictions', 'calibrationProfilesV2', 'parameterExperiment', 'experimentPlanHash', 'experimentIdentity',
               'diagnosticOnly', 'productionAdoptionEligible', 'productionValidated', 'independentEvidence', 'availability', 'status', 'selectionProtocol'}
    for key in set(candidate) | set(original):
        if key not in mutable: assert candidate.get(key) == original.get(key), key
    experiment = candidate['parameterExperiment']
    assert experiment['method'] == METHOD and experiment['variant'] == VARIANT and experiment['leafEstimationIterations'] == 1
    assert experiment['variantFixedBeforeOutcomes'] is True and experiment['fullComparisonRegardlessOfDevelopment'] is True
    assert experiment['variantFixedAt'] == plan['createdAt'] and experiment['developmentHash'] == hashes[prepared / 'development.json']
    assert experiment['sourceVersion'] == original['version'] and experiment['sourceArtifactHash'] == plan['incumbentArtifactHash']
    assert experiment['developmentFiveLeagueCriterionPassed'] == development['decision']['developmentFiveLeagueCriterionPassed']
    fixed_decision(development['decision']); assert audit['decision'] == development['decision'] == report['developmentDecision']
    assert audit['calibrationConsumed'] is True and audit['candidateFits'] == 2 and audit['controlFits'] == 0
    assert timestamp(plan['createdAt']) < timestamp(candidate['createdAt']) <= timestamp(report['candidateFrozenAt']) <= timestamp(report['diagnosticStartedAt']) <= timestamp(report['completedAt'])
    dataset = read(ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json')
    rows = sorted(dataset['rows'], key=lambda row: (timestamp(row['forecastAt']), row['matchId']))
    assert len(rows) == len({row['matchId'] for row in rows}) == 6577
    by_id = {row['matchId']: index for index, row in enumerate(rows)}
    indices = [dataset['featureNames'].index(name) for name in original['featureNames']]
    features = np.asarray([[row['features'][index] for index in indices] for row in rows])
    groups = {}
    for name, part, next_part in [('fit', 'train', 'selection'), ('development', 'selection', 'calibration')]:
        group = [row for row in rows if original['trainingSplit'][part]['from'] <= row['forecastAt'] <= original['trainingSplit'][part]['to']
                 and row['availableAt'] < original['trainingSplit'][next_part]['from']]
        ids = [row['matchId'] for row in group]; manifest = development[name]
        assert manifest == audit[name] == experiment[name]
        assert manifest['matchIds'] == ids and manifest['n'] == len(ids) == original['trainingSplit'][part]['n']
        assert manifest['matchIdsHash'] == COMMON.ids_hash(group) == original['trainingSplit'][part]['matchIdsHash']
        assert manifest['orderedMatchIdsHash'] == hashlib.sha256('\n'.join(ids).encode()).hexdigest()
        assert manifest['availableThrough'] == max(row['availableAt'] for row in group)
        groups[name] = group
    protected = set(read(ROOT / 'backend/src/research/original-holdout-policy.json')['protectedOriginalFinalMatchIds'])
    quarantined = {entry['matchId'] for entry in read(ROOT / 'backend/src/research/challenger-data-quarantine.json')['entries']}
    assert not ((set(development['fit']['matchIds']) | set(development['development']['matchIds'])) & (protected | quarantined))
    control_selection_file = ROOT / plan['reproductionControl']['source']; control_selection = read(control_selection_file)
    models = {'identity': original['models'], 'candidate': candidate['models'], 'control': {}}
    for side in ['home', 'away']:
        control_info = control_selection['control']['models'][side]; file = (control_selection_file.parent / control_info['file']).resolve()
        assert digest(file) == control_info['sha256'] == plan['sourceHashes'][file.relative_to(ROOT).as_posix()]
        models['control'][side] = read(file)
        parameter_guard(original['models'][side], guard_models[side]); SOURCE.L2.parameters(original['models'][side], models['control'][side], 3.)
        old, control = original['models'][side], models['control'][side]
        assert {key: value for key, value in old.items() if key not in ['model_info', 'oblivious_trees']} == {key: value for key, value in control.items() if key not in ['model_info', 'oblivious_trees']}
        for a, b in zip(old['oblivious_trees'], control['oblivious_trees']):
            assert {key: value for key, value in a.items() if key != 'leaf_values'} == {key: value for key, value in b.items() if key != 'leaf_values'}
            assert float(np.max(np.abs(np.asarray(a['leaf_values']) - b['leaf_values']))) <= 1e-12
    raw_all, errors = {}, {'nativePython': 0., 'nativeTypeScriptSource': 0., 'control': 0., 'development': 0., 'calibrationMatrix': 0., 'rawDiagnostic': 0., 'calibratedDiagnostic': 0., 'decisionReplay': 0., 'metrics': 0., 'bootstrap': 0.}
    train_indices = [by_id[row['matchId']] for row in groups['fit']]
    with tempfile.TemporaryDirectory(prefix='newton-one-independent-verification-') as temporary:
        for family in ['identity', 'control', 'candidate']:
            raw_all[family] = {}
            for side in ['home', 'away']:
                file = Path(temporary) / f'{family}-{side}.json'; file.write_text(json.dumps(models[family][side]), encoding='utf-8')
                native = CatBoostRegressor().load_model(str(file), format='json')
                assert native.feature_names_ == original['featureNames']
                raw = np.asarray(native.predict(features, prediction_type='RawFormulaVal', thread_count=2)); raw_all[family][side] = raw
                errors['nativePython'] = max(errors['nativePython'], float(np.max(np.abs(raw - SOURCE.traverse_raw(models[family][side], features)))))
                if family == 'control': errors['control'] = max(errors['control'], float(np.max(np.abs(raw - raw_all['identity'][side]))))
                if family in ['identity', 'candidate']:
                    routes = native.calc_leaf_indexes(features[train_indices], thread_count=2)
                    for index, tree in enumerate(models[family][side]['oblivious_trees']): assert np.array_equal(np.bincount(routes[:, index], minlength=len(tree['leaf_values'])), tree['leaf_weights'])
        bridge = SOURCE.source_predictions(models, rows, features, plan['sourceHashes'], temporary)
        source_rows = {row['matchId']: row for row in bridge['rows']}
        for family in models:
            for side in ['home', 'away']:
                errors['nativeTypeScriptSource'] = max(errors['nativeTypeScriptSource'], float(np.max(np.abs(np.asarray([source_rows[row['matchId']][family][side][0] for row in rows]) - raw_all[family][side]))))
        parity_rows = {row['matchId']: row for row in parity['rows']}; assert set(parity_rows) == set(by_id)
        for row in rows:
            for side in ['home', 'away']:
                assert abs(parity_rows[row['matchId']]['raw'][side][0] - raw_all['candidate'][side][by_id[row['matchId']]]) <= 1e-12
                assert abs(parity_rows[row['matchId']]['rawIncumbent'][side][0] - raw_all['identity'][side][by_id[row['matchId']]]) <= 1e-12
        development_evidence = {row['matchId']: row for row in development['developmentRows']}
        assert len(development_evidence) == len(development['developmentRows']) == 317
        assert set(development_evidence) == {row['matchId'] for row in groups['development']}
        computed_development = {}
        for family in ['identity', 'candidate']:
            p = np.asarray([COMMON.SHARED.joint_probabilities(row, np.exp(raw_all[family]['home'][by_id[row['matchId']]]), np.exp(raw_all[family]['away'][by_id[row['matchId']]]), .75, .8)[1] for row in groups['development']])
            computed_development[family] = COMMON.SELECTION.metrics(groups['development'], p)
            errors['development'] = max(errors['development'], COMMON.SELECTION.compare_metrics(computed_development[family], development[family]['developmentMetrics']))
            for index, row in enumerate(groups['development']):
                assert development_evidence[row['matchId']]['competition'] == row['competition']
                assert development_evidence[row['matchId']]['actualClass'] == (0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1)
                raw_key = 'identityRaw' if family == 'identity' else 'candidateRaw'
                for side in ['home', 'away']:
                    assert abs(development_evidence[row['matchId']][raw_key][side][0] - raw_all[family][side][by_id[row['matchId']]]) <= 1e-12
                errors['development'] = max(errors['development'], float(np.max(np.abs(p[index] - development_evidence[row['matchId']][family]))))
        assert SOURCE.accepts(computed_development['candidate'], computed_development['identity']) == development['decision']['developmentFiveLeagueCriterionPassed']
        for family in ['identity', 'candidate']:
            artifact = original if family == 'identity' else candidate
            for before, row in zip(original['calibrationPredictions'], artifact['calibrationPredictions']):
                assert {key: value for key, value in before.items() if key != 'matrixC'} == {key: value for key, value in row.items() if key != 'matrixC'}
                index = by_id[row['matchId']]
                matrix, _ = COMMON.SHARED.joint_probabilities(rows[index], np.exp(raw_all[family]['home'][index]), np.exp(raw_all[family]['away'][index]), .75, .8)
                errors['calibrationMatrix'] = max(errors['calibrationMatrix'], float(np.max(np.abs(matrix - row['matrixC']))))
            for profile_family, matrix_key in [('A', 'matrixA'), ('C', 'matrixC')]:
                profile = artifact['calibrationProfilesV2'][profile_family]
                curve = COMMON.original_binned_curve(artifact['calibrationPredictions'], matrix_key)
                assert COMMON.numeric_error(curve, profile['calibrationPoints']) <= 1e-12
                assert COMMON.numeric_error(curve, profile['byFamily']['goal_1x2']['points']) <= 1e-12
                assert profile['matches'] == 358 and profile['nObservations'] == 1074
        reconstruction = subprocess.run(['node', '-e', COMMON.RECONSTRUCT, str(ROOT), str(run), str(plan_file)], cwd=ROOT, capture_output=True, text=True, check=True)
        frozen = json.loads(reconstruction.stdout); assert all(frozen['buildParity'].values()) and len(frozen['buildParity']) == 8
        assert frozen['adapterIdentity'] == report['adapterIdentity'] and frozen['buildParity'] == report['buildParity']
        assert not inputs_file.exists()
        with inputs_file.open('x', encoding='utf-8', newline='\n') as handle: json.dump(frozen, handle, separators=(',', ':'), allow_nan=False); handle.write('\n')
        frozen_hash = digest(inputs_file); input_by_id = {row['matchId']: row for row in frozen['rows']}
        assert sum(row['source'] == 'pure_forecast_core_rebuild' for row in input_by_id.values()) == 43
        diagnostic = report['rows']; assert len(diagnostic) == len(input_by_id) == 652 and COMMON.ids_hash(diagnostic) == plan['diagnosticCohort']['matchIdsHash']
        targets = {row['matchId']: row for row in read(ROOT / 'backend/artifacts/research/current-c-real-odds-backtest-20261108/quotes.json')['rows']}
        assert set(input_by_id) == set(targets)
        replay_rows = []
        for index, row in enumerate(diagnostic):
            source = input_by_id[row['matchId']]; assert source['forecastAt'] == row['forecastAt']
            assert timestamp(source['maxTrainingAvailableAt']) <= timestamp(source['forecastAt']) < timestamp(row['kickoffAt'])
            assert timestamp(source['forecastAt']) > timestamp(candidate['validationThrough'])
            assert row['matchId'] not in protected | quarantined
            target = targets[row['matchId']]
            verify_target_row(row, target)
            for i, quote in enumerate(row['quoteEvidence']): assert quote == {'selection': COMMON.KEYS[i], 'market': '1x2', 'side': ['home', 'draw', 'away'][i], 'bookmaker': 'Bet365', 'source': 'football_data_csv', 'priceType': 'closing', 'capturedAt': target['archiveAcquiredAt'], 'timestampEvidence': 'observed_snapshot', 'odds': target['sheets']['1x2']['prices'][i]}
            replay_rows.append({'matchId': row['matchId'], 'forecastAt': source['forecastAt'], 'quotes': row['quoteEvidence'], 'matrices': {}})
        diagnostic_features = np.asarray([input_by_id[row['matchId']]['features'] for row in diagnostic])
        for name, family, artifact in [('incumbent', 'identity', original), ('candidate', 'candidate', candidate)]:
            native_raw = {}
            for side in ['home', 'away']:
                file = Path(temporary) / f'{family}-{side}.json'; native = CatBoostRegressor().load_model(str(file), format='json')
                native_raw[side] = native.predict(diagnostic_features, prediction_type='RawFormulaVal', thread_count=2)
            for index, row in enumerate(diagnostic):
                matrix, _ = COMMON.SHARED.joint_probabilities(input_by_id[row['matchId']], np.exp(native_raw['home'][index]), np.exp(native_raw['away'][index]), .75, .8)
                replay_rows[index]['matrices'][name] = matrix.tolist()
                errors['rawDiagnostic'] = max(errors['rawDiagnostic'], COMMON.numeric_error(COMMON.markets(matrix), row['forecasts'][name]['raw']))
                calibrated = COMMON.project_partition(matrix, COMMON.calibrated_partition(matrix, artifact['calibrationProfilesV2']['C']))
                errors['calibratedDiagnostic'] = max(errors['calibratedDiagnostic'], COMMON.numeric_error(COMMON.markets(calibrated), row['forecasts'][name]['calibrated']))
        replay_file = Path(temporary) / 'native-pipeline-replay.json'
        replay_file.write_text(json.dumps({'rows': replay_rows, 'profiles': {'incumbent': original['calibrationProfilesV2']['C'], 'candidate': candidate['calibrationProfilesV2']['C']}}, allow_nan=False), encoding='utf-8')
        replay = json.loads(subprocess.run(['node', '-e', REPLAY, str(ROOT), str(replay_file)], cwd=ROOT, capture_output=True, text=True, check=True).stdout)
        assert replay['adapterIdentity'] == report['adapterIdentity']
        for actual, expected in zip(replay['rows'], diagnostic):
            assert actual['matchId'] == expected['matchId']
            for name in ['incumbent', 'candidate']:
                for stage in ['calibrated', 'decision']: errors['decisionReplay'] = max(errors['decisionReplay'], COMMON.numeric_error(actual['forecasts'][name][stage], expected['forecasts'][name][stage]))
    diagnostic = report['rows']; historical = [row for row in diagnostic if row['season'] != '2026/2027']; current = [row for row in diagnostic if row['season'] == '2026/2027']
    assert len(historical) == 595 and len(current) == 57 and COMMON.ids_hash(historical) == plan['trainingSplit']['test']['matchIdsHash']
    cohorts = [(diagnostic, report['summary']['all']), (historical, report['summary']['historical']), (current, report['summary']['current'])]
    cohorts += [([row for row in diagnostic if row['competition'] == league], summary) for league, summary in report['summary']['byLeague'].items()]
    for cohort, summary in cohorts:
        for stage in COMMON.STAGES:
            for family in ['incumbent', 'candidate']: errors['metrics'] = max(errors['metrics'], COMMON.numeric_error(COMMON.metrics(cohort, family, stage), summary[stage][family]))
            expected_delta = {key: summary[stage]['candidate'][key] - summary[stage]['incumbent'][key] for key in summary[stage]['candidate'] if key != 'n'}
            errors['metrics'] = max(errors['metrics'], COMMON.numeric_error(expected_delta, summary[stage]['deltaCandidateMinusIncumbent']))
            ci = COMMON.paired_intervals(cohort, stage, 2000, 20261108)
            errors['bootstrap'] = max(errors['bootstrap'], COMMON.numeric_error(ci, summary[stage]['pairedWeekly95PercentInterval']))
    verify_gates(report['summary'], report['developmentCriterion'])
    assert max(errors.values()) <= 1e-12
    for file, value in hashes.items(): assert digest(file) == value, file
    assert digest(inputs_file) == frozen_hash
    return {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'scriptHash': digest(__file__), 'planHash': PLAN_HASH,
        'candidateHash': hashes[run / 'candidate.json'], 'comparisonHash': hashes[run / 'comparison.json'],
        'frozenDiagnosticInputsFile': str(inputs_file), 'frozenDiagnosticInputsHash': frozen_hash,
        'nativeSourceRowsPerRegressor': 6577, 'nativeTrainingRowsPerRegressor': 5293, 'nativeDevelopmentRowsPerPair': 317,
        'nativeCalibrationRowsPerModel': 358, 'nativeFullDiagnosticRowsPerModel': 652, 'rebuiltForecastCoreInputs': 43,
        'sourceTypeScriptVerification': {key: value for key, value in bridge.items() if key != 'rows'},
        'dependencyHashes': {str(HERE.parent / 'c-tree-weight-research/verify.py'): digest(HERE.parent / 'c-tree-weight-research/verify.py'), str(HERE.parent / 'c-tree-ignored-samples-research/verify_selection.py'): digest(HERE.parent / 'c-tree-ignored-samples-research/verify_selection.py')},
        'errors': errors, 'fixedVariantComparedRegardlessOfDevelopment': True, 'all31GateFlagsReproduced': True,
        'stagedToFinalSerializationChecks': serialization_checks,
        'sameRealBet365Quotes': True, 'incumbentAndPinnedSourcesUnchanged': True, 'independentPredictiveEvidence': False, 'productionAdoptionEligible': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['plan', 'prepared', 'run', 'out']: parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args(); assert not args.out.exists()
    inputs = args.out.with_name(args.out.stem + '-inputs.json').resolve(); assert not inputs.exists()
    result = verify(args.plan, args.prepared, args.run, inputs)
    with args.out.open('x', encoding='utf-8', newline='\n') as handle: json.dump(result, handle, indent=2, allow_nan=False); handle.write('\n')
    print(json.dumps(result))
