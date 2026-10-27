#!/usr/bin/env node
// Offline sizing only: a private local snapshot, a temporary file DB, no provider requests or bets.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join, dirname } = require('node:path');
const { performance } = require('node:perf_hooks');
const argument = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const snapshot = () => ({ rssMiB: process.memoryUsage().rss / 1048576,
  heapUsedMiB: process.memoryUsage().heapUsed / 1048576,
  peakRssMiB: process.resourceUsage().maxRSS / 1024 });
const safeEnvironment = () => Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LD_LIBRARY_PATH']
  .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));

async function measure() {
  assert.match(argument('--measure'), /^file:.*synthetic-hostless-sizing-/);
  process.env.TURSO_DATABASE_URL = argument('--measure');
  process.env.TURSO_AUTH_TOKEN = 'synthetic-local-token';
  const { DatabaseService } = require('../dist/db/DatabaseService');
  const { researchMatchFromRow } = require('../dist/research/ResearchRuntime');
  const { buildForecastInput, baselineManifest } = require('../dist/research/ForecastCore');
  const { validateArtifact, predictHybrid } = require('../dist/research/CatBoostModel');
  const db = new DatabaseService({ skipSchemaBootstrap: true });
  try {
    const started = performance.now(), cpu = process.cpuUsage();
    const beforeLoad = snapshot();
    const history = (await db.getMatches()).map(researchMatchFromRow);
    const historyLoaded = snapshot(), loadMs = performance.now() - started;
    const artifact = JSON.parse(readFileSync(argument('--artifact'), 'utf8'));
    assert.notEqual(artifact.diagnosticOnly, true);
    validateArtifact(artifact);
    assert.equal(artifact.baselineVersion, baselineManifest().version, 'Sizing must use the actual compatible baseline');
    const loaded = snapshot();
    const availableAt = Math.max(Date.parse(artifact.createdAt), Date.parse(artifact.validationThrough));
    const requestedCount = Number(argument('--count') || 20);
    assert.ok(Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 100);
    const targets = history.filter((match) => match.homeGoals == null && match.awayGoals == null
      && Date.parse(match.date) - 15 * 60000 > availableAt)
      .sort((left, right) => Date.parse(left.date) - Date.parse(right.date)).slice(0, requestedCount);
    assert.equal(targets.length, requestedCount, 'Local snapshot has insufficient future fixture inputs');
    const results = [];
    for (const target of targets) {
      const wall = performance.now(), cpuBefore = process.cpuUsage();
      const input = buildForecastInput(history, target, new Date(Date.parse(target.date) - 15 * 60000).toISOString());
      const inference = performance.now();
      const prediction = predictHybrid(input, artifact);
      assert.ok(Object.values(prediction.probabilities).every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
      const cpuDelta = process.cpuUsage(cpuBefore);
      results.push({ matchId: target.matchId, competition: target.competition, trainingCount: input.trainingCount,
        baselineAndFeaturesMs: inference - wall, cInferenceMs: performance.now() - inference,
        totalMs: performance.now() - wall, cpuMs: (cpuDelta.user + cpuDelta.system) / 1000, ...snapshot() });
    }
    const cpuDelta = process.cpuUsage(cpu);
    const result = { resourceSampleOnly: true, productionReadinessEstablished: false,
      noBetsCreated: true, realProviderRequests: 0, realCreditsConsumed: 0,
      platform: process.platform, node: process.version, historyCount: history.length,
      historyLoadMs: loadMs, modelVersion: artifact.version, modelArtifactBytes: Buffer.byteLength(JSON.stringify(artifact)),
      productionValidated: artifact.productionValidated === true,
      memory: { beforeLoad, historyLoaded, artifactLoaded: loaded, afterCohort: snapshot() },
      cohort: { count: results.length, totalMs: results.reduce((sum, row) => sum + row.totalMs, 0),
        first3Ms: results.slice(0, 3).reduce((sum, row) => sum + row.totalMs, 0),
        cpuMs: results.reduce((sum, row) => sum + row.cpuMs, 0), results },
      totalCpuMs: (cpuDelta.user + cpuDelta.system) / 1000, totalWallMs: performance.now() - started,
      limits: ['Local exported history; no remote Turso latency measured.',
        'Sequential full A fit/features + C inference; calibration, quote acquisition and ledger not included.',
        'No market decisions, validation gates, benchmark outcomes or production artifacts are changed.'] };
    return result;
  } finally { await db.close(); }
}

async function seed(url, matchesPath) {
  assert.match(url, /^file:.*synthetic-hostless-sizing-/);
  process.env.TURSO_DATABASE_URL = url; process.env.TURSO_AUTH_TOKEN = 'synthetic-local-token';
  const { DatabaseService } = require('../dist/db/DatabaseService');
  const db = new DatabaseService();
  try {
    await db.getMatches();
    const history = JSON.parse(readFileSync(resolve(matchesPath), 'utf8'));
    await db.upsertMatches(history);
  } finally { await db.close(); }
}

async function run() {
  const matchesPath = argument('--matches'), artifactPath = argument('--artifact');
  if (!matchesPath || !artifactPath) throw new Error('Usage: node scripts/hostless-resource-sample.js --matches <local.json> --artifact <local.json> [--count 20] [--output <result.json>]');
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-hostless-sizing-'));
  const url = `file:${join(directory, 'matches.db')}`;
  const seeded = spawnSync(process.execPath, [__filename, '--seed', url, '--matches', resolve(matchesPath)],
    { cwd: resolve(__dirname, '..'), env: safeEnvironment(), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (seeded.status !== 0) throw new Error(`Local fixture import failed: ${seeded.stderr || seeded.stdout}`);
  // The lightweight parent never imports the dataset: a fork cannot inherit the importer's peak RSS.
  const measured = spawnSync(process.execPath, [__filename, '--measure', url, '--artifact', resolve(artifactPath),
    '--count', argument('--count') || '20'], { cwd: resolve(__dirname, '..'), env: safeEnvironment(),
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (measured.status !== 0) throw new Error(`Sizing subprocess failed: ${measured.stderr || measured.stdout}`);
  const result = JSON.parse(measured.stdout);
  const output = argument('--output');
  if (output) { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(resolve(output), JSON.stringify(result, null, 2) + '\n'); }
  console.log(JSON.stringify(result, null, 2));
}

(argument('--seed') ? seed(argument('--seed'), argument('--matches'))
  : argument('--measure') ? measure().then((result) => console.log(JSON.stringify(result))) : run()).catch((error) => {
  console.error(`Offline resource sample failed: ${error.stack}`); process.exitCode = 1;
});
