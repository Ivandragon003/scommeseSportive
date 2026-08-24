import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PredictionArchivePage from './PredictionArchivePage';
import * as api from '../../utils/api';

jest.mock('../../utils/api');

const mockedApi = api as jest.Mocked<typeof api>;

const archiveRows = [
  {
    decision_id: 'decision-high', match_id: 'match-101', home_team_name: 'Bologna', away_team_name: 'Lazio',
    competition: 'Serie A', match_date: '2026-08-23T18:45:00.000Z', market_name: '1X2', selection: 'homeWin',
    classification: 'HIGH', archive_type: 'operative', display_odds: 2.05, bookmaker_odds: 2.1, bookmaker_name: 'Pinnacle',
    raw_probability: 0.61, calibrated_probability: 0.59, ev: 0.15, source: 'odds_api',
    theoretical_stake_percent: 2, theoretical_stake_amount: 20, ranking_position: 1, operational_slot: 1,
    decision_status: 'placed', exclusion_reason: null, bet_id: 'bet-101', bet_stake: 20, result: 'pending',
    created_at: '2026-08-23T10:00:00.000Z', settled_at: null,
  },
  {
    decision_id: 'decision-medium', match_id: 'match-102', home_team_name: 'Torino', away_team_name: 'Milan',
    competition: 'Serie A', match_date: '2026-08-23T20:45:00.000Z', market_name: 'Over/Under', selection: 'over2_5',
    classification: 'MEDIUM', archive_type: 'simulated', display_odds: 2.1, bookmaker_odds: 2.1, bookmaker_name: 'Pinnacle',
    raw_probability: 0.56, calibrated_probability: 0.55, ev: 0.12, source: 'odds_api',
    theoretical_stake_percent: 1.5, theoretical_stake_amount: 15, ranking_position: 4, operational_slot: null,
    decision_status: 'saved_only', exclusion_reason: 'per_match_limit_reached', bet_id: null, result: 'loss',
    created_at: '2026-08-23T09:00:00.000Z', settled_at: '2026-08-23T23:00:00.000Z',
  },
  {
    decision_id: 'decision-low', match_id: 'match-103', market_name: 'Goal/Goal', selection: 'btts',
    classification: 'LOW', archive_type: 'simulated', display_odds: 1.9, bookmaker_odds: 1.9, bookmaker_name: 'Betfair',
    ranking_position: 5, decision_status: 'saved_only', exclusion_reason: 'low_confidence_saved_only',
    result: 'win', created_at: '2026-08-22T09:00:00.000Z',
  },
  {
    decision_id: 'decision-speculative', match_id: 'match-104', market_name: 'Risultato esatto', selection: 'exact_2-1',
    classification: 'SPECULATIVE', archive_type: 'simulated', display_odds: 7.5, bookmaker_odds: 7.5, bookmaker_name: '888sport',
    ranking_position: 6, decision_status: 'saved_only', exclusion_reason: 'speculative_saved_only',
    result: 'void', created_at: '2026-08-21T09:00:00.000Z',
  },
];

describe('PredictionArchivePage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedApi.getBetOpportunityArchive.mockResolvedValue({ success: true, data: archiveRows } as any);
  });

  test('mostra soltanto le colonne semplici dell archivio opportunita', async () => {
    render(<PredictionArchivePage />);

    expect(await screen.findByRole('heading', { name: 'Archivio giocate' })).toBeTruthy();
    expect(await screen.findByRole('columnheader', { name: 'Classificazione' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Tipo' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Probabilità' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'EV' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Stato prediction' })).toBeNull();
    expect(mockedApi.getBetOpportunityArchive).toHaveBeenCalledWith({ limit: 200 });
  });

  test('traduce mercato e giocata effettiva senza mostrare codici interni', async () => {
    render(<PredictionArchivePage />);

    expect(await screen.findByText('Bologna – Lazio')).toBeTruthy();
    expect(screen.getByText('Vittoria Bologna')).toBeTruthy();
    expect(screen.getByText('Più di 2,5 gol')).toBeTruthy();
    expect(screen.getByText('Entrambe le squadre segnano')).toBeTruthy();
    expect(screen.getByText('Risultato esatto 2–1')).toBeTruthy();
    expect(screen.queryByText('homeWin')).toBeNull();
    expect(screen.queryByText('exact_2-1')).toBeNull();
  });

  test('mostra quota reale classificazione tipo ed unico risultato', async () => {
    render(<PredictionArchivePage />);

    expect((await screen.findAllByText('2.05')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pinnacle').length).toBeGreaterThan(0);
    expect(screen.getAllByText('High').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Medium').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Low').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Speculativa').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Operativa').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Simulata').length).toBeGreaterThan(0);
    expect(screen.getAllByText('In attesa').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Vinta').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Persa').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Rimborsata').length).toBeGreaterThan(0);
    expect(screen.queryByText('Non classificata')).toBeNull();
  });

  test('mantiene probabilita EV e stake soltanto nei dettagli', async () => {
    render(<PredictionArchivePage />);

    expect(screen.queryByText('Probabilità del modello')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Apri dettagli giocata decision-high' }));

    expect(screen.getByText('Probabilità del modello')).toBeTruthy();
    expect(screen.getByText('EV tecnico')).toBeTruthy();
    expect(screen.getByText('Stake effettivo')).toBeTruthy();
    expect(screen.getByText('20.00')).toBeTruthy();
  });

  test('i filtri interrogano il backend per tipo classificazione ed esito', async () => {
    render(<PredictionArchivePage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Simulate' }));
    await waitFor(() => expect(mockedApi.getBetOpportunityArchive).toHaveBeenLastCalledWith({ type: 'simulated', limit: 200 }));

    fireEvent.click(screen.getByRole('button', { name: 'Speculative' }));
    await waitFor(() => expect(mockedApi.getBetOpportunityArchive).toHaveBeenLastCalledWith({ classification: 'speculative', limit: 200 }));

    fireEvent.click(screen.getByRole('button', { name: 'Perse' }));
    await waitFor(() => expect(mockedApi.getBetOpportunityArchive).toHaveBeenLastCalledWith({ result: 'loss', limit: 200 }));
  });

  test('mostra stato vuoto ed errore con possibilita di riprovare', async () => {
    mockedApi.getBetOpportunityArchive.mockResolvedValueOnce({ success: true, data: [] } as any);
    const { unmount } = render(<PredictionArchivePage />);
    expect(await screen.findByRole('status', { name: 'Archivio giocate vuoto' })).toBeTruthy();
    unmount();

    mockedApi.getBetOpportunityArchive.mockRejectedValueOnce(new Error('Archivio non disponibile'));
    render(<PredictionArchivePage />);
    expect((await screen.findByRole('alert')).textContent).toContain('Archivio non disponibile');
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy();
  });
});
