import {
  normalizeProviderHealth,
  normalizeRecentRuns,
  normalizeSystemHealth,
  normalizeSystemMetrics,
} from './systemObservability';

test('normalizeProviderHealth mappa payload provider senza perdere i campi diagnostici', () => {
  const normalized = normalizeProviderHealth({
    data: {
      status: 'degraded',
      primaryProvider: 'odds_api',
      fallbackProvider: null,
      activeProvider: 'odds_api',
      oddsSource: 'odds_api',
      fallbackReason: null,
      providerHealth: {
        odds_api: { status: 'degraded', checkedAt: '2026-04-16T10:00:01.000Z', message: 'provider_degraded' },
      },
      fetchedAt: '2026-04-16T10:01:00.000Z',
      matchCount: 6,
      matchesWithBaseOdds: 4,
      matchesWithExtendedGroups: 1,
      marketCount: 22,
      durationMs: 18450,
      errorCategory: 'provider_degraded',
      warnings: ['quota provider parziale'],
      warningCount: 1,
      isMerged: true,
      freshnessMinutes: 3,
    },
  });

  expect(normalized.status).toBe('degraded');
  expect(normalized.activeProvider).toBe('odds_api');
  expect(normalized.providerHealth.odds_api.status).toBe('degraded');
  expect(normalized.fallbackProvider).toBeNull();
  expect(normalized.marketCount).toBe(22);
  expect(normalized.warningCount).toBe(1);
  expect(normalized.isMerged).toBe(true);
});

test('normalizeSystemMetrics mappa metriche aggregate e last outcome', () => {
  const normalized = normalizeSystemMetrics({
    data: {
      provider: {
        oddsApiSuccessRatePct: 72.5,
        fallbackRatePct: 18.4,
        fixtureMatchRatePct: 91.1,
        avgScrapeLatencyMs: 12340,
        avgMarketsFound: 8.2,
        requestsObserved: 48,
      },
      sync: {
        successRatePct: 88.9,
        runsObserved: 9,
        lastOutcome: {
          component: 'understat_scheduler',
          success: true,
          startedAt: '2026-04-16T01:00:00.000Z',
          durationMs: 45000,
          errorCategory: null,
        },
      },
      trends: {
        warningRuns: 3,
        errorRuns: 1,
        topErrorCategories: [{ category: 'meeting_json_failed', count: 2 }],
      },
    },
  });

  expect(normalized.provider.oddsApiSuccessRatePct).toBe(72.5);
  expect(normalized.sync.lastOutcome?.component).toBe('understat_scheduler');
  expect(normalized.trends.topErrorCategories[0].category).toBe('meeting_json_failed');
});

test('normalizeRecentRuns mappa run eterogenei in formato coerente', () => {
  const normalized = normalizeRecentRuns({
    data: {
      count: 2,
      runs: [
        {
          runId: 10,
          kind: 'provider_fetch',
          component: 'odds_api_provider',
          status: 'ok',
          startedAt: '2026-04-16T10:00:00.000Z',
          durationMs: 12000,
          warningCount: 0,
          provider: 'odds_api',
          competition: 'Serie A',
          matchCount: 10,
          sourceUsed: 'odds_api',
        },
        {
          runId: 11,
          schedulerName: 'understat',
          success: false,
          startedAt: '2026-04-16T01:00:00.000Z',
          durationMs: 30000,
          errorCategory: 'sync_failed',
        },
      ],
    },
  });

  expect(normalized.count).toBe(2);
  expect(normalized.runs[0].component).toBe('odds_api_provider');
  expect(normalized.runs[1].status).toBe('error');
});

test('normalizeSystemHealth compone provider, metriche e issues', () => {
  const normalized = normalizeSystemHealth({
    data: {
      status: 'degraded',
      isUpdating: false,
      lastUpdate: {
        at: '2026-04-16T01:00:00.000Z',
        success: true,
        message: 'Sync notturna completata',
      },
      freshness: {
        lastUnderstatSyncAt: '2026-04-16T01:00:00.000Z',
        understatFreshnessMinutes: 60,
        lastProviderFetchAt: '2026-04-16T10:00:00.000Z',
        providerFreshnessMinutes: 3,
      },
      providers: {
        status: 'degraded',
        primaryProvider: 'odds_api',
        activeProvider: 'odds_api',
        providerHealth: {
          odds_api: { status: 'degraded', message: 'provider_degraded' },
        },
      },
      metrics: {
        provider: { oddsApiSuccessRatePct: 55 },
        sync: { successRatePct: 100, runsObserved: 3 },
        trends: { warningRuns: 2, errorRuns: 1, topErrorCategories: [] },
      },
      issues: [
        { scope: 'provider', severity: 'warning', message: 'Provider quote degradato', errorCategory: 'provider_degraded' },
      ],
    },
  });

  expect(normalized.status).toBe('degraded');
  expect(normalized.providers.providerHealth.odds_api.status).toBe('degraded');
  expect(normalized.metrics.provider.oddsApiSuccessRatePct).toBe(55);
  expect(normalized.issues[0].errorCategory).toBe('provider_degraded');
});
