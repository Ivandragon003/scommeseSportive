const test = require('node:test');
const assert = require('node:assert/strict');
const { predictHybrid, validateArtifact } = require('../dist/research/CatBoostModel');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION } = require('../dist/research/ForecastCore');
const { CHALLENGER_DATA_QUALITY_POLICY_HASH } = require('../dist/research/ChallengerDataQuality');

const input = () => ({ featureSchema: FEATURE_SCHEMA_VERSION, featureNames: [...FEATURE_NAMES],
  features: FEATURE_NAMES.map(() => 0), forecastAt: '2026-10-20T01:07:00Z',
  baselineMatrix: [[.2, .1], [.6, .1]], baselineVersion: 'fixture-baseline' });
const artifact = (patch = {}) => ({ family: 'C', version: 'C-data-contract-fixture',
  featureSchema: FEATURE_SCHEMA_VERSION, featureNames: [...FEATURE_NAMES], candidateKind: 'no_ml',
  weight: 0, temperature: 1, models: {}, baselineVersion: 'fixture-baseline',
  trainedThrough: '2026-08-01T00:00:00Z', validationThrough: '2026-09-01T00:00:00Z',
  createdAt: '2026-09-02T00:00:00Z', ...patch });

test('legacy C artifacts retain identical predictions while audited C requires a clean baseline contract', () => {
  const baseline = input(), frozen = structuredClone(baseline);
  const legacy = predictHybrid(baseline, artifact());
  const model = artifact({ dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true });
  assert.throws(() => predictHybrid(baseline, model), /hybrid_data_quality_contract_mismatch/);
  for (const patch of [{ dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH },
    { dataQualityPolicyHash: '0'.repeat(64), dataQualityBaselineClean: true }]) {
    assert.throws(() => predictHybrid({ ...baseline, ...patch }, model), /hybrid_data_quality_contract_mismatch/);
  }
  const clean = predictHybrid({ ...baseline, dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH,
    dataQualityBaselineClean: true }, model);
  assert.deepEqual(clean.matrix, legacy.matrix);
  assert.deepEqual(clean.probabilities, legacy.probabilities);
  assert.deepEqual(baseline, frozen);
});

test('a model cannot declare an unknown data policy or a dirty audited baseline', () => {
  assert.throws(() => validateArtifact(artifact({ dataQualityPolicyHash: '0'.repeat(64), dataQualityBaselineClean: true })), /invalid_challenger_data_quality_policy/);
  assert.throws(() => validateArtifact(artifact({ dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH })), /invalid_challenger_data_quality_policy/);
  assert.throws(() => validateArtifact(artifact({ dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH,
    dataQualityBaselineClean: true, calibrationPredictions: [{ matchId: 'understat_22621' }] })), /invalid_challenger_data_quality_policy/);
  assert.throws(() => predictHybrid({ ...input(), matchId: 'understat_22621',
    dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true },
  artifact({ dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true })), /hybrid_data_quality_contract_mismatch/);
});
