#!/usr/bin/env node
'use strict';

// Diagnostic scope audit only: no model inference, fitting, database or network.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const sha = input => createHash('sha256').update(input).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const canonicalHash = value => sha(JSON.stringify(canonical(value)));
const hashPattern = /^[a-f0-9]{64}$/;
const C906_HASH = '3f18e05ee228d1c6fdbe92865b3b19635cdf68f3ecbd50ff53d83914b52993b3';
const time = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function readJson(filename, expectedHash) {
  if (!hashPattern.test(expectedHash ?? '')) fail('invalid_manifest_hash');
  const bytes = fs.readFileSync(filename);
  if (sha(bytes) !== expectedHash) fail('input_hash_mismatch');
  return JSON.parse(bytes.toString('utf8'));
}

/** All arguments are already loaded evidence; never modifies rows or inputs. */
function audit({ dataset, comparison, artifact, holdout, quarantine, manifest }) {
  if (manifest?.schema !== 'alternative-input-benchmark-scope-v1'
    || manifest?.mode !== 'historical_scope_diagnostic_no_fit'
    || manifest?.modelVersion !== 'C-906371b0b3a1e2c8'
    || manifest?.baselineVersion !== 'A-80cb25df5552621e') fail('invalid_manifest');
  if (artifact?.version !== manifest.modelVersion || artifact?.baselineVersion !== manifest.baselineVersion
    || artifact?.family !== 'C' || canonicalHash(artifact) !== manifest.modelCanonicalHash) fail('model_identity_mismatch');
  const created = time(artifact.createdAt), trained = time(artifact.trainedThrough), validation = time(artifact.validationThrough);
  const profile = artifact.calibrationProfilesV2?.C, fitted = time(profile?.fittedThrough);
  if (![created, trained, validation, fitted].every(Number.isFinite) || trained > validation || validation > created || fitted > created) fail('invalid_artifact_chronology');
  if (canonicalHash(profile) !== manifest.calibrationProfileHash || artifact.probabilityCalibrationMode !== manifest.calibrationMode
    || artifact.pipelineHashV2 !== manifest.pipelineHash || dataset?.baselineManifest?.version !== manifest.baselineVersion
    || dataset.schemaVersion !== artifact.featureSchema || JSON.stringify(dataset.featureNames) !== JSON.stringify(artifact.featureNames)) fail('pipeline_identity_mismatch');
  if (!Array.isArray(dataset.rows) || !Array.isArray(comparison.leagues) || !Array.isArray(holdout.protectedOriginalFinalMatchIds)
    || !Array.isArray(quarantine.entries) || !Number.isFinite(time(holdout.newIndependentForecastsAfter))) fail('invalid_input_structure');
  const quarantined = new Set(quarantine.entries.map(row => row.matchId));
  const protectedIds = new Set(holdout.protectedOriginalFinalMatchIds);
  const index = new Map();
  for (const row of dataset.rows) {
    if (typeof row?.matchId !== 'string' || !row.matchId || index.has(row.matchId)) fail('duplicate_or_invalid_dataset_id');
    index.set(row.matchId, row);
  }
  const matches = comparison.leagues.flatMap(league => Array.isArray(league.matched)
    ? league.matched.map(match => ({ ...match, sourceCompetition: league.competition })) : []);
  const comparable = matches.filter(row => row.comparable === true);
  if (comparison.total?.comparablePairs !== comparable.length) fail('comparison_count_mismatch');
  const unique = new Set();
  for (const row of comparable) {
    if (typeof row.matchId !== 'string' || !row.matchId || unique.has(row.matchId) || row.scoreEqual !== true
      || ![row.primaryHomeXg, row.primaryAwayXg, row.candidateHomeXg, row.candidateAwayXg].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) fail('invalid_comparison_match');
    unique.add(row.matchId);
  }
  const exclusions = {}, byLeague = {}, increment = key => { exclusions[key] = (exclusions[key] ?? 0) + 1; };
  let overlapping = 0, chronologyEligible = 0;
  for (const match of comparable) {
    const row = index.get(match.matchId);
    if (!row) { increment('no_precomputed_forecast'); continue; }
    overlapping++;
    if (row.competition !== match.sourceCompetition || String(row.kickoffAt ?? '').slice(0, 10) !== match.date) { increment('source_fixture_identity_mismatch'); continue; }
    if (protectedIds.has(row.matchId)) { increment('protected_original_holdout'); continue; }
    if (quarantined.has(row.matchId)) { increment('quarantined_target'); continue; }
    if (row.baselineVersion !== manifest.baselineVersion || row.featureSchema !== artifact.featureSchema
      || JSON.stringify(row.featureNames) !== JSON.stringify(artifact.featureNames)
      || !Array.isArray(row.features) || row.features.length !== artifact.featureNames.length
      || !row.features.every(v => typeof v === 'number' && Number.isFinite(v)) || !Array.isArray(row.baselineMatrix)) { increment('invalid_baseline_input'); continue; }
    const at = time(row.forecastAt), kickoff = time(row.kickoffAt), modelFit = time(row.modelFitAt), history = time(row.maxTrainingAvailableAt);
    if (![at, kickoff, modelFit, history].every(Number.isFinite) || at >= kickoff || modelFit > at || history > at
      || !Number.isSafeInteger(row.trainingCount) || row.trainingCount < 30) { increment('invalid_or_unverified_proxy_chronology'); continue; }
    if (created > at || validation > at || trained > at || fitted > at) { increment('model_or_calibration_after_forecast'); continue; }
    if (at <= time(holdout.newIndependentForecastsAfter)) { increment('before_future_holdout_boundary'); continue; }
    chronologyEligible++;
    byLeague[row.competition] = (byLeague[row.competition] ?? 0) + 1;
  }
  return {
    schema: 'alternative-input-benchmark-scope-result-v1', mode: manifest.mode,
    verdict: 'not_evaluable', noninferiority: 'not_evaluated', adoption: 'not_authorized',
    counts: { comparable: comparable.length, precomputedRows: dataset.rows.length, overlap: overlapping,
      chronologyProxyCandidates: chronologyEligible, rigorouslyEligible: 0 },
    byLeague, exclusions,
    evidence: { availability: dataset.availabilityEvidence ?? null, sourcePublicationVerified: false,
      sourceHistoricalRevisionVerified: false, independentHoldoutEstablished: false, historyQuarantineVerified: false,
      modelCanonicalHash: manifest.modelCanonicalHash, calibrationProfileHash: manifest.calibrationProfileHash,
      modelCreatedAt: artifact.createdAt, trainedThrough: artifact.trainedThrough, validationThrough: artifact.validationThrough,
      profileFittedThrough: profile.fittedThrough, datasetAsOf: dataset.asOf },
    limits: ['Only original precomputed baseline exists; a faithful alternative requires baseline refit, not performed.',
      'Target xG are postmatch and must not be substituted into their prematch forecast.',
      'The original cohort has been consulted and provider publication/revision times are not verified.',
      'Operator-supplied input hashes provide consistency, not independent preregistration or source attestation.',
      'No fit, model inference, calibration, data modification, database or network call was performed.'],
  };
}
function run(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.modelCanonicalHash !== C906_HASH) fail('expected_c906_hash_required');
  const fields = ['dataset', 'comparison', 'artifact', 'holdout', 'quarantine'];
  const input = Object.fromEntries(fields.map(name => [name, readJson(manifest.inputs?.[name]?.path, manifest.inputs?.[name]?.sha256)]));
  return audit({ ...input, manifest });
}
if (require.main === module) {
  try {
    if (process.argv.length !== 3) fail('manifest_path_required');
    process.stdout.write(`${JSON.stringify(run(process.argv[2]), null, 2)}\n`);
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]+$/.test(error.code) ? error.code : 'scope_audit_failed';
    process.stdout.write(`${JSON.stringify({ verdict: 'not_evaluable', error: code })}\n`); process.exitCode = 1;
  }
}
module.exports = { audit, run, canonicalHash };
