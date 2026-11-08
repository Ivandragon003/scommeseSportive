"""Independent HS-inspired model and selection verification; never fits models."""
from __future__ import annotations

import argparse
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
PLAN_HASH = 'f70c68205145454d95af140205fada013941a503ae838c2cf367ab205229441a'
METHOD = 'support-weighted-hierarchical-leaf-contribution-shrinkage-v1'
COMMON_FILE = HERE.parent / 'c-tree-l2-research/verify_selection.py'
SPEC = importlib.util.spec_from_file_location('hierarchical_selection_common_metrics', COMMON_FILE)
COMMON = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMMON)
read, digest, timestamp = COMMON.read, COMMON.digest, COMMON.timestamp
metrics, compare_metrics = COMMON.MATH.metrics, COMMON.MATH.compare_metrics
joint_probabilities = COMMON.MATH.MATH.joint_probabilities


def linear_operator(counts, strength):
    """Linear mixing weights from original conditional-support distributions.

    This constructs no node response means and imports no shrinkage implementation.
    Each output row is the root distribution plus its path's conditional changes.
    """
    counts = np.asarray(counts, dtype=float)
    size = len(counts)
    assert size > 0 and size & (size - 1) == 0 and size <= 256
    assert np.isfinite(counts).all() and (counts >= 0).all() and counts.sum() > 0
    assert math.isfinite(strength) and strength >= 0
    root = counts / counts.sum()
    operator = np.broadcast_to(root, (size, size)).copy()
    indices = np.arange(size)
    for leaf in range(size):
        parent_probability, parent_support = root.copy(), float(counts.sum())
        for bit in range(size.bit_length() - 1):
            mask = (1 << (bit + 1)) - 1
            selected = (indices & mask) == (leaf & mask)
            child_support = float(counts[selected].sum())
            child_probability = np.where(selected, counts, 0.) / child_support if child_support else parent_probability.copy()
            factor = parent_support / (parent_support + strength) if parent_support else 0.
            operator[leaf] += factor * (child_probability - parent_probability)
            parent_probability, parent_support = child_probability, child_support
    assert np.isfinite(operator).all() and float(operator.min()) >= -1e-12
    assert float(np.max(np.abs(operator.sum(axis=1) - 1))) < 1e-12
    assert float(np.max(np.abs(root @ operator - root))) < 1e-12
    return operator


def verify_model(original, edited, strength, expected_training_rows=5293):
    assert {key: value for key, value in original.items() if key != 'oblivious_trees'} == {
        key: value for key, value in edited.items() if key != 'oblivious_trees'}
    assert len(original['oblivious_trees']) == len(edited['oblivious_trees'])
    errors = {'maximumLeafFormulaError': 0., 'maximumWeightedTreeMeanError': 0.,
              'maximumOperatorRowSumError': 0., 'minimumOperatorWeight': 0.}
    changed, empty = 0, 0
    for old, new in zip(original['oblivious_trees'], edited['oblivious_trees']):
        assert {key: value for key, value in old.items() if key != 'leaf_values'} == {
            key: value for key, value in new.items() if key != 'leaf_values'}
        before, after = np.asarray(old['leaf_values']), np.asarray(new['leaf_values'])
        counts = np.asarray(old['leaf_weights'], dtype=float)
        assert before.shape == after.shape == counts.shape
        assert len(before) == 2 ** len(old.get('splits', []))
        assert np.isfinite(before).all() and np.isfinite(after).all()
        assert counts.sum() == expected_training_rows and np.equal(counts, np.floor(counts)).all()
        assert np.all(before[counts == 0] == 0)
        operator = linear_operator(counts, strength)
        expected = operator @ before
        errors['maximumLeafFormulaError'] = max(errors['maximumLeafFormulaError'], float(np.max(np.abs(after - expected))))
        errors['maximumWeightedTreeMeanError'] = max(errors['maximumWeightedTreeMeanError'],
            abs(float(np.average(before, weights=counts)) - float(np.average(after, weights=counts))))
        errors['maximumOperatorRowSumError'] = max(errors['maximumOperatorRowSumError'], float(np.max(np.abs(operator.sum(axis=1) - 1))))
        errors['minimumOperatorWeight'] = min(errors['minimumOperatorWeight'], float(operator.min()))
        changed += int(np.sum(after != before)); empty += int(np.sum(counts == 0))
    assert errors['maximumLeafFormulaError'] <= 1e-12 and errors['maximumWeightedTreeMeanError'] <= 1e-12
    return {'lambda': strength, 'treeCount': len(original['oblivious_trees']), 'changedLeafCount': changed,
            'originalEmptyLeafCount': empty, 'onlyLeafValuesChanged': True, **errors}


def traverse_raw(model, features):
    """Separate float32 split traversal, independent of the preparation code."""
    features = np.asarray(features, dtype=np.float32)
    assert features.ndim == 2 and np.isfinite(features).all()
    mapping = {feature['feature_index']: feature['flat_feature_index'] for feature in model['features_info']['float_features']}
    sums = np.zeros(len(features))
    for tree in model['oblivious_trees']:
        route = np.zeros(len(features), dtype=np.int64)
        for bit, split in enumerate(tree.get('splits', [])):
            assert split['split_type'] == 'FloatFeature'
            route |= np.asarray(features[:, mapping[split['float_feature_index']]] > split['border'], dtype=np.int64) << bit
        sums += np.asarray(tree['leaf_values'])[route]
    scale, bias = model['scale_and_bias']
    assert len(bias) == 1
    return sums * scale + bias[0]


def verify_node_receipts(original, receipt):
    assert receipt['onlyLeafValuesChanged'] is True and receipt['allOtherModelMetadataExactlyUnchanged'] is True
    assert receipt['treeCount'] == len(receipt['trees']) == len(original['oblivious_trees'])
    maximum_error = 0.
    for tree_index, (tree, evidence) in enumerate(zip(original['oblivious_trees'], receipt['trees'])):
        assert evidence['tree'] == tree_index
        values, counts = np.asarray(tree['leaf_values']), np.asarray(tree['leaf_weights'])
        indices = np.arange(len(values))
        assert len(evidence['nodeLevels']) == len(tree['splits']) + 1
        previous_means = None
        for level, nodes in enumerate(evidence['nodeLevels']):
            assert len(nodes) == 1 << level
            means = []
            for prefix, node in enumerate(nodes):
                chosen = (indices & ((1 << level) - 1)) == prefix
                support = float(counts[chosen].sum())
                mean = float(np.average(values[chosen], weights=counts[chosen])) if support else previous_means[prefix & ((1 << (level - 1)) - 1)]
                assert node['prefix'] == prefix and node['support'] == support
                maximum_error = max(maximum_error, abs(node['mean'] - mean))
                means.append(mean)
            previous_means = means
    assert maximum_error <= 1e-12
    return maximum_error


def choose_fit(fits, identity):
    leagues = set(identity['byLeague'])
    assert len(leagues) == 5
    eligible = []
    for index, fit in enumerate(fits):
        actual = fit['validationMetrics']
        assert set(actual['byLeague']) == leagues
        pairs = [(actual, identity)] + [(actual['byLeague'][league], identity['byLeague'][league]) for league in sorted(leagues)]
        if all(reference[metric] - candidate[metric] > 1e-12
               for candidate, reference in pairs for metric in ['logLoss', 'brier']):
            eligible.append(index)
    if not eligible:
        return None
    minimum = min(fits[index]['validationMetrics']['logLoss'] for index in eligible)
    return min((index for index in eligible if fits[index]['validationMetrics']['logLoss'] - minimum <= 1e-12),
               key=lambda index: fits[index]['lambda'])


def verify(plan_file, prepared):
    plan_file, prepared = Path(plan_file).resolve(), Path(prepared).resolve()
    plan, selection, audit = read(plan_file), read(prepared / 'selection.json'), read(prepared / 'audit.json')
    assert catboost_version == plan['intervention']['catboostVersion'] == '1.2.8'
    assert digest(plan_file) == PLAN_HASH == selection['planHash'] == audit['planHash']
    assert plan['protocol'] == 'c-tree-hierarchical-shrinkage-research-v1' and plan['intervention']['method'] == METHOD
    assert plan['intervention']['lambdas'] == [1., 10., 100.] and plan['intervention']['newTreeFits'] == 0
    hashes = {plan_file: PLAN_HASH, prepared / 'selection.json': digest(prepared / 'selection.json'),
              prepared / 'audit.json': digest(prepared / 'audit.json'), HERE / 'prepare.py': digest(HERE / 'prepare.py'),
              HERE / 'shrink.py': digest(HERE / 'shrink.py')}
    dependencies = [COMMON_FILE, HERE.parent / 'c-tree-weight-research/verify_selection.py', HERE.parent / 'c-tree-sample-projection/verify.py']
    for dependency in dependencies:
        hashes[dependency] = digest(dependency)
    assert selection['scriptHash'] == hashes[HERE / 'prepare.py']
    assert selection['shrinkScriptHash'] == hashes[HERE / 'shrink.py']
    assert audit['scriptHash'] == selection['scriptHash'] and audit['shrinkScriptHash'] == selection['shrinkScriptHash']
    assert selection['sourceHashes'] == audit['sourceHashes'] == plan['sourceHashes']
    assert audit['selectionHash'] == hashes[prepared / 'selection.json']
    for file, expected in plan['sourceHashes'].items():
        hashes[ROOT / file] = expected
    for file, expected in hashes.items():
        assert digest(file) == expected, file
    incumbent_file = ROOT / 'backend/current-models/challenger.json'
    incumbent = read(incumbent_file)
    assert incumbent['version'] == plan['incumbentVersion'] == 'C-75fd74eb875e9d0e'
    assert digest(incumbent_file) == plan['incumbentArtifactHash']
    assert incumbent['weight'] == .75 and incumbent['temperature'] == .8 and len(incumbent['featureNames']) == 40
    assert incumbent['trainingSplit'] == plan['trainingSplit']
    assert selection['diagnosticOnly'] is True and selection['productionAdoptionEligible'] is False
    assert audit['controlFits'] == audit['candidateFits'] == audit['newTreeFits'] == 0
    assert audit['preparedVariants'] == 3 and audit['nodeStatisticsFromOriginalValuesAndSupportsOnly'] is True
    dataset = read(ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json')
    assert dataset['dataQualityPolicyHash'] == incumbent['dataQualityPolicyHash'] and dataset['dataQualityBaselineClean'] is True
    all_rows = sorted(dataset['rows'], key=lambda row: (timestamp(row['forecastAt']), row['matchId']))
    assert len(all_rows) == len({row['matchId'] for row in all_rows}) == 6577
    groups = {}
    split = incumbent['trainingSplit']
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
    assert set(selection['fit']['matchIds']).isdisjoint(selection['validation']['matchIds'])
    protected = set(read(ROOT / 'backend/src/research/original-holdout-policy.json')['protectedOriginalFinalMatchIds'])
    quarantined = {entry['matchId'] for entry in read(ROOT / 'backend/src/research/challenger-data-quarantine.json')['entries']}
    assert not ((set(selection['fit']['matchIds']) | set(selection['validation']['matchIds'])) & (protected | quarantined))
    calibration_ids = {row['matchId'] for row in incumbent['calibrationPredictions']}
    assert calibration_ids.isdisjoint(selection['fit']['matchIds']) and calibration_ids.isdisjoint(selection['validation']['matchIds'])
    feature_indices = [dataset['featureNames'].index(name) for name in incumbent['featureNames']]
    features = np.asarray([[row['features'][index] for index in feature_indices] for row in all_rows])
    by_id = {row['matchId']: index for index, row in enumerate(all_rows)}
    train_indices = [by_id[row['matchId']] for row in groups['fit']]
    validation_indices = [by_id[row['matchId']] for row in groups['validation']]
    evidence = {row['matchId']: row for row in selection['validationRows']}
    assert len(evidence) == len(selection['validationRows']) == 317 and set(evidence) == set(selection['validation']['matchIds'])
    assert [fit['lambda'] for fit in selection['fits']] == [1., 10., 100.]
    assert [entry['lambda'] for entry in audit['variantAudits']] == [1., 10., 100.]
    for index, fit in enumerate(selection['fits']):
        assert audit['variantNativeIndependentParity'][index] == fit['nativeIndependentParity']
    for side in ['home', 'away']:
        assert audit['originalSupport'][side]['allLeafSupportsMatch'] is True
        assert audit['originalSupport'][side]['trainingLeafCounts'] == [tree['leaf_weights'] for tree in incumbent['models'][side]['oblivious_trees']]
    errors = {'nativeIndependentRawMaximumError': 0., 'nativeRecordedRawMaximumError': 0.,
              'independentProbabilityMaximumError': 0., 'independentMetricMaximumError': 0.}
    formula_checks, model_inputs, original_routes, original_independent_errors, native_outputs = {}, {}, {}, {}, {}
    recomputed_fits = []
    native_support_rows = 0
    original_validation_metrics = None
    with tempfile.TemporaryDirectory(prefix='c-hierarchical-independent-verification-') as temporary:
        for record_index, record in enumerate([selection['identity']] + selection['fits']):
            raw = {}
            native_outputs[record_index] = {}
            for side in ['home', 'away']:
                original = incumbent['models'][side]
                if record_index == 0:
                    file = Path(temporary) / f'original-{side}.json'
                    file.write_text(json.dumps(original), encoding='utf-8')
                    model = original
                else:
                    metadata = record['models'][side]
                    file = (prepared / metadata['file']).resolve()
                    assert file.is_relative_to(prepared)
                    assert digest(file) == metadata['sha256']
                    hashes[file] = metadata['sha256']
                    model = read(file)
                    assert len(model['oblivious_trees']) == 120
                    checks = verify_model(original, model, record['lambda'])
                    receipt = audit['variantAudits'][record_index - 1]['models'][side]
                    assert receipt['lambda'] == record['lambda']
                    checks['maximumRecordedNodeMeanError'] = verify_node_receipts(original, receipt)
                    formula_checks.setdefault(str(record['lambda']), {})[side] = checks
                    model_inputs[str(file.relative_to(prepared))] = metadata['sha256']
                native = CatBoostRegressor().load_model(str(file), format='json')
                native_all = np.asarray(native.predict(features, prediction_type='RawFormulaVal', thread_count=2))
                independent = traverse_raw(model, features)
                difference = float(np.max(np.abs(native_all - independent)))
                errors['nativeIndependentRawMaximumError'] = max(errors['nativeIndependentRawMaximumError'], difference)
                native_outputs[record_index][side] = native_all
                if record_index == 0:
                    original_independent_errors[side] = difference
                if record_index > 0 and 'nativeIndependentParity' in record:
                    receipt = record['nativeIndependentParity'][side]
                    assert all(math.isfinite(value) and value <= 1e-12 for value in receipt.values())
                    if 'candidateNativeMaximumError' in receipt:
                        assert abs(receipt['candidateNativeMaximumError'] - difference) <= 1e-12
                    if 'incumbentNativeMaximumError' in receipt:
                        assert abs(receipt['incumbentNativeMaximumError'] - original_independent_errors[side]) <= 1e-12
                raw[side] = native_all[validation_indices]
                routes = native.calc_leaf_indexes(features[train_indices], thread_count=2)
                if record_index == 0:
                    original_routes[side] = routes
                else:
                    assert np.array_equal(routes, original_routes[side]), 'Routing changed after leaf-only edit'
                for index, tree in enumerate(model['oblivious_trees']):
                    counts = np.bincount(routes[:, index], minlength=len(tree['leaf_values']))
                    assert np.array_equal(counts, tree['leaf_weights'])
                native_support_rows += len(train_indices)
            probabilities = np.asarray([joint_probabilities(row, np.exp(raw['home'][index]), np.exp(raw['away'][index]), .75, .8)[1]
                                        for index, row in enumerate(groups['validation'])])
            recomputed = metrics(groups['validation'], probabilities)
            errors['independentMetricMaximumError'] = max(errors['independentMetricMaximumError'], compare_metrics(recomputed, record['validationMetrics']))
            if record_index == 0:
                original_validation_metrics = recomputed
            else:
                recomputed_fits.append({**record, 'validationMetrics': recomputed})
            for index, row in enumerate(groups['validation']):
                observed = evidence[row['matchId']]
                assert observed['actualClass'] == (0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1)
                assert observed['competition'] == row['competition']
                if record_index == 0:
                    expected_raw, expected_probabilities = observed['identityRaw'], observed['identity']
                else:
                    fitted = observed['fits'][record_index - 1]
                    assert fitted['lambda'] == record['lambda']
                    expected_raw, expected_probabilities = fitted['raw'], fitted['probabilities']
                assert len(expected_probabilities) == 3 and np.isfinite(expected_probabilities).all()
                assert all(len(expected_raw[side]) == 1 and np.isfinite(expected_raw[side]).all() for side in ['home', 'away'])
                errors['nativeRecordedRawMaximumError'] = max(errors['nativeRecordedRawMaximumError'],
                    *(abs(raw[side][index] - expected_raw[side][0]) for side in ['home', 'away']))
                errors['independentProbabilityMaximumError'] = max(errors['independentProbabilityMaximumError'],
                    float(np.max(np.abs(probabilities[index] - expected_probabilities))))
    assert max(errors.values()) <= 1e-12
    selected = choose_fit(recomputed_fits, original_validation_metrics)
    assert selected == choose_fit(selection['fits'], selection['identity']['validationMetrics'])
    decision = selection['decision']
    assert decision == audit['decision']
    assert decision['acceptedNonIdentity'] is (selected is not None) and decision['selectedFitIndex'] == selected
    assert decision['selectedLambda'] == (None if selected is None else selection['fits'][selected]['lambda'])
    assert timestamp(plan['createdAt']) < timestamp(selection['createdAt']) <= timestamp(decision['frozenAt']) <= timestamp(selection['completedAt'])
    if selected is None:
        assert not (prepared / 'artifact.json').exists() and not (prepared / 'parity.json').exists()
        assert audit['identitySelected'] is True and audit['calibrationConsumed'] is False and audit['diagnosticOutcomesScored'] is False
    else:
        file = prepared / 'artifact.json'
        candidate = read(file)
        hashes[file] = digest(file)
        assert audit['artifactHash'] == hashes[file]
        assert audit['identitySelected'] is False and audit['calibrationConsumed'] is True
        assert candidate['trainedThrough'] == incumbent['trainedThrough'] and candidate['validationThrough'] == incumbent['validationThrough']
        assert candidate['trainingSplit'] == incumbent['trainingSplit']
        chosen_lambda = decision['selectedLambda']
        assert candidate['hyperparameters'] == incumbent['hyperparameters'] | {'postprocessing': {'method': METHOD, 'lambda': chosen_lambda}}
        assert candidate['parentTrainerHash'] == incumbent['trainerHash'] and candidate['trainerHash'] == digest(HERE / 'prepare.py')
        assert candidate['parentVersion'] == incumbent['version'] and candidate['experimentPlanHash'] == PLAN_HASH
        assert candidate['diagnosticOnly'] is True and candidate['productionAdoptionEligible'] is False
        assert candidate['productionValidated'] is False and candidate['independentEvidence'] is False
        assert 'calibrationProfilesV2' not in candidate
        assert candidate['experimentIdentity']['selectionHash'] == hashes[prepared / 'selection.json']
        assert candidate['experimentIdentity']['shrinkScriptHash'] == hashes[HERE / 'shrink.py']
        assert candidate['experimentIdentity']['scriptHash'] == hashes[HERE / 'prepare.py']
        assert candidate['experimentIdentity']['parentArtifactHash'] == plan['incumbentArtifactHash']
        mutable = {'version', 'parentVersion', 'createdAt', 'trainerHash', 'parentTrainerHash', 'hyperparameters',
                   'models', 'calibrationPredictions', 'calibrationProfilesV2', 'parameterAdaptation', 'parameterSelection',
                   'experimentPlanHash', 'experimentIdentity', 'diagnosticOnly', 'productionAdoptionEligible',
                   'productionValidated', 'independentEvidence', 'availability', 'status', 'selectionProtocol'}
        for key in set(candidate) | set(incumbent):
            if key not in mutable:
                assert candidate.get(key) == incumbent.get(key), key
        assert candidate['parameterAdaptation'] == {'method': METHOD, 'lambda': chosen_lambda,
            'formula': plan['intervention']['formula'], 'source': 'backend/current-models/challenger.json',
            'shrinkScriptHash': selection['shrinkScriptHash']}
        assert candidate['parameterSelection'] == {'method': METHOD, 'fit': selection['fit'], 'validation': selection['validation'],
            'testedLambdas': [1., 10., 100.], 'selectedLambda': chosen_lambda,
            'selectionHash': hashes[prepared / 'selection.json'], 'choiceFrozenAt': decision['frozenAt']}
        for side in ['home', 'away']:
            assert candidate['models'][side] == read(prepared / selection['fits'][selected]['models'][side]['file'])
        calibration = candidate['calibrationPredictions']
        assert len(calibration) == 358
        assert {row['matchId'] for row in calibration} == calibration_ids
        for old, new in zip(incumbent['calibrationPredictions'], calibration):
            assert {key: value for key, value in old.items() if key != 'matrixC'} == {key: value for key, value in new.items() if key != 'matrixC'}
            source = all_rows[by_id[new['matchId']]]
            matrix, _ = joint_probabilities(source,
                np.exp(native_outputs[selected + 1]['home'][by_id[new['matchId']]]),
                np.exp(native_outputs[selected + 1]['away'][by_id[new['matchId']]]), .75, .8)
            assert float(np.max(np.abs(matrix - new['matrixC']))) <= 1e-12
        parity_file = prepared / 'parity.json'
        parity = read(parity_file)
        hashes[parity_file] = digest(parity_file)
        assert audit['parityHash'] == hashes[parity_file]
        assert parity['featureNames'] == incumbent['featureNames']
        assert len(parity['rows']) == len({row['matchId'] for row in parity['rows']}) == 6577
        assert {row['matchId'] for row in parity['rows']} == set(by_id)
        for row in parity['rows']:
            for side in ['home', 'away']:
                assert abs(row['rawIncumbent'][side][0] - native_outputs[0][side][by_id[row['matchId']]]) <= 1e-12
                assert abs(row['raw'][side][0] - native_outputs[selected + 1][side][by_id[row['matchId']]]) <= 1e-12
        assert timestamp(decision['frozenAt']) <= timestamp(candidate['createdAt'])
    for file, expected in hashes.items():
        assert digest(file) == expected, file
    return {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'scriptHash': digest(__file__), 'planHash': PLAN_HASH,
            'selectionHash': hashes[prepared / 'selection.json'], 'auditHash': hashes[prepared / 'audit.json'],
            'catboostVersion': catboost_version, 'dependencyHashes': {str(path.relative_to(ROOT)): hashes[path] for path in dependencies},
            'modelInputHashes': model_inputs, 'formulaChecks': formula_checks,
            'nativeAllFeatureRowsPerRegressor': 6577, 'nativeTrainingSupportRowsAcrossEightRegressors': native_support_rows,
            'nativeSelectionRowsPerPair': 317, **errors, 'allFiveLeagueSelectionReproduced': True,
            'decision': decision, 'sameOriginalTrainingSelectionAndProtectedPartitions': True,
            'noModelFitsOrOptimizerCalls': True, 'incumbentAndPinnedSourcesUnchanged': True,
            'independentPredictiveEvidence': False, 'productionAdoptionEligible': False}


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
