const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, cpSync, appendFileSync, rmSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const fixture = require('./fixtures/frozen-baseline-6ed36d44.json');
const hashes = require('../src/research/frozen/a-80cb25df/integrity.json');
const input = require('./frozen-baseline-input');
// The immutable reference was generated with release defaults, independently
// of any legitimate model overrides in the developer's shell.
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
const frozen = resolve(__dirname, '../dist/research/frozen/a-80cb25df');

// libm/V8 can differ in the last floating-point bits across Windows/Linux.
// Keep the release fixture unchanged; identities and JSON structure stay exact.
function assertReleaseOutput(actual, expected, path = 'output') {
  if (typeof expected === 'number') {
    assert.ok(typeof actual === 'number' && Number.isFinite(actual)
      && Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), path);
  } else if (expected !== null && typeof expected === 'object') {
    assert.equal(Array.isArray(actual), Array.isArray(expected), path);
    assert.deepEqual(Object.keys(actual), Object.keys(expected), path);
    for (const key of Object.keys(expected)) assertReleaseOutput(actual[key], expected[key], `${path}.${key}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

test('historical numerical baseline and calibrated decisions match the deployed release fixture', () => {
  assert.deepEqual(core.baselineManifest(), fixture.manifest);
  assert.equal(pipeline.coherentProbabilityPipelineHash(), fixture.pipelineHash);
  const forecast = core.buildForecastInput(input.history, input.target, input.AT);
  assertReleaseOutput(JSON.parse(JSON.stringify(forecast)), fixture.forecast);
  const calibrated = pipeline.applyCoherentProbabilityPipeline({matrix:forecast.baselineMatrix,
    rawProbabilities:forecast.baselineProbabilities,forecastAt:input.AT,quotes:input.quotes,profile:input.profile});
  assertReleaseOutput(JSON.parse(JSON.stringify(calibrated)), fixture.calibrated);
  assert.equal(calibrated.marketBlendingApplied, true);
});

test('every frozen JS file has the recorded release bytes', () => {
  for (const [file, expected] of Object.entries(hashes)) {
    assert.equal(createHash('sha256').update(readFileSync(join(frozen, file))).digest('hex'), expected, file);
  }
});

test('mutating frozen model bytes changes the computed identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frozen-baseline-'));
  try {
    cpSync(frozen, dir, {recursive:true});
    appendFileSync(join(dir, 'models/value/ValueBettingEngine.js'), '\n// altered\n');
    const code = `const c=require(${JSON.stringify(join(dir, 'research/ForecastCore.js'))});const p=require(${JSON.stringify(join(dir, 'research/CoherentProbabilityPipeline.js'))});console.log(JSON.stringify([c.baselineManifest().version,p.coherentProbabilityPipelineHash()]));`;
    const child = spawnSync(process.execPath, ['-e', code], {encoding:'utf8'});
    assert.equal(child.status, 0, child.stderr);
    const [version, hash] = JSON.parse(child.stdout);
    assert.notEqual(version, fixture.manifest.version);
    assert.notEqual(hash, fixture.pipelineHash);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});



test('build rejects a changed or unexpected frozen JavaScript file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frozen-build-'));
  try {
    const source = resolve(__dirname, '../src/research/frozen/a-80cb25df');
    const copy = join(dir, 'src/research/frozen/a-80cb25df');
    const script = join(dir, 'scripts/clean-build.js');
    cpSync(source, copy, {recursive:true});
    cpSync(resolve(__dirname, '../scripts'), join(dir, 'scripts'), {recursive:true});
    const run = () => spawnSync(process.execPath, [script], {encoding:'utf8'});
    assert.equal(run().status, 0);
    appendFileSync(join(copy, 'models/core/PoissonXgModel.js'), '\n// changed\n');
    assert.match(run().stderr, /Frozen baseline integrity failure/);
    cpSync(join(source, 'models/core/PoissonXgModel.js'), join(copy, 'models/core/PoissonXgModel.js'));
    appendFileSync(join(copy, 'models/extra.js'), '// extra\n');
    assert.match(run().stderr, /Frozen baseline file list changed/);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
