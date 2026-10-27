const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');
const { fitCoherentCalibration } = require('../dist/research/CoherentProbabilityPipeline');

test('market configuration binds actual post-processing, not incidental chronological refit values', () => {
  const input = { family: 'A', baselineVersion: 'A-fixed', pipelineHashV2: 'a'.repeat(64), mode: 'identity' };
  const first = buildProbabilityConfiguration(input);
  const refit = buildProbabilityConfiguration({ ...input, modelFitAt: '2026-11-01T00:00:00Z', lambdaHome: 3 });
  assert.equal(first.hash, refit.hash);
  assert.notEqual(first.hash, buildProbabilityConfiguration({ ...input, mode: 'temperature', temperature: 2 }).hash);
  const profile = fitCoherentCalibration([], '2026-01-01T00:00:00Z');
  const isotonic = buildProbabilityConfiguration({ ...input, mode: 'isotonic_1x2', profile });
  assert.notEqual(first.hash, isotonic.hash);
  assert.notEqual(isotonic.hash, buildProbabilityConfiguration({ ...input, mode: 'isotonic_1x2',
    profile: { ...profile, calibrationPoints: [{ predicted: .5, actual: .7 }] } }).hash);
  assert.throws(() => buildProbabilityConfiguration({ ...input, mode: 'temperature' }), /temperature/);
});
