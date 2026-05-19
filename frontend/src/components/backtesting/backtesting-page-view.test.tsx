import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BacktestingPageView from './BacktestingPageView';
import * as api from '../../utils/api';

jest.mock('../../utils/api');

const mockedApi = api as jest.Mocked<typeof api>;

const buildWalkForwardResult = (overrides: Record<string, any> = {}) => ({
  resultId: 9,
  kind: 'walk_forward',
  competition: 'Serie A',
  seasonRange: '2025/2026',
  totalMatches: 120,
  totalFolds: 3,
  expandingWindow: true,
  initialTrainMatches: 60,
  testWindowMatches: 20,
  stepMatches: 20,
  folds: [
    {
      foldNumber: 1,
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-01-31T00:00:00.000Z',
      trainMatches: 60,
      testMatches: 20,
      betsPlaced: 18,
      betsWon: 10,
      roi: 12.4,
      winRate: 58.3,
      netProfit: 128,
      totalStaked: 1000,
      averageClv: 0.012,
      positiveClvRate: 62,
      betsWithRealEurobetOdds: 12,
      betsWithSyntheticOdds: 6,
    },
  ],
  summary: {
    totalBetsPlaced: 18,
    totalBetsWon: 10,
    totalNetProfit: 128,
    totalStaked: 1000,
    roi: 12.4,
    winRate: 58.3,
    averageFoldROI: 12.4,
    medianFoldROI: 12.4,
    roiStdDev: 1.2,
    positiveFoldRate: 66.7,
    averageBrierScore: 0.1842,
    averageLogLoss: 0.6221,
    currentBeatsBaselineFolds: 2,
    baselineBeatsCurrentFolds: 1,
  },
  reportSnapshot: null,
  ...overrides,
});

const reportPayload = {
  data: {
    report: {
      algorithmVersion: 'value-engine-v4',
      rankingVersion: 'ranking-edge-novig-loggrowth-v2',
      backtestEngineVersion: 'backtest-engine-v4',
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
      oddsReliability: {
        roiRealEurobetOdds: 8.2,
        roiSyntheticOdds: -3.1,
        roiTotal: 5.4,
        betsWithRealEurobetOdds: 12,
        betsWithSyntheticOdds: 6,
        profitRealEurobetOdds: 41,
        profitSyntheticOdds: -6,
        stakedRealEurobetOdds: 500,
        stakedSyntheticOdds: 190,
        warning: null,
      },
      algorithmComparison: {
        baselineResult: { roi: 2.1, netProfit: 18, totalStaked: 600, betsPlaced: 16, winRate: 50, averageOdds: 2.05, averageEV: 5, averageClv: 0.004, positiveClvRate: 50, maxDrawdown: 7, profitFactor: 1.12 },
        currentResult: { roi: 5.4, netProfit: 35, totalStaked: 690, betsPlaced: 18, winRate: 58.3, averageOdds: 2.11, averageEV: 7.8, averageClv: 0.015, positiveClvRate: 62, maxDrawdown: 5.5, profitFactor: 1.46 },
        tunedResult: { roi: 6.8, netProfit: 44, totalStaked: 700, betsPlaced: 19, winRate: 60, averageOdds: 2.08, averageEV: 8.1, averageClv: 0.019, positiveClvRate: 66, maxDrawdown: 5.1, profitFactor: 1.55 },
        deltaROI: 3.3,
        deltaProfit: 17,
        deltaCLV: 0.011,
        deltaDrawdown: -1.5,
      },
      rankingOptimization: {
        bestScore: 14.2,
        bestWeights: {
          global: { edgeNoVig: 0.42, ev: 0.14, kelly: 0.12, confidence: 0.05, logGrowth: 0.18, riskPenalty: 0.5, uncertainty: 0.22, contextStrength: 0.08 },
        },
        overfittingRisk: 'MEDIUM',
        overfittingWarnings: ['Campione quote Eurobet reali limitato.'],
        rationale: 'Scelti pesi con CLV medio migliore e drawdown controllato.',
      },
      walkForwardStability: {
        currentBeatsBaselineFolds: 3,
        baselineBeatsCurrentFolds: 1,
        tunedBeatsCurrentFolds: 2,
        roiVariance: 4.2,
        clvVariance: 0.00003,
        rankingStabilityScore: 0.72,
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
        kind: 'walk_forward',
        competition: 'Serie A',
        season_range: '2025/2026',
        run_at: '2026-04-20T09:00:00.000Z',
      },
    ],
  } as any);
  mockedApi.runWalkForwardBacktest.mockResolvedValue({ data: buildWalkForwardResult() } as any);
  mockedApi.getBacktestResult.mockResolvedValue({
    data: {
      result: buildWalkForwardResult({ resultId: 7 }),
    },
  } as any);
  mockedApi.getBacktestReport.mockResolvedValue(reportPayload as any);
  mockedApi.deleteBacktestResult.mockResolvedValue({ data: { deleted: true } } as any);
  mockedApi.deleteBacktestResults.mockResolvedValue({ data: { deletedCount: 1 } } as any);
  mockedApi.pruneBacktestResults.mockResolvedValue({ data: { deletedCount: 2 } } as any);
});

describe('BacktestingPageView', () => {
  test('avvia un walk-forward e carica un run salvato', async () => {
    render(<BacktestingPageView />);

    await waitFor(() => expect(mockedApi.getBacktestResults).toHaveBeenCalledTimes(1));

    expect(screen.queryByLabelText(/Modalita/i)).toBeNull();
    expect(screen.queryByText(/Backtest classico/i)).toBeNull();
    expect(screen.queryByLabelText(/Train ratio/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Avvia Walk-forward/i }));

    await waitFor(() => expect(mockedApi.runWalkForwardBacktest).toHaveBeenCalledTimes(1));
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

    fireEvent.click(screen.getByRole('button', { name: /Avvia Walk-forward/i }));

    await waitFor(() => expect(mockedApi.getBacktestReport).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /Stabilita/i }));

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
    const saveIndividualRuns = screen.getByLabelText(/Salva anche i run singoli/i) as HTMLInputElement;
    expect(saveIndividualRuns.checked).toBe(false);
    fireEvent.click(saveIndividualRuns);
    expect(saveIndividualRuns.checked).toBe(true);

    fireEvent.change(competitionSelect, { target: { value: 'TOP_5' } });
    expect(screen.getByText(/Il walk-forward Top 5 puo richiedere alcuni minuti/i)).toBeTruthy();
    expect(screen.queryByText(/Tuning pesi \+ Top 5 puo essere molto lento/i)).toBeNull();

    const optimizeRankingWeights = screen.getByLabelText(/Ottimizza pesi ranking/i) as HTMLInputElement;
    expect(optimizeRankingWeights.checked).toBe(false);
    fireEvent.click(optimizeRankingWeights);
    expect(screen.getByText(/Tuning pesi \+ Top 5 puo essere molto lento/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Avvia Walk-forward/i }));

    await waitFor(() => expect(mockedApi.runWalkForwardBacktest).toHaveBeenCalledTimes(1));
    expect(mockedApi.runWalkForwardBacktest).toHaveBeenCalledWith(expect.objectContaining({
      competition: 'TOP_5',
      saveIndividualRuns: true,
      optimizeRankingWeights: true,
    }));
  });

  test('mostra metriche real/synthetic e confronto algoritmo nel report', async () => {
    render(<BacktestingPageView />);

    await waitFor(() => expect(mockedApi.getBacktestResults).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /Avvia Walk-forward/i }));

    await screen.findByRole('button', { name: /Reset filtri/i });
    expect(screen.getByText(/ROI quote Eurobet reali/i)).toBeTruthy();
    expect(screen.getByText(/ROI quote sintetiche/i)).toBeTruthy();
    expect(screen.getByText(/Baseline vs algoritmo attuale/i)).toBeTruthy();
    expect(screen.getByText(/Delta ROI/i)).toBeTruthy();
  });

  test('mostra versioni algoritmo, tuning ranking e warning overfitting', async () => {
    render(<BacktestingPageView />);

    await waitFor(() => expect(mockedApi.getBacktestResults).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /Avvia Walk-forward/i }));

    await screen.findByRole('button', { name: /Reset filtri/i });
    expect(screen.getByText(/value-engine-v4/i)).toBeTruthy();
    expect(screen.getByText(/ranking-edge-novig-loggrowth-v2/i)).toBeTruthy();
    expect(screen.getByText(/Ottimizzazione ranking/i)).toBeTruthy();
    expect(screen.getByText(/Rischio overfitting/i)).toBeTruthy();
    expect(screen.getByText(/Walk-forward stability/i)).toBeTruthy();
  });
});
