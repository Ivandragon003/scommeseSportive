const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const compiled = process.env.RESEARCH_TEST_DIST || '../dist';
const moduleOf = (file) => require(resolve(__dirname, compiled, 'research', file));
const { enrichLifecycleArtifact, enrichCoherentLifecycleArtifact, rebindCoherentTrainerReport, buildLifecycleReport, registerLifecycleCandidate, rollbackUnhealthyChampion } = moduleOf('ResearchLifecycle');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = moduleOf('ForecastCore');
const { scoreMatrixMarkets } = moduleOf('GoalSettlement');
const { researchHash } = moduleOf('ResearchStore');
const { fitResearchCalibration } = moduleOf('ResearchProbabilityPipeline');
const { COHERENT_PROBABILITY_PROTOCOL } = moduleOf('CoherentProbabilityPipeline');
const { buildProbabilityConfiguration } = moduleOf('ProbabilityConfiguration');
const SYNTHETIC_POLICY = { version: 'synthetic-fixture-only', newIndependentForecastsAfter: '2025-01-31T00:00:00.000Z', protectedOriginalFinalMatchIds: [] };
const matrix = [[.10, .10, .05], [.20, .15, .05], [.20, .10, .05]];
const constant = (value) => ({ features_info: { float_features: [] }, oblivious_trees: [], scale_and_bias: [1, [value]] });
const NOW = new Date('2026-10-27T10:00:00.000Z');
function fixture(coherent = true) {
  const baseline = baselineManifest();
  const calibrationPredictions = Array.from({ length: 15 }, (_, i) => ({ matchId: `cal-${i}`,
    availableAt: new Date(Date.UTC(2025, 0, i + 1, 15)).toISOString(), forecastAt: new Date(Date.UTC(2025, 0, i + 1, 12)).toISOString(),
    kickoffAt: new Date(Date.UTC(2025, 0, i + 1, 12, 15)).toISOString(), matrixA: matrix, matrixC: matrix,
    probabilitiesA: scoreMatrixMarkets(matrix), probabilitiesC: scoreMatrixMarkets(matrix), homeGoals: i % 3, awayGoals: (i + 1) % 3 }));
  const artifact = { family: 'C', version: 'C-fixture', baselineVersion: baseline.version,
    featureSchema: FEATURE_SCHEMA_VERSION, featureNames: FEATURE_NAMES, datasetHash: 'fixture-dataset',
    trainedThrough: '2024-12-01T00:00:00.000Z', validationThrough: '2025-01-31T00:00:00.000Z',
    createdAt: '2025-02-01T00:00:00.000Z', candidateKind: 'intensity_correction', models: { home: constant(.1), away: constant(-.1) },
    temperature: 1, weight: .5, calibrationPredictions };
  const predictions = Array.from({ length: 35 }, (_, i) => ({ matchId: `test-${i}`, competition: ['Serie A','Premier League','La Liga','Bundesliga','Ligue 1'][i % 5],
    season: '2024/25', forecastAt: new Date(Date.UTC(2025, 1, i + 1, 12)).toISOString(), kickoffAt: new Date(Date.UTC(2025, 1, i + 1, 12, 15)).toISOString(),
    homeGoals: i % 3, awayGoals: (i + 1) % 3, matrixA: matrix, matrixC: matrix,
    probabilitiesA: scoreMatrixMarkets(matrix), versionA: baseline.version, versionC: artifact.version }));
  const report = { datasetHash: artifact.datasetHash, baselineManifest: baseline, type: 'historical_probability_walk_forward', predictions,
    finalHoldout: { version: artifact.version, testFrom: predictions[0].forecastAt, testTo: predictions.at(-1).forecastAt } };
  if (!coherent) return { artifact, report };
  const child = enrichCoherentLifecycleArtifact(artifact, { mode: 'identity' });
  return { artifact: child, report: rebindCoherentTrainerReport(report, child) };
}
const runs = (artifact, success = true) => Array.from({ length: 3 }, (_, i) => ({ schedulerName: 'research_model_check',
  success, startedAt: new Date(NOW.getTime() - i * 60000).toISOString(), summary: {
    family: 'C', modelVersion: artifact.version, baselineVersion: artifact.baselineVersion, featureSchema: artifact.featureSchema,
    matchId: `health-match-${i}`, snapshotHash: `health-snapshot-${i}`, probabilityProtocol: artifact.probabilityProtocol, pipelineHashV2: artifact.pipelineHashV2,
    probabilityConfigurationHash: buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
      pipelineHashV2: artifact.pipelineHashV2, mode: artifact.probabilityCalibrationMode,
      temperature: artifact.probabilityTemperature, profile: artifact.calibrationProfilesV2.C }).hash,
    checks: { inference: success, finiteProbabilities: success, coherentProbabilities: success, preKickoff: true, sharedSnapshot: true, calibrationCompatible: success } } }));

test('calibration enrichment is deterministic and excludes future calibration labels', () => {
  const { artifact } = fixture(false);
  artifact.calibrationPredictions.push({ ...artifact.calibrationPredictions[0], matchId: 'future', availableAt: '2025-03-01T00:00:00.000Z' });
  const first = enrichLifecycleArtifact(artifact), second = enrichLifecycleArtifact(first);
  assert.equal(first.calibrationProfiles.A.matches, 15);
  assert.equal(first.calibrationProfiles.C.matches, 15);
  assert.equal(researchHash(first), researchHash(second));
  assert.equal(first.calibrationSamples, undefined, 'real payout samples must not be invented');
  assert.equal(artifact.calibrationProfiles, undefined);
  assert.throws(() => enrichLifecycleArtifact({ ...artifact, pipelineHash: 'different-implementation' }), /version_mismatch_retrain/);
});

test('coherent enrichment creates a distinct immutable candidate identity and clones report crosslinks', () => {
  const { artifact, report } = fixture(false);
  artifact.calibrationSamples = { C: [{ matchId: 'legacy-payout-evidence' }] };
  report.calibrationSamples = artifact.calibrationSamples;
  const original = JSON.stringify({ artifact, report });
  const coherent = enrichCoherentLifecycleArtifact(artifact, { mode: 'identity' });
  assert.notEqual(coherent.version, artifact.version);
  assert.equal(coherent.parentVersion, artifact.version);
  assert.equal(coherent.probabilityProtocol, COHERENT_PROBABILITY_PROTOCOL);
  assert.equal(coherent.calibrationProfilesV2.A.targetProtocol, 'joint_1x2_normalized-v2');
  assert.equal(coherent.calibrationProfilesV2.A.nObservations, 45);
  assert.equal(coherent.calibrationProfilesV2.C.nObservations, 45);
  assert.deepEqual(enrichCoherentLifecycleArtifact(coherent, { mode: 'identity' }), coherent);
  const rebound = rebindCoherentTrainerReport(report, coherent);
  assert.equal(rebound.finalHoldout.version, coherent.version);
  assert.ok(rebound.predictions.every((row) => row.versionC === coherent.version));
  assert.equal(rebound.calibrationSamples, undefined);
  assert.equal(JSON.stringify({ artifact, report }), original);
  assert.equal(coherent.calibrationSamples, undefined);
  assert.throws(() => enrichCoherentLifecycleArtifact(artifact, { mode: 'temperature' }), /temperature/);
});

test('only the final holdout counts and an unmeasured model cannot be promoted', () => {
  const { artifact, report } = fixture();
  report.predictions.push(...report.predictions.map((row) => ({ ...row, matchId: `earlier-${row.matchId}`, versionC: 'C-earlier-fold' })));
  const evaluated = buildLifecycleReport(enrichLifecycleArtifact(artifact), report, { evaluationPolicy: SYNTHETIC_POLICY, now: NOW });
  assert.equal(evaluated.validation.nPaired, 35);
  assert.equal(evaluated.validation.passed, false);
  assert.equal(evaluated.validation.operationalChecksPassed, false);
  assert.ok(evaluated.warnings.some((warning) => warning.code === 'measured_operational_checks_missing_or_failed'));
  assert.deepEqual(evaluated.marketValidation, {});
});

test('lifecycle reports retain the exact identity or temperature settings used for operational decisions', () => {
  for (const settings of [{ mode: 'identity' }, { mode: 'temperature', temperature: .9 }]) {
    const raw = fixture(false);
    const artifact = enrichCoherentLifecycleArtifact(raw.artifact, settings);
    const trainer = rebindCoherentTrainerReport(raw.report, artifact);
    const report = buildLifecycleReport(artifact, trainer, { evaluationPolicy: SYNTHETIC_POLICY,
      now: NOW, operationalRuns: runs(artifact) });
    assert.equal(report.probabilityCalibrationMode, settings.mode);
    assert.equal(report.probabilityTemperature, settings.temperature);
    assert.equal(report.validation.operationalChecksPassed, true);
    assert.equal(report.operationalEvidence.expectedConfigurationHash, runs(artifact)[0].summary.probabilityConfigurationHash);
  }
});

test('operational evidence for another post-processing configuration cannot approve the candidate', () => {
  const { artifact, report } = fixture();
  const wrongConfiguration = buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
    pipelineHashV2: artifact.pipelineHashV2, mode: 'temperature', temperature: .9,
    profile: artifact.calibrationProfilesV2.C }).hash;
  const mixed = runs(artifact).map((run) => ({ ...run, summary: { ...run.summary,
    probabilityConfigurationHash: wrongConfiguration } }));
  const evaluated = buildLifecycleReport(artifact, report, { evaluationPolicy: SYNTHETIC_POLICY,
    now: NOW, operationalRuns: mixed });
  assert.equal(evaluated.validation.operationalChecksPassed, false);
  assert.equal(evaluated.operationalEvidence.count, 0);
});

test('a reused holdout blocks promotion even beyond the latest benchmark', () => {
  const { artifact, report } = fixture();
  const evaluated = buildLifecycleReport(enrichLifecycleArtifact(artifact), report, { evaluationPolicy: SYNTHETIC_POLICY, now: NOW, operationalRuns: runs(artifact),
    priorBenchmarks: [{ modelVersion: 'C-other', report: { validation: { holdoutMatchIds: ['test-4'] } } }, { modelVersion: 'C-newest', report: {} }] });
  assert.ok(evaluated.warnings.some((warning) => warning.code === 'holdout_reused_by_another_candidate'));
  assert.equal(evaluated.validation.operationalChecksPassed, true);
  assert.equal(evaluated.validation.passed, false);
});

test('the default policy rejects already observed historical periods and legacy operational calibration', () => {
  const raw = fixture(false);
  const legacy = buildLifecycleReport(enrichLifecycleArtifact(raw.artifact), raw.report, { now: NOW });
  assert.ok(legacy.warnings.some((warning) => warning.code === 'legacy_probability_protocol_not_operational'));
  assert.ok(legacy.warnings.some((warning) => warning.code === 'new_independent_future_holdout_required'));
  assert.equal(legacy.validation.passed, false);
  const { artifact, report } = fixture();
  const evaluated = buildLifecycleReport(artifact, report, { now: NOW, operationalRuns: runs(artifact) });
  assert.equal(evaluated.validation.operationalChecksPassed, true);
  assert.equal(evaluated.validation.finalHoldout, false);
  assert.equal(evaluated.validation.passed, false);
});

test('retries of one match or one shared snapshot cannot supply three independent operational checks', () => {
  const { artifact, report } = fixture();
  for (const key of ['matchId', 'snapshotHash']) {
    const repeated = runs(artifact).map((run) => ({ ...run, summary: { ...run.summary, [key]: 'same-evidence' } }));
    const evaluated = buildLifecycleReport(artifact, report, { evaluationPolicy: SYNTHETIC_POLICY, now: NOW, operationalRuns: repeated });
    assert.equal(evaluated.validation.operationalChecksPassed, false, key);
  }
  const preCalibration = runs(artifact).map((run) => ({ ...run,
    summary: { ...run.summary, checks: { ...run.summary.checks, calibrationCompatible: false } } }));
  assert.equal(buildLifecycleReport(artifact, report, { evaluationPolicy: SYNTHETIC_POLICY, now: NOW,
    operationalRuns: preCalibration }).validation.operationalChecksPassed, false);
});

test('a protected evaluation is rejected before scoring outcomes under a new configuration', () => {
  const { artifact, report } = fixture();
  const first = buildLifecycleReport(artifact, report, { now: NOW, operationalRuns: runs(artifact) });
  const poisoned = { ...report, predictions: report.predictions.map((row) => ({ ...row, homeGoals: 999, awayGoals: 999 })) };
  const second = buildLifecycleReport(artifact, poisoned, { now: NOW, operationalRuns: runs(artifact) });
  assert.equal(first.A.n, 0); assert.equal(first.C.n, 0);
  assert.deepEqual(first.A, second.A); assert.deepEqual(first.C, second.C);
  assert.equal(first.validation.passed, false);
});

test('robust final-holdout differences can pass only with measured operations and independent chronology', () => {
  const { artifact, report } = fixture();
  artifact.calibrationPredictions = [];
  const identity = fitResearchCalibration([], artifact.validationThrough);
  artifact.calibrationProfiles = { A: identity, C: identity };
  const matrixA = [[.1, .8], [.05, .05]], matrixC = [[.02, .02], [.9, .06]];
  report.predictions = Array.from({ length: 500 }, (_, index) => ({
    ...report.predictions[index % 35], matchId: `strong-${index}`,
    forecastAt: new Date(Date.UTC(2025, 1, index + 1, 12)).toISOString(),
    kickoffAt: new Date(Date.UTC(2025, 1, index + 1, 12, 15)).toISOString(),
    homeGoals: 1, awayGoals: 0, matrixA, matrixC, probabilitiesA: scoreMatrixMarkets(matrixA),
  }));
  report.finalHoldout = { version: artifact.version, testFrom: report.predictions[0].forecastAt,
    testTo: report.predictions.at(-1).forecastAt };
  const evaluated = buildLifecycleReport(enrichLifecycleArtifact(artifact), report, { evaluationPolicy: SYNTHETIC_POLICY, now: NOW, operationalRuns: runs(artifact) });
  assert.equal(evaluated.validation.nPaired, 500);
  assert.equal(evaluated.validation.passed, true);
  assert.equal(evaluated.validation.comparisonReference, 'model_A');
  assert.ok(evaluated.validation.deltaLogLossCI[1] < 0);
  assert.equal(evaluated.validation.calibrationPassed, true);
  const contaminated = buildLifecycleReport(artifact, report, { evaluationPolicy: SYNTHETIC_POLICY, now: NOW,
    operationalRuns: runs(artifact).map((run) => ({ ...run, summary: { ...run.summary, modelVersion: 'other' } })) });
  assert.equal(contaminated.validation.passed, false);
});

test('an incumbent cannot be silently replaced by A as the comparison reference', () => {
  const { artifact, report } = fixture();
  const previous = enrichLifecycleArtifact({ ...artifact, version: 'C-incumbent' });
  const evaluated = buildLifecycleReport(enrichLifecycleArtifact(artifact), report, { evaluationPolicy: SYNTHETIC_POLICY, now: NOW, operationalRuns: runs(artifact),
    incumbent: { version: previous.version, artifact: previous } });
  assert.equal(evaluated.validation.comparisonReference, 'incumbent');
  assert.equal(evaluated.validation.referenceModelVersion, 'C-incumbent');
  assert.equal(evaluated.validation.passed, false);
  assert.ok(evaluated.warnings.some((warning) => warning.code === 'unavailable_or_future_calibration_or_incumbent'));
});

test('candidate registration does not enable a market or promote a weak sample', async () => {
  const { artifact, report } = fixture();
  const savedModels = [], markets = [], reports = [], summaries = [];
  let promotions = 0;
  const db = { research: { saveModel: async (model) => savedModels.push(model), getChampion: async () => null,
    listBenchmarks: async () => [], saveBenchmark: async (value) => { reports.push(value); return { id: 'benchmark-fixture', validated: 0 }; },
    listMarkets: async () => [], setMarketState: async (market) => markets.push(market), promoteModel: async () => { promotions++; } },
    listRecentSchedulerRuns: async () => [], saveSchedulerRun: async (summary) => summaries.push(summary) };
  const registered = await registerLifecycleCandidate(db, { artifact, report, now: NOW });
  assert.equal(savedModels.length, 2);
  assert.equal(promotions, 0);
  assert.equal(registered.promoted, false);
  assert.ok(markets.length >= 8);
  assert.ok(markets.every((market) => market.state === 'EXPERIMENTAL'));
  assert.equal(reports[0].report.validation.nPaired, 0);
  assert.ok(reports[0].report.warnings.some((warning) => warning.code === 'new_independent_future_holdout_required'));
  assert.equal(summaries[0].schedulerName, 'research_training');
});

test('three consecutive champion failures restore only its previously approved predecessor', async () => {
  const { artifact } = fixture();
  let rollback;
  const db = { research: { getChampion: async () => ({ version: artifact.version }),
    listMarkets: async () => [], setMarketState: async () => {},
    listModelEvents: async () => [{ version: 'C-before', previousVersion: null, action: 'PROMOTE' },
      { version: artifact.version, previousVersion: 'C-before', action: 'PROMOTE' }],
    rollbackModel: async (value) => { rollback = value; } },
    listRecentSchedulerRuns: async () => runs(artifact, false), saveSchedulerRun: async () => {} };
  const result = await rollbackUnhealthyChampion(db, NOW);
  assert.equal(result.rolledBack, true);
  assert.equal(rollback.version, 'C-before');
  assert.match(rollback.reason, /three consecutive/);
  db.listRecentSchedulerRuns = async () => [runs(artifact, true)[0], ...runs(artifact, false).slice(1)];
  assert.equal((await rollbackUnhealthyChampion(db, NOW)).rolledBack, false);
});

test('a failing first champion never rolls back to an unapproved model', async () => {
  const { artifact } = fixture();
  const suspensions = [];
  const db = { research: { getChampion: async () => ({ version: artifact.version }),
    listMarkets: async () => [{ market: '1x2', state: 'ACTIVE' }], setMarketState: async (input) => suspensions.push(input),
    listModelEvents: async () => [{ version: artifact.version, previousVersion: null, action: 'PROMOTE' }],
    rollbackModel: async () => assert.fail('unapproved fallback') },
    listRecentSchedulerRuns: async () => runs(artifact, false), saveSchedulerRun: async () => {} };
  assert.deepEqual(await rollbackUnhealthyChampion(db, NOW), { rolledBack: false, suspended: true, reason: 'no_previously_approved_champion' });
  assert.equal(suspensions[0].state, 'SUSPENDED');
  assert.equal(suspensions[0].modelVersion, artifact.version);
});

test('three retries of a failed match cannot trigger a champion rollback', async () => {
  const { artifact } = fixture();
  const db = { research: { getChampion: async () => ({ version: artifact.version }),
    listModelEvents: async () => [], rollbackModel: async () => assert.fail('retry is not independent evidence') },
  listRecentSchedulerRuns: async () => runs(artifact, false).map((run) => ({ ...run,
    summary: { ...run.summary, matchId: 'one-failed-match' } })), saveSchedulerRun: async () => {} };
  assert.deepEqual(await rollbackUnhealthyChampion(db, NOW), { rolledBack: false, reason: 'no_repeated_model_failure' });
});
