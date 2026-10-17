const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createClient } = require('@libsql/client');
const { DatabaseService } = require('../dist/db/DatabaseService');
const { PredictionService } = require('../dist/services/PredictionService');
const { decodeCalibrationProfile } = require('../dist/services/CalibrationProfileCache');

const COMPETITIONS = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];

async function warmAndVerify(db, createService, competitions = COMPETITIONS, log = console.log) {
  let validReads = 0;
  const originalRead = db.getCalibrationProfileCache;
  db.getCalibrationProfileCache = async function (...args) {
    const record = await originalRead.apply(this, args);
    if (record && decodeCalibrationProfile(record.payloadJson, record.payloadSha256)) validReads++;
    return record;
  };
  try {
    const service = createService();
    const profiles = [];
    for (const competition of competitions) {
      const start = Date.now();
      profiles.push(...await service.warmCalibrationProfiles([competition]));
      log(JSON.stringify({ event: 'calibration_prepared', competition, durationMs: Date.now() - start }));
    }
    // A successful calculation alone is insufficient: storage failures are
    // deliberately tolerated by live predictions. Require a persisted hit for
    // every league from a fresh service before marking this job successful.
    const before = validReads;
    await createService().warmCalibrationProfiles(competitions);
    if (validReads - before !== competitions.length) {
      throw new Error('Calibration profiles could not all be reused after restart');
    }
    log(JSON.stringify({ event: 'calibration_verified', competitions: competitions.length }));
    return profiles;
  } finally {
    db.getCalibrationProfileCache = originalRead;
  }
}

async function main() {
  const url = String(process.env.TURSO_DATABASE_URL ?? '').trim();
  const authToken = String(process.env.TURSO_AUTH_TOKEN ?? '').trim();
  if (!url || !authToken) throw new Error('Missing Turso configuration');
  // Apply only the additive cache migration. No imports, bets, model parameter
  // updates, or general schema/bootstrap maintenance run in this command.
  const client = createClient({ url, authToken });
  try {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations/014_runtime_calibration_cache.sql'), 'utf8'));
  } finally {
    client.close();
  }
  const db = new DatabaseService({ skipSchemaBootstrap: true });
  return warmAndVerify(db, () => new PredictionService(db));
}

if (require.main === module) {
  main().catch((error) => {
    // Provider/client messages can contain connection details. Keep CI output
    // free of credentials; failure is visible through the nonzero exit code.
    console.error(`[calibration-warm] Failed (${error.name || 'Error'}). Check database access and cache availability.`);
    process.exitCode = 1;
  });
}

module.exports = { COMPETITIONS, warmAndVerify, main };
