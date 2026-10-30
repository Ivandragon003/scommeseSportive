import { act, renderHook, waitFor } from '@testing-library/react';
import { useUserBudget, walletMatchKey } from './useUserBudget';
import { useBetPlacement } from './useBetPlacement';
import { getAppWallets } from '../utils/walletApi';
import { getBets, getBudget, placeBet, syncSharedBets } from '../utils/api';
import { ResearchComparison } from '../features/research/researchComparisonTypes';

jest.mock('../utils/walletApi');
jest.mock('../utils/api');
const mockedWallets = getAppWallets as jest.MockedFunction<typeof getAppWallets>;
const mockedBudget = getBudget as jest.MockedFunction<typeof getBudget>;
const mockedBets = getBets as jest.MockedFunction<typeof getBets>;
const mockedPlace = placeBet as jest.MockedFunction<typeof placeBet>;
const mockedSync = syncSharedBets as jest.MockedFunction<typeof syncSharedBets>;

const wallets = (): ResearchComparison => ({
  period: { key: 'all', from: null, to: '2026-10-30T15:17:00Z', timezone: 'Europe/Rome', label: 'Tutto lo storico' },
  portfolios: [
    { family: 'A', portfolioId: 'shadow_A', initialized: true, initialCents: 100000, currentAvailableCents: 95580,
      currentCommittedCents: 4420, currentEquityCents: 100000, equity: [] },
    { family: 'C', portfolioId: 'shadow_C', initialized: true, initialCents: 100000, currentAvailableCents: 98000,
      currentCommittedCents: 2000, currentEquityCents: 100000, equity: [] },
  ],
  bets: { total: 2, truncated: false, rows: [
    { id: 'a', portfolioId: 'shadow_A', family: 'A', matchId: 'match-A', modelVersion: 'APP-A-recorded',
      selection: 'homeWin', market: '1x2', stakeCents: 420, odds: 8, status: 'PENDING', createdAt: '2026-10-30T14:17:00Z' },
    { id: 'c', portfolioId: 'shadow_C', family: 'C', matchId: 'match-C', modelVersion: 'C-recorded',
      selection: 'under25', market: 'goals', stakeCents: 1000, odds: 2.9, status: 'PENDING', createdAt: '2026-10-30T14:17:00Z' },
  ] },
  leader: null, byLeague: [], byMarket: [],
  decisionDifferences: { comparedCount: 0, differentCount: 0, total: 0, truncated: false, rows: [] },
});

beforeEach(() => jest.resetAllMocks());

test('Partite legge il portafoglio A effettivo senza sync o budget legacy', async () => {
  mockedWallets.mockResolvedValue(wallets());
  const { result } = renderHook(() => useUserBudget('user1'));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.bankroll).toBe(1000);
  expect(result.current.budget.available_budget).toBe(955.8);
  expect(result.current.budget.committed_budget).toBe(44.2);
  expect(result.current.userBets.map((bet) => bet.id)).toEqual(['a']);
  expect(result.current.placedMatchKeySet.has(walletMatchKey('A', 'match-A'))).toBe(true);
  expect(result.current.placedMatchKeySet.has(walletMatchKey('C', 'match-C'))).toBe(false);
  expect(mockedWallets).toHaveBeenCalledWith({ period: 'all' });
  expect(mockedSync).not.toHaveBeenCalled();
  expect(mockedBudget).not.toHaveBeenCalled();
  expect(mockedBets).not.toHaveBeenCalled();
});

test('C legge soltanto il proprio saldo e le proprie registrazioni', async () => {
  mockedWallets.mockResolvedValue(wallets());
  const { result } = renderHook(() => useUserBudget('user1', { mode: 'automatic', family: 'C' }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.budget.available_budget).toBe(980);
  expect(result.current.budget.committed_budget).toBe(20);
  expect(result.current.userBets.map((bet) => bet.id)).toEqual(['c']);
  expect(result.current.placedMatchKeySet.has('C:match-C')).toBe(true);
  expect(result.current.placedMatchKeySet.has('A:match-A')).toBe(false);
});

test('un errore dei portafogli resta esplicito e non ripiega sul vecchio bankroll', async () => {
  mockedWallets.mockRejectedValue(new Error('Database non disponibile'));
  const { result } = renderHook(() => useUserBudget('user1'));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBe('Database non disponibile');
  expect(result.current.budget).toBeNull();
  expect(mockedBudget).not.toHaveBeenCalled();
  expect(mockedSync).not.toHaveBeenCalled();
});

test('la compatibilità del contesto legacy richiede la scelta esplicita', async () => {
  mockedSync.mockResolvedValue({ success: true } as any);
  mockedBudget.mockResolvedValue({ data: { available_budget: 50 } } as any);
  mockedBets.mockResolvedValue({ data: [] } as any);
  const { result } = renderHook(() => useUserBudget('user1', { mode: 'legacy' }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.bankroll).toBe(50);
  expect(result.current.automaticFamily).toBeNull();
  expect(mockedWallets).not.toHaveBeenCalled();
  expect(mockedSync).toHaveBeenCalledTimes(1);
});

const placementParams = () => ({
  activeUser: 'user1', budget: {}, pred: { matchId: 'match-A' }, activeMatchRow: {}, competition: 'Ligue 1',
  bankroll: 1000, stakes: {}, setStakes: jest.fn(), loadUserContext: jest.fn().mockResolvedValue(undefined),
  confirm: jest.fn().mockResolvedValue(true), showToast: jest.fn().mockReturnValue('toast'),
});

test('la registrazione dalla pagina A non può addebitare il vecchio portafoglio', async () => {
  const params = placementParams();
  const { result } = renderHook(() => useBetPlacement({ ...params, automaticFamily: 'A' }));
  await act(async () => result.current.handleBet({ selection: 'homeWin', marketName: '1x2', bookmakerOdds: 8 }));
  expect(mockedPlace).not.toHaveBeenCalled();
  expect(params.confirm).not.toHaveBeenCalled();
  expect(params.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('automaticamente dalla Nightly') }));
});
