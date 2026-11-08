"""Independent minimax-fit feasibility and selection verification; no optimization."""
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
from catboost import CatBoostRegressor, __version__ as catboost_version

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
PLAN_HASH = '146b9f41cf66d8613de6dffc4ff30c08f70696b02ca9264342e9794270b88c75'
METHOD = 'six-original-tree-block-weights-minimax-training-relative-regret-v1'
COMMON_FILE = HERE.parent / 'c-tree-hierarchical-research/verify_selection.py'
SPEC = importlib.util.spec_from_file_location('minimax_independent_common_verifier', COMMON_FILE)
COMMON = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMMON)
read, digest, timestamp = COMMON.read, COMMON.digest, COMMON.timestamp
metrics, compare_metrics = COMMON.metrics, COMMON.compare_metrics
joint_probabilities, traverse_raw = COMMON.joint_probabilities, COMMON.traverse_raw


def scaled_model(original, weights):
    assert len(weights) == 3 and np.isfinite(weights).all()
    candidate = copy.deepcopy(original)
    assert len(candidate['oblivious_trees']) == 120
    for index, tree in enumerate(candidate['oblivious_trees']):
        tree['leaf_values'] = [value * weights[index // 40] for value in tree['leaf_values']]
    return candidate


def verify_scaling(original, candidate, weights):
    assert {key: value for key, value in original.items() if key != 'oblivious_trees'} == {
        key: value for key, value in candidate.items() if key != 'oblivious_trees'}
    assert len(original['oblivious_trees']) == len(candidate['oblivious_trees']) == 120
    changed, empty = 0, 0
    for index, (old, new) in enumerate(zip(original['oblivious_trees'], candidate['oblivious_trees'])):
        assert {key: value for key, value in old.items() if key != 'leaf_values'} == {
            key: value for key, value in new.items() if key != 'leaf_values'}
        before, after = np.asarray(old['leaf_values']), np.asarray(new['leaf_values'])
        counts = np.asarray(old['leaf_weights'])
        assert before.shape == after.shape == counts.shape
        assert np.isfinite(before).all() and np.isfinite(after).all()
        assert np.array_equal(after, before * weights[index // 40]), 'Incorrect side/tree-block scale'
        assert np.all(before[counts == 0] == 0) and np.all(after[counts == 0] == 0)
        changed += int(np.sum(after != before)); empty += int(np.sum(counts == 0))
    return {'changedLeafCount': changed, 'originalEmptyLeavesStillZero': empty,
            'entireTreeScalingExact': True, 'allOtherModelMetadataExactlyUnchanged': True}


def training_risks(rows, probabilities, identity_metrics):
    actual = metrics(rows, probabilities)
    assert set(actual['byLeague']) == set(identity_metrics['byLeague']) and len(actual['byLeague']) == 5
    risks = []
    for league in sorted(identity_metrics['byLeague']):
        for metric in ['logLoss', 'brier']:
            identity = identity_metrics['byLeague'][league][metric]
            value = actual['byLeague'][league][metric]
            assert identity > 0 and math.isfinite(identity) and math.isfinite(value)
            risks.append({'league': league, 'metric': metric, 'identity': identity, 'value': value,
                          'relativeRegret': value / identity - 1})
    return risks


def solution_values(weights, epigraph, ridge, risks):
    weights = np.asarray(weights, dtype=float)
    assert weights.shape == (6,) and np.isfinite(weights).all() and math.isfinite(epigraph)
    assert len(risks) == 10
    regrets = np.asarray([risk['relativeRegret'] for risk in risks])
    assert np.isfinite(regrets).all()
    return {'objective': float(epigraph + .5 * ridge * np.sum((weights - 1) ** 2)),
            'worstRelativeRegret': float(regrets.max()),
            'maximumConstraintViolation': float(max(0., (regrets - epigraph).max()))}


def finite_vector(values, size):
    return isinstance(values, list) and len(values) == size and all(isinstance(value, (int, float)) and math.isfinite(value) for value in values)


def receipt_failures(record, risks, checks):
    """Reproduce admission from an independent risk table, without a solver call."""
    solver = record['optimizer']
    if record['failureReasons'] == ['solver_exception']:
        assert solver['success'] is False and record['weights'] is None and record['epigraph'] is None
        assert risks is None
        return ['solver_exception']
    failures = []
    if not solver['success']:
        failures.append('solver_did_not_converge')
    finite = (finite_vector(record['weights'], 6) and isinstance(record['epigraph'], (int, float))
              and math.isfinite(record['epigraph']) and solver['pointShape'] == [7]
              and solver['reportedGradientShape'] == [7] and finite_vector(solver['reportedGradient'], 7)
              and isinstance(solver['reportedObjective'], (int, float)) and math.isfinite(solver['reportedObjective']))
    if not finite:
        failures.append('nonfinite_or_malformed_solution')
        assert record['trainingRisks'] is None
        return failures
    if risks is None:
        # No invalid solution can be exported or screened. This explicit failure
        # remains distinct from the native-verified finite/bounded risk tables.
        assert 'nonfinite_recomputed_risks' in record['failureReasons'] or 'bounds_violation' in record['failureReasons']
        return None
    tolerance = checks['boundsTolerance']
    weights, epigraph = record['weights'], record['epigraph']
    if any(value < -tolerance or value > 2 + tolerance for value in weights) or epigraph < -1 - tolerance or epigraph > 1 + tolerance:
        failures.append('bounds_violation')
    values = solution_values(weights, epigraph, record['ridge'], risks)
    if values['maximumConstraintViolation'] > checks['maximumConstraintViolation']:
        failures.append('constraint_violation')
    if not values['objective'] < checks['maximumObjectiveToAdmit']:
        failures.append('penalized_objective_not_strictly_improved')
    if not values['worstRelativeRegret'] < checks['maximumWorstRelativeRegretToAdmit']:
        failures.append('worst_relative_regret_not_strictly_improved')
    if not epigraph < checks['maximumEpigraphToAdmit']:
        failures.append('epigraph_not_strictly_improved')
    return failures


def choose_fit(fits, identity):
    leagues = set(identity['byLeague'])
    assert len(leagues) == 5
    eligible = []
    for index, fit in enumerate(fits):
        if not fit['admissible']:
            assert fit['validationMetrics'] is None
            continue
        actual = fit['validationMetrics']
        assert set(actual['byLeague']) == leagues
        pairs = [(actual, identity)] + [(actual['byLeague'][league], identity['byLeague'][league]) for league in sorted(leagues)]
        if all(reference[metric] - candidate[metric] > 1e-12
               for candidate, reference in pairs for metric in ['logLoss', 'brier']):
            eligible.append(index)
    if not eligible:
        return None
    minimum = min(fits[index]['validationMetrics']['logLoss'] for index in eligible)
    return max((index for index in eligible if fits[index]['validationMetrics']['logLoss'] - minimum <= 1e-12),
               key=lambda index: fits[index]['ridge'])


def native_probabilities(models, rows, features, directory, label):
    rates, raw = {}, {}
    for side in ['home', 'away']:
        file = Path(directory) / f'{label}-{side}.json'
        file.write_text(json.dumps(models[side]), encoding='utf-8')
        native = CatBoostRegressor().load_model(str(file), format='json')
        raw[side] = np.asarray(native.predict(features, prediction_type='RawFormulaVal', thread_count=2))
        rates[side] = np.exp(raw[side])
    probabilities = np.asarray([joint_probabilities(row, rates['home'][index], rates['away'][index], .75, .8)[1]
                                for index, row in enumerate(rows)])
    assert np.isfinite(probabilities).all() and (probabilities > 0).all()
    return raw, probabilities


def verify(plan_file, prepared):
    plan_file, prepared = Path(plan_file).resolve(), Path(prepared).resolve()
    plan, selection, audit = read(plan_file), read(prepared / 'selection.json'), read(prepared / 'audit.json')
    assert digest(plan_file) == PLAN_HASH == selection['planHash'] == audit['planHash']
    assert plan['protocol'] == 'c-tree-minimax-weight-research-v1' and plan['intervention']['method'] == METHOD
    assert catboost_version == '1.2.8' and plan['intervention']['optimizer']['scipyVersion'] == '1.17.0'
    assert plan['intervention']['ridgeGrid'] == [10., 1., .1, .01]
    assert plan['intervention']['maximumOptimizationFits'] == 4 and plan['intervention']['maximumFinalRefits'] == 0
    hashes = {plan_file: PLAN_HASH, prepared / 'selection.json': digest(prepared / 'selection.json'),
              prepared / 'audit.json': digest(prepared / 'audit.json'), HERE / 'prepare.py': digest(HERE / 'prepare.py'),
              HERE / 'minimax.py': digest(HERE / 'minimax.py')}
    dependencies = [COMMON_FILE, HERE.parent / 'c-tree-l2-research/verify_selection.py',
                    HERE.parent / 'c-tree-weight-research/verify_selection.py', HERE.parent / 'c-tree-sample-projection/verify.py']
    for dependency in dependencies:
        hashes[dependency] = digest(dependency)
    assert selection['scriptHash'] == audit['scriptHash'] == hashes[HERE / 'prepare.py']
    assert selection['minimaxScriptHash'] == audit['minimaxScriptHash'] == hashes[HERE / 'minimax.py']
    assert selection['sourceHashes'] == audit['sourceHashes'] == plan['sourceHashes']
    assert audit['selectionHash'] == hashes[prepared / 'selection.json']
    for file, expected in plan['sourceHashes'].items():
        hashes[ROOT / file] = expected
    for file, expected in hashes.items():
        assert digest(file) == expected, file
    incumbent_file = ROOT / 'backend/current-models/challenger.json'
    incumbent = read(incumbent_file)
    assert digest(incumbent_file) == plan['incumbentArtifactHash']
    assert incumbent['version'] == plan['incumbentVersion'] == 'C-75fd74eb875e9d0e'
    assert incumbent['weight'] == .75 and incumbent['temperature'] == .8 and len(incumbent['featureNames']) == 40
    assert incumbent['trainingSplit'] == plan['trainingSplit']
    assert selection['diagnosticOnly'] is True and selection['productionAdoptionEligible'] is False
    assert audit['controlFits'] == audit['candidateFits'] == audit['newTreeFits'] == audit['finalRefits'] == 0
    assert audit['optimizationFits'] == 4 and audit['onlyOriginal5293LabelsInOptimizer'] is True
    assert audit['fits'] == selection['fits']
    assert audit['identityTrainingPipelineMaximumError'] == selection['identityTrainingPipelineMaximumError'] <= 1e-12
    dataset = read(ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json')
    assert dataset['dataQualityPolicyHash'] == incumbent['dataQualityPolicyHash'] and dataset['dataQualityBaselineClean'] is True
    all_rows = sorted(dataset['rows'], key=lambda row: (timestamp(row['forecastAt']), row['matchId']))
    assert len(all_rows) == len({row['matchId'] for row in all_rows}) == 6577
    split, groups = incumbent['trainingSplit'], {}
    for name, part, following in [('fit', 'train', 'selection'), ('validation', 'selection', 'calibration')]:
        rows = [row for row in all_rows if timestamp(split[part]['from']) <= timestamp(row['forecastAt']) <= timestamp(split[part]['to'])
                and timestamp(row['availableAt']) < timestamp(split[following]['from'])]
        ids = [row['matchId'] for row in rows]
        manifest = selection[name]
        assert manifest['n'] == len(ids) == plan['parameterDevelopment'][name]['n']
        assert manifest['matchIds'] == ids
        assert manifest['matchIdsHash'] == hashlib.sha256('\n'.join(sorted(ids)).encode()).hexdigest() == split[part]['matchIdsHash']
        assert manifest['orderedMatchIdsHash'] == hashlib.sha256('\n'.join(ids).encode()).hexdigest()
        assert manifest['availableThrough'] == max(row['availableAt'] for row in rows) == split[part]['availableThrough']
        assert audit[name] == manifest
        assert all(timestamp(row['maxTrainingAvailableAt']) <= timestamp(row['forecastAt']) < timestamp(row['kickoffAt'])
                   and timestamp(row['availableAt']) <= timestamp(manifest['availableThrough']) for row in rows)
        groups[name] = rows
    fit_ids, validation_ids = set(selection['fit']['matchIds']), set(selection['validation']['matchIds'])
    assert fit_ids.isdisjoint(validation_ids)
    protected = set(read(ROOT / 'backend/src/research/original-holdout-policy.json')['protectedOriginalFinalMatchIds'])
    quarantined = {entry['matchId'] for entry in read(ROOT / 'backend/src/research/challenger-data-quarantine.json')['entries']}
    assert not ((fit_ids | validation_ids) & (protected | quarantined))
    calibration_ids = {row['matchId'] for row in incumbent['calibrationPredictions']}
    assert calibration_ids.isdisjoint(fit_ids | validation_ids)
    feature_indices = [dataset['featureNames'].index(name) for name in incumbent['featureNames']]
    features = np.asarray([[row['features'][index] for index in feature_indices] for row in all_rows])
    by_id = {row['matchId']: index for index, row in enumerate(all_rows)}
    train_indices = [by_id[row['matchId']] for row in groups['fit']]
    validation_indices = [by_id[row['matchId']] for row in groups['validation']]
    assert [fit['ridge'] for fit in selection['fits']] == [10., 1., .1, .01]
    evidence = {row['matchId']: row for row in selection['validationRows']}
    assert len(evidence) == len(selection['validationRows']) == 317 and set(evidence) == validation_ids
    checks = plan['intervention']['solutionChecks']
    failures_checked, model_checks, model_inputs, original_routes, native_outputs = [], {}, {}, {}, {}
    errors = {'independentTrainingRiskMaximumError': 0., 'independentSolutionValueMaximumError': 0.,
              'nativeAllFeatureRawMaximumError': 0., 'nativeSelectionRawMaximumError': 0.,
              'independentSelectionProbabilityMaximumError': 0., 'independentSelectionMetricMaximumError': 0.}
    recomputed_fits, native_training_fits = [], 0
    with tempfile.TemporaryDirectory(prefix='c-minimax-independent-verification-') as temporary:
        _, original_training_p = native_probabilities(incumbent['models'], groups['fit'], features[train_indices], temporary, 'identity-training')
        identity_training_metrics = metrics(groups['fit'], original_training_p)
        original_risks = training_risks(groups['fit'], original_training_p, identity_training_metrics)
        assert len(selection['identity']['trainingRisks']) == 10
        for actual, recorded in zip(original_risks, selection['identity']['trainingRisks']):
            assert actual['league'] == recorded['league'] and actual['metric'] == recorded['metric']
            for key in ['identity', 'value', 'relativeRegret']:
                assert math.isfinite(recorded[key])
                errors['independentTrainingRiskMaximumError'] = max(errors['independentTrainingRiskMaximumError'], abs(actual[key] - recorded[key]))
        _, original_validation_p = native_probabilities(incumbent['models'], groups['validation'], features[validation_indices], temporary, 'identity-validation')
        identity_validation_metrics = metrics(groups['validation'], original_validation_p)
        errors['independentSelectionMetricMaximumError'] = compare_metrics(identity_validation_metrics, selection['identity']['validationMetrics'])
        original_raw_all = {}
        for side in ['home', 'away']:
            original = incumbent['models'][side]
            file = Path(temporary) / f'identity-all-{side}.json'
            file.write_text(json.dumps(original), encoding='utf-8')
            native = CatBoostRegressor().load_model(str(file), format='json')
            original_raw_all[side] = np.asarray(native.predict(features, prediction_type='RawFormulaVal', thread_count=2))
            errors['nativeAllFeatureRawMaximumError'] = max(errors['nativeAllFeatureRawMaximumError'],
                float(np.max(np.abs(original_raw_all[side] - traverse_raw(original, features)))))
            original_routes[side] = native.calc_leaf_indexes(features[train_indices], thread_count=2)
            assert audit['originalSupport'][side]['allLeafSupportsMatch'] is True
            assert audit['originalSupport'][side]['trainingLeafCounts'] == [tree['leaf_weights'] for tree in original['oblivious_trees']]
            for index, tree in enumerate(original['oblivious_trees']):
                counts = np.bincount(original_routes[side][:, index], minlength=len(tree['leaf_values']))
                assert np.array_equal(counts, tree['leaf_weights'])
        for index, row in enumerate(groups['validation']):
            observed = evidence[row['matchId']]
            assert observed['actualClass'] == (0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1)
            assert observed['competition'] == row['competition']
            assert np.isfinite(observed['identity']).all()
            errors['independentSelectionProbabilityMaximumError'] = max(errors['independentSelectionProbabilityMaximumError'],
                float(np.max(np.abs(original_validation_p[index] - observed['identity']))))
            errors['nativeSelectionRawMaximumError'] = max(errors['nativeSelectionRawMaximumError'],
                *(abs(original_raw_all[side][validation_indices[index]] - observed['identityRaw'][side][0]) for side in ['home', 'away']))
        for fit_index, fit in enumerate(selection['fits']):
            risks = None
            numeric_weights = finite_vector(fit['weights'], 6)
            tolerance = checks['boundsTolerance']
            bounded_weights = numeric_weights and all(-tolerance <= value <= 2 + tolerance for value in fit['weights'])
            if bounded_weights:
                models = {side: scaled_model(incumbent['models'][side], fit['weights'][side_index * 3:side_index * 3 + 3])
                          for side_index, side in enumerate(['home', 'away'])}
                _, training_p = native_probabilities(models, groups['fit'], features[train_indices], temporary, f'train-fit-{fit_index}')
                risks = training_risks(groups['fit'], training_p, identity_training_metrics)
                native_training_fits += 1
                if fit['trainingRisks'] is not None:
                    assert len(fit['trainingRisks']) == 10
                    for actual, recorded in zip(risks, fit['trainingRisks']):
                        assert actual['league'] == recorded['league'] and actual['metric'] == recorded['metric']
                        for key in ['identity', 'value', 'relativeRegret']:
                            assert math.isfinite(recorded[key])
                            errors['independentTrainingRiskMaximumError'] = max(errors['independentTrainingRiskMaximumError'], abs(actual[key] - recorded[key]))
                    values = solution_values(fit['weights'], fit['epigraph'], fit['ridge'], risks)
                    for key, value in values.items():
                        errors['independentSolutionValueMaximumError'] = max(errors['independentSolutionValueMaximumError'], abs(value - fit[key]))
                    errors['independentSolutionValueMaximumError'] = max(errors['independentSolutionValueMaximumError'],
                        abs(values['objective'] - fit['optimizer']['reportedObjective']))
            reasons = receipt_failures(fit, risks, checks)
            if reasons is None:
                assert fit['admissible'] is False and fit['failureReasons']
            else:
                assert fit['failureReasons'] == reasons
                assert fit['admissible'] is (not reasons)
            failures_checked.append({'ridge': fit['ridge'], 'nativeTrainingRisksRecomputed': risks is not None,
                                     'failureReasons': fit['failureReasons'], 'admissible': fit['admissible']})
            assert timestamp(selection['createdAt']) <= timestamp(fit['weightsFrozenAt']) <= timestamp(selection['decision']['frozenAt'])
            if not fit['admissible']:
                assert fit['models'] is None and fit['validationMetrics'] is None and fit['nativeIndependentParity'] is None
                recomputed_fits.append(fit)
                continue
            assert bounded_weights and risks is not None and reasons == []
            raw = {}
            native_outputs[fit_index] = {}
            for side_index, side in enumerate(['home', 'away']):
                metadata = fit['models'][side]
                file = (prepared / metadata['file']).resolve()
                assert file.is_relative_to(prepared) and digest(file) == metadata['sha256']
                hashes[file] = metadata['sha256']; model_inputs[str(file.relative_to(prepared))] = metadata['sha256']
                model = read(file)
                model_checks.setdefault(str(fit['ridge']), {})[side] = verify_scaling(incumbent['models'][side], model, fit['weights'][side_index * 3:side_index * 3 + 3])
                native = CatBoostRegressor().load_model(str(file), format='json')
                all_raw = np.asarray(native.predict(features, prediction_type='RawFormulaVal', thread_count=2))
                native_outputs[fit_index][side] = all_raw
                raw[side] = all_raw[validation_indices]
                difference = float(np.max(np.abs(all_raw - traverse_raw(model, features))))
                errors['nativeAllFeatureRawMaximumError'] = max(errors['nativeAllFeatureRawMaximumError'], difference)
                receipt = fit['nativeIndependentParity'][side]
                assert all(math.isfinite(value) and value <= 1e-12 for value in receipt.values())
                assert abs(receipt['candidateNativeMaximumError'] - difference) <= 1e-12
                assert np.array_equal(native.calc_leaf_indexes(features[train_indices], thread_count=2), original_routes[side])
            probabilities = np.asarray([joint_probabilities(row, np.exp(raw['home'][index]), np.exp(raw['away'][index]), .75, .8)[1]
                                        for index, row in enumerate(groups['validation'])])
            recomputed = metrics(groups['validation'], probabilities)
            errors['independentSelectionMetricMaximumError'] = max(errors['independentSelectionMetricMaximumError'], compare_metrics(recomputed, fit['validationMetrics']))
            recomputed_fits.append({**fit, 'validationMetrics': recomputed})
            for index, row in enumerate(groups['validation']):
                records = evidence[row['matchId']]['fits']
                found = [entry for entry in records if entry['fitIndex'] == fit_index]
                assert len(found) == 1 and found[0]['ridge'] == fit['ridge']
                expected = found[0]
                assert np.isfinite(expected['probabilities']).all()
                errors['independentSelectionProbabilityMaximumError'] = max(errors['independentSelectionProbabilityMaximumError'],
                    float(np.max(np.abs(probabilities[index] - expected['probabilities']))))
                errors['nativeSelectionRawMaximumError'] = max(errors['nativeSelectionRawMaximumError'],
                    *(abs(raw[side][index] - expected['raw'][side][0]) for side in ['home', 'away']))
        admissible_indices = [index for index, fit in enumerate(selection['fits']) if fit['admissible']]
        assert audit['preparedVariants'] == len(admissible_indices)
        for row in evidence.values():
            assert [fit['fitIndex'] for fit in row['fits']] == admissible_indices
    assert max(errors.values()) <= 1e-12
    selected = choose_fit(recomputed_fits, identity_validation_metrics)
    assert selected == choose_fit(selection['fits'], selection['identity']['validationMetrics'])
    decision = selection['decision']
    assert decision == audit['decision']
    assert decision['selectedFitIndex'] == selected and decision['acceptedNonIdentity'] is (selected is not None)
    assert decision['selectedRidge'] == (None if selected is None else selection['fits'][selected]['ridge'])
    assert timestamp(plan['createdAt']) < timestamp(selection['createdAt']) <= timestamp(decision['frozenAt']) <= timestamp(selection['completedAt'])
    assert {str(path.relative_to(prepared)) for path in (prepared / 'models').glob('*.json')} == set(model_inputs)
    if selected is None:
        assert not (prepared / 'artifact.json').exists() and not (prepared / 'parity.json').exists()
        assert audit['identitySelected'] is True and audit['calibrationConsumed'] is False and audit['diagnosticOutcomesScored'] is False
    else:
        verify_selected_artifact(incumbent, selection, audit, prepared, all_rows, by_id, original_raw_all,
                                 native_outputs[selected], hashes, plan)
    for file, expected in hashes.items():
        assert digest(file) == expected, file
    return {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'scriptHash': digest(__file__), 'planHash': PLAN_HASH,
            'selectionHash': hashes[prepared / 'selection.json'], 'auditHash': hashes[prepared / 'audit.json'],
            'catboostVersion': catboost_version, 'dependencyHashes': {str(file.relative_to(ROOT)): hashes[file] for file in dependencies},
            'modelInputHashes': model_inputs, 'modelChecks': model_checks, 'solutionChecks': failures_checked,
            'nativeTrainingRowsPerAttempt': 5293, 'nativeTrainingAttemptsChecked': native_training_fits,
            'nativeAllFeatureRowsPerAdmissibleRegressor': 6577, 'nativeSelectionRowsPerAdmissiblePair': 317,
            **errors, 'decision': decision, 'allFiveLeagueSelectionReproduced': True,
            'sameOriginalPartitionsAndPolicyExclusions': True, 'optimizerOptimalityVerified': False,
            'noModelFitsOrOptimizerCalls': True, 'incumbentAndPinnedSourcesUnchanged': True,
            'independentPredictiveEvidence': False, 'productionAdoptionEligible': False}


def verify_selected_artifact(incumbent, selection, audit, prepared, all_rows, by_id, original_raw, candidate_raw, hashes, plan):
    artifact_file, parity_file = prepared / 'artifact.json', prepared / 'parity.json'
    candidate, parity = read(artifact_file), read(parity_file)
    hashes[artifact_file], hashes[parity_file] = digest(artifact_file), digest(parity_file)
    assert hashes[artifact_file] == audit['artifactHash'] and hashes[parity_file] == audit['parityHash']
    assert audit['identitySelected'] is False and audit['calibrationConsumed'] is True
    selected = selection['decision']['selectedFitIndex']
    fit = selection['fits'][selected]
    assert candidate['parentVersion'] == incumbent['version'] and candidate['experimentPlanHash'] == PLAN_HASH
    assert candidate['trainerHash'] == hashes[HERE / 'prepare.py'] and candidate['parentTrainerHash'] == incumbent['trainerHash']
    assert candidate['diagnosticOnly'] is True and candidate['productionAdoptionEligible'] is False
    assert candidate['productionValidated'] is False and candidate['independentEvidence'] is False
    assert 'calibrationProfilesV2' not in candidate
    assert candidate['experimentIdentity']['selectionHash'] == hashes[prepared / 'selection.json']
    assert candidate['experimentIdentity']['minimaxScriptHash'] == hashes[HERE / 'minimax.py']
    assert candidate['experimentIdentity']['parentArtifactHash'] == plan['incumbentArtifactHash']
    assert candidate['experimentIdentity']['weights'] == fit['weights']
    assert candidate['experimentIdentity']['ridge'] == fit['ridge']
    assert candidate['hyperparameters'] == incumbent['hyperparameters'] | {'postprocessing': {'method': METHOD, 'ridge': fit['ridge'], 'weights': fit['weights']}}
    assert candidate['parameterAdaptation'] == {'method': METHOD, 'ridge': fit['ridge'], 'weights': fit['weights'],
        'fit': selection['fit'], 'objective': plan['intervention']['objective'], 'optimizer': fit['optimizer'],
        'trainingRisks': fit['trainingRisks'], 'epigraph': fit['epigraph'], 'penalizedObjective': fit['objective'],
        'worstRelativeRegret': fit['worstRelativeRegret'], 'weightsFrozenAt': fit['weightsFrozenAt'],
        'finalRefits': 0, 'source': 'backend/current-models/challenger.json', 'minimaxScriptHash': selection['minimaxScriptHash']}
    assert candidate['parameterSelection'] == {'method': METHOD, 'fit': selection['fit'], 'validation': selection['validation'],
        'testedRidges': [10., 1., .1, .01], 'selectedRidge': fit['ridge'], 'finalRefits': 0,
        'selectionHash': hashes[prepared / 'selection.json'], 'choiceFrozenAt': selection['decision']['frozenAt']}
    mutable = {'version', 'parentVersion', 'createdAt', 'trainerHash', 'parentTrainerHash', 'hyperparameters',
               'models', 'calibrationPredictions', 'calibrationProfilesV2', 'parameterAdaptation', 'parameterSelection',
               'experimentPlanHash', 'experimentIdentity', 'diagnosticOnly', 'productionAdoptionEligible',
               'productionValidated', 'independentEvidence', 'availability', 'status', 'selectionProtocol'}
    for key in set(candidate) | set(incumbent):
        if key not in mutable:
            assert candidate.get(key) == incumbent.get(key), key
    assert timestamp(selection['decision']['frozenAt']) <= timestamp(candidate['createdAt'])
    for side in ['home', 'away']:
        assert candidate['models'][side] == read(prepared / fit['models'][side]['file'])
    calibration = candidate['calibrationPredictions']
    assert len(calibration) == 358
    assert len({row['matchId'] for row in calibration}) == 358
    assert {row['matchId'] for row in calibration} == {row['matchId'] for row in incumbent['calibrationPredictions']}
    for old, new in zip(incumbent['calibrationPredictions'], calibration):
        assert {key: value for key, value in old.items() if key != 'matrixC'} == {key: value for key, value in new.items() if key != 'matrixC'}
        index = by_id[new['matchId']]
        assert timestamp(new['availableAt']) <= timestamp(candidate['validationThrough'])
        matrix, _ = joint_probabilities(all_rows[index], np.exp(candidate_raw['home'][index]), np.exp(candidate_raw['away'][index]), .75, .8)
        assert float(np.max(np.abs(matrix - new['matrixC']))) <= 1e-12
    assert parity['featureNames'] == incumbent['featureNames']
    assert len(parity['rows']) == len({row['matchId'] for row in parity['rows']}) == 6577
    assert {row['matchId'] for row in parity['rows']} == set(by_id)
    for row in parity['rows']:
        for side in ['home', 'away']:
            index = by_id[row['matchId']]
            assert abs(row['rawIncumbent'][side][0] - original_raw[side][index]) <= 1e-12
            assert abs(row['raw'][side][0] - candidate_raw[side][index]) <= 1e-12


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--prepared', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    assert not args.out.exists(), 'Exclusive new output required'
    result = verify(args.plan, args.prepared)
    with args.out.open('x', encoding='utf-8', newline='\n') as handle:
        json.dump(result, handle, indent=2, allow_nan=False); handle.write('\n')
    print(json.dumps(result))
