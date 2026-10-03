const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const {
  createLibsqlFootballDataDb, parseFootballDataCsv, syncFootballData,
} = require('../dist/services/FootballDataService');

const csv = [
  'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,Referee,AvgH,AvgD,AvgA',
  'I1,01/08/2026,Alpha,Beta,1,0,10,8,5,3,12,14,6,4,2,1,0,0,,2.1,3.4,3.6',
].join('\n');
const row = parseFootballDataCsv(csv)[0];
const invertedCsv = [
  'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,Referee,AvgH,AvgD,AvgA,AvgCH,AvgCD,AvgCA',
  'F1,23/08/2026,Rennes,Paris SG,2,2,9,19,3,5,7,6,0,10,2,4,0,1,Dechepy,6.5,4.7,1.4,6.2,4.6,1.5',
].join('\n');

async function memoryDb() {
  const client = createClient({ url: 'file::memory:' });
  await client.execute(`CREATE TABLE matches (
    match_id TEXT PRIMARY KEY, date TEXT, competition TEXT, home_team_name TEXT, away_team_name TEXT,
    home_team_id TEXT, away_team_id TEXT, home_goals INTEGER,
    home_shots INTEGER, away_shots INTEGER, home_shots_on_target INTEGER, away_shots_on_target INTEGER,
    home_fouls INTEGER, away_fouls INTEGER, home_corners INTEGER, away_corners INTEGER,
    home_yellow_cards INTEGER, away_yellow_cards INTEGER, home_red_cards INTEGER, away_red_cards INTEGER,
    referee TEXT, fd_odds_json TEXT
  )`);
  await client.execute('CREATE TABLE writes (match_id TEXT)');
  await client.execute('CREATE TRIGGER record_write AFTER UPDATE ON matches BEGIN INSERT INTO writes VALUES (NEW.match_id); END');
  return client;
}

async function insertMatch(client, id = 'match', date = '2026-08-01', competition = 'Serie A', goals = 1) {
  await client.execute({
    sql: `INSERT INTO matches (match_id,date,competition,home_team_name,away_team_name,home_team_id,away_team_id,home_goals)
      VALUES (?,?,?,'Alpha','Beta','alpha','beta',?)`,
    args: [id, date, competition, goals],
  });
}

for (const batched of [false, true]) {
  test(`football-data ${batched ? 'batch' : 'single'} writes only changed values and preserves Understat`, async () => {
    const client = await memoryDb();
    try {
      await insertMatch(client);
      await client.execute("UPDATE matches SET home_shots = 99, referee = '  ' WHERE match_id = 'match'");
      await client.execute('DELETE FROM writes');
      const db = createLibsqlFootballDataDb(client);
      const apply = async (nextRow) => batched
        ? (await db.applySupplementalStatsAndOdds([{ matchId: 'match', row: nextRow }]))[0]
        : { statsChanged: await db.fillSupplementalStats('match', nextRow), oddsWritten: await db.saveMarketOdds('match', nextRow) };
      assert.deepEqual(await apply(row), { statsChanged: true, oddsWritten: true });
      assert.deepEqual(await apply(row), { statsChanged: false, oddsWritten: false });
      const saved = (await client.execute("SELECT home_shots, away_shots, referee FROM matches WHERE match_id = 'match'")).rows[0];
      assert.equal(saved.home_shots, 99);
      assert.equal(saved.away_shots, 8);
      assert.equal(saved.referee, null);
      assert.equal((await client.execute('SELECT COUNT(*) AS count FROM writes')).rows[0].count, 2);
      assert.deepEqual(await apply({ ...row, referee: 'Rossi', oddsHome: 2.2 }), { statsChanged: true, oddsWritten: true });
      assert.deepEqual(await apply({ ...row, referee: 'Different', oddsHome: 2.2 }), { statsChanged: false, oddsWritten: false });
      assert.equal((await client.execute('SELECT referee FROM matches')).rows[0].referee, 'Rossi');
    } finally { client.close(); }
  });
}

test('football-data restricts reads to requested seasons including the one-day matching margin', async () => {
  const client = await memoryDb();
  try {
    for (const [id, date] of [
      ['old', '2022-08-01'], ['margin', '2024-06-30'], ['historic', '2024-08-01'],
      ['gap', '2025-08-01'], ['current', '2026-08-01'], ['end', '2027-07-01'], ['future', '2027-07-02'],
    ]) await insertMatch(client, id, date);
    await insertMatch(client, 'notPlayed', '2026-08-01', 'Serie A', null);
    await insertMatch(client, 'otherLeague', '2026-08-01', 'La Liga');
    const db = createLibsqlFootballDataDb(client);
    const matches = await db.getMatchesForCompetition('Serie A', [2024, 2026, 2026]);
    assert.deepEqual(matches.map((match) => match.match_id).sort(), ['current', 'end', 'historic', 'margin']);
    assert.ok(matches.every((match) => match.home_team_id === 'alpha' && match.away_team_id === 'beta'));
    assert.deepEqual(await db.getMatchesForCompetition('Serie A', []), []);
  } finally { client.close(); }
});

test('football-data reports changed teams even when coverage is partial and skips them on identical replay', async () => {
  const client = await memoryDb();
  try {
    await insertMatch(client);
    const db = createLibsqlFootballDataDb(client);
    const incompleteCsv = `${csv}\nI1,02/08/2026,Missing,Other,1,0,10,8,5,3,12,14,6,4,2,1,0,0,,2.1,3.4,3.6`;
    const options = { competitions: ['Serie A'], seasonStartYears: [2026], fetcher: async () => incompleteCsv };
    const first = await syncFootballData(db, options);
    assert.equal(first.allExpectedSeasonsComplete, false);
    assert.equal(first.updated, 1);
    assert.deepEqual(first.updatedMatchIds, ['match']);
    assert.deepEqual(first.updatedTeamIds, ['alpha', 'beta']);
    const repeat = await syncFootballData(db, options);
    assert.equal(repeat.updated, 0);
    assert.equal(repeat.oddsWritten, 0);
    assert.deepEqual(repeat.updatedTeamIds, []);
  } finally { client.close(); }
});

test('football-data identical sync sends no write statements; later stats and odds changes are independent', async () => {
  const client = await memoryDb();
  try {
    await insertMatch(client);
    const statements = [];
    const db = createLibsqlFootballDataDb({
      execute: (query) => client.execute(query),
      batch: (updates, mode) => { statements.push(...updates.map((update) => update.sql)); return client.batch(updates, mode); },
    });
    let source = csv;
    const options = { competitions: ['Serie A'], seasonStartYears: [2026], fetcher: async () => source };
    assert.equal((await syncFootballData(db, options)).updated, 1);
    assert.equal(statements.length, 2);
    statements.length = 0;
    const repeat = await syncFootballData(db, options);
    assert.equal(repeat.matched, 1);
    assert.equal(repeat.allExpectedSeasonsComplete, true);
    assert.equal(statements.length, 0);
    source = csv.replace(',,2.1,', ',Rossi,2.1,');
    const statsOnly = await syncFootballData(db, options);
    assert.equal(statsOnly.updated, 1);
    assert.equal(statsOnly.oddsWritten, 0);
    assert.equal(statements.length, 1);
    assert.ok(!statements[0].includes('SET fd_odds_json'));
    statements.length = 0;
    source = source.replace(',2.1,', ',2.2,');
    const oddsOnly = await syncFootballData(db, options);
    assert.equal(oddsOnly.updated, 0);
    assert.equal(oddsOnly.oddsWritten, 1);
    assert.deepEqual(oddsOnly.updatedTeamIds, []);
    assert.equal(statements.length, 1);
    assert.ok(statements[0].includes('SET fd_odds_json'));
  } finally { client.close(); }
});

test('football-data SQL guards preserve data changed by another writer after matching read', async () => {
  const client = await memoryDb();
  try {
    await insertMatch(client);
    const adapter = createLibsqlFootballDataDb(client);
    const db = {
      ...adapter,
      async getMatchesForCompetition(...args) {
        const matches = await adapter.getMatchesForCompetition(...args);
        await client.execute("UPDATE matches SET home_shots = 77 WHERE match_id = 'match'");
        return matches;
      },
    };
    const result = await syncFootballData(db, {
      competitions: ['Serie A'], seasonStartYears: [2026], fetcher: async () => csv,
    });
    assert.equal(result.updated, 1);
    assert.equal((await client.execute('SELECT home_shots FROM matches')).rows[0].home_shots, 77);
  } finally { client.close(); }
});

test('football-data keeps successful chunk changes if a later chunk fails', async () => {
  const lines = ['Div,Date,HomeTeam,AwayTeam,FTHG,FTAG'];
  const matches = Array.from({ length: 51 }, (_, index) => {
    lines.push(`I1,01/08/2026,Home${index},Away${index},1,0`);
    return { match_id: String(index), date: '2026-08-01', home_team_name: `Home${index}`,
      away_team_name: `Away${index}`, home_team_id: `home-${index}`, away_team_id: `away-${index}` };
  });
  let calls = 0;
  const result = await syncFootballData({
    getMatchesForCompetition: async (_competition, seasons) => { assert.deepEqual(seasons, [2026]); return matches; },
    fillSupplementalStats: async () => false,
    saveMarketOdds: async () => false,
    applySupplementalStatsAndOdds: async (updates) => {
      if (++calls === 2) throw new Error('Database temporarily unavailable');
      return updates.map(() => ({ statsChanged: true, oddsWritten: false }));
    },
  }, { competitions: ['Serie A'], seasonStartYears: [2026], fetcher: async () => lines.join('\n') });
  assert.equal(result.updated, 50);
  assert.equal(result.errors.length, 1);
  assert.equal(result.updatedMatchIds.length, 50);
  assert.equal(result.updatedTeamIds.length, 100);
  assert.equal(result.updatedMatchIds.includes('50'), false);
});

test('football-data tracks a successful individual stats write if saving its odds fails', async () => {
  const result = await syncFootballData({
    getMatchesForCompetition: async () => [{ match_id: 'match', date: '2026-08-01', home_team_name: 'Alpha',
      away_team_name: 'Beta', home_team_id: 'alpha', away_team_id: 'beta' }],
    fillSupplementalStats: async () => true,
    saveMarketOdds: async () => { throw new Error('Database temporarily unavailable'); },
  }, { competitions: ['Serie A'], seasonStartYears: [2026], fetcher: async () => csv });
  assert.equal(result.updated, 1);
  assert.equal(result.oddsWritten, 0);
  assert.deepEqual(result.updatedTeamIds, ['alpha', 'beta']);
  assert.equal(result.errors.length, 1);
});

test('football-data adapter without atomic batch tracks successful stats before an odds write failure', async () => {
  const client = await memoryDb();
  try {
    await insertMatch(client);
    const db = createLibsqlFootballDataDb({
      execute(query) {
        if (typeof query === 'object' && query.sql.includes('SET fd_odds_json')) {
          throw new Error('Database temporarily unavailable');
        }
        return client.execute(query);
      },
    });
    assert.equal(db.applySupplementalStatsAndOdds, undefined);
    const result = await syncFootballData(db, {
      competitions: ['Serie A'], seasonStartYears: [2026], fetcher: async () => csv,
    });
    assert.equal(result.updated, 1);
    assert.equal(result.oddsWritten, 0);
    assert.deepEqual(result.updatedTeamIds, ['alpha', 'beta']);
    assert.equal(result.errors.length, 1);
    assert.equal((await client.execute('SELECT away_shots FROM matches')).rows[0].away_shots, 8);
  } finally { client.close(); }
});

test('football-data verified inverted fixture maps stats and real odds by team, preserving source orientation', async () => {
  const client = await memoryDb();
  try {
    await insertMatch(client, 'psg-rennes', '2026-08-23', 'Ligue 1', 2);
    await client.execute("UPDATE matches SET home_team_name='Paris Saint Germain',away_team_name='Rennes',home_team_id='psg',away_team_id='rennes' WHERE match_id='psg-rennes'");
    const statements = [];
    const db = createLibsqlFootballDataDb({
      execute: (query) => client.execute(query),
      batch: (updates, mode) => { statements.push(...updates); return client.batch(updates, mode); },
    });
    const options = { competitions: ['Ligue 1'], seasonStartYears: [2026], fetcher: async () => invertedCsv };
    const sourceRow = parseFootballDataCsv(invertedCsv)[0];
    const result = await syncFootballData(db, options);
    assert.equal(result.allExpectedSeasonsComplete, true);
    assert.equal(result.matched, 1);
    assert.deepEqual(result.updatedTeamIds, ['psg', 'rennes']);
    const saved = (await client.execute("SELECT * FROM matches WHERE match_id='psg-rennes'")).rows[0];
    assert.equal(saved.home_team_name, 'Paris Saint Germain');
    assert.equal(saved.away_team_name, 'Rennes');
    assert.equal(saved.home_team_id, 'psg');
    assert.equal(saved.home_goals, 2);
    assert.deepEqual([
      saved.home_shots, saved.away_shots, saved.home_shots_on_target, saved.away_shots_on_target,
      saved.home_fouls, saved.away_fouls, saved.home_corners, saved.away_corners,
      saved.home_yellow_cards, saved.away_yellow_cards, saved.home_red_cards, saved.away_red_cards,
    ], [19, 9, 5, 3, 6, 7, 10, 0, 4, 2, 1, 0]);
    const odds = JSON.parse(saved.fd_odds_json);
    assert.deepEqual(odds.opening, { homeWin: 1.4, draw: 4.7, awayWin: 6.5 });
    assert.deepEqual(odds.closing, { homeWin: 1.5, draw: 4.6, awayWin: 6.2 });
    assert.deepEqual(odds.orientation, {
      mapping: 'by_team_identity', source: 'football-data.co.uk', sourceHomeTeam: 'Rennes', sourceAwayTeam: 'Paris SG',
      mappedHomeTeam: 'Paris Saint Germain', mappedAwayTeam: 'Rennes',
      officialReference: 'https://ligue1.com/fr/articles/l1_article_5699-j1-psg-rennes-inverse-l1-2627',
    });
    statements.length = 0;
    const repeat = await syncFootballData(db, options);
    assert.equal(repeat.matched, 1);
    assert.equal(repeat.updated, 0);
    assert.equal(repeat.oddsWritten, 0);
    assert.equal(statements.length, 0);
    assert.deepEqual(parseFootballDataCsv(invertedCsv)[0], sourceRow);
    assert.equal(sourceRow.sourceOrientation, undefined);
  } finally { client.close(); }
});

test('football-data already correctly oriented verified fixture uses unchanged source sides and no orientation metadata', async () => {
  const saved = [];
  const result = await syncFootballData({
    getMatchesForCompetition: async () => [{ match_id: 'rennes-psg', date: '2026-08-23',
      home_team_name: 'Rennes', away_team_name: 'Paris Saint Germain' }],
    fillSupplementalStats: async (_id, sourceRow) => { saved.push(sourceRow); return true; },
    saveMarketOdds: async () => false,
  }, { competitions: ['Ligue 1'], seasonStartYears: [2026], fetcher: async () => invertedCsv });
  assert.equal(result.allExpectedSeasonsComplete, true);
  assert.equal(saved[0].homeShots, 9);
  assert.equal(saved[0].oddsHome, 6.5);
  assert.equal(saved[0].sourceOrientation, undefined);
});

for (const variant of ['generic pair', 'other date', 'other competition', 'other season', 'ambiguous duplicates', 'incorrect result']) {
  test(`football-data inversion exception rejects ${variant}`, async () => {
    let source = invertedCsv;
    let competitions = ['Ligue 1'];
    let seasonStartYears = [2026];
    const matches = [{ match_id: 'psg-rennes', date: '2026-08-23', home_team_name: 'Paris Saint Germain', away_team_name: 'Rennes' }];
    if (variant === 'generic pair') {
      source = source.replace('Rennes,Paris SG', 'Alpha,Beta');
      matches[0].home_team_name = 'Beta'; matches[0].away_team_name = 'Alpha';
    }
    if (variant === 'other date') { source = source.replace('23/08/2026', '24/08/2026'); matches[0].date = '2026-08-24'; }
    if (variant === 'other competition') competitions = ['Serie A'];
    if (variant === 'other season') seasonStartYears = [2025];
    if (variant === 'ambiguous duplicates') matches.push({ ...matches[0], match_id: 'duplicate' });
    if (variant === 'incorrect result') source = source.replace(',2,2,9,', ',0,0,9,');
    const result = await syncFootballData({
      getMatchesForCompetition: async () => matches,
      fillSupplementalStats: async () => { assert.fail('must not write rejected fixture'); },
      saveMarketOdds: async () => { assert.fail('must not write rejected fixture'); },
    }, { competitions, seasonStartYears, fetcher: async () => source, now: new Date('2026-10-03T12:00:00Z') });
    assert.equal(result.allExpectedSeasonsReady, false);
    assert.equal(result.matched, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.oddsWritten, 0);
  });
}
