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
  const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION } = require('../dist/research/ForecastCore');
  const { researchHash } = require('../dist/research/ResearchStore');
  const { opportunityGuardImplementationHash } = require('../dist/research/COpportunityGuardRecommendation');
  const { jointHeadImplementationHash } = require('../dist/research/JointHeadConfiguration');
  const calibration = { example: 1 };
  const guard = { protocol: 'c-opportunity-value-guard-v1', planSha256: 'a'.repeat(64), profilesSha256: 'b'.repeat(64),
    profile: { protocol: 'c-opportunity-gap-guard-v1', frozenPlanSha256: 'a'.repeat(64), modelVersion: 'original' },
    reliabilityProfile: { protocol: 'c-prequential-payout-reliability-v1', modelVersion: 'original' } };
  const artifact = { family: 'C', version: '', baselineVersion: 'A-test', pipelineHashV2: 'f'.repeat(64), featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
    candidateKind: 'joint_head_v1', productionValidated: false, independentEvidence: false, weight: .75, temperature: .8, trainedThrough: '2025-01-01T00:00:00Z',
    validationThrough: '2025-02-01T00:00:00Z', createdAt: '2025-03-01T00:00:00Z', models: { jointHead: model },
    calibrationProfilesV2: { C: calibration }, opportunityGuard: guard,
    jointHeadIdentity: { protocol: 'c-joint-head-v1', classifierHash: researchHash(model), guardHash: researchHash(guard),
      calibrationHash: researchHash(calibration), originalModelVersion: 'original', selectorImplementationHash: opportunityGuardImplementationHash(),
      implementationHash: jointHeadImplementationHash(), baselineVersion: 'A-test', pipelineHashV2: 'f'.repeat(64) } };
  artifact.version = `C-${researchHash(artifact.jointHeadIdentity).slice(0, 16)}`;
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
