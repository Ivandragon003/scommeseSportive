import React from 'react';
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
});

test('header principale mostra solo brand e aggiorna sistema, senza dettagli tecnici sempre visibili', async () => {
  render(<App />);

  const header = screen.getByRole('banner');
  expect(within(header).getByText('FootPredictor')).toBeTruthy();
  expect(within(header).getByText(/Decisioni rapide/i)).toBeTruthy();
  expect(within(header).getByRole('button', { name: /Aggiorna sistema/i })).toBeTruthy();

  expect(screen.queryByText(/Sync Notturna/i)).toBeNull();
  expect(within(header).queryByText(/Workspace/i)).toBeNull();
  expect(within(header).queryByText(/user1/i)).toBeNull();
  expect(within(header).queryByText(/Sistema OK/i)).toBeNull();
  expect(within(header).queryByText(/Sync OK/i)).toBeNull();

  await waitFor(() => expect(mockedApi.getScraperStatus).toHaveBeenCalledTimes(1));

  fireEvent.click(within(header).getByRole('button', { name: /Aggiorna sistema/i }));

  await waitFor(() => expect(mockedApi.getScraperStatus).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('Sistema aggiornato')).toBeTruthy();
});

test('la pagina iniziale apre Previsioni e la Dashboard non compare nella navigazione', async () => {
  render(<App />);

  expect(await screen.findByText('Predictions page')).toBeTruthy();

  const sidebar = screen.getByLabelText('Navigazione principale');
  expect(within(sidebar).queryByText('Dashboard')).toBeNull();
  expect(within(sidebar).getByText('Previsioni')).toBeTruthy();
  expect(within(sidebar).getByText('Budget')).toBeTruthy();
  expect(within(sidebar).getByText('Backtest')).toBeTruthy();
  expect(within(sidebar).getByText('Dati')).toBeTruthy();
  expect(within(sidebar).getByText('Dati & Provider')).toBeTruthy();

  const header = screen.getByRole('banner');
  expect(within(header).getByRole('button', { name: /Aggiorna sistema/i })).toBeTruthy();
});

test('la vecchia route dashboard viene reindirizzata a Previsioni', async () => {
  window.history.pushState({}, '', '/dashboard');

  render(<App />);

  expect(await screen.findByText('Predictions page')).toBeTruthy();
  expect(window.location.pathname).toBe('/predictions');
  expect(screen.queryByText('Dashboard page')).toBeNull();
});
