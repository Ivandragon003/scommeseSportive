import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DashboardPageView from './DashboardPageView';
import * as api from '../../utils/api';

jest.mock('../../utils/api');

const mockedApi = api as jest.Mocked<typeof api>;

const budgetPayload = {
  total_budget: 1000,
  available_budget: 780,
  total_staked: 220,
  total_won: 310,
  total_lost: 90,
  roi: 12.4,
  win_rate: 58.3,
  total_bets: 12,
};

const analyticsPayload = {
  oddsArchive: {
    totalSnapshots: 42,
    matchesCovered: 18,
    matchesWithMultipleSnapshots: 6,
    snapshotsWithRealOdds: 30,
    snapshotsWithSyntheticCompletion: 12,
    snapshotsUsingEurobetPure: 24,
    sourceBreakdown: {
      eurobet_scraper: 24,
      fallback_provider: 6,
    },
  },
  userClv: {
    avgClvPct: 1.82,
    positiveClvRate: 61.4,
    trackedBets: 9,
    betsWithClosingLine: 8,
  },
  overview: {
    checks: { allCoreStatsLoaded: true },
    coverage: {
      fields: {
        xg: { pct: 100 },
        shots: { pct: 96 },
        shotsOnTarget: { pct: 94 },
        fouls: { pct: 82 },
        yellowCards: { pct: 88 },
      },
    },
  },
};

const providerHealthPayload = {
  data: {
    status: 'degraded',
    primaryProvider: 'eurobet',
    fallbackProvider: 'odds_api',
    activeProvider: 'odds_api',
    oddsSource: 'odds_api',
    fallbackReason: 'Provider primario eurobet non disponibile, fallback odds_api attivo',
    providerHealth: {
      eurobet: { status: 'unhealthy', checkedAt: '2026-04-22T09:00:00.000Z', message: 'meeting_json_failed' },
      odds_api: { status: 'healthy', checkedAt: '2026-04-22T09:00:05.000Z', message: null },
    },
    fetchedAt: '2026-04-22T09:05:00.000Z',
    matchesWithBaseOdds: 7,
    matchesWithExtendedGroups: 3,
    freshnessMinutes: 5,
    warnings: ['fallback attivo'],
    warningCount: 1,
    lastSmokeRun: {
      origin: 'local_artifact',
      competition: 'Serie A',
      generatedAt: '2026-04-22T09:06:00.000Z',
      freshnessMinutes: 4,
      severity: 'degraded',
      success: true,
      errorCategory: 'meeting_json_failed',
      sourceUsed: 'meeting-json',
      matchesFound: 8,
      matchesWithBaseOdds: 7,
      matchesWithExtendedGroups: 3,
      durationMs: 18000,
      warnings: ['dom fallback'],
    },
  },
};

const systemHealthPayload = {
  data: {
    status: 'healthy',
    freshness: {
      lastUnderstatSyncAt: '2026-04-22T08:00:00.000Z',
      understatFreshnessMinutes: 65,
      lastProviderFetchAt: '2026-04-22T09:05:00.000Z',
      providerFreshnessMinutes: 5,
    },
    providers: providerHealthPayload.data,
    metrics: {
      provider: {
        eurobetSuccessRatePct: 73.4,
        fallbackRatePct: 12.5,
        fixtureMatchRatePct: 89.1,
        avgScrapeLatencyMs: 17250,
      },
      sync: {
        successRatePct: 100,
      },
      trends: {
        warningRuns: 1,
        errorRuns: 0,
        topErrorCategories: [],
      },
    },
    issues: [],
  },
};

const scraperStatusPayload = {
  data: {
    isUpdating: false,
    recentSchedulerRuns: [],
    understatScheduler: {
      enabled: true,
      time: '01:00',
      lastRunAt: '2026-04-22T08:00:00.000Z',
      nextRunAt: '2026-04-23T01:00:00.000Z',
      lastDurationMs: 720000,
      lastResult: { newMatchesImported: 5, existingMatchesUpdated: 10 },
    },
    oddsSnapshotScheduler: {
      enabled: true,
      time: '02:15',
      lastRunAt: '2026-04-22T09:05:00.000Z',
      nextRunAt: '2026-04-23T02:15:00.000Z',
      lastDurationMs: 18000,
      lastResults: [{ success: true, savedSnapshots: 18 }],
    },
    learningReviewScheduler: {
      enabled: true,
      time: '03:00',
      lastRunAt: '2026-04-22T09:30:00.000Z',
      nextRunAt: '2026-04-23T03:00:00.000Z',
      lastDurationMs: 12000,
      lastResult: { created: 2, refreshed: 4 },
    },
  },
};

beforeEach(() => {
  jest.resetAllMocks();
  mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
  mockedApi.getBets.mockResolvedValue({ data: [] } as any);
  mockedApi.getMatchesCount.mockResolvedValue({ count: 128 } as any);
  mockedApi.getSystemAnalytics.mockResolvedValue({ data: analyticsPayload } as any);
  mockedApi.getScraperStatus.mockResolvedValue(scraperStatusPayload as any);
  mockedApi.getSystemHealth.mockResolvedValue(systemHealthPayload as any);
  mockedApi.getProviderHealth.mockResolvedValue(providerHealthPayload as any);
  mockedApi.getSystemMetrics.mockResolvedValue(systemHealthPayload.data.metrics as any);
  mockedApi.getRecentSystemRuns.mockResolvedValue({
    data: {
      count: 1,
      runs: [
        {
          runId: 11,
          kind: 'provider_fetch',
          component: 'eurobet',
          status: 'ok',
          startedAt: '2026-04-22T09:05:00.000Z',
          durationMs: 18000,
          warningCount: 1,
          matchCount: 8,
        },
      ],
    },
  } as any);
  mockedApi.initBudget.mockResolvedValue({ data: budgetPayload } as any);
});

describe('DashboardPageView', () => {
  test('mostra stato provider, freshness quote e consente refresh manuale', async () => {
    render(<DashboardPageView activeUser="user1" />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-status-summary-active-provider').textContent).toContain('Provider secondario');
    });

    expect(mockedApi.getBudget).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBets).toHaveBeenCalledTimes(1);
    expect(mockedApi.getMatchesCount).toHaveBeenCalledTimes(1);
    expect(mockedApi.getSystemAnalytics).toHaveBeenCalledTimes(1);
    expect(mockedApi.getScraperStatus).toHaveBeenCalledTimes(1);
    expect(mockedApi.getSystemHealth).toHaveBeenCalledTimes(1);
    expect(mockedApi.getProviderHealth).toHaveBeenCalledTimes(1);
    expect(mockedApi.getSystemMetrics).toHaveBeenCalledTimes(1);
    expect(mockedApi.getRecentSystemRuns).toHaveBeenCalledTimes(1);

    expect(screen.getByText('Provider Quote')).toBeTruthy();
    expect(screen.getByText('Freshness Quote')).toBeTruthy();
    expect(screen.getByTestId('provider-status-summary').textContent).toContain('5m');
    expect(screen.getByTestId('provider-status-summary-primary-provider').textContent).toContain('Eurobet');
    expect(screen.getByTestId('provider-status-summary-active-provider').textContent).toContain('Provider secondario');

    fireEvent.click(screen.getByRole('button', { name: /Ricarica dati dashboard/i }));

    await waitFor(() => expect(mockedApi.getProviderHealth).toHaveBeenCalledTimes(2));
    expect(mockedApi.getBudget).toHaveBeenCalledTimes(2);
    expect(mockedApi.getBets).toHaveBeenCalledTimes(2);
    expect(mockedApi.getMatchesCount).toHaveBeenCalledTimes(2);
    expect(mockedApi.getSystemAnalytics).toHaveBeenCalledTimes(2);
    expect(mockedApi.getScraperStatus).toHaveBeenCalledTimes(2);
    expect(mockedApi.getSystemHealth).toHaveBeenCalledTimes(2);
    expect(mockedApi.getSystemMetrics).toHaveBeenCalledTimes(2);
    expect(mockedApi.getRecentSystemRuns).toHaveBeenCalledTimes(2);
  });
});
