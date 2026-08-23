import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PredictionArchivePage from './PredictionArchivePage';
import * as api from '../../utils/api';

jest.mock('../../utils/api');

const mockedApi = api as jest.Mocked<typeof api>;

const archiveRows = [
  {
    prediction_id: 'pred_pending_played',
    match_id: 'match-101',
    home_team_name: 'Bologna',
    away_team_name: 'Lazio',
    competition: 'Serie A',
    match_date: '2026-08-23T18:45:00.000Z',
    market: 'Draw No Bet',
    selection: 'Ospite',
    raw_probability: 0.51,
    calibrated_probability: 0.55,
    odds_at_prediction: 2.1,
    source: 'odds_api',
    ev: 0.155,
    ev_reason: 'Quota superiore alla probabilità implicita.',
    kelly: 0.04,
    confidence_computed: 'MEDIUM',
    sample_size_at_time: 240,
    created_at: '2026-08-23T10:00:00.000Z',
    result: 'pending',
    settled_at: null,
    was_played: 1,
    bet_id: 'bet-101',
    bet_status: 'PENDING',
    bet_stake: 20,
    bet_odds: 2.05,
    bet_placed_at: '2026-08-23T10:04:00.000Z',
  },
  {
    prediction_id: 'pred_unplayed',
    match_id: 'match-102',
    market: 'Over/Under',
    selection: 'Over 2.5',
    raw_probability: 0.58,
    calibrated_probability: 0.57,
    odds_at_prediction: null,
    ev: 0.094,
    ev_reason: 'Non promossa a giocata.',
    kelly: 0.02,
    confidence_computed: 'LOW',
    sample_size_at_time: 180,
    created_at: '2026-08-23T09:00:00.000Z',
    result: 'pending',
    settled_at: null,
    was_played: 0,
    bet_id: null,
    bet_status: null,
    bet_stake: null,
    bet_odds: null,
    bet_placed_at: null,
  },
  { prediction_id: 'pred_win', match_id: 'match-103', market: '1X2', selection: 'Casa', calibrated_probability: 0.62, odds_at_prediction: 1.8, ev: 0.116, confidence_computed: 'HIGH', created_at: '2026-08-22T09:00:00.000Z', result: 'win', was_played: 1, bet_id: 'bet-103' },
  { prediction_id: 'pred_loss', match_id: 'match-104', market: 'BTTS', selection: 'Sì', calibrated_probability: 0.54, odds_at_prediction: 2, ev: 0.08, confidence_computed: 'MEDIUM', created_at: '2026-08-21T09:00:00.000Z', result: 'loss', was_played: 0, bet_id: null },
  { prediction_id: 'pred_void', match_id: 'match-105', market: 'Under/Over', selection: 'Under 3.5', calibrated_probability: 0.66, odds_at_prediction: 1.62, ev: 0.069, confidence_computed: 'HIGH', created_at: '2026-08-20T09:00:00.000Z', result: 'void', was_played: 1, bet_id: 'bet-105' },
];

describe('PredictionArchivePage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedApi.getPredictionArchive.mockResolvedValue({ success: true, data: archiveRows } as any);
  });

  test('carica e mostra l archivio prediction', async () => {
    render(<PredictionArchivePage />);

    expect(await screen.findByRole('heading', { name: 'Archivio prediction' })).toBeTruthy();
    expect(await screen.findByText('Bologna – Lazio')).toBeTruthy();
    expect(screen.getByText(/Serie A/)).toBeTruthy();
    expect(screen.queryByText('Match #match-101')).toBeNull();
    expect(screen.getByText('Draw No Bet')).toBeTruthy();
    expect(mockedApi.getPredictionArchive).toHaveBeenCalledWith({ limit: 200 });
  });

  test('mostra match id solo nei dettagli espandibili', async () => {
    render(<PredictionArchivePage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Apri dettagli prediction pred_pending_played' }));

    expect(screen.getByText('Match ID')).toBeTruthy();
    expect(screen.getByText('match-101')).toBeTruthy();
  });

  test('mostra quota prediction e quota giocata senza inventare valori mancanti', async () => {
    render(<PredictionArchivePage />);

    expect(await screen.findByText('2.10')).toBeTruthy();
    expect(screen.getAllByText('Quota prediction').length).toBeGreaterThan(0);
    expect(screen.getByText('Giocata: 2.05')).toBeTruthy();
    expect(screen.getAllByText('Non disponibile').length).toBeGreaterThan(0);
  });

  test('mostra Low Medium High dalla confidence registrata', async () => {
    render(<PredictionArchivePage />);

    expect((await screen.findAllByText('Low')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Medium').length).toBeGreaterThan(0);
    expect(screen.getAllByText('High').length).toBeGreaterThan(0);
  });

  test('il filtro non giocate interroga il backend senza mostrare bet operative', async () => {
    mockedApi.getPredictionArchive
      .mockResolvedValueOnce({ success: true, data: archiveRows } as any)
      .mockResolvedValueOnce({ success: true, data: [archiveRows[1]] } as any);
    render(<PredictionArchivePage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Non giocate' }));

    await waitFor(() => expect(mockedApi.getPredictionArchive).toHaveBeenLastCalledWith({ status: 'unplayed', limit: 200 }));
    expect(await screen.findByText('Match #match-102')).toBeTruthy();
    expect(screen.queryByText('Match #match-101')).toBeNull();
  });

  test('distingue chiaramente prediction giocate e non giocate', async () => {
    render(<PredictionArchivePage />);

    expect((await screen.findAllByText('Giocata')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Non giocata').length).toBeGreaterThan(0);
  });

  test('mostra gli esiti win loss e void con etichette leggibili', async () => {
    render(<PredictionArchivePage />);

    expect((await screen.findAllByText('Vinta')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Persa').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Rimborsata').length).toBeGreaterThan(0);
  });

  test('mostra uno stato vuoto quando non esistono prediction', async () => {
    mockedApi.getPredictionArchive.mockResolvedValue({ success: true, data: [] } as any);
    render(<PredictionArchivePage />);

    expect(await screen.findByRole('status', { name: 'Archivio prediction vuoto' })).toBeTruthy();
    expect(screen.getByText('Nessuna prediction trovata')).toBeTruthy();
  });

  test('mostra loading ed errore con possibilità di riprovare', async () => {
    let rejectRequest: ((reason?: unknown) => void) | undefined;
    mockedApi.getPredictionArchive.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRequest = reject; }) as any);
    render(<PredictionArchivePage />);

    expect(screen.getByLabelText('Caricamento archivio prediction')).toBeTruthy();
    rejectRequest?.(new Error('Archivio non disponibile'));

    expect((await screen.findByRole('alert')).textContent).toContain('Archivio non disponibile');
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy();
  });
});
