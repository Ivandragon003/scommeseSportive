const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseFootballDataCsv,
  canonicalTeamName,
  matchKey,
  seasonToFootballDataCode,
  syncFootballData,
  FOOTBALL_DATA_LEAGUE_CODES,
  currentSeasonStartYear,
  seasonLabel,
  buildSeasonWindow,
  pruneOldSeasons,
  buildMarketOddsJson,
  buildTransitionSeasonReference,
  buildTransitionStandings,
  syncTransitionSeasonReferences,
  FOOTBALL_DATA_TRANSITION_LEAGUE_CODES,
  selectLatestRelevantTransition,
} = require('../dist/services/FootballDataService.js');

test('seasonToFootballDataCode: anno inizio -> codice football-data', () => {
  assert.equal(seasonToFootballDataCode(2024), '2425');
  assert.equal(seasonToFootballDataCode(2025), '2526');
  assert.equal(seasonToFootballDataCode(2022), '2223');
});

test('canonicalTeamName: alias football-data -> nome DB Understat', () => {
  assert.equal(canonicalTeamName('Inter'), 'internazionale');
  assert.equal(canonicalTeamName('Milan'), 'acmilan');
  assert.equal(canonicalTeamName('Parma'), 'parmacalcio1913');
  assert.equal(canonicalTeamName('Man City'), 'manchestercity');
  assert.equal(canonicalTeamName('Ath Madrid'), 'atleticomadrid');
  assert.equal(canonicalTeamName('Ein Frankfurt'), 'eintrachtfrankfurt');
  assert.equal(canonicalTeamName('Santander'), 'racingsantander');
  assert.equal(canonicalTeamName('La Coruna'), 'deportivolacoruna');
  // nome senza alias: solo normalizzato
  assert.equal(canonicalTeamName('Arsenal'), 'arsenal');
  assert.equal(canonicalTeamName('Real Madrid'), 'realmadrid');
});

test('matchKey: robusto a normalizzazione e alias', () => {
  assert.equal(matchKey('2024-08-17', 'Inter', 'Milan'), '2024-08-17|internazionale|acmilan');
  // stessa chiave da nomi DB equivalenti
  assert.equal(
    matchKey('2024-08-17T20:45:00', 'Internazionale', 'AC Milan'),
    matchKey('2024-08-17', 'Inter', 'Milan')
  );
});

test('parseFootballDataCsv: estrae i campi supplementari e converte la data', () => {
  const csv = [
    'Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,Referee',
    'I1,17/08/2024,17:30,Genoa,Inter,2,2,10,14,6,9,15,14,1,4,1,2,0,0,Mr Rossi',
    'I1,18/08/2024,20:45,Milan,Torino,3,1,18,7,8,3,11,16,7,2,2,3,0,1,',
  ].join('\n');
  const rows = parseFootballDataCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { date: rows[0].date, h: rows[0].homeTeam, a: rows[0].awayTeam, hf: rows[0].homeFouls, af: rows[0].awayFouls, hc: rows[0].homeCorners, ref: rows[0].referee },
    { date: '2024-08-17', h: 'Genoa', a: 'Inter', hf: 15, af: 14, hc: 1, ref: 'Mr Rossi' }
  );
  // referee vuoto -> null
  assert.equal(rows[1].referee, null);
  assert.equal(rows[1].homeShots, 18);
  assert.equal(rows[1].awayRed, 1);
  assert.equal(rows[0].homeGoals, 2);
  assert.equal(rows[0].awayGoals, 2);
});

test('buildTransitionSeasonReference: calcola PPG e differenza reti senza inventare playoff', () => {
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG',
    'I2,01/08/2024,A,B,2,0',
    'I2,02/08/2024,B,A,1,1',
    'I2,03/08/2024,C,A,0,1',
    'I2,04/08/2024,A,C,2,0',
    'I2,05/08/2024,B,C,1,0',
    'I2,06/08/2024,C,B,0,0',
  ].join('\n');
  const reference = buildTransitionSeasonReference(
    'serie_b', 'Serie B', 2024, parseFootballDataCsv(csv), 'https://example.test/2425/I2.csv'
  );
  assert.equal(reference.sourceSeason, '2024/2025');
  assert.equal(reference.teamsCount, 3);
  assert.equal(reference.coverageStatus, 'complete');
  assert.equal(reference.sourceProvider, 'football-data.co.uk');
  assert.equal(reference.sourceReference.includes('/2425/I2.csv'), true);
  assert.equal(reference.matchesObserved, 6);
  assert.equal(reference.matchesExpected, 6);
  assert.equal(reference.coveragePercent, 100);
});

test('selectLatestRelevantTransition: conserva la cronologia ma usa l’evento piu recente', () => {
  const transitions = [
    { destination_competition_id: 'serie_a', destination_season: '2022/2023', source: 'serie_a' },
    { destination_competition_id: 'serie_a', destination_season: '2025/2026', source: 'serie_b' },
  ];
  assert.equal(selectLatestRelevantTransition(transitions, 'serie_a', '2025/2026').source, 'serie_b');
  assert.equal(selectLatestRelevantTransition(transitions, 'serie_a', '2024/2025').source, 'serie_a');
});

test('syncTransitionSeasonReferences: upsert idempotente e skip della stagione completa', async () => {
  const persisted = [];
  const fakeDb = {
    async hasCompleteTransitionSeasonReference(id, season) {
      return id === 'serie_b' && season === '2024/2025';
    },
    async upsertTransitionSeasonReference(reference) { persisted.push(reference); },
  };
  const result = await syncTransitionSeasonReferences(fakeDb, {
    competitions: { 'Serie B': 'I2' },
    seasonStartYears: [2024, 2025],
    fetcher: async () => [
      'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG',
      'I2,01/08/2025,A,B,1,0',
    ].join('\n'),
  });
  assert.equal(result.requested, 2);
  assert.equal(result.persisted, 1);
  assert.equal(persisted[0].sourceSeason, '2025/2026');
});

test('syncTransitionSeasonReferences: salva le prime due promozioni dirette quando i team sono risolvibili', async () => {
  const transitions = [];
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG',
    'I2,01/08/2024,Alpha,Beta,2,0',
    'I2,02/08/2024,Beta,Alpha,1,1',
    'I2,03/08/2024,Gamma,Alpha,0,1',
    'I2,04/08/2024,Alpha,Gamma,2,0',
    'I2,05/08/2024,Beta,Gamma,1,0',
    'I2,06/08/2024,Gamma,Beta,0,0',
  ].join('\n');
  const standings = buildTransitionStandings(parseFootballDataCsv(csv));
  assert.deepEqual(standings.slice(0, 2).map((row) => row.teamName), ['Alpha', 'Beta']);
  const fakeDb = {
    async getTransitionTeams() { return [{ team_id: 'alpha-id', name: 'Alpha' }, { team_id: 'beta-id', name: 'Beta' }]; },
    async upsertTransitionSeasonReference() {},
    async upsertTeamCompetitionTransition(row) { transitions.push(row); },
    async hasCompleteTransitionSeasonReference() { return false; },
    async hasTransitionForSourceSeason() { return false; },
  };
  const result = await syncTransitionSeasonReferences(fakeDb, {
    competitions: { 'Serie B': 'I2' },
    seasonStartYears: [2024],
    fetcher: async () => csv,
  });
  assert.equal(result.transitionsPersisted, 2);
  assert.deepEqual(transitions.map((row) => row.transitionMode).sort(), ['direct_1', 'direct_2']);
});

test('FOOTBALL_DATA_TRANSITION_LEAGUE_CODES: catalogo seconde divisioni', () => {
  assert.deepEqual(Object.keys(FOOTBALL_DATA_TRANSITION_LEAGUE_CODES).sort(), [
    '2. Bundesliga', 'Championship', 'Ligue 2', 'Segunda Division', 'Serie B',
  ]);
});

test('parseFootballDataCsv: estrae quote apertura (Avg) e chiusura (AvgC) + fallback B365', () => {
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,AvgH,AvgD,AvgA,Avg>2.5,Avg<2.5,AvgCH,AvgCD,AvgCA,AvgC>2.5,AvgC<2.5',
    'I1,17/08/2024,Genoa,Inter,2,2,4.20,3.60,1.85,2.05,1.80,4.50,3.70,1.78,2.10,1.75',
  ].join('\n');
  const r = parseFootballDataCsv(csv)[0];
  assert.equal(r.oddsHome, 4.20); assert.equal(r.oddsDraw, 3.60); assert.equal(r.oddsAway, 1.85);
  assert.equal(r.oddsOver25, 2.05); assert.equal(r.oddsUnder25, 1.80);
  assert.equal(r.closingHome, 4.50); assert.equal(r.closingAway, 1.78); assert.equal(r.closingOver25, 2.10);

  // fallback B365 quando Avg assente; quote assenti -> null
  const csv2 = ['Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,B365H,B365D,B365A', 'E0,01/09/2024,Arsenal,Chelsea,2,1,1.50,4.0,7.0'].join('\n');
  const r2 = parseFootballDataCsv(csv2)[0];
  assert.equal(r2.oddsHome, 1.50); assert.equal(r2.oddsAway, 7.0);
  assert.equal(r2.closingHome, null); assert.equal(r2.oddsOver25, null);
});

test('parseFootballDataCsv: header senza colonne minime -> vuoto', () => {
  assert.deepEqual(parseFootballDataCsv('Foo,Bar\n1,2'), []);
  assert.deepEqual(parseFootballDataCsv(''), []);
});

test('parseFootballDataCsv: gestisce colonne statistiche mancanti (null)', () => {
  const csv = ['Div,Date,HomeTeam,AwayTeam,FTHG,FTAG', 'E0,01/09/2024,Arsenal,Chelsea,2,1'].join('\n');
  const rows = parseFootballDataCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].homeFouls, null);
  assert.equal(rows[0].homeShots, null);
  assert.equal(rows[0].referee, null);
});

test('syncFootballData: matcha per data+squadre e riempie solo i NULL (DB fake)', async () => {
  const filled = [];
  const oddsSaved = [];
  const fakeDb = {
    async getMatchesForCompetition() {
      return [
        { match_id: 'm1', date: '2024-08-17', home_team_name: 'Internazionale', away_team_name: 'Genoa' },
        { match_id: 'm2', date: '2024-08-18', home_team_name: 'AC Milan', away_team_name: 'Torino' },
      ];
    },
    async fillSupplementalStats(matchId, row) {
      filled.push({ matchId, hf: row.homeFouls });
      return true;
    },
    async saveMarketOdds(matchId, row) {
      oddsSaved.push({ matchId, home: row.oddsHome, closingHome: row.closingHome });
      return row.oddsHome != null || row.closingHome != null;
    },
  };
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,HS,AS,HF,AF,HC,AC,HY,AY,HR,AR',
    'I1,17/08/2024,Inter,Genoa,14,10,14,15,4,1,2,1,0,0', // matcha m1
    'I1,18/08/2024,Milan,Torino,18,7,11,16,7,2,2,3,0,1', // matcha m2
  ].join('\n');
  const summary = await syncFootballData(fakeDb, {
    competitions: ['Serie A'],
    seasonStartYears: [2024],
    fetcher: async () => csv,
  });
  assert.equal(summary.matched, 2, 'devono matchare m1 e m2');
  assert.equal(summary.updated, 2);
  assert.deepEqual(filled.map((f) => f.matchId).sort(), ['m1', 'm2']);
  assert.equal(summary.requested, 1);
  assert.equal(summary.completed, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.perSeason['Serie A 2024/2025'].status, 'complete');
});

test('syncFootballData: segnala CSV mancante o vuoto per ogni stagione attesa', async () => {
  const fakeDb = {
    async getMatchesForCompetition() { return []; },
    async fillSupplementalStats() { return false; },
    async saveMarketOdds() { return false; },
  };
  const missing = await syncFootballData(fakeDb, {
    competitions: ['Serie A'], seasonStartYears: [2024], fetcher: async () => null,
  });
  assert.equal(missing.requested, 1);
  assert.equal(missing.completed, 0);
  assert.equal(missing.errors.length, 1);
  assert.equal(missing.perSeason['Serie A 2024/2025'].status, 'failed');

  const empty = await syncFootballData(fakeDb, {
    competitions: ['Serie A'], seasonStartYears: [2024], fetcher: async () => 'Foo,Bar\n1,2',
  });
  assert.equal(empty.errors.length, 1);
  assert.match(empty.errors[0].error, /vuoto|valide/i);
});

test('syncFootballData: fallisce la stagione senza match DB corrispondenti e conserva i conteggi', async () => {
  const fakeDb = {
    async getMatchesForCompetition() { return []; },
    async fillSupplementalStats() { return false; },
    async saveMarketOdds() { return false; },
  };
  const csv = ['Div,Date,HomeTeam,AwayTeam,FTHG,FTAG', 'I1,17/08/2024,Inter,Genoa,2,0'].join('\n');
  const summary = await syncFootballData(fakeDb, {
    competitions: ['Serie A'], seasonStartYears: [2024], fetcher: async () => csv,
  });
  assert.equal(summary.completed, 0);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.perSeason['Serie A 2024/2025'].csvRows, 1);
  assert.equal(summary.perSeason['Serie A 2024/2025'].matched, 0);
});

test('syncFootballData abbina una data fonte errata di un giorno solo con coppia squadre univoca', async () => {
  const filled = [];
  const fakeDb = {
    async getMatchesForCompetition() {
      return [{ match_id: 'st-pauli-kiel', date: '2024-11-30T14:30:00Z', home_team_name: 'St. Pauli', away_team_name: 'Holstein Kiel' }];
    },
    async fillSupplementalStats(matchId) { filled.push(matchId); return true; },
    async saveMarketOdds() { return true; },
  };
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG',
    'D1,29/11/2024,St Pauli,Holstein Kiel,3,1',
  ].join('\n');
  const summary = await syncFootballData(fakeDb, {
    competitions: ['Bundesliga'], seasonStartYears: [2024], fetcher: async () => csv,
  });
  assert.deepEqual(filled, ['st-pauli-kiel']);
  assert.equal(summary.completed, 1);
  assert.equal(summary.matched, 1);
});

test('syncFootballData abbina un rinvio oltre un giorno solo alla coppia univoca della stessa stagione', async () => {
  const filled = [];
  const fakeDb = {
    async getMatchesForCompetition() {
      return [
        { match_id: 'udinese-roma-2324', date: '2024-04-14T16:00:00Z', home_team_name: 'Udinese', away_team_name: 'Roma' },
        { match_id: 'udinese-roma-2425', date: '2025-01-26T14:00:00Z', home_team_name: 'Udinese', away_team_name: 'Roma' },
      ];
    },
    async fillSupplementalStats(matchId) { filled.push(matchId); return true; },
    async saveMarketOdds() { return true; },
  };
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG',
    'I1,25/04/2024,Udinese,Roma,1,2',
  ].join('\n');
  const summary = await syncFootballData(fakeDb, {
    competitions: ['Serie A'], seasonStartYears: [2023], fetcher: async () => csv,
  });
  assert.deepEqual(filled, ['udinese-roma-2324']);
  assert.equal(summary.completed, 1);
  assert.equal(summary.dateToleranceMatched, 1);
});

test('syncFootballData tratta come pending la Bundesliga non pubblicata solo prima del via ufficiale', async () => {
  const seasons = [2022, 2023, 2024, 2025, 2026];
  const fakeDb = {
    async getMatchesForCompetition() {
      return seasons.slice(0, 4).map((season) => ({
        match_id: `bayern-mainz-${season}`,
        date: `${season}-08-20`,
        home_team_name: 'Bayern Munich',
        away_team_name: 'Mainz 05',
      }));
    },
    async fillSupplementalStats() { return true; },
    async saveMarketOdds() { return true; },
  };
  const fetcher = async (_league, code) => code === '2627'
    ? null
    : ['Div,Date,HomeTeam,AwayTeam,FTHG,FTAG', `D1,20/08/20${code.slice(0, 2)},Bayern Munich,Mainz,2,0`].join('\n');

  const beforeStart = await syncFootballData(fakeDb, {
    competitions: ['Bundesliga'], seasonStartYears: seasons, fetcher,
    now: new Date('2026-08-27T21:59:59Z'),
  });
  assert.equal(beforeStart.completed, 4);
  assert.equal(beforeStart.pending, 1);
  assert.equal(beforeStart.allExpectedSeasonsReady, true);
  assert.equal(beforeStart.perSeason['Bundesliga 2026/2027'].status, 'pending');
  assert.deepEqual(beforeStart.errors, []);

  const onStart = await syncFootballData(fakeDb, {
    competitions: ['Bundesliga'], seasonStartYears: seasons, fetcher,
    now: new Date('2026-08-27T22:00:00Z'),
  });
  assert.equal(onStart.pending, 0);
  assert.equal(onStart.allExpectedSeasonsReady, false);
  assert.equal(onStart.perSeason['Bundesliga 2026/2027'].status, 'failed');
});

test('syncFootballData mette in quarantena temporanea la sola inversione ufficiale Rennes-PSG', async () => {
  const seasons = [2022, 2023, 2024, 2025, 2026];
  const fakeDb = {
    async getMatchesForCompetition() {
      return [
        ...seasons.slice(0, 4).map((season) => ({
          match_id: `rennes-lille-${season}`,
          date: `${season}-08-20`,
          home_team_name: 'Rennes',
          away_team_name: 'Lille',
        })),
        { match_id: 'stale-psg-rennes', date: '2026-08-23', home_team_name: 'Paris Saint Germain', away_team_name: 'Rennes' },
        { match_id: 'marseille-strasbourg', date: '2026-08-21', home_team_name: 'Marseille', away_team_name: 'Strasbourg' },
      ];
    },
    async fillSupplementalStats() { return true; },
    async saveMarketOdds() { return true; },
  };
  const fetcher = async (_league, code) => code === '2627'
    ? [
      'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG',
      'F1,23/08/2026,Rennes,Paris SG,0,0',
      'F1,21/08/2026,Marseille,Strasbourg,4,0',
    ].join('\n')
    : ['Div,Date,HomeTeam,AwayTeam,FTHG,FTAG', `F1,20/08/20${code.slice(0, 2)},Rennes,Lille,1,0`].join('\n');

  const summary = await syncFootballData(fakeDb, {
    competitions: ['Ligue 1'], seasonStartYears: seasons, fetcher,
    now: new Date('2026-08-25T12:00:00Z'),
  });
  assert.equal(summary.completed, 4);
  assert.equal(summary.pending, 1);
  assert.equal(summary.allExpectedSeasonsReady, true);
  assert.equal(summary.perSeason['Ligue 1 2026/2027'].status, 'pending');
  assert.match(summary.pendingSeasonPairs[0].reason, /inversione/i);
  assert.deepEqual(summary.errors, []);

  const expired = await syncFootballData(fakeDb, {
    competitions: ['Ligue 1'], seasonStartYears: seasons, fetcher,
    now: new Date('2026-08-27T22:00:00Z'),
  });
  assert.equal(expired.pending, 0);
  assert.equal(expired.allExpectedSeasonsReady, false);
  assert.equal(expired.perSeason['Ligue 1 2026/2027'].status, 'failed');
});

test('syncFootballData non nasconde un errore DB dietro la quarantena Rennes-PSG', async () => {
  const seasons = [2022, 2023, 2024, 2025, 2026];
  const fakeDb = {
    async getMatchesForCompetition() {
      return [
        ...seasons.slice(0, 4).map((season) => ({
          match_id: `rennes-lille-${season}`,
          date: `${season}-08-20`,
          home_team_name: 'Rennes',
          away_team_name: 'Lille',
        })),
        { match_id: 'stale-psg-rennes', date: '2026-08-23', home_team_name: 'Paris Saint Germain', away_team_name: 'Rennes' },
        { match_id: 'marseille-strasbourg', date: '2026-08-21', home_team_name: 'Marseille', away_team_name: 'Strasbourg' },
      ];
    },
    async fillSupplementalStats(matchId) {
      if (matchId === 'marseille-strasbourg') throw new Error('database unavailable');
      return true;
    },
    async saveMarketOdds() { return true; },
  };
  const fetcher = async (_league, code) => code === '2627'
    ? [
      'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG',
      'F1,23/08/2026,Rennes,Paris SG,0,0',
      'F1,21/08/2026,Marseille,Strasbourg,4,0',
    ].join('\n')
    : ['Div,Date,HomeTeam,AwayTeam,FTHG,FTAG', `F1,20/08/20${code.slice(0, 2)},Rennes,Lille,1,0`].join('\n');

  const summary = await syncFootballData(fakeDb, {
    competitions: ['Ligue 1'], seasonStartYears: seasons, fetcher,
    now: new Date('2026-08-25T12:00:00Z'),
  });
  assert.equal(summary.pending, 0);
  assert.equal(summary.allExpectedSeasonsReady, false);
  assert.equal(summary.perSeason['Ligue 1 2026/2027'].status, 'failed');
  assert.match(summary.errors[0].error, /database unavailable/i);
});

test('syncFootballData non dichiara completa una stagione con una riga intermedia non abbinata', async () => {
  const fakeDb = {
    async getMatchesForCompetition() {
      return [{ match_id: 'latest', date: '2024-08-10', home_team_name: 'Gamma', away_team_name: 'Delta' }];
    },
    async fillSupplementalStats() { return true; },
    async saveMarketOdds() { return true; },
  };
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG',
    'I1,01/08/2024,Alpha,Beta,1,0',
    'I1,10/08/2024,Gamma,Delta,2,1',
  ].join('\n');
  const summary = await syncFootballData(fakeDb, {
    competitions: ['Serie A'], seasonStartYears: [2024], fetcher: async () => csv,
  });
  assert.equal(summary.matched, 1);
  assert.equal(summary.completed, 0);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0].error, /copertura.*1\/2/i);
  assert.equal(summary.perSeason['Serie A 2024/2025'].status, 'failed');
});

test('buildMarketOddsJson: apertura+chiusura nel formato motore, scarta quote invalide', () => {
  const row = {
    oddsHome: 4.20, oddsDraw: 3.60, oddsAway: 1.85, oddsOver25: 2.05, oddsUnder25: 1.80,
    closingHome: 4.50, closingDraw: 3.70, closingAway: 1.78, closingOver25: null, closingUnder25: 1.0,
  };
  const out = buildMarketOddsJson(row);
  assert.deepEqual(out.opening, { homeWin: 4.20, draw: 3.60, awayWin: 1.85, over25: 2.05, under25: 1.80 });
  assert.deepEqual(out.closing, { homeWin: 4.50, draw: 3.70, awayWin: 1.78 }); // over25 null e under25<=1 scartati
  // nessuna quota -> null
  assert.equal(buildMarketOddsJson({ oddsHome: null, closingHome: null }), null);
});

test('FOOTBALL_DATA_LEAGUE_CODES: copre le 5 leghe', () => {
  assert.deepEqual(Object.keys(FOOTBALL_DATA_LEAGUE_CODES).sort(), ['Bundesliga', 'La Liga', 'Ligue 1', 'Premier League', 'Serie A']);
});

test('currentSeasonStartYear: le stagioni iniziano ad agosto (luglio+ punta alla nuova)', () => {
  assert.equal(currentSeasonStartYear(new Date('2026-07-17T00:00:00Z')), 2026); // luglio -> stagione 2026/27
  assert.equal(currentSeasonStartYear(new Date('2026-05-01T00:00:00Z')), 2025); // maggio -> 2025/26
  assert.equal(currentSeasonStartYear(new Date('2025-09-01T00:00:00Z')), 2025);
  assert.equal(currentSeasonStartYear(new Date('2026-01-15T00:00:00Z')), 2025);
  assert.equal(seasonLabel(2024), '2024/2025');
});

test('syncTransitionSeasonReferences salva stagione e partite di serie inferiore solo per team noti', async () => {
  const seasons = [];
  const matches = [];
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,Referee',
    'I2,01/08/2024,Alpha,Unknown,2,0,12,5,6,2,9,12,7,2,1,3,0,0,Rossi',
    'I2,08/08/2024,Unknown,Alpha,1,1,8,10,3,4,11,10,3,5,2,2,0,0,Bianchi',
  ].join('\n');
  const fakeDb = {
    async getTransitionTeams() { return [{ team_id: 'alpha-id', name: 'Alpha' }]; },
    async upsertTransitionSeasonReference() {},
    async upsertLowerDivisionTeamSeason(row) { seasons.push(row); },
    async upsertLowerDivisionTeamMatch(row) { matches.push(row); },
    async hasCompleteTransitionSeasonReference() { return false; },
    async hasTransitionForSourceSeason() { return false; },
  };
  const result = await syncTransitionSeasonReferences(fakeDb, {
    competitions: { 'Serie B': 'I2' }, seasonStartYears: [2024], fetcher: async () => csv,
  });
  assert.equal(result.teamSeasonsPersisted, 1);
  assert.equal(result.teamMatchesPersisted, 2);
  assert.equal(seasons[0].teamId, 'alpha-id');
  assert.deepEqual(matches.map((row) => [row.venue, row.opponentName, row.goalsFor]), [
    ['home', 'Unknown', 2], ['away', 'Unknown', 1],
  ]);
  assert.equal(matches.some((row) => Object.hasOwn(row, 'xgFor')), false);
  assert.equal(result.modelAdjustmentEnabled, false);
});

test('syncTransitionSeasonReferences rilegge stagioni complete quando compare una nuova squadra nota', async () => {
  const saved = [];
  let downloads = 0;
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG',
    'I2,01/08/2024,New Team,Other,1,0',
    'I2,08/08/2024,Other,New Team,0,2',
  ].join('\n');
  const fakeDb = {
    async getTransitionTeams() { return [{ team_id: 'new-team-id', name: 'New Team' }]; },
    async hasCompleteTransitionSeasonReference() { return true; },
    async hasTransitionForSourceSeason() { return true; },
    async upsertTransitionSeasonReference() {},
    async upsertLowerDivisionTeamSeason(row) { saved.push(row); },
  };
  const result = await syncTransitionSeasonReferences(fakeDb, {
    competitions: { 'Serie B': 'I2' }, seasonStartYears: [2024],
    fetcher: async () => { downloads += 1; return csv; },
  });
  assert.equal(downloads, 1);
  assert.equal(result.skipped, 0);
  assert.equal(saved.some((row) => row.teamId === 'new-team-id'), true);
});

test('syncTransitionSeasonReferences: CSV mancante e un errore esplicito, non uno skip riuscito', async () => {
  const result = await syncTransitionSeasonReferences({
    async upsertTransitionSeasonReference() {},
  }, {
    competitions: { 'Serie B': 'I2' }, seasonStartYears: [2024], fetcher: async () => null,
  });
  assert.equal(result.requested, 1);
  assert.equal(result.persisted, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.perSeason['Serie B 2024/2025'].status, 'failed');
});

test('syncTransitionSeasonReferences usa un batch e salta scritture storiche gia complete', async () => {
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG',
    'I2,01/08/2024,Alpha,Beta,2,0',
    'I2,02/08/2024,Beta,Alpha,0,1',
  ].join('\n');
  let bulkCalls = 0;
  const fakeDb = {
    async getTransitionTeams() { return [{ team_id: 'alpha-id', name: 'Alpha' }]; },
    async hasCompleteTransitionSeasonReference() { return true; },
    async hasTransitionForSourceSeason() { return true; },
    async hasCompleteLowerDivisionTeamHistory(_competition, _season, expectedTeamIds, expectedRows) {
      assert.deepEqual(expectedTeamIds, ['alpha-id']);
      assert.equal(expectedRows, 2);
      return true;
    },
    async upsertTransitionSeasonReference() { throw new Error('non deve scrivere'); },
    async upsertLowerDivisionHistoryBatch() { bulkCalls += 1; },
  };
  const result = await syncTransitionSeasonReferences(fakeDb, {
    competitions: { 'Serie B': 'I2' }, seasonStartYears: [2024], fetcher: async () => csv,
  });
  assert.equal(result.skipped, 1);
  assert.equal(result.persisted, 0);
  assert.equal(bulkCalls, 0);
  assert.equal(result.perSeason['Serie B 2024/2025'].status, 'skipped_complete');
});

test('syncTransitionSeasonReferences raggruppa storico e transizioni in una sola chiamata bulk', async () => {
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG',
    'I2,01/08/2024,Alpha,Beta,2,0',
    'I2,02/08/2024,Beta,Alpha,0,1',
  ].join('\n');
  const batches = [];
  const fakeDb = {
    async getTransitionTeams() { return [{ team_id: 'alpha-id', name: 'Alpha' }, { team_id: 'beta-id', name: 'Beta' }]; },
    async hasCompleteTransitionSeasonReference() { return false; },
    async hasTransitionForSourceSeason() { return false; },
    async hasCompleteLowerDivisionTeamHistory() { return false; },
    async upsertTransitionSeasonReference() { throw new Error('usa bulk'); },
    async upsertLowerDivisionHistoryBatch(payload) { batches.push(payload); },
  };
  const result = await syncTransitionSeasonReferences(fakeDb, {
    competitions: { 'Serie B': 'I2' }, seasonStartYears: [2024], fetcher: async () => csv,
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].teamSeasons.length, 2);
  assert.equal(batches[0].teamMatches.length, 4);
  assert.equal(result.teamSeasonsPersisted, 2);
  assert.equal(result.teamMatchesPersisted, 4);
  assert.equal(result.perSeason['Serie B 2024/2025'].status, 'complete');
});

test('buildSeasonWindow: restituisce sempre stagione corrente e quattro precedenti', () => {
  assert.deepEqual(buildSeasonWindow(new Date('2026-08-25T00:00:00Z')), [
    '2022/2023', '2023/2024', '2024/2025', '2025/2026', '2026/2027',
  ]);
});

test('pruneOldSeasons: tiene la finestra esatta di cinque stagioni e pulisce i dati collegati in un batch atomico', async () => {
  const executed = [];
  const batches = [];
  const client = {
    async execute(q) {
      const sql = typeof q === 'string' ? q : q.sql;
      executed.push({ sql, args: q.args });
      if (/SELECT season/.test(sql)) {
        return { rows: [
          { season: '2021/2022', n: 380 }, { season: '2022/2023', n: 380 }, { season: '2023/2024', n: 380 },
          { season: '2024/2025', n: 380 }, { season: '2025/2026', n: 380 },
          { season: '2026/2027', n: 100 },
        ] };
      }
      return { rows: [] };
    },
    async batch(statements, mode) {
      batches.push({ statements, mode });
      return statements.map((statement) => ({
        rows: [],
        rowsAffected: /DELETE FROM matches/.test(statement.sql) ? 380
          : /DELETE FROM odds_snapshots/.test(statement.sql) ? 12 : 3,
      }));
    },
  };
  const summary = await pruneOldSeasons(client, 5, new Date('2026-08-25T00:00:00Z'));
  assert.deepEqual(summary.seasonsKept, ['2026/2027', '2025/2026', '2024/2025', '2023/2024', '2022/2023']);
  assert.deepEqual(summary.seasonsDeleted, ['2021/2022']);
  assert.equal(summary.matchesDeleted, 380);
  assert.equal(summary.oddsDeleted, 12);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].mode, 'write');
  const sql = batches[0].statements.map((statement) => statement.sql).join('\n');
  assert.match(sql, /DELETE FROM player_injury_refresh_batches/);
  assert.match(sql, /DELETE FROM player_lineup_status/);
  assert.match(sql, /DELETE FROM player_lineup_snapshots/);
  assert.match(sql, /DELETE FROM learning_reviews/);
  assert.doesNotMatch(sql, /DELETE FROM predictions/);
  assert.doesNotMatch(sql, /DELETE FROM bets/);
});

test('pruneOldSeasons: senza stagioni vecchie pulisce comunque i batch snapshot orfani', async () => {
  let orphanCleanupCalls = 0;
  const client = {
    async execute(q) {
      const sql = typeof q === 'string' ? q : q.sql;
      if (/SELECT season/.test(sql)) {
        return { rows: [{ season: '2024/2025', n: 10 }, { season: '2025/2026', n: 10 }] };
      }
      assert.match(sql, /DELETE FROM player_lineup_snapshot_batches/);
      assert.match(sql, /player_injury_refresh_batches injury/);
      orphanCleanupCalls += 1;
      return { rows: [], rowsAffected: 2 };
    },
  };
  const summary = await pruneOldSeasons(client, 5, new Date('2026-08-25T00:00:00Z'));
  assert.deepEqual(summary.seasonsDeleted, []);
  assert.equal(summary.matchesDeleted, 0);
  assert.equal(summary.linkedRowsDeleted, 2);
  assert.equal(orphanCleanupCalls, 1);
});

test('pruneOldSeasons elimina una stagione tecnica vecchia anche senza match residui', async () => {
  const batches = [];
  const client = {
    async execute() { return { rows: [{ season: '2021/2022' }, { season: '2026/2027' }] }; },
    async batch(statements, mode) {
      batches.push({ statements, mode });
      return statements.map(() => ({ rowsAffected: 0 }));
    },
  };
  const summary = await pruneOldSeasons(client, 5, new Date('2026-08-25T00:00:00Z'));
  assert.deepEqual(summary.seasonsDeleted, ['2021/2022']);
  assert.equal(batches.length, 1);
  assert.match(batches[0].statements.map((statement) => statement.sql).join('\n'), /DELETE FROM lower_division_team_seasons/);
});

test('pruneOldSeasons: non esegue cancellazioni parziali quando il batch atomico fallisce', async () => {
  let destructiveExecuteCalls = 0;
  const client = {
    async execute(q) {
      const sql = typeof q === 'string' ? q : q.sql;
      if (/SELECT season/.test(sql)) {
        return { rows: [
          { season: '2021/2022', n: 380 }, { season: '2022/2023', n: 380 },
          { season: '2023/2024', n: 380 }, { season: '2024/2025', n: 380 },
          { season: '2025/2026', n: 380 }, { season: '2026/2027', n: 100 },
        ] };
      }
      if (/DELETE FROM/.test(sql)) destructiveExecuteCalls++;
      return { rows: [] };
    },
    async batch() { throw new Error('write failed'); },
  };
  await assert.rejects(
    pruneOldSeasons(client, 5, new Date('2026-08-25T00:00:00Z')),
    /write failed/,
  );
  assert.equal(destructiveExecuteCalls, 0);
});
