#!/usr/bin/env node
// Local-only, synthetic acceptance test. No environment file is read or inherited.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, writeFileSync, renameSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const net = require('node:net');
const { performance } = require('node:perf_hooks');

const root = resolve(__dirname, '..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const resourceSnapshot = () => ({ rssMiB: process.memoryUsage().rss / 1048576,
  peakRssMiB: process.resourceUsage().maxRSS / 1024, cpuMs: (process.cpuUsage().user + process.cpuUsage().system) / 1000 });
const cgroupSnapshot = () => {
  try {
    const value = (name) => readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim();
    return { cpuMax: value('cpu.max'), memoryMax: value('memory.max'),
      memoryPeakMiB: Number(value('memory.peak')) / 1048576, memoryCurrentMiB: Number(value('memory.current')) / 1048576 };
  } catch {
    try {
      const value = (name) => readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim();
      return { version: 1, cpuQuotaUs: Number(value('cpu/cpu.cfs_quota_us')),
        cpuPeriodUs: Number(value('cpu/cpu.cfs_period_us')), memoryMax: value('memory/memory.limit_in_bytes'),
        memoryPeakMiB: Number(value('memory/memory.max_usage_in_bytes')) / 1048576,
        memoryCurrentMiB: Number(value('memory/memory.usage_in_bytes')) / 1048576 };
    } catch { return null; }
  }
};

function ensureLocalEnvironment() {
  assert.equal(process.env.HOSTLESS_SYNTHETIC_ACCEPTANCE, 'true');
  assert.match(process.env.TURSO_DATABASE_URL || '', /^file:.*synthetic-hostless-/);
  assert.equal(process.env.TURSO_AUTH_TOKEN, 'synthetic-local-token');
  assert.equal(process.env.ODDS_API_KEY, 'synthetic-never-sent');
}

async function child(mode) {
  ensureLocalEnvironment();
  // Any unforeseen external HTTP call must fail before a socket is created.
  for (const protocol of ['node:http', 'node:https']) {
    const transport = require(protocol);
    for (const method of ['request', 'get']) transport[method] = () => { throw new Error('External HTTP is forbidden in synthetic acceptance'); };
  }
  process.on('message', (message) => {
    if (message.type === 'metrics') process.send({ type: 'metrics', requestId: message.requestId, ...resourceSnapshot() });
  });
  if (mode === 'web') {
    require('../dist/index'); // The actual production Express entrypoint, including shared-admin authentication.
    process.send({ type: 'ready' });
    return;
  }
  const axios = require('axios');
  const { providerEvents } = require('./hostless-integration-fixtures');
  const { DatabaseService } = require('../dist/db/DatabaseService');
  const { ResearchStore } = require('../dist/research/ResearchStore');
  const { SmartOddsRequestStore } = require('../dist/services/odds-provider/SmartOddsRequestStore');
  const { ResearchRuntime } = require('../dist/research/ResearchRuntime');
  const { ResearchWorkerCoordinator } = require('../dist/research/ResearchWorkerCoordinator');
  const { startWorker } = require('./research-worker');
  const clock = () => new Date(readFileSync(process.env.HOSTLESS_SYNTHETIC_CLOCK, 'utf8'));
  const db = new DatabaseService({ skipSchemaBootstrap: true });
  db.research = new ResearchStore(db.db, async () => {}, { now: clock });
  db.oddsRequests = new SmartOddsRequestStore(db.db, async () => {}, { clock });
  axios.get = async (url) => {
    assert.equal(url, 'https://api.the-odds-api.com/v4/sports/soccer_italy_serie_a/odds');
    process.send({ type: 'fixture_odds_transport' });
    return { data: providerEvents(), headers: { 'x-requests-used': '3', 'x-requests-remaining': '497', 'x-requests-last': '3' } };
  };
  const runtime = new ResearchRuntime(db, { clock, coordinator: new ResearchWorkerCoordinator(db.db, async () => {}, { clock }) });
  const originalTick = runtime.tick.bind(runtime);
  runtime.tick = async () => {
    const start = performance.now();
    try {
      const summary = await originalTick();
      process.send({ type: 'tick', summary, elapsedMs: performance.now() - start, resources: resourceSnapshot() });
      return summary;
    } catch (error) { process.send({ type: 'failure', message: error.message }); throw error; }
  };
  const worker = await startWorker({ enabled: true, db, runtime, log: () => {} });
  process.on('message', (message) => { if (message.type === 'tick') void runtime.tick().catch(() => undefined); });
  process.on('SIGTERM', async () => {
    await worker.stop();
    process.exit(0);
  });
  process.send({ type: 'ready' });
}

function launch(mode, env) {
  const childProcess = fork(__filename, ['--child', mode], { cwd: root, env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = [];
  let output = '';
  childProcess.stdout.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
  childProcess.stderr.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
  childProcess.on('message', (message) => messages.push({ ...message, wallAt: performance.now() }));
  const waitFor = async (predicate, timeout = 30000) => {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      const failure = messages.find((message) => message.type === 'failure');
      if (failure) throw new Error(failure.message);
      const found = messages.find(predicate);
      if (found) return found;
      if (childProcess.exitCode !== null || childProcess.signalCode !== null) throw new Error(`Synthetic ${mode} exited: ${output}`);
      await pause(25);
    }
    throw new Error(`Timed out waiting for synthetic ${mode}: ${output}`);
  };
  return { process: childProcess, messages, waitFor,
    metrics: async () => {
      const requestId = String(performance.now()); childProcess.send({ type: 'metrics', requestId });
      return waitFor((message) => message.type === 'metrics' && message.requestId === requestId);
    } };
}

async function availablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function run() {
  const { DatabaseService } = require('../dist/db/DatabaseService');
  const { ResearchStore } = require('../dist/research/ResearchStore');
  const { baselineManifest } = require('../dist/research/ForecastCore');
  const { createPasswordHash } = require('../dist/security/SharedAdminAuth');
  const { BEFORE, TARGET, KICKOFF, fixtures, artifact, evidence } = require('./hostless-integration-fixtures');
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-hostless-'));
  const databaseUrl = `file:${join(directory, 'acceptance.db')}`;
  const clockPath = join(directory, 'clock.txt');
  let now = BEFORE;
  const setClock = (value) => {
    now = value; writeFileSync(`${clockPath}.next`, now); renameSync(`${clockPath}.next`, clockPath);
  };
  setClock(now);
  // Explicit allowlist: real DB URLs, API keys and secrets cannot reach child processes.
  const inherited = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LD_LIBRARY_PATH'];
  const env = Object.fromEntries(inherited.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, { NODE_ENV: 'production', PORT: String(await availablePort()),
    TURSO_DATABASE_URL: databaseUrl, TURSO_AUTH_TOKEN: 'synthetic-local-token',
    SHARED_ADMIN_PASSWORD_HASH: await createPasswordHash('synthetic-only-password'),
    NIGHTLY_ORCHESTRATOR: 'github_actions', AUTO_SYNC_ON_BOOT: 'false', UNDERSTAT_SCHEDULER_ENABLED: 'false',
    ODDS_SNAPSHOT_SCHEDULER_ENABLED: 'false', LEARNING_REVIEW_SCHEDULER_ENABLED: 'false',
    LINEUP_REFRESH_SCHEDULER_ENABLED: 'false', PLAYER_DATA_ENABLED: 'false', PLAYER_AVAILABILITY_ENABLED: 'false',
    AUTO_BET_ENABLED: 'true', AUTO_BET_DRY_RUN: 'false', RESEARCH_T15_SCHEDULER_ENABLED: 'true',
    ODDS_API_KEY: 'synthetic-never-sent', ODDS_API_ACCOUNT_SCOPE: 'synthetic-test-account',
    HOSTLESS_SYNTHETIC_ACCEPTANCE: 'true', HOSTLESS_SYNTHETIC_CLOCK: clockPath });
  // The coordinator process also receives only synthetic DB credentials.
  process.env.TURSO_DATABASE_URL = databaseUrl; process.env.TURSO_AUTH_TOKEN = env.TURSO_AUTH_TOKEN;
  const db = new DatabaseService();
  const processes = [];
  try {
    await db.getMatches();
    await db.db.execute('PRAGMA journal_mode=WAL');
    db.research = new ResearchStore(db.db, async () => {}, { now: () => new Date(now) });
    await db.research.initializePortfolios();
    for (const fixture of fixtures) {
      await db.upsertTeam({ teamId: fixture.homeTeamId, name: fixture.homeTeamName, competition: fixture.competition });
      await db.upsertTeam({ teamId: fixture.awayTeamId, name: fixture.awayTeamName, competition: fixture.competition });
      await db.upsertMatches(Array.from({ length: 45 }, (_, index) => ({ ...fixture,
        matchId: `${fixture.matchId}-history-${index}`,
        date: new Date(Date.parse(TARGET) - (index + 2) * 86400000).toISOString(),
        homeGoals: 3 + index % 2, awayGoals: 0, homeXG: 3.2, awayXG: .2 })));
      await db.upsertMatch(fixture);
    }
    const model = artifact();
    for (const family of ['A', 'C']) {
      const version = family === 'A' ? baselineManifest().version : model.version;
      await db.research.saveModel({ family, version, artifact: family === 'A' ? baselineManifest() : model });
      const benchmark = await db.research.saveBenchmark({ family, modelVersion: version, report: evidence(family, version) });
      await db.research.setMarketState({ family, modelVersion: version, market: '1x2', state: 'SHADOW',
        evidence: { benchmarkId: benchmark.id }, reason: 'Synthetic Hostless integration fixture only.' });
    }
    const web = launch('web', env); processes.push(web);
    await web.waitFor((message) => message.type === 'ready');
    const base = `http://127.0.0.1:${env.PORT}/api`;
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { health = await fetch(`${base}/health`); if (health.ok) break; } catch { /* Wait for actual listen callback. */ }
      await pause(50);
    }
    assert.equal(health?.status, 200);
    const retired = await fetch(`${base}/automation/place-valid-bets`, { method: 'POST' });
    assert.equal(retired.status, 410);
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ password: 'synthetic-only-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const webIdle = await web.metrics();
    setClock(new Date(Date.parse(TARGET) - 30000).toISOString());
    const worker = launch('worker', env); processes.push(worker);
    await worker.waitFor((message) => message.type === 'tick');
    const standby = launch('worker', env); processes.push(standby);
    const standbyTick = await standby.waitFor((message) => message.type === 'tick');
    assert.equal(standbyTick.summary.busy, true);
    assert.equal((await db.research.listBets()).length, 0);
    assert.equal(worker.messages.filter((message) => message.type === 'fixture_odds_transport').length, 0);
    // Exercise the real 15-second timer once before T-15. Polling must not fetch prices.
    setClock(new Date(Date.parse(TARGET) - 15000).toISOString());
    const beforeTick = await worker.waitFor((message) => message.type === 'tick' && message.summary.at === now, 22000);
    assert.equal(beforeTick.summary.claimed, 0);
    assert.equal(worker.messages.filter((message) => message.type === 'fixture_odds_transport').length, 0);
    const workerIdle = await worker.metrics();
    setClock(TARGET);
    const cohortStart = performance.now();
    worker.process.send({ type: 'tick' });
    standby.process.send({ type: 'tick' });
    const decisionTick = await worker.waitFor((message) => message.type === 'tick' && message.summary.at === TARGET && !message.summary.busy);
    assert.equal(decisionTick.summary.errors, 0);
    assert.equal(decisionTick.summary.completed, fixtures.length);
    const cohortMs = performance.now() - cohortStart;
    const bets = await db.research.listBets();
    const decisions = await db.research.listDecisions();
    assert.equal(bets.length, 6); assert.equal(decisions.length, 6);
    assert.ok(bets.every((bet) => bet.stakeCents === 1000 && bet.odds === 1.9 && bet.selection === 'homeWin'));
    for (const fixture of fixtures) {
      const pair = decisions.filter((decision) => decision.snapshot?.quote && bets.some((bet) => bet.matchId === fixture.matchId && bet.decisionId === decision.id));
      assert.equal(pair.length, 2);
      assert.equal(new Set(pair.map((decision) => decision.snapshot.inputHash)).size, 1);
      assert.notEqual(pair[0].snapshot.probabilityStages.raw.homeWin, pair[1].snapshot.probabilityStages.raw.homeWin);
    }
    assert.equal([...worker.messages, ...standby.messages].filter((message) => message.type === 'fixture_odds_transport').length, 1);
    const quota = await db.oddsRequests.overview();
    assert.equal(quota.providers[0].requests, 1); assert.equal(quota.providers[0].chargedCredits, 3);
    const workerPeak = await worker.metrics();
    // Simulate an unexpected process death, then start two workers against the same DB.
    worker.process.kill('SIGKILL'); await once(worker.process, 'exit');
    // Crash recovery waits for the persisted 30s lease, still inside the 60s T-15 window.
    setClock(new Date(Date.parse(TARGET) + 31000).toISOString());
    const restartStart = performance.now();
    standby.process.send({ type: 'tick' });
    await standby.waitFor((message) => message.type === 'tick' && message.summary.at === now && !message.summary.busy);
    const restarted = launch('worker', env); processes.push(restarted);
    await restarted.waitFor((message) => message.type === 'tick');
    const restartMs = performance.now() - restartStart;
    assert.equal((await db.research.listBets()).length, 6);
    assert.equal((await db.research.listDecisions()).length, 6);
    assert.equal(restarted.messages.filter((message) => message.type === 'fixture_odds_transport').length, 0);
    assert.equal(standby.messages.filter((message) => message.type === 'fixture_odds_transport').length, 0);
    setClock(new Date(Date.parse(KICKOFF) + 2 * 3600000).toISOString());
    for (const fixture of fixtures) await db.upsertMatch({ ...fixture, homeGoals: 2, awayGoals: 0 });
    const settleStart = performance.now();
    const settlement = await fetch(`${base}/research/settle`, { method: 'POST', headers: { cookie, origin: 'http://localhost:3000' } });
    assert.equal(settlement.status, 200); assert.equal((await settlement.json()).data.settled, 6);
    const settleMs = performance.now() - settleStart;
    const repeated = await fetch(`${base}/research/settle`, { method: 'POST', headers: { cookie, origin: 'http://localhost:3000' } });
    assert.equal((await repeated.json()).data.settled, 0);
    const portfolios = await db.research.listPortfolios();
    assert.deepEqual(portfolios.map((portfolio) => [portfolio.availableCents, portfolio.committedCents, portfolio.equityCents]),
      [[102700, 0, 102700], [102700, 0, 102700]]);
    for (const portfolio of portfolios) {
      const ledger = await db.research.listLedger(portfolio.id);
      assert.equal(ledger.reduce((sum, entry) => sum + entry.availableDeltaCents, 0), portfolio.availableCents);
      assert.equal(ledger.reduce((sum, entry) => sum + entry.committedDeltaCents, 0), 0);
    }
    const result = { syntheticTestOnly: true, realProviderRequests: 0, realCreditsConsumed: 0,
      platform: process.platform, node: process.version, simultaneousMatches: fixtures.length,
      sample: { historicalMatches: fixtures.length * 45, syntheticCArtifact: true,
        productionDatasetMemoryMeasured: false, container: cgroupSnapshot() },
      assertions: ['actual_backend_health', 'production_auth', 'legacy_410_even_enabled', '15s_poll_without_odds',
        'A_C_independent_shared_snapshot', 'two_workers_concurrent_single_transport', '6_virtual_bets', 'SIGKILL_restart',
        'standby_takeover_after_lease', 'restarted_process_no_duplicates', '6_settlements', 'idempotent_settlement', 'two_ledger_balances'],
      timing: { pollIntervalObservedMs: beforeTick.wallAt - worker.messages.find((message) => message.type === 'tick').wallAt,
        simultaneousCohortMs: cohortMs, decisionTickMs: decisionTick.elapsedMs, restartMs, settlementMs: settleMs },
      resources: { backendIdle: webIdle, backendAfterSettlement: await web.metrics(), workerIdle, workerAfterDecisions: workerPeak,
        restartedWorker: await restarted.metrics(), standbyWorker: await standby.metrics() },
      cpu: { workerCohortCpuMs: workerPeak.cpuMs - workerIdle.cpuMs,
        note: 'Cumulative process CPU deltas include orchestration, database and inference. These are synthetic samples, not production load guarantees.' },
      simulatedQuota: { requests: quota.providers[0].requests, chargedCredits: quota.providers[0].chargedCredits },
      portfolios: portfolios.map(({ id, availableCents, committedCents, equityCents }) => ({ id, availableCents, committedCents, equityCents })) };
    const output = process.argv.find((argument) => argument.startsWith('--output='))?.slice(9);
    if (output) { mkdirSync(require('node:path').dirname(resolve(output)), { recursive: true }); writeFileSync(resolve(output), JSON.stringify(result, null, 2) + '\n'); }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    for (const entry of processes) if (entry.process.exitCode === null && entry.process.signalCode === null) entry.process.kill('SIGTERM');
    await Promise.all(processes.map(async (entry) => {
      if (entry.process.exitCode !== null || entry.process.signalCode !== null) return;
      await Promise.race([once(entry.process, 'exit'), pause(3000)]);
      if (entry.process.exitCode === null && entry.process.signalCode === null) entry.process.kill('SIGKILL');
    }));
    db.db.close();
    // Leave only synthetic temp files for OS cleanup (Windows libSQL can retain WAL handles).
  }
}

(process.argv[2] === '--child' ? child(process.argv[3]) : run()).catch((error) => {
  console.error(`Synthetic Hostless acceptance failed: ${error.stack}`);
  if (process.argv[2] === '--child') process.exit(1);
  process.exitCode = 1;
});
