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

const nextDayMatchRow = {
  ...matchRow,
  match_id: 'match_2',
  home_team_id: 'team_napoli',
  away_team_id: 'team_roma',
  home_team_name: 'Napoli',
  away_team_name: 'Roma',
  date: '2026-05-24T18:45:00.000Z',
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

const canonicalPacket = (ranked: any[] = [valueOpportunity]) => ({
  policyVersion: 'match-page-recommendation-v1', selected: ranked[0] ?? null, ranked,
  decisionStatus: ranked.length ? 'RECOMMENDED' : 'NO_BET', asOf: '2026-05-23T03:07:01Z',
  model: { source: 'PredictionService', version: 'APP-A-test', codeHash: 'code', configHash: 'config', stateHash: 'state' },
  odds: { source: 'odds_api', capturedAt: '2026-05-23T03:07:00Z', bookmakerBySelection: { over25: 'Pinnacle' } },
  probabilities: { raw: { over25: .561 }, decision: { over25: .561 } },
});

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
  canonicalRecommendation: canonicalPacket(),
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
  window.history.replaceState(null, '', '/predictions');
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

    await screen.findByRole('button', { name: /Inter.*Milan/i });

    expect(mockedApi.getTeams).toHaveBeenCalledTimes(1);
    expect(mockedApi.getUpcomingMatches).toHaveBeenCalledTimes(1);
    expect(mockedApi.getRecentMatches).toHaveBeenCalledTimes(0);
    expect(mockedApi.getMatchdayMap).toHaveBeenCalledTimes(1);
    expect(mockedApi.syncSharedBets).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBudget).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBets).toHaveBeenCalledTimes(1);
    expect(mockedApi.getPrediction).toHaveBeenCalledTimes(0);
    expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(0);
    expect(screen.queryByText(/Consigli giornata/i)).toBeNull();
  });

  test('mostra prima tutte le partite raggruppate per giorno senza filtro data o selezione automatica', async () => {
    mockedApi.getUpcomingMatches.mockResolvedValue({ data: [matchRow, nextDayMatchRow] } as any);
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({ data: { found: false } } as any);

    render(<Predictions activeUser="user1" />);

    expect(await screen.findByRole('button', { name: /Inter.*Milan/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Napoli.*Roma/i })).toBeTruthy();
    expect(screen.getByLabelText('Campionato')).toBeTruthy();
    expect(screen.getByLabelText('Stagione')).toBeTruthy();
    expect(screen.queryByLabelText('Data')).toBeNull();
    expect(screen.getByText(/Sabato 23 maggio/i)).toBeTruthy();
    expect(screen.getByText(/Domenica 24 maggio/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Analizza partita/i })).toBeNull();
    expect(screen.queryByText(/Pronta per l’analisi/i)).toBeNull();
    expect(mockedApi.getPrediction).toHaveBeenCalledTimes(0);
    expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(0);
  });

  test('mostra il packet A archiviato e non ripropone la registrazione della stessa puntata', async () => {
    const archivedPick = { ...valueOpportunity, bookmakerName: 'Pinnacle', bookmakerOdds: 1.77, suggestedStakePercent: .37 };
    const automaticRecommendation = { ...canonicalPacket([archivedPick]), actualStakeAmount: 3.7,
      status: 'OPEN', placedAt: '2026-05-23T03:07:02Z' };
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction({ automaticRecommendation }) } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({ data: { found: true, source: 'odds_api',
      selectedBookmakerName: 'Pinnacle', selectedOdds: { over25: 2.1 }, marketsRequested: ['totals'] } } as any);

    render(<Predictions activeUser="user1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));
    await screen.findByTestId('best-value-card');
    expect(screen.getByTestId('best-value-metric-quota-bookmaker').textContent).toBe('1.77');
    expect(screen.getByTestId('best-value-metric-puntata-suggerita').textContent).toBe('EUR 3.70');
    expect(screen.getByText(/prezzo archiviato, non quota corrente/)).toBeTruthy();
    expect(screen.queryByTestId('stake-planner')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Scommesse/i }));
    expect(await screen.findByText('Scommessa gia fatta')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Scommetti/ })).toBeNull();
    expect(mockedApi.placeBet).not.toHaveBeenCalled();
  });

  test('mostra una astensione tecnica registrata senza sostituirla con consigli live o azioni di puntata', async () => {
    const automaticRecommendation = { projectionKind: 'technical_abstention', selected: null, ranked: [],
      decisionStatus: 'NO_BET', actualStakeAmount: 0, status: 'ABSTAIN',
      reason: 'Calendario incompleto al momento della valutazione.', asOf: '2026-05-23T03:07:01Z',
      placedAt: null, model: null, probabilities: null, odds: null, source: null,
      quoteArchived: false, quoteStatus: 'UNAVAILABLE', quoteCapturedAt: null };
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction({ automaticRecommendation,
      bestValueOpportunity: { ...valueOpportunity, confidence: 'LOW', edgeNoVig: 2 },
    }) } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({ data: { found: true, source: 'odds_api',
      selectedBookmakerName: 'Pinnacle', selectedOdds: { over25: 2.1 }, marketsRequested: ['totals'] } } as any);

    render(<Predictions activeUser="user1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));
    expect(await screen.findByText('Valutazione Nightly non completata')).toBeTruthy();
    expect(screen.getByLabelText('Decisione Nightly A').textContent).toContain(automaticRecommendation.reason);
    expect(screen.getByLabelText('Decisione Nightly A').textContent).toContain('EUR 0.00');
    expect(screen.queryByTestId('best-value-metric-quota-bookmaker')).toBeNull();
    expect(screen.queryByTestId('stake-planner')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Scommesse/i }));
    expect(screen.queryByRole('button', { name: /Scommetti/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archivia/ })).toBeNull();
    expect(mockedApi.placeBet).not.toHaveBeenCalled();
  });

  test('il replay storico conserva il consiglio canonico e non richiede quote correnti o nuove registrazioni', async () => {
    const played = { ...matchRow, date: '2026-05-22T18:00:00Z', home_goals: 2, away_goals: 1 };
    mockedApi.getRecentMatches.mockResolvedValue({ data: [played] } as any);
    const replayPick = { ...valueOpportunity, bookmakerName: 'Eurobet', bookmakerOdds: 2.23 };
    mockedApi.replayPlayedMatchPrediction.mockResolvedValue({ data: buildPrediction({
      analysisMode: 'played_match_replay', oddsReplaySource: 'historical_bookmaker_snapshot',
      canonicalRecommendation: canonicalPacket([replayPick]), replayOddsUsed: { over25: 2.23 },
      actualMatch: { date: played.date, actualScore: '2-1' },
      recommendedBetResult: { selection: 'over25', status: 'WON', reason: 'Esito storico verificato.' },
    }) } as any);

    render(<Predictions activeUser="user1" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Recenti' }));
    await waitFor(() => expect(mockedApi.getRecentMatches).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));
    await waitFor(() => expect(mockedApi.replayPlayedMatchPrediction).toHaveBeenCalledWith('match_1'));
    expect(await screen.findByTestId('best-value-card')).toBeTruthy();
    expect(screen.getByTestId('best-value-card').textContent).toContain('Over 2.5 Goal');
    expect(screen.getByTestId('best-value-metric-quota-bookmaker').textContent).toBe('2.23');
    expect(screen.getByTestId('best-value-card').textContent).toContain('WON');
    expect(mockedApi.getPrediction).not.toHaveBeenCalled();
    expect(mockedApi.getOddsForMatch).not.toHaveBeenCalled();
    expect(mockedApi.placeBet).not.toHaveBeenCalled();
  });

  test('apre il dettaglio di una sola partita e permette di tornare alla lista', async () => {
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({ data: { found: false } } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));

    expect(screen.queryByRole('region', { name: 'Filtri e partite' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Tutte le partite/i }));

    expect(await screen.findByRole('region', { name: 'Filtri e partite' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Tutte le partite/i })).toBeNull();
  });

  test('seleziona la partita, carica quote e mostra best value e stake planner', async () => {
    mockedApi.getPrediction
      .mockResolvedValueOnce({ data: buildPrediction({ oddsSource: 'odds_api' }) } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({
      data: {
        found: true,
        source: 'odds_api',
        primaryProvider: 'odds_api',
        selectedBookmakerName: 'Pinnacle',
        selectedOdds: { over25: 2.1 },
        analysisOdds: { over25: 2.1, 'alternate_totals_cards_over_4.5': 2.05, 'alternate_totals_shots_over_23.5': 1.92 },
        bookmakerBySelection: { over25: 'Pinnacle', 'alternate_totals_cards_over_4.5': 'Codere', 'alternate_totals_shots_over_23.5': 'Betfair' },
        analysisBookmakers: ['Codere', 'Pinnacle'],
        marketsRequested: ['totals', 'alternate_totals_cards'],
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));

    await waitFor(() => expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1));
    expect(mockedApi.getPrediction).toHaveBeenCalledWith(expect.objectContaining({
      bookmakerOdds: { over25: 2.1, 'alternate_totals_cards_over_4.5': 2.05, 'alternate_totals_shots_over_23.5': 1.92 },
      bookmakerBySelection: { over25: 'Pinnacle', 'alternate_totals_cards_over_4.5': 'Codere', 'alternate_totals_shots_over_23.5': 'Betfair' },
      oddsSource: 'odds_api',
    }));
    expect(mockedApi.getOddsForMatch).toHaveBeenCalledWith(expect.objectContaining({
      matchId: 'match_1',
      homeTeam: 'Inter',
      awayTeam: 'Milan',
      commenceTime: matchRow.date,
    }));
    fireEvent.click(screen.getByRole('tab', { name: /Pronostico Finale/i }));

    await screen.findByTestId('best-value-card');
    expect(screen.getAllByText(/Migliore giocata del match/i).length).toBeGreaterThan(0);
    expect(screen.getByTestId('best-value-card').textContent).toContain('Over 2.5 Goal');
    expect(screen.getByTestId('odds-source-badge').textContent).toContain('Quota bookmaker verificata: 2 bookmaker reali');
    expect(screen.getByTestId('stake-planner').textContent).toContain('EUR 1000.00');
    expect(screen.getByText(/Quote bookmaker reali caricate.*odds_api/i)).toBeTruthy();
    expect(screen.queryByText(/Consigli giornata/i)).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Quote Complete/i }));
    expect(await screen.findByRole('region', { name: 'Totali goal' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Cartellini' })).toBeTruthy();
    expect(screen.getByText('Codere')).toBeTruthy();
    expect(screen.getByText('Pinnacle')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Cartellini' }));
    expect(await screen.findByText(/Quote disponibili · Cartellini/i)).toBeTruthy();
    expect(screen.getByLabelText('Quote disponibili: Cartellini').textContent).toContain('Codere');
    fireEvent.click(screen.getByRole('tab', { name: 'Tiri' }));
    expect(await screen.findByText(/Quote disponibili · Tiri/i)).toBeTruthy();
    expect(screen.getByLabelText('Quote disponibili: Tiri').textContent).toContain('Betfair');
    expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1);
    expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(1);
  });

  test('conserva i filtri e ripristina il dettaglio dalla cronologia senza ricalcolare', async () => {
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction({ oddsSource: 'odds_api' }) } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({
      data: { found: true, source: 'odds_api', selectedBookmakerName: 'Pinnacle', selectedOdds: { over25: 2.1 }, analysisOdds: { over25: 2.1 }, bookmakerBySelection: { over25: 'Pinnacle' }, analysisBookmakers: ['Pinnacle'] },
    } as any);

    render(<Predictions activeUser="user1" />);

    const dateFilter = await screen.findByRole('button', { name: /Sabato 23 maggio/i });
    fireEvent.click(dateFilter);
    fireEvent.click(screen.getByRole('button', { name: /Inter.*Milan/i }));
    await screen.findByRole('tab', { name: /Quote Complete/i });
    expect(window.location.search).toContain('match=match_1');

    window.history.back();
    fireEvent.popState(window);
    expect(await screen.findByRole('region', { name: 'Filtri e partite' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Sabato 23 maggio/i }).getAttribute('aria-pressed')).toBe('true');

    window.history.forward();
    fireEvent.popState(window);
    await screen.findByRole('tab', { name: /Quote Complete/i });
    expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1);
    expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(1);
  });

  test('consuma i 3 slot canonici del backend e mantiene il consiglio LOW aggiuntivo nel solo archivio', async () => {
    const lowPlayerOpportunity = {
      ...valueOpportunity,
      selection: 'player_orsolini_shots_over_1_5',
      selectionLabel: 'Riccardo Orsolini Over 1.5 tiri',
      marketName: 'Tiri giocatore',
      marketCategory: 'player_shots',
      playerName: 'Riccardo Orsolini',
      teamName: 'Bologna',
      expectedMinutes: 82,
      sampleSize: 12,
      confidence: 'LOW',
    };
    const lowTeamOpportunity = {
      ...valueOpportunity,
      selection: 'under25',
      selectionLabel: 'Under 2.5 Goal',
      confidence: 'LOW',
    };
    const highTeamOpportunity = {
      ...valueOpportunity,
      selection: 'over25',
      selectionLabel: 'Over 2.5 Goal',
      confidence: 'HIGH',
    };
    const mediumTeamOpportunity = {
      ...valueOpportunity,
      selection: 'btts',
      selectionLabel: 'GG Sì',
      marketName: 'Goal / No Goal',
      confidence: 'MEDIUM',
    };
    const thirdPriorityTeamOpportunity = {
      ...valueOpportunity,
      selection: 'awayWin',
      selectionLabel: 'Vittoria Milan',
      marketName: 'Esito finale (1X2)',
      confidence: 'MEDIUM',
    };
    const recommendedAwayDnb = {
      ...valueOpportunity,
      selection: 'dnb_away',
      selectionLabel: 'Pareggio non conta (DNB) · Ospite',
      marketName: 'Draw No Bet - Ospite',
      bookmakerOdds: 2.59,
      confidence: 'LOW',
      expectedValue: 20.26,
      edgeNoVig: 6.4,
    };
    const speculativeTeamOpportunity = {
      ...valueOpportunity,
      selection: 'double_chance_1x',
      selectionLabel: 'Doppia chance 1X',
      marketName: 'Doppia Chance',
      marketTier: 'SPECULATIVE',
      confidence: 'LOW',
    };
    const opportunities = [
      lowPlayerOpportunity,
      lowTeamOpportunity,
      mediumTeamOpportunity,
      highTeamOpportunity,
      thirdPriorityTeamOpportunity,
    ];
    const canonicalRecommendation = canonicalPacket([highTeamOpportunity, mediumTeamOpportunity, thirdPriorityTeamOpportunity]);
    mockedApi.getPrediction
      .mockResolvedValueOnce({ data: buildPrediction({ canonicalRecommendation, valueOpportunities: opportunities, speculativeOpportunities: [speculativeTeamOpportunity], bestValueOpportunity: recommendedAwayDnb }) } as any)
      .mockResolvedValueOnce({ data: buildPrediction({ canonicalRecommendation, valueOpportunities: opportunities, speculativeOpportunities: [speculativeTeamOpportunity], bestValueOpportunity: recommendedAwayDnb, oddsSource: 'odds_api' }) } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({
      data: {
        found: true,
        source: 'odds_api',
        primaryProvider: 'odds_api',
        selectedBookmakerName: 'Pinnacle',
        selectedOdds: {
          [lowPlayerOpportunity.selection]: lowPlayerOpportunity.bookmakerOdds,
          [lowTeamOpportunity.selection]: lowTeamOpportunity.bookmakerOdds,
          [mediumTeamOpportunity.selection]: mediumTeamOpportunity.bookmakerOdds,
          [highTeamOpportunity.selection]: highTeamOpportunity.bookmakerOdds,
          [thirdPriorityTeamOpportunity.selection]: thirdPriorityTeamOpportunity.bookmakerOdds,
          [speculativeTeamOpportunity.selection]: speculativeTeamOpportunity.bookmakerOdds,
          [recommendedAwayDnb.selection]: recommendedAwayDnb.bookmakerOdds,
        },
        marketsRequested: ['player_shots', 'totals', 'h2h_3_way'],
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));
    const recommendedBetsTab = await screen.findByRole('tab', { name: /Scommesse\s*3/i });
    fireEvent.click(recommendedBetsTab);

    const valueBets = await screen.findByTestId('value-opportunities-table');
    expect(valueBets.textContent).toContain('GG Si');
    expect(valueBets.textContent).toContain('Over 2.5 Goal');
    expect(valueBets.textContent).toContain('Vittoria Ospite');
    expect(valueBets.textContent).toContain('Pareggio non conta (DNB) · Ospite');
    expect(valueBets.textContent).toContain('Solo archivio · LOW');
    expect(valueBets.textContent).not.toContain('Under 2.5 Goal');
    expect(valueBets.textContent).not.toContain('Double Chance 1X');
    expect(valueBets.textContent).toContain('Consigliata');
    expect(valueBets.textContent).not.toContain('Riccardo Orsolini');
    expect(screen.queryByText(/Nessuna giocata supera i criteri operativi/i)).toBeNull();

    expect(screen.queryByRole('tab', { name: /Mercati giocatore\s*1/i })).toBeNull();
    expect(screen.queryByText('Riccardo Orsolini')).toBeNull();
  });

  test('non presenta come operativa una giocata solo speculativa', async () => {
    mockedApi.getPrediction.mockResolvedValue({
      data: buildPrediction({
        valueOpportunities: [],
        canonicalRecommendation: canonicalPacket([]),
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
        selectedBookmakerName: 'Pinnacle',
        selectedOdds: { over25: 2.1 },
        marketsRequested: ['totals'],
        message: 'Quote bookmaker caricate correttamente.',
      },
    } as any);

    render(<Predictions activeUser="user1" />);

    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('tab', { name: /Pronostico Finale/i }));

    expect(await screen.findByText('Nessuna giocata consigliata')).toBeTruthy();
    expect(screen.getByText(/non genera una puntata reale/i)).toBeTruthy();
    expect(screen.getByTestId('best-value-card').textContent).not.toContain('Over 2.5 Goal');
    expect(screen.getByText(/EUR 0\.00/)).toBeTruthy();
    expect(screen.queryByText(/Alternative valutate/i)).toBeNull();
  });

  test('mostra NO_MARKET solo quando mancano quote o probabilita valutabili', async () => {
    mockedApi.getPrediction.mockResolvedValue({
      data: buildPrediction({
        valueOpportunities: [],
        bestValueOpportunity: null,
        canonicalRecommendation: canonicalPacket([]),
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

    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('tab', { name: /Pronostico Finale/i }));

    expect(await screen.findByText('Nessuna giocata consigliata')).toBeTruthy();
    expect(screen.getAllByText(/Quota bookmaker non disponibile/i).length).toBeGreaterThan(0);
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

    expect(await screen.findByRole('button', { name: /Inter.*Milan/i })).toBeTruthy();
    expect(screen.queryByText('Juventus')).toBeNull();
  });

  test('quando il sistema segnala sync completato ricarica le partite upcoming', async () => {
    mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
    mockedApi.getOddsForMatch.mockResolvedValue({ data: { found: false } } as any);

    render(<Predictions activeUser="user1" />);

    await screen.findByRole('button', { name: /Inter.*Milan/i });
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

    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));

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

    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));

    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText(/Quota bookmaker non disponibile/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText('2.06')).toBeNull();

    fireEvent.click(await screen.findByRole('tab', { name: /Scommesse/i }));

    await waitFor(() => {
      expect(screen.getByTestId('value-opportunities-table').textContent).toContain('Quota bookmaker non disponibile');
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

    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));

    await waitFor(() => expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('tab', { name: /Scommesse/i }));

    await waitFor(() => {
      expect(screen.getByTestId('value-opportunities-table').textContent).toContain('Quota bookmaker non disponibile per questa partita.');
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

    fireEvent.click(await screen.findByRole('button', { name: /Inter.*Milan/i }));

    await waitFor(() => expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(1));

    expect(await screen.findByText(/Errore quote: 502 = backend\/proxy non ha risposto\. Controlla logs backend\./i)).toBeTruthy();
  });
});
