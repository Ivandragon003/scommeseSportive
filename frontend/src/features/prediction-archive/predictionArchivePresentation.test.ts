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

  test.each([
    ['homeWin', '1 — Torino vincente'],
    ['draw', 'X — Pareggio'],
    ['awayWin', '2 — Roma vincente'],
    ['double_chance_1x', '1X — Torino o pareggio'],
    ['double_chance_x2', 'X2 — Roma o pareggio'],
    ['double_chance_12', '12 — Una delle due squadre vince'],
    ['dnb_home', 'DNB 1 — Torino; pareggio rimborsato'],
    ['dnb_away', 'DNB 2 — Roma; pareggio rimborsato'],
    ['btts', 'Goal (GG) — Entrambe le squadre segnano'],
    ['bttsNo', 'No Goal (NG) — Almeno una squadra non segna'],
  ])('identifies the exact selection %s, including its outcome sign', (selection, label) => {
    expect(opportunityLabel('Mercato', selection, 'Torino', 'Roma')).toBe(label);
  });

  test.each([
    ['over25', 'Over 2.5 gol'], ['over2_5', 'Over 2.5 gol'], ['over2.5', 'Over 2.5 gol'],
    ['under275', 'Under 2.75 gol'], ['over375', 'Over 3.75 gol'], ['under3', 'Under 3 gol'],
    ['team_home_over_15', 'Torino: Over 1.5 gol'],
    ['team_away_under_1.5', 'Roma: Under 1.5 gol'],
    ['shots_total_over_20.5', 'Tiri totali: Over 20.5'],
    ['cards_total_under_4_5', 'Punti cartellino: Under 4.5'],
    ['shotsOver205', 'Tiri totali: Over 20.5'],
    ['shotsHomeOver105', 'Tiri Torino: Over 10.5'],
    ['shotsAwayUnder95', 'Tiri Roma: Under 9.5'],
    ['shotsOTOver65', 'Tiri in porta totali: Over 6.5'],
    ['yellowOver35', 'Cartellini gialli: Over 3.5'],
    ['cardsTotalUnder45', 'Punti cartellino: Under 4.5'],
  ])('keeps the correct goal or statistic line for %s', (selection, label) => {
    expect(opportunityLabel('Mercato', selection, 'Torino', 'Roma')).toBe(label);
  });

  test('keeps exact scores distinct from other markets', () => {
    expect(opportunityLabel('Risultato esatto', 'exact_2-1', 'Napoli', 'Roma')).toBe('Risultato esatto 2–1');
  });

  test('uses the recorded handicap adjustment, never an ambiguous A/C alias', () => {
    const quote = { selection: 'ahcp_0.5', market: 'asian_handicap', side: 'home', line: -0.5 };
    expect(opportunityLabel('Handicap', 'ahcp_0.5', 'Torino', 'Roma', quote))
      .toBe('Handicap asiatico 1 — Torino (-0.5)');
    expect(opportunityLabel('Handicap', 'ahcp_0.5', 'Torino', 'Roma', { ...quote, line: 0.5 }))
      .toBe('Handicap asiatico 1 — Torino (+0.5)');
    expect(opportunityLabel('Handicap', 'ahcp_away_-0.25', 'Torino', 'Roma', {
      selection: 'ahcp_away_-0.25', market: 'asian_handicap', side: 'away', line: -0.25,
    })).toBe('Handicap asiatico 2 — Roma (-0.25)');
    expect(opportunityLabel('Handicap', 'hcp_draw+1', 'Torino', 'Roma', {
      selection: 'hcp_draw+1', market: 'european_handicap', side: 'draw', line: 1,
    })).toBe('Handicap europeo X (+1 casa) — Pareggio');
    expect(opportunityLabel('Handicap', 'hcp_away+1', 'Torino', 'Roma', {
      selection: 'hcp_away+1', market: 'european_handicap', side: 'away', line: -1,
    })).toBe('Handicap europeo 2 — Roma (+1)');
    expect(opportunityLabel('Handicap', 'hcp_away-1', 'Torino', 'Roma', {
      selection: 'hcp_away-1', market: 'european_handicap', side: 'away', line: 1,
    })).toBe('Handicap europeo 2 — Roma (-1)');
  });

  test.each([
    undefined,
    { market: 'asian_handicap', side: 'home' },
    { market: 'asian_handicap', side: 'home', line: Number.NaN },
    { market: 'asian_handicap', side: 'away', line: -0.5 },
    { market: 'european_handicap', side: 'home', line: -0.5 },
    { selection: 'ahcp_1', market: 'asian_handicap', side: 'home', line: -0.5 },
  ])('does not invent a handicap from missing or inconsistent price evidence %#', (quote) => {
    expect(opportunityLabel('Handicap', 'ahcp_0.5', 'Torino', 'Roma', quote))
      .toBe('Handicap asiatico — dettaglio non disponibile');
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
    )).toBe('Giocatore: Over 1.5 tiri');
  });
});
