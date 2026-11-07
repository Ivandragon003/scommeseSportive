const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, cpSync, appendFileSync, rmSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join, resolve, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
// Immutable numeric observations remain useful after removing the old executable copy.
// Its release manifest and hashes identify that observation, not the current model.
const fixture = require('./fixtures/frozen-baseline-6ed36d44.json');
const input = require('./frozen-baseline-input');
const modelEnvNames = Object.keys(process.env).filter(name => name.startsWith('MODEL_') || name === 'PLAYER_GOALS_XG_SHRINK');
const modelEnv = Object.fromEntries(modelEnvNames.map(name => [name, process.env[name]]));
let core, pipeline;
try {
  for (const name of modelEnvNames) delete process.env[name];
  core = require('../dist/research/ForecastCore');
  pipeline = require('../dist/research/CoherentProbabilityPipeline');
} finally {
  Object.assign(process.env, modelEnv);
}

// libm/V8 can differ in the last floating-point bits across Windows/Linux.
function assertNumericOutput(actual, expected, path = 'output') {
  if (typeof expected === 'number') {
    assert.ok(typeof actual === 'number' && Number.isFinite(actual)
      && Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), path);
  } else if (expected !== null && typeof expected === 'object') {
    assert.equal(Array.isArray(actual), Array.isArray(expected), path);
    assert.deepEqual(Object.keys(actual), Object.keys(expected), path);
    for (const key of Object.keys(expected)) assertNumericOutput(actual[key], expected[key], `${path}.${key}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

test('current shared model preserves the established forecast and calibrated numeric observations', () => {
  const forecast = core.buildForecastInput(input.history, input.target, input.AT);
  const actualForecast = JSON.parse(JSON.stringify(forecast));
  const expectedForecast = structuredClone(fixture.forecast);
  assert.equal(actualForecast.baselineVersion, core.baselineManifest().version);
  delete actualForecast.baselineVersion;
  delete expectedForecast.baselineVersion;
  assertNumericOutput(actualForecast, expectedForecast);
  const calibrated = pipeline.applyCoherentProbabilityPipeline({ matrix: forecast.baselineMatrix,
    rawProbabilities: forecast.baselineProbabilities, forecastAt: input.AT, quotes: input.quotes, profile: input.profile });
  assertNumericOutput(JSON.parse(JSON.stringify(calibrated)), fixture.calibrated);
  assert.equal(calibrated.marketBlendingApplied, true);
});

test('current baseline identifies the shared operational math sources', () => {
  const manifest = core.baselineManifest();
  for (const file of ['models/core/DixonColesModel.js', 'models/core/PoissonXgModel.js',
    'models/value/ValueBettingEngine.js', 'services/ProbabilityEnsembleService.js', 'research/ForecastCore.js']) {
    const hash = createHash('sha256').update(readFileSync(join(__dirname, '../dist', file), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    assert.equal(manifest.codeHashes[file], hash, file);
  }
  assert.ok(Object.keys(manifest.codeHashes).every(file => !file.includes('/frozen/')));
  assert.match(manifest.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(manifest.version, `A-${manifest.fingerprint.slice(0, 16)}`);
});

test('changing shared math invalidates the current baseline and coherent pipeline identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'current-model-'));
  try {
    const compiled = resolve(__dirname, '../dist');
    for (const folder of ['models', 'config', 'research', 'services', 'utils']) {
      cpSync(join(compiled, folder), join(dir, folder), { recursive: true,
        filter: file => !file.split(/[\\/]/).includes('frozen') });
    }
    const code = `const c=require(${JSON.stringify(join(dir, 'research/ForecastCore.js'))});const p=require(${JSON.stringify(join(dir, 'research/CoherentProbabilityPipeline.js'))});process.stdout.write(JSON.stringify([c.baselineManifest().version,p.coherentProbabilityPipelineHash()]));`;
    const identity = () => {
      const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout);
    };
    const original = identity();
    appendFileSync(join(dir, 'models/value/ValueBettingEngine.js'), '\n// changed shared implementation\n');
    const changed = identity();
    assert.notEqual(changed[0], original[0]);
    assert.notEqual(changed[1], original[1]);
  } finally {
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    rmSync(target, { recursive: true, force: true });
  }
});
