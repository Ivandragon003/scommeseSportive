import { fireEvent, render, screen } from '@testing-library/react';
import BetsManager from './BetsManager';
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
    our_probability: 0.57,
    profit: null,
    status: 'PENDING',
    placed_at: '2026-04-22T10:00:00.000Z',
    source: 'manual',
  },
  {
    bet_id: 'bet_won',
    home_team_name: 'Juventus',
    away_team_name: 'Roma',
    competition: 'Serie A',
    market_name: 'Draw No Bet - Casa',
    selection: 'dnb_home',
    odds: 1.9,
    stake: 15,
    our_probability: 0.57,
    profit: 13.5,
    status: 'WON',
    placed_at: '2026-04-21T18:00:00.000Z',
    source: 'automation',
  },
];

describe('BetsManager', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedApi.getBudget.mockResolvedValue({ data: budgetPayload } as any);
    mockedApi.getBets.mockResolvedValue({ data: betsPayload } as any);
  });

  test('mostra giocate aperte e storico con stati leggibili', async () => {
    render(<BetsManager activeUser="user1" />);

    expect((await screen.findAllByText('IN ATTESA')).length).toBeGreaterThan(0);
    expect(screen.getByText('VINTA')).toBeTruthy();
    expect(screen.getAllByText(/Inter.*Milan/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Juventus.*Roma/i)).toBeTruthy();
  });

  test('traduce i mercati legacy e non espone i codici tecnici', async () => {
    render(<BetsManager activeUser="user1" />);

    fireEvent.click(await screen.findByRole('button', { name: /Apri dettaglio Juventus Roma/i }));
    expect((await screen.findAllByText(/Pareggio non conta \(DNB\)/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Draw No Bet - Casa')).toBeNull();
    expect(screen.queryByText('dnb_home')).toBeNull();
  });

  test('applica i filtri istantaneamente senza ricaricare o oscurare la pagina', async () => {
    render(<BetsManager activeUser="user1" />);

    await screen.findByRole('button', { name: 'Vinte' });
    expect(mockedApi.getBudget).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBets).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Vinte' }));

    expect(await screen.findByText(/Juventus.*Roma/i)).toBeTruthy();
    expect(screen.queryByText(/Inter.*Milan/i)).toBeNull();
    expect(screen.queryByLabelText(/Caricamento giocate/i)).toBeNull();
    expect(mockedApi.getBets).toHaveBeenCalledTimes(1);
    expect(mockedApi.getBudget).toHaveBeenCalledTimes(1);
  });

  test('mantiene lo storico consultabile quando la vista iniziale mostra le giocate aperte', async () => {
    render(<BetsManager activeUser="user1" />);

    expect((await screen.findByRole('button', { name: 'In attesa' })).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('region', { name: /Giocate in attesa/i })).toBeTruthy();
    expect(screen.getByRole('region', { name: /Storico giocate/i })).toBeTruthy();
    expect(screen.getByText(/Juventus.*Roma/i)).toBeTruthy();
  });

  test('offre le viste mobile aperte chiuse e tutte senza richieste aggiuntive', async () => {
    render(<BetsManager activeUser="user1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Chiuse' }));

    expect(screen.queryByRole('region', { name: /Giocate aperte/i })).toBeNull();
    expect(screen.getByRole('region', { name: /Storico giocate/i })).toBeTruthy();
    expect(mockedApi.getBets).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /^Tutte$/ }));
    expect(screen.getByRole('region', { name: /Giocate in attesa/i })).toBeTruthy();
  });

  test('filtra lo storico per esito e competizione', async () => {
    mockedApi.getBets.mockResolvedValue({
      data: [
        ...betsPayload,
        {
          ...betsPayload[1],
          bet_id: 'bet_lost_premier',
          home_team_name: 'Arsenal',
          away_team_name: 'Chelsea',
          competition: 'Premier League',
          status: 'LOST',
          profit: -15,
        },
      ],
    } as any);

    render(<BetsManager activeUser="user1" />);

    fireEvent.change(await screen.findByLabelText('Filtra storico per esito'), { target: { value: 'LOST' } });
    expect(screen.getByText(/Arsenal.*Chelsea/i)).toBeTruthy();
    expect(screen.queryByText(/Juventus.*Roma/i)).toBeNull();

    fireEvent.change(screen.getByLabelText('Filtra storico per competizione'), { target: { value: 'Serie A' } });
    expect(screen.queryByText(/Arsenal.*Chelsea/i)).toBeNull();
  });

  test('espande una giocata mostrando le informazioni operative del mockup', async () => {
    render(<BetsManager activeUser="user1" />);

    fireEvent.click(await screen.findByRole('button', { name: /Apri dettaglio Inter Milan/i }));

    expect(screen.getByText('Quota alla giocata')).toBeTruthy();
    expect(screen.getByText('P. nostra')).toBeTruthy();
    expect(screen.getByText('57%')).toBeTruthy();
    expect(screen.getByText('Giocata il')).toBeTruthy();
    expect(screen.getByText('Fonte quota')).toBeTruthy();
  });

  test('filtra le giocate per un intervallo di date e permette di azzerarlo', async () => {
    render(<BetsManager activeUser="user1" />);

    fireEvent.click(await screen.findByRole('button', { name: /Intervallo date/i }));
    fireEvent.change(screen.getByLabelText(/Data iniziale/i), { target: { value: '2026-04-22' } });
    fireEvent.change(screen.getByLabelText(/Data finale/i), { target: { value: '2026-04-22' } });
    fireEvent.click(screen.getByRole('button', { name: /Applica intervallo/i }));

    expect(screen.getAllByText(/Inter.*Milan/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Juventus.*Roma/i)).toBeNull();
    expect(screen.getByRole('button', { name: /22\/04\/2026/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /22\/04\/2026/i }));
    fireEvent.click(screen.getByRole('button', { name: /Azzera intervallo/i }));

    expect(await screen.findByText(/Juventus.*Roma/i)).toBeTruthy();
  });
});
