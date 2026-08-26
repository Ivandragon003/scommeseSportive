import {
  archiveMatchTitle,
  classificationBadge,
  opportunityLabel,
  opportunityOdds,
} from './predictionArchivePresentation';

describe('prediction archive presentation', () => {
  test('mostra soltanto quote reali e valide', () => {
    expect(opportunityOdds({
      decision_id: 'real', match_id: 'm1', market_name: '1X2', selection: 'homeWin',
      classification: 'HIGH', archive_type: 'operative', display_odds: 2.1, bookmaker_name: 'Pinnacle', source: 'odds_api', result: 'pending',
    })).toBe(2.1);

    expect(opportunityOdds({
      decision_id: 'synthetic', match_id: 'm1', market_name: '1X2', selection: 'homeWin',
      classification: 'HIGH', archive_type: 'simulated', display_odds: 4.5, bookmaker_name: 'Pinnacle',
      source: 'odds_api_plus_model_completion', result: 'pending',
    })).toBeNull();

    expect(opportunityOdds({
      decision_id: 'unknown-bookmaker', match_id: 'm1', market_name: '1X2', selection: 'homeWin',
      classification: 'HIGH', archive_type: 'simulated', display_odds: 2.2, source: 'odds_api', result: 'pending',
    })).toBeNull();
  });

  test('classifica sempre le quattro categorie dell archivio utente', () => {
    expect(classificationBadge('HIGH')).toEqual({ label: 'High', tone: 'high' });
    expect(classificationBadge('MEDIUM')).toEqual({ label: 'Medium', tone: 'medium' });
    expect(classificationBadge('LOW')).toEqual({ label: 'Low', tone: 'low' });
    expect(classificationBadge('SPECULATIVE')).toEqual({ label: 'Speculativa', tone: 'speculative' });
  });

  test('traduce le selezioni interne in giocate terra terra', () => {
    expect(opportunityLabel('1X2', 'homeWin', 'Napoli', 'Roma')).toBe('Vittoria Napoli');
    expect(opportunityLabel('Over/Under', 'over2_5', 'Napoli', 'Roma')).toBe('Più di 2,5 gol');
    expect(opportunityLabel('Goal/Goal', 'btts', 'Napoli', 'Roma')).toBe('Entrambe le squadre segnano');
    expect(opportunityLabel('Risultato esatto', 'exact_2-1', 'Napoli', 'Roma')).toBe('Risultato esatto 2–1');
  });

  test('non espone identificativi tecnici nei fallback utente', () => {
    expect(archiveMatchTitle({
      decision_id: 'decision-1', match_id: 'understat_31562', market_name: 'Tiri giocatore',
      selection: 'player_understat_player_6521_shots_over_1_5', classification: 'LOW',
      archive_type: 'simulated', result: 'void',
    })).toBe('Partita archiviata');
    expect(opportunityLabel(
      'Tiri giocatore',
      'player_understat_player_6521_shots_over_1_5',
    )).toBe('Giocatore: più di 1,5 tiri');
  });
});
