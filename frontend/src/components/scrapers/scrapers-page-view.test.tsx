import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ScrapersPageView from './ScrapersPageView';
import * as api from '../../utils/api';

jest.mock('../../utils/api');

const mockedApi = api as jest.Mocked<typeof api>;

const providerHealthPayload = {
  data: {
    status: 'degraded',
    primaryProvider: 'eurobet',
    fallbackProvider: 'odds_api',
    activeProvider: 'odds_api',
    oddsSource: 'odds_api',
    fallbackReason: 'Eurobet degradato, fallback attivo',
    providerHealth: {
      eurobet: { status: 'unhealthy', checkedAt: '2026-04-22T09:00:00.000Z', message: 'html_or_captcha' },
      odds_api: { status: 'healthy', checkedAt: '2026-04-22T09:00:05.000Z', message: null },
    },
    fetchedAt: '2026-04-22T09:02:00.000Z',
    matchesWithBaseOdds: 4,
    matchesWithExtendedGroups: 1,
    freshnessMinutes: 6,
    warnings: ['fallback attivo'],
    warningCount: 1,
    lastSmokeRun: {
      origin: 'local_artifact',
      competition: 'Serie A',
      generatedAt: '2026-04-22T09:05:00.000Z',
      freshnessMinutes: 3,
      severity: 'degraded',
      success: true,
      errorCategory: 'html_or_captcha',
      sourceUsed: 'meeting-json',
      matchesFound: 4,
      matchesWithBaseOdds: 4,
      matchesWithExtendedGroups: 1,
      durationMs: 22000,
      warnings: ['fallback attivo'],
    },
  },
};

beforeEach(() => {
  jest.resetAllMocks();
  mockedApi.getScraperStatus.mockResolvedValue({
    data: {
      isUpdating: false,
      lastUpdate: {
        at: '2026-04-22T09:10:00.000Z',
        success: true,
        message: 'Sync completata',
      },
      understatScheduler: {
        enabled: true,
        time: '01:00',
        nextRunAt: '2026-04-23T01:00:00.000Z',
      },
      oddsSnapshotScheduler: {
        enabled: true,
        time: '02:15',
        nextRunAt: '2026-04-23T02:15:00.000Z',
      },
      learningReviewScheduler: {
        enabled: true,
        time: '03:00',
        nextRunAt: '2026-04-23T03:00:00.000Z',
      },
    },
  } as any);
  mockedApi.getUnderstatScraperInfo.mockResolvedValue({
    data: {
      competitions: ['Serie A', 'Premier League'],
      dbLastImport: { 'Serie A': '2026-04-22T08:00:00.000Z' },
      note: 'Understat primario',
    },
  } as any);
  mockedApi.getOddsSnapshotStatus
    .mockResolvedValueOnce({
      data: {
        matches: [],
        remainingRequests: 320,
        lastUpdatedAt: '2026-04-22T09:02:00.000Z',
      },
    } as any)
    .mockResolvedValue({
      data: {
        matches: [
          {
            homeTeam: 'Inter',
            awayTeam: 'Milan',
            commenceTime: '2026-04-25T18:45:00.000Z',
          },
        ],
        remainingRequests: 318,
        lastUpdatedAt: '2026-04-22T09:15:00.000Z',
      },
    } as any);
  mockedApi.getSystemHealth.mockResolvedValue({
    data: {
      status: 'degraded',
      issues: [{ scope: 'providers', severity: 'warning', message: 'Fallback tecnico attivo' }],
    },
  } as any);
  mockedApi.getProviderHealth.mockResolvedValue(providerHealthPayload as any);
  mockedApi.getSystemMetrics.mockResolvedValue({
    data: {
      provider: {
        avgScrapeLatencyMs: 18500,
      },
      trends: {
        errorRuns: 2,
      },
    },
  } as any);
  mockedApi.runUnderstatImport.mockResolvedValue({
    data: {
      mode: 'single',
      competitions: ['Serie A'],
      seasons: ['2025/2026'],
      newMatchesImported: 5,
      upcomingMatchesImported: 3,
      existingMatchesUpdated: 8,
    },
  } as any);
  mockedApi.runOddsSnapshot.mockResolvedValue({
    data: {
      matches: [
        {
          homeTeam: 'Inter',
          awayTeam: 'Milan',
          commenceTime: '2026-04-25T18:45:00.000Z',
        },
      ],
      remainingRequests: 318,
      lastUpdatedAt: '2026-04-22T09:15:00.000Z',
    },
  } as any);
});

describe('ScrapersPageView', () => {
  test('mantiene il tab Understat operativo e scarica il campionato selezionato', async () => {
    render(<ScrapersPageView />);

    await screen.findByText(/Download da Understat/i);

    expect(mockedApi.getScraperStatus).toHaveBeenCalledTimes(1);
    expect(mockedApi.getUnderstatScraperInfo).toHaveBeenCalledTimes(1);
    expect(mockedApi.getOddsSnapshotStatus).toHaveBeenCalledTimes(1);
    expect(mockedApi.getSystemHealth).toHaveBeenCalledTimes(1);
    expect(mockedApi.getProviderHealth).toHaveBeenCalledTimes(1);
    expect(mockedApi.getSystemMetrics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Scarica solo Serie A/i }));

    await waitFor(() => expect(mockedApi.runUnderstatImport).toHaveBeenCalledTimes(1));
    expect(mockedApi.runUnderstatImport.mock.calls[0][0]).toMatchObject({
      mode: 'single',
      competition: 'Serie A',
      includeMatchDetails: true,
    });
  });

  test('mostra provider degraded e consente scaricare quote live dal tab provider quote', async () => {
    render(<ScrapersPageView />);

    await screen.findByText(/Download da Understat/i);

    fireEvent.click(screen.getByRole('button', { name: /Provider quote/i }));

    await screen.findByText(/Scarica quote provider/i);
    expect(mockedApi.getScraperStatus).toHaveBeenCalledTimes(1);
    expect(mockedApi.getProviderHealth).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('provider-status-summary-provider-eurobet').textContent).toContain('Errore');
    expect(screen.getByTestId('provider-status-summary-provider-odds_api').textContent).toContain('OK');

    fireEvent.click(screen.getByRole('button', { name: /Scarica quote provider/i }));

    await waitFor(() => expect(mockedApi.runOddsSnapshot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedApi.getOddsSnapshotStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  test('cambio tab non rilancia il fetch iniziale e verifica provider chiama solo gli endpoint necessari', async () => {
    render(<ScrapersPageView />);

    await screen.findByText(/Download da Understat/i);

    expect(mockedApi.getScraperStatus).toHaveBeenCalledTimes(1);
    expect(mockedApi.getUnderstatScraperInfo).toHaveBeenCalledTimes(1);
    expect(mockedApi.getProviderHealth).toHaveBeenCalledTimes(1);
    expect(mockedApi.getSystemHealth).toHaveBeenCalledTimes(1);
    expect(mockedApi.getSystemMetrics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Provider quote/i }));
    fireEvent.click(screen.getByRole('button', { name: /Understat/i }));

    expect(mockedApi.getScraperStatus).toHaveBeenCalledTimes(1);
    expect(mockedApi.getUnderstatScraperInfo).toHaveBeenCalledTimes(1);
    expect(mockedApi.getProviderHealth).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Provider quote/i }));
    fireEvent.click(screen.getByRole('button', { name: /Verifica provider/i }));

    await waitFor(() => expect(mockedApi.getProviderHealth).toHaveBeenCalledTimes(2));
    expect(mockedApi.getSystemHealth).toHaveBeenCalledTimes(2);
    expect(mockedApi.getScraperStatus).toHaveBeenCalledTimes(1);
    expect(mockedApi.getUnderstatScraperInfo).toHaveBeenCalledTimes(1);
    expect(mockedApi.getSystemMetrics).toHaveBeenCalledTimes(1);
    expect(mockedApi.getOddsSnapshotStatus).toHaveBeenCalledTimes(1);
  });
});
