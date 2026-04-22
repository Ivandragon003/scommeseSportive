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
      primaryProvider: 'eurobet',
      fallbackProvider: 'odds_api',
      activeProvider: 'odds_api',
      oddsSource: 'eurobet+odds_api',
      fallbackReason: 'Provider primario eurobet non disponibile',
      providerHealth: {
        eurobet: { status: 'unhealthy', checkedAt: '2026-04-16T10:00:00.000Z', message: 'meeting_json_failed' },
        odds_api: { status: 'healthy', checkedAt: '2026-04-16T10:00:01.000Z' },
      },
      fetchedAt: '2026-04-16T10:01:00.000Z',
      matchCount: 6,
      matchesWithBaseOdds: 4,
      matchesWithExtendedGroups: 1,
      marketCount: 22,
      durationMs: 18450,
      errorCategory: 'meeting_json_failed',
      warnings: ['fallback attivo'],
      warningCount: 1,
      isMerged: true,
      freshnessMinutes: 3,
      lastSmokeRun: {
        origin: 'local_artifact',
        competition: 'Serie A',
        generatedAt: '2026-04-16T10:05:00.000Z',
        freshnessMinutes: 2,
        severity: 'degraded',
        success: true,
        errorCategory: 'meeting_json_failed',
        sourceUsed: 'meeting-json',
        matchesFound: 6,
        matchesWithBaseOdds: 4,
        matchesWithExtendedGroups: 1,
        durationMs: 18450,
        warnings: ['dom fallback'],
      },
    },
  });

  expect(normalized.status).toBe('degraded');
  expect(normalized.activeProvider).toBe('odds_api');
  expect(normalized.providerHealth.eurobet.status).toBe('unhealthy');
  expect(normalized.fallbackProvider).toBe('odds_api');
  expect(normalized.marketCount).toBe(22);
  expect(normalized.warningCount).toBe(1);
  expect(normalized.isMerged).toBe(true);
  expect(normalized.lastSmokeRun?.severity).toBe('degraded');
});

test('normalizeSystemMetrics mappa metriche aggregate e last outcome', () => {
  const normalized = normalizeSystemMetrics({
    data: {
      provider: {
        eurobetSuccessRatePct: 72.5,
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

  expect(normalized.provider.eurobetSuccessRatePct).toBe(72.5);
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
          component: 'eurobet_provider',
          status: 'ok',
          startedAt: '2026-04-16T10:00:00.000Z',
          durationMs: 12000,
          warningCount: 0,
          provider: 'eurobet',
          competition: 'Serie A',
          matchCount: 10,
          sourceUsed: 'eurobet',
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
  expect(normalized.runs[0].component).toBe('eurobet_provider');
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
        primaryProvider: 'eurobet',
        activeProvider: 'odds_api',
        providerHealth: {
          eurobet: { status: 'unhealthy', message: 'meeting_json_failed' },
        },
      },
      metrics: {
        provider: { eurobetSuccessRatePct: 55 },
        sync: { successRatePct: 100, runsObserved: 3 },
        trends: { warningRuns: 2, errorRuns: 1, topErrorCategories: [] },
      },
      issues: [
        { scope: 'provider', severity: 'warning', message: 'Eurobet degradato', errorCategory: 'meeting_json_failed' },
      ],
    },
  });

  expect(normalized.status).toBe('degraded');
  expect(normalized.providers.providerHealth.eurobet.status).toBe('unhealthy');
  expect(normalized.metrics.provider.eurobetSuccessRatePct).toBe(55);
  expect(normalized.issues[0].errorCategory).toBe('meeting_json_failed');
});
