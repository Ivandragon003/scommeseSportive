const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { mkdtempSync, rmdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const {
  QUERIES, targetFingerprint, selectOnly, readAccountSnapshot, oddsAccountPreflight,
} = require('../scripts/odds-account-preflight');

const now = new Date('2026-11-06T00:00:00Z');
const env = { TURSO_DATABASE_URL: 'libsql://isolated-test.invalid', ODDS_API_KEY: 'synthetic-key-never-sent' };
function duck(current = null, prior = null) {
  const statements = [];
  let closes = 0;
  return {
    statements, closes: () => closes,
    client: {
      execute: async (statement) => {
        assert.match(statement.sql, /^\s*SELECT\b/);
        statements.push(statement);
        if (statement.sql === QUERIES.current) return { rows: current ? [current] : [] };
        if (statement.sql === QUERIES.prior) return { rows: prior ? [prior] : [] };
        if (statement.sql === QUERIES.usage) return { rows: [{ requests: 0, charged: 0, reserved: 0, unknown_charged: 0, planned: 0, measured: 0 }] };
        if (statement.sql === QUERIES.carryover) return { rows: [{ credits: 0 }] };
        throw new Error('Unexpected statement');
      },
      close: () => { closes++; },
    },
  };
}

test('target hash is mandatory and checked before any client or application constructor', async () => {
  let clients = 0;
  const dependencies = {
    createClient: () => { clients++; throw new Error('Forbidden client'); },
    createDatabase: () => { throw new Error('Forbidden application constructor'); },
    createStore: () => { throw new Error('Forbidden store constructor'); },
  };
  await assert.rejects(oddsAccountPreflight({ env, now }, dependencies), /target_mismatch/);
  await assert.rejects(oddsAccountPreflight({ env, now, targetSha256: 'wrong' }, dependencies), /target_mismatch/);
  assert.equal(clients, 0);
});

test('nonexistent file targets are rejected before opening a client, avoiding implicit SQLite creation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'odds-account-target-'));
  try {
    const localEnv = { TURSO_DATABASE_URL: pathToFileURL(join(directory, 'missing.db')).href };
    let clients = 0;
    await assert.rejects(oddsAccountPreflight({ env: localEnv, targetSha256: targetFingerprint(localEnv.TURSO_DATABASE_URL) }, {
      createClient: () => { clients++; throw new Error('Forbidden creation'); },
    }), /local_target_missing/);
    assert.equal(clients, 0);
  } finally { rmdirSync(directory); }
});

test('default plan uses SELECT only, keeps primary scope and never exposes the configured key', async () => {
  const fixture = duck(null, { month: '2026-10' });
  const result = await oddsAccountPreflight({ env, now, targetSha256: targetFingerprint(env.TURSO_DATABASE_URL) }, {
    createClient: () => fixture.client,
  });
  assert.equal(result.mode, 'read-only-plan');
  assert.equal(result.configuredScope, 'primary');
  assert.equal(result.keyConfigured, true);
  assert.equal(result.accountIdentity, 'UNCONFIRMED');
  assert.equal(result.status, 'CURRENT_MONTH_MISSING');
  assert.equal(result.resetGate, 'would_inherit_prior_month_with_reset_unconfirmed');
  assert.equal(result.liveBalanceVerified, false);
  assert.equal(result.paidNetworkAuthorized, false);
  assert.equal(result.nextCheck.invoked, false);
  assert.equal(result.providerRequests, 0);
  assert.equal(result.databaseWrites, 0);
  assert.ok(fixture.statements.every((statement) => statement.args[1] === 'primary'));
  assert.ok(!JSON.stringify(result).includes(env.ODDS_API_KEY));
  assert.equal(fixture.closes(), 1);
});

test('unknown or future header observations never produce a green account or live balance', async () => {
  for (const header of [null, 'invalid', '2026-12-01T00:00:00Z']) {
    const fixture = duck({ measured_used: null, measured_remaining: null, header_observed_at: header, reset_confirmed: 1 });
    const result = await readAccountSnapshot(fixture.client, { ODDS_API_ACCOUNT_SCOPE: 'named' }, now);
    assert.equal(result.status, 'HEADER_UNAVAILABLE');
    assert.equal(result.keyConfigured, false);
    assert.equal(result.observation.headerAgeSeconds, null);
    assert.equal(result.observation.observedRemaining, null);
    assert.equal(result.liveBalanceVerified, false);
    assert.equal(result.paidNetworkAuthorized, false);
  }
});

test('real SQL aggregates preserve independent scopes, reservations, unknown charges and carryover', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.executeMultiple(`
      CREATE TABLE smart_odds_budgets(provider TEXT,account_scope TEXT,month TEXT,measured_used REAL,measured_remaining REAL,
        header_charged_anchor REAL,header_observed_at TEXT,reset_confirmed INTEGER);
      CREATE TABLE smart_odds_requests(id TEXT,provider TEXT,account_scope TEXT,month TEXT,expected_credits REAL);
      CREATE TABLE smart_odds_results(request_id TEXT,charged_credits REAL,measured_cost REAL,finished_at TEXT);
    `);
    await client.batch([
      { sql: 'INSERT INTO smart_odds_budgets VALUES(?,?,?,?,?,?,?,?)', args: ['odds_api', 'named', '2026-11', 353, 147, 353, '2026-11-04T19:17:29Z', 1] },
      { sql: 'INSERT INTO smart_odds_budgets VALUES(?,?,?,?,?,?,?,?)', args: ['odds_api', 'primary', '2026-11', 498, 2, 218, '2026-10-31T09:39:18Z', 0] },
      ...[['success', 'named', '2026-11', 10], ['inflight', 'named', '2026-11', 5], ['unknown', 'named', '2026-11', 4],
        ['prior-inflight', 'named', '2026-10', 3], ['other', 'primary', '2026-11', 2]].map(([id, scope, month, credits]) => ({
        sql: 'INSERT INTO smart_odds_requests VALUES(?,?,?,?,?)', args: [id, 'odds_api', scope, month, credits],
      })),
      ...[['success', 7, 7], ['unknown', 4, null], ['other', 2, 2]].map(([id, charged, measured]) => ({
        sql: 'INSERT INTO smart_odds_results VALUES(?,?,?,?)', args: [id, charged, measured, '2026-11-05T00:00:00Z'],
      })),
    ], 'write');
    const named = await readAccountSnapshot(client, { ...env, ODDS_API_ACCOUNT_SCOPE: 'named' }, now);
    const primary = await readAccountSnapshot(client, env, now);
    assert.equal(named.status, 'HISTORICAL_OBSERVATION_ONLY');
    assert.equal(named.observation.observedRemaining, 147);
    assert.ok(named.observation.headerAgeSeconds > 86400);
    assert.deepEqual([named.ledger.chargedCredits, named.ledger.reservedCredits, named.ledger.unknownChargedCredits,
      named.ledger.plannedCredits, named.ledger.carryoverCredits], [11, 5, 4, 19, 3]);
    assert.equal(named.accountIdentity, 'UNCONFIRMED');
    assert.equal(named.liveBalanceVerified, false);
    assert.equal(primary.status, 'RESET_UNCONFIRMED');
    assert.equal(primary.resetGate, 'paid_network_blocked_until_reset_confirmation');
    assert.equal(primary.ledger.chargedCredits, 2);
    assert.equal(primary.observation.observedRemaining, 2);
  } finally { client.close(); }
});

test('read-only guard rejects DDL, writes, PRAGMA and multiple statements without forwarding them', async () => {
  let executions = 0;
  const client = { execute: async () => { executions++; } };
  for (const sql of ['DELETE FROM smart_odds_requests', 'CREATE TABLE unexpected(id TEXT)', 'PRAGMA journal_mode=WAL', 'SELECT 1; INSERT INTO t VALUES(1)']) {
    await assert.rejects(selectOnly(client, { sql, args: [] }), /select_only/);
  }
  assert.equal(executions, 0);
});
