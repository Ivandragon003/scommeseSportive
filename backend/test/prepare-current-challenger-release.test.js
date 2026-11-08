'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { researchHash } = require('../dist/research/ResearchStore');
const { createCurrentChallengerRelease, prepareCurrentChallengerRelease, CANDIDATE_CANONICAL_HASH } = require('../scripts/prepare-current-challenger-release');
const packaged = JSON.parse(readFileSync(join(__dirname, '../current-models/challenger.json'), 'utf8'));

function selectedCandidate() {
  const candidate = JSON.parse(JSON.stringify(packaged));
  const metadata = candidate.releaseAdoption.originalCandidateMetadata;
  delete candidate.releaseAdoption;
  return Object.assign(candidate, metadata);
}

test('release derivation clones the exact candidate and deterministic identity without training', () => {
  const candidate = selectedCandidate(), before = researchHash(candidate);
  const first = createCurrentChallengerRelease(candidate, packaged.createdAt);
  assert.equal(before, CANDIDATE_CANONICAL_HASH);
  assert.equal(researchHash(candidate), before);
  assert.deepEqual(first.artifact, packaged);
  assert.equal(first.manifest.artifactHash, researchHash(packaged));
  assert.equal(first.artifact.version, 'C-271c9573ba485956');
  const later = createCurrentChallengerRelease(candidate, '2026-11-09T00:00:00.000Z');
  assert.equal(later.artifact.version, first.artifact.version);
  assert.notEqual(later.manifest.artifactHash, first.manifest.artifactHash);
  for (const key of ['models', 'featureNames', 'featureSchema', 'candidateKind', 'weight', 'temperature',
    'calibrationPredictions', 'calibrationProfilesV2', 'datasetHash', 'trainerHash', 'trainingSplit']) {
    assert.deepEqual(first.artifact[key], candidate[key], key);
  }
});

test('release derivation rejects changed candidate content and invalid timestamps', () => {
  const changed = selectedCandidate();
  changed.models.home.oblivious_trees[0].leaf_values[0] += .001;
  assert.throws(() => createCurrentChallengerRelease(changed, packaged.createdAt), /candidate_identity_mismatch/);
  assert.throws(() => createCurrentChallengerRelease(selectedCandidate(), 'invalid'), /invalid_release_timestamp/);
  assert.throws(() => createCurrentChallengerRelease(selectedCandidate(), '2026-11-07T00:00:00Z'), /invalid_release_timestamp/);
});

test('file preparation refuses existing destinations and unpinned inputs without writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prepare-current-c-'));
  try {
    const sourcePath = join(directory, 'source.json'), candidatePath = join(directory, 'candidate.json');
    writeFileSync(sourcePath, JSON.stringify(packaged));
    writeFileSync(candidatePath, JSON.stringify(selectedCandidate()));
    const outputDirectory = join(directory, 'new-release');
    assert.throws(() => prepareCurrentChallengerRelease({ sourcePath, candidatePath, outputDirectory: directory }), /output_directory_must_be_new/);
    assert.throws(() => prepareCurrentChallengerRelease({ sourcePath, candidatePath, outputDirectory }), /source_file_hash_mismatch/);
    assert.equal(existsSync(outputDirectory), false);
    assert.deepEqual(JSON.parse(readFileSync(sourcePath, 'utf8')), packaged);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
