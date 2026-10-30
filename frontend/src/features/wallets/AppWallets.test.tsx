import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BetsManager from '../../pages/BetsManager';
import BudgetManager from '../../pages/BudgetManager';
import * as legacyApi from '../../utils/api';
import { getAppWallets } from '../../utils/walletApi';
import { ComparisonBet, ResearchComparison } from '../research/researchComparisonTypes';
import { WalletBetTable, walletBetReturn } from './AppWallets';

jest.mock('../../utils/walletApi');
jest.mock('../../utils/api');
jest.mock('../research/ResearchEquityChart', () => () => <div>Andamento dei patrimoni</div>);
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
  bet('c2', 'C', 'Villarreal – Espanyol', 1000, 'under25'),
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
  expect(screen.getByText('Vittoria Le Havre')).toBeTruthy();
  expect(screen.queryByText('Villarreal – Espanyol')).not.toBeTruthy();
  fireEvent.change(screen.getByLabelText('Modello'), { target: { value: 'C' } });
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(screen.getByText('Villarreal – Espanyol')).toBeTruthy();
  expect(mockedLegacy.syncSharedBets).not.toHaveBeenCalled();
  expect(mockedLegacy.placeBet).not.toHaveBeenCalled();
  expect(mockedLegacy.initBudget).not.toHaveBeenCalled();
  expect(mockedLegacy.getBudget).not.toHaveBeenCalled();
});

test('Budget keeps the actual funds separate and displays server aggregates rather than detail length', async () => {
  const data = payload(); data.portfolios[0].betCount = 7000; data.portfolios[0].roi = 0.125;
  mockedWallets.mockResolvedValue(data);
  render(<MemoryRouter><BudgetManager activeUser="user1" /></MemoryRouter>);
  const a = await screen.findByRole('region', { name: 'Portafoglio A' });
  const c = screen.getByRole('region', { name: 'Portafoglio C' });
  expect(within(a).getByText(/955,80/)).toBeTruthy();
  expect(within(a).getByText(/44,20/)).toBeTruthy();
  expect(within(c).getByText(/980,00/)).toBeTruthy();
  expect(within(c).getByText(/20,00/)).toBeTruthy();
  expect(screen.getByText('7000')).toBeTruthy();
  expect(screen.getByText('12,5%')).toBeTruthy();
  expect(screen.queryByText(/2\.000,00/)).not.toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Inizializza' })).not.toBeTruthy();
});

test('a failed wallet read is explicit and never proposes a new bankroll', async () => {
  mockedWallets.mockRejectedValue(new Error('Database temporaneamente non disponibile'));
  render(<MemoryRouter><BudgetManager activeUser="user1" /></MemoryRouter>);
  expect((await screen.findByRole('alert')).textContent).toContain('Database temporaneamente non disponibile');
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
  expect(await screen.findByText(/Modello A: 600 giocate registrate/)).toBeTruthy();
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
