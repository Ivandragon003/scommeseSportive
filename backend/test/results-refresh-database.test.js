const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { DatabaseService } = require('../dist/db/DatabaseService');

async function fixture(t) {
  const client = createClient({ url: 'file::memory:' });
  t.after(() => client.close());
  const fields = ['match_id', 'home_team_id', 'away_team_id', 'home_team_name', 'away_team_name', 'date',
    'home_goals', 'away_goals', 'home_xg', 'away_xg', 'home_shots', 'away_shots', 'home_shots_on_target', 'away_shots_on_target',
    'home_possession', 'away_possession', 'home_fouls', 'away_fouls', 'home_yellow_cards', 'away_yellow_cards',
    'home_red_cards', 'away_red_cards', 'home_corners', 'away_corners', 'referee', 'competition', 'season', 'source', 'source_match_id', 'created_at', 'raw_json'];
  await client.execute(`CREATE TABLE matches (${fields.map((key) => `${key} ${/goals|_xg|shots|corners|cards/.test(key) ? 'REAL' : 'TEXT'}`).join(',')})`);
  const db = Object.create(DatabaseService.prototype); db.db = client; db.initPromise = Promise.resolve();
  const now = new Date(); const kickoff = new Date(now.getTime() - 4 * 3600000).toISOString();
  const row = { match_id: 'understat_31652', source_match_id: '31652', home_team_id: 'home', away_team_id: 'away',
    date: kickoff, source: 'understat', competition: 'Serie A', season: '2026/2027', home_shots: 12,
    raw_json: JSON.stringify({ match: { id: '31652', isResult: false, keep: 'match-value' }, details: { keep: 'details-value' } }) };
  const insert = async (value) => client.execute({ sql: `INSERT INTO matches (${Object.keys(value).join(',')}) VALUES (${Object.keys(value).map(() => '?').join(',')})`, args: Object.values(value) });
  await insert(row);
  const input = { matchId: row.match_id, sourceMatchId: 31652, expectedHomeTeamId: 'home', expectedAwayTeamId: 'away',
    expectedCompetition: 'Serie A', expectedSeason: '2026/2027', expectedKickoffAt: kickoff,
    homeGoals: 2, awayGoals: 1, homeXg: 2.75, source: 'understat', observedAt: now.toISOString(),
    rawSource: { id: '31652', isResult: true, goals: { h: '2', a: '1' }, xG: { h: '2.75', a: null } } };
  return { db, client, row, input, insert, now };
}

test('verified final update preserves kickoff, identities, observed statistics and raw wrapper', async (t) => {
  const f = await fixture(t); assert.equal((await f.db.applyVerifiedFinalResult(f.input)).updated, true);
  const after = await f.db.getMatchById(f.row.match_id);
  assert.equal(after.home_goals, 2); assert.equal(after.away_goals, 1); assert.equal(after.home_xg, 2.75);
  assert.equal(after.away_xg, null); assert.equal(after.home_shots, 12); assert.equal(after.date, f.row.date);
  const raw = JSON.parse(after.raw_json);
  assert.equal(raw.match.keep, 'match-value'); assert.equal(raw.details.keep, 'details-value');
  assert.equal(raw.resultObservation.observedAt, f.input.observedAt);
  assert.equal((await f.db.applyVerifiedFinalResult(f.input)).reason, 'result_already_present');
});

test('results adapter rejects source-score mismatch, changed identities and future observations', async (t) => {
  const f = await fixture(t);
  for (const change of [{ homeGoals: 4 }, { expectedHomeTeamId: 'other' }, { expectedSeason: '2025/2026' },
    { sourceMatchId: 9 }, { observedAt: new Date(Date.now() + 60000).toISOString() }]) {
    assert.equal((await f.db.applyVerifiedFinalResult({ ...f.input, ...change })).updated, false);
  }
  assert.equal((await f.db.getMatchById(f.row.match_id)).home_goals, null);
});

test('source identity changing between read and write cannot receive a stale result', async (t) => {
  const f = await fixture(t); const originalExecute = f.db.execute.bind(f.db); let changed = false;
  f.db.execute = async (sql, args, skip) => {
    if (!changed && sql.startsWith('UPDATE matches SET home_goals')) {
      changed = true; await f.client.execute("UPDATE matches SET source_match_id='999'");
    }
    return originalExecute(sql, args, skip);
  };
  assert.equal((await f.db.applyVerifiedFinalResult(f.input)).updated, false);
  assert.equal((await f.db.getMatchById(f.row.match_id)).home_goals, null);
});

test('results scan is bounded to unfinished Understat matches in its verified time window', async (t) => {
  const f = await fixture(t);
  await f.insert({ ...f.row, match_id: 'finished', home_goals: 1, away_goals: 0 });
  await f.insert({ ...f.row, match_id: 'old', date: new Date(f.now.getTime() - 80 * 3600000).toISOString() });
  await f.insert({ ...f.row, match_id: 'future', date: new Date(f.now.getTime() + 3600000).toISOString() });
  await f.insert({ ...f.row, match_id: 'supplement', source: 'football_data' });
  const rows = await f.db.getRecentUnfinishedMatches({ from: new Date(f.now.getTime() - 72 * 3600000).toISOString(),
    to: f.now.toISOString(), competitions: ['Serie A'], limit: 200 });
  assert.deepEqual(rows.map((row) => row.match_id), ['understat_31652']);
});

test('only the UI opt-in retains started matches without results; normal upcoming selection stays future-only', async (t) => {
  const f = await fixture(t);
  await f.insert({ ...f.row, match_id: 'future', date: new Date(f.now.getTime() + 3600000).toISOString() });
  const normal = await f.db.getUpcomingMatches({ nowIso: f.now.toISOString() });
  const calendar = await f.db.getUpcomingMatches({ nowIso: f.now.toISOString(), includeStartedWithoutResult: true });
  assert.deepEqual(normal.map((row) => row.match_id), ['future']);
  assert.deepEqual(calendar.map((row) => row.match_id), ['understat_31652', 'future']);
});
