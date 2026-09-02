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

    expect(await screen.findByRole('heading', { name: 'Archivio' })).toBeTruthy();
    expect(await screen.findByRole('columnheader', { name: 'Classificazione' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Tipo' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Probabilità' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'EV' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Stato prediction' })).toBeNull();
    expect(mockedApi.getBetOpportunityArchive).toHaveBeenCalledWith({ category: 'played', limit: 200 });
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

  test('mantiene nei dettagli solo informazioni comprensibili della giocata', async () => {
    render(<PredictionArchivePage />);

    expect(screen.queryByText('Probabilità del modello')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /Apri dettagli Bologna – Lazio: Esito finale \(1X2\) — Vittoria Bologna/ }));

    expect(screen.queryByText('Probabilità del modello')).toBeNull();
    expect(screen.queryByText('EV tecnico')).toBeNull();
    expect(screen.getByText('Stake effettivo')).toBeTruthy();
    expect(screen.getByText('20.00')).toBeTruthy();
    expect(screen.queryByText('ID giocata')).toBeNull();
    expect(screen.queryByText('Match ID')).toBeNull();
    expect(screen.queryByText('decision-high')).toBeNull();
  });

  test('distingue i pulsanti dettagli quando la stessa partita ha piu opportunita', async () => {
    mockedApi.getBetOpportunityArchive.mockResolvedValueOnce({
      success: true,
      data: [
        archiveRows[0],
        {
          ...archiveRows[1],
          decision_id: 'decision-second-market',
          match_id: 'match-101',
          home_team_name: 'Bologna',
          away_team_name: 'Lazio',
        },
      ],
    } as any);

    render(<PredictionArchivePage />);

    expect(await screen.findByRole('button', {
      name: /Apri dettagli Bologna – Lazio: Esito finale \(1X2\) — Vittoria Bologna/,
    })).toBeTruthy();
    expect(screen.getByRole('button', {
      name: /Apri dettagli Bologna – Lazio: Over\/Under — Più di 2,5 gol/,
    })).toBeTruthy();
  });

  test('i filtri data e classificazione multipla interrogano il backend', async () => {
    render(<PredictionArchivePage />);

    await screen.findByText('Bologna – Lazio');
    fireEvent.change(screen.getByLabelText('Da'), { target: { value: '2026-08-23' } });
    await waitFor(() => expect(mockedApi.getBetOpportunityArchive).toHaveBeenLastCalledWith({ category: 'played', from: '2026-08-23', limit: 200 }));

    fireEvent.change(screen.getByLabelText('A'), { target: { value: '2026-08-24' } });
    await waitFor(() => expect(mockedApi.getBetOpportunityArchive).toHaveBeenLastCalledWith({ category: 'played', from: '2026-08-23', to: '2026-08-24', limit: 200 }));

    fireEvent.click(screen.getByRole('button', { name: 'High' }));
    fireEvent.click(screen.getByRole('button', { name: 'Low' }));
    await waitFor(() => expect(mockedApi.getBetOpportunityArchive).toHaveBeenLastCalledWith({
      category: 'played', from: '2026-08-23', to: '2026-08-24', classifications: ['high', 'low'], limit: 200,
    }));
    expect(screen.getByText(/Non ci sono ancora giocate operative concluse nei filtri scelti/)).toBeTruthy();
    expect(screen.getByText(/risultati filtrati/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Azzera filtri/ }));
    await waitFor(() => expect(mockedApi.getBetOpportunityArchive).toHaveBeenLastCalledWith({ category: 'played', limit: 200 }));
  });

  test('mostra il saldo server-side delle sole giocate operative concluse', async () => {
    mockedApi.getBetOpportunityArchive.mockResolvedValueOnce({
      success: true,
      data: archiveRows,
      summary: {
        settledCount: 3, wonCount: 2, lostCount: 1, voidCount: 0,
        wonProfit: 31.5, lostProfit: 12, netProfit: 19.5,
      },
    } as any);

    render(<PredictionArchivePage />);

    expect(await screen.findByRole('region', { name: 'Riepilogo economico delle giocate concluse' })).toBeTruthy();
    expect(screen.getByText('3 concluse')).toBeTruthy();
    expect(screen.getByText('+31,50 €')).toBeTruthy();
    expect(screen.getByText('−12,00 €')).toBeTruthy();
    expect(screen.getByText('+19,50 €')).toBeTruthy();
    expect(screen.getByText(/esclusivamente il profitto delle giocate operative/i)).toBeTruthy();
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

  test('separa le categorie e mostra i match conclusi senza proposta', async () => {
    mockedApi.getBetOpportunityArchive.mockResolvedValueOnce({
      success: true,
      data: archiveRows,
      counts: { played: 1, unplayed: 3, noProposal: 2 },
    } as any).mockResolvedValueOnce({
      success: true,
      data: [{
        match_id: 'match-no-proposal', home_team_name: 'Como', away_team_name: 'Lecce', competition: 'Serie A',
        match_date: '2026-08-25T18:45:00.000Z', home_goals: 2, away_goals: 1, archive_type: 'no_proposal',
      }],
      counts: { played: 1, unplayed: 3, noProposal: 2 },
    } as any);
    render(<PredictionArchivePage />);

    await screen.findByText('Giocate');
    expect(screen.getByRole('tab', { name: /Giocate/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Non giocate/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Nessuna proposta/ }));

    expect(await screen.findByText('Como – Lecce')).toBeTruthy();
    expect(screen.getByText('2–1')).toBeTruthy();
    expect(screen.getByText('1 partita senza proposta')).toBeTruthy();
    expect(screen.getByText(/assenza di una proposta non indica un errore/i)).toBeTruthy();
    await waitFor(() => expect(mockedApi.getBetOpportunityArchive).toHaveBeenLastCalledWith({ category: 'no_proposal', limit: 200 }));
    expect((screen.getByRole('button', { name: 'High' }).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  });

  test('le tab seguono il pattern tastiera con frecce, Home ed End', async () => {
    render(<PredictionArchivePage />);
    const played = await screen.findByRole('tab', { name: /Giocate/ });
    const unplayed = screen.getByRole('tab', { name: /Non giocate/ });
    const noProposal = screen.getByRole('tab', { name: /Nessuna proposta/ });

    expect(played.tabIndex).toBe(0);
    expect(unplayed.tabIndex).toBe(-1);
    fireEvent.keyDown(played, { key: 'ArrowRight' });
    await waitFor(() => expect(unplayed.getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(unplayed);

    fireEvent.keyDown(unplayed, { key: 'End' });
    await waitFor(() => expect(noProposal.getAttribute('aria-selected')).toBe('true'));
    fireEvent.keyDown(noProposal, { key: 'Home' });
    await waitFor(() => expect(played.getAttribute('aria-selected')).toBe('true'));
    fireEvent.keyDown(played, { key: 'ArrowLeft' });
    await waitFor(() => expect(noProposal.getAttribute('aria-selected')).toBe('true'));
  });
});
