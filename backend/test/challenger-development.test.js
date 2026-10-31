const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateChallengerDevelopment, challengerDevelopmentMarkdown, admissibleNightlyDevelopmentQuotes } = require('../dist/research/ChallengerDevelopment');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = require('../dist/research/ForecastCore');
const { resolveNightlyForecastAt } = require('../dist/research/ForecastDecisionTime');
const { ORIGINAL_HOLDOUT_POLICY } = require('../dist/research/ResearchHoldoutPolicy');
const { buildChallengerRecommendation } = require('../dist/research/ChallengerRecommendation');
const { applyCoherentProbabilityPipeline, coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../dist/research/CoherentProbabilityPipeline');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');
const { main, argumentsOf } = require('../scripts/research-challenger-development');
const { writeFileSync, readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const matrix = [[.2, .1], [.6, .1]];
const plan = () => ({ asOf: '2026-10-31T12:00:00Z', developmentFrom: '2026-10-01T00:00:00Z',
  developmentUntil: '2026-10-26T00:00:00Z', independentFrom: '2026-10-28T00:00:00Z', allowedMarkets: ['1x2', 'totals', 'asian_handicap'], bootstrapSamples: 30 });
function row(matchId, kickoffAt = '2026-10-20T18:00:00Z', patch = {}) {
  const forecastAt = resolveNightlyForecastAt(kickoffAt);
  const features = FEATURE_NAMES.map((name) => name.endsWith('_sample') ? 30 : name.endsWith('_xg_coverage') ? 1 : 0);
  return { matchId, competition: 'Serie A', season: '2026/27', kickoffAt, forecastAt,
    homeTeamId: 'home', awayTeamId: 'away', features, featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
    baselineMatrix: matrix, baselineProbabilities: { homeWin: .6, draw: .3, awayWin: .1 }, lambdaHome: 1.4, lambdaAway: 1.1,
    modelFitAt: new Date(Date.parse(forecastAt) - 3600000).toISOString(), maxTrainingAvailableAt: new Date(Date.parse(forecastAt) - 7200000).toISOString(),
    trainingCount: 60, baselineVersion: baselineManifest().version, homeGoals: 1, awayGoals: 0,
    availableAt: new Date(Date.parse(kickoffAt) + 7200000).toISOString(), ...patch };
}
const noMl = (id = 'no_ml', selectionPolicy = 'legacy-c906') => ({ id, role: 'no_ml', selectionPolicy });
function artifact(patch = {}) {
  return { version: 'C-development-fixture', family: 'C', featureSchema: FEATURE_SCHEMA_VERSION, featureNames: FEATURE_NAMES,
    trainedThrough: '2026-09-01T00:00:00Z', validationThrough: '2026-09-15T00:00:00Z', createdAt: '2026-09-20T00:00:00Z',
    candidateKind: 'intensity_correction', weight: .25, temperature: 1, baselineVersion: baselineManifest().version,
    models: { home: { oblivious_trees: [{ leaf_values: [.1] }], scale_and_bias: [1, [0]] },
      away: { oblivious_trees: [{ leaf_values: [-.1] }], scale_and_bias: [1, [0]] } }, ...patch };
}
function quotes(forecastAt, extra = {}) {
  return [['homeWin', 'home', 2], ['draw', 'draw', 4], ['awayWin', 'away', 4]].map(([selection, side, odds]) =>
    ({ selection, side, odds, market: '1x2', bookmaker: 'Actual fixture operator', source: 'odds_api', priceType: 'prematch',
      capturedAt: forecastAt, updatedAt: forecastAt, ...extra }));
}

test('all valid matches including NO_BET contribute probability metrics and paired comparisons deterministically', () => {
  const rows = [row('one'), row('two', '2026-10-10T18:00:00Z'), row('three', '2026-10-01T18:00:00Z')];
  const input = { rows, variants: [noMl(), noMl('same_baseline')], plan: plan() };
  const report = evaluateChallengerDevelopment(input);
  assert.deepEqual(report, evaluateChallengerDevelopment(input));
  assert.equal(report.variants.no_ml.byPhase.development.metrics.n, 3);
  assert.ok(Math.abs(report.variants.no_ml.byPhase.development.metrics.logLoss + Math.log(.6)) < 1e-12);
  assert.ok(Math.abs(report.variants.no_ml.byPhase.development.metrics.brier - .26) < 1e-12);
  assert.equal(report.variants.no_ml.byPhase.development.economics.modelNoBetMatches, 3);
  assert.equal(report.variants.no_ml.byPhase.development.economics.roi, null);
  assert.equal(report.variants.no_ml.byPhase.development.economics.maxDrawdownFraction, null);
  assert.equal(report.comparisons[0].byPhase.development.n, 3);
  assert.deepEqual(report.comparisons[0].byPhase.development.uncertainty.logLoss95, [0, 0]);
  assert.equal(report.holdout.certificationEligible, false);
});

test('protected exposed matches, T-15 inputs and future feature/model information cannot enter optimization metrics', () => {
  const rows = [row(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds[0]),
    row('t15', undefined, { forecastAt: '2026-10-20T17:45:00Z' }),
    row('future_baseline', undefined, { maxTrainingAvailableAt: '2026-10-20T12:00:00Z' }),
    row('future_extra', undefined, { challengerFeatureMetadata: { maxHistoryAvailableAt: '2026-10-20T12:00:00Z' } })];
  const report = evaluateChallengerDevelopment({ rows, variants: [noMl(), noMl('control')], plan: plan() });
  assert.equal(report.holdout.protectedRowsExcluded, 1);
  assert.equal(report.coverage.invalidRows, 3);
  assert.equal(report.variants.no_ml.byPhase.development.metrics.n, 0);
  assert.ok(report.records.every((record) => !Object.keys(record.predictions).length));
  assert.throws(() => evaluateChallengerDevelopment({ rows: [row('duplicate'), row('duplicate')], variants: [noMl(), noMl('control')], plan: plan() }), /duplicate/);
});

test('closing, future, stale and observation-only prices never become admissible Nightly entries', () => {
  const input = row('freshness');
  for (const patch of [{ priceType: 'closing' }, { source: 'odds_api_plus_model_completion' }, { usedSyntheticOdds: true },
    { updatedAt: new Date(Date.parse(input.forecastAt) - 300001).toISOString() },
    { capturedAt: new Date(Date.parse(input.forecastAt) + 1).toISOString() }, { timestampEvidence: 'observed_snapshot' }]) {
    assert.equal(admissibleNightlyDevelopmentQuotes(quotes(input.forecastAt, patch), input.forecastAt, ['1x2']).quotes.length, 0);
  }
  const report = evaluateChallengerDevelopment({ rows: [input], variants: [noMl(), noMl('control')], plan: plan(),
    quotesByMatch: { freshness: quotes(input.forecastAt, { priceType: 'closing' }) } });
  assert.equal(report.records[0].admissibleQuoteCount, 0);
  assert.equal(report.variants.no_ml.byPhase.development.economics.roi, null);
});

test('actual current artifact is never backdated; development reconstructions stay separate from independent periods', () => {
  const late = artifact({ createdAt: '2026-10-31T00:00:00Z' });
  const rows = [row('development'), row('future_period', '2026-10-30T18:00:00Z')];
  const variants = [noMl(), { id: 'actual_current', role: 'current', artifact: late, availability: 'retrospective_development' },
    { id: 'development_replica', role: 'candidate', artifact: late, availability: 'retrospective_development' }];
  const report = evaluateChallengerDevelopment({ rows, variants, plan: plan() });
  assert.equal(report.variants.actual_current.byPhase.development.metrics.n, 0);
  assert.equal(report.variants.development_replica.byPhase.development.metrics.n, 1);
  assert.equal(report.variants.development_replica.byPhase.independent_period.metrics.n, 0);
  assert.equal(report.records.find((record) => record.matchId === 'development').predictions.development_replica.retrospective, true);
  assert.equal(report.comparisons.find((pair) => pair.right === 'development_replica').byPhase.independent_period.n, 0);
});

test('legacy selector exactly matches the operational C selector and payout policy changes only selection', () => {
  const input = row('selector');
  const sheet = quotes(input.forecastAt);
  const variants = [noMl('legacy'), noMl('payout', 'payout-aware-v1')];
  const report = evaluateChallengerDevelopment({ rows: [input], variants, plan: plan(), quotesByMatch: { selector: sheet } });
  const pipeline = applyCoherentProbabilityPipeline({ matrix, quotes: sheet, forecastAt: input.forecastAt, mode: 'identity' });
  const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion: input.baselineVersion,
    pipelineHashV2: coherentProbabilityPipelineHash(), mode: 'identity' });
  const actual = buildChallengerRecommendation({ decision: { family: 'C', modelVersion: 'C-statistical-no-ml-comparator', validated: true,
    action: 'ABSTAIN', probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, calibrationPipelineHash: coherentProbabilityPipelineHash(),
    probabilityConfiguration: configuration.descriptor, probabilityConfigurationHash: configuration.hash,
    calibrationAvailableAt: input.modelFitAt, prospectiveMatrix: pipeline.matrix, probabilityStages: { decision: pipeline.decision } },
  quotes: sheet, observedAt: input.forecastAt, allowedMarkets: plan().allowedMarkets,
  expectedIdentity: { modelVersion: 'C-statistical-no-ml-comparator', baselineVersion: input.baselineVersion,
    probabilityConfigurationHash: configuration.hash }, selectionPolicy: 'legacy-c906', competition: input.competition });
  assert.equal(report.records[0].predictions.legacy.selected?.quote.selection ?? null, actual.selected?.selection ?? null);
  assert.equal(report.records[0].predictions.legacy.matrixHash, report.records[0].predictions.payout.matrixHash);
  assert.deepEqual(report.records[0].predictions.legacy.probabilities, report.records[0].predictions.payout.probabilities);
  assert.equal(report.variants.payout.selectionPolicy, 'payout-aware-v1');
  assert.equal(report.variants.legacy.byPhase.development.economics.eligibleQuoteMatches, 1);
});

test('out-of-sample folds are explicit and every pair uses its exact common rows, not different cohorts', () => {
  const rows = [row('first', '2026-10-10T18:00:00Z'), row('second')];
  const variants = [noMl(), { id: 'folds', role: 'ablation', folds: [
    { artifact: artifact(), from: '2026-10-15T00:00:00Z', until: '2026-10-26T00:00:00Z' },
  ] }];
  const report = evaluateChallengerDevelopment({ rows, variants, plan: plan() });
  assert.equal(report.variants.no_ml.byPhase.development.metrics.n, 2);
  assert.equal(report.variants.folds.byPhase.development.metrics.n, 1);
  assert.equal(report.comparisons[0].byPhase.development.n, 1);
  assert.equal(report.comparisons[0].byPhase.development.left.n, 1);
  assert.equal(report.comparisons[0].byPhase.development.right.n, 1);
  assert.equal(report.records.find((record) => record.matchId === 'first').predictionExclusions.folds, 'variant_fold_not_uniquely_available');
});

test('the no-ML arm supports its frozen calibration and fold through the same coherent C pipeline', () => {
  const input = row('calibrated-control');
  const profile = { protocol: 'existing-isotonic-v1', targetProtocol: 'joint_1x2_normalized-v2',
    nObservations: 3000, matches: 1000, fittedThrough: '2026-09-15T00:00:00Z',
    calibrationPoints: [{ x: 0, y: 0 }, { x: .1, y: .05 }, { x: .3, y: .2 }, { x: .6, y: .9 }, { x: 1, y: 1 }],
    byFamily: {}, learnedBlendWeights: {} };
  const control = artifact({ candidateKind: 'no_ml', weight: 0, temperature: 1, models: {},
    probabilityCalibrationMode: 'isotonic_1x2', calibrationProfilesV2: { C: profile } });
  const variants = [noMl('bare'), { id: 'calibrated_no_ml', role: 'no_ml', selectionPolicy: 'payout-aware-v1', folds: [
    { artifact: control, from: '2026-10-01T00:00:00Z', until: '2026-10-26T00:00:00Z' },
  ] }];
  const report = evaluateChallengerDevelopment({ rows: [input], variants, plan: plan() });
  const expected = applyCoherentProbabilityPipeline({ matrix, quotes: [], forecastAt: input.forecastAt, mode: 'isotonic_1x2', profile });
  assert.deepEqual(report.records[0].predictions.calibrated_no_ml.probabilities,
    ['homeWin', 'draw', 'awayWin'].map((key) => expected.decision[key]));
  assert.notDeepEqual(report.records[0].predictions.calibrated_no_ml.probabilities, report.records[0].predictions.bare.probabilities);
  assert.equal(report.comparisons[0].byPhase.development.n, 1);
  assert.equal(report.variants.calibrated_no_ml.pipelineSource, 'artifact_calibration_and_same_coherent_pipeline');
  assert.throws(() => evaluateChallengerDevelopment({ rows: [input], variants: [noMl(), {
    id: 'false_no_ml', role: 'no_ml', artifact: artifact(),
  }], plan: plan() }), /invalid_challenger_development_variants/);
});

test('local reporter emits hashes, command reproduction and explicit ROI/holdout limits without a database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'challenger-development-'));
  try {
    const dataset = join(directory, 'dataset.json'), config = join(directory, 'plan.json'), variants = join(directory, 'variants.json');
    const out = join(directory, 'report.json'), markdown = join(directory, 'report.md');
    writeFileSync(dataset, JSON.stringify({ rows: [row('cli')] })); writeFileSync(config, JSON.stringify(plan()));
    writeFileSync(variants, JSON.stringify([noMl(), noMl('control')]));
    const result = main(['evaluate', '--dataset', dataset, '--plan', config, '--variants', variants, '--out', out, '--markdown', markdown]);
    assert.equal(result.records, 1); assert.equal(result.certificationEligible, false);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.match(report.provenance.datasetFileHash, /^[a-f0-9]{64}$/);
    assert.match(challengerDevelopmentMarkdown(report), /745/);
    const text = readFileSync(markdown, 'utf8');
    assert.match(text, /research-challenger-development\.js evaluate/); assert.match(text, /n\/d/);
    assert.throws(() => argumentsOf(['evaluate', '--unknown', 'value']));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
