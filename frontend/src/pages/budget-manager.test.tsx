import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BudgetManager from './BudgetManager';
import * as api from '../utils/api';

jest.mock('../utils/api');

const mockedApi = api as jest.Mocked<typeof api>;

const renderBudget = () => render(<MemoryRouter><BudgetManager activeUser="user1" /></MemoryRouter>);

const budgetPayload = {
  total_budget: 1000,
  available_budget: 760,
  total_staked: 240,
  total_won: 330,
  total_lost: 110,
  roi: 9.2,
  win_rate: 57.1,
};

const betsPayload = [
  {
    bet_id: 'bet_pending',
    home_team_name: 'Inter',
    away_team_name: 'Milan',
    competition: 'Serie A',
    market_name: 'Totali Goal',
    selection: 'Over 2.5 Goal',
    odds: 2.1,
    stake: 20,
    profit: null,
    status: 'PENDING',
    placed_at: '2026-04-22T10:00:00.000Z',
  },
  {
    bet_id: 'bet_won',
    home_team_name: 'Juventus',
    away_team_name: 'Roma',
    competition: 'Serie A',
    market_name: '1X2',
    selection: '1',
    odds: 1.9,
    stake: 15,
    profit: 13.5,
    status: 'WON',
    placed_at: '2026-04-21T18:00:00.000Z',
  },
  {
    bet_id: 'bet_lost',
    home_team_name: 'Napoli',
    away_team_name: 'Lazio',
    competition: 'Serie A',
    market_name: 'Goal/No Goal',
    selection: 'No Goal',
    odds: 1.8,
    stake: 10,
    profit: -10,
    status: 'LOST',
    placed_at: '2026-04-20T18:00:00.000Z',
  },
];

describe('BudgetManager', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('inizializza il budget quando non esiste un bankroll', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: null } as any);
    mockedApi.getBets.mockResolvedValue({ data: [] } as any);
    mockedApi.initBudget.mockResolvedValue({ data: budgetPayload } as any);

    renderBudget();

    await screen.findByRole('heading', { name: /Crea il bankroll iniziale/i });

    fireEvent.change(screen.getByPlaceholderText('1000'), { target: { value: '1200' } });
    fireEvent.click(screen.getByRole('button', { name: /Inizializza/i }));

    await waitFor(() => expect(mockedApi.initBudget).toHaveBeenCalledWith('user1', 1200));
  });

  test('mantiene le giocate fuori dalla pagina Budget e offre un collegamento dedicato', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({ data: betsPayload } as any);
    mockedApi.initBudget.mockResolvedValue({ data: budgetPayload } as any);

    renderBudget();

    expect(await screen.findByRole('link', { name: /Vai alle giocate aperte/i })).toBeTruthy();
    expect(screen.queryByText(/Storico scommesse/i)).toBeNull();
    expect(screen.queryByText(/Inter vs Milan/i)).toBeNull();
  });

  test('distingue bankroll iniziale, disponibile, capitale esposto e interpreta il ROI', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({ data: betsPayload } as any);

    renderBudget();

    await screen.findByTestId('budget-available');

    expect(screen.getByTestId('budget-initial').textContent).toContain('EUR 1000.00');
    expect(screen.getByTestId('budget-available').textContent).toContain('EUR 760.00');
    expect(screen.getByTestId('budget-exposure').textContent).toContain('EUR 20.00');
    expect(screen.getByTestId('budget-profit').textContent).toContain('EUR 3.50');
    expect(screen.getByTestId('budget-roi').textContent).toContain('9.20%');
    expect(screen.getByText(/ROI positivo, da leggere insieme a 2 giocate concluse/i)).toBeTruthy();
  });

  test('al mount carica una sola volta budget e riepilogo giocate', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({ data: betsPayload } as any);

    renderBudget();

    await screen.findByTestId('budget-available');

    expect(mockedApi.getBudget).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBets).toHaveBeenCalledTimes(1);

    expect(mockedApi.getBudget).toHaveBeenCalledTimes(1);
    expect(mockedApi.syncSharedBets).not.toHaveBeenCalled();
  });

  test('non mostra una percentuale negativa quando il bankroll supera quello iniziale', async () => {
    mockedApi.getBudget.mockResolvedValue({
      data: { ...budgetPayload, available_budget: 1165.93 },
    } as any);
    mockedApi.getBets.mockResolvedValue({ data: betsPayload } as any);

    renderBudget();

    const progress = await screen.findByRole('progressbar', { name: /Budget utilizzato/i });
    expect(progress.getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByText('0.0%')).toBeTruthy();
  });

  test('mostra il grafico dell andamento del bankroll usando le giocate concluse', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({ data: betsPayload } as any);

    renderBudget();

    expect(await screen.findByRole('heading', { name: 'Andamento' })).toBeTruthy();
    const chart = screen.getByTestId('bankroll-trend-chart');
    expect(chart.getAttribute('aria-label')).toMatch(/da EUR 1000.00 a EUR 1003.50/i);
  });

  test('riproduce la gerarchia del mockup con tre indicatori principali', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({ data: betsPayload } as any);

    renderBudget();

    await screen.findByTestId('budget-available');
    expect(screen.getAllByTestId(/^budget-(available|exposure|profit)$/)).toHaveLength(3);
    expect(screen.getByText('Bankroll disponibile')).toBeTruthy();
    expect(screen.getByText('Capitale impegnato')).toBeTruthy();
    expect(screen.getByText('Risultato netto')).toBeTruthy();
  });

  test('permette di cambiare l intervallo temporale del grafico', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({
      data: [
        ...betsPayload,
        {
          ...betsPayload[1],
          bet_id: 'bet_old_won',
          profit: 100,
          placed_at: '2025-01-01T18:00:00.000Z',
        },
      ],
    } as any);

    renderBudget();

    const chart = await screen.findByTestId('bankroll-trend-chart');
    expect(chart.getAttribute('aria-label')).toMatch(/EUR 1103.50.*2 movimenti/i);
    expect(screen.getByRole('button', { name: '30G' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Tutto' }));
    expect(chart.getAttribute('aria-label')).toMatch(/EUR 1103.50.*3 movimenti/i);
    expect(screen.getByRole('button', { name: 'Tutto' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('mostra gestione e manutenzione del bankroll come nel mockup', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({ data: betsPayload } as any);

    renderBudget();

    expect(await screen.findByRole('heading', { name: 'Gestione bankroll' })).toBeTruthy();
    expect(screen.getByLabelText('Budget iniziale')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aggiorna budget' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Manutenzione budget' })).toBeTruthy();
  });
});
