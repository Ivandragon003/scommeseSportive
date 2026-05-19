import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BacktestingPageView from './BacktestingPageView';
import * as api from '../../utils/api';

jest.mock('../../utils/api');

const mockedApi = api as jest.Mocked<typeof api>;

const buildClassicResult = (overrides: Record<string, any> = {}) => ({
  resultId: 9,
  kind: 'classic',
  competition: 'Serie A',
  seasonRange: '2025/2026',
  roi: 12.4,
  winRate: 58.3,
  profitFactor: 1.46,
  brierScore: 0.1842,
  totalMatches: 120,
  trainingMatches: 84,
  testMatches: 36,
  betsPlaced: 18,
  betsWon: 10,
  averageOdds: 2.11,
  sharpeRatio: 1.21,
  maxDrawdown: 6.2,
  recoveryFactor: 1.8,
  historicalOddsCoverage: '87%',
  netProfit: 128,
  equityCurve: [],
  monthlyStats: [],
  calibration: [],
  reportSnapshot: null,
  ...overrides,
});

const reportPayload = {
  data: {
    report: {
      summary: {
        yieldPct: 5.4,
        roiPct: 12.4,
        hitRatePct: 58.3,
        brierScore: 0.1842,
        logLoss: 0.6221,
        expectedEvPct: 7.8,
        realizedEvPct: 5.2,
        evCapturePct: 66.7,
      },
      alerts: [],
      calibration: {
        probabilityBuckets: [],
      },
      segments: {
        bySource: [],
        byMarket: [],
        byEvBucket: [],
        byConfidence: [],
      },
      dataset: {
        filteredBets: 18,
        availableMarkets: ['Totali Goal'],
        availableSources: ['eurobet_scraper'],
        legacyData: false,
      },
      clv: {
        available: false,
        reason: 'Richiede quota di chiusura Eurobet prima del kickoff.',
        averageClv: null,
        positiveClvRate: null,
        betsWithClv: 0,
        missingClosingOddsCount: 18,
      },
    },
  },
};

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (window as any).ResizeObserver = ResizeObserverMock;
  (global as any).ResizeObserver = ResizeObserverMock;
});

beforeEach(() => {
  jest.resetAllMocks();
  mockedApi.getBacktestResults.mockResolvedValue({
    data: [
      {
        id: 7,
        kind: 'classic',
        competition: 'Serie A',
        season_range: '2025/2026',
        run_at: '2026-04-20T09:00:00.000Z',
      },
    ],
  } as any);
  mockedApi.runBacktest.mockResolvedValue({ data: buildClassicResult() } as any);
  mockedApi.runWalkForwardBacktest.mockResolvedValue({ data: null } as any);
  mockedApi.getBacktestResult.mockResolvedValue({
    data: {
      result: buildClassicResult({ resultId: 7, roi: 9.8, netProfit: 94 }),
    },
  } as any);
  mockedApi.getBacktestReport.mockResolvedValue(reportPayload as any);
  mockedApi.deleteBacktestResult.mockResolvedValue({ data: { deleted: true } } as any);
  mockedApi.deleteBacktestResults.mockResolvedValue({ data: { deletedCount: 1 } } as any);
  mockedApi.pruneBacktestResults.mockResolvedValue({ data: { deletedCount: 2 } } as any);
});

describe('BacktestingPageView', () => {
  test('avvia un backtest e carica un run salvato', async () => {
    render(<BacktestingPageView />);

    await waitFor(() => expect(mockedApi.getBacktestResults).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /Avvia Backtest/i }));

    await waitFor(() => expect(mockedApi.runBacktest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedApi.getBacktestReport).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: /Reset filtri/i });
    expect(screen.getByText('Report Decisionale')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Apri Run/i }));

    await waitFor(() => expect(mockedApi.getBacktestResult).toHaveBeenCalledWith(7, { force: true }));
    await waitFor(() => expect(mockedApi.getBacktestReport).toHaveBeenCalledTimes(2));
  });

  test('protegge eliminazione run con conferma e resetta i filtri report', async () => {
    render(<BacktestingPageView />);

    await screen.findByRole('button', { name: /Apri Run/i });

    fireEvent.click(screen.getByRole('button', { name: /Apri Run/i }));
    await waitFor(() => expect(mockedApi.getBacktestResult).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedApi.getBacktestReport).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: /Reset filtri/i });

    const marketSelect = screen.getByLabelText(/^Mercato$/i) as HTMLSelectElement;
    const sourceSelect = screen.getByLabelText(/Sorgente quote/i) as HTMLSelectElement;
    fireEvent.change(marketSelect, { target: { value: 'Totali Goal' } });
    fireEvent.change(sourceSelect, { target: { value: 'eurobet_scraper' } });

    await waitFor(() => expect(marketSelect.value).toBe('Totali Goal'));
    await waitFor(() => expect(sourceSelect.value).toBe('eurobet_scraper'));

    fireEvent.click(screen.getByRole('button', { name: /Reset filtri/i }));

    await waitFor(() => expect(marketSelect.value).toBe(''));
    await waitFor(() => expect(sourceSelect.value).toBe(''));

    fireEvent.click(screen.getByRole('button', { name: /Elimina Run/i }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Elimina run/i }));

    await waitFor(() => expect(mockedApi.deleteBacktestResult).toHaveBeenCalledWith(7));
  });

  test('cambiare tab del risultato non rilancia fetch inutili', async () => {
    render(<BacktestingPageView />);

    await waitFor(() => expect(mockedApi.getBacktestResults).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /Avvia Backtest/i }));

    await waitFor(() => expect(mockedApi.getBacktestReport).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /Statistiche/i }));

    expect(mockedApi.getBacktestReport).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBacktestResults).toHaveBeenCalledTimes(2);
  });

  test('mostra tutorial Backtesting e invia il preset Top 5 campionati', async () => {
    render(<BacktestingPageView />);

    await waitFor(() => expect(mockedApi.getBacktestResults).toHaveBeenCalledTimes(1));

    expect(screen.queryByText(/CLV positivo/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Come usare il backtesting/i }));
    expect(screen.getByText(/CLV positivo/i)).toBeTruthy();
    expect(screen.getByText(/una bet persa puo comunque essere buona/i)).toBeTruthy();

    const competitionSelect = screen.getByLabelText(/Competizione/i) as HTMLSelectElement;
    fireEvent.change(competitionSelect, { target: { value: 'TOP_5' } });
    fireEvent.click(screen.getByRole('button', { name: /Avvia Backtest/i }));

    await waitFor(() => expect(mockedApi.runBacktest).toHaveBeenCalledTimes(1));
    expect(mockedApi.runBacktest).toHaveBeenCalledWith(expect.objectContaining({
      competition: 'TOP_5',
    }));
  });
});
