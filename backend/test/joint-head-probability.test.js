'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { jointHeadMatrix, restoreJointHeadSpread } = require('../dist/research/JointHeadProbability');
const model = { oblivious_trees: [], scale_and_bias: [1, [0, 0, 0, 0, 0, 0]] };
const matrix = [[.1, .1, .1, .05], [.1, .1, .1, .05], [.1, .05, .05, .05], [.02, .01, .01, .01]];
const mass = m => m.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
const groups = m => { const out = [0, 0, 0]; m.forEach((row, h) => row.forEach((p, a) => { out[h > a ? 0 : h === a ? 1 : 2] += p; })); return out; };
test('joint head is normalized and rejects unsupported input', () => {
  const result = jointHeadMatrix(matrix, model, []);
  assert(Math.abs(mass(result) - 1) < 1e-12);
  assert.throws(() => jointHeadMatrix(matrix, { ...model, scale_and_bias: [1, [0]] }, []), /dimension/);
  assert.throws(() => jointHeadMatrix([[1, 0], [0, 0]], model, []), /partition/);
});
test('conditional spread preserves calibrated result masses and zero support', () => {
  const input = jointHeadMatrix(matrix, model, []), result = restoreJointHeadSpread(input);
  groups(input).forEach((p, i) => assert(Math.abs(p - groups(result)[i]) < 1e-12));
  const sparse = [[1, 0], [0, 1]], restored = restoreJointHeadSpread(sparse);
  assert.equal(restored[0][1], 0); assert.equal(restored[1][0], 0);
  assert.throws(() => restoreJointHeadSpread([[NaN]]), /invalid/);
});

test('joint classifier and frozen profiles are authenticated', () => {
  const { validateArtifact } = require('../dist/research/CatBoostModel');
  const artifact = require('./fixtures/joint-head-artifact').jointHeadArtifact(model);
  const guard = artifact.opportunityGuard;
  validateArtifact(artifact);
  assert.throws(() => validateArtifact({ ...artifact, opportunityGuard: { ...guard, planSha256: 'c'.repeat(64) } }), /invalid_joint_head/);
  assert.throws(() => validateArtifact({ ...artifact, models: { jointHead: { ...model, scale_and_bias: [1, [1, 0, 0, 0, 0, 0]] } } }), /invalid_joint_head/);
  assert.throws(() => validateArtifact({ ...artifact, calibrationProfilesV2: { C: { example: 2 } } }), /invalid_joint_head/);
});

test('joint configuration passes the operational technical identity check', () => {
  const { buildJointHeadProbabilityConfiguration } = require('../dist/research/JointHeadConfiguration');
  const { challengerTechnicalReason } = require('../dist/research/ChallengerRecommendation');
  const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../dist/research/CoherentProbabilityPipeline');
  const { scoreMatrixMarkets } = require('../dist/research/GoalSettlement');
  const pipelineHashV2 = coherentProbabilityPipelineHash(), baselineVersion = 'A-test';
  const configuration = buildJointHeadProbabilityConfiguration({ family: 'C', baselineVersion, pipelineHashV2, mode: 'identity' }, 'a'.repeat(64));
  const matrix = [[.2, .2], [.3, .3]], at = '2026-11-09T00:00:00.000Z';
  const decision = { family: 'C', modelVersion: 'C-test', validated: true, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
    calibrationPipelineHash: pipelineHashV2, probabilityConfiguration: configuration.descriptor,
    probabilityConfigurationHash: configuration.hash, calibrationAvailableAt: at, prospectiveMatrix: matrix,
    probabilityStages: { decision: scoreMatrixMarkets(matrix) } };
  const expected = { modelVersion: 'C-test', baselineVersion, probabilityConfigurationHash: configuration.hash };
  assert.equal(challengerTechnicalReason(decision, at, expected), null);
});
