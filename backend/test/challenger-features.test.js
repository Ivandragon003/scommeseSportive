const test = require('node:test');
const assert = require('node:assert/strict');
if (process.env.RESEARCH_SOURCE_TESTS === '1') require('ts-node/register/transpile-only');
const moduleRoot = process.env.RESEARCH_SOURCE_TESTS === '1' ? '../src/research/' : '../dist/research/';
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = require(moduleRoot + 'ForecastCore');
const { CHALLENGER_FEATURE_SCHEMA_VERSION, CHALLENGER_FEATURE_PROTOCOL, challengerFeatureNames,
  withChallengerFeatures, extendChallengerTrainingDataset, buildChallengerTrainingDataset } = require(moduleRoot + 'ChallengerFeatures');
const { validateArtifact, predictHybrid } = require(moduleRoot + 'CatBoostModel');
const { ORIGINAL_HOLDOUT_POLICY } = require(moduleRoot + 'ResearchHoldoutPolicy');

const kickoff = '2026-01-20T19:00:00Z', forecast = '2026-01-20T02:07:00Z';
const input = () => ({ matchId: 'target', homeTeamId: 'home', awayTeamId: 'away', competition: 'Serie A',
  forecastAt: forecast, kickoffAt: kickoff, features: FEATURE_NAMES.map(() => .2), featureNames: [...FEATURE_NAMES],
  featureSchema: FEATURE_SCHEMA_VERSION, baselineMatrix: [[.2, .2], [.3, .3]], baselineProbabilities: { homeWin: .3, draw: .5, awayWin: .2 },
  baselineVersion: 'A-fixture', lambdaHome: 1.2, lambdaAway: .9, modelFitAt: '2026-01-19T01:00:00Z',
  maxTrainingAvailableAt: '2026-01-19T00:00:00Z', trainingCount: 50 });
const match = (id, date, home, away, homeXG = 1, awayXG = 1) => ({ matchId: id, date, homeTeamId: home,
  awayTeamId: away, competition: 'Serie A', homeGoals: 1, awayGoals: 0, homeXG, awayXG });
const history = () => [
  ...Array.from({ length: 8 }, (_, i) => match(`opponent-${i}`, `2025-12-${String(i + 1).padStart(2, '0')}T15:00:00Z`, 'opponent', `other-${i}`, 3, .5)),
  match('prior-home', '2026-01-13T15:00:00Z', 'home', 'opponent', 2, 1),
  match('prior-away', '2026-01-18T15:00:00Z', 'other', 'away', 1.5, .7),
];
const values = (row) => Object.fromEntries(row.featureNames.map((name, i) => [name, row.features[i]]));

test('C feature blocks extend a clone without changing A features, probabilities or baseline identity', () => {
  const base = input(), before = JSON.stringify(base), manifest = baselineManifest();
  const extended = withChallengerFeatures(base, history());
  assert.equal(JSON.stringify(base), before);
  assert.deepEqual(baselineManifest(), manifest);
  assert.equal(extended.featureSchema, CHALLENGER_FEATURE_SCHEMA_VERSION);
  assert.deepEqual(extended.featureNames, challengerFeatureNames());
  assert.deepEqual(extended.features.slice(0, FEATURE_NAMES.length), base.features);
  assert.equal(extended.baselineMatrix, base.baselineMatrix);
  assert.equal(extended.baselineProbabilities, base.baselineProbabilities);
  assert.ok(extended.features.every(Number.isFinite));
  const data = values(extended);
  assert.equal(data.home_recent_xg_for, 2);
  assert.notEqual(data.home_recent_adjusted_xg_for, data.home_recent_xg_for);
  assert.equal(data.home_observed_matches_14d, 1);
  assert.equal(data.away_observed_matches_7d, 1);
  assert.ok(Date.parse(extended.challengerFeatureMetadata.maxHistoryAvailableAt) <= Date.parse(forecast));
});

test('target scores, future labels and delayed observations never enter C features', () => {
  const base = input(), previous = history(), expected = withChallengerFeatures(base, previous);
  const unseen = [match('future', '2026-01-21T12:00:00Z', 'home', 'away', 90, 90),
    { ...match('target', kickoff, 'home', 'away', 100, 100), homeGoals: 99 },
    { ...match('delayed', '2026-01-19T15:00:00Z', 'home', 'away', 80, 80), availableAt: '2026-01-21T00:00:00Z' },
    match('not-yet-final', '2026-01-20T01:00:00Z', 'home', 'away', 70, 70)];
  assert.deepEqual(withChallengerFeatures(base, [...previous, ...unseen]), expected);
  assert.deepEqual(withChallengerFeatures(base, [...previous, ...unseen.map(row => ({ ...row, homeGoals: 12, homeXG: 300 }))]), expected);
  assert.throws(() => withChallengerFeatures({ ...base, forecastAt: kickoff }, previous), /forecast_context/);
  assert.throws(() => withChallengerFeatures(base, previous, ['unknown']), /feature_blocks/);
});

test('opponent adjustment uses only strength known before the historical match', () => {
  const first = history(), laterOpponent = match('later-opponent', '2026-01-18T12:00:00Z', 'opponent', 'outside', 99, 99);
  const before = values(withChallengerFeatures(input(), first));
  const after = values(withChallengerFeatures(input(), [...first, laterOpponent]));
  assert.equal(after.home_recent_adjusted_xg_for, before.home_recent_adjusted_xg_for);
  assert.equal(after.home_recent_adjusted_xg_against, before.home_recent_adjusted_xg_against);
});

test('block ablations are explicit and protected target rows are excluded before training', () => {
  const base = input(), ids = ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds;
  const row = { ...base, homeGoals: 1, awayGoals: 0, availableAt: '2026-01-20T21:00:00Z' };
  const timing = { policy: 'nightly-03:07-Europe-Rome-v1', resultDelayMs: 7200000, forecastBeforeKickoff: true };
  const dataset = { schemaVersion: FEATURE_SCHEMA_VERSION, featureNames: FEATURE_NAMES, rows: [row, { ...row, matchId: ids[0] }],
    asOf: '2026-01-21T00:00:00Z', baselineManifest: baselineManifest(), exclusions: {}, forecastTiming: timing };
  const extended = extendChallengerTrainingDataset(dataset, history(), ['schedule']);
  assert.equal(extended.rows.length, 1);
  assert.equal(extended.protectedMatchesExcluded, 1);
  assert.deepEqual(extended.featureNames, challengerFeatureNames(['schedule']));
  assert.deepEqual(extended.forecastTiming, timing);
  let calls = 0;
  const built = buildChallengerTrainingDataset([match('target', kickoff, 'home', 'away'),
    match(ids[0], kickoff, 'home', 'away')], '2026-01-21T00:00:00Z', {
    forecastAt: () => forecast, forecastPolicy: timing.policy,
    forecastBuilder: (_history, target, at) => { calls++; assert.equal(at, forecast); return { ...base, matchId: target.matchId }; },
  });
  assert.equal(calls, 1);
  assert.equal(built.rows.length, 1);
  assert.equal(built.rows[0].forecastAt, forecast);
  assert.equal(built.protectedMatchesExcluded, 1);
});

test('C runtime accepts versioned features and keeps legacy artifacts loadable', () => {
  const base = input(), extended = withChallengerFeatures(base, history());
  const range = (from, to) => ({ n: 10, from: `${from}T00:00:00Z`, to: `${to}T00:00:00Z`, availableThrough: `${to}T02:00:00Z` });
  const artifact = { version: 'C-feature-fixture', family: 'C', featureSchema: CHALLENGER_FEATURE_SCHEMA_VERSION,
    featureNames: extended.featureNames, featureBlocks: extended.featureBlocks, featureProtocol: CHALLENGER_FEATURE_PROTOCOL,
    trainedThrough: '2025-01-02T02:00:00Z', validationThrough: '2025-03-02T02:00:00Z', createdAt: '2026-01-19T00:00:00Z',
    candidateKind: 'no_ml', weight: 0, temperature: 1, models: {}, baselineVersion: 'A-fixture',
    trainingForecastTiming: { policy: 'nightly-fixture', resultDelayMs: 7200000, forecastBeforeKickoff: true },
    trainingSplit: { protocol: 'purged-temporal-train-selection-calibration-test-v1', train: range('2025-01-01', '2025-01-02'),
      selection: range('2025-02-01', '2025-02-02'), calibration: range('2025-03-01', '2025-03-02'), test: range('2025-04-01', '2025-04-02') } };
  validateArtifact(artifact);
  const prediction = predictHybrid(extended, artifact);
  assert.ok(Math.abs(prediction.matrix.flat().reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.throws(() => validateArtifact({ ...artifact, featureNames: [...extended.featureNames, 'invented'] }), /invalid/);
  assert.throws(() => validateArtifact({ ...artifact, trainingForecastTiming: undefined }), /metadata/);
  assert.throws(() => validateArtifact({ ...artifact, weight: .1 }), /no_ml/);
  const constant = { features_info: { float_features: [] }, oblivious_trees: [], scale_and_bias: [1, [0]] };
  const legacy = { ...artifact, featureSchema: FEATURE_SCHEMA_VERSION, featureNames: FEATURE_NAMES,
    candidateKind: 'calibrated_ensemble', weight: .75, temperature: .8, models: { home: constant, away: constant } };
  validateArtifact(legacy);
  assert.ok(predictHybrid(base, legacy).matrix.length);
  const extendedTree = { features_info: { float_features: [{ feature_index: 0, flat_feature_index: extended.features.length - 1 }] },
    oblivious_trees: [{ splits: [{ split_type: 'FloatFeature', float_feature_index: 0, border: .5 }], leaf_values: [0, .2] }],
    scale_and_bias: [1, [0]] };
  const correction = { ...artifact, candidateKind: 'intensity_correction', weight: .25,
    models: { home: extendedTree, away: constant } };
  validateArtifact(correction);
  assert.notDeepEqual(predictHybrid(extended, correction).matrix, prediction.matrix);
});
