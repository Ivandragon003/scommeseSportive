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
const METHOD = 'nearest-supported-prefix-ancestor-original-training-weighted-mean-v1';
const PLAN_HASH = '74a9f4a1d01d5e7b39ab0671b267775349de563c5f7302a3aced84b68d8d21a6';

function maximumDifference(left, right) {
  assert.equal(left.length, right.length, 'Different numeric dimensions');
  assert(left.every(Number.isFinite) && right.every(Number.isFinite));
  return Math.max(0, ...left.map((value, index) => Math.abs(value - right[index])));
}

function validatePlan(plan) {
  assert.equal(plan.protocol, 'c-tree-empty-leaf-backoff-v1');
  assert.equal(plan.productionAdoption, false);
  assert.equal(plan.databaseWrites, 0);
  assert.equal(plan.intervention.method, METHOD);
  assert.equal(plan.intervention.maximumCandidates, 1);
  assert.equal(plan.intervention.hyperparameterSearch, false);
  assert.equal(plan.intervention.newTreeFits, 0);
  assert.equal(plan.intervention.leafValueFits, 0);
  assert.equal(plan.intervention.minimumSupport, 1);
  for (const key of ['onlyOriginallyZeroSupportLeaves', 'requireOriginalEmptyValueZero', 'preserveSupportedLeafValuesExactly',
    'sameOriginalSplitsAndScaleBias']) assert.equal(plan.intervention[key], true, key);
  assert.equal(plan.developmentCriterion.minimumLeaguesWithBothLowerAtBothStages, 5);
  for (const key of ['bothPrimaryMetricsLowerAtCalibratedAndDecision', 'overallTopLabelECENotWorseAtBothStages',
    'overallPaired95IntervalsUpperBelowZeroAtBothStages']) assert.equal(plan.developmentCriterion[key], true, key);
  assert.equal(plan.metrics.intervals.replications, 2000);
  assert.equal(plan.metrics.intervals.seed, 20261108);
}

// An oblivious-tree leaf index uses bit zero for its first split. Backing off
// therefore drops the highest remaining bit and keeps the original split prefix.
function ancestorReplacement(tree, leaf) {
  assert.equal(tree.leaf_weights[leaf], 0, 'Only originally unsupported leaves may back off');
  assert.equal(tree.leaf_values[leaf], 0, 'Original empty leaf must be zero');
  const depth = (tree.splits ?? []).length;
  for (let length = depth - 1; length >= 0; length--) {
    const mask = 2 ** length - 1, prefix = leaf & mask;
    let support = 0, weighted = 0;
    const leaves = [];
    tree.leaf_values.forEach((value, index) => {
      if ((index & mask) !== prefix) return;
      const weight = tree.leaf_weights[index];
      support += weight; weighted += weight * value; leaves.push(index);
    });
    if (support > 0) return { value: weighted / support, prefixLength: length, prefixBits: prefix, support, leaves };
  }
  throw new Error('No supported ancestor');
}

function validatePrepared(artifact, incumbent, planHash, plan) {
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
    'independentEvidence', 'selectionProtocol', 'diagnosticOnly', 'productionAdoptionEligible', 'experimentIdentity', 'experimentPlanHash']);
  for (const key of new Set([...Object.keys(artifact), ...Object.keys(incumbent)])) {
    if (mutableMetadata.has(key) || ['models', 'calibrationPredictions', 'calibrationProfilesV2'].includes(key)) continue;
    assert.deepEqual(artifact[key], incumbent[key], `Unauthorized artifact change: ${key}`);
  }
  assert.equal(artifact.weight, .75);
  assert.equal(artifact.temperature, .8);
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
      oldValues.forEach((value, leaf) => {
        if (tree.leaf_weights[leaf] > 0) {
          assert.equal(newValues[leaf], value, 'Supported leaf changed');
        } else {
          emptyLeaves++;
          const replacement = ancestorReplacement(tree, leaf);
          assert(Math.abs(newValues[leaf] - replacement.value) < 1e-12, 'Incorrect nearest-supported-prefix ancestor mean');
          changedLeaves += Number(newValues[leaf] !== value);
        }
      });
    });
    assert.equal(emptyLeaves, plan.originalAudit[`${side}EmptyLeaves`]);
    bySide[side] = { emptyLeaves, changedLeaves };
  }
  assert(bySide.home.changedLeaves + bySide.away.changedLeaves > 0, 'Empty intervention');
  return { bySide, supportedLeavesUnchanged: true, onlyOriginallyEmptyLeavesChanged: true, onlyModelLeafValuesChanged: true };
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
  const inputHashes = Object.fromEntries(['artifact.json', 'audit.json', 'parity.json'].map(name => [name, hashFile(path.join(options.prepared, name))]));
  inputHashes['prepare.py'] = hashFile(path.join(__dirname, 'prepare.py'));
  const prepared = read(path.join(options.prepared, 'artifact.json'));
  const preparedAudit = read(path.join(options.prepared, 'audit.json'));
  const parity = read(path.join(options.prepared, 'parity.json'));
  assert.equal(preparedAudit.planHash, planHash);
  assert.equal(preparedAudit.artifactHash, inputHashes['artifact.json']);
  assert.equal(preparedAudit.parityHash, inputHashes['parity.json']);
  assert.deepEqual(preparedAudit.identity, prepared.experimentIdentity);
  assert.deepEqual(preparedAudit.sourceHashes, plan.sourceHashes);
  assert.equal(prepared.experimentIdentity.scriptHash, inputHashes['prepare.py'], 'Preparation script changed');
  assert.equal(prepared.experimentIdentity.helperScriptHash, plan.sourceHashes['backend/experiments/c-tree-sample-projection/prepare.py']);
  assert.equal(prepared.experimentIdentity.catboostVersion, '1.2.8');
  assert.equal(preparedAudit.trainingRows, plan.trainingSplit.train.n);
  assert.equal(preparedAudit.calibrationRows, plan.trainingSplit.calibration.n);
  assert.deepEqual(preparedAudit.trainingSplit, plan.trainingSplit);
  assert.equal(preparedAudit.newTreeFits, 0);
  assert.equal(preparedAudit.leafValueFits, 0);
  assert.equal(preparedAudit.trainingRawExactlyUnchanged, true);
  assert.equal(preparedAudit.allSupportedLeavesExactlyUnchanged, true);
  assert.equal(preparedAudit.calibrationPredictionsAAndMetadataUnchanged, true);
  assert.equal(preparedAudit.calibrationProfilesRemovedPendingSameEstimatorRefit, true);
  assert.equal(preparedAudit.currentC75Unchanged, true);
  assert.equal(preparedAudit.incumbentAndPinnedSourcesUnchanged, true);
  for (const side of ['home', 'away']) {
    for (const key of ['allLeafSupportsMatch', 'supportedLeavesUnchanged', 'onlyOriginallyEmptyLeavesChanged', 'onlyLeafValuesChanged', 'trainingRawExactlyUnchanged']) assert.equal(preparedAudit.models[side][key], true);
    assert.equal(preparedAudit.models[side].trainingRawMaximumDifference, 0);
    assert.equal(preparedAudit.nativeIndependentParity[side].trainingNativeExactlyUnchanged, true);
    assert.equal(preparedAudit.nativeIndependentParity[side].trainingNativeMaximumDifference, 0);
    for (const value of Object.values(preparedAudit.nativeIndependentParity[side])) {
      if (typeof value === 'boolean') assert.equal(value, true);
      else assert(Number.isFinite(value) && value < 1e-10);
    }
  }
  const projection = validatePrepared(prepared, incumbent, planHash, plan);
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
  for (const row of parity.rows) {
    const input = projectInput(byId.get(row.matchId), incumbent);
    for (const side of ['home', 'away']) {
      for (const [artifact, evidence] of [[prepared, row.raw], [incumbent, row.rawIncumbent]]) {
        nativeRawParityMaximum = Math.max(nativeRawParityMaximum, maximumDifference(predictCatBoostJson(artifact.models[side], input.features), evidence[side]));
      }
    }
  }
  assert(nativeRawParityMaximum < 1e-10, 'CatBoost native/TypeScript raw parity failed');
  const train = dataset.rows.filter(row => row.forecastAt >= plan.trainingSplit.train.from && row.forecastAt <= plan.trainingSplit.train.to
    && row.availableAt < plan.trainingSplit.selection.from).map(row => projectInput(row, incumbent));
  assert.equal(train.length, plan.trainingSplit.train.n);
  assert.equal(hashIds(train), plan.trainingSplit.train.matchIdsHash);
  const selection = dataset.rows.filter(row => row.forecastAt >= plan.trainingSplit.selection.from && row.forecastAt <= plan.trainingSplit.selection.to
    && row.availableAt < plan.trainingSplit.calibration.from).map(row => projectInput(row, incumbent));
  assert.equal(selection.length, plan.trainingSplit.selection.n);
  assert.equal(hashIds(selection), plan.trainingSplit.selection.matchIdsHash);
  let trainingRawMaximumDifference = 0;
  const nativeById = new Map(parity.rows.map(row => [row.matchId, row]));
  for (const input of train) {
    const evidence = nativeById.get(input.matchId);
    for (const side of ['home', 'away']) {
      const original = predictCatBoostJson(incumbent.models[side], input.features);
      const modified = predictCatBoostJson(prepared.models[side], input.features);
      assert.deepEqual(modified, original, 'Original training TypeScript raw prediction changed');
      assert.deepEqual(evidence.raw[side], evidence.rawIncumbent[side], 'Original training native raw prediction changed');
      trainingRawMaximumDifference = Math.max(trainingRawMaximumDifference, maximumDifference(original, modified));
    }
  }
  assert.equal(trainingRawMaximumDifference, 0);
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
  for (const row of calibrationRows) {
    assert(Date.parse(row.availableAt) <= Date.parse(incumbent.validationThrough));
    const input = projectInput(byId.get(row.matchId), incumbent);
    const rebuilt = calibrationRawMatrix(input, prepared, predictCatBoostJson, normalizeScoreMatrix);
    calibrationMatrixMaximumError = Math.max(calibrationMatrixMaximumError, maximumDifference(rebuilt.flat(), row.matrixC.flat()));
  }
  assert(calibrationMatrixMaximumError < 1e-12, 'Prepared calibration raw math differs');
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
  const sourceHashes = Object.fromEntries(['evaluate.cjs', 'evaluation.test.cjs', 'prepare.py'].map(name => [name, hashFile(path.join(__dirname, name))]));
  const identity = { protocol: plan.protocol, planHash, sourceHashes, inputHashes, parentVersion: incumbent.version,
    parentArtifactHash: plan.incumbentArtifactHash, backoffModelsHash: sha(JSON.stringify(prepared.models)), calibrationProfileHash: sha(JSON.stringify(profileC)) };
  const candidate = structuredClone(prepared);
  Object.assign(candidate, { version: `C-${sha(JSON.stringify(identity)).slice(0, 16)}`, parentVersion: incumbent.version,
    createdAt: new Date().toISOString(), status: 'CANDIDATE', productionValidated: false,
    diagnosticOnly: true, productionAdoptionEligible: false, independentEvidence: false,
    availability: 'local_tree_empty_leaf_backoff_candidate', experimentIdentity: identity,
    selectionProtocol: 'One fixed original-support nearest-prefix-ancestor empty-leaf backoff and unchanged original-calibration refit; retrospective diagnostics only.',
    calibrationProfilesV2: { A: structuredClone(incumbent.calibrationProfilesV2.A), C: profileC } });
  validateArtifact(candidate);
  assert.deepEqual(candidate.models, prepared.models);
  fs.mkdirSync(options.out);
  const write = (name, value) => fs.writeFileSync(path.join(options.out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  write('candidate.json', candidate); // Freeze before any post-calibration outcome scoring.
  const candidateHash = hashFile(path.join(options.out, 'candidate.json'));
  const candidateFrozenAt = new Date().toISOString();
  write('pre-scoring-checks.json', { planHash, inputHashes, identity, projection, preparedAudit, buildParity, adapterIdentity,
    nativeRawParityMaximum, nativeRawParityRows: parity.rows.length, trainingRawMaximumDifference, calibrationRows: calibrationRows.length,
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
  for (const name of ['artifact.json', 'audit.json', 'parity.json']) assert.equal(hashFile(path.join(options.prepared, name)), inputHashes[name]);
  for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(hashFile(path.join(__dirname, name)), expected);
  assert.equal(hashFile(path.join(options.out, 'candidate.json')), candidateHash);
  const report = { protocol: plan.protocol, planHash, sourceHashes, inputHashes, adapterIdentity, buildParity,
    pinnedSourceHashes: plan.sourceHashes, identity, incumbentVersion: incumbent.version, candidateVersion: candidate.version,
    candidateHash, candidateFrozenAt, diagnosticStartedAt, completedAt: new Date().toISOString(),
    diagnosticOnly: true, independentEvidence: false, productionAdoption: false, productionAdoptionEligible: false, databaseWrites: 0,
    developmentCriterion, interpretation: developmentCriterion.passed
      ? 'Fixed descriptive criterion passed; no operational adoption; independent future validation still required.'
      : 'Candidate fails the fixed descriptive criterion; no adoption.',
    allowedChanges: ['Originally empty zero leaf_values replaced by original-support weighted nearest-prefix-ancestor means',
      'Calibration matrixC recomputed from backed-off trees', 'C profile refitted using unchanged estimator on original358', 'Explicit diagnostic identity metadata'],
    checks: { incumbentAndPinnedSourcesUnchanged: true, protectedHoldoutTargetsUsed: 0, quarantinedTargetsUsed: 0,
      originalCalibrationRows: calibrationRows.length, originalAProfileReproduced: true, nativeRawParityRows: parity.rows.length,
      nativeRawParityMaximum, trainingRawMaximumDifference, guardedRawMathMaximumError, calibrationMatrixMaximumError, rebuiltInputs,
      candidateFrozenBeforeScoring: true, ...projection }, summary, rows: records };
  write('comparison.json', report);
  console.log(JSON.stringify({ candidateVersion: candidate.version, developmentCriterion, checks: report.checks }, null, 2));
  return report;
}

module.exports = { main, validatePlan, validatePrepared, ancestorReplacement };
if (require.main === module) main();
