import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BetsManager from '../../pages/BetsManager';
import BudgetManager from '../../pages/BudgetManager';
import PredictionArchivePage from '../prediction-archive/PredictionArchivePage';
import { getPaperBets, PaperBet, PaperBetsData, PaperMetrics } from '../../utils/paperBetsApi';
import { getAppWallets } from '../../utils/walletApi';
import * as api from '../../utils/api';
import { selectOption } from '../../testSelect';

jest.mock('../../utils/paperBetsApi');
jest.mock('../../utils/walletApi');
jest.mock('../../utils/api');
jest.mock('recharts', () => ({ ...jest.requireActual('recharts'), ResponsiveContainer: ({ children }: any) => <div>{children}</div> }));
const readPaper = getPaperBets as jest.MockedFunction<typeof getPaperBets>;
export const paperBet = (index: number): PaperBet => ({
  id: `paper:${index}`, accountingMode: 'PAPER_FIXED_UNIT', family: index % 2 === 0 ? 'A' : 'C',
  portfolioId: index % 2 === 0 ? 'shadow_A' : 'shadow_C', matchId: 'same-match', modelVersion: 'frozen',
  market: 'totals', selection: index % 2 === 0 ? 'over25' : 'under25', selectionKey: `selection:${index}`,
  odds: 2, stakeUnits: 1, returnUnits: index === 0 ? 2 : null, profitUnits: index === 0 ? 1 : null,
  status: index === 0 ? 'WON' : 'PENDING', placedAt: '2026-11-06T12:00:00Z', createdAt: '2026-11-06T12:00:00Z',
  settledAt: index === 0 ? '2026-11-06T14:00:00Z' : null, matchLabel: 'Inter – Napoli', league: 'Serie A',
  bookmaker: 'Bookmaker fixture', source: 'fixture_real_quote',
});
const metrics = (total: number): PaperMetrics => ({ totalCount: total, betCount: total, openCount: total - 1, settledCount: 1,
  totalStakeUnits: total, settledStakeUnits: 1, returnUnits: 2, profitUnits: 1, roiPercent: 100, winRatePercent: 100,
  wonCount: 1, lostCount: 0, voidCount: 0 });
export const paperPayload = (total = 5): PaperBetsData => ({ ...metrics(total), accountingMode: 'PAPER_FIXED_UNIT', fixedStakeUnits: 1,
  bets: Array.from({ length: total }, (_, index) => paperBet(index)), history: [{ at: '2026-11-06T14:00:00Z', betId: 'paper:0', profitUnits: 1 }],
  portfolios: [
    { ...metrics(Math.ceil(total / 2)), family: 'A', history: [{ at: '2026-11-06T14:00:00Z', betId: 'paper:0', profitUnits: 1 }] },
    { ...metrics(Math.floor(total / 2)), family: 'C', openCount: Math.floor(total / 2), settledCount: 0, settledStakeUnits: 0, returnUnits: 0, profitUnits: 0, roiPercent: null, winRatePercent: null, wonCount: 0, history: [] },
  ],
});

beforeEach(() => { jest.resetAllMocks(); readPaper.mockResolvedValue(paperPayload()); });

test('Giocate mostra tutte le selezioni della stessa partita senza usare o sommare lo storico', async () => {
  render(<MemoryRouter><BetsManager activeUser="user1" /></MemoryRouter>);
  expect(await screen.findAllByRole('article')).toHaveLength(5);
  expect(screen.getByText('5 giocate nei filtri · Pagina 1 di 1')).toBeTruthy();
  selectOption(screen.getByLabelText('Modello'), 'A');
  expect(screen.getAllByRole('article')).toHaveLength(3);
  expect(getAppWallets).not.toHaveBeenCalled();
  expect(api.getBets).not.toHaveBeenCalled();
  expect(api.placeBet).not.toHaveBeenCalled();
  expect(api.initBudget).not.toHaveBeenCalled();
  expect(screen.queryByText(/EUR|€|Disponibile|Capitale iniziale/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Storico precedente' }).getAttribute('aria-expanded')).toBe('false');
});

test('125 registrazioni restano raggiungibili con pagine complete, totali e ROI invariati', async () => {
  readPaper.mockResolvedValue(paperPayload(125));
  render(<MemoryRouter><BetsManager activeUser="user1" /></MemoryRouter>);
  expect(await screen.findAllByRole('article')).toHaveLength(50);
  expect(screen.getByText('125 giocate nei filtri · Pagina 1 di 3')).toBeTruthy();
  const a = screen.getByRole('region', { name: 'Risultati paper modello A' });
  expect(within(a).getByText('63')).toBeTruthy();
  expect(within(a).getAllByText('100%')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Pagina successiva' }));
  expect(screen.getAllByRole('article')).toHaveLength(50);
  fireEvent.click(screen.getByRole('button', { name: 'Pagina successiva' }));
  expect(screen.getAllByRole('article')).toHaveLength(25);
  expect(screen.getByText('125 giocate nei filtri · Pagina 3 di 3')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Pagina successiva' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(a).getByText('63')).toBeTruthy();
});

test('Budget usa solo unità, ritorni e profitto realizzati senza gate di saldo', async () => {
  render(<MemoryRouter><BudgetManager activeUser="user1" /></MemoryRouter>);
  const a = await screen.findByRole('region', { name: 'Risultati paper modello A' });
  expect(within(a).getByText('2 u')).toBeTruthy();
  expect(within(a).getAllByText('1 u').length).toBeGreaterThan(0);
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(screen.queryByText(/EUR|€|Bankroll disponibile|Capitale iniziale|Impegnato/)).toBeNull();
  expect(api.getBudget).not.toHaveBeenCalled();
  expect(api.initBudget).not.toHaveBeenCalled();
  expect(getAppWallets).not.toHaveBeenCalled();
});

test('Archivio filtra le liquidate e conserva le aperte senza deduplicare per partita', async () => {
  render(<MemoryRouter><PredictionArchivePage /></MemoryRouter>);
  expect(await screen.findAllByRole('article')).toHaveLength(1);
  expect(screen.getByText('Vinta')).toBeTruthy();
  selectOption(screen.getByLabelText('Stato'), 'all');
  expect(screen.getAllByRole('article')).toHaveLength(5);
});

test('schema non disponibile mostra un errore e non finge un registro vuoto o un saldo', async () => {
  readPaper.mockRejectedValue(new Error('Registro paper non disponibile: lo schema del database deve essere aggiornato.'));
  render(<MemoryRouter><BudgetManager activeUser="user1" /></MemoryRouter>);
  expect((await screen.findByRole('alert')).textContent).toContain('schema del database');
  expect(screen.queryByRole('region', { name: 'Risultati paper modello A' })).toBeNull();
  expect(api.initBudget).not.toHaveBeenCalled();
});
