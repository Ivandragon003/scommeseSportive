import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import * as api from './utils/api';

jest.mock('./utils/api');
jest.mock('./pages/Predictions', () => ({
  __esModule: true,
  default: () => <div>Predictions page</div>,
}));
jest.mock('./pages/BudgetManager', () => ({
  __esModule: true,
  default: () => <div>Budget page</div>,
}));
jest.mock('./pages/BetsManager', () => ({
  __esModule: true,
  default: () => <div>Bets page</div>,
}));
jest.mock('./features/prediction-archive/PredictionArchivePage', () => ({
  __esModule: true,
  default: () => <div>Prediction archive page</div>,
}));
jest.mock('./pages/Backtesting', () => ({
  __esModule: true,
  default: () => <div>Backtesting page</div>,
}));
jest.mock('./pages/DataManager', () => ({
  __esModule: true,
  default: () => <div>Data page</div>,
}));
jest.mock('./pages/Scrapers', () => ({
  __esModule: true,
  default: () => <div>Scrapers page</div>,
}));

const mockedApi = api as jest.Mocked<typeof api>;

beforeEach(() => {
  jest.resetAllMocks();
  window.localStorage.clear();
  window.history.pushState({}, '', '/');
  mockedApi.getScraperStatus.mockResolvedValue({
    data: {
      isUpdating: false,
      lastUpdate: { success: true, message: 'Dati aggiornati correttamente.' },
      recentSchedulerRuns: [
        { schedulerName: 'understat', success: true },
        { schedulerName: 'learning', success: true },
        { schedulerName: 'odds', success: true },
      ],
    },
  } as any);
  mockedApi.syncUpcomingKickoffs.mockResolvedValue({
    data: { corrected: 0 },
  } as any);
});

test('header principale resta essenziale e rende aggiorna sistema disponibile negli strumenti', async () => {
  render(<App />);

  const header = screen.getByRole('banner');
  expect(within(header).getByText('FootPredictor')).toBeTruthy();
  expect(within(header).getByText(/Decisioni rapide/i)).toBeTruthy();
  expect(within(header).queryByRole('button', { name: /Aggiorna sistema/i })).toBeNull();

  expect(screen.queryByText(/Sync Notturna/i)).toBeNull();
  expect(within(header).queryByText(/Workspace/i)).toBeNull();
  expect(within(header).queryByText(/user1/i)).toBeNull();
  expect(within(header).queryByText(/Sistema OK/i)).toBeNull();
  expect(within(header).queryByText(/Sync OK/i)).toBeNull();

  await waitFor(() => expect(mockedApi.getScraperStatus).toHaveBeenCalledTimes(1));
  expect(mockedApi.syncUpcomingKickoffs).toHaveBeenCalledTimes(0);

  fireEvent.click(screen.getByRole('button', { name: 'Apri strumenti' }));
  fireEvent.click(within(screen.getByRole('menu', { name: /Strumenti/i })).getByRole('button', { name: /Aggiorna sistema/i }));

  await waitFor(() => expect(mockedApi.getScraperStatus).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mockedApi.syncUpcomingKickoffs).toHaveBeenCalledWith({
    mode: 'top5',
    season: expect.stringMatching(/^\d{4}\/\d{4}$/),
    limit: 160,
  }));
  expect(await screen.findByText('Sistema aggiornato')).toBeTruthy();
});

test('Aggiorna Sistema mostra quanti kickoff calendario sono stati corretti', async () => {
  mockedApi.syncUpcomingKickoffs.mockResolvedValueOnce({
    data: { corrected: 2 },
  } as any);

  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: 'Apri strumenti' }));
  fireEvent.click(within(screen.getByRole('menu', { name: /Strumenti/i })).getByRole('button', { name: /Aggiorna sistema/i }));

  await waitFor(() => expect(mockedApi.syncUpcomingKickoffs).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Calendario aggiornato: 2 kickoff corretti')).toBeTruthy();
});

test('la pagina iniziale apre Partite e mostra la navigazione primaria semplificata', async () => {
  render(<App />);

  expect(await screen.findByText('Predictions page')).toBeTruthy();

  const navigation = screen.getByLabelText('Navigazione principale');
  expect(within(navigation).queryByText('Dashboard')).toBeNull();
  expect(within(navigation).getByText('Partite')).toBeTruthy();
  expect(within(navigation).getByText('Giocate')).toBeTruthy();
  expect(within(navigation).getByText('Budget')).toBeTruthy();
  expect(within(navigation).getByText('Strumenti')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Apri strumenti' }));
  expect(within(screen.getByRole('menu', { name: /Strumenti/i })).getByRole('button', { name: /Aggiorna sistema/i })).toBeTruthy();
});

test('la vecchia route dashboard viene reindirizzata a Previsioni', async () => {
  window.history.pushState({}, '', '/dashboard');

  render(<App />);

  expect(await screen.findByText('Predictions page')).toBeTruthy();
  expect(window.location.pathname).toBe('/predictions');
  expect(screen.queryByText('Dashboard page')).toBeNull();
});

test('apre la pagina Glossario dalla navigazione principale', async () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: 'Apri strumenti' }));
  const toolsMenu = screen.getByRole('menu', { name: /Strumenti/i });
  fireEvent.click(within(toolsMenu).getByText('Glossario'));

  expect(await screen.findByRole('heading', { name: 'Glossario' })).toBeTruthy();
  expect(screen.getByRole('searchbox', { name: /Cerca nel glossario/i })).toBeTruthy();
  expect(window.location.pathname).toBe('/glossary');
});

test('il comando nell header apre il glossario rapido', async () => {
  render(<App />);

  const header = screen.getByRole('banner');
  fireEvent.click(within(header).getByRole('button', { name: /Apri glossario rapido/i }));

  expect(await screen.findByRole('dialog', { name: /Glossario rapido/i })).toBeTruthy();
});

test('il menu mobile Strumenti si comporta come dialog e restituisce il focus alla chiusura', async () => {
  render(<App />);

  const trigger = screen.getByRole('button', { name: /Apri strumenti mobile/i });
  fireEvent.click(trigger);

  const dialog = await screen.findByRole('dialog', { name: /Strumenti/i });
  expect(within(dialog).getByRole('link', { name: /Backtest/i })).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: /Chiudi strumenti/i }).matches(':focus')).toBe(true);

  fireEvent.keyDown(document, { key: 'Escape' });

  expect(screen.queryByRole('dialog', { name: /Altre sezioni/i })).toBeNull();
  expect(trigger.matches(':focus')).toBe(true);
});

test('apre la nuova pagina Giocate dalla navigazione primaria', async () => {
  render(<App />);

  const navigation = screen.getByLabelText('Navigazione principale');
  fireEvent.click(within(navigation).getByText('Giocate'));

  expect(await screen.findByText('Bets page')).toBeTruthy();
  expect(window.location.pathname).toBe('/bets');
});

test('apre Archivio prediction dal menu Strumenti', async () => {
  render(<App />);

  fireEvent.click(screen.getByRole('button', { name: 'Apri strumenti' }));
  fireEvent.click(within(screen.getByRole('menu', { name: /Strumenti/i })).getByText('Archivio prediction'));

  expect(await screen.findByText('Prediction archive page')).toBeTruthy();
  expect(window.location.pathname).toBe('/prediction-archive');
});
