const test = require('node:test');
const assert = require('node:assert/strict');
const { SystemObservabilityService } = require('../dist/services/SystemObservabilityService.js');

const createDbStub = (systemRuns = []) => {
  const savedRuns = [];
  return {
    savedRuns,
    listCalls: 0,
    async saveSystemRun(entry) {
      savedRuns.push(entry);
      return savedRuns.length;
    },
    async listRecentSystemRuns(limit) {
      this.listCalls += 1;
      return systemRuns.slice(0, limit);
    },
  };
};

test('SystemObservabilityService registra provider run e aggiorna snapshot', async () => {
  const db = createDbStub();
  const svc = new SystemObservabilityService(db);

  await svc.recordProviderRun({
    requestId: 'req_1',
    runId: 'run_1',
    provider: 'odds_api',
    competition: 'Serie A',
    meetingAlias: null,
    sourceUsed: 'odds_api',
    matchCount: 10,
    marketCount: 42,
    fixtureCount: 10,
    matchesWithBaseOdds: 10,
    matchesWithExtendedGroups: 3,
    durationMs: 14000,
    success: true,
    fallbackUsed: false,
    warnings: [],
    providerHealth: {
      odds_api: { status: 'healthy', checkedAt: '2026-04-16T10:00:00.000Z' },
    },
    startedAt: '2026-04-16T10:00:00.000Z',
    endedAt: '2026-04-16T10:00:14.000Z',
  });

  const snapshot = svc.getLastProviderSnapshot();
  assert.equal(snapshot.provider, 'odds_api');
  assert.equal(snapshot.matchCount, 10);
  assert.equal(snapshot.marketCount, 42);
  assert.equal(db.savedRuns.length, 1);
  assert.equal(db.savedRuns[0].runType, 'provider_fetch');
});

test('typed cache-policy skips are informational while mixed failures and explicit errors remain errors', async (t) => {
  const info = [], errors = [];
  t.mock.method(console, 'info', (line) => info.push(JSON.parse(line)));
  t.mock.method(console, 'error', (line) => errors.push(JSON.parse(line)));
  const db = createDbStub();
  const svc = new SystemObservabilityService(db);
  const skipped = { provider: 'odds_api', status: 'not_checked', message: 'odds_cache_only',
    details: { skipReason: 'odds_cache_only' } };
  const entry = { runId: 'cache-skip', provider: 'odds_api', sourceUsed: 'odds_api', matchCount: 0,
    marketCount: 0, success: false, warnings: ['odds_api: odds_cache_only'], errorCategory: null,
    providerHealth: { odds_api: skipped }, startedAt: '2026-10-29T12:00:00Z' };
  await svc.recordProviderRun(entry);
  assert.equal(info[0].level, 'info');
  assert.equal(info[0].outcome, 'skipped');
  assert.equal(errors.length, 0);
  assert.equal(db.savedRuns[0].success, false);
  assert.equal(db.savedRuns[0].metadata.skipReason, 'odds_cache_only');
  const health = await svc.getProviderHealthPayload();
  assert.equal(health.status, 'unknown');
  assert.equal(health.activeProvider, null);
  assert.equal(health.matchCount, 0);
  await svc.recordProviderRun({ ...entry, runId: 'explicit-timeout', errorCategory: 'timeout' });
  await svc.recordProviderRun({ ...entry, runId: 'mixed-failure', providerHealth: {
    odds_api: skipped, another: { status: 'unhealthy', message: 'provider unavailable' },
  } });
  assert.equal(errors.length, 2);
  assert.ok(errors.every((log) => log.level === 'error' && log.outcome === undefined));
  assert.equal(db.savedRuns[1].errorCategory, 'timeout');
  assert.equal(db.savedRuns[2].metadata.outcome, undefined);
});

test('SystemObservabilityService aggrega metriche provider e sync', async () => {
  const db = createDbStub([
    {
      runId: 1,
      runType: 'provider_fetch',
      component: 'odds_api_provider',
      provider: 'odds_api',
      matchCount: 8,
      marketCount: 32,
      fixtureCount: 10,
      durationMs: 12000,
      success: true,
      fallbackUsed: false,
      warningCount: 0,
      errorCategory: null,
      warnings: [],
      metadata: { providerHealth: { odds_api: { status: 'healthy' } } },
      startedAt: '2026-04-16T10:00:00.000Z',
      endedAt: '2026-04-16T10:00:12.000Z',
    },
    {
      runId: 2,
      runType: 'provider_fetch',
      component: 'odds_api_provider',
      provider: 'odds_api',
      matchCount: 4,
      marketCount: 10,
      fixtureCount: 10,
      durationMs: 18000,
      success: true,
      fallbackUsed: true,
      warningCount: 1,
      errorCategory: 'provider_degraded',
      warnings: ['provider degradato'],
      metadata: { providerHealth: { odds_api: { status: 'degraded' } } },
      startedAt: '2026-04-16T09:00:00.000Z',
      endedAt: '2026-04-16T09:00:18.000Z',
    },
    {
      runId: 3,
      runType: 'sync',
      component: 'understat_scheduler',
      success: true,
      warningCount: 0,
      errorCategory: null,
      startedAt: '2026-04-16T01:00:00.000Z',
      endedAt: '2026-04-16T01:00:50.000Z',
      durationMs: 50000,
    },
  ]);
  const svc = new SystemObservabilityService(db);

  const metrics = await svc.getMetricsPayload();

  assert.equal(metrics.provider.oddsApiSuccessRatePct, 100);
  assert.equal(metrics.provider.fallbackRatePct, 50);
  assert.equal(metrics.provider.fixtureMatchRatePct, 60);
  assert.equal(metrics.provider.avgScrapeLatencyMs, 15000);
  assert.equal(metrics.sync.successRatePct, 100);
  assert.equal(metrics.trends.topErrorCategories[0].category, 'provider_degraded');
});

const skippedProviderRun = (runId) => ({
  runId, runType: 'provider_fetch', provider: 'odds_api', success: false, matchCount: 0,
  fixtureCount: 10, marketCount: 0, durationMs: 50, fallbackUsed: false,
  warningCount: 1, warnings: ['odds_api: odds_cache_only'], errorCategory: null,
  metadata: { outcome: 'skipped', skipReason: 'odds_cache_only', providerHealth: {
    odds_api: { status: 'not_checked', details: { skipReason: 'odds_cache_only' } },
  } }, startedAt: '2026-10-29T12:00:00Z',
});

test('all skipped provider lookups report zero attempts without successes, failures or latency', async () => {
  const runs = [skippedProviderRun('skip-1'), skippedProviderRun('skip-2')];
  const svc = new SystemObservabilityService(createDbStub(runs));
  const metrics = await svc.getMetricsPayload();
  assert.equal(metrics.provider.requestsObserved, 2);
  assert.equal(metrics.provider.attemptsObserved, 0);
  assert.equal(metrics.provider.requestsSkipped, 2);
  assert.equal(metrics.provider.oddsApiSuccessRatePct, 0);
  assert.equal(metrics.provider.fallbackRatePct, 0);
  assert.equal(metrics.provider.fixtureMatchRatePct, 0);
  assert.equal(metrics.provider.avgScrapeLatencyMs, null);
  assert.equal(metrics.provider.avgMarketsFound, null);
  assert.equal(metrics.trends.errorRuns, 0);
  assert.equal(metrics.trends.skippedRuns, 2);
  assert.deepEqual(metrics.trends.topErrorCategories, []);
  const recent = await svc.getRecentRunsPayload();
  assert.equal(recent.count, 2);
  assert.ok(recent.runs.every((run) => run.status === 'skipped' && run.success === false));
});

test('mixed provider summaries exclude only explicit skips from rates and preserve genuine errors', async () => {
  const runs = [skippedProviderRun('skip-1'), skippedProviderRun('skip-2'), {
    runId: 'success', runType: 'provider_fetch', provider: 'odds_api', success: true,
    matchCount: 3, fixtureCount: 5, marketCount: 4, durationMs: 1000, fallbackUsed: true,
    metadata: { providerHealth: { odds_api: { status: 'healthy' } } }, startedAt: '2026-10-29T11:00:00Z',
  }, {
    runId: 'failure', runType: 'provider_fetch', provider: 'odds_api', success: false,
    matchCount: 0, fixtureCount: 1, marketCount: 0, durationMs: 3000, errorCategory: 'timeout',
    metadata: { providerHealth: { odds_api: { status: 'unhealthy' } } }, startedAt: '2026-10-29T10:00:00Z',
  }];
  const svc = new SystemObservabilityService(createDbStub(runs));
  const metrics = await svc.getMetricsPayload();
  assert.equal(metrics.provider.requestsObserved, 4);
  assert.equal(metrics.provider.attemptsObserved, 2);
  assert.equal(metrics.provider.requestsSkipped, 2);
  assert.equal(metrics.provider.oddsApiSuccessRatePct, 50);
  assert.equal(metrics.provider.fallbackRatePct, 50);
  assert.equal(metrics.provider.fixtureMatchRatePct, 50);
  assert.equal(metrics.provider.avgScrapeLatencyMs, 2000);
  assert.equal(metrics.provider.avgMarketsFound, 2);
  assert.equal(metrics.trends.errorRuns, 1);
  assert.equal(metrics.trends.skippedRuns, 2);
  assert.deepEqual(metrics.trends.topErrorCategories, [{ category: 'timeout', count: 1 }]);
  const recent = await svc.getRecentRunsPayload();
  assert.deepEqual(recent.runs.map(({ runId, status }) => [runId, status]), [
    ['skip-1', 'skipped'], ['skip-2', 'skipped'], ['success', 'ok'], ['failure', 'error'],
  ]);
});

test('a failed lookup without explicit skipped metadata or with a real error remains an error', async () => {
  const unmarked = skippedProviderRun('unmarked'); delete unmarked.metadata.outcome;
  const conflicting = { ...skippedProviderRun('conflicting'), errorCategory: 'timeout' };
  const svc = new SystemObservabilityService(createDbStub([unmarked, conflicting]));
  const metrics = await svc.getMetricsPayload();
  assert.equal(metrics.provider.attemptsObserved, 2);
  assert.equal(metrics.provider.requestsSkipped, 0);
  assert.equal(metrics.trends.errorRuns, 2);
  assert.equal(metrics.trends.skippedRuns, 0);
  assert.ok((await svc.getRecentRunsPayload()).runs.every((run) => run.status === 'error'));
});

test('SystemObservabilityService coalesces and caches repeated metrics reads', async () => {
  const db = createDbStub([]);
  const svc = new SystemObservabilityService(db);

  await Promise.all([svc.getMetricsPayload(), svc.getMetricsPayload()]);
  await svc.getMetricsPayload();

  assert.equal(db.listCalls, 1);
});

test('SystemObservabilityService costruisce provider health con Odds API primario', async () => {
  const previousPrimary = process.env.ODDS_PRIMARY_PROVIDER;
  const previousKey = process.env.ODDS_API_KEY;
  process.env.ODDS_PRIMARY_PROVIDER = 'odds_api';
  process.env.ODDS_API_KEY = 'configured';
  const db = createDbStub();
  const svc = new SystemObservabilityService(db);

  try {
    await svc.recordProviderRun({
      runId: 'run_2',
      provider: 'odds_api',
      competition: 'Serie A',
      sourceUsed: 'odds_api',
      matchCount: 3,
      marketCount: 12,
      fixtureCount: 5,
      matchesWithBaseOdds: 3,
      matchesWithExtendedGroups: 0,
      durationMs: 9000,
      success: true,
      fallbackUsed: false,
      fallbackReason: null,
      warnings: [],
      providerHealth: {
        odds_api: { status: 'healthy', checkedAt: '2026-04-16T10:00:01.000Z', message: 'provider operativo' },
      },
      startedAt: '2026-04-16T10:00:00.000Z',
      endedAt: '2026-04-16T10:00:09.000Z',
    });

    const payload = await svc.getProviderHealthPayload();

    assert.equal(payload.primaryProvider, 'odds_api');
    assert.equal(payload.activeProvider, 'odds_api');
    assert.equal(payload.status, 'healthy');
    assert.equal(payload.fallbackReason, null);
    assert.equal(payload.providerHealth.odds_api.status, 'healthy');
  } finally {
    if (previousPrimary === undefined) delete process.env.ODDS_PRIMARY_PROVIDER;
    else process.env.ODDS_PRIMARY_PROVIDER = previousPrimary;
    if (previousKey === undefined) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = previousKey;
  }
});

test('SystemObservabilityService costruisce recent runs combinando system e scheduler', async () => {
  const db = createDbStub([
    {
      runId: 11,
      runType: 'provider_fetch',
      component: 'odds_api_provider',
      provider: 'odds_api',
      success: true,
      warningCount: 0,
      startedAt: '2026-04-16T10:00:00.000Z',
      endedAt: '2026-04-16T10:00:10.000Z',
      durationMs: 10000,
      errorCategory: null,
      matchCount: 10,
      sourceUsed: 'odds_api',
      warnings: [],
      metadata: {},
    },
  ]);
  const svc = new SystemObservabilityService(db);

  const payload = await svc.getRecentRunsPayload(5, [
    {
      runId: 21,
      schedulerName: 'understat',
      success: false,
      startedAt: '2026-04-16T11:00:00.000Z',
      endedAt: '2026-04-16T11:00:45.000Z',
      durationMs: 45000,
      error: 'Sync failed',
      summary: null,
    },
  ]);

  assert.equal(payload.count, 2);
  assert.equal(payload.runs[0].kind, 'scheduler');
  assert.equal(payload.runs[1].kind, 'provider_fetch');
});
const providerRun = (runId, matchCount = 1) => ({
  externalRunId: runId,
  runType: 'provider_fetch',
  provider: 'odds_api',
  sourceUsed: 'odds_api',
  matchCount,
  success: true,
  startedAt: '2026-10-03T01:00:00.000Z',
  endedAt: '2026-10-03T01:00:01.000Z',
  metadata: { providerHealth: { odds_api: { status: 'healthy' } } },
});

test('provider snapshot shares reads, expires and observes external nightly updates', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const runs = [providerRun('initial', 3)];
  const db = createDbStub(runs);
  const svc = new SystemObservabilityService(db);
  const first = await Promise.all([svc.getProviderHealthPayload(), svc.getProviderHealthPayload()]);
  assert.equal(db.listCalls, 1);
  assert.equal(first[0].matchCount, 3);
  runs[0] = providerRun('nightly', 7);
  now += 59_999;
  assert.equal((await svc.getProviderHealthPayload()).matchCount, 3);
  assert.equal(db.listCalls, 1);
  now += 1;
  const updated = await Promise.all([svc.getProviderHealthPayload(), svc.getProviderHealthPayload()]);
  assert.equal(db.listCalls, 2);
  assert.equal(updated[0].matchCount, 7);
  assert.equal(updated[1].matchCount, 7);
  assert.equal(svc.getLastProviderSnapshot().runId, 'nightly');
});

test('empty provider history is cached temporarily and a later external run becomes visible', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const runs = [];
  const db = createDbStub(runs);
  const svc = new SystemObservabilityService(db);
  await Promise.all([svc.getProviderHealthPayload(), svc.getProviderHealthPayload()]);
  await svc.getProviderHealthPayload();
  assert.equal(db.listCalls, 1);
  assert.equal(svc.getLastProviderSnapshot(), null);
  runs.push(providerRun('first_nightly', 5));
  now += 60_000;
  assert.equal((await svc.getProviderHealthPayload()).matchCount, 5);
  assert.equal(db.listCalls, 2);
});

test('an old in-flight DB load cannot replace a newer local provider run', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const db = createDbStub();
  let resolveRead;
  db.listRecentSystemRuns = () => new Promise((resolve) => { resolveRead = resolve; });
  const svc = new SystemObservabilityService(db);
  const oldLoad = svc.getProviderHealthPayload();
  await svc.recordProviderRun({
    runId: 'local', provider: 'odds_api', sourceUsed: 'odds_api', matchCount: 9,
    success: true, startedAt: '2026-10-03T02:00:00.000Z',
    providerHealth: { odds_api: { status: 'healthy' } },
  });
  resolveRead([providerRun('old', 2)]);
  assert.equal((await oldLoad).matchCount, 9);
  assert.equal((await svc.getProviderHealthPayload()).matchCount, 9);
  assert.equal(svc.getLastProviderSnapshot().runId, 'local');
  db.listRecentSystemRuns = async () => [providerRun('external_after_local', 12)];
  now += 60_000;
  assert.equal((await svc.getProviderHealthPayload()).matchCount, 12);
});

test('failed provider snapshot reads remain retryable', async () => {
  const db = createDbStub();
  let attempts = 0;
  db.listRecentSystemRuns = async () => {
    if (++attempts === 1) throw new Error('Temporary DB error');
    return [providerRun('retry', 4)];
  };
  const svc = new SystemObservabilityService(db);
  await assert.rejects(svc.getProviderHealthPayload(), /Temporary DB error/);
  assert.equal((await svc.getProviderHealthPayload()).matchCount, 4);
  assert.equal(attempts, 2);
});
