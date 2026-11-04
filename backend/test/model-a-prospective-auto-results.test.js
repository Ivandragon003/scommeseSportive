const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createClient } = require('@libsql/client');
const { DatabaseService } = require('../dist/db/DatabaseService');
const { startModelAProspectiveRecovery, stopModelAProspectiveRecovery, drainModelAProspective } = require('../dist/research/ModelAProspectiveRecorder');

async function eventually(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('automatic result reconciliation did not finish');
}

test('the periodic loop discovers new final evidence and corrections without manual reconciliation', async t => {
  const previous = { enabled: process.env.MODEL_A_PROSPECTIVE_ENABLED, spool: process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR };
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true'; delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;
  const db = createClient({ url: 'file::memory:' });
  t.after(async () => {
    stopModelAProspectiveRecovery();
    await drainModelAProspective(1000);
    db.close();
    for (const [key, value] of [['MODEL_A_PROSPECTIVE_ENABLED', previous.enabled], ['MODEL_A_PROSPECTIVE_SPOOL_DIR', previous.spool]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await db.executeMultiple(readFileSync(join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
  await db.executeMultiple(`CREATE TABLE teams(team_id TEXT PRIMARY KEY, source_team_id INTEGER);
    CREATE TABLE matches(match_id TEXT PRIMARY KEY, home_team_id TEXT, away_team_id TEXT, competition TEXT,
      season TEXT, source TEXT, source_match_id INTEGER, date TEXT, home_goals INTEGER, away_goals INTEGER, raw_json TEXT);
    INSERT INTO teams VALUES ('home',1),('away',2);`);
  const now = Date.now(), kickoff = new Date(now - 7200000).toISOString();
  await db.execute({ sql: 'INSERT INTO matches VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL)',
    args: ['understat_777', 'home', 'away', 'Serie A', '2026/2027', 'understat', 777, kickoff] });
  const payload = JSON.stringify({ homeTeamId: 'home', awayTeamId: 'away', competition: 'Serie A', season: '2026/2027' });
  await db.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)',
    args: ['immutable-before-kickoff', 'understat_777', new Date(now - 10800000).toISOString(), kickoff, payload] });
  const wrapper = { execute: (sql, args) => db.execute({ sql, args }),
    all: async (sql, args) => (await db.execute({ sql, args })).rows,
    get: async (sql, args) => (await db.execute({ sql, args })).rows[0] };
  let scans = 0;
  const sink = {
    getModelAProspectiveResultCandidates: async options => {
      scans++;
      return DatabaseService.prototype.getModelAProspectiveResultCandidates.call(wrapper, options);
    },
    appendModelAProspectiveResult: event => DatabaseService.prototype.appendModelAProspectiveResult.call(wrapper, event),
  };
  const count = async () => Number((await db.execute('SELECT COUNT(*) AS n FROM model_a_prospective_results')).rows[0].n);
  const update = async (homeGoals, observedAt) => {
    const raw = { match: { id: '777', h: { id: '1' }, a: { id: '2' }, datetime: kickoff,
      isResult: true, goals: { h: String(homeGoals), a: '1' } }, resultObservation: { source: 'understat', observedAt } };
    await db.execute({ sql: 'UPDATE matches SET home_goals=?,away_goals=1,raw_json=? WHERE match_id=?',
      args: [homeGoals, JSON.stringify(raw), 'understat_777'] });
  };
  startModelAProspectiveRecovery(sink, 25);
  await eventually(() => scans >= 2);
  assert.equal(await count(), 0);
  await update(2, new Date(now - 60000).toISOString());
  await eventually(async () => (await count()) === 1);
  const afterFirst = scans;
  await eventually(() => scans >= afterFirst + 2);
  assert.equal(await count(), 1, 'the same evidence remains idempotent across timer ticks');
  await update(3, new Date(now - 30000).toISOString());
  await eventually(async () => (await count()) === 2);
  stopModelAProspectiveRecovery();
  assert.equal(await drainModelAProspective(1000), true);
  assert.deepEqual((await db.execute('SELECT home_goals FROM model_a_prospective_results ORDER BY observed_at')).rows.map(row => row.home_goals), [2, 3]);
  assert.equal((await db.execute('SELECT payload_json FROM model_a_prospective_forecasts')).rows[0].payload_json, payload);
});
