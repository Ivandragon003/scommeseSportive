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
