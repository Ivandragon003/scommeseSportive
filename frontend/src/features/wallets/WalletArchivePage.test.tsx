import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { selectOption } from '../../testSelect';
import WalletArchivePage from './WalletArchivePage';
import { getWalletArchive, WalletArchiveData } from '../../utils/walletApi';
import API from '../../utils/api';

jest.mock('../../utils/walletApi');
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const mockedArchive = getWalletArchive as jest.MockedFunction<typeof getWalletArchive>;
const summary = { total: 2, settled: 1, open: 1, won: 1, lost: 0, void: 0, missingProfit: false, wonCents: 12345, lostCents: 0, netCents: 12345 };
const data: WalletArchiveData = { summary, byClassification: [{ ...summary, quality: 'HIGH' }], byModel: [{ ...summary, family: 'A' }], total: 2, offset: 0, limit: 200,
  rows: [{ id: 'baseline:old', family: 'A', historical: true, portfolioId: 'legacy_deterministic_A', matchId: 'old', modelVersion: '', matchLabel: 'Old Home – Old Away', market: '1x2', selection: 'homeWin', odds: 2, stakeCents: 1000, profitCents: 1000, status: 'WON', createdAt: '2026-10-20T10:00:00Z', classification: 'HIGH' },
    { id: 'current-c', family: 'C', portfolioId: 'shadow_C', matchId: 'c1', modelVersion: 'C-test', matchLabel: 'Alpha – Beta', market: 'totals', selection: 'under25', odds: 2.5, stakeCents: 1000, status: 'PENDING', createdAt: '2026-11-01T10:00:00Z', classification: 'LOW' }],
};
beforeEach(() => { jest.clearAllMocks(); mockedArchive.mockResolvedValue(data); window.history.replaceState({}, '', '/prediction-archive'); });

test('renders server totals and labels all deterministic records as A without a separate historical model', async () => {
  render(<WalletArchivePage />); await screen.findByText('Old Home – Old Away');
  expect(screen.getByRole('article', { name: 'A · Old Home – Old Away' })).toBeTruthy();
  const overview = screen.getByRole('region', { name: 'Riepilogo giocate' });
  expect(within(overview).getAllByText(/123,45/)).toHaveLength(2);
  fireEvent.click(screen.getByLabelText('Modello'));
  expect(screen.getByRole('option', { name: 'Deterministico (Modello A)' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: /storico/i })).toBeNull();
  expect(API.post).not.toHaveBeenCalled();
});

test('keeps the chosen risk highlighted and the page visible while the backend filters results', async () => {
  let resolve!: (value: WalletArchiveData) => void;
  mockedArchive.mockResolvedValueOnce(data).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<WalletArchivePage />); await screen.findByText('Old Home – Old Away');
  const high = screen.getByRole('button', { name: 'High', exact: true }); fireEvent.click(high);
  expect(high.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText('Alpha – Beta')).toBeTruthy();
  await waitFor(() => expect(mockedArchive).toHaveBeenLastCalledWith(expect.objectContaining({ qualities: ['HIGH'] }), expect.anything()));
  await act(async () => { resolve({ ...data, rows: [data.rows[0]], total: 1, summary: { ...summary, total: 1 }, byClassification: [{ ...summary, total: 1, quality: 'HIGH' }] }); });
  expect(screen.queryByText('Alpha – Beta')).toBeNull();
  expect(high.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Azzera filtri' }));
  await screen.findByText('Alpha – Beta'); expect(high.getAttribute('aria-pressed')).toBe('false');
});

test('requests model and date filters from the backend', async () => {
  render(<WalletArchivePage />); await screen.findByText('Alpha – Beta');
  selectOption(screen.getByLabelText('Modello'), 'A');
  fireEvent.change(screen.getByLabelText('Da'), { target: { value: '2026-10-01' } });
  await waitFor(() => expect(mockedArchive).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'A', from: '2026-10-01' }), expect.anything()));
  fireEvent.change(screen.getByLabelText('A'), { target: { value: '2026-09-01' } });
  expect(screen.getByRole('alert').textContent).toContain('data finale');
});

test('shows full aggregate figures even when only a page of records is returned', async () => {
  mockedArchive.mockResolvedValue({ ...data, total: 700, summary: { ...summary, total: 700, settled: 699 }, rows: [data.rows[0]] });
  render(<WalletArchivePage />); await screen.findByText('Old Home – Old Away');
  expect(screen.getByText('699 concluse · 1 aperte')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Successive' }));
  await waitFor(() => expect(mockedArchive).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 200 }), expect.anything()));
});

test('loads the recorded C decision without creating bets', async () => {
  (API.get as jest.Mock).mockResolvedValue({ data: { success: true, data: { matchId: 'c1', decisions: [{ id: 'saved', betId: 'current-c', family: 'C', matchId: 'c1', modelVersion: 'C-test', action: 'BET', selection: 'under25', recommendationPacket: { selected: { selection: 'under25' } } }] } } });
  render(<WalletArchivePage />); await screen.findByText('Alpha – Beta');
  const row = screen.getByRole('article', { name: 'C · Alpha – Beta' });
  fireEvent.click(within(row).getByText('Dettagli della giocata'));
  fireEvent.click(within(row).getByRole('button', { name: 'Apri pronostico registrato' }));
  expect(await screen.findByText('Consiglio registrato verificato.')).toBeTruthy(); expect(API.post).not.toHaveBeenCalled();
});

test('does not present a failed backend calculation as an empty archive', async () => {
  mockedArchive.mockRejectedValueOnce(new Error('unavailable'));
  render(<WalletArchivePage />); expect((await screen.findByRole('alert')).textContent).toContain('archivio');
  expect(screen.queryByRole('region', { name: 'Riepilogo giocate' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Riprova' })); await screen.findByText('Alpha – Beta');
});
