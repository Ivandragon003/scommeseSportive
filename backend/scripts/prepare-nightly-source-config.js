'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function prepare(env = process.env) {
  const target = env.TURSO_DATABASE_URL ?? '';
  if (!target || !/^[a-f0-9]{64}$/.test(env.NIGHTLY_SOURCE_TARGET_SHA256 ?? '')
    || createHash('sha256').update(target).digest('hex') !== env.NIGHTLY_SOURCE_TARGET_SHA256
    || !/^20\d{2}$/.test(env.NIGHTLY_SOURCE_SEASON ?? '')) throw Error('nightly_source_configuration_invalid');
  if (['MODEL_A_PROSPECTIVE_ENABLED', 'MODEL_A_PROSPECTIVE_COLLECTION_ENABLED', 'RESEARCH_T15_SCHEDULER_ENABLED']
    .some(key => env[key] === 'true')) throw Error('nightly_source_scheduler_conflict');
  const mappingPath = path.resolve(env.NIGHTLY_SOURCE_MAPPING_FILE || '');
  const manifestPath = path.resolve(env.NIGHTLY_SOURCE_MANIFEST_FILE || '');
  if (!mappingPath.endsWith('.json') || !manifestPath.endsWith('.json') || mappingPath === manifestPath) throw Error('nightly_source_output_invalid');
  const supplied = env.NIGHTLY_SOURCE_MAPPING_JSON;
  const mapping = supplied ? JSON.parse(supplied) : JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  if (mapping?.version !== 'reviewed-source-mapping-v1' || typeof mapping.reference !== 'string' || !mapping.reference.trim()
    || !Number.isFinite(Date.parse(mapping.reviewedAt)) || Date.parse(mapping.reviewedAt) > Date.now()
    || !mapping.teams || ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'].some(name => !mapping.teams[name])) {
    throw Error('nightly_source_mapping_invalid');
  }
  if (fs.existsSync(mappingPath)) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(mappingPath, 'utf8'))) !== JSON.stringify(mapping)) throw Error('nightly_source_mapping_changed');
  } else {
    fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
    fs.writeFileSync(mappingPath, JSON.stringify(mapping), { flag: 'wx', mode: 0o600 });
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  return { mode: 'configuration_verified', sourceMode: 'verified-alternatives', writesToOperationalDatabase: 0 };
}
module.exports = { prepare };
if (require.main === module) {
  try { console.log(JSON.stringify(prepare())); }
  catch { console.error('nightly_source_configuration_failed'); process.exitCode = 1; }
}
