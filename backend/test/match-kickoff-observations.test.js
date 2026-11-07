const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseService } = require('../dist/db/DatabaseService');

const date = '2026-10-25T16:15:00.000Z';
const wrongDate = '2026-10-24T15:15:00.000Z';
const fixture = { matchId: 'understat_32010', homeTeamId: 'h', awayTeamId: 'a',
  homeTeamName: 'Home', awayTeamName: 'Away', date, source: 'manual',
  homeTotalShots: 0, rawJson: '{"original":true}' };

async function setup() {
  process.env.TURSO_DATABASE_URL = 'file::memory:';
  process.env.TURSO_AUTH_TOKEN = 'local';
  const db = new DatabaseService();
  await db.initPromise;
  await db.upsertMatch(fixture);
  return db;
}

async function insertProof(db, kickoff = date, matchId = fixture.matchId) {
  return db.db.execute({
    sql: 'INSERT INTO match_kickoff_observations(match_id,kickoff_at,source,evidence_json,evidence_sha256) VALUES(?,?,?,?,?)',
    args: [matchId, kickoff, 'official', '{"document":"proof"}', 'a'.repeat(64)],
  });
}

test('kickoff proof matches a canonical stored date and is immutable with foreign keys disabled', async () => {
  const db = await setup();
  try {
    await assert.rejects(insertProof(db, wrongDate), /match_kickoff_observation_value_changed/);
    await assert.rejects(insertProof(db, date, 'missing'), /match_kickoff_observation_value_changed/);
    await db.db.execute({ sql: 'UPDATE matches SET date=? WHERE match_id=?', args: ['2026-10-25T16:15:00Z', fixture.matchId] });
    await assert.rejects(insertProof(db, '2026-10-25T16:15:00Z'), /CHECK constraint/);
    await db.db.execute({ sql: 'UPDATE matches SET date=? WHERE match_id=?', args: [date, fixture.matchId] });
    await insertProof(db);
    await assert.rejects(insertProof(db), /match_kickoff_observation_value_changed/);
    await assert.rejects(db.db.execute('UPDATE match_kickoff_observations SET source=\'other\''), /match_kickoff_observation_immutable/);
    await assert.rejects(db.db.execute('DELETE FROM match_kickoff_observations'), /match_kickoff_observation_immutable/);
    await db.db.execute('PRAGMA foreign_keys=OFF');
    await assert.rejects(db.db.execute("UPDATE matches SET date='2026-10-24'"), /match_kickoff_observation_locked/);
    await assert.rejects(db.db.execute("UPDATE matches SET match_id='other'"), /match_kickoff_observation_locked/);
    await assert.rejects(db.db.execute('DELETE FROM matches'), /match_kickoff_observation_locked/);
  } finally { await db.close(); }
});

test('imports log discordant kickoff while retaining protected date and updating other data', async () => {
  const db = await setup();
  try {
    await insertProof(db);
    await db.upsertMatch({ ...fixture, date: wrongDate, homeTotalShots: 4, rawJson: '{"new":true}' });
    const row = await db.getMatchById(fixture.matchId);
    assert.equal(row.date, date);
    assert.equal(row.home_shots, 4);
    assert.equal(row.away_shots, null);
    assert.equal(row.raw_json, '{"new":true}');
    const conflicts = (await db.db.execute('SELECT field,existing_value,attempted_value FROM final_observation_conflicts')).rows;
    assert.deepEqual(conflicts.map(row => [row.field, row.existing_value, row.attempted_value]), [['date', date, wrongDate]]);
    await db.upsertMatch({ ...fixture, date, homeTotalShots: null, awayTotalShots: 0 });
    const next = await db.getMatchById(fixture.matchId);
    assert.equal(next.home_shots, 4);
    assert.equal(next.away_shots, 0);
    assert.equal((await db.db.execute('SELECT * FROM final_observation_conflicts')).rows.length, 1);
  } finally { await db.close(); }
});

test('a failed import rolls back the conflict and every write within its batch', async () => {
  const db = await setup();
  try {
    await insertProof(db);
    await assert.rejects(db.upsertMatches([
      { ...fixture, date: wrongDate, homeTotalShots: 6 },
      { ...fixture, matchId: 'invalid', homeTeamId: null },
    ]), /Match batch failed/);
    const row = await db.getMatchById(fixture.matchId);
    assert.equal(row.date, date);
    assert.equal(row.home_shots, 0);
    assert.equal((await db.db.execute('SELECT * FROM final_observation_conflicts')).rows.length, 0);
    assert.equal(await db.getMatchById('invalid'), null);
  } finally { await db.close(); }
});

test('a conflicting provider date cannot create result evidence for the corrected fixture', async () => {
  const db = await setup();
  try {
    await db.db.execute("INSERT INTO teams(team_id,name,source_team_id) VALUES('h','Home',1),('a','Away',2)");
    await insertProof(db);
    const raw = { id: '32010', isResult: true, h: { id: '1', title: 'Home' }, a: { id: '2', title: 'Away' },
      datetime: '2026-10-24 15:15:00', goals: { h: '1', a: '0' }, xG: { h: '1.0', a: '0.2' } };
    await db.upsertMatch({ ...fixture, date: wrongDate, source: 'understat', sourceMatchId: 32010,
      homeGoals: 1, awayGoals: 0, homeXG: 1, awayXG: 0.2, rawJson: JSON.stringify(raw) });
    assert.equal((await db.db.execute('SELECT * FROM final_observations')).rows.length, 0);
  } finally { await db.close(); }
});

test('retention preserves seasons with either kind of proof and deletes unprotected seasons', async () => {
  const { pruneOldSeasons } = require('../dist/services/FootballDataService');
  const db = await setup();
  try {
    await db.db.execute("UPDATE matches SET season='2021/2022' WHERE match_id='understat_32010'");
    await insertProof(db);
    await db.upsertMatches([
      { ...fixture, matchId: 'old-unprotected', season: '2020/2021' },
      { ...fixture, matchId: 'old-final', season: '2019/2020' },
      { ...fixture, matchId: 'current', season: '2026/2027' },
    ]);
    await db.db.execute({
      sql: 'INSERT INTO final_observations(match_id,field,value,source,evidence_json,evidence_sha256) VALUES(?,?,?,?,?,?)',
      args: ['old-final', 'home_shots', 0, 'official', '{}', 'a'.repeat(64)],
    });
    const result = await pruneOldSeasons(db.db, 5, new Date('2026-11-07T10:00:00Z'));
    assert.deepEqual(result.seasonsProtected, ['2021/2022', '2019/2020']);
    assert.deepEqual(result.seasonsDeleted, ['2020/2021']);
    assert.equal(result.matchesDeleted, 1);
    assert.ok(await db.getMatchById('understat_32010'));
    assert.ok(await db.getMatchById('old-final'));
    assert.ok(await db.getMatchById('current'));
    assert.equal(await db.getMatchById('old-unprotected'), null);
  } finally { await db.close(); }
});
