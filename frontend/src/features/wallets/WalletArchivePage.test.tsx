import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import WalletArchivePage from './WalletArchivePage';
import { getAppWallets } from '../../utils/walletApi';
import API from '../../utils/api';
import { getBetOpportunityArchive } from '../../utils/api';
import PredictionArchivePage from '../prediction-archive/PredictionArchivePage';
import { ComparisonBet, ResearchComparison } from '../research/researchComparisonTypes';

jest.mock('../../utils/walletApi');
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() }, getBetOpportunityArchive: jest.fn() }));

const mockedWallets = getAppWallets as jest.MockedFunction<typeof getAppWallets>;
const bet = (id: string, family: 'A' | 'C', stakeCents: number, matchLabel: string): ComparisonBet => ({
  id, family, portfolioId: `shadow_${family}`, modelVersion: family === 'A' ? 'APP-A-test' : 'C-test',
  matchId: id, matchLabel, market: 'totals', selection: family === 'A' ? 'over25' : 'under25',
  stakeCents, odds: 2.14, status: 'PENDING', createdAt: '2026-10-30T14:17:00Z',
  quote: { bookmaker: family === 'A' ? 'Codere (IT)' : 'Betsson', source: 'odds_api', capturedAt: '2026-10-30T14:16:00Z' },
});

const rows = [bet('a1', 'A', 420, 'Alpha – Beta'), bet('a2', 'A', 1800, 'Gamma – Delta'),
  bet('a3', 'A', 2200, 'Epsilon – Zeta'), bet('c1', 'C', 1000, 'Alpha – Beta'), bet('c2', 'C', 1000, 'Eta – Theta')];
const data: ResearchComparison = {
  period: { key: 'all', from: null, to: '2026-10-30T15:00:00Z', timezone: 'Europe/Rome', label: 'Dall’apertura dei portafogli' },
  portfolios: [
    { family: 'A', portfolioId: 'shadow_A', initialCents: 100000, currentEquityCents: 100000, currentAvailableCents: 95580,
      currentCommittedCents: 4420, betCount: 3, equity: [] },
    { family: 'C', portfolioId: 'shadow_C', initialCents: 100000, currentEquityCents: 100000, currentAvailableCents: 98000,
      currentCommittedCents: 2000, betCount: 2, equity: [] },
  ],
  bets: { total: 5, truncated: false, rows }, leader: null, byLeague: [], byMarket: [],
  decisionDifferences: { comparedCount: 1, differentCount: 0, total: 0, truncated: false, rows: [
    { matchId: 'unfunded', matchLabel: 'Not played – No stake', at: '2026-10-30T14:17:00Z',
      A: { action: 'ABSTAIN', reason: 'no_recommendation' }, C: { action: 'ABSTAIN' } },
  ] },
};

describe('WalletArchivePage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedWallets.mockResolvedValue(data);
    window.history.replaceState({}, '', '/prediction-archive');
  });

  test('lists the five funded records in the normal archive, excluding unfunded decisions', async () => {
    render(<WalletArchivePage />);
    expect(await screen.findByRole('heading', { name: 'Archivio' })).toBeTruthy();
    await screen.findByText('Gamma – Delta');
    expect(screen.getAllByRole('article')).toHaveLength(5);
    expect(screen.queryByText('Not played – No stake')).toBeNull();
    expect(screen.getByText(/Modello A: 3 giocate registrate/)).toBeTruthy();
    expect(screen.getByText(/Modello C: 2 giocate registrate/)).toBeTruthy();
    expect(mockedWallets).toHaveBeenCalledWith({ period: 'all' }, expect.anything());
    expect(API.post).not.toHaveBeenCalled();
  });

  test('the main archive route defaults to the funded A/C source without mounting the previous archive', async () => {
    render(<PredictionArchivePage />);
    await screen.findByText('Gamma – Delta');
    expect(screen.getAllByRole('article')).toHaveLength(5);
    expect(getBetOpportunityArchive).not.toHaveBeenCalled();
    expect(API.post).not.toHaveBeenCalled();
  });

  test('filters actual records by A and C without replacing them with predictions', async () => {
    render(<WalletArchivePage />);
    await screen.findByText('Gamma – Delta');
    fireEvent.change(screen.getByLabelText('Modello'), { target: { value: 'C' } });
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('Eta – Theta')).toBeTruthy();
    expect(screen.queryByText('Gamma – Delta')).toBeNull();
    fireEvent.change(screen.getByLabelText('Modello'), { target: { value: 'A' } });
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByText('Eta – Theta')).toBeNull();
    expect(mockedWallets).toHaveBeenCalledTimes(1);
    expect(API.get).not.toHaveBeenCalled();
  });

  test('opens the matching recorded C forecast from its archived bet', async () => {
    (API.get as jest.Mock).mockResolvedValueOnce({ data: { success: true, data: { matchId: 'c1', decisions: [
      { id: 'old-a', betId: 'a1', family: 'A', matchId: 'c1', action: 'BET', modelVersion: 'APP-A-test', selection: 'over25',
        confidence: 'HIGH', recommendationPacket: { selected: { selection: 'over25' } } },
      { id: 'frozen-c', betId: 'c1', family: 'C', matchId: 'c1', action: 'BET', modelVersion: 'C-test', selection: 'under25',
        confidence: null, recommendationPacket: { selected: { selection: 'under25' } } },
    ] } } });
    render(<WalletArchivePage />);
    await screen.findByText('Gamma – Delta');
    fireEvent.change(screen.getByLabelText('Modello'), { target: { value: 'C' } });
    const card = screen.getByRole('article', { name: 'C · Alpha – Beta' });
    fireEvent.click(within(card).getByText('Dettagli della giocata'));
    fireEvent.click(within(card).getByRole('button', { name: 'Apri pronostico registrato' }));
    expect(await screen.findByText('C-test')).toBeTruthy();
    expect(screen.getByText('Non registrata')).toBeTruthy();
    expect(screen.queryByText('APP-A-test')).toBeNull();
    expect(API.get).toHaveBeenCalledWith('/research/forecasts', { params: { matchId: 'c1' }, signal: expect.anything() });
    expect(API.get).toHaveBeenCalledTimes(1);
    expect(API.post).not.toHaveBeenCalled();
  });

  test.each(['manual', 'data-sync'] as const)('updates the opened evidence after %s refresh settles the recorded bet', async (trigger) => {
    (API.get as jest.Mock).mockResolvedValue({ data: { success: true, data: { matchId: 'c1', decisions: [
      { id: 'frozen-c', betId: 'c1', family: 'C', matchId: 'c1', action: 'BET', modelVersion: 'C-test', selection: 'under25',
        confidence: null, recommendationPacket: { selected: { selection: 'under25' } } },
    ] } } });
    mockedWallets.mockResolvedValueOnce(data).mockResolvedValueOnce({ ...data, bets: { ...data.bets,
      rows: rows.map((row) => row.id === 'c1' ? { ...row, status: 'HALF_LOST', profitCents: -500, settledAt: '2026-10-30T21:00:00Z' } : row),
    } });
    render(<WalletArchivePage />);
    await screen.findByText('Gamma – Delta');
    const card = screen.getByRole('article', { name: 'C · Alpha – Beta' });
    fireEvent.click(within(card).getByText('Dettagli della giocata'));
    fireEvent.click(within(card).getByRole('button', { name: 'Apri pronostico registrato' }));
    await screen.findByText('C-test');
    const pendingEvidence = screen.getByRole('region', { name: 'Pronostico registrato modello C' });
    expect(within(pendingEvidence).getByText('Aperta')).toBeTruthy();
    expect(within(pendingEvidence).queryByText(/^5,00\s€$/)).toBeNull();

    if (trigger === 'manual') fireEvent.click(screen.getByRole('button', { name: 'Aggiorna archivio' }));
    else fireEvent(window, new Event('data-sync-complete'));

    await waitFor(() => expect(mockedWallets).toHaveBeenCalledTimes(2));
    await screen.findByText('C-test');
    const settledEvidence = screen.getByRole('region', { name: 'Pronostico registrato modello C' });
    expect(within(settledEvidence).getByText('Mezza perdita')).toBeTruthy();
    expect(within(settledEvidence).getByText(/^5,00\s€$/)).toBeTruthy();
    expect(within(settledEvidence).getByText(/^-5,00\s€$/)).toBeTruthy();
    expect(within(settledEvidence).queryByText('Aperta')).toBeNull();
    expect(API.post).not.toHaveBeenCalled();
  });

  test('uses the settled return for a half loss and keeps open bets out of the settled filter', async () => {
    mockedWallets.mockResolvedValueOnce({ ...data, bets: { total: 2, truncated: false, rows: [
      { ...rows[0], status: 'HALF_LOST', stakeCents: 1000, profitCents: -500, settledAt: '2026-10-30T21:00:00Z' }, rows[4],
    ] } });
    render(<WalletArchivePage />);
    await screen.findByText('Mezza perdita');
    fireEvent.change(screen.getByLabelText('Esito'), { target: { value: 'settled' } });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    fireEvent.click(screen.getByText('Dettagli della giocata'));
    expect(screen.getByText(/^5,00\s€$/)).toBeTruthy();
    expect(screen.queryByText('Eta – Theta')).toBeNull();
    expect(API.post).not.toHaveBeenCalled();
  });

  test('keeps source aggregate totals explicit when details are truncated', async () => {
    mockedWallets.mockResolvedValueOnce({ ...data, bets: { total: 700, truncated: true, rows },
      portfolios: data.portfolios.map((portfolio) => ({ ...portfolio, betCount: portfolio.family === 'A' ? 400 : 300 })) });
    render(<WalletArchivePage />);
    expect(await screen.findByText(/Modello A: 400 giocate registrate/)).toBeTruthy();
    expect(screen.getByText(/Modello C: 300 giocate registrate/)).toBeTruthy();
    expect(screen.getByText(/fino a 5 delle 700 giocate/)).toBeTruthy();
  });

  test('does not mount or relabel previous records until the previous archive is requested', async () => {
    render(<WalletArchivePage legacy={<div>Original previous records</div>} />);
    await screen.findByText('Gamma – Delta');
    expect(screen.queryByText('Original previous records')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Storico precedente' }));
    expect(screen.getByText('Original previous records')).toBeTruthy();
    expect(screen.queryByText('Gamma – Delta')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Torna all’archivio A/C' }));
    expect(await screen.findByText('Gamma – Delta')).toBeTruthy();
  });

  test('keeps an API failure explicit and retries instead of fabricating an empty archive', async () => {
    mockedWallets.mockRejectedValueOnce(new Error('Registro non disponibile'));
    render(<WalletArchivePage />);
    expect((await screen.findByRole('alert')).textContent).toContain('Registro non disponibile');
    expect(screen.queryByText('Nessuna giocata registrata nei filtri scelti.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    await waitFor(() => expect(mockedWallets).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Gamma – Delta')).toBeTruthy();
  });
});
