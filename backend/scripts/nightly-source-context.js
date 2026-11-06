'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function sourceMode(env = process.env) {
  const mode = env.NIGHTLY_SOURCE_MODE || 'primary';
  if (!['primary', 'verified-alternatives'].includes(mode)) throw Error('nightly_source_mode_invalid');
  return mode;
}

function readValidatedManifest(env = process.env, now = new Date()) {
  const target = String(env.TURSO_DATABASE_URL ?? '');
  const targetHash = createHash('sha256').update(target).digest('hex');
  if (!target || !/^[a-f0-9]{64}$/.test(env.NIGHTLY_SOURCE_TARGET_SHA256 ?? '')
    || targetHash !== env.NIGHTLY_SOURCE_TARGET_SHA256) throw Error('nightly_source_target_mismatch');
  const manifest = JSON.parse(fs.readFileSync(env.NIGHTLY_SOURCE_MANIFEST_FILE, 'utf8'));
  const { manifestSha256, ...content } = manifest;
  if (manifest.schemaVersion !== 1 || manifest.mode !== 'execute' || manifest.targetSha256 !== targetHash
    || digest(content) !== manifestSha256 || !Array.isArray(manifest.competitions)
    || !Number.isFinite(Date.parse(manifest.generatedAt)) || Date.parse(manifest.generatedAt) > now.getTime()
    || !Array.isArray(manifest.updatedTeamIds) || manifest.updatedTeamIds.length > 500
    || manifest.updatedTeamIds.some(id => typeof id !== 'string' || !id.trim())) throw Error('nightly_source_manifest_invalid');
  return manifest;
}

async function createFixtureAdmission(db, env = process.env, options = {}) {
  const manifest = readValidatedManifest(env, (options.clock ?? (() => new Date()))());
  const mapping = JSON.parse(fs.readFileSync(env.NIGHTLY_SOURCE_MAPPING_FILE, 'utf8'));
  if (mapping?.version !== 'reviewed-source-mapping-v1' || !mapping.teams) throw Error('nightly_source_mapping_invalid');
  const { SourceFeedStore } = require('../dist/services/SourceFeedStore');
  const sourceStore = new SourceFeedStore(db.db);
  await sourceStore.initialize({ shared: true });
  const { loadNightlyFixtureReadiness } = require('../dist/research/NightlyFixtureReadiness');
  return async (matchId, asOf, pinnedDeployment) => {
    const deployment = pinnedDeployment ?? (db.challengerAdoption
      ? await db.challengerAdoption.getState() : require('../dist/research/ResearchRecommendationPolicy').fallbackChallengerState());
    const checked = await loadNightlyFixtureReadiness(db, manifest, matchId, asOf, deployment, { sourceStore, mapping });
    return checked.admission;
  };
}

async function recomputeImportedTeams(db, env = process.env) {
  const manifest = readValidatedManifest(env);
  const ids = [...new Set(manifest.updatedTeamIds)];
  // This is maintenance after an explicitly executed import, never model fitting.
  if (ids.length) await db.recomputeTeamAveragesBatch(ids);
  return { recomputedTeams: ids.length, manifestSha256: manifest.manifestSha256 };
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0] !== '--recompute-imported-teams') throw Error('nightly_source_context_arguments_invalid');
  readValidatedManifest(); // Reject wrong target or manifest before application construction.
  const { DatabaseService } = require('../dist/db/DatabaseService');
  const db = new DatabaseService({ skipSchemaBootstrap: true });
  try { return await recomputeImportedTeams(db); } finally { await db.close(); }
}
module.exports = { sourceMode, readValidatedManifest, createFixtureAdmission, recomputeImportedTeams };
if (require.main === module) main().then(result => console.log(JSON.stringify(result)))
  .catch(() => { console.error('nightly_source_context_failed'); process.exitCode = 1; });
