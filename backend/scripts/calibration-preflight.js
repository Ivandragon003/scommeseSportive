// Read existing calibration only. Never construct application services or fit on a miss.
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join, relative, resolve } = require('node:path');

const COMPETITIONS = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function runtimeManifest(directory) {
  const hash = createHash('sha256').update('chronological-calibration-cache-v1');
  const files = [];
  function visit(current) {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts')) {
        const name = relative(directory, fullPath).replace(/\\/g, '/');
        const content = readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n');
        hash.update(name).update(content);
        files.push({ path: name, sha256: sha256(content) });
      }
    }
  }
  visit(directory);
  return { codeRevision: hash.digest('hex'), files };
}

function loadRuntime(runtimeDirectory = join(__dirname, '../dist')) {
  const directory = resolve(runtimeDirectory);
  return {
    directory,
    PredictionService: require(join(directory, 'services/PredictionService')).PredictionService,
    DatabaseService: require(join(directory, 'db/DatabaseService')).DatabaseService,
    cache: require(join(directory, 'services/CalibrationProfileCache')),
    predictionConfig: require(join(directory, 'config/predictionConfig')).predictionConfig,
    predictionEngineConfig: require(join(directory, 'config/PredictionEngineConfig')).predictionEngineConfig,
    resultDelayMs: require(join(directory, 'services/ChronologicalForecastService')).HISTORICAL_RESULT_DELAY_MS,
  };
}

/** Reuse the runtime SELECTs and normalization without DatabaseService bootstrap. */
function readOnlyDatabase(client, runtime = loadRuntime()) {
  const db = Object.create(runtime.DatabaseService.prototype);
  db.initPromise = Promise.resolve();
  db.db = {
    execute: async (statement) => {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error('Calibration preflight permits SELECT only');
      return client.execute(statement);
    },
  };
  return db;
}

/**
 * The mapper is the runtime's actual mapper, invoked without its constructor.
 * Preserve the full rows, property order, row order and selected odds order.
 */
function calibrationInputs(runtime, competition, rows, historicalOdds, asOf) {
  const prototype = runtime.PredictionService.prototype;
  const competitionKey = prototype.getCalibrationCacheKey.call({}, competition);
  const matches = prototype.mapCompletedMatches.call({}, rows);
  const eligible = matches.filter((match) => match.date.getTime() + runtime.resultDelayMs <= asOf.getTime());
  const eligibleIds = new Set(eligible.map((match) => match.matchId));
  return {
    competition: competitionKey,
    rows: rows.filter((row) => eligibleIds.has(String(row.match_id))),
    odds: eligible.map((match) => [match.matchId, historicalOdds[match.matchId]?.odds ?? null]),
  };
}

async function preflightCalibration(db, competitions = COMPETITIONS, options = {}) {
  const asOf = options.asOf ? new Date(options.asOf) : new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error('Invalid calibration preflight cutoff');
  const runtime = options.runtime ?? loadRuntime(options.runtimeDirectory);
  const manifest = runtimeManifest(runtime.directory);
  const configuration = { predictionConfig: runtime.predictionConfig, predictionEngineConfig: runtime.predictionEngineConfig };
  const configurationSha256 = sha256(JSON.stringify(configuration));
  const results = [];
  for (const competition of [...new Set(competitions)]) {
    try {
      const rows = await db.getMatches({ competition });
      const needsOdds = runtime.predictionEngineConfig.marketBlending.enableLearnedBlendWeights;
      if (needsOdds && typeof db.getHistoricalOddsDetailMap !== 'function') throw new Error('Historical odds reader unavailable');
      const odds = needsOdds ? await db.getHistoricalOddsDetailMap({ competition }) : {};
      const inputs = calibrationInputs(runtime, competition, rows, odds, asOf);
      const cacheKey = runtime.cache.calibrationProfileFingerprint(inputs, configuration);
      // Detect a changed runtime on disk or a module loaded from another build.
      if (cacheKey !== sha256(JSON.stringify([manifest.codeRevision, configuration, inputs]))) {
        throw new Error('Loaded runtime and runtime manifest differ');
      }
      const stored = await db.getCalibrationProfileCache(cacheKey);
      const profile = stored && runtime.cache.decodeCalibrationProfile(stored.payloadJson, stored.payloadSha256);
      const status = !stored ? 'MISS' : profile ? 'HIT' : 'INVALID';
      results.push({
        competition, status, ready: status === 'HIT' && profile.nObservations > 0,
        cacheKey, eligibleMatches: inputs.rows.length, observations: profile?.nObservations ?? 0,
        byFamily: Object.fromEntries(Object.entries(profile?.byFamily ?? {}).map(([family, curve]) => [family, curve.nObservations])),
        learnedBlendFamilies: Object.keys(profile?.learnedBlendWeights ?? {}),
        componentHashes: {
          code: manifest.codeRevision, configuration: configurationSha256,
          rows: sha256(JSON.stringify(inputs.rows)), odds: sha256(JSON.stringify(inputs.odds)),
          completeInputs: sha256(JSON.stringify(inputs)),
        },
        ...(status === 'HIT' && profile.nObservations === 0 ? { reason: 'calibration_no_observations' } : {}),
      });
    } catch {
      // Database errors can include credentials. Fail closed without leaking them.
      results.push({ competition, status: 'ERROR', ready: false, reason: 'calibration_preflight_read_or_runtime_error' });
    }
  }
  if (runtimeManifest(runtime.directory).codeRevision !== manifest.codeRevision
    || sha256(JSON.stringify(configuration)) !== configurationSha256) {
    throw new Error('Runtime or configuration changed during calibration preflight');
  }
  return {
    asOf: asOf.toISOString(), ready: results.every((row) => row.ready),
    competitions: results,
    runtime: { directory: runtime.directory, ...manifest, configurationSha256,
      dependencyEnvironment: {
        node: process.version, platform: process.platform, arch: process.arch,
        packageLockSha256: sha256(readFileSync(join(__dirname, '../package-lock.json'))),
      } },
    writes: 0, fits: 0, providerRequests: 0,
    limitations: [
      'Exact cache compatibility is separate from per-market sample gates and saved live-model parameter checks.',
      'The cutoff follows the existing two-hour result-delay proxy; it does not prove historical publication times.',
      'Run after imports and before prediction; any subsequent input, quote, configuration or code change requires another preflight.',
      'The existing fingerprint does not directly include Node, OS or package-lock; dependency metadata is reported separately without changing compatibility rules.',
    ],
  };
}

async function main() {
  // This command is an explicit read-only action. No environment URL is printed.
  if (!process.argv.includes('--read-database')) throw new Error('Use --read-database to inspect the configured database');
  const { createClient } = require('@libsql/client');
  const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  try {
    const result = await preflightCalibration(readOnlyDatabase(client));
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 2;
  } finally { client.close(); }
}

if (require.main === module) main().catch(() => {
  console.error('[calibration-preflight] Failed; no calibration or database changes were attempted.');
  process.exitCode = 1;
});

module.exports = { COMPETITIONS, runtimeManifest, loadRuntime, readOnlyDatabase, calibrationInputs, preflightCalibration };
