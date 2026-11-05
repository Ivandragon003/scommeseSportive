'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, canonicalHash } = require('../scripts/benchmark-alternative-inputs');

function fixture() {
  const profile = { fittedThrough: '2026-04-01T00:00:00Z', calibrationPoints: [] };
  const artifact = { family: 'C', version: 'C-906371b0b3a1e2c8', baselineVersion: 'A-80cb25df5552621e', featureSchema: 'legacy', featureNames: ['xg'], createdAt: '2026-10-27T09:00:00Z', trainedThrough: '2025-01-01T00:00:00Z', validationThrough: '2026-04-01T00:00:00Z', probabilityCalibrationMode: 'isotonic_1x2', pipelineHashV2: 'a'.repeat(64), calibrationProfilesV2: { C: profile } };
  const manifest = { schema: 'alternative-input-benchmark-scope-v1', mode: 'historical_scope_diagnostic_no_fit', modelVersion: artifact.version, baselineVersion: artifact.baselineVersion, modelCanonicalHash: canonicalHash(artifact), calibrationProfileHash: canonicalHash(profile), calibrationMode: artifact.probabilityCalibrationMode, pipelineHash: artifact.pipelineHashV2 };
  const record = { matchId: 'm', competition: 'Serie A', kickoffAt: '2026-10-29T20:00:00Z', forecastAt: '2026-10-29T02:07:00Z', modelFitAt: '2026-10-29T02:07:00Z', maxTrainingAvailableAt: '2026-10-28T22:00:00Z', trainingCount: 40, featureSchema: 'legacy', featureNames: ['xg'], features: [1.2], baselineMatrix: [[1]], baselineVersion: artifact.baselineVersion };
  const comparisonRow = { date: '2026-10-29', matchId: 'm', scoreEqual: true, comparable: true, primaryHomeXg: 1, primaryAwayXg: 0, candidateHomeXg: 1.4, candidateAwayXg: 0 };
  return { dataset: { rows: [record], featureNames: ['xg'], schemaVersion: 'legacy', baselineManifest: { version: artifact.baselineVersion }, availabilityEvidence: 'proxy_only' }, comparison: { total: { comparablePairs: 1 }, leagues: [{ competition: 'Serie A', matched: [comparisonRow] }] }, artifact, manifest, holdout: { newIndependentForecastsAfter: '2026-10-27T10:12:56Z', protectedOriginalFinalMatchIds: [] }, quarantine: { entries: [] } };
}

test('chronology proxy does not grant OOS proof or compare sources, even with valid snapshots', () => {
  const input = fixture(), before = JSON.stringify(input), result = audit(input);
  assert.equal(result.counts.chronologyProxyCandidates, 1); assert.equal(result.counts.rigorouslyEligible, 0);
  assert.equal(result.verdict, 'not_evaluable'); assert.equal(result.noninferiority, 'not_evaluated');
  assert.equal(result.evidence.historyQuarantineVerified, false); assert.equal(JSON.stringify(input), before);
  input.comparison.leagues[0].matched[0].candidateHomeXg = 99;
  assert.deepEqual(audit(input).counts, result.counts, 'target xG is not substituted into prematch input');
});

test('protected, quarantined, early model and future training are excluded', () => {
  for (const [mutate, reason] of [
    [x => x.holdout.protectedOriginalFinalMatchIds.push('m'), 'protected_original_holdout'],
    [x => x.quarantine.entries.push({ matchId: 'm' }), 'quarantined_target'],
    [x => { x.dataset.rows[0].forecastAt = '2026-10-27T08:00:00Z'; x.dataset.rows[0].modelFitAt = '2026-10-27T07:00:00Z'; x.dataset.rows[0].maxTrainingAvailableAt = '2026-10-27T06:00:00Z'; }, 'model_or_calibration_after_forecast'],
    [x => { x.dataset.rows[0].maxTrainingAvailableAt = '2026-10-29T03:00:00Z'; }, 'invalid_or_unverified_proxy_chronology'],
    [x => { x.dataset.rows[0].competition = 'Ligue 1'; }, 'source_fixture_identity_mismatch'],
  ]) { const input = fixture(); mutate(input); const result = audit(input); assert.equal(result.exclusions[reason], 1, reason); assert.equal(result.counts.chronologyProxyCandidates, 0); }
});

test('identity, calibration and comparison tampering fail closed', () => {
  const a = fixture(); a.artifact.models = { injected: true }; assert.throws(() => audit(a), /model_identity_mismatch/);
  const b = fixture(); b.manifest.calibrationProfileHash = '0'.repeat(64); assert.throws(() => audit(b), /pipeline_identity_mismatch/);
  const c = fixture(); c.comparison.total.comparablePairs = 2; assert.throws(() => audit(c), /comparison_count_mismatch/);
});
