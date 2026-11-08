'use strict';
// One prespecified diagnostic comparison. This file never trains or selects a model.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  if (!['--candidate', '--plan', '--inputs', '--out', '--cohort'].includes(process.argv[index]) || !process.argv[index + 1]) throw Error('Invalid comparison option');
  options[process.argv[index].slice(2)] = process.argv[index + 1];
}
if (!options.candidate || !options.plan || !options.inputs || !options.out || fs.existsSync(options.out)) throw Error('Candidate, plan, inputs and new output required');
const cohort = options.cohort || 'current';
if (!['current', 'post-calibration'].includes(cohort)) throw Error('Unknown diagnostic cohort');
const { baselineManifest, buildForecastInput } = require('../../dist/research/ForecastCore');
const { predictHybrid, predictCatBoostJson, validateArtifact } = require('../../dist/research/CatBoostModel');
const { scoreMatrixMarkets } = require('../../dist/research/GoalSettlement');
const { coherentProbabilityPipelineHash } = require('../../dist/research/CoherentProbabilityPipeline');
const { filterChallengerHistory, CHALLENGER_DATA_QUALITY_POLICY_HASH } = require('../../dist/research/ChallengerDataQuality');
const { resolveNightlyForecastAt } = require('../../dist/research/ForecastDecisionTime');
const adapter = require('./selector-math.cjs');
const incumbentFile = path.join(root, 'backend/current-models/challenger.json');
const datasetFile = path.join(root, 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json');
const inputs = path.resolve(options.inputs);
const quoteFile = path.join(inputs, 'quotes.json');
const historyFile = path.join(inputs, 'history.json');
const files = [incumbentFile, datasetFile, options.candidate, options.plan, quoteFile, historyFile];
const hashes = Object.fromEntries(files.map(file => [path.relative(root, file).replaceAll('\\', '/'), sha(file)]));
const plan = read(options.plan);
const models = { incumbent: read(incumbentFile), candidate: read(options.candidate) };
assert.equal(models.incumbent.version, plan.incumbentVersion);
assert.equal(sha(incumbentFile), plan.incumbentArtifactHash);
assert.equal(sha(datasetFile), plan.datasetHash);
const identity = adapter.identities();
assert(Object.values(identity.buildParity).every(Boolean));
for (const artifact of Object.values(models)) {
  validateArtifact(artifact);
  assert.equal(artifact.baselineVersion, baselineManifest().version);
  assert.equal(artifact.pipelineHashV2, coherentProbabilityPipelineHash());
  assert.equal(artifact.probabilityCalibrationMode, 'isotonic_1x2');
}
assert.equal(models.candidate.datasetHash, plan.datasetHash);
assert.equal(models.candidate.splitPlanHash, sha(options.plan), 'The comparison must use the exact frozen training plan');
assert.equal(models.candidate.identity.incumbentVersion, plan.incumbentVersion);
assert.equal(models.candidate.productionValidated, false);
const dataset = read(datasetFile);
const byId = new Map(dataset.rows.map(row => [row.matchId, row]));
const quoteData = read(quoteFile);
const targets = cohort === 'current' ? quoteData.rows.filter(row => row.season === '2026/2027') : quoteData.rows;
if (plan.protocol === 'fixed-seed-ensemble-v1') {
  const trainingReport = read(path.join(path.dirname(path.dirname(path.resolve(options.candidate))), 'training', 'report.json'));
  assert.equal(trainingReport.selectionGate.passed, true, 'The prespecified development gate must pass before any test diagnostics');
}
if (cohort === 'current') assert.equal(targets.length, 57, 'The prespecified current-season diagnostic cohort must remain fixed');
else {
  assert.equal(targets.length, plan.diagnosticCohort?.n);
  const idsHash = crypto.createHash('sha256').update(targets.map(row => row.matchId).sort().join('\n')).digest('hex');
  assert.equal(idsHash, plan.diagnosticCohort.matchIdsHash);
  assert.equal(sha(quoteFile), plan.diagnosticCohort.quoteFileSha256);
  const trainingReport = read(path.join(path.dirname(path.dirname(path.resolve(options.candidate))), 'training', 'report.json'));
  assert.equal(trainingReport.selectionGate.passed, true, 'The prespecified development gate must pass before additional diagnostics');
}
const history = filterChallengerHistory(read(historyFile));
const historyById = new Map(history.map(row => [row.matchId, row]));
const records = [];
const parityFile = path.join(path.dirname(path.dirname(path.resolve(options.candidate))), 'training', 'parity.json');
const parity = read(parityFile);
let maximumParityError = 0;
for (const observation of parity.rows) for (const side of ['home', 'away']) {
  const actual = predictCatBoostJson(models.candidate.models[side], observation.features);
  assert.equal(actual.length, observation.raw[side].length);
  actual.forEach((value, index) => {
    maximumParityError = Math.max(maximumParityError, Math.abs(value - observation.raw[side][index]));
  });
}
assert(maximumParityError < 1e-10, 'Native CatBoost and TypeScript JSON inference must agree');

for (const target of targets) {
  let input = byId.get(target.matchId);
  if (!input) {
    const match = historyById.get(target.matchId);
    input = { ...buildForecastInput(history, { matchId: match.matchId, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
      date: match.date, competition: match.competition, season: match.season }, resolveNightlyForecastAt(match.date, { hour: 3, minute: 7 })),
    dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true };
  }
  assert(Date.parse(input.forecastAt) >= Date.parse(plan.calibrationBefore));
  assert(Date.parse(input.maxTrainingAvailableAt) <= Date.parse(input.forecastAt));
  const quotes = ['homeWin', 'draw', 'awayWin'].map((selection, index) => ({ selection, market: '1x2',
    side: ['home', 'draw', 'away'][index], bookmaker: 'Bet365', source: 'football_data_csv', priceType: 'closing',
    capturedAt: target.archiveAcquiredAt, timestampEvidence: 'observed_snapshot', odds: target.sheets['1x2'].prices[index] }));
  const forecasts = {};
  for (const [name, artifact] of Object.entries(models)) {
    assert(Date.parse(input.forecastAt) > Date.parse(artifact.validationThrough));
    const indices = artifact.featureNames.map(feature => input.featureNames.indexOf(feature));
    assert(indices.every(index => index >= 0));
    const raw = predictHybrid({ ...input, featureNames: artifact.featureNames, featureSchema: artifact.featureSchema,
      features: indices.map(index => input.features[index]) }, artifact);
    const result = adapter.calibrateAndBlend({ matrix: raw.matrix, rawProbabilities: raw.probabilities,
      profile: artifact.calibrationProfilesV2.C, mode: artifact.probabilityCalibrationMode,
      temperature: artifact.probabilityTemperature, forecastAt: input.forecastAt, quotes });
    assert(result.marketBlendingApplied);
    forecasts[name] = { raw: scoreMatrixMarkets(raw.matrix), calibrated: result.calibrated, decision: result.decision };
  }
  records.push({ matchId: target.matchId, competition: target.competition, kickoffAt: target.kickoffAt,
    forecastAt: input.forecastAt, homeGoals: target.homeGoals, awayGoals: target.awayGoals, forecasts });
}

function metrics(rows, family, stage) {
  let logLoss = 0, brier = 0, over25LogLoss = 0, over25Brier = 0, correct = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, predicted: 0, observed: 0 }));
  for (const row of rows) {
    const value = row.forecasts[family][stage];
    const probabilities = ['homeWin', 'draw', 'awayWin'].map(key => value[key]);
    assert(Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) < 1e-10);
    const outcome = row.homeGoals > row.awayGoals ? 0 : row.homeGoals < row.awayGoals ? 2 : 1;
    logLoss -= Math.log(Math.max(1e-15, probabilities[outcome]));
    brier += probabilities.reduce((sum, p, index) => sum + (p - Number(index === outcome)) ** 2, 0);
    const predicted = probabilities.indexOf(Math.max(...probabilities));
    correct += Number(predicted === outcome);
    const bin = bins[Math.min(9, Math.floor(probabilities[predicted] * 10))];
    bin.n++; bin.predicted += probabilities[predicted]; bin.observed += Number(predicted === outcome);
    const y = Number(row.homeGoals + row.awayGoals > 2.5), p = value.over25;
    over25LogLoss -= Math.log(Math.max(1e-15, y ? p : 1 - p));
    over25Brier += (p - y) ** 2;
  }
  const n = rows.length;
  return { n, logLoss: logLoss / n, brier: brier / n, eceTopLabel10Bins: bins.reduce((sum, bin) => sum + Math.abs(bin.predicted - bin.observed), 0) / n,
    accuracy: correct / n, over25LogLoss: over25LogLoss / n, over25Brier: over25Brier / n };
}
const summary = {};
for (const stage of ['raw', 'calibrated', 'decision']) {
  const incumbent = metrics(records, 'incumbent', stage), candidate = metrics(records, 'candidate', stage);
  const delta = Object.fromEntries(Object.keys(incumbent).filter(key => key !== 'n').map(key => [key, candidate[key] - incumbent[key]]));
  summary[stage] = { incumbent, candidate, deltaCandidateMinusIncumbent: delta,
    byLeague: Object.fromEntries([...new Set(records.map(row => row.competition))].sort().map(league => {
      const rows = records.filter(row => row.competition === league);
      return [league, { incumbent: metrics(rows, 'incumbent', stage), candidate: metrics(rows, 'candidate', stage) }];
    })) };
}
for (const [file, hash] of Object.entries(hashes)) assert.equal(sha(path.join(root, file)), hash);
const result = { protocol: 'fixed-refresh-probability-diagnostic-v1', comparedAt: new Date().toISOString(),
  comparisonScriptSha256: sha(__filename),
  incumbentVersion: models.incumbent.version, candidateVersion: models.candidate.version,
  planSha256: sha(options.plan), sourceHashes: hashes, adapter: identity,
  scope: `Prespecified already-consulted ${targets.length}-match ${cohort} diagnostic; no tuning, adoption or new independent test.`,
  cohort,
  independentEvidence: false, productionAdoption: false, databaseWrites: 0,
  primary: '1X2 Log Loss and multiclass Brier after coherent calibration; decision stage adds the same real closing 1X2 prices for both.',
  metricDefinitions: { brier: 'Multiclass 1X2 sum of three squared errors, range 0 to 2.',
    over25Brier: 'Single-event binary squared error, range 0 to 1.', ece: 'Top-label ECE with ten equal-width probability bins.' },
  checks: { nativeVsTypeScriptParityRows: parity.rows.length, maximumRawParityError: maximumParityError,
    futureDiagnosticLabelsExcludedFromFitAndCalibration: true, inputsUnchanged: true },
  trainingPartitions: models.candidate.trainingSplit, summary, rows: records };
fs.writeFileSync(options.out, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ candidateVersion: result.candidateVersion, summary, checks: result.checks }, null, 2));
