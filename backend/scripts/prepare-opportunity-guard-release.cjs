'use strict';
// Prepare a reviewable candidate from pinned evidence; never register or overwrite a release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  assert(['--source', '--joint', '--guard', '--output', '--created-at'].includes(args[i]) && args[i + 1] && !options[args[i]], 'invalid arguments');
  options[args[i]] = args[i + 1];
}
for (const name of ['--source', '--joint', '--guard', '--output', '--created-at']) assert(options[name], `${name} required`);
const createdAt = options['--created-at'];
assert(/Z$/.test(createdAt) && Number.isFinite(Date.parse(createdAt)) && Date.parse(createdAt) <= Date.now(), 'invalid created-at');
const sourceFile = path.resolve(options['--source']), joint = path.resolve(options['--joint']);
const guard = path.resolve(options['--guard']), output = path.resolve(options['--output']);
assert(!fs.existsSync(output), 'output already exists');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const { researchHash, researchJson } = require('../dist/research/ResearchStore');
const { validateArtifact } = require('../dist/research/CatBoostModel');
const { buildJointHeadProbabilityConfiguration, jointHeadImplementationHash } = require('../dist/research/JointHeadConfiguration');
const { coherentProbabilityPipelineHash } = require('../dist/research/CoherentProbabilityPipeline');
const { opportunityGuardImplementationHash } = require('../dist/research/COpportunityGuardRecommendation');
const source = read(sourceFile), plan = read(path.join(guard, 'study-plan.json'));
const verification = read(path.join(joint, 'verification-v2.json'));
const guardVerification = read(path.join(guard, 'verification.json'));
assert.equal(sha(path.join(joint, 'verification-v2.json')), '119a422a966e65268d1898872724536ff3cca816e353775d4e2f5100fdb7ad8e');
assert.equal(sha(path.join(guard, 'verification.json')), '14b3941852326d18848c355903dc4621555da9b36f3afc924f97fe3613c6b5c2');
assert.equal(verification.status, 'PASS'); assert.equal(verification.verified, true); assert.equal(verification.errorCount, 0);
assert.equal(guardVerification.status, 'PASS'); assert.equal(guardVerification.verified, true); assert.equal(guardVerification.errorCount, 0);
assert.equal(sha(sourceFile), plan.currentArtifactSha256);
assert.equal(sha(path.join(joint, 'probabilities.json')), verification.probabilitiesSha256);
assert.equal(plan.priorProbabilitiesSha256, verification.probabilitiesSha256);
assert.equal(sha(path.join(guard, 'profiles.json')), guardVerification.guardProfilesSha256);
assert.equal(sha(path.join(guard, 'study-plan.json')), guardVerification.planSha256);
const pinned = verification.attestationInputHashes;
for (const name of ['model.json', 'predictions.json', 'audit.json']) {
  assert.equal(sha(path.join(joint, 'trained/fold-2026', name)), pinned[`backend/artifacts/research/c-joint-head-study-20261108-v2/trained/fold-2026/${name}`]);
}
const trained = read(path.join(joint, 'trained/fold-2026/predictions.json'));
const audit = read(path.join(joint, 'trained/fold-2026/audit.json'));
const classifier = read(path.join(joint, 'trained/fold-2026/model.json'));
const probabilities = read(path.join(joint, 'probabilities.json')).arms.joint_head;
const guardFile = read(path.join(guard, 'profiles.json')), profile = guardFile.folds['2026'];
assert.equal(guardFile.planSha256, guardVerification.planSha256);
assert.equal(guardFile.priorProbabilitiesSha256, verification.probabilitiesSha256);
const calibration = probabilities.calibration.folds['2026'], reliabilityFull = probabilities.profiles.folds['2026'];
const reliabilityProfile = Object.fromEntries(['protocol', 'frozenPlanSha256', 'year', 'modelVersion', 'testFrom', 'maxCalibrationAvailableAt', 'families'].map(k => [k, reliabilityFull[k]]));
assert.equal(sha(path.join(joint, 'trained/fold-2026/model.json')), trained.modelJsonSha256);
assert.equal(guardFile.productionEligible, false); assert.equal(guardFile.testTargetsUsed, 0); assert.equal(guardFile.protectedTargetsUsed, 0);
assert.equal(profile.modelVersion, reliabilityProfile.modelVersion); assert.equal(profile.year, 2026);
assert.equal(JSON.stringify(source.featureNames), JSON.stringify(audit.featureNames40));
assert(Date.parse(calibration.fittedThrough) < Date.parse(createdAt));
const classifierHash = researchHash(classifier);
const opportunityGuard = { protocol: 'c-opportunity-value-guard-v1', planSha256: guardFile.planSha256,
  profilesSha256: guardVerification.guardProfilesSha256, profile, reliabilityProfile };
const pipelineHashV2 = coherentProbabilityPipelineHash();
const identity = { protocol: 'c-joint-head-v1', classifierHash, classifierJsonSha256: trained.modelJsonSha256,
  classifierNativeSha256: trained.modelSha256, planSha256: trained.planSha256, originalModelVersion: profile.modelVersion,
  guardHash: researchHash(opportunityGuard), calibrationHash: researchHash(calibration),
  baselineVersion: source.baselineVersion, pipelineHashV2, implementationHash: jointHeadImplementationHash(),
  selectorImplementationHash: opportunityGuardImplementationHash() };
const version = `C-${researchHash(identity).slice(0, 16)}`;
const artifact = { version, family: 'C', featureNames: source.featureNames, featureSchema: source.featureSchema,
  baselineVersion: source.baselineVersion, dataQualityPolicyHash: source.dataQualityPolicyHash, dataQualityBaselineClean: true,
  candidateKind: 'joint_head_v1', weight: .75, temperature: .8, models: { jointHead: classifier },
  trainedThrough: probabilities.modelWrappers['2026'].artifact.trainedThrough, validationThrough: calibration.fittedThrough,
  createdAt, calibrationProfilesV2: { C: calibration }, jointHeadIdentity: identity, opportunityGuard,
  trainingRecipe: audit.fixedRecipe, status: 'CURRENT', availability: 'packaged_explicit_user_release',
  diagnosticOnly: false, productionEligible: false, productionValidated: false, independentEvidence: false, runtimeCompatible: true,
  probabilityProtocol: 'joint-goal-coherent-v2', pipelineHashV2, probabilityCalibrationMode: 'isotonic_1x2',
  releaseAdoption: { protocol: 'explicit-user-opportunity-guard-release-v1', authorization: 'explicit_user_instruction',
    productionValidated: false, independentEvidence: false } };
validateArtifact(artifact);
const configuration = buildJointHeadProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
  pipelineHashV2, mode: artifact.probabilityCalibrationMode, profile: calibration }, classifierHash);
const manifest = { modelVersion: version, baselineVersion: artifact.baselineVersion, selectorPolicy: 'c-resolved-engine-ranking-v1',
  probabilityConfigurationHash: configuration.hash, artifactHash: researchHash(artifact) };
fs.mkdirSync(output);
fs.writeFileSync(path.join(output, 'challenger.json'), researchJson(artifact) + '\n', { flag: 'wx' });
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, manifest, classifierHash, classifierJsonSha256: trained.modelJsonSha256,
  profilesSha256: opportunityGuard.profilesSha256, calibrationHash: identity.calibrationHash }));
