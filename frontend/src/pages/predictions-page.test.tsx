import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Predictions from './Predictions';
import * as api from '../utils/api';

jest.mock('../utils/api');

const mockedApi = api as jest.Mocked<typeof api>;

const matchRow = {
  match_id: 'match_1',
  home_team_id: 'team_inter',
  away_team_id: 'team_milan',
  home_team_name: 'Inter',
  away_team_name: 'Milan',
  competition: 'Serie A',
  date: '2026-04-25T18:45:00.000Z',
  home_goals: null,
  away_goals: null,
};

const valueOpportunity = {
  selection: 'over25',
  selectionLabel: 'Over 2.5 Goal',
  marketName: 'Totali Goal',
  bookmakerOdds: 2.1,
  confidence: 'HIGH',
  marketTier: 'CORE',
  humanSummary: 'Profilo offensivo coerente con un over.',
  humanReasons: ['xG combinati alti', 'Difese concedono volume'],
  expectedValue: 7.2,
  edge: 4.3,
  ourProbability: 56.1,
  impliedProbability: 47.6,
  kellyFraction: 1.9,
  suggestedStakePercent: 2.5,
};

const buildPrediction = (overrides: Record<string, any> = {}) => ({
  matchId: 'match_1',
  homeTeam: 'Inter',
  awayTeam: 'Milan',
  competition: 'Serie A',
  lambdaHome: 1.72,
  lambdaAway: 1.08,
  modelConfidence: 0.74,
  goalProbabilities: {
    homeWin: 0.52,
    draw: 0.26,
    awayWin: 0.22,
    btts: 0.57,
    bttsNo: 0.43,
    over05: 0.92,
    over15: 0.76,
    over25: 0.56,
    over35: 0.32,
    over45: 0.15,
    handicap: {
      homeMinus1: 0.29,
      awayPlus1: 0.71,
    },
    asianHandicap: {
      '-0.5': 0.52,
    },
    exactScore: {
      '1-0': 0.12,
      '2-1': 0.11,
    },
  },
  cardsPrediction: null,
  foulsPrediction: null,
  shotsPrediction: null,
  playerShotsPredictions: [],
  valueOpportunities: [valueOpportunity],
  bestValueOpportunity: valueOpportunity,
  analysisFactors: {
    homeAdvantage: 'moderato',
  },
  methodology: {},
  ...overrides,
});

const setupBaseMocks = () => {
  mockedApi.getTeams.mockResolvedValue({
    data: [
      { team_id: 'team_inter', name: 'Inter', competition: 'Serie A' },
      { team_id: 'team_milan', name: 'Milan', competition: 'Serie A' },
    ],
  } as any);
  mockedApi.getUpcomingMatches.mockResolvedValue({ data: [matchRow] } as any);
  mockedApi.getRecentMatches.mockResolvedValue({ data: [] } as any);
  mockedApi.getMatchdayMap.mockResolvedValue({ data: { match_1: 34 } } as any);
  mockedApi.getBudget.mockResolvedValue({
    data: {
      total_budget: 1000,
      available_budget: 1000,
      total_staked: 0,
      total_won: 0,
      total_lost: 0,
      roi: 0,
      win_rate: 0,
    },
  } as any);
  mockedApi.getBets.mockResolvedValue({ data: [] } as any);
  mockedApi.placeBet.mockResolvedValue({ data: { bet_id: 'bet_1' } } as any);
};

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: jest.fn(),
  });
});

beforeEach(() => {
  jest.resetAllMocks();
  setupBaseMocks();
});

describe('Predictions page', () => {
  test('al mount carica una sola volta liste e contesto utente senza fetch prediction', async () => {
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getEurobetOddsForMatch.mockResolvedValue({ data: { found: false } } as any);

    render(<Predictions activeUser="user1" />);

    await screen.findByText('Inter');

    expect(mockedApi.getTeams).toHaveBeenCalledTimes(1);
    expect(mockedApi.getUpcomingMatches).toHaveBeenCalledTimes(1);
    expect(mockedApi.getRecentMatches).toHaveBeenCalledTimes(0);
    expect(mockedApi.getMatchdayMap).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBudget).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBets).toHaveBeenCalledTimes(1);
    expect(mockedApi.getPrediction).toHaveBeenCalledTimes(0);
    expect(mockedApi.getEurobetOddsForMatch).toHaveBeenCalledTimes(0);
  });

  test('seleziona la partita, carica quote e mostra best value e stake planner', async () => {
    mockedApi.getPrediction
      .mockResolvedValueOnce({ data: buildPrediction() } as any)
      .mockResolvedValueOnce({ data: buildPrediction({ oddsSource: 'eurobet_scraper' }) } as any);
    mockedApi.getEurobetOddsForMatch.mockResolvedValue({
      data: {
        found: true,
        source: 'eurobet_scraper',
        selectedOdds: { over25: 2.1 },
        marketsRequested: ['totals'],
        message: 'Quote reali Eurobet caricate.',
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByText('Inter'));

    await waitFor(() => expect(mockedApi.getEurobetOddsForMatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: /Pronostico Finale/i }));

    await screen.findByTestId('best-value-card');
    expect(screen.getByTestId('best-value-card').textContent).toContain('Over 2.5 Goal');
    expect(screen.getByTestId('odds-source-badge').textContent).toContain('Quote reali Eurobet');
    expect(screen.getByTestId('stake-planner').textContent).toContain('EUR 1000.00');
    expect(screen.getByText(/Quote reali Eurobet caricate/i)).toBeTruthy();
  });

  test('mostra warning quando il provider fallback viene usato', async () => {
    mockedApi.getPrediction
      .mockResolvedValueOnce({ data: buildPrediction() } as any)
      .mockResolvedValueOnce({ data: buildPrediction() } as any);
    mockedApi.getEurobetOddsForMatch.mockResolvedValue({
      data: {
        found: false,
        source: 'fallback_provider',
        fallbackOdds: { over25: 2.06 },
        marketsRequested: ['totals'],
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByText('Inter'));

    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Quote Eurobet non disponibili: mostro quote provider secondario per analisi\./i)).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: /Scommesse/i }));

    await waitFor(() => {
      expect(screen.getByTestId('value-opportunities-table').textContent).toContain('Provider secondario attivo: confronta la giocata con Eurobet prima di eseguirla.');
    });
  });

  test('gestisce Eurobet unavailable senza proporre una quota utente', async () => {
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getEurobetOddsForMatch.mockResolvedValue({
      data: {
        found: false,
        source: 'eurobet_unavailable',
        message: 'Quote Eurobet non disponibili per questa partita.',
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByText('Inter'));

    await waitFor(() => expect(mockedApi.getEurobetOddsForMatch).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: /Scommesse/i }));

    await waitFor(() => {
      expect(screen.getByTestId('value-opportunities-table').textContent).toContain('Quote Eurobet non disponibili per questa partita.');
    });
  });
});
