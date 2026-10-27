const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { predictCatBoostJson, predictHybrid, jointMarketProbabilities, validateArtifact } = require('../dist/research/CatBoostModel');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION } = require('../dist/research/ForecastCore');

const constantModel = (bias) => ({ features_info: { float_features: [] }, oblivious_trees: [], scale_and_bias: [1, bias] });
function input() {
  return { featureSchema: FEATURE_SCHEMA_VERSION, featureNames: FEATURE_NAMES, features: FEATURE_NAMES.map(() => 0),
    baselineMatrix: [[0.2, 0.1, 0.05], [0.15, 0.15, 0.05], [0.15, 0.1, 0.05]],
    baselineVersion: 'A-test', lambdaHome: 1.3, lambdaAway: 0.8, forecastAt: '2025-02-01T12:00:00Z' };
}
function artifact() {
  return { family: 'C', version: 'C-test', featureSchema: FEATURE_SCHEMA_VERSION, featureNames: FEATURE_NAMES,
    trainedThrough: '2024-12-01T00:00:00Z', validationThrough: '2025-01-01T00:00:00Z',
    createdAt: '2025-01-02T00:00:00Z', candidateKind: 'intensity_correction', baselineVersion: 'A-test',
    weight: 0.5, temperature: 1, models: { home: constantModel([0.3]), away: constantModel([-0.2]) } };
}

test('numeric CatBoost inference honors border bits, output dimensions and scale/bias', () => {
  const model = { features_info: { float_features: [{ feature_index: 0, flat_feature_index: 1 }] },
    oblivious_trees: [{ splits: [{ split_type: 'FloatFeature', float_feature_index: 0, border: 1.5 }], leaf_values: [1, 2, 3, 4, 5, 6] }],
    scale_and_bias: [2, [0.1, 0.2, 0.3]] };
  assert.deepEqual(predictCatBoostJson(model, [9, 1]), [2.1, 4.2, 6.3]);
  assert.deepEqual(predictCatBoostJson(model, [9, 2]), [8.1, 10.2, 12.3]);
  assert.deepEqual(predictCatBoostJson(model, [9, 1.50000001]), [2.1, 4.2, 6.3]);
  assert.throws(() => predictCatBoostJson(model, [NaN, 2]), /non_finite/);
});

test('C really changes the joint distribution while preserving market identities', () => {
  const prediction = predictHybrid(input(), artifact());
  assert.notDeepEqual(prediction.matrix, input().baselineMatrix);
  assert.ok(Math.abs(prediction.matrix.flat().reduce((a, b) => a + b) - 1) < 1e-12);
  const p = prediction.probabilities;
  assert.ok(Math.abs(p.homeWin + p.draw + p.awayWin - 1) < 1e-12);
  assert.ok(Math.abs(p.over25 + p.under25 - 1) < 1e-12);
  assert.ok(Math.abs(p.btts + p.bttsNo - 1) < 1e-12);
  assert.ok(Math.abs(p.double_chance_1x - p.homeWin - p.draw) < 1e-12);
  assert.throws(() => predictHybrid({ ...input(), forecastAt: '2024-12-31T00:00:00Z' }, artifact()), /not_available/);
  assert.throws(() => validateArtifact({ ...artifact(), weight: -0.01 }), /invalid/);
});

test('zero ML contribution with unit temperature reproduces A joint probabilities', () => {
  const baseline = input();
  const prediction = predictHybrid(baseline, { ...artifact(), weight: 0, temperature: 1 });
  const expected = jointMarketProbabilities(baseline.baselineMatrix);
  for (const key of ['homeWin', 'draw', 'awayWin', 'over25', 'btts']) {
    assert.ok(Math.abs(prediction.probabilities[key] - expected[key]) < 1e-12, key);
  }
  assert.notDeepEqual(predictHybrid(baseline, { ...artifact(), weight: 0, temperature: .8 }).matrix, prediction.matrix);
});

const python = process.env.ML_PYTHON ?? 'python';
const hasCatBoost = spawnSync(python, ['-c', 'import catboost; assert catboost.__version__ == "1.2.8"'], { encoding: 'utf8', timeout: 20000 }).status === 0;
test('real CatBoost training compares three candidates and exported JSON matches Python inference', { skip: !hasCatBoost, timeout: 180000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'footpredictor-catboost-test-'));
  try {
    const base = input();
    // Explicit synthetic test fixture, never production evidence or a historical performance claim.
    const rows = Array.from({ length: 150 }, (_, i) => {
      const forecastAt = new Date(Date.UTC(2023, 0, i + 1, 12)).toISOString();
      return { ...base, matchId: `synthetic-test-${i}`, competition: ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'][i % 5],
        forecastAt, kickoffAt: new Date(Date.parse(forecastAt) + 15 * 60000).toISOString(),
        availableAt: new Date(Date.parse(forecastAt) + 135 * 60000).toISOString(), modelFitAt: '2022-12-01T00:00:00Z',
        maxTrainingAvailableAt: '2022-12-01T00:00:00Z', features: base.features.map((_, j) => (i + j) % 7 / 7),
        baselineProbabilities: jointMarketProbabilities(base.baselineMatrix), homeGoals: i % 3, awayGoals: i % 3 === 2 ? 0 : 1 };
    });
    const datasetPath = join(directory, 'dataset.json');
    writeFileSync(datasetPath, JSON.stringify({ schemaVersion: FEATURE_SCHEMA_VERSION, featureNames: FEATURE_NAMES,
      baselineManifest: { version: 'A-test', fixture: true }, rows }));
    const processResult = spawnSync(python, [resolve(__dirname, '../ml/train.py'), '--input', datasetPath,
      '--output', join(directory, 'output'), '--iterations', '5', '--depth', '2', '--folds', '2'], { encoding: 'utf8', timeout: 150000 });
    assert.equal(processResult.status, 0, processResult.stderr || processResult.stdout);
    const trained = JSON.parse(readFileSync(join(directory, 'output/artifact.json'), 'utf8'));
    validateArtifact(trained);
    assert.equal(trained.candidateComparisons.length, 3);
    assert.equal(trained.productionValidated, false);
    const parity = JSON.parse(readFileSync(join(directory, 'output/parity.json'), 'utf8'));
    for (const row of parity.rows) for (const [name, expected] of Object.entries(row.raw)) {
      const actual = predictCatBoostJson(trained.models[name], row.features);
      actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9));
    }
    for (const row of parity.rows) for (const [kind, bundle] of Object.entries(row.rawByCandidate)) {
      for (const [name, expected] of Object.entries(bundle)) {
        const actual = predictCatBoostJson(parity.candidateModels[kind][name], row.features);
        actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9));
      }
    }
    const report = JSON.parse(readFileSync(join(directory, 'output/report.json'), 'utf8'));
    assert.equal(report.folds.length, 2);
    assert.equal(report.conclusion, 'inconclusive');
    assert.ok(report.predictions.every((row) => Date.parse(row.validationThrough) < Date.parse(row.forecastAt)));
    assert.equal(new Set(report.predictions.map((row) => row.matchId)).size, report.predictions.length);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
