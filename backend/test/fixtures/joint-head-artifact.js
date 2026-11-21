function jointHeadArtifact(model = { oblivious_trees: [], scale_and_bias: [1, [0, 0, 0, 0, 0, 0]] }) {
  const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION } = require('../../dist/research/ForecastCore');
  const { researchHash } = require('../../dist/research/ResearchStore');
  const { opportunityGuardImplementationHash } = require('../../dist/research/COpportunityGuardRecommendation');
  const { jointHeadImplementationHash } = require('../../dist/research/JointHeadConfiguration');
  const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../../dist/research/CoherentProbabilityPipeline');
  const pipelineHashV2 = coherentProbabilityPipelineHash();
  const calibration = { example: 1 };
  const guard = { protocol: 'c-opportunity-value-guard-v1', planSha256: 'a'.repeat(64), profilesSha256: 'b'.repeat(64),
    profile: { protocol: 'c-opportunity-gap-guard-v1', frozenPlanSha256: 'a'.repeat(64), modelVersion: 'original' },
    reliabilityProfile: { protocol: 'c-prequential-payout-reliability-v1', modelVersion: 'original' } };
  const artifact = { family: 'C', version: '', baselineVersion: 'A-fixture', pipelineHashV2, featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
    candidateKind: 'joint_head_v1', probabilityCalibrationMode: 'isotonic_1x2', probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, productionValidated: false, independentEvidence: false, weight: .75, temperature: .8, trainedThrough: '2025-01-01T00:00:00Z',
    validationThrough: '2025-02-01T00:00:00Z', createdAt: '2025-03-01T00:00:00Z', models: { jointHead: model },
    calibrationProfilesV2: { C: calibration }, opportunityGuard: guard,
    jointHeadIdentity: { protocol: 'c-joint-head-v1', classifierHash: researchHash(model), guardHash: researchHash(guard),
      calibrationHash: researchHash(calibration), originalModelVersion: 'original', selectorImplementationHash: opportunityGuardImplementationHash(),
      implementationHash: jointHeadImplementationHash(), baselineVersion: 'A-fixture', pipelineHashV2 } };
  artifact.version = `C-${researchHash(artifact.jointHeadIdentity).slice(0, 16)}`;
  return artifact;
}

module.exports = { jointHeadArtifact };
