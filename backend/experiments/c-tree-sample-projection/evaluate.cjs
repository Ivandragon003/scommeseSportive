'use strict';
// Local, retrospective diagnostic only. Never starts the app or registers a model.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { compare } = require('../c-parameter-audit/metrics.cjs');
const root = path.resolve(__dirname, '../../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hashIds = rows => sha(rows.map(row => row.matchId).sort().join('\n'));
const resultKeys = ['homeWin', 'draw', 'awayWin'];
const stages = ['calibrated', 'decision'];
const primary = ['logLoss', 'brier'];

function maximumDifference(left, right) {
  assert.equal(left.length, right.length, 'Different numeric dimensions');
  assert(left.every(Number.isFinite) && right.every(Number.isFinite));
  return Math.max(0, ...left.map((value, index) => Math.abs(value - right[index])));
}

function assertNumericEquivalent(actual, expected, tolerance = 1e-12, location = 'profile') {
  if (typeof expected === 'number') {
    assert(Number.isFinite(actual) && Math.abs(actual - expected) < tolerance, location);
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), location);
    for (const key of Object.keys(expected)) assertNumericEquivalent(actual[key], expected[key], tolerance, `${location}.${key}`);
  } else assert.equal(actual, expected, location);
}

function validatePlan(plan) {
  assert.equal(plan.protocol, 'c-tree-sample-projection-v1');
  assert.equal(plan.productionAdoption, false);
  assert.equal(plan.intervention.maximumCandidates, 1);
  assert.equal(plan.intervention.hyperparameterSearch, false);
  assert.equal(plan.intervention.newTreeFits, 0);
  assert.deepEqual(plan.intervention.features, ['home_sample', 'away_sample']);
  assert.equal(plan.developmentCriterion.minimumLeaguesWithBothLowerAtBothStages, 5);
  for (const key of ['bothPrimaryMetricsLowerAtCalibratedAndDecision', 'overallTopLabelECENotWorseAtBothStages',
    'overallPaired95IntervalsUpperBelowZeroAtBothStages']) assert.equal(plan.developmentCriterion[key], true, key);
  assert.equal(plan.metrics.intervals.replications, 2000);
  assert.equal(plan.metrics.intervals.seed, 20261108);
}

function evaluateGate(summary, criterion) {
  assert.equal(criterion.minimumLeaguesWithBothLowerAtBothStages, 5);
  const gates = [];
  const add = (name, passed, value) => gates.push({ name, passed: Boolean(passed), value });
  const leagues = Object.keys(summary.byLeague).sort();
  add('exactly_five_leagues', leagues.length === 5, leagues.length);
  for (const stage of stages) {
    for (const metric of primary) {
      const global = summary.all[stage].deltaCandidateMinusIncumbent[metric];
      add(`all.${stage}.${metric}.strictly_lower`, Number.isFinite(global) && global < 0, global);
      const interval = summary.all[stage].pairedWeekly95PercentInterval.intervals?.[metric];
      add(`all.${stage}.${metric}.paired95_upper_below_zero`, Number.isFinite(interval?.upper) && interval.upper < 0, interval ?? null);
      for (const league of leagues) {
        const delta = summary.byLeague[league][stage].deltaCandidateMinusIncumbent[metric];
        add(`${league}.${stage}.${metric}.strictly_lower`, Number.isFinite(delta) && delta < 0, delta);
      }
    }
    const ece = summary.all[stage].deltaCandidateMinusIncumbent.eceTopLabel10Bins;
    add(`all.${stage}.ece.not_worse`, Number.isFinite(ece) && ece <= 0, ece);
  }
  const primaryBetter = stats => stages.every(stage => primary.every(metric => stats[stage].deltaCandidateMinusIncumbent[metric] < 0));
  return { passed: gates.every(gate => gate.passed), diagnosticOnly: true, productionAdoptionEligible: false,
    independentEvidence: false, improvedLeagues: leagues.filter(league => primaryBetter(summary.byLeague[league])),
    gates, failedGates: gates.filter(gate => !gate.passed) };
}

function projectInput(input, artifact) {
  assert(Array.isArray(input.featureNames) && new Set(input.featureNames).size === input.featureNames.length);
  const indices = artifact.featureNames.map(name => input.featureNames.indexOf(name));
  assert(indices.every(index => index >= 0), 'Missing required feature');
  const features = indices.map(index => input.features[index]);
  assert(features.every(Number.isFinite), 'Non-finite projected feature');
  return { ...input, features, featureNames: artifact.featureNames, featureSchema: artifact.featureSchema };
}

function validatePrepared(artifact, incumbent, planHash, plan) {
  assert.equal(artifact.experimentPlanHash, planHash);
  assert.equal(artifact.diagnosticOnly, true);
  assert.equal(artifact.productionAdoptionEligible, false);
  assert.equal(artifact.independentEvidence, false);
  assert.equal(artifact.experimentIdentity?.planHash, planHash, 'Missing plan identity');
  assert.equal(artifact.experimentIdentity?.parentArtifactHash, plan.incumbentArtifactHash, 'Missing incumbent identity');
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
  let changedLeaves = 0, editedTrees = 0;
  for (const side of ['home', 'away']) {
    const oldModel = incumbent.models[side], newModel = artifact.models[side];
    const { oblivious_trees: oldTrees, ...oldMetadata } = oldModel;
    const { oblivious_trees: newTrees, ...newMetadata } = newModel;
    assert.deepEqual(newMetadata, oldMetadata, `Only leaf_values may change: ${side}`);
    assert.equal(newTrees.length, oldTrees.length);
    const indices = new Map(oldModel.features_info.float_features.map(feature => [feature.feature_index, feature.flat_feature_index]));
    oldTrees.forEach((tree, index) => {
      const replacement = newTrees[index];
      const { leaf_values: oldValues, ...oldStructure } = tree;
      const { leaf_values: newValues, ...newStructure } = replacement;
      assert.deepEqual(newStructure, oldStructure, `${side}.tree${index} structure changed`);
      assert.equal(newValues.length, oldValues.length);
      const targetBits = (tree.splits ?? []).flatMap((split, bit) =>
        plan.intervention.features.includes(incumbent.featureNames[indices.get(split.float_feature_index)]) ? [bit] : []);
      if (!targetBits.length) { assert.deepEqual(replacement, tree); return; }
      editedTrees++;
      const mask = targetBits.reduce((value, bit) => value | 2 ** bit, 0), groups = new Map();
      oldValues.forEach((value, leaf) => {
        const key = leaf & ~mask, group = groups.get(key) ?? { weight: 0, total: 0, leaves: [] };
        const weight = tree.leaf_weights[leaf];
        assert(Number.isFinite(weight) && weight >= 0);
        group.weight += weight; group.total += value * weight; group.leaves.push(leaf); groups.set(key, group);
      });
      for (const group of groups.values()) {
        if (group.weight === 0) assert(group.leaves.every(leaf => oldValues[leaf] === 0));
        const expected = group.weight > 0 ? group.total / group.weight : 0;
        for (const leaf of group.leaves) {
          assert(Number.isFinite(newValues[leaf]) && Math.abs(newValues[leaf] - expected) < 1e-12, 'Incorrect weighted projection');
          assert.equal(newValues[leaf], newValues[group.leaves[0]], 'Projection must remove target-bit dependence exactly');
          changedLeaves += Number(newValues[leaf] !== oldValues[leaf]);
        }
      }
      const oldContribution = oldValues.reduce((sum, value, leaf) => sum + value * tree.leaf_weights[leaf], 0);
      const newContribution = newValues.reduce((sum, value, leaf) => sum + value * tree.leaf_weights[leaf], 0);
      assert(Math.abs(oldContribution - newContribution) < 1e-10, 'Weighted tree contribution changed');
    });
  }
  assert(changedLeaves > 0 && editedTrees > 0, 'Empty intervention');
  return { changedLeaves, editedTrees, onlyModelLeafValuesChanged: true };
}

// Pure calibration audit mathematics, with the same intensity clamp, mixture and
// temperature as predictHybrid. It never changes a forecast date or model cutoff.
// Every post-calibration result is checked against guarded predictHybrid below.
function calibrationRawMatrix(input, artifact, predictCatBoostJson, normalizeScoreMatrix) {
  assert.equal(artifact.candidateKind, 'calibrated_ensemble');
  const baseline = normalizeScoreMatrix(input.baselineMatrix);
  const pmf = lambda => {
    const values = [Math.exp(-lambda)];
    for (let index = 1; index < baseline.length; index++) values.push(values[index - 1] * lambda / index);
    return values;
  };
  const intensity = side => Math.max(.05, Math.min(8, Math.exp(predictCatBoostJson(artifact.models[side], input.features)[0])));
  const home = pmf(intensity('home')), away = pmf(intensity('away'));
  const ml = normalizeScoreMatrix(home.map(h => away.map(a => h * a)));
  const combined = baseline.map((row, h) => row.map((value, a) => (1 - artifact.weight) * value + artifact.weight * ml[h][a]));
  return normalizeScoreMatrix(combined.map(row => row.map(value => Math.pow(Math.max(1e-15, value), 1 / artifact.temperature))));
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
  assert.equal(prepared.experimentIdentity.catboostVersion, '1.2.8');
  assert.equal(preparedAudit.trainingRows, plan.trainingSplit.train.n);
  assert.equal(preparedAudit.calibrationRows, plan.trainingSplit.calibration.n);
  assert.deepEqual(preparedAudit.trainingSplit, plan.trainingSplit);
  assert.equal(preparedAudit.newTreeFits, 0);
  assert.equal(preparedAudit.currentC75Unchanged, true);
  assert.equal(preparedAudit.incumbentAndPinnedSourcesUnchanged, true);
  for (const side of ['home', 'away']) {
    for (const key of ['allLeafSupportsMatch', 'untargetedTreesUnchanged', 'onlyLeafValuesChanged']) assert.equal(preparedAudit.models[side][key], true);
    assert.equal(preparedAudit.models[side].effectiveCountDependentGroupsAfter, 0);
    for (const value of Object.values(preparedAudit.nativeIndependentParity[side])) assert(Number.isFinite(value) && value < 1e-10);
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
  let countCounterfactualMaximumDifference = 0;
  for (const input of selection) {
    const changed = [...input.features];
    for (const feature of plan.intervention.features) changed[incumbent.featureNames.indexOf(feature)] += 38;
    for (const model of Object.values(prepared.models)) countCounterfactualMaximumDifference = Math.max(countCounterfactualMaximumDifference,
      maximumDifference(predictCatBoostJson(model, input.features), predictCatBoostJson(model, changed)));
  }
  assert.equal(countCounterfactualMaximumDifference, 0);
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
    parentArtifactHash: plan.incumbentArtifactHash, projectedModelsHash: sha(JSON.stringify(prepared.models)), calibrationProfileHash: sha(JSON.stringify(profileC)) };
  const candidate = structuredClone(prepared);
  Object.assign(candidate, { version: `C-${sha(JSON.stringify(identity)).slice(0, 16)}`, parentVersion: incumbent.version,
    createdAt: new Date().toISOString(), status: 'CANDIDATE', productionValidated: false,
    diagnosticOnly: true, productionAdoptionEligible: false, independentEvidence: false,
    availability: 'local_tree_sample_projection_candidate', experimentIdentity: identity,
    selectionProtocol: 'One fixed training-weighted tree projection and unchanged original-calibration refit; retrospective diagnostics only.',
    calibrationProfilesV2: { A: structuredClone(incumbent.calibrationProfilesV2.A), C: profileC } });
  validateArtifact(candidate);
  assert.deepEqual(candidate.models, prepared.models);
  fs.mkdirSync(options.out);
  const write = (name, value) => fs.writeFileSync(path.join(options.out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  write('candidate.json', candidate); // Freeze before any post-calibration outcome scoring.
  const candidateHash = hashFile(path.join(options.out, 'candidate.json'));
  const candidateFrozenAt = new Date().toISOString();
  write('pre-scoring-checks.json', { planHash, inputHashes, identity, projection, preparedAudit, buildParity, adapterIdentity,
    nativeRawParityMaximum, nativeRawParityRows: parity.rows.length, countCounterfactualMaximumDifference, calibrationRows: calibrationRows.length,
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
    allowedChanges: ['Original-training-support weighted leaf_values projection for home_sample/away_sample splits',
      'Calibration matrixC recomputed from projected trees', 'C profile refitted using unchanged estimator on original358', 'Explicit diagnostic identity metadata'],
    checks: { incumbentAndPinnedSourcesUnchanged: true, protectedHoldoutTargetsUsed: 0, quarantinedTargetsUsed: 0,
      originalCalibrationRows: calibrationRows.length, originalAProfileReproduced: true, nativeRawParityRows: parity.rows.length,
      nativeRawParityMaximum, countCounterfactualMaximumDifference, guardedRawMathMaximumError, calibrationMatrixMaximumError, rebuiltInputs,
      candidateFrozenBeforeScoring: true, ...projection }, summary, rows: records };
  write('comparison.json', report);
  console.log(JSON.stringify({ candidateVersion: candidate.version, developmentCriterion, checks: report.checks }, null, 2));
  return report;
}

module.exports = { main, evaluateGate, validatePlan, validatePrepared, projectInput, calibrationRawMatrix, assertNumericEquivalent };
if (require.main === module) main();
