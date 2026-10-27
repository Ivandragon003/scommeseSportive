// Offline Linux inference check. Inputs are private local artifacts, never credentials.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { performance } = require('node:perf_hooks');
const { predictHybrid, predictCatBoostJson, validateArtifact } = require('../dist/research/CatBoostModel');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION } = require('../dist/research/ForecastCore');

const args = process.argv.slice(2);
const argument = (name) => args[args.indexOf(name) + 1];
if (!args.includes('--artifact') || !args.includes('--parity')) {
  throw new Error('Usage: node scripts/research-ml-smoke.js --artifact <artifact.json> --parity <parity.json>');
}
const cpuStart = process.cpuUsage(), startedAt = performance.now();
const artifact = JSON.parse(readFileSync(argument('--artifact'), 'utf8'));
const parity = JSON.parse(readFileSync(argument('--parity'), 'utf8'));
assert.notEqual(artifact.diagnosticOnly, true, 'A diagnostic artifact cannot establish operational compatibility');
validateArtifact(artifact);
const loadedAt = performance.now();
let comparisons = 0, maxAbsoluteError = 0;
for (const row of parity.rows) {
  for (const [kind, bundle] of Object.entries(row.rawByCandidate)) {
    for (const [name, expected] of Object.entries(bundle)) {
      const actual = predictCatBoostJson(parity.candidateModels[kind][name], row.features);
      actual.forEach((value, index) => {
        const error = Math.abs(value - expected[index]);
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
        assert.ok(error < 1e-9, `${kind}/${name} differs from native CatBoost`);
        comparisons++;
      });
    }
  }
}
const marginal = (lambda) => {
  const values = [Math.exp(-lambda)];
  for (let i = 1; i <= 10; i++) values.push(values[i - 1] * lambda / i);
  return values;
};
const home = marginal(1.5), away = marginal(1.1);
const baselineMatrix = home.map((h) => away.map((a) => h * a));
const input = { featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
  features: parity.rows[0].features, baselineMatrix, baselineVersion: artifact.baselineVersion,
  lambdaHome: 1.5, lambdaAway: 1.1,
  forecastAt: new Date(Math.max(Date.parse(artifact.validationThrough), Date.parse(artifact.createdAt)) + 86400000).toISOString() };
assert.equal(input.features.length, FEATURE_NAMES.length);
const prediction = predictHybrid(input, artifact);
assert.notDeepEqual(prediction.matrix, baselineMatrix, 'The complete C path must execute a nonzero correction');
assert.ok(Object.values(prediction.probabilities).every((p) => Number.isFinite(p) && p >= 0 && p <= 1));
assert.ok(Math.abs(prediction.matrix.flat().reduce((a, b) => a + b, 0) - 1) < 1e-9);
assert.throws(() => predictHybrid({ ...input, features: input.features.map(() => NaN) }, artifact));
assert.throws(() => predictHybrid({ ...input, featureSchema: 'invalid-test-schema' }, artifact), /schema_mismatch/);
assert.throws(() => validateArtifact({ ...artifact, models: {} }), /invalid_hybrid_models/);
assert.throws(() => predictHybrid({ ...input, forecastAt: artifact.validationThrough }, artifact), /not_available/);
for (let i = 0; i < 30; i++) predictHybrid(input, artifact);
const times = [];
for (let i = 0; i < 1000; i++) {
  const before = performance.now(); predictHybrid(input, artifact); times.push(performance.now() - before);
}
const batchStarted = performance.now();
for (let i = 0; i < 20; i++) predictHybrid(input, artifact);
const batch20Ms = performance.now() - batchStarted;
times.sort((a, b) => a - b);
const cpu = process.cpuUsage(cpuStart);
console.log(JSON.stringify({ evidence: 'offline technical inference; simulated baseline; no betting-performance claim',
  platform: process.platform, architecture: process.arch, node: process.version,
  modelVersion: artifact.version, productionValidated: artifact.productionValidated === true,
  diagnosticOnly: artifact.diagnosticOnly === true,
  artifactBytes: Buffer.byteLength(JSON.stringify(artifact)), trees: Object.fromEntries(Object.entries(artifact.models).map(([name, model]) => [name, model.oblivious_trees.length])),
  modelLoadMs: loadedAt - startedAt, parityComparisons: comparisons, maxAbsoluteError,
  inference: { samples: times.length, p50Ms: times[500], p95Ms: times[950], maxMs: times[999], batch20Ms },
  resources: { cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
    wallMs: performance.now() - startedAt, maxRssMiB: process.resourceUsage().maxRSS / 1024,
    rssMiB: process.memoryUsage().rss / 1024 ** 2, heapUsedMiB: process.memoryUsage().heapUsed / 1024 ** 2 },
  errorsVerified: ['non_finite_features', 'feature_schema_mismatch', 'missing_models', 'future_model'] }, null, 2));
