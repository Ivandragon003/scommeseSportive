import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import BudgetManager from './BudgetManager';
import * as api from '../utils/api';

jest.mock('../utils/api');

const mockedApi = api as jest.Mocked<typeof api>;

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

    render(<BudgetManager activeUser="user1" />);

    await screen.findByText(/Crea bankroll iniziale/i);

    fireEvent.change(screen.getByPlaceholderText('1000'), { target: { value: '1200' } });
    fireEvent.click(screen.getByRole('button', { name: /Inizializza/i }));

    await waitFor(() => expect(mockedApi.initBudget).toHaveBeenCalledWith('user1', 1200));
  });

  test('mostra ultime scommesse e stati pending won lost', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({ data: betsPayload } as any);
    mockedApi.initBudget.mockResolvedValue({ data: budgetPayload } as any);

    render(<BudgetManager activeUser="user1" />);

    await screen.findByText(/Storico scommesse/i);

    expect(screen.getAllByText('ATTESA').length).toBeGreaterThan(0);
    expect(screen.getByText('VINTA')).toBeTruthy();
    expect(screen.getByText('PERSA')).toBeTruthy();
    expect(screen.getAllByText(/Inter vs Milan/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Juventus vs Roma/i)).toBeTruthy();
    expect(screen.getByText(/Napoli vs Lazio/i)).toBeTruthy();
  });

  test('distingue bankroll iniziale, disponibile, capitale esposto e interpreta il ROI', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({ data: betsPayload } as any);

    render(<BudgetManager activeUser="user1" />);

    await screen.findByText(/Storico scommesse/i);

    expect(screen.getByTestId('budget-initial').textContent).toContain('EUR 1000.00');
    expect(screen.getByTestId('budget-available').textContent).toContain('EUR 760.00');
    expect(screen.getByTestId('budget-exposure').textContent).toContain('EUR 20.00');
    expect(screen.getByTestId('budget-profit').textContent).toContain('EUR 3.50');
    expect(screen.getByTestId('budget-roi').textContent).toContain('9.20%');
    expect(screen.getByText(/ROI positivo, da leggere insieme a 2 scommesse concluse/i)).toBeTruthy();
    expect(screen.getByText('Vinte: 1')).toBeTruthy();
    expect(screen.getByText('Perse: 1')).toBeTruthy();
    expect(screen.getByText('Annullate: 0')).toBeTruthy();
    expect(screen.getByText('Pendenti: 1')).toBeTruthy();
  });

  test('al mount non fa doppio fetch e il filtro storico ricarica solo le scommesse', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({ data: betsPayload } as any);

    render(<BudgetManager activeUser="user1" />);

    await screen.findByText(/Storico scommesse/i);

    expect(mockedApi.getBudget).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBets).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Vinte/i }));

    await waitFor(() => expect(mockedApi.getBets).toHaveBeenCalledTimes(2));
    expect(mockedApi.getBudget).toHaveBeenCalledTimes(1);
  });

  test('traduce i mercati legacy e non espone i codici tecnici nello storico', async () => {
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({
      data: [{
        ...betsPayload[1],
        market_name: 'Draw No Bet - Casa',
        selection: 'dnb_home',
      }],
    } as any);

    render(<BudgetManager activeUser="user1" />);

    expect(await screen.findByText('Pareggio non conta (DNB) - Casa')).toBeTruthy();
    expect(screen.queryByText('Draw No Bet - Casa')).toBeNull();
    expect(screen.queryByText('dnb_home')).toBeNull();
  });
});
