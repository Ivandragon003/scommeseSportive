'use strict';
// Frozen local diagnostic: no application startup, registration or provider calls.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { compare } = require('../c-parameter-audit/metrics.cjs');
const { evaluateGate, projectInput, calibrationRawMatrix, assertNumericEquivalent } = require('../c-tree-sample-projection/evaluate.cjs');
const root = path.resolve(__dirname, '../../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hashIds = rows => sha(rows.map(row => row.matchId).sort().join('\n'));
const resultKeys = ['homeWin', 'draw', 'awayWin'];
const METHOD = 'six-nonnegative-original-tree-block-weights-with-chronological-ridge-selection-v1';
const PLAN_HASH = 'acd4e01698d5a61a70843192cdb6e156997c0d7da81c865e2aac8380c910c483';

function maximumDifference(left, right) {
  assert.equal(left.length, right.length, 'Different numeric dimensions');
  assert(left.every(Number.isFinite) && right.every(Number.isFinite));
  return Math.max(0, ...left.map((value, index) => Math.abs(value - right[index])));
}

function validatePlan(plan) {
  assert.equal(plan.protocol, 'c-tree-block-weight-research-v1');
  assert.equal(plan.productionAdoption, false);
  assert.equal(plan.databaseWrites, 0);
  assert.equal(plan.intervention.method, METHOD);
  assert.equal(plan.intervention.maximumSelectionFits, 4);
  assert.equal(plan.intervention.maximumFinalRefits, 1);
  assert.equal(plan.intervention.maximumDiagnosticCandidates, 1);
  assert.equal(plan.intervention.identityControl, true);
  assert.equal(plan.intervention.newTreeFits, 0);
  assert.deepEqual(plan.intervention.treeBlocks, [[0, 40], [40, 80], [80, 120]]);
  assert.deepEqual(plan.intervention.bounds, [0, 2]);
  assert.deepEqual(plan.intervention.initialWeights, [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(plan.intervention.ridgeGrid, [10, 1, .1, .01]);
  assert.deepEqual(plan.intervention.parameterOrder, ['home_0_40', 'home_40_80', 'home_80_120', 'away_0_40', 'away_40_80', 'away_80_120']);
  assert.equal(plan.developmentCriterion.minimumLeaguesWithBothLowerAtBothStages, 5);
  for (const key of ['bothPrimaryMetricsLowerAtCalibratedAndDecision', 'overallTopLabelECENotWorseAtBothStages',
    'overallPaired95IntervalsUpperBelowZeroAtBothStages']) assert.equal(plan.developmentCriterion[key], true, key);
  assert.equal(plan.metrics.intervals.replications, 2000);
  assert.equal(plan.metrics.intervals.seed, 20261108);
}

function checkedWeights(weights) {
  assert(Array.isArray(weights) && weights.length === 6, 'Six weights required');
  assert(weights.every(value => Number.isFinite(value) && value >= 0 && value <= 2), 'Weights outside frozen bounds');
  return weights;
}

function rankFits(fits, identityMetrics) {
  assert(Number.isFinite(identityMetrics.logLoss) && Number.isFinite(identityMetrics.brier));
  const eligibleFits = [];
  for (const fit of fits) {
    const values = fit.validationMetrics;
    assert(Number.isFinite(values.logLoss) && Number.isFinite(values.brier));
    const eligible = fit.converged === true && identityMetrics.logLoss - values.logLoss > 1e-12
      && values.brier <= identityMetrics.brier + 1e-12;
    if (eligible) eligibleFits.push(fit);
  }
  if (!eligibleFits.length) return null;
  const minimum = Math.min(...eligibleFits.map(fit => fit.validationMetrics.logLoss));
  return eligibleFits.filter(fit => fit.validationMetrics.logLoss - minimum <= 1e-12)
    .reduce((chosen, fit) => !chosen || fit.ridge > chosen.ridge ? fit : chosen, null);
}

function scaleModels(models, weights, blocks) {
  checkedWeights(weights);
  const scaled = structuredClone(models);
  for (const [sideIndex, side] of ['home', 'away'].entries()) {
    scaled[side].oblivious_trees.forEach((tree, treeIndex) => {
      const block = blocks.findIndex(([from, through]) => treeIndex >= from && treeIndex < through);
      assert(block >= 0, 'Tree outside frozen blocks');
      tree.leaf_values = tree.leaf_values.map(value => value * weights[sideIndex * blocks.length + block]);
    });
  }
  return scaled;
}

function groupedRaw(model, features, weights, blocks) {
  const indices = new Map(model.features_info.float_features.map(feature => [feature.feature_index, feature.flat_feature_index]));
  const sums = blocks.map(() => 0);
  model.oblivious_trees.forEach((tree, treeIndex) => {
    const block = blocks.findIndex(([from, through]) => treeIndex >= from && treeIndex < through);
    assert(block >= 0);
    const leaf = tree.splits.reduce((value, split, bit) => value +
      (Math.fround(features[indices.get(split.float_feature_index)]) > split.border ? 2 ** bit : 0), 0);
    sums[block] += tree.leaf_values[leaf];
  });
  return sums.reduce((sum, value, block) => sum + value * weights[block], 0) * model.scale_and_bias[0] + model.scale_and_bias[1][0];
}

function selectionMetrics(rows, weights, incumbent, plan, predictCatBoostJson, normalizeScoreMatrix, scoreMatrixMarkets, evidence) {
  const artifact = { ...incumbent, models: scaleModels(incumbent.models, weights, plan.intervention.treeBlocks) };
  const all = { n: 0, logLoss: 0, brier: 0 }, byLeague = {};
  for (const row of rows) {
    const matrix = calibrationRawMatrix(projectInput(row, artifact), artifact, predictCatBoostJson, normalizeScoreMatrix);
    const scored = scoreMatrixMarkets(matrix), probabilities = resultKeys.map(key => scored[key]);
    const outcome = row.homeGoals > row.awayGoals ? 0 : row.homeGoals < row.awayGoals ? 2 : 1;
    if (evidence) assert(maximumDifference(probabilities, evidence.get(row.matchId)) < 1e-12, 'Selection probability evidence mismatch');
    const losses = { logLoss: -Math.log(probabilities[outcome]),
      brier: probabilities.reduce((sum, value, index) => sum + (value - Number(index === outcome)) ** 2, 0) };
    byLeague[row.competition] ??= { n: 0, logLoss: 0, brier: 0 };
    for (const group of [all, byLeague[row.competition]]) {
      group.n++;
      for (const metric of ['logLoss', 'brier']) group[metric] += losses[metric];
    }
  }
  for (const group of [all, ...Object.values(byLeague)]) for (const metric of ['logLoss', 'brier']) group[metric] /= group.n;
  return { ...all, byLeague };
}

function validateSelection(record, plan, planHash) {
  assert.equal(record.planHash, planHash);
  assert.deepEqual(record.identity.weights, [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(record.fits.map(fit => fit.ridge), plan.intervention.ridgeGrid);
  for (const fit of record.fits) {
    checkedWeights(fit.weights);
    assert.equal(fit.converged, fit.optimizer.success);
  }
  const chosen = rankFits(record.fits, record.identity.validationMetrics);
  assert(chosen && record.decision.acceptedNonIdentity === true, 'Identity selected: no candidate and no652 scoring authorized');
  assert.equal(record.decision.selectedFitIndex, record.fits.indexOf(chosen));
  assert.equal(record.decision.selectedRidge, chosen.ridge);
  assert(record.finalFit && record.finalFit.converged === true, 'Final refit must converge before evaluation');
  assert.equal(record.finalFit.optimizer.success, true);
  checkedWeights(record.finalFit.weights);
  assert(Number.isFinite(Date.parse(record.decision.frozenAt)));
  assert(Date.parse(record.finalFit.frozenAt) >= Date.parse(record.decision.frozenAt), 'Weights must be fitted after ridge choice');
  return chosen;
}

function validatePrepared(artifact, incumbent, planHash, plan, scriptHash, finalWeights) {
  assert.equal(artifact.experimentPlanHash, planHash);
  assert.equal(artifact.experimentIdentity?.planHash, planHash);
  assert.equal(artifact.experimentIdentity?.parentArtifactHash, plan.incumbentArtifactHash);
  assert.equal(artifact.experimentIdentity?.method, METHOD);
  assert.equal(artifact.diagnosticOnly, true);
  assert.equal(artifact.productionAdoptionEligible, false);
  assert.equal(artifact.productionValidated, false);
  assert.equal(artifact.independentEvidence, false);
  assert.equal(artifact.calibrationProfilesV2, undefined, 'Prepared artifact must not contain stale profiles');
  const mutableMetadata = new Set(['version', 'createdAt', 'parentVersion', 'status', 'productionValidated', 'availability',
    'independentEvidence', 'selectionProtocol', 'diagnosticOnly', 'productionAdoptionEligible', 'experimentIdentity', 'experimentPlanHash',
    'trainedThrough', 'trainerHash', 'parentTrainerHash', 'parameterAdaptation']);
  for (const key of new Set([...Object.keys(artifact), ...Object.keys(incumbent)])) {
    if (mutableMetadata.has(key) || ['models', 'calibrationPredictions', 'calibrationProfilesV2'].includes(key)) continue;
    assert.deepEqual(artifact[key], incumbent[key], `Unauthorized artifact change: ${key}`);
  }
  assert.equal(artifact.weight, .75);
  assert.equal(artifact.temperature, .8);
  assert.equal(artifact.trainedThrough, plan.parameterDevelopment.originalSelection.availableThrough, 'Parameter fit cutoff must include all317 rows');
  assert.equal(artifact.parentTrainerHash, incumbent.trainerHash, 'Original tree trainer lineage mismatch');
  assert.equal(artifact.trainerHash, scriptHash, 'Parameter trainer hash mismatch');
  assert.equal(artifact.parameterAdaptation?.method, METHOD);
  assert.deepEqual(artifact.parameterAdaptation.weights, finalWeights);
  assert(Date.parse(artifact.trainedThrough) < Date.parse(plan.trainingSplit.calibration.from));
  assert.deepEqual(artifact.trainingSplit, plan.trainingSplit);
  assert.equal(artifact.calibrationPredictions.length, incumbent.calibrationPredictions.length);
  for (let index = 0; index < incumbent.calibrationPredictions.length; index++) {
    const { matrixC: oldMatrix, ...oldRow } = incumbent.calibrationPredictions[index];
    const { matrixC: newMatrix, ...newRow } = artifact.calibrationPredictions[index];
    assert.deepEqual(newRow, oldRow, 'Only calibration matrixC may change');
    assert(Array.isArray(oldMatrix) && Array.isArray(newMatrix));
  }
  assert.deepEqual(Object.keys(artifact.models), Object.keys(incumbent.models));
  const bySide = {};
  for (const side of ['home', 'away']) {
    const { oblivious_trees: oldTrees, ...oldMetadata } = incumbent.models[side];
    const { oblivious_trees: newTrees, ...newMetadata } = artifact.models[side];
    assert.deepEqual(newMetadata, oldMetadata, `Only leaf_values may change: ${side}`);
    assert.equal(newTrees.length, oldTrees.length);
    let emptyLeaves = 0, changedLeaves = 0;
    oldTrees.forEach((tree, index) => {
      const { leaf_values: oldValues, ...oldStructure } = tree;
      const { leaf_values: newValues, ...newStructure } = newTrees[index];
      assert.deepEqual(newStructure, oldStructure, `${side}.tree${index} structure changed`);
      assert.equal(newValues.length, oldValues.length);
      assert.equal(oldValues.length, 2 ** (tree.splits ?? []).length);
      assert.equal(tree.leaf_weights.length, oldValues.length);
      assert(tree.leaf_weights.every(weight => Number.isSafeInteger(weight) && weight >= 0));
      assert(oldValues.every(Number.isFinite) && newValues.every(Number.isFinite));
      const block = plan.intervention.treeBlocks.findIndex(([from, through]) => index >= from && index < through);
      assert(block >= 0);
      const weight = checkedWeights(finalWeights)[(side === 'home' ? 0 : 3) + block];
      oldValues.forEach((value, leaf) => {
        const expected = value * weight;
        assert.equal(newValues[leaf], expected, 'Incorrect tree-block scalar factor');
        if (tree.leaf_weights[leaf] === 0) {
          emptyLeaves++;
          assert.equal(value, 0, 'Original empty leaf must be zero');
          assert.equal(newValues[leaf], 0, 'Empty leaf must remain zero');
        }
        changedLeaves += Number(newValues[leaf] !== value);
      });
    });
    assert.equal(oldTrees.length, 120);
    bySide[side] = { emptyLeaves, changedLeaves };
  }
  assert(bySide.home.changedLeaves + bySide.away.changedLeaves > 0, 'Empty intervention');
  return { bySide, onlyWholeTreeScalarWeightsChanged: true, originalEmptyLeavesRemainZero: true, onlyModelLeafValuesChanged: true };
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert(['--plan', '--prepared', '--out'].includes(argv[index]) && argv[index + 1], 'Invalid argument');
    assert.equal(options[argv[index].slice(2)], undefined, 'Duplicate argument');
    options[argv[index].slice(2)] = path.resolve(argv[index + 1]);
  }
  assert(options.plan && options.prepared && options.out && !fs.existsSync(options.out), 'Plan, prepared input and NEW output directory required');
  const plan = read(options.plan), planHash = hashFile(options.plan);
  assert.equal(planHash, PLAN_HASH, "Frozen plan hash mismatch");
  validatePlan(plan);
  const checkSources = () => {
    assert.equal(hashFile(options.plan), planHash, 'Plan changed');
    for (const [file, expected] of Object.entries(plan.sourceHashes)) assert.equal(hashFile(path.join(root, file)), expected, file);
  };
  checkSources();
  const selectionRecord = read(path.join(options.prepared, 'selection.json'));
  validateSelection(selectionRecord, plan, planHash); // Identity/no-artifact result must stop before any scoring/output.
  const backend = path.join(root, 'backend');
  const ts = require(path.join(backend, 'node_modules/typescript'));
  const buildParity = Object.fromEntries(Object.keys(plan.sourceHashes).filter(file => file.endsWith('.ts')).map(file => {
    const expected = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText.replace(/\r\n/g, '\n').trim();
    const dist = file.replace('/src/', '/dist/').replace(/\.ts$/, '.js');
    assert(plan.sourceHashes[dist], `Missing pinned build: ${dist}`);
    return [file, expected === fs.readFileSync(path.join(root, dist), 'utf8').replace(/\r\n/g, '\n').trim()];
  }));
  assert.equal(Object.keys(buildParity).length, 8);
  assert(Object.values(buildParity).every(Boolean), 'Source/build mismatch');
  const { validateArtifact, predictHybrid, predictCatBoostJson } = require('../../dist/research/CatBoostModel');
  const { scoreMatrixMarkets, normalizeScoreMatrix } = require('../../dist/research/GoalSettlement');
  const { fitCoherentCalibration, applyCoherentProbabilityPipeline, coherentProbabilityPipelineHash } = require('../../dist/research/CoherentProbabilityPipeline');
  const { baselineManifest, buildForecastInput } = require('../../dist/research/ForecastCore');
  const { filterChallengerHistory, challengerDataQualityReason, CHALLENGER_DATA_QUALITY_POLICY_HASH } = require('../../dist/research/ChallengerDataQuality');
  const { ORIGINAL_HOLDOUT_POLICY } = require('../../dist/research/ResearchHoldoutPolicy');
  const { resolveNightlyForecastAt } = require('../../dist/research/ForecastDecisionTime');
  const adapter = require('../current-c-real-odds-backtest/selector-math.cjs');
  const adapterIdentity = adapter.identities();
  assert(Object.values(adapterIdentity.buildParity).every(Boolean));
  const incumbent = read(path.join(backend, 'current-models/challenger.json'));
  validateArtifact(incumbent);
  assert.equal(incumbent.version, plan.incumbentVersion);
  assert.equal(incumbent.baselineVersion, baselineManifest().version);
  assert.equal(incumbent.pipelineHashV2, coherentProbabilityPipelineHash());
  assert.equal(incumbent.dataQualityPolicyHash, CHALLENGER_DATA_QUALITY_POLICY_HASH);
  const inputHashes = Object.fromEntries(['artifact.json', 'audit.json', 'parity.json', 'selection.json'].map(name => [name, hashFile(path.join(options.prepared, name))]));
  inputHashes['prepare.py'] = hashFile(path.join(__dirname, 'prepare.py'));
  inputHashes['weights.py'] = hashFile(path.join(__dirname, 'weights.py'));
  const prepared = read(path.join(options.prepared, 'artifact.json'));
  const preparedAudit = read(path.join(options.prepared, 'audit.json'));
  const parity = read(path.join(options.prepared, 'parity.json'));
  assert.equal(preparedAudit.planHash, planHash);
  assert.equal(preparedAudit.artifactHash, inputHashes['artifact.json']);
  assert.equal(preparedAudit.parityHash, inputHashes['parity.json']);
  assert.equal(preparedAudit.selectionHash, inputHashes['selection.json']);
  assert.equal(prepared.experimentIdentity.selectionHash, inputHashes['selection.json']);
  assert.equal(selectionRecord.scriptHash, inputHashes['prepare.py']);
  assert.equal(selectionRecord.weightsScriptHash, inputHashes['weights.py']);
  assert.deepEqual(selectionRecord.sourceHashes, plan.sourceHashes);
  assert.deepEqual(preparedAudit.identity, prepared.experimentIdentity);
  assert.deepEqual(preparedAudit.sourceHashes, plan.sourceHashes);
  assert.equal(prepared.experimentIdentity.scriptHash, inputHashes['prepare.py'], 'Preparation script changed');
  assert.equal(prepared.experimentIdentity.weightsScriptHash, inputHashes['weights.py']);
  assert.deepEqual(prepared.experimentIdentity.weights, selectionRecord.finalFit.weights);
  assert.equal(prepared.experimentIdentity.scipyVersion, plan.intervention.optimizer.scipyVersion);
  assert.equal(prepared.experimentIdentity.helperScriptHash, plan.sourceHashes['backend/experiments/c-tree-sample-projection/prepare.py']);
  assert.equal(prepared.experimentIdentity.catboostVersion, '1.2.8');
  assert.equal(preparedAudit.trainingRows, plan.trainingSplit.train.n);
  assert.equal(preparedAudit.calibrationRows, plan.trainingSplit.calibration.n);
  assert.deepEqual(preparedAudit.trainingSplit, plan.trainingSplit);
  assert.equal(preparedAudit.newTreeFits, 0);
  assert.equal(preparedAudit.onlyEntireTreeBlockScaling, true);
  assert(Number.isFinite(preparedAudit.identityPipelineMaximumError) && preparedAudit.identityPipelineMaximumError < 1e-12);
  assert.equal(preparedAudit.identityPipelineMaximumError, selectionRecord.identityPipelineMaximumError);
  assert.deepEqual(preparedAudit.weights, selectionRecord.finalFit.weights);
  assert.deepEqual(preparedAudit.parameterAdaptation, prepared.parameterAdaptation);
  assert.deepEqual(preparedAudit.nativeIndependentParity, parity.nativeIndependentParity);
  assert.equal(preparedAudit.calibrationPredictionsAAndMetadataUnchanged, true);
  assert.equal(preparedAudit.calibrationProfilesRemovedPendingSameEstimatorRefit, true);
  assert.equal(preparedAudit.currentC75Unchanged, true);
  assert.equal(preparedAudit.incumbentAndPinnedSourcesUnchanged, true);
  for (const side of ['home', 'away']) {
    assert.equal(preparedAudit.models[side].allLeafSupportsMatch, true);
    assert.deepEqual(preparedAudit.models[side].trainingLeafCounts, incumbent.models[side].oblivious_trees.map(tree => tree.leaf_weights));
    for (const value of Object.values(preparedAudit.nativeIndependentParity[side])) {
      if (typeof value === 'boolean') assert.equal(value, true);
      else assert(Number.isFinite(value) && value < 1e-10);
    }
  }
  const projection = validatePrepared(prepared, incumbent, planHash, plan, inputHashes['prepare.py'], selectionRecord.finalFit.weights);
  validateArtifact(prepared);
  const datasetFile = path.join(backend, 'artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json');
  const dataset = read(datasetFile), byId = new Map(dataset.rows.map(row => [row.matchId, row]));
  assert.equal(byId.size, dataset.rows.length, 'Duplicate dataset IDs');
  assert.equal(dataset.rows.length, 6577);
  assert.equal(dataset.dataQualityPolicyHash, CHALLENGER_DATA_QUALITY_POLICY_HASH);
  assert.equal(dataset.baselineManifest.version, baselineManifest().version);
  assert.deepEqual(parity.featureNames, incumbent.featureNames);
  assert.equal(parity.rows.length, dataset.rows.length);
  assert.equal(new Set(parity.rows.map(row => row.matchId)).size, parity.rows.length);
  assert.equal(hashIds(parity.rows), hashIds(dataset.rows));
  let nativeRawParityMaximum = 0;
  let identityGroupedRawMaximumError = 0;
  for (const row of parity.rows) {
    const input = projectInput(byId.get(row.matchId), incumbent);
    for (const side of ['home', 'away']) {
      identityGroupedRawMaximumError = Math.max(identityGroupedRawMaximumError, Math.abs(
        groupedRaw(incumbent.models[side], input.features, [1, 1, 1], plan.intervention.treeBlocks)
        - predictCatBoostJson(incumbent.models[side], input.features)[0]));
      for (const [artifact, evidence] of [[prepared, row.raw], [incumbent, row.rawIncumbent]]) {
        nativeRawParityMaximum = Math.max(nativeRawParityMaximum, maximumDifference(predictCatBoostJson(artifact.models[side], input.features), evidence[side]));
      }
    }
  }
  assert(nativeRawParityMaximum < 1e-10, 'CatBoost native/TypeScript raw parity failed');
  assert(identityGroupedRawMaximumError < 1e-12, 'Identity block weights must reproduce original raw inference');
  const train = dataset.rows.filter(row => row.forecastAt >= plan.trainingSplit.train.from && row.forecastAt <= plan.trainingSplit.train.to
    && row.availableAt < plan.trainingSplit.selection.from).map(row => projectInput(row, incumbent));
  assert.equal(train.length, plan.trainingSplit.train.n);
  assert.equal(hashIds(train), plan.trainingSplit.train.matchIdsHash);
  const selection = dataset.rows.filter(row => row.forecastAt >= plan.trainingSplit.selection.from && row.forecastAt <= plan.trainingSplit.selection.to
    && row.availableAt < plan.trainingSplit.calibration.from).map(row => projectInput(row, incumbent));
  assert.equal(selection.length, plan.trainingSplit.selection.n);
  assert.equal(hashIds(selection), plan.trainingSplit.selection.matchIdsHash);
  const cutoff = Date.parse(plan.parameterDevelopment.cutoff);
  const developmentGroups = { fit: selection.filter(row => Date.parse(row.forecastAt) < cutoff && Date.parse(row.availableAt) < cutoff),
    validation: selection.filter(row => Date.parse(row.forecastAt) >= cutoff), refit: selection };
  assert.equal(developmentGroups.fit.length + developmentGroups.validation.length, selection.length);
  for (const [name, rows] of Object.entries(developmentGroups)) {
    const expected = name === 'refit' ? plan.parameterDevelopment.originalSelection : plan.parameterDevelopment[name];
    assert.equal(rows.length, expected.n);
    assert.equal(hashIds(rows), expected.matchIdsHash);
    assert.equal(new Date(Math.max(...rows.map(row => Date.parse(row.availableAt)))).toISOString(), expected.availableThrough);
    assert.equal(selectionRecord.manifests[name].n, expected.n);
    assert.equal(selectionRecord.manifests[name].matchIdsHash, expected.matchIdsHash);
    assert.equal(selectionRecord.manifests[name].availableThrough, expected.availableThrough);
    assert.deepEqual([...selectionRecord.manifests[name].matchIds].sort(), rows.map(row => row.matchId).sort());
    assert.deepEqual(prepared.parameterAdaptation[name], selectionRecord.manifests[name]);
  }
  assert.equal(prepared.parameterAdaptation.ridge, selectionRecord.decision.selectedRidge);
  assert.equal(prepared.parameterAdaptation.choiceFrozenAt, selectionRecord.decision.frozenAt);
  assert.equal(prepared.parameterAdaptation.weightsFrozenAt, selectionRecord.finalFit.frozenAt);
  assert.equal(selectionRecord.validationRows.length, developmentGroups.validation.length);
  assert.equal(hashIds(selectionRecord.validationRows), hashIds(developmentGroups.validation));
  const validationById = new Map(developmentGroups.validation.map(row => [row.matchId, row]));
  for (const row of selectionRecord.validationRows) {
    const actual = validationById.get(row.matchId);
    assert(actual);
    assert.equal(row.actualClass, actual.homeGoals > actual.awayGoals ? 0 : actual.homeGoals < actual.awayGoals ? 2 : 1);
    assert.equal(row.competition, actual.competition);
    assert.deepEqual(row.fits.map(fit => fit.ridge), plan.intervention.ridgeGrid);
  }
  const identityValidationEvidence = new Map(selectionRecord.validationRows.map(row => [row.matchId, row.identity]));
  const recomputedIdentity = selectionMetrics(developmentGroups.validation, [1, 1, 1, 1, 1, 1], incumbent, plan,
    predictCatBoostJson, normalizeScoreMatrix, scoreMatrixMarkets, identityValidationEvidence);
  assertNumericEquivalent(recomputedIdentity, selectionRecord.identity.validationMetrics);
  assertNumericEquivalent(selectionMetrics(developmentGroups.fit, [1, 1, 1, 1, 1, 1], incumbent, plan,
    predictCatBoostJson, normalizeScoreMatrix, scoreMatrixMarkets), selectionRecord.identity.fitMetrics);
  const independentlyScoredFits = selectionRecord.fits.map((fit, index) => {
    const evidence = new Map(selectionRecord.validationRows.map(row => [row.matchId, row.fits[index].probabilities]));
    const validationMetrics = selectionMetrics(developmentGroups.validation, fit.weights, incumbent, plan,
      predictCatBoostJson, normalizeScoreMatrix, scoreMatrixMarkets, evidence);
    assertNumericEquivalent(validationMetrics, fit.validationMetrics);
    assertNumericEquivalent(selectionMetrics(developmentGroups.fit, fit.weights, incumbent, plan,
      predictCatBoostJson, normalizeScoreMatrix, scoreMatrixMarkets), fit.fitMetrics);
    return { ...fit, validationMetrics };
  });
  assert.equal(rankFits(independentlyScoredFits, recomputedIdentity)?.ridge, selectionRecord.decision.selectedRidge);
  assertNumericEquivalent(selectionMetrics(developmentGroups.refit, selectionRecord.finalFit.weights, incumbent, plan,
    predictCatBoostJson, normalizeScoreMatrix, scoreMatrixMarkets), selectionRecord.finalFit.metrics);
  for (const model of Object.values(incumbent.models)) {
    const indices = new Map(model.features_info.float_features.map(feature => [feature.feature_index, feature.flat_feature_index]));
    for (const tree of model.oblivious_trees) {
      const counts = Array(tree.leaf_values.length).fill(0);
      for (const row of train) {
        const leaf = tree.splits.reduce((value, split, bit) => value + (Math.fround(row.features[indices.get(split.float_feature_index)]) > split.border ? 2 ** bit : 0), 0);
        counts[leaf]++;
      }
      assert.deepEqual(counts, tree.leaf_weights, 'Original training support mismatch');
    }
  }
  const calibrationRows = prepared.calibrationPredictions;
  assert.equal(calibrationRows.length, plan.trainingSplit.calibration.n);
  assert.equal(hashIds(calibrationRows), plan.trainingSplit.calibration.matchIdsHash);
  let calibrationMatrixMaximumError = 0;
  let identityRawPipelineMaximumError = 0;
  for (const row of calibrationRows) {
    assert(Date.parse(row.availableAt) <= Date.parse(incumbent.validationThrough));
    const input = projectInput(byId.get(row.matchId), incumbent);
    const rebuilt = calibrationRawMatrix(input, prepared, predictCatBoostJson, normalizeScoreMatrix);
    calibrationMatrixMaximumError = Math.max(calibrationMatrixMaximumError, maximumDifference(rebuilt.flat(), row.matrixC.flat()));
    identityRawPipelineMaximumError = Math.max(identityRawPipelineMaximumError, maximumDifference(
      calibrationRawMatrix(input, incumbent, predictCatBoostJson, normalizeScoreMatrix).flat(),
      incumbent.calibrationPredictions.find(original => original.matchId === row.matchId).matrixC.flat()));
  }
  assert(calibrationMatrixMaximumError < 1e-12, 'Prepared calibration raw math differs');
  assert(identityRawPipelineMaximumError < 1e-12, 'Identity raw pipeline differs from original calibration matrices');
  const observations = (rows, matrixKey) => rows.map(row => {
    const scored = scoreMatrixMarkets(row[matrixKey]);
    const total = resultKeys.reduce((sum, key) => sum + scored[key], 0);
    const actual = row.homeGoals > row.awayGoals ? 'homeWin' : row.homeGoals < row.awayGoals ? 'awayWin' : 'draw';
    return { matchId: row.matchId, availableAt: row.availableAt,
      probabilities: Object.fromEntries(resultKeys.map(key => [key, scored[key] / total])),
      outcomes: Object.fromEntries(resultKeys.map(key => [key, Number(key === actual)])) };
  });
  const refittedA = fitCoherentCalibration(observations(calibrationRows, 'matrixA'), incumbent.validationThrough);
  assertNumericEquivalent(refittedA, incumbent.calibrationProfilesV2.A);
  const profileC = fitCoherentCalibration(observations(calibrationRows, 'matrixC'), incumbent.validationThrough);
  assert.equal(profileC.matches, 358);
  assert.equal(profileC.nObservations, 1074);
  const sourceHashes = Object.fromEntries(['evaluate.cjs', 'evaluation.test.cjs', 'prepare.py', 'weights.py'].map(name => [name, hashFile(path.join(__dirname, name))]));
  const identity = { protocol: plan.protocol, planHash, sourceHashes, inputHashes, parentVersion: incumbent.version,
    parentArtifactHash: plan.incumbentArtifactHash, weightedModelsHash: sha(JSON.stringify(prepared.models)), calibrationProfileHash: sha(JSON.stringify(profileC)) };
  const candidate = structuredClone(prepared);
  Object.assign(candidate, { version: `C-${sha(JSON.stringify(identity)).slice(0, 16)}`, parentVersion: incumbent.version,
    createdAt: new Date().toISOString(), status: 'CANDIDATE', productionValidated: false,
    diagnosticOnly: true, productionAdoptionEligible: false, independentEvidence: false,
    availability: 'local_tree_block_weight_candidate', experimentIdentity: identity,
    selectionProtocol: 'Four chronological ridge fits, identity control, one selected all317 refit and unchanged original-calibration estimator; retrospective diagnostics only.',
    calibrationProfilesV2: { A: structuredClone(incumbent.calibrationProfilesV2.A), C: profileC } });
  validateArtifact(candidate);
  assert.deepEqual(candidate.models, prepared.models);
  fs.mkdirSync(options.out);
  const write = (name, value) => fs.writeFileSync(path.join(options.out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  write('candidate.json', candidate); // Freeze before any post-calibration outcome scoring.
  const candidateHash = hashFile(path.join(options.out, 'candidate.json'));
  const candidateFrozenAt = new Date().toISOString();
  write('pre-scoring-checks.json', { planHash, inputHashes, identity, projection, preparedAudit, buildParity, adapterIdentity,
    nativeRawParityMaximum, nativeRawParityRows: parity.rows.length, identityGroupedRawMaximumError, identityRawPipelineMaximumError,
    selectionRecomputedIndependently: true, selectedRidge: selectionRecord.decision.selectedRidge, calibrationRows: calibrationRows.length,
    calibrationMatrixMaximumError, originalAProfileReproduced: true, candidateHash, candidateFrozenAt });
  const inputs = path.join(backend, 'artifacts/research/current-c-real-odds-backtest-20261108');
  const targets = read(path.join(inputs, 'quotes.json')).rows;
  assert.equal(targets.length, plan.diagnosticCohort.n);
  assert.equal(new Set(targets.map(row => row.matchId)).size, targets.length);
  assert.equal(hashIds(targets), plan.diagnosticCohort.matchIdsHash);
  const history = filterChallengerHistory(read(path.join(inputs, 'history.json'))), historyById = new Map(history.map(row => [row.matchId, row]));
  const protectedIds = new Set(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds);
  assert(targets.every(row => !protectedIds.has(row.matchId) && !challengerDataQualityReason(row.matchId)), 'Protected/quarantined target');
  const records = [];
  let rebuiltInputs = 0, guardedRawMathMaximumError = 0;
  const diagnosticStartedAt = new Date().toISOString();
  for (const target of targets) {
    let input = byId.get(target.matchId);
    if (!input) {
      const match = historyById.get(target.matchId);
      assert(match, 'Missing current match');
      input = { ...buildForecastInput(history, { matchId: match.matchId, homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId, date: match.date, competition: match.competition, season: match.season },
      resolveNightlyForecastAt(match.date, { hour: 3, minute: 7 })),
      dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true };
      rebuiltInputs++;
    }
    assert(Date.parse(input.forecastAt) > Date.parse(candidate.validationThrough));
    assert(Date.parse(input.maxTrainingAvailableAt) <= Date.parse(input.forecastAt));
    assert(Date.parse(input.forecastAt) < Date.parse(target.kickoffAt));
    assert(Number.isFinite(Date.parse(target.archiveAcquiredAt)));
    const quotes = resultKeys.map((selection, index) => ({ selection, market: '1x2', side: ['home', 'draw', 'away'][index],
      bookmaker: 'Bet365', source: 'football_data_csv', priceType: 'closing', capturedAt: target.archiveAcquiredAt,
      timestampEvidence: 'observed_snapshot', odds: target.sheets['1x2'].prices[index] }));
    const forecasts = {};
    for (const [name, artifact] of Object.entries({ incumbent, candidate })) {
      const projected = projectInput(input, artifact), raw = predictHybrid(projected, artifact);
      guardedRawMathMaximumError = Math.max(guardedRawMathMaximumError, maximumDifference(raw.matrix.flat(),
        calibrationRawMatrix(projected, artifact, predictCatBoostJson, normalizeScoreMatrix).flat()));
      const result = adapter.calibrateAndBlend({ matrix: raw.matrix, rawProbabilities: raw.probabilities,
        profile: artifact.calibrationProfilesV2.C, mode: 'isotonic_1x2', forecastAt: input.forecastAt, quotes });
      assert(result.marketBlendingApplied);
      assert.equal(result.bookmaker.bookmaker, 'Bet365');
      assert.equal(result.bookmaker.capturedAt, target.archiveAcquiredAt);
      assert(Math.abs(result.matrix.flat().reduce((a, b) => a + b, 0) - 1) < 1e-12);
      const calibrated = applyCoherentProbabilityPipeline({ matrix: raw.matrix, profile: artifact.calibrationProfilesV2.C,
        mode: 'isotonic_1x2', forecastAt: input.forecastAt, quotes: [] });
      const probabilities = { raw: scoreMatrixMarkets(raw.matrix), calibrated: calibrated.calibrated, decision: result.decision };
      for (const values of Object.values(probabilities)) {
        assert(Object.values(values).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
        assert(Math.abs(values.homeWin + values.draw + values.awayWin - 1) < 1e-10);
        assert(Math.abs(values.over25 + values.under25 - 1) < 1e-10);
        assert(Math.abs(values.btts + values.bttsNo - 1) < 1e-10);
      }
      forecasts[name] = Object.fromEntries(Object.entries(probabilities).map(([stage, values]) => [stage,
        Object.fromEntries([...resultKeys, 'over25', 'under25', 'btts', 'bttsNo'].map(key => [key, values[key]]))]));
    }
    records.push({ matchId: target.matchId, competition: target.competition, season: target.season,
      kickoffAt: target.kickoffAt, forecastAt: input.forecastAt, homeGoals: target.homeGoals, awayGoals: target.awayGoals,
      quoteEvidence: quotes, quoteTiming: 'closing_download_observation_not_forecast_capture', forecasts });
    if (records.length % 100 === 0 || records.length === targets.length) console.log(JSON.stringify({ completed: records.length, total: targets.length }));
  }
  assert.equal(rebuiltInputs, 43);
  assert(guardedRawMathMaximumError < 1e-12);
  const historical = records.filter(row => row.season !== '2026/2027'), current = records.filter(row => row.season === '2026/2027');
  assert.equal(historical.length, plan.diagnosticCohort.historical);
  assert.equal(current.length, plan.diagnosticCohort.currentSeason);
  assert.equal(hashIds(historical), incumbent.trainingSplit.test.matchIdsHash);
  const summary = { all: compare(records, plan.metrics.intervals), historical: compare(historical, plan.metrics.intervals),
    current: compare(current, plan.metrics.intervals), byLeague: Object.fromEntries([...new Set(records.map(row => row.competition))].sort()
      .map(league => [league, compare(records.filter(row => row.competition === league), plan.metrics.intervals)])) };
  const developmentCriterion = evaluateGate(summary, plan.developmentCriterion);
  checkSources();
  for (const name of ['artifact.json', 'audit.json', 'parity.json', 'selection.json']) assert.equal(hashFile(path.join(options.prepared, name)), inputHashes[name]);
  for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(hashFile(path.join(__dirname, name)), expected);
  assert.equal(hashFile(path.join(options.out, 'candidate.json')), candidateHash);
  const report = { protocol: plan.protocol, planHash, sourceHashes, inputHashes, adapterIdentity, buildParity,
    pinnedSourceHashes: plan.sourceHashes, identity, incumbentVersion: incumbent.version, candidateVersion: candidate.version,
    candidateHash, candidateFrozenAt, diagnosticStartedAt, completedAt: new Date().toISOString(),
    diagnosticOnly: true, independentEvidence: false, productionAdoption: false, productionAdoptionEligible: false, databaseWrites: 0,
    developmentCriterion, interpretation: developmentCriterion.passed
      ? 'Fixed descriptive criterion passed; no operational adoption; independent future validation still required.'
      : 'Candidate fails the fixed descriptive criterion; no adoption.',
    allowedChanges: ['Each entire original tree leaf_values scaled by its one selected nonnegative side/block weight; empty zero leaves remain zero',
      'Explicit parameterAdaptation, trainedThrough and trainer lineage recording all317 final-fit rows',
      'Calibration matrixC recomputed from weighted trees', 'C profile refitted using unchanged estimator on original358', 'Explicit diagnostic identity metadata'],
    checks: { incumbentAndPinnedSourcesUnchanged: true, protectedHoldoutTargetsUsed: 0, quarantinedTargetsUsed: 0,
      originalCalibrationRows: calibrationRows.length, originalAProfileReproduced: true, nativeRawParityRows: parity.rows.length,
      nativeRawParityMaximum, identityGroupedRawMaximumError, identityRawPipelineMaximumError,
      selectionRecomputedIndependently: true, selectedRidge: selectionRecord.decision.selectedRidge,
      guardedRawMathMaximumError, calibrationMatrixMaximumError, rebuiltInputs,
      candidateFrozenBeforeScoring: true, ...projection }, summary, rows: records };
  write('comparison.json', report);
  console.log(JSON.stringify({ candidateVersion: candidate.version, developmentCriterion, checks: report.checks }, null, 2));
  return report;
}

module.exports = { main, validatePlan, validatePrepared, checkedWeights, rankFits, validateSelection, scaleModels, groupedRaw };
if (require.main === module) main();
