const test = require('node:test');
const assert = require('node:assert/strict');
const { SystemObservabilityService } = require('../dist/services/SystemObservabilityService.js');

const createDbStub = (systemRuns = []) => {
  const savedRuns = [];
  return {
    savedRuns,
    async saveSystemRun(entry) {
      savedRuns.push(entry);
      return savedRuns.length;
    },
    async listRecentSystemRuns(limit) {
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
