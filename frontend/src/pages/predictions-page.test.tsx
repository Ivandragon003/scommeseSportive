import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  date: '2026-05-23T16:00:00.000Z',
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
  jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-23T08:00:00.000Z').getTime());
  setupBaseMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Predictions page', () => {
  test('al mount carica una sola volta liste e contesto utente senza fetch prediction', async () => {
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({ data: { found: false } } as any);

    render(<Predictions activeUser="user1" />);

    await screen.findByText('Inter');

    expect(mockedApi.getTeams).toHaveBeenCalledTimes(1);
    expect(mockedApi.getUpcomingMatches).toHaveBeenCalledTimes(1);
    expect(mockedApi.getRecentMatches).toHaveBeenCalledTimes(0);
    expect(mockedApi.getMatchdayMap).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBudget).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBets).toHaveBeenCalledTimes(1);
    expect(mockedApi.getPrediction).toHaveBeenCalledTimes(0);
    expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(0);
    expect(screen.queryByText(/Consigli giornata/i)).toBeNull();
  });

  test('seleziona la partita, carica quote e mostra best value e stake planner', async () => {
    mockedApi.getPrediction
      .mockResolvedValueOnce({ data: buildPrediction() } as any)
      .mockResolvedValueOnce({ data: buildPrediction({ oddsSource: 'odds_api' }) } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({
      data: {
        found: true,
        source: 'odds_api',
        primaryProvider: 'odds_api',
        selectedOdds: { over25: 2.1 },
        marketsRequested: ['totals'],
        message: 'Quote bookmaker caricate correttamente.',
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByText('Inter'));

    await waitFor(() => expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(2));
    expect(mockedApi.getOddsForMatch).toHaveBeenCalledWith(expect.objectContaining({
      matchId: 'match_1',
      homeTeam: 'Inter',
      awayTeam: 'Milan',
      commenceTime: matchRow.date,
    }));
    fireEvent.click(screen.getByRole('button', { name: /Pronostico Finale/i }));

    await screen.findByTestId('best-value-card');
    expect(screen.getAllByText(/Migliore giocata del match/i).length).toBeGreaterThan(0);
    expect(screen.getByTestId('best-value-card').textContent).toContain('Over 2.5 Goal');
    expect(screen.getByTestId('odds-source-badge').textContent).toContain('Quota Eurobet verificata');
    expect(screen.getByTestId('stake-planner').textContent).toContain('EUR 1000.00');
    expect(screen.getByText(/Quote bookmaker caricate/i)).toBeTruthy();
    expect(screen.queryByText(/Consigli giornata/i)).toBeNull();
  });

  test('mostra SPECULATIVE quando la migliore giocata e debole ma valutabile', async () => {
    mockedApi.getPrediction.mockResolvedValue({
      data: buildPrediction({
        bestValueOpportunity: {
          ...valueOpportunity,
          confidence: 'LOW',
          bestBetStatus: 'SPECULATIVE',
          bestBetReason: 'Migliore giocata disponibile, ma il margine non e forte. Stake basso.',
          riskAdjustedBestScore: 0.08,
          edgeNoVig: 1.4,
        },
        bestBetStatus: 'SPECULATIVE',
        bestBetReason: 'Migliore giocata disponibile, ma il margine non e forte. Stake basso.',
        bestBetAlternatives: [
          {
            selection: 'dnb_away',
            marketName: 'Draw No Bet - Ospite',
            expectedValue: 5.1,
            edgeNoVig: 2.8,
            riskAdjustedScore: 0.1,
            confidence: 'MEDIUM',
            reason: 'risk_adjusted_score_basso',
          },
        ],
      }),
    } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({
      data: {
        found: true,
        source: 'odds_api',
        primaryProvider: 'odds_api',
        selectedOdds: { over25: 2.1 },
        marketsRequested: ['totals'],
        message: 'Quote bookmaker caricate correttamente.',
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByText('Inter'));
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: /Pronostico Finale/i }));

    expect(await screen.findByText('Rischio elevato')).toBeTruthy();
    expect(screen.getByText(/Migliore giocata disponibile/i)).toBeTruthy();
    expect(screen.queryByText(/Match da saltare/i)).toBeNull();
    expect(screen.getByTestId('best-value-card').textContent).toContain('Over 2.5 Goal');
    expect(screen.queryByText(/Alternative valutate/i)).toBeNull();
  });

  test('mostra NO_MARKET solo quando mancano quote o probabilita valutabili', async () => {
    mockedApi.getPrediction.mockResolvedValue({
      data: buildPrediction({
        valueOpportunities: [],
        bestValueOpportunity: null,
        bestBetStatus: 'NO_MARKET',
        bestBetReason: 'Quote o probabilita insufficienti per scegliere una giocata.',
        bestBetAlternatives: [],
      }),
    } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({
      data: {
        found: false,
        source: 'odds_unavailable',
        message: 'Quote bookmaker non disponibili per questa partita.',
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByText('Inter'));
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: /Pronostico Finale/i }));

    expect(await screen.findByText('Nessuna giocata consigliata')).toBeTruthy();
    expect(screen.getAllByText(/Quota Eurobet non disponibile/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Match da saltare/i)).toBeNull();
  });

  test('il calendario upcoming ignora partite passate di aprile e parte dalle future', async () => {
    mockedApi.getUpcomingMatches.mockResolvedValue({
      data: [
        {
          ...matchRow,
          match_id: 'old_match',
          home_team_name: 'Juventus',
          away_team_name: 'Roma',
          date: '2026-04-20T18:45:00.000Z',
        },
        matchRow,
      ],
    } as any);
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({ data: { found: false } } as any);

    render(<Predictions activeUser="user1" />);

    expect(await screen.findByText('Inter')).toBeTruthy();
    expect(screen.queryByText('Juventus')).toBeNull();
  });

  test('quando il sistema segnala sync completato ricarica le partite upcoming', async () => {
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({ data: { found: false } } as any);

    render(<Predictions activeUser="user1" />);

    await screen.findByText('Inter');
    expect(mockedApi.getUpcomingMatches).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('data-sync-complete'));
    });

    await waitFor(() => expect(mockedApi.getUpcomingMatches).toHaveBeenCalledTimes(2));
  });

  test('passa commenceTime null al lookup quote solo se la partita non ha data', async () => {
    mockedApi.getUpcomingMatches.mockResolvedValue({
      data: [{ ...matchRow, date: undefined }],
    } as any);
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({
      data: {
        found: false,
        source: 'odds_unavailable',
        message: 'Quote bookmaker non disponibili per questa partita.',
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByText('Inter'));

    await waitFor(() => expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(1));
    expect(mockedApi.getOddsForMatch).toHaveBeenCalledWith(expect.objectContaining({
      matchId: 'match_1',
      commenceTime: null,
    }));
  });

  test('mostra warning quando il provider fallback viene usato', async () => {
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({
      data: {
        found: false,
        source: 'fallback_provider',
        fallbackOdds: { over25: 2.06 },
        marketsRequested: ['totals'],
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByText('Inter'));

    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText(/Quota Eurobet non disponibile/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText('2.06')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /Scommesse/i }));

    await waitFor(() => {
      expect(screen.getByTestId('value-opportunities-table').textContent).toContain('Quota Eurobet non disponibile');
    });
    expect(screen.queryByRole('button', { name: /Scommetti/i })).toBeNull();
  });

  test('gestisce provider unavailable senza proporre una quota utente', async () => {
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({
      data: {
        found: false,
        source: 'odds_unavailable',
        message: 'Quote bookmaker non disponibili per questa partita.',
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByText('Inter'));

    await waitFor(() => expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: /Scommesse/i }));

    await waitFor(() => {
      expect(screen.getByTestId('value-opportunities-table').textContent).toContain('Quota Eurobet non disponibile per questa partita.');
    });
  });

  test('mostra il messaggio di errore quote quando la route quote risponde 502', async () => {
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getOddsForMatch.mockRejectedValue({
      response: {
        status: 502,
        data: {
          error: 'Request failed with status code 502',
        },
      },
    });

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByText('Inter'));

    await waitFor(() => expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(1));

    expect(await screen.findByText(/Errore quote: 502 = backend\/proxy non ha risposto\. Controlla logs backend\./i)).toBeTruthy();
  });
});
