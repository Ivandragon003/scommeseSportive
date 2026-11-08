'use strict';
// One user-fixed exploratory comparison. Development outcomes never select or stop it.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { compare, metrics } = require('../c-parameter-audit/metrics.cjs');
const { evaluateGate, projectInput, calibrationRawMatrix, assertNumericEquivalent } = require('../c-tree-sample-projection/evaluate.cjs');
const root = path.resolve(__dirname, '../../..');
const PLAN_HASH = 'f073f545685a147607e5fd05bb25e49d25f0a461e15952bae8908aaff06e09d1';
const METHOD = 'single-newton-update-original-training-full-probability-comparison-v1', VARIANT = 'newton_one_step';
const sha = value => createHash('sha256').update(value).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hashIds = rows => sha(rows.map(row => row.matchId).sort().join('\n'));
const keys = ['homeWin', 'draw', 'awayWin'], kept = [...keys, 'over25', 'under25', 'btts', 'bttsNo'];
const difference = (a, b) => { assert.equal(a.length, b.length); assert([...a, ...b].every(Number.isFinite)); return Math.max(0, ...a.map((v, i) => Math.abs(v - b[i]))); };

function validatePlan(plan) {
  assert.equal(plan.protocol, 'c-tree-newton-one-research-v1');
  assert.equal(plan.intervention.method, METHOD); assert.equal(plan.intervention.variant, VARIANT);
  assert.equal(plan.intervention.originalLeafEstimationIterations, 10); assert.equal(plan.intervention.candidateLeafEstimationIterations, 1);
  assert.equal(plan.intervention.maximumCandidateFits, 2); assert.equal(plan.intervention.maximumDiagnosticCandidates, 1);
  assert.equal(plan.parameterDevelopment.noSelectionGate, true); assert.equal(plan.parameterDevelopment.variantFixedBeforeOutcomes, true);
  assert.equal(plan.productionAdoption, false);
  assert.equal(plan.developmentCriterion.minimumLeaguesWithBothLowerAtBothStages, 5);
  assert.equal(plan.metrics.intervals.replications, 2000); assert.equal(plan.metrics.intervals.seed, 20261108);
}

function validateParameters(original, candidate) {
  for (const model of [original, candidate]) assert(!['categorical_features', 'text_features', 'embedding_features'].some(key => model.features_info?.[key]?.length));
  const before = structuredClone(original.model_info.params), after = structuredClone(candidate.model_info.params);
  assert.equal(before.tree_learner_options.leaf_estimation_iterations, 10);
  assert.equal(after.tree_learner_options.leaf_estimation_iterations, 1);
  assert.equal(before.tree_learner_options.leaf_estimation_backtracking, 'AnyImprovement');
  assert.equal(after.tree_learner_options.leaf_estimation_backtracking, 'AnyImprovement');
  after.tree_learner_options.leaf_estimation_iterations = 10;
  assert.equal(before.flat_params.leaf_estimation_iterations, undefined); assert.equal(after.flat_params.leaf_estimation_iterations, 1);
  delete after.flat_params.leaf_estimation_iterations;
  assert.equal(before.tree_learner_options.l2_leaf_reg, 3); assert.equal(after.tree_learner_options.l2_leaf_reg, 3);
  assert.equal(before.flat_params.l2_leaf_reg ?? 3, 3); assert.equal(after.flat_params.l2_leaf_reg, 3);
  delete before.flat_params.l2_leaf_reg; delete after.flat_params.l2_leaf_reg;
  if (before.cat_feature_params.ctr_leaf_count_limit !== after.cat_feature_params.ctr_leaf_count_limit) {
    // JS rounds the documented inactive uint64 pair to one representable number.
    assert.equal(before.cat_feature_params.ctr_leaf_count_limit, 18446744073709552000);
    assert.equal(after.cat_feature_params.ctr_leaf_count_limit, 18446744073709552000);
  }
  assert.deepEqual(after, before, 'Effective parameters changed beyond Newton iteration count');
  assert.equal(candidate.oblivious_trees.length, 120);
}

function validatePrepared(candidate, incumbent, plan, planHash, developmentHash, prepareHash) {
  assert.equal(candidate.experimentPlanHash, planHash); assert.equal(candidate.parentVersion, incumbent.version);
  assert.equal(candidate.trainerHash, prepareHash); assert.equal(candidate.parentTrainerHash, incumbent.trainerHash);
  assert.equal(candidate.experimentIdentity.developmentHash, developmentHash);
  assert.equal(candidate.experimentIdentity.method, METHOD); assert.equal(candidate.experimentIdentity.planHash, planHash);
  assert.equal(candidate.experimentIdentity.parentArtifactHash, plan.incumbentArtifactHash); assert.equal(candidate.experimentIdentity.scriptHash, prepareHash);
  assert.equal(candidate.diagnosticOnly, true); assert.equal(candidate.productionAdoptionEligible, false);
  assert.equal(candidate.productionValidated, false); assert.equal(candidate.independentEvidence, false);
  assert.equal(candidate.calibrationProfilesV2, undefined);
  assert.deepEqual(candidate.hyperparameters, { ...incumbent.hyperparameters, leafEstimationIterations: 1 });
  const experiment = candidate.parameterExperiment;
  assert.equal(experiment.method, METHOD); assert.equal(experiment.variant, VARIANT);
  assert.equal(experiment.leafEstimationIterations, 1); assert.equal(experiment.variantFixedBeforeOutcomes, true);
  assert.equal(experiment.fullComparisonRegardlessOfDevelopment, true); assert.equal(experiment.variantFixedAt, plan.createdAt);
  const mutable = new Set(['version', 'parentVersion', 'createdAt', 'trainerHash', 'parentTrainerHash', 'hyperparameters', 'models',
    'calibrationPredictions', 'calibrationProfilesV2', 'parameterExperiment', 'experimentPlanHash', 'experimentIdentity',
    'diagnosticOnly', 'productionAdoptionEligible', 'productionValidated', 'independentEvidence', 'availability', 'status', 'selectionProtocol']);
  for (const key of new Set([...Object.keys(incumbent), ...Object.keys(candidate)])) if (!mutable.has(key)) assert.deepEqual(candidate[key], incumbent[key], key);
  assert.equal(candidate.calibrationPredictions.length, 358);
  candidate.calibrationPredictions.forEach((row, index) => {
    const { matrixC: a, ...old } = incumbent.calibrationPredictions[index], { matrixC: b, ...current } = row;
    assert.deepEqual(current, old); assert(Array.isArray(a) && Array.isArray(b));
  });
  for (const side of ['home', 'away']) validateParameters(incumbent.models[side], candidate.models[side]);
}

function validateDevelopmentDecision(decision) {
  assert.equal(decision.variantFixedBeforeOutcomes, true); assert.equal(decision.variant, VARIANT);
  assert.equal(decision.fullDiagnosticRequired, true);
  assert.equal(typeof decision.developmentFiveLeagueCriterionPassed, 'boolean');
  return true; // A negative development result still requires the complete comparison.
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) { assert(['--plan', '--prepared', '--out'].includes(argv[i]) && argv[i + 1]); assert(!options[argv[i].slice(2)]); options[argv[i].slice(2)] = path.resolve(argv[i + 1]); }
  assert(options.plan && options.prepared && options.out && !fs.existsSync(options.out));
  const plan = read(options.plan), planHash = hashFile(options.plan); assert.equal(planHash, PLAN_HASH); validatePlan(plan);
  const checkSources = () => { assert.equal(hashFile(options.plan), planHash); for (const [file, hash] of Object.entries(plan.sourceHashes)) assert.equal(hashFile(path.join(root, file)), hash, file); };
  checkSources();
  const ts = require('../../node_modules/typescript');
  const buildParity = Object.fromEntries(Object.keys(plan.sourceHashes).filter(file => file.endsWith('.ts')).map(file => {
    const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const built = file.replace('/src/', '/dist/').replace(/\.ts$/, '.js'); assert(plan.sourceHashes[built]);
    return [file, compiled.replace(/\r\n/g, '\n').trim() === fs.readFileSync(path.join(root, built), 'utf8').replace(/\r\n/g, '\n').trim()];
  })); assert.equal(Object.keys(buildParity).length, 8); assert(Object.values(buildParity).every(Boolean));
  const { validateArtifact, predictHybrid, predictCatBoostJson } = require('../../dist/research/CatBoostModel');
  const { scoreMatrixMarkets, normalizeScoreMatrix } = require('../../dist/research/GoalSettlement');
  const { fitCoherentCalibration, coherentProbabilityPipelineHash } = require('../../dist/research/CoherentProbabilityPipeline');
  const { baselineManifest, buildForecastInput } = require('../../dist/research/ForecastCore');
  const { filterChallengerHistory, challengerDataQualityReason, CHALLENGER_DATA_QUALITY_POLICY_HASH } = require('../../dist/research/ChallengerDataQuality');
  const { ORIGINAL_HOLDOUT_POLICY } = require('../../dist/research/ResearchHoldoutPolicy');
  const { resolveNightlyForecastAt } = require('../../dist/research/ForecastDecisionTime');
  const adapter = require('../current-c-real-odds-backtest/selector-math.cjs'), adapterIdentity = adapter.identities();
  assert(Object.values(adapterIdentity.buildParity).every(Boolean));
  const incumbent = read(path.join(root, 'backend/current-models/challenger.json'));
  assert.equal(incumbent.version, plan.incumbentVersion); validateArtifact(incumbent);
  assert.equal(incumbent.baselineVersion, baselineManifest().version); assert.equal(incumbent.pipelineHashV2, coherentProbabilityPipelineHash());
  const inputHashes = Object.fromEntries(['artifact.json', 'audit.json', 'parity.json', 'development.json'].map(name => [name, hashFile(path.join(options.prepared, name))]));
  const prepareHash = hashFile(path.join(__dirname, 'prepare.py'));
  const prepared = read(path.join(options.prepared, 'artifact.json')), audit = read(path.join(options.prepared, 'audit.json'));
  const parity = read(path.join(options.prepared, 'parity.json')), development = read(path.join(options.prepared, 'development.json'));
  assert.equal(audit.planHash, planHash); assert.equal(audit.artifactHash, inputHashes['artifact.json']); assert.equal(audit.parityHash, inputHashes['parity.json']);
  assert.equal(audit.developmentHash, inputHashes['development.json']); assert.equal(audit.scriptHash, prepareHash);
  assert.deepEqual(audit.sourceHashes, plan.sourceHashes); assert.deepEqual(development.sourceHashes, plan.sourceHashes);
  assert.equal(development.planHash, planHash); assert.equal(development.scriptHash, prepareHash);
  validatePrepared(prepared, incumbent, plan, planHash, inputHashes['development.json'], prepareHash);
  validateDevelopmentDecision(development.decision); validateArtifact(prepared);
  assert.equal(audit.calibrationConsumed, true); assert.equal(audit.candidateFits, 2); assert.equal(audit.controlFits, 0);
  const dataset = read(path.join(root, 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json'));
  const byId = new Map(dataset.rows.map(row => [row.matchId, row])); assert.equal(byId.size, 6577);
  assert.equal(hashIds(parity.rows), hashIds(dataset.rows)); assert.equal(parity.rows.length, 6577); assert.deepEqual(parity.featureNames, incumbent.featureNames);
  let nativeRawParityMaximum = 0;
  for (const row of parity.rows) for (const [artifact, raw] of [[incumbent, row.rawIncumbent], [prepared, row.raw]]) {
    const input = projectInput(byId.get(row.matchId), artifact);
    for (const side of ['home', 'away']) nativeRawParityMaximum = Math.max(nativeRawParityMaximum, difference(predictCatBoostJson(artifact.models[side], input.features), raw[side]));
  } assert(nativeRawParityMaximum <= 1e-12);
  const membership = (part, next) => dataset.rows.filter(row => row.forecastAt >= plan.trainingSplit[part].from && row.forecastAt <= plan.trainingSplit[part].to && row.availableAt < plan.trainingSplit[next].from);
  const train = membership('train', 'selection'), developmentInputs = membership('selection', 'calibration');
  const trainProjected = train.map(row => projectInput(row, incumbent));
  assert.equal(train.length, 5293); assert.equal(hashIds(train), plan.trainingSplit.train.matchIdsHash);
  assert.equal(developmentInputs.length, 317); assert.equal(hashIds(developmentInputs), plan.trainingSplit.selection.matchIdsHash);
  assert.equal(hashIds(development.developmentRows), hashIds(developmentInputs));
  assert.deepEqual(prepared.parameterExperiment.fit, development.fit); assert.deepEqual(prepared.parameterExperiment.development, development.development);
  for (const artifact of [incumbent, prepared]) for (const model of Object.values(artifact.models)) {
    const mapping = new Map(model.features_info.float_features.map(feature => [feature.feature_index, feature.flat_feature_index]));
    for (const tree of model.oblivious_trees) {
      const counts = Array(tree.leaf_values.length).fill(0);
      for (const input of trainProjected) { const leaf = tree.splits.reduce((s, split, bit) => s + (Math.fround(input.features[mapping.get(split.float_feature_index)]) > split.border ? 2 ** bit : 0), 0); counts[leaf]++; }
      assert.deepEqual(counts, tree.leaf_weights);
    }
  }
  const rawMatrix = (input, artifact) => calibrationRawMatrix(projectInput(input, artifact), artifact, predictCatBoostJson, normalizeScoreMatrix);
  const developmentRows = developmentInputs.map(row => ({ ...row, forecasts: Object.fromEntries(Object.entries({ incumbent, candidate: prepared }).map(([name, artifact]) => [name, { raw: scoreMatrixMarkets(rawMatrix(row, artifact)) }])) }));
  const rawMetrics = (rows, family) => { const value = metrics(rows, family, 'raw'); return { n: value.n, logLoss: value.logLoss, brier: value.brier, byLeague: Object.fromEntries([...new Set(rows.map(r => r.competition))].sort().map(league => { const group = metrics(rows.filter(r => r.competition === league), family, 'raw'); return [league, { n: group.n, logLoss: group.logLoss, brier: group.brier }]; })) }; };
  assertNumericEquivalent(rawMetrics(developmentRows, 'incumbent'), development.identity.developmentMetrics);
  assertNumericEquivalent(rawMetrics(developmentRows, 'candidate'), development.candidate.developmentMetrics);
  for (const row of prepared.calibrationPredictions) assert(difference(rawMatrix(byId.get(row.matchId), prepared).flat(), row.matrixC.flat()) < 1e-12);
  const observations = matrixKey => prepared.calibrationPredictions.map(row => { const p = scoreMatrixMarkets(row[matrixKey]), sum = keys.reduce((s, key) => s + p[key], 0); const actual = row.homeGoals > row.awayGoals ? 'homeWin' : row.homeGoals < row.awayGoals ? 'awayWin' : 'draw'; return { matchId: row.matchId, availableAt: row.availableAt, probabilities: Object.fromEntries(keys.map(key => [key, p[key] / sum])), outcomes: Object.fromEntries(keys.map(key => [key, Number(key === actual)])) }; });
  assertNumericEquivalent(fitCoherentCalibration(observations('matrixA'), incumbent.validationThrough), incumbent.calibrationProfilesV2.A);
  const profileC = fitCoherentCalibration(observations('matrixC'), incumbent.validationThrough); assert.equal(profileC.matches, 358); assert.equal(profileC.nObservations, 1074);
  const sourceHashes = Object.fromEntries(['evaluate.cjs', 'prepare.py', 'test_evaluate.cjs'].map(name => [name, hashFile(path.join(__dirname, name))]));
  const identity = { protocol: plan.protocol, planHash, sourceHashes, inputHashes, parentVersion: incumbent.version, parentArtifactHash: plan.incumbentArtifactHash, modelsHash: sha(JSON.stringify(prepared.models)), calibrationHash: sha(JSON.stringify(profileC)) };
  const candidate = structuredClone(prepared); Object.assign(candidate, { version: `C-${sha(JSON.stringify(identity)).slice(0, 16)}`, createdAt: new Date().toISOString(), experimentIdentity: identity, calibrationProfilesV2: { A: structuredClone(incumbent.calibrationProfilesV2.A), C: profileC } }); validateArtifact(candidate);
  fs.mkdirSync(options.out); const write = (name, value) => fs.writeFileSync(path.join(options.out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  write('candidate.json', candidate); const candidateHash = hashFile(path.join(options.out, 'candidate.json')), candidateFrozenAt = new Date().toISOString();
  write('pre-scoring-checks.json', { planHash, inputHashes, identity, candidateHash, candidateFrozenAt, buildParity, adapterIdentity, nativeRawParityMaximum, developmentMetricsRecomputed: true, originalAProfileReproduced: true });
  const quotesFile = path.join(root, 'backend/artifacts/research/current-c-real-odds-backtest-20261108/quotes.json');
  const targets = read(quotesFile).rows; assert.equal(targets.length, 652); assert.equal(hashIds(targets), plan.diagnosticCohort.matchIdsHash);
  const history = filterChallengerHistory(read(path.join(root, 'backend/artifacts/research/current-c-real-odds-backtest-20261108/history.json'))), historyById = new Map(history.map(row => [row.matchId, row]));
  const protectedIds = new Set(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds);
  assert(targets.every(row => !protectedIds.has(row.matchId) && !challengerDataQualityReason(row.matchId)));
  const diagnosticStartedAt = new Date().toISOString(), records = []; let rebuiltInputs = 0;
  for (const target of targets) {
    let input = byId.get(target.matchId);
    if (!input) { const match = historyById.get(target.matchId); assert(match); input = { ...buildForecastInput(history, { matchId: match.matchId, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId, date: match.date, competition: match.competition, season: match.season }, resolveNightlyForecastAt(match.date, { hour: 3, minute: 7 })), dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true }; rebuiltInputs++; }
    assert(Date.parse(input.forecastAt) > Date.parse(candidate.validationThrough)); assert(Date.parse(input.maxTrainingAvailableAt) <= Date.parse(input.forecastAt)); assert(Date.parse(input.forecastAt) < Date.parse(target.kickoffAt));
    const quotes = keys.map((selection, index) => ({ selection, market: '1x2', side: ['home', 'draw', 'away'][index], bookmaker: 'Bet365', source: 'football_data_csv', priceType: 'closing', capturedAt: target.archiveAcquiredAt, timestampEvidence: 'observed_snapshot', odds: target.sheets['1x2'].prices[index] }));
    const forecasts = {};
    for (const [name, artifact] of Object.entries({ incumbent, candidate })) {
      const raw = predictHybrid(projectInput(input, artifact), artifact);
      const result = adapter.calibrateAndBlend({ matrix: raw.matrix, rawProbabilities: raw.probabilities, profile: artifact.calibrationProfilesV2.C, mode: 'isotonic_1x2', forecastAt: input.forecastAt, quotes });
      assert(result.marketBlendingApplied); assert.equal(result.bookmaker.bookmaker, 'Bet365'); assert.equal(result.bookmaker.capturedAt, target.archiveAcquiredAt);
      assert(Math.abs(result.matrix.flat().reduce((s, value) => s + value, 0) - 1) < 1e-12);
      forecasts[name] = Object.fromEntries(Object.entries({ raw: scoreMatrixMarkets(raw.matrix), calibrated: result.calibrated, decision: result.decision }).map(([stage, values]) => {
        assert(Math.abs(values.homeWin + values.draw + values.awayWin - 1) < 1e-10); assert(Math.abs(values.over25 + values.under25 - 1) < 1e-10); assert(Math.abs(values.btts + values.bttsNo - 1) < 1e-10);
        return [stage, Object.fromEntries(kept.map(key => [key, values[key]]))];
      }));
    }
    records.push({ matchId: target.matchId, competition: target.competition, season: target.season, kickoffAt: target.kickoffAt, forecastAt: input.forecastAt, homeGoals: target.homeGoals, awayGoals: target.awayGoals, quoteEvidence: quotes, quoteTiming: 'closing_download_observation_not_forecast_capture', forecasts });
    if (records.length % 100 === 0 || records.length === targets.length) console.log(JSON.stringify({ completed: records.length, total: targets.length }));
  }
  assert.equal(rebuiltInputs, 43);
  const historical = records.filter(row => row.season !== '2026/2027'), current = records.filter(row => row.season === '2026/2027');
  assert.equal(historical.length, 595); assert.equal(current.length, 57); assert.equal(hashIds(historical), plan.trainingSplit.test.matchIdsHash);
  const summary = { all: compare(records, plan.metrics.intervals), historical: compare(historical, plan.metrics.intervals), current: compare(current, plan.metrics.intervals), byLeague: Object.fromEntries([...new Set(records.map(r => r.competition))].sort().map(league => [league, compare(records.filter(r => r.competition === league), plan.metrics.intervals)])) };
  const developmentCriterion = evaluateGate(summary, plan.developmentCriterion); checkSources();
  for (const [name, hash] of Object.entries(inputHashes)) assert.equal(hashFile(path.join(options.prepared, name)), hash);
  for (const [name, hash] of Object.entries(sourceHashes)) assert.equal(hashFile(path.join(__dirname, name)), hash);
  assert.equal(hashFile(path.join(options.out, 'candidate.json')), candidateHash);
  const report = { protocol: plan.protocol, planHash, sourceHashes, inputHashes, pinnedSourceHashes: plan.sourceHashes, identity, buildParity, adapterIdentity, incumbentVersion: incumbent.version, candidateVersion: candidate.version, candidateHash, candidateFrozenAt, diagnosticStartedAt, completedAt: new Date().toISOString(), diagnosticOnly: true, independentEvidence: false, productionAdoption: false, productionAdoptionEligible: false, databaseWrites: 0, developmentDecision: development.decision, developmentCriterion, checks: { nativeRawParityRows: 6577, nativeRawParityMaximum, nativeTrainingSupportRows: 5293, originalCalibrationRows: 358, originalAProfileReproduced: true, rebuiltInputs, candidateFrozenBeforeScoring: true, incumbentAndPinnedSourcesUnchanged: true }, summary, rows: records };
  write('comparison.json', report); console.log(JSON.stringify({ candidateVersion: candidate.version, developmentCriterion, checks: report.checks }, null, 2)); return report;
}
module.exports = { main, validatePlan, validateParameters, validatePrepared, validateDevelopmentDecision };
if (require.main === module) main();
