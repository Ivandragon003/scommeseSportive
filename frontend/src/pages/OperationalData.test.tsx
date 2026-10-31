import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OperationalData from './OperationalData';
import { getOperationalStatus, OperationalStatus, refreshMatchResults } from '../utils/api';

jest.mock('../utils/api');
const readStatus = getOperationalStatus as jest.MockedFunction<typeof getOperationalStatus>;
const refreshResults = refreshMatchResults as jest.MockedFunction<typeof refreshMatchResults>;
const status = (): OperationalStatus => ({
  checkedAt: '2026-10-31T16:00:00Z', lastDataUpdateAt: '2026-10-31T12:00:00Z', lastResultsRefreshAt: null,
  nightly: { state: 'SUCCESS', lastStartedAt: '2026-10-31T12:00:00Z', lastCompletedAt: '2026-10-31T12:10:00Z',
    analyzedMatches: 0, registeredBets: 0 },
});
const renderPage = () => render(<MemoryRouter><OperationalData /></MemoryRouter>);
beforeEach(() => {
  jest.resetAllMocks();
  readStatus.mockResolvedValue({ success: true, data: status() });
  refreshResults.mockResolvedValue({ success: true, data: { status: 'SUCCESS', startedAt: '2026-10-31T16:00:00Z',
    completedAt: '2026-10-31T16:01:00Z', checked: 22, updated: 7, settlement: { checked: 8, settled: 4, unresolved: 4 } } });
});

test('opening the page only reads observed status and never updates results or registers bets', async () => {
  renderPage();
  expect(await screen.findByText('Ultima elaborazione completata')).toBeTruthy();
  expect(readStatus).toHaveBeenCalledTimes(1);
  expect(refreshResults).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Vedi partite concluse' }).getAttribute('href')).toBe('/predictions?mode=recent');
  expect(screen.getByRole('link', { name: 'Vedi giocate registrate' }).getAttribute('href')).toBe('/bets');
  expect(screen.queryByText(/0 giocate|scheduler|benchmark|Brier|API quota|Challenger/i)).toBeNull();
  const data = within(screen.getByRole('region', { name: 'Aggiornamento dei dati' }));
  expect(data.getByText('Non disponibile')).toBeTruthy();
});

test('manual results refresh runs once and emits a completed event only after a verified success', async () => {
  let finish!: (value: Awaited<ReturnType<typeof refreshMatchResults>>) => void;
  refreshResults.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const completed = jest.fn();
  window.addEventListener('data-sync-complete', completed);
  try {
    renderPage();
    await screen.findByText('Ultima elaborazione completata');
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna risultati' }));
    expect((screen.getByRole('button', { name: 'Aggiornamento in corso…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Aggiornamento in corso…' }));
    expect(refreshResults).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    await act(async () => finish({ success: true, data: { status: 'SUCCESS', startedAt: '2026-10-31T16:00:00Z',
      completedAt: '2026-10-31T16:01:00Z', checked: 22, updated: 7, settlement: { checked: 8, settled: 4, unresolved: 4 } } }));
    expect(await screen.findByText('Risultati aggiornati: 7. Giocate liquidate: 4.')).toBeTruthy();
    expect(completed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(readStatus).toHaveBeenCalledTimes(2));
  } finally { window.removeEventListener('data-sync-complete', completed); }
});

test.each(['PARTIAL', 'FAILED'] as const)('a %s refresh remains explicit without reporting completed sync', async (resultStatus) => {
  refreshResults.mockResolvedValue({ success: true, data: { status: resultStatus, startedAt: '2026-10-31T16:00:00Z',
    completedAt: '2026-10-31T16:01:00Z', checked: 22, updated: 0, settlement: { checked: 0, settled: 0, unresolved: 0 } } });
  const completed = jest.fn();
  window.addEventListener('data-sync-complete', completed);
  try {
    renderPage();
    await screen.findByText('Ultima elaborazione completata');
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna risultati' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(completed).not.toHaveBeenCalled();
    expect(screen.queryByText('Risultati aggiornati: 0. Giocate liquidate: 0.')).toBeNull();
  } finally { window.removeEventListener('data-sync-complete', completed); }
});

test.each(['PARTIAL', 'FAILED'] as const)('a %s refresh with unavailable settlement never substitutes zero settled bets', async (resultStatus) => {
  refreshResults.mockResolvedValue({ success: true, data: { status: resultStatus, startedAt: '2026-10-31T16:00:00Z',
    completedAt: '2026-10-31T16:01:00Z', checked: 22, updated: 7, settlement: null } });
  const completed = jest.fn();
  window.addEventListener('data-sync-complete', completed);
  try {
    renderPage();
    await screen.findByText('Ultima elaborazione completata');
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna risultati' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/liquidazione delle giocate non è/);
    expect(screen.queryByText(/Giocate liquidate: 0/)).toBeNull();
    expect(completed).not.toHaveBeenCalled();
  } finally { window.removeEventListener('data-sync-complete', completed); }
});

test('a success without a verified settlement is reported as incomplete rather than completed', async () => {
  refreshResults.mockResolvedValue({ success: true, data: { status: 'SUCCESS', startedAt: '2026-10-31T16:00:00Z',
    completedAt: '2026-10-31T16:01:00Z', checked: 22, updated: 7, settlement: null } });
  const completed = jest.fn();
  window.addEventListener('data-sync-complete', completed);
  try {
    renderPage();
    await screen.findByText('Ultima elaborazione completata');
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna risultati' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/Giocate liquidate:/)).toBeNull();
    expect(completed).not.toHaveBeenCalled();
  } finally { window.removeEventListener('data-sync-complete', completed); }
});

test('an unavailable status is an error with retry, not a fabricated successful or empty run', async () => {
  readStatus.mockRejectedValueOnce(new Error('SQL or transport details'));
  renderPage();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('SQL or transport details')).toBeNull();
  expect(screen.queryByText('Ultima elaborazione completata')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Riprova lettura' }));
  expect(await screen.findByText('Ultima elaborazione completata')).toBeTruthy();
  expect(refreshResults).not.toHaveBeenCalled();
});
