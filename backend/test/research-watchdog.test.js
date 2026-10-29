const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { inspectWorker } = require('../scripts/check-research-worker');

const NOW = new Date('2026-10-27T12:00:00.000Z');
async function setup() {
  const db = createClient({ url: ':memory:' });
  for (const name of ['015_research_platform.sql', '018_smart_odds.sql', '019_research_worker.sql']) {
    await db.executeMultiple(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
  }
  await db.executeMultiple(`CREATE TABLE scheduler_runs (scheduler_name TEXT, started_at TEXT, ended_at TEXT, success INTEGER, error TEXT, summary_json TEXT);
    CREATE TABLE matches (match_id TEXT, home_goals INTEGER, away_goals INTEGER);`);
  return db;
}

async function running(db, overrides = {}) {
  const value = { enabled: 1, heartbeat: NOW.toISOString(), tick: NOW.toISOString(), lease: '2026-10-27T12:00:30.000Z', ...overrides };
  await db.execute({ sql: `INSERT OR REPLACE INTO research_worker_state
    (scheduler,owner_id,lease_token,lease_expires_at,heartbeat_at,last_tick_at,last_tick_json,last_error,enabled,updated_at)
    VALUES ('research_t15','fixture-owner','fixture-token',?,?,?,'{}',?,?,?)`,
  args: [value.lease, value.heartbeat, value.tick, value.error ?? null, value.enabled, NOW.toISOString()] });
}

test('external watchdog detects fresh worker without a backend, and every SQL operation is SELECT', async () => {
  const db = await setup();
  try {
    await running(db);
    const checked = { execute: async (query) => {
      const sql = typeof query === 'string' ? query : query.sql;
      assert.match(sql.trim(), /^SELECT\b/i);
      return db.execute(query);
    } };
    const result = await inspectWorker(checked, { now: NOW, expectEnabled: true });
    assert.equal(result.ok, true);
    assert.equal(result.worker.state, 'RUNNING');
    assert.equal(result.worker.heartbeatAgeSeconds, 0);
    assert.deepEqual(result.odds.providers, []);
    assert.equal(result.settlements.completedMatchesAwaitingSettlement, 0);
  } finally { db.close(); }
});

test('watchdog fails stale heartbeat, expired lease and stalled tick even if process flag says enabled', async () => {
  const db = await setup();
  try {
    await running(db, { heartbeat: '2026-10-27T11:59:00.000Z', tick: '2026-10-27T11:58:00.000Z', lease: '2026-10-27T11:59:30.000Z' });
    const result = await inspectWorker(db, { now: NOW, expectEnabled: true });
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues, ['worker_heartbeat_stale', 'worker_tick_stalled', 'worker_lease_expired']);
    assert.equal(result.worker.state, 'DEGRADED');
  } finally { db.close(); }
});

test('watchdog distinguishes intentionally disabled, never started and unexpectedly stopped worker', async () => {
  const db = await setup();
  try {
    assert.equal((await inspectWorker(db, { now: NOW })).worker.state, 'UNOBSERVED');
    assert.deepEqual((await inspectWorker(db, { now: NOW, expectEnabled: true })).issues, ['worker_never_observed']);
    await running(db, { enabled: 0 });
    assert.equal((await inspectWorker(db, { now: NOW })).ok, true);
    assert.deepEqual((await inspectWorker(db, { now: NOW, expectEnabled: true })).issues, ['worker_disabled']);
  } finally { db.close(); }
});

test('watchdog reports repeated failures without leaking arbitrary error messages', async () => {
  const db = await setup();
  try {
    await running(db, { error: 'https://private.invalid/?apiKey=fixture-secret' });
    for (let index = 0; index < 3; index++) await db.execute({ sql: 'INSERT INTO scheduler_runs (scheduler_name,started_at,ended_at,success,error) VALUES (?,?,?,?,?)',
      args: ['research_provider', `2026-10-27T11:59:0${index}.000Z`, NOW.toISOString(), 0, 'fixture transport secret'] });
    const result = await inspectWorker(db, { now: NOW });
    assert.equal(result.ok, false);
    assert.deepEqual(result.persistentErrors, ['research_provider']);
    assert.equal(result.worker.lastError, 'unclassified_error');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally { db.close(); }
});

async function job(db, id, target, status, reason = null) {
  await db.execute({ sql: `INSERT INTO research_jobs (id,match_id,kickoff_at,target_at,status,reason,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, args: [id, id, new Date(Date.parse(target) + 900_000).toISOString(), target, status, reason, target, target] });
}

test('active watchdog detects recent missed and stranded decision windows without counting historical or future jobs', async () => {
  const db = await setup();
  try {
    await running(db);
    await job(db, 'missed', '2026-10-27T11:50:00Z', 'MISSED');
    await job(db, 'stranded', '2026-10-27T11:55:00+00:00', 'CLAIMED');
    await job(db, 'old', '2026-10-26T11:50:00Z', 'MISSED');
    await job(db, 'future', '2026-10-27T12:05:00Z', 'PENDING');
    await job(db, 'in-window', '2026-10-27T11:59:30Z', 'PENDING');
    await job(db, 'abstention', '2026-10-27T11:45:00Z', 'COMPLETED');
    const result = await inspectWorker(db, { now: NOW, expectEnabled: true });
    assert.deepEqual(result.issues, ['scheduler_missed_decisions']);
    assert.equal(result.missedDecisions.recentHour, 2);
    await running(db, { enabled: 0 });
    assert.equal((await inspectWorker(db, { now: NOW })).ok, true);
  } finally { db.close(); }
});

test('exhausted shared credits alert only while automation is enabled or expected', async () => {
  const db = await setup();
  try {
    await db.executeMultiple(`INSERT INTO smart_odds_budgets
      (provider,account_scope,month,measured_used,measured_remaining,reset_confirmed)
      VALUES ('odds_api','fixture-only','2026-10',500,0,1);`);
    assert.equal((await inspectWorker(db, { now: NOW })).ok, true);
    await running(db);
    assert.deepEqual((await inspectWorker(db, { now: NOW })).issues, ['odds_credits_exhausted']);
    await db.execute('UPDATE smart_odds_budgets SET measured_used=499,measured_remaining=1');
    assert.equal((await inspectWorker(db, { now: NOW })).ok, true);
  } finally { db.close(); }
});

test('prolonged odds outage requires observed demand and clears after a usable snapshot', async () => {
  const db = await setup();
  try {
    await running(db);
    assert.equal((await inspectWorker(db, { now: NOW })).ok, true);
    await job(db, 'first-empty', '2026-10-27T11:40:00Z', 'SKIPPED', 'fixture_unknown');
    assert.equal((await inspectWorker(db, { now: NOW })).ok, true);
    await job(db, 'second-empty', '2026-10-27T11:55:00Z', 'SKIPPED', 'fixture_unknown');
    const outage = await inspectWorker(db, { now: NOW });
    assert.deepEqual(outage.issues, ['odds_unavailable_prolonged']);
    assert.equal(outage.quoteAvailability.absenceSeconds, 900);
    const at = '2026-10-27T11:56:00Z';
    await db.execute({ sql: 'INSERT INTO research_inputs VALUES (?,?,?,?,?,?)', args: ['input', 'second-empty', 'fixture-hash',
      JSON.stringify({ quotes: [{ odds: 1.9, bookmaker: 'Fixture bookmaker', source: 'odds_api', capturedAt: at, updatedAt: at }] }), at, at] });
    const recovered = await inspectWorker(db, { now: NOW });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.quoteAvailability.lastUsableAt, at);
    // A fresh HTTP timestamp cannot make a stale bookmaker price a recovery.
    await db.execute({ sql: 'UPDATE research_inputs SET snapshot_json=?', args: [JSON.stringify({ quotes: [
      { odds: 1.9, bookmaker: 'Fixture bookmaker', source: 'odds_api', capturedAt: at, updatedAt: '2026-10-27T11:00:00Z' },
    ] })] });
    assert.ok((await inspectWorker(db, { now: NOW })).issues.includes('odds_unavailable_prolonged'));
    await running(db, { enabled: 0 });
    assert.equal((await inspectWorker(db, { now: NOW })).ok, true);
  } finally { db.close(); }
});

test('three recent model failures are grouped by family and version and cannot be hidden by A successes', async () => {
  const db = await setup();
  try {
    await running(db);
    const insert = async (at, family, version, success) => db.execute({ sql: `INSERT INTO scheduler_runs
      (scheduler_name,started_at,ended_at,success,error,summary_json) VALUES ('research_model_check',?,?,?,?,?)`,
    args: [at, at, success, success ? null : 'fixture private token', JSON.stringify({ family, modelVersion: version, private: 'fixture private token' })] });
    for (const minute of ['40', '45', '50']) await insert(`2026-10-27T11:${minute}:00Z`, 'C', 'C-fixture', 0);
    for (let index = 0; index < 40; index++) await db.execute({ sql: `INSERT INTO scheduler_runs
      (scheduler_name,started_at,ended_at,success) VALUES ('research_t15',?,?,1)`, args: [NOW.toISOString(), NOW.toISOString()] });
    await insert('2026-10-27T11:55:00Z', 'A', 'A-fixture', 1);
    await insert('2026-10-27T11:56:00Z', 'C', 'C-other', 1);
    const result = await inspectWorker(db, { now: NOW });
    assert.deepEqual(result.issues, ['persistent_model_errors']);
    assert.deepEqual(result.modelFailures, [{ family: 'C', failures: 3 }]);
    assert.equal(JSON.stringify(result).includes('private token'), false);
    await insert('2026-10-27T11:57:00Z', 'C', 'C-fixture', 1);
    assert.equal((await inspectWorker(db, { now: NOW })).ok, true);
    await db.execute("UPDATE scheduler_runs SET ended_at='2026-10-26T12:00:00Z' WHERE scheduler_name='research_model_check'");
    assert.equal((await inspectWorker(db, { now: NOW })).ok, true);
  } finally { db.close(); }
});

test('empty provider responses trigger a sustained outage while stopped automation ignores old operational failures', async () => {
  const db = await setup();
  try {
    await running(db);
    for (const minute of ['30', '40', '50']) await db.execute({ sql: `INSERT INTO scheduler_runs
      (scheduler_name,started_at,ended_at,success,summary_json) VALUES ('research_provider',?,?,?,?)`,
    args: [`2026-10-27T11:${minute}:00Z`, `2026-10-27T11:${minute}:00Z`, 1, JSON.stringify({ eventCount: 0 })] });
    assert.deepEqual((await inspectWorker(db, { now: NOW })).issues, ['odds_unavailable_prolonged']);
    await db.execute("UPDATE scheduler_runs SET success=0 WHERE scheduler_name='research_provider'");
    await running(db, { enabled: 0 });
    assert.equal((await inspectWorker(db, { now: NOW })).ok, true);
    await db.execute("UPDATE scheduler_runs SET scheduler_name='research_settlement'");
    assert.deepEqual((await inspectWorker(db, { now: NOW })).issues, ['persistent_scheduler_errors']);
  } finally { db.close(); }
});

test('watchdog reports decision delay, skipped jobs, quota and an unprocessed settlement backlog', async () => {
  const db = await setup();
  try {
    await running(db);
    await db.executeMultiple(`INSERT INTO research_jobs (id,match_id,kickoff_at,target_at,status,reason,created_at,updated_at)
      VALUES ('fixture-job','fixture-match','2026-10-27T12:15:00Z','2026-10-27T12:00:00Z','SKIPPED','quote_stale','2026-10-27T12:00:00Z','2026-10-27T12:00:15Z');
      INSERT INTO research_portfolios VALUES ('shadow_A','A','2026-10-01T00:00:00Z');
      INSERT INTO research_inputs VALUES ('fixture-input','fixture-job','fixture-hash','{}','2026-10-27T12:00:00Z','2026-10-27T12:15:00Z');
      INSERT INTO research_decisions VALUES ('fixture-decision','fixture-job','fixture-input','A','test-only','1x2','homeWin','shadow_A','BET',NULL,'{}','2026-10-27T12:00:15Z');
      INSERT INTO research_bets VALUES ('fixture-bet','fixture-decision','shadow_A','fixture-match','A','test-only','1x2','homeWin',1.9,1000,'{}','2026-10-27T12:00:15Z');
      INSERT INTO matches VALUES ('fixture-match',2,0);
      INSERT INTO smart_odds_budgets (provider,account_scope,month,measured_used,measured_remaining,reset_confirmed)
      VALUES ('odds_api','test-only','2026-10',7,493,1);`);
    const result = await inspectWorker(db, { now: NOW });
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes('settlement_backlog'));
    assert.equal(result.latestDecisions[0].lagSeconds, 15);
    assert.equal(result.jobs.find((job) => job.status === 'SKIPPED').reason, 'quote_stale');
    assert.equal(result.settlements.completedMatchesAwaitingSettlement, 1);
    assert.equal(result.odds.providers[0].monthlyLimit, 500);
    assert.equal(result.odds.providers[0].reserveCredits, 50);
    assert.equal(result.odds.providers[0].availableCredits, 493);
  } finally { db.close(); }
});

test('watchdog workflow monitors nightly independently and uses a dedicated read-only database token', () => {
  const workflow = readFileSync(join(__dirname, '../../.github/workflows/research-watchdog.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /^\s+schedule:/m);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /check-research-nightly\.js/);
  assert.doesNotMatch(workflow, /node scripts\/check-research-worker\.js/);
  assert.match(workflow, /secrets\.TURSO_WATCHDOG_READONLY_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.TURSO_AUTH_TOKEN/);
  const script = readFileSync(join(__dirname, '../scripts/check-research-worker.js'), 'utf8');
  assert.doesNotMatch(script, /require\(['"].*DatabaseService/);
});
