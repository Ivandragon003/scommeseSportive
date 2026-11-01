import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BetsManager from '../../pages/BetsManager';
import BudgetManager from '../../pages/BudgetManager';
import * as legacyApi from '../../utils/api';
import { getAppWallets } from '../../utils/walletApi';
import { ComparisonBet, ResearchComparison } from '../research/researchComparisonTypes';
import { WalletBetTable, walletBetReturn } from './AppWallets';
import { WalletPeriodPicker, walletToday } from './WalletPages';

jest.mock('../../utils/walletApi');
jest.mock('../../utils/api');
jest.mock('../research/ResearchEquityChart', () => ({ a, c, title }: any) => <div data-testid="wallet-chart" data-a={JSON.stringify(a)} data-c={JSON.stringify(c)}>{title}</div>);
jest.mock('../../components/budget/BankrollTrendChart', () => () => <div>Andamento precedente</div>);
const mockedWallets = getAppWallets as jest.MockedFunction<typeof getAppWallets>;
const mockedLegacy = legacyApi as jest.Mocked<typeof legacyApi>;

const bet = (id: string, family: 'A' | 'C', label: string, stakeCents: number, selection: string): ComparisonBet => ({
  id, family, portfolioId: `shadow_${family}`, matchId: id, matchLabel: label, modelVersion: `${family}-recorded`,
  selection, market: selection === 'homeWin' ? '1X2' : 'goals_ou', stakeCents, odds: family === 'A' ? 2.14 : 2.9,
  status: 'PENDING', createdAt: '2026-10-30T14:17:00.000Z', profitCents: null,
  quote: { bookmaker: family === 'A' ? 'Codere (IT)' : 'Betsson', source: 'odds_api', capturedAt: '2026-10-30T14:16:00.000Z' },
});
const rows = [
  bet('a1', 'A', 'Le Havre – PSG', 420, 'homeWin'),
  bet('a2', 'A', 'Elversberg – Mainz', 1800, 'over35'),
  bet('a3', 'A', 'Lille – Lens', 2200, 'over25'),
  bet('c1', 'C', 'Le Havre – PSG', 1000, 'under25'),
  bet('c2', 'C', 'Villarreal — Espanyol', 1000, 'under25'),
];
const payload = (): ResearchComparison => ({
  period: { key: 'all', from: null, to: '2026-10-30T16:00:00.000Z', timezone: 'Europe/Rome', label: 'Dall’apertura' },
  portfolios: [
    { family: 'A', portfolioId: 'shadow_A', initialized: true, initialCents: 100000, currentEquityCents: 100000, currentAvailableCents: 95580, currentCommittedCents: 4420, betCount: 3, stakeCents: 4420, settledCount: 0, profitCents: 0, roi: null, equity: [] },
    { family: 'C', portfolioId: 'shadow_C', initialized: true, initialCents: 100000, currentEquityCents: 100000, currentAvailableCents: 98000, currentCommittedCents: 2000, betCount: 2, stakeCents: 2000, settledCount: 0, profitCents: 0, roi: null, equity: [] },
  ],
  leader: 'TIE', byLeague: [], byMarket: [], decisionDifferences: { comparedCount: 5, differentCount: 4, total: 4, truncated: false, rows: [] },
  bets: { total: 5, truncated: false, rows },
});

beforeEach(() => {
  jest.resetAllMocks();
  mockedWallets.mockResolvedValue(payload());
  mockedLegacy.getBudget.mockResolvedValue({ data: { total_budget: 1000, available_budget: 1000 } } as any);
  mockedLegacy.getBets.mockResolvedValue({ data: [] } as any);
});

afterEach(() => jest.restoreAllMocks());

test('normal Giocate lists the five funded bets and filters A/C without legacy mutations', async () => {
  render(<MemoryRouter><BetsManager activeUser="user1" /></MemoryRouter>);
  expect(await screen.findAllByRole('article')).toHaveLength(5);
  fireEvent.change(screen.getByLabelText('Modello'), { target: { value: 'A' } });
  expect(screen.getAllByRole('article')).toHaveLength(3);
  expect(screen.getByText('1 — Le Havre vincente')).toBeTruthy();
  expect(screen.queryByText('Villarreal — Espanyol')).not.toBeTruthy();
  fireEvent.change(screen.getByLabelText('Modello'), { target: { value: 'C' } });
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(screen.getByText('Villarreal — Espanyol')).toBeTruthy();
  expect(mockedLegacy.syncSharedBets).not.toHaveBeenCalled();
  expect(mockedLegacy.placeBet).not.toHaveBeenCalled();
  expect(mockedLegacy.initBudget).not.toHaveBeenCalled();
  expect(mockedLegacy.getBets).toHaveBeenCalledTimes(1);
});

test('unifies previous bets with A/C using only a deterministic baseline for unlabelled records', async () => {
  mockedLegacy.getBets.mockResolvedValue({ data: [{ bet_id: 'old', home_team_name: 'Inter', away_team_name: 'Milan',
    status: 'WON', stake: 20, profit: 10, odds: 1.5, placed_at: '2026-10-29T12:00:00Z', market_name: '1X2', selection: '1' }] } as any);
  render(<MemoryRouter><BetsManager activeUser="user1" /></MemoryRouter>);
  expect(await screen.findAllByRole('article')).toHaveLength(6);
  expect(screen.queryByRole('button', { name: 'Storico precedente' })).toBeNull();
  expect(screen.getAllByText('Baseline deterministica')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Modello'), { target: { value: 'baseline' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByText('Inter — Milan')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Modello'), { target: { value: 'C' } });
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(screen.queryByText('Inter — Milan')).toBeNull();
  expect(mockedLegacy.syncSharedBets).not.toHaveBeenCalled();
});

test('Budget keeps the actual funds separate and displays server aggregates rather than detail length', async () => {
  const data = payload(); data.portfolios[0].betCount = 7000; data.portfolios[0].roi = 0.125;
  mockedWallets.mockResolvedValue(data);
  render(<MemoryRouter><BudgetManager activeUser="user1" /></MemoryRouter>);
  const a = await screen.findByRole('region', { name: 'Portafoglio A' });
  expect(screen.queryByRole('region', { name: 'Portafoglio C' })).toBeNull();
  expect(within(a).getAllByText(/955,80/).length).toBeGreaterThan(0);
  expect(within(a).getAllByText(/44,20/).length).toBeGreaterThan(0);

  expect(screen.getByText('7000')).toBeTruthy();
  expect(screen.getAllByText('12,5%').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Modello C' }));
  const c = screen.getByRole('region', { name: 'Portafoglio C' });
  expect(within(c).getAllByText(/980,00/).length).toBeGreaterThan(0);
  expect(within(c).getAllByText(/20,00/).length).toBeGreaterThan(0);
  expect(screen.queryByRole('region', { name: 'Portafoglio A' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Confronta A e C' }));
  expect(screen.getByRole('region', { name: 'Portafoglio A' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Portafoglio C' })).toBeTruthy();
  expect(screen.queryByText(/2\.000,00/)).not.toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Inizializza' })).not.toBeTruthy();
});

test('Budget selects only its own authoritative equity series, retains comparison and period queries', async () => {
  const data = payload();
  data.portfolios[0].equity = [{ at: '2026-10-29T00:00:00Z', equityCents: 100000 }, { at: '2026-10-30T00:00:00Z', equityCents: 101000 }];
  data.portfolios[1].equity = [{ at: '2026-10-29T00:00:00Z', equityCents: 100000 }, { at: '2026-10-30T00:00:00Z', equityCents: 99000 }];
  mockedWallets.mockResolvedValue(data);
  render(<MemoryRouter><BudgetManager activeUser="user1" /></MemoryRouter>);
  let chart = await screen.findByTestId('wallet-chart');
  expect(chart.getAttribute('data-a')).toBe(JSON.stringify(data.portfolios[0].equity));
  expect(chart.hasAttribute('data-c')).toBe(false);
  expect(screen.getByRole('link', { name: 'Giocate del modello A' }).getAttribute('href')).toBe('/bets?model=A');
  fireEvent.click(screen.getByRole('button', { name: 'Modello C' }));
  chart = screen.getByTestId('wallet-chart');
  expect(chart.hasAttribute('data-a')).toBe(false);
  expect(chart.getAttribute('data-c')).toBe(JSON.stringify(data.portfolios[1].equity));
  fireEvent.click(screen.getByRole('button', { name: 'Confronta A e C' }));
  chart = screen.getByTestId('wallet-chart');
  expect(chart.getAttribute('data-a')).toBe(JSON.stringify(data.portfolios[0].equity));
  expect(chart.getAttribute('data-c')).toBe(JSON.stringify(data.portfolios[1].equity));
  fireEvent.change(screen.getByLabelText('Periodo'), { target: { value: '7d' } });
  await waitFor(() => expect(mockedWallets).toHaveBeenLastCalledWith({ period: '7d' }, expect.any(AbortSignal)));
  expect(mockedLegacy.initBudget).not.toHaveBeenCalled();
  expect(mockedLegacy.syncSharedBets).not.toHaveBeenCalled();
});

test('Budget keeps an unavailable portfolio explicit without reconstructing funds', async () => {
  const data = payload(); data.portfolios[0].initialized = false;
  mockedWallets.mockResolvedValue(data);
  render(<MemoryRouter><BudgetManager activeUser="user1" /></MemoryRouter>);
  expect(await screen.findByText(/Portafoglio non disponibile. Nessun saldo/)).toBeTruthy();
  expect(screen.queryByLabelText('Riepilogo modello A')).toBeNull();
  expect(mockedLegacy.initBudget).not.toHaveBeenCalled();
});

test('unified rows preserve partial settlement and do not assign a missing family to A or C', async () => {
  const data = payload();
  data.bets.rows = [{ ...rows[0], family: undefined, portfolioId: 'other', status: 'HALF_LOST', stakeCents: 2000, profitCents: -1000 }];
  mockedWallets.mockResolvedValue(data);
  render(<MemoryRouter><BetsManager activeUser="user1" /></MemoryRouter>);
  const row = (await screen.findAllByRole('article'))[0];
  expect(within(row).getByText('Baseline deterministica')).toBeTruthy();
  expect(within(row).getByText('MEZZA PERDITA')).toBeTruthy();
  expect(within(row).getByText('EUR 10.00')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Perse' }));
  expect(screen.getAllByRole('article')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Modello'), { target: { value: 'A' } });
  expect(screen.queryAllByRole('article')).toHaveLength(0);
});

test('a failed previous-history request is visible instead of looking like an empty history', async () => {
  mockedLegacy.getBets.mockRejectedValue(new Error('offline'));
  render(<MemoryRouter><BetsManager activeUser="user1" /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(await screen.findAllByRole('article')).toHaveLength(5);
  expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy();
});

test('a failed wallet read is explicit and never proposes a new bankroll', async () => {
  mockedWallets.mockRejectedValue(new Error('Database temporaneamente non disponibile'));
  render(<MemoryRouter><BudgetManager activeUser="user1" /></MemoryRouter>);
  expect((await screen.findByRole('alert')).textContent).toContain('Non è stato possibile caricare giocate e saldi');
  expect(screen.queryByText('Crea il bankroll iniziale')).not.toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Inizializza' })).not.toBeTruthy();
  expect(mockedLegacy.initBudget).not.toHaveBeenCalled();
});

test('opening the previous history does not trigger settlement or expose reset controls', async () => {
  render(<MemoryRouter><BudgetManager activeUser="user1" /></MemoryRouter>);
  await screen.findByRole('region', { name: 'Portafoglio A' });
  fireEvent.click(screen.getByRole('button', { name: 'Storico precedente' }));
  await waitFor(() => expect(mockedLegacy.getBudget).toHaveBeenCalled());
  expect(mockedLegacy.syncSharedBets).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Inizializza' })).not.toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Avvia nuova sessione' })).not.toBeTruthy();
  expect(screen.queryByText('Manutenzione budget')).not.toBeTruthy();
});

test('half loss and half win preserve the actual partial return and original result', () => {
  const partialLoss = { ...rows[0], status: 'HALF_LOST', stakeCents: 2000, profitCents: -1000 };
  const partialWin = { ...rows[1], status: 'HALF_WON', stakeCents: 2000, profitCents: 500 };
  expect(walletBetReturn(partialLoss)).toBe(1000);
  expect(walletBetReturn(partialWin)).toBe(2500);
  expect(walletBetReturn({ ...partialLoss, status: 'PENDING' })).toBeNull();
  render(<WalletBetTable rows={[partialLoss, partialWin]} model="all" />);
  expect(screen.getByText('Mezza perdita')).toBeTruthy();
  expect(screen.getByText('Mezza vincita')).toBeTruthy();
  expect(screen.getByText(/^10,00/)).toBeTruthy();
  expect(screen.getByText(/^25,00/)).toBeTruthy();
});

test('truncated details remain distinct from complete registered-bet counts', async () => {
  const data = payload(); data.bets.total = 800; data.bets.truncated = true; data.portfolios[0].betCount = 600;
  mockedWallets.mockResolvedValue(data);
  render(<MemoryRouter><BetsManager activeUser="user1" /></MemoryRouter>);
  await screen.findAllByRole('article');
  expect(screen.getByText(/Mostrate fino a 5 delle 800 giocate/)).toBeTruthy();
  expect(screen.getAllByRole('article')).toHaveLength(5);
});

test('returning to the app coalesces focus/visibility refresh and observes completed syncs without polling', async () => {
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  render(<MemoryRouter><BetsManager activeUser="user1" /></MemoryRouter>);
  await screen.findAllByRole('article');
  expect(mockedWallets).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(now + 31_000);
  fireEvent(window, new Event('focus'));
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(mockedWallets).toHaveBeenCalledTimes(2));
  await screen.findAllByRole('article');
  fireEvent(window, new Event('data-sync-complete'));
  fireEvent(window, new Event('data-sync-complete'));
  await waitFor(() => expect(mockedWallets).toHaveBeenCalledTimes(3));
});

test('today uses the existing custom range in Rome, including the UTC day boundary', () => {
  expect(walletToday(new Date('2026-10-31T23:30:00Z'))).toBe('2026-11-01');
  const change = jest.fn();
  render(<WalletPeriodPicker query={{ period: 'all' }} onChange={change} />);
  fireEvent.change(screen.getByLabelText('Periodo'), { target: { value: 'today' } });
  expect(change).toHaveBeenCalledWith({ period: 'custom', from: walletToday(), to: walletToday() });
});

test('recorded bets retain real prices and outcomes without internal market or provider codes', () => {
  render(<WalletBetTable rows={[{ ...rows[0], market: 'dnb', selection: 'dnb_home' },
    { ...rows[1], market: 'totals', status: 'PENDING', kickoffAt: '2026-01-01T12:00:00Z' }]} model="all" />);
  expect(screen.getByText('Pareggio rimborsato')).toBeTruthy();
  expect(screen.getByText('Gol totali')).toBeTruthy();
  expect(screen.getByText('In attesa di esito')).toBeTruthy();
  expect(screen.getByText('Risultato o liquidazione non ancora disponibili.')).toBeTruthy();
  expect(screen.queryByText(/odds_api|Challenger|ROI/)).toBeNull();
  expect(screen.getAllByText('2,14')).toHaveLength(2);
});

test('Giocate distinguishes a win, double chance and DNB while retaining the recorded price and stake', async () => {
  const records = [
    { ...rows[0], id: 'win', matchLabel: 'Torino – Roma', selection: 'homeWin', market: '1x2' },
    { ...rows[0], id: 'chance', matchLabel: 'Torino – Roma', selection: 'double_chance_1x', market: 'double_chance' },
    { ...rows[3], id: 'refund', matchLabel: 'Frosinone – Torino', selection: 'dnb_away', market: 'dnb' },
  ];
  const before = JSON.stringify(records);
  const data = payload(); data.bets.rows = records; data.bets.total = records.length;
  mockedWallets.mockResolvedValue(data);
  render(<MemoryRouter><BetsManager activeUser="user1" /></MemoryRouter>);
  expect(await screen.findByText('1 — Torino vincente')).toBeTruthy();
  expect(screen.getByText('1X — Torino o pareggio')).toBeTruthy();
  expect(screen.getByText('DNB 2 — Torino; pareggio rimborsato')).toBeTruthy();
  const cards = screen.getAllByRole('article');
  expect(within(cards[0]).getByText('2.14')).toBeTruthy();
  expect(within(cards[0]).getByText('EUR 4.20')).toBeTruthy();
  expect(within(cards[2]).getByText('2.90')).toBeTruthy();
  expect(within(cards[2]).getByText('EUR 10.00')).toBeTruthy();
  expect(JSON.stringify(records)).toBe(before);
  expect(mockedLegacy.placeBet).not.toHaveBeenCalled();
  expect(mockedLegacy.syncSharedBets).not.toHaveBeenCalled();
});
