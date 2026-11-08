'use strict';
// Frozen, local diagnostic. No application startup, registration or provider calls.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fitPlateauCalibration, interpolateCalibration } = require('./plateau.cjs');
const { compare } = require('./metrics.cjs');
const root = path.resolve(__dirname, '../../..');
const sha = data => createHash('sha256').update(data).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hashIds = rows => sha(rows.map(r => r.matchId).sort().join('\n'));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert(['--plan', '--out'].includes(process.argv[i]) && process.argv[i + 1], 'Invalid argument');
  options[process.argv[i].slice(2)] = path.resolve(process.argv[i + 1]);
}
assert(options.plan && options.out && !fs.existsSync(options.out), 'Plan and new output directory required');
const plan = read(options.plan), planHash = hashFile(options.plan);
assert.equal(plan.protocol, 'c-isotonic-plateau-parameter-audit-v1');
assert.equal(plan.intervention.maximumCandidates, 1);
assert.equal(plan.productionAdoption, false);
const checkSources = () => {
  assert.equal(hashFile(options.plan), planHash);
  for (const [file, expected] of Object.entries(plan.sourceHashes)) assert.equal(hashFile(path.join(root, file)), expected, file);
};
checkSources();
const sourceHashes = Object.fromEntries(['run.cjs', 'plateau.cjs', 'metrics.cjs']
  .map(name => [name, hashFile(path.join(__dirname, name))]));
const backend = path.join(root, 'backend');
const incumbentFile = path.join(backend, 'current-models/challenger.json');
const incumbent = read(incumbentFile);
assert.equal(incumbent.version, plan.incumbentVersion);
assert.equal(hashFile(incumbentFile), plan.incumbentArtifactHash);
const { validateArtifact, predictHybrid, predictCatBoostJson } = require('../../dist/research/CatBoostModel');
const { scoreMatrixMarkets } = require('../../dist/research/GoalSettlement');
const { fitCoherentCalibration, applyCoherentProbabilityPipeline, coherentProbabilityPipelineHash } = require('../../dist/research/CoherentProbabilityPipeline');
const { baselineManifest, buildForecastInput } = require('../../dist/research/ForecastCore');
const { filterChallengerHistory, CHALLENGER_DATA_QUALITY_POLICY_HASH } = require('../../dist/research/ChallengerDataQuality');
const { ORIGINAL_HOLDOUT_POLICY } = require('../../dist/research/ResearchHoldoutPolicy');
const { resolveNightlyForecastAt } = require('../../dist/research/ForecastDecisionTime');
const adapter = require('../current-c-real-odds-backtest/selector-math.cjs');
const adapterIdentity = adapter.identities();
assert(Object.values(adapterIdentity.buildParity).every(Boolean));
validateArtifact(incumbent);
assert.equal(incumbent.baselineVersion, baselineManifest().version);
assert.equal(incumbent.pipelineHashV2, coherentProbabilityPipelineHash());
const resultKeys = ['homeWin', 'draw', 'awayWin'];
const maximumDifference = (left, right) => {
  assert.equal(left.length, right.length);
  return Math.max(0, ...left.map((v, i) => Math.abs(v - right[i])));
};
const flattenPoints = points => points.flatMap(p => [p.x, p.y]);
const observations = incumbent.calibrationPredictions.map(row => {
  const scored = scoreMatrixMarkets(row.matrixC);
  const total = resultKeys.reduce((s, key) => s + scored[key], 0);
  const actual = row.homeGoals > row.awayGoals ? 'homeWin' : row.homeGoals < row.awayGoals ? 'awayWin' : 'draw';
  return { matchId: row.matchId, availableAt: row.availableAt,
    probabilities: Object.fromEntries(resultKeys.map(key => [key, scored[key] / total])),
    outcomes: Object.fromEntries(resultKeys.map(key => [key, Number(key === actual)])) };
}).sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt) || a.matchId.localeCompare(b.matchId));
assert.equal(observations.length, plan.calibration.n);
assert.equal(hashIds(observations), plan.calibration.matchIdsHash);
assert(observations.every(row => Date.parse(row.availableAt) <= Date.parse(incumbent.validationThrough)));
const profile = incumbent.calibrationProfilesV2.C;
const fitted = fitPlateauCalibration(observations.flatMap(r => resultKeys.map(key => r.probabilities[key])),
  observations.flatMap(r => resultKeys.map(key => r.outcomes[key])));
const reconstructed = fitCoherentCalibration(observations, incumbent.validationThrough);
const legacyError = maximumDifference(flattenPoints(fitted.legacyPoints), flattenPoints(profile.calibrationPoints));
assert(legacyError < 1e-12);
assert(maximumDifference(flattenPoints(reconstructed.calibrationPoints), flattenPoints(profile.calibrationPoints)) < 1e-12);
assert(maximumDifference(flattenPoints(fitted.legacyPoints), flattenPoints(profile.byFamily.goal_1x2.points)) < 1e-12);
assert.equal(reconstructed.matches, profile.matches);
assert.equal(profile.nObservations, observations.length * 3);
assert.equal(fitted.objective.maximumPlateauResidual, 0);
assert(fitted.objective.correctedWeightedSquaredError < fitted.objective.legacyWeightedSquaredError);

const identity = { protocol: plan.protocol, planHash, sourceHashes, parentVersion: incumbent.version,
  parentArtifactHash: plan.incumbentArtifactHash, correctedPoints: fitted.correctedPoints };
const candidate = structuredClone(incumbent);
Object.assign(candidate, { version: `C-${sha(JSON.stringify(identity)).slice(0, 16)}`, parentVersion: incumbent.version,
  createdAt: new Date().toISOString(), status: 'CANDIDATE', productionValidated: false,
  productionAdoptionEligible: false, diagnosticOnly: true, independentEvidence: false,
  availability: 'local_parameter_audit_candidate', experimentIdentity: identity,
  selectionProtocol: 'One fixed plateau representation correction; original calibration labels only; retrospective diagnostics are not independent validation.' });
candidate.calibrationProfilesV2.C.calibrationPoints = fitted.correctedPoints;
candidate.calibrationProfilesV2.C.byFamily.goal_1x2.points = fitted.correctedPoints;
validateArtifact(candidate);
assert.deepEqual(candidate.models, incumbent.models);
assert.deepEqual(candidate.calibrationProfilesV2.A, incumbent.calibrationProfilesV2.A);
assert.equal(candidate.weight, incumbent.weight);
assert.equal(candidate.temperature, incumbent.temperature);
assert.deepEqual(candidate.trainingSplit, incumbent.trainingSplit);
fs.mkdirSync(options.out); // Exclusive: never overwrite a previous experiment.
const write = (name, value) => fs.writeFileSync(path.join(options.out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
write('candidate.json', candidate); // Freeze before any post-calibration outcome scoring.
const candidateHash = hashFile(path.join(options.out, 'candidate.json'));
const evidence = { protocol: plan.protocol, planHash, sourceHashes, identity,
  candidateCreatedAt: candidate.createdAt, legacyCurveMaximumError: legacyError,
  ...fitted, witnesses: fitted.pools.filter(p => p.firstBucket !== p.lastBucket).map(pool => ({
    first: fitted.buckets[pool.firstBucket], last: fitted.buckets[pool.lastBucket], pooledValue: pool.y,
    oldAtFirst: interpolateCalibration(fitted.buckets[pool.firstBucket].xMean, fitted.legacyPoints),
    oldAtLast: interpolateCalibration(fitted.buckets[pool.lastBucket].xMean, fitted.legacyPoints) })),
  interpretation: 'Loss of fitted binned PAVA plateaus is reproducible. Lower fitting SSE is not predictive evidence.' };
write('calibration-audit.json', evidence);

const inputs = path.join(backend, 'artifacts/research/current-c-real-odds-backtest-20261108');
const dataset = read(path.join(backend, 'artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json'));
const targets = read(path.join(inputs, 'quotes.json')).rows;
assert.equal(targets.length, plan.diagnosticCohort.n);
assert.equal(hashIds(targets), plan.diagnosticCohort.matchIdsHash);
const byId = new Map(dataset.rows.map(row => [row.matchId, row]));
const history = filterChallengerHistory(read(path.join(inputs, 'history.json')));
const historyById = new Map(history.map(row => [row.matchId, row]));
const protectedIds = new Set(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds);
assert(targets.every(row => !protectedIds.has(row.matchId)));
const project = input => {
  const indices = incumbent.featureNames.map(name => input.featureNames.indexOf(name));
  assert(indices.every(index => index >= 0));
  return { ...input, featureNames: incumbent.featureNames, featureSchema: incumbent.featureSchema,
    features: indices.map(index => input.features[index]) };
};

// Trace every training row to its actual leaf; empty leaves are not automatically defects.
const treeAudit = {};
const groups = {};
for (const [part, next] of [['train', 'selection'], ['selection', 'calibration']]) {
  const split = incumbent.trainingSplit[part], boundary = incumbent.trainingSplit[next].from;
  groups[part] = dataset.rows.filter(r => r.forecastAt >= split.from && r.forecastAt <= split.to && r.availableAt < boundary).map(project);
  assert.equal(groups[part].length, split.n);
  assert.equal(hashIds(groups[part]), split.matchIdsHash);
}
for (const side of ['home', 'away']) {
  const model = incumbent.models[side];
  const indices = new Map(model.features_info.float_features.map(f => [f.feature_index, f.flat_feature_index]));
  let empty = 0, emptyNonzero = 0, sparse = 0, supportError = 0, maxLeaf = 0;
  const reachedEmpty = new Set(), reachedSparse = new Set();
  for (const tree of model.oblivious_trees) {
    const leafOf = row => tree.splits.reduce((leaf, split, bit) => leaf +
      (Math.fround(row.features[indices.get(split.float_feature_index)]) > split.border ? 2 ** bit : 0), 0);
    const counts = Array(tree.leaf_values.length).fill(0);
    for (const row of groups.train) counts[leafOf(row)]++;
    for (let leaf = 0; leaf < counts.length; leaf++) {
      supportError = Math.max(supportError, Math.abs(counts[leaf] - tree.leaf_weights[leaf]));
      empty += Number(counts[leaf] === 0);
      emptyNonzero += Number(counts[leaf] === 0 && tree.leaf_values[leaf] !== 0);
      sparse += Number(counts[leaf] >= 1 && counts[leaf] <= 4);
      maxLeaf = Math.max(maxLeaf, Math.abs(tree.leaf_values[leaf]));
    }
    for (const row of groups.selection) {
      const support = counts[leafOf(row)];
      if (support === 0) reachedEmpty.add(row.matchId);
      if (support >= 1 && support <= 4) reachedSparse.add(row.matchId);
    }
  }
  assert.equal(supportError, 0);
  assert.equal(emptyNonzero, 0);
  const intensity = groups.selection.map(row => Math.exp(predictCatBoostJson(model, row.features)[0]));
  treeAudit[side] = { trees: model.oblivious_trees.length, leaves: model.oblivious_trees.reduce((s, t) => s + t.leaf_values.length, 0),
    emptyLeaves: empty, nonzeroEmptyLeaves: emptyNonzero, leavesWithSupportOneToFour: sparse,
    selectionMatchesReachingEmpty: reachedEmpty.size, selectionMatchesReachingSparse: reachedSparse.size,
    maximumLeafMagnitude: maxLeaf, maximumSupportError: supportError,
    selectionIntensityRange: [Math.min(...intensity), Math.max(...intensity)],
    selectionClamps: intensity.filter(v => v < .05 || v > 8).length };
}
write('tree-audit.json', { trainRows: groups.train.length, selectionRows: groups.selection.length, treeAudit });

const records = [];
let maximumRawDifference = 0, rebuiltInputs = 0;
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
  const quotes = resultKeys.map((selection, index) => ({ selection, market: '1x2', side: ['home', 'draw', 'away'][index],
    bookmaker: 'Bet365', source: 'football_data_csv', priceType: 'closing',
    capturedAt: target.archiveAcquiredAt, timestampEvidence: 'observed_snapshot', odds: target.sheets['1x2'].prices[index] }));
  const forecasts = {}, rawMatrices = {};
  for (const [name, artifact] of Object.entries({ incumbent, candidate })) {
    const raw = predictHybrid(project(input), artifact);
    rawMatrices[name] = raw.matrix;
    const result = adapter.calibrateAndBlend({ matrix: raw.matrix, rawProbabilities: raw.probabilities,
      profile: artifact.calibrationProfilesV2.C, mode: 'isotonic_1x2', forecastAt: input.forecastAt, quotes });
    assert(result.marketBlendingApplied);
    assert(Math.abs(result.matrix.flat().reduce((a, b) => a + b, 0) - 1) < 1e-12);
    const calibrated = applyCoherentProbabilityPipeline({ matrix: raw.matrix, profile: artifact.calibrationProfilesV2.C,
      mode: 'isotonic_1x2', forecastAt: input.forecastAt, quotes: [] });
    const stages = { raw: scoreMatrixMarkets(raw.matrix), calibrated: calibrated.calibrated, decision: result.decision };
    for (const values of Object.values(stages)) {
      assert(Math.abs(values.homeWin + values.draw + values.awayWin - 1) < 1e-10);
      assert(Math.abs(values.over25 + values.under25 - 1) < 1e-10);
      assert(Math.abs(values.btts + values.bttsNo - 1) < 1e-10);
    }
    forecasts[name] = Object.fromEntries(Object.entries(stages).map(([stage, values]) => [stage,
      Object.fromEntries([...resultKeys, 'over25', 'under25', 'btts', 'bttsNo'].map(key => [key, values[key]]))]));
  }
  maximumRawDifference = Math.max(maximumRawDifference, maximumDifference(rawMatrices.incumbent.flat(), rawMatrices.candidate.flat()));
  records.push({ matchId: target.matchId, competition: target.competition, season: target.season,
    kickoffAt: target.kickoffAt, forecastAt: input.forecastAt, homeGoals: target.homeGoals, awayGoals: target.awayGoals, forecasts });
  if (records.length % 100 === 0 || records.length === targets.length) console.log(JSON.stringify({ completed: records.length, total: targets.length }));
}
assert.equal(maximumRawDifference, 0);
const historical = records.filter(r => r.season !== '2026/2027'), current = records.filter(r => r.season === '2026/2027');
assert.equal(historical.length, plan.diagnosticCohort.historical);
assert.equal(current.length, plan.diagnosticCohort.currentSeason);
assert.equal(hashIds(historical), incumbent.trainingSplit.test.matchIdsHash);
const summary = { all: compare(records, plan.metrics.intervals), historical: compare(historical, plan.metrics.intervals),
  current: compare(current, plan.metrics.intervals),
  byLeague: Object.fromEntries([...new Set(records.map(r => r.competition))].sort().map(league => [league,
    compare(records.filter(r => r.competition === league), plan.metrics.intervals)])) };
const primaryBetter = stats => ['calibrated', 'decision'].every(stage =>
  stats[stage].deltaCandidateMinusIncumbent.logLoss < 0 && stats[stage].deltaCandidateMinusIncumbent.brier < 0);
const improvedLeagues = Object.entries(summary.byLeague).filter(([, stats]) => primaryBetter(stats)).map(([league]) => league);
const eceNotWorse = ['calibrated', 'decision'].every(stage => summary.all[stage].deltaCandidateMinusIncumbent.eceTopLabel10Bins <= 0);
const developmentPassed = primaryBetter(summary.all) && improvedLeagues.length >= plan.developmentCriterion.minimumLeaguesWithBothLowerAtBothStages && eceNotWorse;
checkSources();
assert.equal(hashFile(path.join(options.out, 'candidate.json')), candidateHash);
const report = { protocol: plan.protocol, planHash, sourceHashes, adapterIdentity,
  incumbentVersion: incumbent.version, candidateVersion: candidate.version, candidateHash,
  diagnosticStartedAt, completedAt: new Date().toISOString(), independentEvidence: false, productionAdoption: false,
  databaseWrites: 0, developmentCriterion: { passed: developmentPassed, primaryBetter: primaryBetter(summary.all), improvedLeagues, eceNotWorse },
  interpretation: developmentPassed ? 'Descriptive criterion passed; independent prospective confirmation still required.' : 'Candidate fails the fixed descriptive criterion; no adoption.',
  checks: { incumbentAndPinnedSourcesUnchanged: true, originalCalibrationRows: observations.length,
    maximumRawDifference, rebuiltInputs, unchangedCatBoostParameters: true, protectedHoldoutTargetsUsed: 0 },
  summary, rows: records };
write('comparison.json', report);
console.log(JSON.stringify({ candidateVersion: candidate.version, criterion: report.developmentCriterion,
  checks: report.checks, all: summary.all, current: summary.current }, null, 2));
