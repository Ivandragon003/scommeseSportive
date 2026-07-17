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
  pruneOldSeasons,
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
  };
  const csv = [
    'Div,Date,HomeTeam,AwayTeam,HS,AS,HF,AF,HC,AC,HY,AY,HR,AR',
    'I1,17/08/2024,Genoa,Inter,10,14,15,14,1,4,1,2,0,0', // Genoa vs Inter: NON matcha (home/away invertiti rispetto a m1)
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

test('pruneOldSeasons: tiene le N stagioni piu recenti ed elimina le vecchie + odds orfani', async () => {
  const executed = [];
  const client = {
    async execute(q) {
      const sql = typeof q === 'string' ? q : q.sql;
      executed.push({ sql, args: q.args });
      if (/SELECT season/.test(sql)) {
        return { rows: [
          { season: '2022/2023', n: 380 }, { season: '2023/2024', n: 380 },
          { season: '2024/2025', n: 380 }, { season: '2025/2026', n: 380 },
          { season: '2026/2027', n: 100 },
        ] };
      }
      if (/DELETE FROM odds_snapshots/.test(sql)) return { rows: [], rowsAffected: 12 };
      if (/DELETE FROM matches/.test(sql)) return { rows: [], rowsAffected: 380 };
      return { rows: [] };
    },
  };
  const summary = await pruneOldSeasons(client, 4);
  assert.deepEqual(summary.seasonsKept, ['2026/2027', '2025/2026', '2024/2025', '2023/2024']);
  assert.deepEqual(summary.seasonsDeleted, ['2022/2023']);
  assert.equal(summary.matchesDeleted, 380);
  assert.equal(summary.oddsDeleted, 12);
});

test('pruneOldSeasons: no-op se le stagioni sono <= keepCount', async () => {
  const client = {
    async execute() { return { rows: [{ season: '2024/2025', n: 10 }, { season: '2025/2026', n: 10 }] }; },
  };
  const summary = await pruneOldSeasons(client, 4);
  assert.deepEqual(summary.seasonsDeleted, []);
  assert.equal(summary.matchesDeleted, 0);
});
