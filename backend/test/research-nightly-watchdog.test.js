const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { expectedSchedule, inspectGithub, inspectDatabase } = require('../scripts/check-research-nightly');

const NOW = new Date('2026-10-29T08:00:00Z');
const run = (overrides = {}) => ({ id: 123, event: 'schedule', display_title: 'Nightly Sync (0 2 * * *)',
  created_at: '2026-10-29T02:20:00Z', status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/repo/actions/runs/123', ...overrides });
const github = (runs, options = {}) => inspectGithub({ now: NOW, token: 'fixture-only', repository: 'fixture/repo', expectScheduled: true,
  fetchImpl: async (url, request) => {
    assert.equal(request.headers.Authorization, 'Bearer fixture-only');
    assert.equal(url.includes('fixture-only'), false);
    assert.equal(request.redirect, 'error');
    return new Response(JSON.stringify({ workflow_runs: runs }));
  }, ...options });

test('GitHub-only watchdog catches missing scheduled run independently of Hostless, DB and provider', async () => {
  assert.deepEqual((await github([])).issues, ['github_nightly_missing']);
  assert.deepEqual((await github([run()])).issues, []);
  assert.deepEqual((await github([run({ display_title: 'Nightly Sync (0 1 * * *)' })])).issues, ['github_nightly_missing']);
  assert.deepEqual((await github([], { expectScheduled: false })).issues, []);
  const beforeGrace = new Date('2026-10-29T05:59:59Z');
  assert.deepEqual((await github([], { now: beforeGrace })).issues, []);
});

test('GitHub watchdog reports failure, queued jobs beyond grace and accepts a current manual recovery', async () => {
  assert.deepEqual((await github([run({ conclusion: 'failure' })])).issues, ['github_nightly_failed']);
  assert.deepEqual((await github([run({ status: 'queued', conclusion: null })])).issues, ['github_nightly_stalled']);
  assert.deepEqual((await github([run({ event: 'workflow_dispatch', display_title: 'manual recovery' })])).issues, []);
  assert.deepEqual((await github([run({ event: 'workflow_dispatch', created_at: '2026-10-29T07:59:00Z', status: 'queued', conclusion: null })])).issues, []);
  assert.deepEqual((await github([run({ conclusion: 'skipped' })])).issues, ['github_nightly_failed']);
  await assert.rejects(github([], { repository: '../invalid' }), /github_configuration_missing/);
});

test('GitHub watchdog chooses the active Rome schedule across daylight saving changes', () => {
  assert.equal(expectedSchedule(new Date('2026-03-29T06:00:00Z')).cron, '0 1 * * *');
  assert.equal(expectedSchedule(new Date('2026-10-25T06:00:00Z')).cron, '0 2 * * *');
  assert.equal(expectedSchedule(new Date('2026-03-28T23:00:00Z')).expectedAt, '2026-03-28T02:00:00.000Z');
});

async function database() {
  const db = createClient({ url: ':memory:' });
  for (const name of ['015_research_platform.sql', '018_smart_odds.sql']) {
    await db.executeMultiple(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
  }
  await db.executeMultiple(`CREATE TABLE scheduler_runs(scheduler_name TEXT,started_at TEXT,ended_at TEXT,success INTEGER,error TEXT,summary_json TEXT);
    CREATE TABLE matches(match_id TEXT,home_goals INTEGER,away_goals INTEGER);`);
  return db;
}

test('database watchdog is SELECT-only and never requires a retired heartbeat or scans predictions', async () => {
  const db = await database();
  try {
    await db.execute({ sql: 'INSERT INTO scheduler_runs VALUES (?,?,?,?,?,?)', args: ['research_nightly', '2026-10-29T02:20:00Z',
      '2026-10-29T03:00:00Z', 1, null, JSON.stringify({ analyzedMatches: 8, registeredBets: 0, skippedMatches: 8, apiErrors: 0 })] });
    const checked = { execute: async (query) => {
      const sql = typeof query === 'string' ? query : query.sql;
      assert.match(sql.trim(), /^SELECT\b/i);
      assert.doesNotMatch(sql, /predictions|worker_state/i);
      return db.execute(query);
    } };
    const result = await inspectDatabase(checked, { now: NOW, expectEnabled: true });
    assert.equal(result.ok, true);
    assert.equal(result.nightly.metrics.analyzedMatches, 8);
    assert.equal(result.nightly.metrics.registeredBets, 0);
    assert.equal(result.delivery.externalConfigured, false);
  } finally { db.close(); }
});

test('database watchdog flags missed nightly and ledger integrity without initializing portfolios', async () => {
  const db = await database();
  try {
    const missing = await inspectDatabase(db, { now: NOW, expectEnabled: true });
    assert.deepEqual(missing.issues, ['nightly_execution_missing']);
    await db.execute("INSERT INTO research_portfolios VALUES ('shadow_A','A','2026-10-01T00:00:00Z')");
    assert.deepEqual((await inspectDatabase(db, { now: NOW })).issues, ['virtual_accounting_integrity']);
    assert.equal((await db.execute('SELECT COUNT(*) AS count FROM research_ledger')).rows[0].count, 0);
  } finally { db.close(); }
});


test('existing recent stalled runs alert without schedule expectations, while recent, future and historical queues do not', async () => {
  const queued = run({ status: 'queued', conclusion: null });
  const stale = await github([queued], { expectScheduled: false });
  assert.deepEqual(stale.issues, ['github_nightly_stalled']);
  assert.equal(stale.stalledRun.id, queued.id);
  assert.deepEqual((await github([run({ id: 124, created_at: '2026-10-29T07:50:00Z' }), queued], { expectScheduled: false })).issues,
    ['github_nightly_stalled']);
  for (const created_at of ['2026-10-29T07:45:00Z', '2026-10-29T09:00:00Z', '2026-10-27T18:00:00Z']) {
    assert.deepEqual((await github([run({ status: 'queued', conclusion: null, created_at })], { expectScheduled: false })).issues, []);
  }
  const previousManual = run({ event: 'workflow_dispatch', created_at: '2026-10-28T23:00:00Z', status: 'in_progress', conclusion: null });
  assert.deepEqual((await github([previousManual], { expectScheduled: false })).issues, ['github_nightly_stalled']);
  assert.deepEqual((await github([], { expectScheduled: true })).issues, ['github_nightly_missing']);
});

test('first activation can inspect valid independent wallets before any database run without expecting an earlier nightly', async () => {
  const db = await database();
  try {
    for (const family of ['A', 'C']) {
      await db.execute({ sql: 'INSERT INTO research_portfolios VALUES (?,?,?)', args: [`shadow_${family}`, family, '2026-10-29T07:00:00Z'] });
      await db.execute({ sql: 'INSERT INTO research_ledger VALUES (?,?,NULL,?,?,?,?)',
        args: [`open:${family}`, `shadow_${family}`, 'OPEN', 100000, 0, '2026-10-29T07:00:00Z'] });
    }
    const checked = { execute: (query) => {
      assert.match((typeof query === 'string' ? query : query.sql).trim(), /^SELECT\b/i);
      return db.execute(query);
    } };
    const waiting = await inspectDatabase(checked, { now: NOW, expectEnabled: false });
    assert.equal(waiting.ok, true); assert.deepEqual(waiting.issues, []);
    assert.equal(waiting.nightly.lastRun, null); assert.equal(waiting.nightly.metrics.registeredBets, null);
    assert.deepEqual(waiting.accounting, { stable: true, checked: true, errors: 0 });
    assert.deepEqual((await inspectDatabase(checked, { now: NOW, expectEnabled: true })).issues, ['nightly_execution_missing']);
    assert.equal((await db.execute('SELECT COUNT(*) AS count FROM research_ledger')).rows[0].count, 2);
  } finally { db.close(); }
});

test('observed database failures, API errors and exhausted quota remain visible with schedule expectations off', async () => {
  const db = await database();
  try {
    await db.execute({ sql: 'INSERT INTO scheduler_runs VALUES (?,?,?,?,?,?)', args: ['research_nightly', '2026-10-29T02:20:00Z',
      '2026-10-29T03:00:00Z', 0, 'nightly_execution_failed', JSON.stringify({ apiErrors: 3 })] });
    assert.deepEqual((await inspectDatabase(db, { now: NOW, expectEnabled: false })).issues, ['nightly_execution_failed', 'nightly_api_errors']);
    for (const [started, ended] of [['2026-10-27T18:00:00Z', '2026-10-27T19:00:00Z'],
      ['2026-10-30T02:00:00Z', '2026-10-30T03:00:00Z'], ['2026-10-29T02:20:00Z', '2026-10-30T03:00:00Z']]) {
      await db.execute({ sql: 'UPDATE scheduler_runs SET started_at=?,ended_at=?', args: [started, ended] });
      assert.deepEqual((await inspectDatabase(db, { now: NOW, expectEnabled: false })).issues, []);
    }
    await db.execute({ sql: 'INSERT INTO smart_odds_budgets VALUES (?,?,?,?,?,?,?,?)',
      args: ['odds_api', 'primary', '2026-10', 500, 0, 0, NOW.toISOString(), 1] });
    assert.deepEqual((await inspectDatabase(db, { now: NOW, expectEnabled: false })).issues, ['nightly_odds_credits_exhausted']);
  } finally { db.close(); }
});


for (const change of [
  { label: 'spring', now: '2026-03-29T06:00:00Z', previous: '2026-03-28T02:03:00Z',
    previousCron: '0 2 * * *', activeCron: '0 1 * * *', beforeThree: '2026-03-29T00:30:00Z' },
  { label: 'autumn', now: '2026-10-25T06:00:00Z', previous: '2026-10-24T01:03:00Z',
    previousCron: '0 1 * * *', activeCron: '0 2 * * *', beforeThree: '2026-10-25T00:30:00Z' },
]) test(`historically active queues survive the ${change.label} DST transition without admitting inactive triggers`, async () => {
  const now = new Date(change.now);
  const old = run({ id: 200, created_at: change.previous, display_title: `Nightly Sync (${change.previousCron})`,
    status: 'queued', conclusion: null });
  const success = run({ id: 201, created_at: `${change.now.slice(0, 10)}T05:30:00Z`, display_title: `Nightly Sync (${change.activeCron})` });
  const inspect = (runs, expectScheduled = false) => github(runs, { now, expectScheduled });
  assert.deepEqual((await inspect([old])).issues, ['github_nightly_stalled']);
  const withSuccess = await inspect([success, old]);
  assert.deepEqual(withSuccess.issues, ['github_nightly_stalled']);
  assert.equal(withSuccess.lastRun.id, success.id); assert.equal(withSuccess.stalledRun.id, old.id);
  const inactiveOld = { ...old, display_title: `Nightly Sync (${change.activeCron})` };
  assert.deepEqual((await inspect([success, inactiveOld])).issues, []);
  // On the transition date, checking before 03:00 against the previous expected
  // schedule would accidentally accept the wrong cron for that date.
  const earlyActive = { ...old, id: 202, created_at: change.beforeThree, display_title: `Nightly Sync (${change.activeCron})` };
  const earlyInactive = { ...earlyActive, display_title: `Nightly Sync (${change.previousCron})` };
  assert.deepEqual((await inspect([earlyActive])).issues, ['github_nightly_stalled']);
  assert.deepEqual((await inspect([earlyInactive])).issues, []);
  assert.deepEqual((await github([earlyActive], { now: new Date(Date.parse(change.beforeThree) + 60000),
    expectScheduled: true })).issues, ['github_nightly_missing']);
  const missing = await github([old], { now: new Date(now.getTime() + 1000), expectScheduled: true });
  assert.deepEqual(missing.issues, ['github_nightly_missing', 'github_nightly_stalled']);
  assert.deepEqual((await inspect([success, old], true)).issues, ['github_nightly_stalled']);
});
