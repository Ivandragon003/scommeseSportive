'use strict';
// Clone an explicitly selected, immutable candidate. No fitting, database or deployment writes.
const { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { createHash } = require('node:crypto');
const { researchHash } = require('../dist/research/ResearchStore');
const { validateArtifact } = require('../dist/research/CatBoostModel');
const { baselineManifest } = require('../dist/research/ForecastCore');
const { applyCoherentProbabilityPipeline, coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../dist/research/CoherentProbabilityPipeline');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');

const RELEASE_PROTOCOL = 'explicit-user-tree-sample-projection-release-v1';
const SOURCE_VERSION = 'C-75fd74eb875e9d0e';
const CANDIDATE_VERSION = 'C-f6d4ac23de48fbfa';
const SOURCE_FILE_SHA256 = '772049b0d4462faa94c785390222501c609f7887a9b7e005c737c3c8988700d2';
const CANDIDATE_FILE_SHA256 = '25371123796c7ae4c11a6c5326d839a5bccc6c310533ca3b0e8c9267899b345b';
const CANDIDATE_CANONICAL_HASH = 'ae5382b1ee7b55f8e6e802d8c557a653b0a359c157db60f764a2597f7af3272b';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CHANGED_METADATA = ['version', 'createdAt', 'parentVersion', 'status', 'availability', 'diagnosticOnly', 'productionAdoptionEligible'];

function validateCurrentPipeline(artifact) {
  validateArtifact(artifact);
  if (artifact.baselineVersion !== baselineManifest().version
    || artifact.pipelineHashV2 !== coherentProbabilityPipelineHash()
    || artifact.probabilityProtocol !== COHERENT_PROBABILITY_PROTOCOL) throw new Error('current_pipeline_manifest_mismatch');
  const row = artifact.calibrationPredictions?.[0];
  if (!row) throw new Error('calibration_evidence_required');
  for (const family of ['A', 'C']) {
    applyCoherentProbabilityPipeline({ matrix: row[`matrix${family}`], rawProbabilities: row[`probabilities${family}`],
      quotes: [], forecastAt: artifact.createdAt, mode: artifact.probabilityCalibrationMode,
      temperature: artifact.probabilityTemperature, profile: artifact.calibrationProfilesV2?.[family] });
  }
}

function createCurrentChallengerRelease(candidate, createdAt) {
  if (researchHash(candidate) !== CANDIDATE_CANONICAL_HASH || candidate.version !== CANDIDATE_VERSION
    || candidate.parentVersion !== SOURCE_VERSION) throw new Error('candidate_identity_mismatch');
  if (!Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) < Date.parse(candidate.createdAt)) {
    throw new Error('invalid_release_timestamp');
  }
  validateCurrentPipeline(candidate);
  const artifact = JSON.parse(JSON.stringify(candidate));
  const originalCandidateMetadata = Object.fromEntries(CHANGED_METADATA.map((key) => [key, candidate[key]]));
  artifact.version = `C-${researchHash({ protocol: RELEASE_PROTOCOL, candidateCanonicalHash: CANDIDATE_CANONICAL_HASH }).slice(0, 16)}`;
  artifact.parentVersion = candidate.version;
  artifact.createdAt = new Date(createdAt).toISOString();
  artifact.status = 'CURRENT';
  artifact.availability = 'packaged_explicit_user_release';
  delete artifact.diagnosticOnly;
  delete artifact.productionAdoptionEligible;
  artifact.productionValidated = false;
  artifact.independentEvidence = false;
  artifact.releaseAdoption = { protocol: RELEASE_PROTOCOL, authorization: 'explicit_user_instruction',
    basis: 'Exact projected candidate selected by the user; no statistical promotion or independent validation.',
    candidateCanonicalHash: CANDIDATE_CANONICAL_HASH, candidateFileSha256: CANDIDATE_FILE_SHA256,
    sourceVersion: SOURCE_VERSION, sourceFileSha256: SOURCE_FILE_SHA256,
    originalCandidateMetadata, productionValidated: false, independentEvidence: false };
  validateCurrentPipeline(artifact);
  const probability = buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
    pipelineHashV2: artifact.pipelineHashV2, mode: artifact.probabilityCalibrationMode,
    temperature: artifact.probabilityTemperature, profile: artifact.calibrationProfilesV2.C });
  const manifest = { modelVersion: artifact.version, baselineVersion: artifact.baselineVersion,
    selectorPolicy: 'canonical-binary-v1', probabilityConfigurationHash: probability.hash, artifactHash: researchHash(artifact) };
  return { artifact, manifest };
}

function prepareCurrentChallengerRelease({ sourcePath, candidatePath, outputDirectory, createdAt = new Date().toISOString() }) {
  if (!sourcePath || !candidatePath || !outputDirectory) throw new Error('source_candidate_and_new_output_required');
  const output = resolve(outputDirectory);
  // Requiring a new directory also rejects output aliases/symlinks and existing packaged paths.
  if (existsSync(output)) throw new Error('output_directory_must_be_new');
  const sourceFile = realpathSync(resolve(sourcePath)), candidateFile = realpathSync(resolve(candidatePath));
  if (sourceFile === candidateFile) throw new Error('distinct_inputs_required');
  const sourceBytes = readFileSync(sourceFile), candidateBytes = readFileSync(candidateFile);
  if (sha256(sourceBytes) !== SOURCE_FILE_SHA256) throw new Error('source_file_hash_mismatch');
  if (sha256(candidateBytes) !== CANDIDATE_FILE_SHA256) throw new Error('candidate_file_hash_mismatch');
  const source = JSON.parse(sourceBytes), candidate = JSON.parse(candidateBytes);
  validateCurrentPipeline(source);
  if (source.version !== SOURCE_VERSION || candidate.experimentIdentity?.parentArtifactHash !== SOURCE_FILE_SHA256) {
    throw new Error('source_candidate_lineage_mismatch');
  }
  const result = createCurrentChallengerRelease(candidate, createdAt);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'challenger.json'), JSON.stringify(result.artifact), { flag: 'wx' });
  writeFileSync(join(output, 'release-manifest.json'), `${JSON.stringify(result.manifest, null, 2)}\n`, { flag: 'wx' });
  return { ...result, outputDirectory: output, fileSha256: sha256(readFileSync(join(output, 'challenger.json'))) };
}

module.exports = { createCurrentChallengerRelease, prepareCurrentChallengerRelease, RELEASE_PROTOCOL,
  SOURCE_VERSION, CANDIDATE_VERSION, SOURCE_FILE_SHA256, CANDIDATE_FILE_SHA256, CANDIDATE_CANONICAL_HASH };

if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    const keys = { '--source': 'sourcePath', '--candidate': 'candidatePath', '--out': 'outputDirectory', '--created-at': 'createdAt' };
    for (let index = 0; index < args.length; index += 2) {
      if (!keys[args[index]] || !args[index + 1] || options[keys[args[index]]]) throw new Error('Expected --source path --candidate path --out NEW_DIRECTORY [--created-at ISO]');
      options[keys[args[index]]] = args[index + 1];
    }
    const result = prepareCurrentChallengerRelease(options);
    console.log(JSON.stringify({ outputDirectory: result.outputDirectory, fileSha256: result.fileSha256, ...result.manifest }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
