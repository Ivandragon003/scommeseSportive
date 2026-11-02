import { getManualModelOpportunities } from '../utils/modelBetActionsApi';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Predictions from './Predictions';
import * as api from '../utils/api';
import { getAppWallets } from '../utils/walletApi';
import { getMatchModelAdvice } from '../utils/matchModelAdviceApi';
import { getChallengerPreview } from '../utils/challengerPreviewApi';

jest.mock('../utils/api');
jest.mock('../utils/modelBetActionsApi');
jest.mock('../utils/walletApi');
jest.mock('../utils/matchModelAdviceApi');
jest.mock('../utils/challengerPreviewApi');
const mockedPreview = getChallengerPreview as jest.MockedFunction<typeof getChallengerPreview>;
const mockedAdvice = getMatchModelAdvice as jest.MockedFunction<typeof getMatchModelAdvice>;
const mockedWallets = getAppWallets as jest.MockedFunction<typeof getAppWallets>;

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
  mockedAdvice.mockResolvedValue({ A: null, C: null, errors: {} });
  mockedPreview.mockImplementation(async (matchId) => ({ kind: 'C_PREVIEW', family: 'C', matchId,
    asOf: '2026-05-23T08:00:00Z', kickoffAt: '2026-05-23T16:00:00Z', expiresAt: null,
    modelVersion: null, deploymentRevision: null, status: 'UNAVAILABLE', reason: 'real_fresh_quotes_unavailable',
    recommendationPacket: null, quote: null, suggestedStakePercent: 1, registered: false }));
  mockedWallets.mockResolvedValue({
    period: { key: 'all', from: null, to: '2026-05-23T08:00:00Z', timezone: 'Europe/Rome', label: 'Tutto lo storico' },
    portfolios: [{ family: 'A', portfolioId: 'shadow_A', initialized: true, initialCents: 100000,
      currentEquityCents: 100000, currentAvailableCents: 100000, currentCommittedCents: 0, equity: [] }],
    bets: { rows: [], total: 0, truncated: false }, leader: null, byLeague: [], byMarket: [],
    decisionDifferences: { comparedCount: 0, differentCount: 0, total: 0, truncated: false, rows: [] },
  });
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

const recordedAdvice = (family: 'A' | 'C', selection: string, selectionLabel: string, stakeCents: number) => ({
  id: `recorded-${family}`, matchId: 'match_1', family, modelVersion: `${family}-recorded`,
  action: 'BET' as const, selection, betId: `bet-${family}`, stakeCents, betStatus: 'PENDING',
  forecastAt: '2026-05-23T03:07:01Z',
  quote: { selection, odds: family === 'A' ? 2.1 : 3.3, bookmaker: 'Pinnacle', source: 'odds_api', capturedAt: '2026-05-23T03:07:00Z' },
  recommendationPacket: { selected: { selection, selectionLabel, bookmakerOdds: family === 'A' ? 2.1 : 3.3 }, decisionStatus: 'RECOMMENDED' },
});

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: jest.fn(),
  });
});

beforeEach(() => {
  jest.resetAllMocks();
  (getManualModelOpportunities as jest.Mock).mockResolvedValue([]);
  window.history.replaceState(null, '', '/predictions');
  jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-23T08:00:00.000Z').getTime());
  setupBaseMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});


const setupAnalysis = () => {
  mockedApi.getOddsForMatch.mockResolvedValue({ data: { found: true, source: 'odds_api', selectedBookmakerName: 'Pinnacle',
    analysisOdds: { over25: 2.1 }, bookmakerBySelection: { over25: 'Pinnacle' } } } as any);
  mockedApi.getPrediction.mockResolvedValue({ data: buildPrediction() } as any);
};
const openFirst = async () => { fireEvent.click(await screen.findByRole('button', { name: /Inter vs Milan.*Vedi analisi/ })); fireEvent.click(await screen.findByRole('tab', { name: 'Giocate A e C' })); };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe('Partite: consigli semplici e orchestrazione indipendente', () => {
  test('mount reads calendar and wallet once without running predictions or reconstructed matchdays', async () => {
    render(<Predictions activeUser="test-user" />); await screen.findByRole('button', { name: /Inter vs Milan/ });
    expect(screen.getByRole('heading', { name: 'Partite' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'In programma' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Concluse' })).toBeTruthy();
    expect(mockedApi.getUpcomingMatches).toHaveBeenCalledTimes(1);
    expect(mockedApi.getUpcomingMatches).toHaveBeenCalledWith(expect.objectContaining({ includeStartedWithoutResult: false }));
    expect(mockedApi.getMatchdayMap).not.toHaveBeenCalled();
    expect(mockedApi.getPrediction).not.toHaveBeenCalled();
    expect(mockedAdvice).not.toHaveBeenCalled();
  });
  test('cache-only A analysis starts independently while C preview is pending', async () => {
    setupAnalysis(); const pending = deferred<any>(); const a = deferred<any>();
    mockedPreview.mockReturnValueOnce(pending.promise); mockedApi.getPrediction.mockReturnValueOnce(a.promise);
    render(<Predictions activeUser="test-user" />); await openFirst();
    await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(1));
    expect(mockedAdvice).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(1));
    expect(mockedApi.getOddsForMatch).toHaveBeenCalledWith(expect.objectContaining({ cacheOnly: true }), expect.anything());
    await act(async () => pending.resolve({ kind: 'C_PREVIEW', family: 'C', matchId: 'match_1', asOf: '2026-05-23T08:00:00Z',
      kickoffAt: matchRow.date, expiresAt: '2026-05-23T08:05:00Z', modelVersion: 'C906-secret', deploymentRevision: 'hash-secret',
      status: 'RECOMMENDED', reason: null, recommendationPacket: { selected: { selection: 'under25', selectionLabel: 'Under 2.5 Goal' }, decisionStatus: 'RECOMMENDED' },
      quote: { selection: 'under25', odds: 2.4, bookmaker: 'Book C', source: 'odds_api', priceType: 'prematch', capturedAt: '2026-05-23T08:00:00Z', updatedAt: '2026-05-23T08:00:00Z' }, suggestedStakePercent: 1, registered: false }));
    await screen.findByText('Under 2.5 Goal'); await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/prima analisi può richiedere/)).toBeTruthy();
    expect(screen.queryByText(/C906|hash-secret|Algoritmo|Checklist|EV >|Confidenza/)).toBeNull();
    expect(mockedApi.placeBet).not.toHaveBeenCalled();
  });
  test.each(['NO_BET', 'UNAVAILABLE', 'reject'])('C %s releases A without retries or registration', async status => {
    setupAnalysis(); if (status === 'reject') mockedPreview.mockRejectedValueOnce(new Error('network'));
    else mockedPreview.mockResolvedValueOnce({ kind: 'C_PREVIEW', family: 'C', matchId: 'match_1', asOf: '2026-05-23T08:00:00Z', kickoffAt: matchRow.date, expiresAt: '2026-05-23T08:05:00Z', modelVersion: null, deploymentRevision: null, status,
      reason: null, recommendationPacket: status === 'NO_BET' ? { selected: null, decisionStatus: 'NO_BET' } : null, quote: null, suggestedStakePercent: 1, registered: false } as any);
    render(<Predictions activeUser="test-user" />); await openFirst(); await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1));
    expect(mockedAdvice).toHaveBeenCalledTimes(1); expect(mockedPreview).toHaveBeenCalledTimes(1);
    expect(mockedApi.placeBet).not.toHaveBeenCalled();
    expect(mockedApi.getPrediction.mock.calls[0][0]).toEqual(expect.objectContaining({ homeTeamId: 'team_inter', awayTeamId: 'team_milan', matchId: 'match_1', competition: 'Serie A', bookmakerOdds: { over25: 2.1 }, oddsSource: 'odds_api' }));
  });
  test('A presents the canonical selection and real bookmaker without confidence, ranking or recalculating stake', async () => {
    setupAnalysis(); render(<Predictions activeUser="test-user" />); await openFirst();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Consiglio modello A' }).textContent).toContain('Over 2.5 Goal'));
    const a = within(screen.getByRole('region', { name: 'Consiglio modello A' }));
    expect(a.getByText('Pinnacle')).toBeTruthy(); expect(a.getByText('2.10')).toBeTruthy(); expect(a.getByText('2.5%')).toBeTruthy();
    expect(a.queryByText(/EV|Edge|CORE|Alta|Probabilità stimata|Kelly|Affidabilità/)).toBeNull();
    expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1); expect(mockedApi.placeBet).not.toHaveBeenCalled();
  });
  test('archived C always wins and prevents preview, including a live A failure', async () => {
    setupAnalysis(); mockedAdvice.mockResolvedValue({ A: recordedAdvice('A', 'over25', 'Over 2.5 Goal', 1000), C: recordedAdvice('C', 'under25', 'Under 2.5 Goal', 1000), errors: {} });
    mockedApi.getPrediction.mockRejectedValueOnce(new Error('timeout'));
    render(<Predictions activeUser="test-user" />); await openFirst(); await screen.findByText('Under 2.5 Goal');
    expect(mockedPreview).not.toHaveBeenCalled(); expect(screen.getByText('Over 2.5 Goal')).toBeTruthy();
    expect(screen.queryByText(/A-recorded|C-recorded|Versione/)).toBeNull();
    expect(mockedApi.placeBet).not.toHaveBeenCalled();
  });
  test('archive error forbids C preview but allows A and a manual retry', async () => {
    setupAnalysis(); mockedAdvice.mockRejectedValueOnce(new Error('archive offline')); mockedApi.getPrediction.mockRejectedValueOnce(new Error('timeout'));
    render(<Predictions activeUser="test-user" />); await openFirst(); const retry = await screen.findByRole('button', { name: 'Riprova analisi A' });
    expect(mockedPreview).not.toHaveBeenCalled(); expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1);
    mockedApi.getPrediction.mockResolvedValueOnce({ data: buildPrediction() } as any); fireEvent.click(retry);
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(2));
  });
  test('Nightly appearing during C causes exactly one archive reread and still releases A', async () => {
    setupAnalysis(); mockedAdvice.mockResolvedValueOnce({ A: null, C: null, errors: {} }).mockResolvedValueOnce({ A: null, C: recordedAdvice('C', 'under25', 'Under 2.5 Goal', 1000), errors: {} });
    mockedPreview.mockResolvedValueOnce({ status: 'ARCHIVED' } as any);
    render(<Predictions activeUser="test-user" />); await openFirst(); await screen.findByText('Under 2.5 Goal');
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1));
    expect(mockedAdvice).toHaveBeenCalledTimes(2); expect(mockedPreview).toHaveBeenCalledTimes(1);
  });
  test('leaving a pending C aborts it; a later response cannot launch extra A or replace a new match', async () => {
    setupAnalysis(); mockedApi.getUpcomingMatches.mockResolvedValue({ data: [matchRow, nextDayMatchRow] } as any);
    const pending = deferred<any>(); mockedPreview.mockReturnValueOnce(pending.promise);
    render(<Predictions activeUser="test-user" />); await openFirst(); await waitFor(() => expect(mockedPreview).toHaveBeenCalledTimes(1));
    const signal = mockedPreview.mock.calls[0][1]; fireEvent.click(screen.getByRole('button', { name: 'Tutte le partite' }));
    expect(signal?.aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Tutte' }));
    fireEvent.click(await screen.findByRole('button', { name: /Napoli vs Roma/ }));
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(2));
    await act(async () => pending.resolve({ status: 'UNAVAILABLE' }));
    expect(mockedApi.getPrediction.mock.calls[1][0].matchId).toBe('match_2');
    expect(mockedApi.getPrediction).toHaveBeenCalledTimes(2);
  });
  test('leaving an A request aborts its HTTP signal and later completion does not leak to another match', async () => {
    setupAnalysis(); const a = deferred<any>(); mockedApi.getPrediction.mockReturnValueOnce(a.promise);
    mockedApi.getUpcomingMatches.mockResolvedValue({ data: [matchRow, nextDayMatchRow] } as any);
    render(<Predictions activeUser="test-user" />); await openFirst();
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1));
    const signal = mockedApi.getPrediction.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Tutte le partite' })); expect(signal?.aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Tutte' }));
    fireEvent.click(await screen.findByRole('button', { name: /Napoli vs Roma/ }));
    await waitFor(() => expect(mockedApi.getPrediction).toHaveBeenCalledTimes(2));
    await act(async () => a.resolve({ data: buildPrediction() }));
    expect(screen.queryByRole('heading', { name: 'Inter vs Milan' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Napoli vs Roma' })).toBeTruthy();
  });
  test('started fixtures with no score are excluded from upcoming without running any advice', async () => {
    setupAnalysis(); mockedApi.getUpcomingMatches.mockResolvedValue({ data: [{ ...matchRow, date: '2026-05-23T07:00:00Z' }] } as any);
    render(<Predictions activeUser="test-user" />);
    await screen.findByText('Nessuna partita trovata');
    expect(screen.queryByRole('button', { name: /Inter vs Milan/ })).toBeNull();
    expect(mockedAdvice).not.toHaveBeenCalled(); expect(mockedPreview).not.toHaveBeenCalled();
    expect(mockedApi.getPrediction).not.toHaveBeenCalled(); expect(mockedApi.getOddsForMatch).not.toHaveBeenCalled();
  });
  test('calendar refresh is read-only and filters clear a stale day', async () => {
    mockedApi.getUpcomingMatches.mockResolvedValue({ data: [matchRow, nextDayMatchRow] } as any);
    render(<Predictions activeUser="test-user" />); const toolbar = await screen.findByRole('toolbar', { name: 'Filtra partite per data' });
    fireEvent.click(within(toolbar).getAllByRole('button')[1]); expect(screen.queryByRole('button', { name: /Napoli vs Roma/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Campionato'), { target: { value: '' } });
    expect((await screen.findByRole('button', { name: 'Tutte' })).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Tutte' }));
    await screen.findByRole('button', { name: /Napoli vs Roma/ });
    expect(new URLSearchParams(window.location.search).get('day')).toBe('all');
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna calendario' }));
    await waitFor(() => expect(mockedApi.getUpcomingMatches).toHaveBeenCalledTimes(3));
    expect(mockedApi.getPrediction).not.toHaveBeenCalled(); expect(mockedPreview).not.toHaveBeenCalled();
  });
  test('completed match exposes observed stats separately from a retrospective replay', async () => {
    mockedApi.getRecentMatches.mockResolvedValue({ data: [{ ...matchRow, home_goals: 2, away_goals: 1, home_xg: 1.8, away_xg: 0.9 }] } as any);
    mockedApi.replayPlayedMatchPrediction.mockResolvedValue({ data: buildPrediction({ analysisMode: 'played_match_replay', oddsSource: 'odds_unavailable', canonicalRecommendation: canonicalPacket([]), valueOpportunities: [] }) } as any);
    render(<Predictions activeUser="test-user" />); fireEvent.click(screen.getByRole('tab', { name: 'Concluse' })); await openFirst();
    await screen.findByText('Nessun consiglio pre-partita archiviato disponibile.');
    expect(mockedApi.replayPlayedMatchPrediction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apri replay retrospettivo A' }));
    await screen.findByText('Replay A · valutazione retrospettiva'); expect(mockedPreview).not.toHaveBeenCalled();
    expect(mockedApi.getOddsForMatch).not.toHaveBeenCalled(); expect(mockedApi.getPrediction).not.toHaveBeenCalled();
    expect(screen.getByText('Risultato finale: 2 - 1')).toBeTruthy(); expect(screen.getByText('1.8')).toBeTruthy();
    expect(mockedApi.placeBet).not.toHaveBeenCalled();
  });
});


test('calendar defaults to today and all dates are an explicit persistent choice', async () => {
  mockedApi.getUpcomingMatches.mockResolvedValue({ data: [matchRow, nextDayMatchRow] } as any);
  const view = render(<Predictions activeUser="test-user" />);
  await screen.findByRole('button', { name: /Inter vs Milan/ });
  expect(screen.queryByRole('button', { name: /Napoli vs Roma/ })).toBeNull();
  await waitFor(() => expect(new URLSearchParams(window.location.search).get('day')).toBe('2026-05-23'));
  fireEvent.click(screen.getByRole('button', { name: 'Tutte' }));
  expect(screen.getByRole('button', { name: /Napoli vs Roma/ })).toBeTruthy();
  expect(new URLSearchParams(window.location.search).get('day')).toBe('all');
  view.unmount(); render(<Predictions activeUser="test-user" />);
  await screen.findByRole('button', { name: /Napoli vs Roma/ });
  expect(screen.getByRole('button', { name: 'Tutte' }).getAttribute('aria-pressed')).toBe('true');
});

test('when today has no fixture the first available day is selected without breaking a later match deep link', async () => {
  setupAnalysis(); mockedApi.getUpcomingMatches.mockResolvedValue({ data: [nextDayMatchRow] } as any);
  const view = render(<Predictions activeUser="test-user" />);
  await screen.findByRole('button', { name: /Napoli vs Roma/ });
  await waitFor(() => expect(new URLSearchParams(window.location.search).get('day')).toBe('2026-05-24'));
  view.unmount(); mockedApi.getUpcomingMatches.mockResolvedValue({ data: [matchRow, nextDayMatchRow] } as any);
  window.history.replaceState(null, '', '/predictions?day=2026-05-23&match=match_2');
  render(<Predictions activeUser="test-user" />);
  await screen.findByRole('heading', { name: 'Napoli vs Roma' });
  await waitFor(() => expect(mockedAdvice).toHaveBeenCalledWith('match_2', expect.anything()));
  expect(mockedApi.getPrediction.mock.calls.every(call => call[0].matchId === 'match_2')).toBe(true);
});


test('remount reads the current completed-match link and its league and season without resetting modules', async () => {
  const view = render(<Predictions activeUser="test-user" />);
  await screen.findByRole('button', { name: /Inter vs Milan/ });
  expect(screen.getByRole('tab', { name: 'In programma' }).getAttribute('aria-selected')).toBe('true');
  view.unmount();
  window.history.replaceState(null, '', '/data');
  window.history.replaceState(null, '', '/predictions?mode=recent&competition=La+Liga&season=2025%2F2026');
  mockedApi.getTeams.mockResolvedValue({ data: [{ team_id: 'team_inter', name: 'Inter', competition: 'La Liga' }] } as any);
  mockedApi.getRecentMatches.mockResolvedValue({ data: [{ ...matchRow, competition: 'La Liga', home_goals: 2, away_goals: 1 }] } as any);
  render(<Predictions activeUser="test-user" />);
  await screen.findByRole('button', { name: /Inter vs Milan/ });
  expect(screen.getByRole('tab', { name: 'Concluse' }).getAttribute('aria-selected')).toBe('true');
  expect((screen.getByLabelText('Campionato') as HTMLSelectElement).value).toBe('La Liga');
  expect((screen.getByLabelText('Stagione') as HTMLInputElement).value).toBe('2025/2026');
  expect(mockedApi.getRecentMatches).toHaveBeenCalledWith({ competition: 'La Liga', season: '2025/2026', limit: 160 });
  expect(mockedApi.getUpcomingMatches).toHaveBeenCalledTimes(1);
  const query = new URLSearchParams(window.location.search);
  expect(query.get('mode')).toBe('recent'); expect(query.get('competition')).toBe('La Liga'); expect(query.get('season')).toBe('2025/2026');
  expect(mockedApi.getPrediction).not.toHaveBeenCalled(); expect(mockedPreview).not.toHaveBeenCalled();
});


test('opening a match starts on sporting charts with a separate betting section and cache-only odds', async () => {
  setupAnalysis();
  render(<Predictions activeUser="test-user" />);
  fireEvent.click(await screen.findByRole('button', { name: /Inter vs Milan.*Vedi analisi/ }));
  await screen.findByRole('region', { name: 'Grafici gol' });
  expect(screen.getByRole('tab', { name: 'Analisi sportiva' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('region', { name: 'Grafici tiri' })).toBeTruthy();
  expect(screen.getByText(/Indici di forza non disponibili/)).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Migliori giocate per modello' })).toBeNull();
  expect(mockedApi.getOddsForMatch).toHaveBeenCalledWith(expect.objectContaining({ cacheOnly: true }), expect.anything());
  expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('tab', { name: 'Giocate A e C' }));
  expect(screen.getByRole('region', { name: 'Migliori giocate per modello' })).toBeTruthy();
  expect(mockedApi.getOddsForMatch).toHaveBeenCalledTimes(1);
  expect(mockedApi.getPrediction).toHaveBeenCalledTimes(1);
});
