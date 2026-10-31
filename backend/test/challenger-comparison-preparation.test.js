const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename, sep } = require('node:path');
const { createHash } = require('node:crypto');
const { main } = require('../scripts/prepare-challenger-comparison');
const { enrichCoherentLifecycleArtifact } = require('../dist/research/ResearchLifecycle');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = require('../dist/research/ForecastCore');
const { researchHash } = require('../dist/research/ResearchStore');

const clone = value => JSON.parse(JSON.stringify(value));
const constant = value => ({ features_info: { float_features: [] }, oblivious_trees: [], scale_and_bias: [1, [value]] });
const save = (path, value) => writeFileSync(path, JSON.stringify(value));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'challenger-comparison-preparation-'));
  const training = join(directory, 'training'), fold = join(training, 'fold-0', 'no_ml');
  mkdirSync(fold, { recursive: true });
  const dataset = { asOf: '2026-10-30T22:00:00.000Z', decisionSchedule: { hour: 3, minute: 7 }, rows: [] };
  const datasetPath = join(directory, 'dataset.json'); save(datasetPath, dataset);
  const datasetHash = createHash('sha256').update(readFileSync(datasetPath)).digest('hex');
  const matrix = [[.2, .2], [.4, .2]];
  const artifact = { family: 'C', version: 'C-fixture-trained', baselineVersion: baselineManifest().version,
    featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION, datasetHash,
    trainedThrough: '2025-10-18T18:30:00.000Z', validationThrough: '2026-04-04T18:30:00.000Z',
    createdAt: '2026-10-27T09:05:06.479Z', candidateKind: 'calibrated_ensemble', weight: .75, temperature: .8,
    models: { home: constant(.1), away: constant(-.1) },
    calibrationPredictions: [{ matchId: 'fixture-calibration', availableAt: '2026-04-04T18:30:00.000Z',
      matrixA: matrix, matrixC: matrix, homeGoals: 1, awayGoals: 0 }] };
  save(join(fold, 'artifact.json'), artifact);
  save(join(training, 'report.json'), { schemaVersion: 'controlled-challenger-development-v1', datasetHash,
    arms: [{ name: 'no_ml' }], folds: [{ fold: 0, trainingSplit: { test: {
      from: '2026-04-05T01:07:00.000Z', to: '2026-04-06T01:07:00.000Z' } } }] });
  const incumbent = enrichCoherentLifecycleArtifact(artifact, { mode: 'isotonic_1x2' });
  const registry = { modelVersion: incumbent.version, artifactHash: researchHash(incumbent),
    artifactCreatedAt: '2026-10-29T10:39:58.713Z', benchmarkCreatedAt: '2026-10-29T10:40:00.219Z',
    benchmark: { candidateVersion: incumbent.version, probabilityProtocol: incumbent.probabilityProtocol,
      pipelineHashV2: incumbent.pipelineHashV2, probabilityCalibrationMode: incumbent.probabilityCalibrationMode,
      calibrationProfilesV2: clone(incumbent.calibrationProfilesV2) } };
  const incumbentPath = join(directory, 'incumbent.json'), registryPath = join(directory, 'registry.json'), out = join(directory, 'out');
  const run = () => {
    save(incumbentPath, incumbent); save(registryPath, registry);
    return main(['--training', training, '--dataset', datasetPath, '--out', out,
      '--incumbent', incumbentPath, '--incumbent-registry', registryPath]);
  };
  const close = () => {
    const target = resolve(directory), root = resolve(tmpdir());
    assert.ok(target.startsWith(`${root}${sep}`) && basename(target).startsWith('challenger-comparison-preparation-'));
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { directory, incumbent, registry, out, run, close };
}

test('comparison freezes the exact canonical incumbent without changing its creation date', () => {
  const f = fixture();
  try {
    const original = clone(f.incumbent);
    assert.equal(f.run().registryWrites, false);
    assert.deepEqual(JSON.parse(readFileSync(join(f.out, 'incumbent.json'), 'utf8')), original);
    const variants = JSON.parse(readFileSync(join(f.out, 'variants.json'), 'utf8')).variants;
    const current = variants.filter(variant => variant.role === 'current');
    assert.equal(current.length, 2);
    assert.ok(current.every(variant => variant.from === f.registry.benchmarkCreatedAt));
    assert.deepEqual(current.map(variant => variant.selectionPolicy), ['legacy-c906', 'payout-aware-v1']);
    // Output formatting changes, while the registry compares canonical content.
    assert.equal(researchHash(JSON.parse(readFileSync(join(f.out, 'incumbent.json'), 'utf8'))), f.registry.artifactHash);
  } finally { f.close(); }
});

test('comparison rejects changed model outputs and absent or incorrect registry hashes before writing output', () => {
  for (const change of [f => { f.incumbent.models.home.scale_and_bias[1][0] += .2; },
    f => { delete f.registry.artifactHash; }, f => { f.registry.artifactHash = '0'.repeat(64); }]) {
    const f = fixture();
    try { change(f); assert.throws(f.run, /artifact hash/); assert.equal(existsSync(f.out), false); }
    finally { f.close(); }
  }
});

test('comparison requires both the model and benchmark to identify the frozen version', () => {
  for (const change of [f => { f.registry.modelVersion = 'C-other'; },
    f => { f.registry.benchmark.candidateVersion = 'C-other'; }, f => { delete f.registry.benchmark; }]) {
    const f = fixture();
    try { change(f); assert.throws(f.run, /version mismatch or missing|model version mismatch/); assert.equal(existsSync(f.out), false); }
    finally { f.close(); }
  }
});

test('comparison rejects a different effective calibration configuration', () => {
  const f = fixture();
  try {
    f.registry.benchmark.probabilityCalibrationMode = 'temperature';
    f.registry.benchmark.probabilityTemperature = .9;
    assert.throws(f.run, /configuration must match/); assert.equal(existsSync(f.out), false);
  } finally { f.close(); }
});

test('comparison requires valid explicit model and benchmark availability timestamps', () => {
  for (const field of ['createdAt', 'artifactCreatedAt', 'benchmarkCreatedAt']) for (const value of [undefined, 'not-a-date', '2026-10-29T10:40:00']) {
    const f = fixture();
    try {
      if (field === 'createdAt') { f.incumbent.createdAt = value; f.registry.artifactHash = researchHash(f.incumbent); }
      else f.registry[field] = value;
      assert.throws(f.run, /availability must have valid coherent/); assert.equal(existsSync(f.out), false);
    } finally { f.close(); }
  }
});

test('comparison refuses a registry predating the artifact or its benchmark predating registration', () => {
  for (const change of [f => { f.registry.artifactCreatedAt = '2026-10-26T10:00:00.000Z'; },
    f => { f.registry.benchmarkCreatedAt = '2026-10-28T10:00:00.000Z'; }]) {
    const f = fixture();
    try { change(f); assert.throws(f.run, /availability must have valid coherent/); assert.equal(existsSync(f.out), false); }
    finally { f.close(); }
  }
});
