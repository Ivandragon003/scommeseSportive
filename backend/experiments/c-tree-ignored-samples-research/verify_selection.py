"""Verify one ignored-feature native refit and its frozen development screen; no fitting."""
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
PLAN_HASH = '9c3243479fc915a8ec10425a3445c1bf33d3ada8a93b0af838d03677f5b98f3f'
METHOD = 'ignored-sample-features-native-refit-five-league-screen-v1'
VARIANT = 'ignored_samples'
IGNORED_NAMES = ['home_sample', 'away_sample']
IGNORED_INDICES = [1, 17]
COMMON_FILE = HERE.parent / 'c-tree-hierarchical-research/verify_selection.py'
SPEC = importlib.util.spec_from_file_location('ignored_samples_independent_common', COMMON_FILE)
COMMON = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMMON)
read, digest, timestamp = COMMON.read, COMMON.digest, COMMON.timestamp
metrics, compare_metrics = COMMON.metrics, COMMON.compare_metrics
joint_probabilities, traverse_raw = COMMON.joint_probabilities, COMMON.traverse_raw
L2 = COMMON.COMMON


def ignored_parameters(original, candidate):
    adjusted = copy.deepcopy(candidate)
    old, new = original['model_info']['params'], adjusted['model_info']['params']
    assert old['boosting_options']['boosting_type'] == new['boosting_options']['boosting_type'] == 'Plain'
    assert old['data_processing_options']['ignored_features'] == []
    assert new['data_processing_options']['ignored_features'] == IGNORED_INDICES
    assert 'ignored_features' not in old['flat_params']
    explicit = new['flat_params'].pop('ignored_features')
    assert explicit in [IGNORED_NAMES, IGNORED_INDICES], 'Unexpected ignored feature names or indices'
    new['data_processing_options']['ignored_features'] = []
    # This pinned helper removes only explicit/default L2=3 and the documented
    # inactive categorical uint64 export pair; every other parameter stays exact.
    L2.parameters(original, adjusted, 3.)


def ignored_mapping(model, names):
    assert len(names) == 40 and [names[index] for index in IGNORED_INDICES] == IGNORED_NAMES
    information = model['features_info']
    assert not any(information.get(kind) for kind in ['categorical_features', 'text_features', 'embedding_features'])
    mapping, flat = {}, set()
    for feature in information['float_features']:
        index, location = feature['feature_index'], feature['flat_feature_index']
        assert type(index) is int and type(location) is int and index >= 0 and 0 <= location < 40
        assert index not in mapping and location not in flat
        assert feature['feature_id'] == names[location]
        mapping[index] = location; flat.add(location)
    assert len(model['oblivious_trees']) == 120
    splits = 0
    for tree in model['oblivious_trees']:
        assert len(tree.get('splits', [])) <= 5
        assert len(tree['leaf_values']) == 2 ** len(tree.get('splits', []))
        assert np.isfinite(tree['leaf_values']).all()
        for split in tree.get('splits', []):
            assert split['split_type'] == 'FloatFeature' and math.isfinite(split['border'])
            assert split['float_feature_index'] in mapping
            assert mapping[split['float_feature_index']] not in IGNORED_INDICES, 'Ignored feature used by a split'
            splits += 1
    return {'floatFeatureMapping': mapping, 'mappedFloatFeatures': len(mapping), 'splitCount': splits,
            'inputSchemaSize': 40, 'noIgnoredFeatureSplits': True}


def perturbations(features):
    for label, indices in [('home', [1]), ('away', [17]), ('both', [1, 17])]:
        for delta in [-1000., 1000.]:
            changed = features.copy()
            changed[:, indices] += delta
            other = [index for index in range(features.shape[1]) if index not in indices]
            assert np.array_equal(changed[:, other], features[:, other])
            yield f'{label}_{delta:g}', changed


def accepts(candidate, identity):
    assert len(identity['byLeague']) == 5 and set(candidate['byLeague']) == set(identity['byLeague'])
    pairs = [(candidate, identity)] + [(candidate['byLeague'][league], identity['byLeague'][league]) for league in sorted(identity['byLeague'])]
    return all(reference[metric] - actual[metric] > 1e-12 for actual, reference in pairs for metric in ['logLoss', 'brier'])


SOURCE_BRIDGE = r"""
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),{createHash}=require('node:crypto');
const root=process.argv[1],payload=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const backend=path.join(root,'backend'),ts=require(path.join(backend,'node_modules/typescript'));
const sourceFile=path.join(backend,'src/research/CatBoostModel.ts');
const source=fs.readFileSync(sourceFile,'utf8');
const options={target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true};
const compiled=ts.transpileModule(source,{compilerOptions:options,reportDiagnostics:true,fileName:sourceFile});
if((compiled.diagnostics||[]).some(d=>d.category===ts.DiagnosticCategory.Error))throw Error('TypeScript source compilation failed');
const filename=path.join(backend,'dist/research/CatBoostModel.js'),mod={exports:{}};
vm.runInThisContext('(function(require,module,exports,__filename,__dirname){\n'+compiled.outputText+'\n})',{filename:filename+'.independent-source-verification'})(createRequire(filename),mod,mod.exports,filename,path.dirname(filename));
const predict=mod.exports.predictCatBoostJson;
const sha=value=>createHash('sha256').update(value).digest('hex');
const baselineBefore=sha(JSON.stringify(payload.rows.map(row=>row.baselineMatrix)));
const buildParity=Object.fromEntries(Object.keys(payload.pinnedSourceHashes).filter(f=>f.endsWith('.ts')).map(f=>{
const expected=ts.transpileModule(fs.readFileSync(path.join(root,f),'utf8'),{compilerOptions:options}).outputText.replace(/\r\n/g,'\n').trim();
const built=fs.readFileSync(path.join(root,f.replace('/src/','/dist/').replace(/\.ts$/,'.js')),'utf8').replace(/\r\n/g,'\n').trim();return [f,expected===built];}));
const rows=payload.rows.map(row=>{
const output={matchId:row.matchId};
for(const name of ['identity','control','candidate'])output[name]=Object.fromEntries(['home','away'].map(side=>[side,predict(payload.models[name][side],row.features)]));
output.perturbations={};
for(const [label,indices] of [['home',[1]],['away',[17]],['both',[1,17]]])for(const delta of [-1000,1000]){
const changed=row.features.slice();for(const index of indices)changed[index]+=delta;
output.perturbations[label+'_'+delta]=Object.fromEntries(['home','away'].map(side=>[side,predict(payload.models.candidate[side],changed)]));}
return output;});
process.stdout.write(JSON.stringify({sourceHash:sha(source),compiledHash:sha(compiled.outputText),buildParity,
baselineHashBefore:baselineBefore,baselineHashAfter:sha(JSON.stringify(payload.rows.map(row=>row.baselineMatrix))),rows}));
"""


def source_predictions(models, rows, features, source_hashes, directory):
    payload = {'models': models, 'pinnedSourceHashes': source_hashes,
               'rows': [{'matchId': row['matchId'], 'features': feature.tolist(), 'baselineMatrix': row['baselineMatrix']}
                        for row, feature in zip(rows, features)]}
    file = Path(directory) / 'source-inference-input.json'
    file.write_text(json.dumps(payload, allow_nan=False), encoding='utf-8')
    before = digest(file)
    result = subprocess.run(['node', '-e', SOURCE_BRIDGE, str(ROOT), str(file)], cwd=ROOT,
                            capture_output=True, text=True, check=True)
    assert digest(file) == before
    receipt = json.loads(result.stdout)
    assert receipt['sourceHash'] == source_hashes['backend/src/research/CatBoostModel.ts']
    assert receipt['baselineHashBefore'] == receipt['baselineHashAfter']
    assert all(receipt['buildParity'].values())
    receipt['inputHash'] = before
    receipt['outputHash'] = hashlib.sha256(result.stdout.encode()).hexdigest()
    return receipt


def verify(plan_file, prepared):
    plan_file, prepared = Path(plan_file).resolve(), Path(prepared).resolve()
    plan, selection, audit = read(plan_file), read(prepared / 'selection.json'), read(prepared / 'audit.json')
    assert digest(plan_file) == PLAN_HASH == selection['planHash'] == audit['planHash']
    assert plan['protocol'] == 'c-tree-ignored-samples-research-v1' and plan['intervention']['method'] == METHOD
    assert catboost_version == plan['intervention']['catboostVersion'] == '1.2.8'
    hashes = {plan_file: PLAN_HASH, prepared / 'selection.json': digest(prepared / 'selection.json'),
              prepared / 'audit.json': digest(prepared / 'audit.json'), HERE / 'prepare.py': digest(HERE / 'prepare.py')}
    dependencies = [COMMON_FILE, HERE.parent / 'c-tree-l2-research/verify_selection.py',
                    HERE.parent / 'c-tree-weight-research/verify_selection.py', HERE.parent / 'c-tree-sample-projection/verify.py']
    for dependency in dependencies:
        hashes[dependency] = digest(dependency)
    assert selection['scriptHash'] == audit['scriptHash'] == hashes[HERE / 'prepare.py']
    assert selection['sourceHashes'] == audit['sourceHashes'] == plan['sourceHashes']
    assert audit['selectionHash'] == hashes[prepared / 'selection.json']
    for file, expected in plan['sourceHashes'].items():
        hashes[ROOT / file] = expected
    for file, expected in hashes.items():
        assert digest(file) == expected, file
    original_file = ROOT / 'backend/current-models/challenger.json'
    original = read(original_file)
    assert original['version'] == plan['incumbentVersion'] == 'C-75fd74eb875e9d0e'
    assert digest(original_file) == plan['incumbentArtifactHash']
    assert original['weight'] == .75 and original['temperature'] == .8 and len(original['featureNames']) == 40
    assert [original['featureNames'][index] for index in IGNORED_INDICES] == IGNORED_NAMES
    assert plan['intervention']['ignoredFeatures'] == IGNORED_NAMES and plan['intervention']['ignoredFlatIndices'] == IGNORED_INDICES
    assert plan['intervention']['recipe']['ignored_features'] == IGNORED_NAMES
    assert original['trainingSplit'] == plan['trainingSplit']
    assert audit['controlFits'] == 0 and audit['candidateFits'] == 2 and audit['reusedControlModels'] == 2
    assert audit['trainingLabelsOnlyOriginal5293'] is True and audit['noEvalSetOrOffset'] is True
    assert audit['control'] == selection['control']
    assert selection['diagnosticOnly'] is True and selection['productionAdoptionEligible'] is False
    assert len(selection['fits']) == 1 and selection['fits'][0]['variant'] == VARIANT
    assert selection['identity']['variant'] == selection['control']['variant'] == 'Plain'
    assert selection['control']['sourceSelection'] == plan['reproductionControl']['source']
    control_selection_file = ROOT / plan['reproductionControl']['source']
    control_selection = read(control_selection_file)
    dataset = read(ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json')
    assert dataset['dataQualityPolicyHash'] == original['dataQualityPolicyHash'] and dataset['dataQualityBaselineClean'] is True
    rows = sorted(dataset['rows'], key=lambda row: (timestamp(row['forecastAt']), row['matchId']))
    assert len(rows) == len({row['matchId'] for row in rows}) == 6577
    split, groups = original['trainingSplit'], {}
    for name, part, following in [('fit', 'train', 'selection'), ('validation', 'selection', 'calibration')]:
        group = [row for row in rows if timestamp(split[part]['from']) <= timestamp(row['forecastAt']) <= timestamp(split[part]['to'])
                 and timestamp(row['availableAt']) < timestamp(split[following]['from'])]
        ids = [row['matchId'] for row in group]
        manifest = selection[name]
        assert manifest == audit[name] and manifest['n'] == len(ids) == split[part]['n']
        assert manifest['matchIds'] == ids
        assert manifest['matchIdsHash'] == split[part]['matchIdsHash'] == hashlib.sha256('\n'.join(sorted(ids)).encode()).hexdigest()
        assert manifest['orderedMatchIdsHash'] == hashlib.sha256('\n'.join(ids).encode()).hexdigest()
        assert manifest['availableThrough'] == max(row['availableAt'] for row in group) == split[part]['availableThrough']
        assert all(timestamp(row['maxTrainingAvailableAt']) <= timestamp(row['forecastAt']) < timestamp(row['kickoffAt']) for row in group)
        groups[name] = group
    protected = set(read(ROOT / 'backend/src/research/original-holdout-policy.json')['protectedOriginalFinalMatchIds'])
    quarantined = {entry['matchId'] for entry in read(ROOT / 'backend/src/research/challenger-data-quarantine.json')['entries']}
    fit_ids, validation_ids = set(selection['fit']['matchIds']), set(selection['validation']['matchIds'])
    assert fit_ids.isdisjoint(validation_ids) and not ((fit_ids | validation_ids) & (protected | quarantined))
    assert {row['matchId'] for row in original['calibrationPredictions']}.isdisjoint(fit_ids | validation_ids)
    locations = [dataset['featureNames'].index(name) for name in original['featureNames']]
    features = np.asarray([[row['features'][index] for index in locations] for row in rows])
    by_id = {row['matchId']: index for index, row in enumerate(rows)}
    train_indices = [by_id[row['matchId']] for row in groups['fit']]
    validation_indices = [by_id[row['matchId']] for row in groups['validation']]
    evidence = {row['matchId']: row for row in selection['validationRows']}
    assert len(evidence) == len(selection['validationRows']) == 317 and set(evidence) == validation_ids
    models = {'identity': original['models'], 'control': {}, 'candidate': {}}
    files = {'identity': {}, 'control': {}, 'candidate': {}}
    for side in ['home', 'away']:
        for family, record, base in [('control', selection['control'], ROOT), ('candidate', selection['fits'][0], prepared)]:
            metadata = record['models'][side]
            file = (base / metadata['file']).resolve()
            assert file.is_relative_to(base) and digest(file) == metadata['sha256']
            if family == 'control':
                source = control_selection['control']['models'][side]
                assert file == (control_selection_file.parent / source['file']).resolve()
                assert metadata['sha256'] == source['sha256'] == plan['sourceHashes'][file.relative_to(ROOT).as_posix()]
            models[family][side], files[family][side] = read(file), file
            hashes[file] = metadata['sha256']
    mapping_checks, control_checks = {}, {}
    for side in ['home', 'away']:
        ignored_parameters(original['models'][side], models['candidate'][side])
        mapping_checks[side] = ignored_mapping(models['candidate'][side], original['featureNames'])
        L2.parameters(original['models'][side], models['control'][side], 3.)
        old, control = original['models'][side], models['control'][side]
        assert len(old['oblivious_trees']) == len(control['oblivious_trees']) == 120
        assert {key: value for key, value in old.items() if key not in ['model_info', 'oblivious_trees']} == {
            key: value for key, value in control.items() if key not in ['model_info', 'oblivious_trees']}
        leaf_error = 0.
        for before, after in zip(old['oblivious_trees'], control['oblivious_trees']):
            assert {key: value for key, value in before.items() if key != 'leaf_values'} == {key: value for key, value in after.items() if key != 'leaf_values'}
            leaf_error = max(leaf_error, float(np.max(np.abs(np.asarray(before['leaf_values']) - after['leaf_values']))))
        assert leaf_error <= 1e-12
        control_checks[side] = {'leafMaximumError': leaf_error}
    raw_all, native_models, support_checks, perturbation_checks = {}, {}, {}, {}
    errors = {'nativePythonMaximumError': 0., 'nativeSourceTypeScriptMaximumError': 0., 'controlNativeMaximumError': 0.,
              'ignoredNativeMaximumDifference': 0., 'ignoredSourceTypeScriptMaximumDifference': 0.,
              'selectionRawMaximumError': 0., 'selectionProbabilityMaximumError': 0., 'selectionMetricsMaximumError': 0.}
    with tempfile.TemporaryDirectory(prefix='ignored-samples-independent-verification-') as temporary:
        for family in ['identity', 'control', 'candidate']:
            raw_all[family], native_models[family] = {}, {}
            for side in ['home', 'away']:
                file = files[family].get(side)
                if file is None:
                    file = Path(temporary) / f'original-{side}.json'
                    file.write_text(json.dumps(models[family][side]), encoding='utf-8')
                native = CatBoostRegressor().load_model(str(file), format='json')
                native_models[family][side] = native
                assert native.feature_names_ == original['featureNames']
                raw = np.asarray(native.predict(features, prediction_type='RawFormulaVal', thread_count=2))
                raw_all[family][side] = raw
                errors['nativePythonMaximumError'] = max(errors['nativePythonMaximumError'], float(np.max(np.abs(raw - traverse_raw(models[family][side], features)))))
                if family == 'control':
                    control_error = float(np.max(np.abs(raw - raw_all['identity'][side])))
                    errors['controlNativeMaximumError'] = max(errors['controlNativeMaximumError'], control_error)
                    control_checks[side]['nativeMaximumError'] = control_error
                    receipt = selection['control']['verification'][side]
                    assert receipt['nonLeafInferenceExactlyEqual'] is True and receipt['effectiveParametersOnlyL2AfterDocumentedMetadataNormalization'] is True
                    assert receipt['nativeRows'] == 6577
                    for key, value in control_checks[side].items():
                        assert math.isfinite(receipt[key]) and abs(receipt[key] - value) <= 1e-12
                if family in ['identity', 'candidate']:
                    routes = native.calc_leaf_indexes(features[train_indices], thread_count=2)
                    for index, tree in enumerate(models[family][side]['oblivious_trees']):
                        counts = np.bincount(routes[:, index], minlength=len(tree['leaf_values']))
                        assert np.array_equal(counts, tree['leaf_weights'])
                    if family == 'candidate':
                        support_checks[side] = {'nativeTrainingRows': len(train_indices), 'treeCount': len(models[family][side]['oblivious_trees']), 'allLeafSupportsMatch': True}
                        assert audit['models'][side]['allLeafSupportsMatch'] is True
                        assert audit['models'][side]['trainingLeafCounts'] == [tree['leaf_weights'] for tree in models[family][side]['oblivious_trees']]
                        receipt = selection['fits'][0]['nativeIndependentParity'][side]
                        assert audit['candidateInferenceChecks'][side] == receipt
                        assert receipt['rows'] == 6577 and receipt['baselineFrozen'] is True and receipt['onlyIgnoredInputsPerturbed'] is True
                        difference = float(np.max(np.abs(raw - traverse_raw(models[family][side], features))))
                        assert abs(receipt['candidateNativeMaximumError'] - difference) <= 1e-12
                        original_error = float(np.max(np.abs(raw_all['identity'][side] - traverse_raw(models['identity'][side], features))))
                        assert abs(receipt['incumbentNativeMaximumError'] - original_error) <= 1e-12
        bridge = source_predictions(models, rows, features, plan['sourceHashes'], temporary)
        assert len(bridge['buildParity']) == 8
        bridge_rows = {row['matchId']: row for row in bridge['rows']}
        assert len(bridge_rows) == len(bridge['rows']) == 6577 and set(bridge_rows) == set(by_id)
        for family in ['identity', 'control', 'candidate']:
            for side in ['home', 'away']:
                source_raw = np.array([bridge_rows[row['matchId']][family][side][0] for row in rows])
                errors['nativeSourceTypeScriptMaximumError'] = max(errors['nativeSourceTypeScriptMaximumError'], float(np.max(np.abs(source_raw - raw_all[family][side]))))
        for label, changed in perturbations(features):
            perturbation_checks[label] = {}
            for side in ['home', 'away']:
                raw = raw_all['candidate'][side]
                perturbed_native = native_models['candidate'][side].predict(changed, prediction_type='RawFormulaVal', thread_count=2)
                source_raw = np.array([bridge_rows[row['matchId']]['perturbations'][label][side][0] for row in rows])
                native_difference = float(np.max(np.abs(perturbed_native - raw)))
                source_difference = float(np.max(np.abs(source_raw - raw)))
                perturbation_checks[label][side] = {'nativeMaximumDifference': native_difference, 'sourceTypeScriptMaximumDifference': source_difference}
                errors['ignoredNativeMaximumDifference'] = max(errors['ignoredNativeMaximumDifference'], native_difference)
                errors['ignoredSourceTypeScriptMaximumDifference'] = max(errors['ignoredSourceTypeScriptMaximumDifference'], source_difference)
                if label.startswith('both_'):
                    receipt = selection['fits'][0]['nativeIndependentParity'][side]['ignoredPerturbations'][label.removeprefix('both_')]
                    assert abs(receipt['nativeMaximumError'] - native_difference) <= 1e-12
                    assert math.isfinite(receipt['independentMaximumError']) and receipt['independentMaximumError'] <= 1e-12
        recomputed_metrics = {}
        for family in ['identity', 'candidate']:
            raw = {side: raw_all[family][side][validation_indices] for side in ['home', 'away']}
            probabilities = np.asarray([joint_probabilities(row, np.exp(raw['home'][index]), np.exp(raw['away'][index]), .75, .8)[1]
                                        for index, row in enumerate(groups['validation'])])
            recomputed_metrics[family] = metrics(groups['validation'], probabilities)
            record = selection['identity'] if family == 'identity' else selection['fits'][0]
            errors['selectionMetricsMaximumError'] = max(errors['selectionMetricsMaximumError'], compare_metrics(recomputed_metrics[family], record['validationMetrics']))
            for index, row in enumerate(groups['validation']):
                observed = evidence[row['matchId']]
                assert observed['competition'] == row['competition'] and observed['actualClass'] == (0 if row['homeGoals'] > row['awayGoals'] else 2 if row['homeGoals'] < row['awayGoals'] else 1)
                if family == 'identity':
                    expected_raw, expected_p = observed['identityRaw'], observed['identity']
                else:
                    assert len(observed['fits']) == 1 and observed['fits'][0]['variant'] == VARIANT
                    expected_raw, expected_p = observed['fits'][0]['raw'], observed['fits'][0]['probabilities']
                assert len(expected_p) == 3 and np.isfinite(expected_p).all()
                errors['selectionProbabilityMaximumError'] = max(errors['selectionProbabilityMaximumError'], float(np.max(np.abs(probabilities[index] - expected_p))))
                errors['selectionRawMaximumError'] = max(errors['selectionRawMaximumError'], *(abs(raw[side][index] - expected_raw[side][0]) for side in ['home', 'away']))
    assert max(errors.values()) <= 1e-12
    accepted = accepts(recomputed_metrics['candidate'], recomputed_metrics['identity'])
    assert accepted == accepts(selection['fits'][0]['validationMetrics'], selection['identity']['validationMetrics'])
    decision = selection['decision']
    assert decision == audit['decision']
    assert decision['acceptedNonIdentity'] is accepted and decision['selectedVariant'] == (VARIANT if accepted else None)
    assert timestamp(plan['createdAt']) < timestamp(selection['createdAt']) <= timestamp(decision['frozenAt']) <= timestamp(selection['completedAt'])
    if not accepted:
        assert not (prepared / 'artifact.json').exists() and not (prepared / 'parity.json').exists()
        assert audit['identitySelected'] is True and audit['calibrationConsumed'] is False and audit['diagnosticOutcomesScored'] is False
    else:
        verify_selected(original, selection, audit, prepared, rows, by_id, raw_all, hashes)
    for file, expected in hashes.items():
        assert digest(file) == expected, file
    return {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'scriptHash': digest(__file__), 'planHash': PLAN_HASH,
            'selectionHash': hashes[prepared / 'selection.json'], 'auditHash': hashes[prepared / 'audit.json'],
            'catboostVersion': catboost_version, 'dependencyHashes': {str(file.relative_to(ROOT)): hashes[file] for file in dependencies},
            'nativeRowsPerRegressor': 6577, 'nativeTrainingRowsPerCandidate': 5293, 'nativeSelectionRowsPerPair': 317,
            'featureMappingChecks': mapping_checks, 'controlChecks': control_checks, 'supportChecks': support_checks, 'ignoredPerturbationChecks': perturbation_checks,
            'sourceTypeScriptVerification': {key: value for key, value in bridge.items() if key != 'rows'},
            'sourceBridgeHash': hashlib.sha256(SOURCE_BRIDGE.encode()).hexdigest(), **errors,
            'decision': decision, 'allFiveLeagueSelectionReproduced': True, 'noFitsOrProviderCalls': True,
            'incumbentAndPinnedSourcesUnchanged': True, 'independentPredictiveEvidence': False, 'productionAdoptionEligible': False}


def verify_selected(original, selection, audit, prepared, rows, by_id, raw_all, hashes):
    file, parity_file = prepared / 'artifact.json', prepared / 'parity.json'
    candidate, parity = read(file), read(parity_file)
    hashes[file], hashes[parity_file] = digest(file), digest(parity_file)
    assert audit['artifactHash'] == hashes[file] and audit['parityHash'] == hashes[parity_file]
    assert candidate['trainedThrough'] == original['trainedThrough'] and candidate['trainingSplit'] == original['trainingSplit']
    assert candidate['hyperparameters'] == original['hyperparameters'] | {'ignoredFeatures': IGNORED_NAMES, 'ignoredFeatureIndices': IGNORED_INDICES}
    assert candidate['trainerHash'] == hashes[HERE / 'prepare.py'] and candidate['parentTrainerHash'] == original['trainerHash']
    assert candidate['parentVersion'] == original['version'] and candidate['experimentPlanHash'] == PLAN_HASH
    assert candidate['diagnosticOnly'] is True and candidate['productionAdoptionEligible'] is False
    assert candidate['productionValidated'] is False and candidate['independentEvidence'] is False
    assert 'calibrationProfilesV2' not in candidate
    assert candidate['experimentIdentity']['selectionHash'] == hashes[prepared / 'selection.json']
    assert candidate['parameterSelection'] == {'method': METHOD, 'fit': selection['fit'], 'validation': selection['validation'],
        'testedVariants': [VARIANT], 'selectedVariant': VARIANT, 'selectionHash': hashes[prepared / 'selection.json'],
        'choiceFrozenAt': selection['decision']['frozenAt'], 'ignoredFeatures': IGNORED_NAMES, 'ignoredFlatIndices': IGNORED_INDICES}
    assert timestamp(selection['decision']['frozenAt']) <= timestamp(candidate['createdAt'])
    for side in ['home', 'away']:
        assert candidate['models'][side] == read(prepared / selection['fits'][0]['models'][side]['file'])
    assert len(candidate['calibrationPredictions']) == 358
    for before, after in zip(original['calibrationPredictions'], candidate['calibrationPredictions']):
        assert {key: value for key, value in before.items() if key != 'matrixC'} == {key: value for key, value in after.items() if key != 'matrixC'}
        index = by_id[after['matchId']]
        matrix, _ = joint_probabilities(rows[index], np.exp(raw_all['candidate']['home'][index]), np.exp(raw_all['candidate']['away'][index]), .75, .8)
        assert float(np.max(np.abs(matrix - after['matrixC']))) <= 1e-12
    assert len(parity['rows']) == len({row['matchId'] for row in parity['rows']}) == 6577
    assert {row['matchId'] for row in parity['rows']} == set(by_id) and parity['featureNames'] == original['featureNames']
    for row in parity['rows']:
        for side in ['home', 'away']:
            index = by_id[row['matchId']]
            assert abs(row['raw'][side][0] - raw_all['candidate'][side][index]) <= 1e-12
            assert abs(row['rawIncumbent'][side][0] - raw_all['identity'][side][index]) <= 1e-12


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
