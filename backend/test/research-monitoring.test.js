const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchMonitoringStore, researchDailySummary, researchCriticalIncidents, readResearchMonitoring,
  reconcileResearchMonitoring } = require('../dist/research/ResearchMonitoring');

async function setup(t) {
  const path = join(tmpdir(), `footpredictor-monitor-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  await client.executeMultiple(readFileSync(join(__dirname, '../migrations/016_research_monitoring.sql'), 'utf8'));
  t.after(() => {
    client.close();
    // Native libSQL handles may outlive close() on Windows until finalization.
    if (process.platform === 'win32') return;
    try { rmSync(path, { force: true }); }
    catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
  });
  return { client, store: new ResearchMonitoringStore(client) };
}

test('critical incident notifications are deduplicated persistently across polls and process recreation', async (t) => {
  const { client, store } = await setup(t);
  const incident = { key: 'scheduler_missing', title: 'Scheduler', message: 'No heartbeat' };
  await store.reconcile([incident], '2026-10-27T12:00:00Z');
  await store.reconcile([incident], '2026-10-27T12:01:00Z');
  const restarted = new ResearchMonitoringStore(client);
  await restarted.reconcile([incident], '2026-10-27T12:02:00Z');
  let state = await restarted.read();
  assert.equal(state.notifications.length, 1);
  assert.equal(state.incidents.length, 1);
  assert.equal(state.incidents[0].lastSeenAt, '2026-10-27T12:02:00.000Z');
  await restarted.reconcile([], '2026-10-27T12:03:00Z');
  assert.equal((await restarted.read()).incidents.length, 0);
  await restarted.reconcile([incident], '2026-10-27T12:04:00Z');
  state = await restarted.read();
  assert.equal(state.notifications.length, 2);
  assert.notEqual(state.notifications[0].id, state.notifications[1].id);
});

test('daily summary is idempotent and GET monitoring is read-only with explicit in-app delivery limit', async (t) => {
  const { client, store } = await setup(t);
  await store.saveDailySummary('2026-10-26', { portfolios: [{ family: 'A', profitCents: 900 }] }, '2026-10-27T02:00:00Z');
  await store.saveDailySummary('2026-10-26', { portfolios: [{ family: 'A', profitCents: -1000 }] }, '2026-10-27T02:01:00Z');
  const before = await client.execute('SELECT COUNT(*) AS n FROM research_notifications');
  const state = await readResearchMonitoring({ researchMonitoring: store });
  const after = await client.execute('SELECT COUNT(*) AS n FROM research_notifications');
  assert.equal(Number(before.rows[0].n), Number(after.rows[0].n));
  assert.equal(state.dailySummary.portfolios[0].profitCents, 900);
  assert.equal(state.delivery.channel, 'in_app');
  assert.equal(state.delivery.externalConfigured, false);
  assert.match(state.delivery.blocker, /processo remoto fermo/);
});

test('daily A/C accounting is independent and excludes initial capital from profit', () => {
  const portfolios = [{ id: 'shadow_A', family: 'A' }, { id: 'shadow_C', family: 'C' }];
  const ledger = [
    { portfolioId: 'shadow_A', event: 'OPEN', availableDeltaCents: 100000, committedDeltaCents: 0, createdAt: '2026-10-25T23:00:00Z' },
    { portfolioId: 'shadow_C', event: 'OPEN', availableDeltaCents: 100000, committedDeltaCents: 0, createdAt: '2026-10-25T23:00:00Z' },
    { portfolioId: 'shadow_A', event: 'STAKE', availableDeltaCents: -1000, committedDeltaCents: 1000, createdAt: '2026-10-26T12:00:00Z' },
    { portfolioId: 'shadow_C', event: 'STAKE', availableDeltaCents: -1000, committedDeltaCents: 1000, createdAt: '2026-10-26T12:00:00Z' },
    { portfolioId: 'shadow_A', event: 'SETTLE', availableDeltaCents: 1900, committedDeltaCents: -1000, createdAt: '2026-10-26T14:00:00Z' },
    { portfolioId: 'shadow_C', event: 'SETTLE', availableDeltaCents: 0, committedDeltaCents: -1000, createdAt: '2026-10-26T14:00:00Z' },
  ];
  const bets = portfolios.map((p) => ({ portfolioId: p.id, placedAt: '2026-10-26T12:00:00Z', settledAt: '2026-10-26T14:00:00Z' }));
  const summary = researchDailySummary('2026-10-26', portfolios, bets, ledger);
  assert.equal(summary.portfolios.length, 2);
  const [A, C] = summary.portfolios;
  assert.equal(A.endEquityCents, 100900);
  assert.equal(A.profitCents, 900);
  assert.equal(A.portfolioDeltaCents, 900);
  assert.equal(A.registeredBets, 1);
  assert.equal(A.settledBets, 1);
  assert.equal(C.endEquityCents, 99000);
  assert.equal(C.profitCents, -1000);
  assert.equal(C.portfolioDeltaCents, -1000);
  assert.equal('combinedEquity' in summary, false);
});

test('summary day uses Europe/Rome across the repeated autumn hour and midnight', () => {
  const summary = researchDailySummary('2026-10-25', [{ id: 'shadow_A', family: 'A' }], [
    { portfolioId: 'shadow_A', placedAt: '2026-10-25T00:30:00+02:00' },
    { portfolioId: 'shadow_A', placedAt: '2026-10-25T02:30:00+02:00' },
    { portfolioId: 'shadow_A', placedAt: '2026-10-25T02:30:00+01:00' },
    { portfolioId: 'shadow_A', placedAt: '2026-10-25T23:30:00+01:00' },
    { portfolioId: 'shadow_A', placedAt: '2026-10-26T00:00:00+01:00' },
  ], []);
  assert.equal(summary.portfolios[0].registeredBets, 4);
});

test('critical rules require measured failures, respect disabled scheduler and detect ledger disagreement', () => {
  const base = { now: '2026-10-27T12:00:00Z', schedulerEnabled: false, runs: [], models: [], markets: [], jobs: [], portfolios: [], bets: [], ledger: [] };
  assert.deepEqual(researchCriticalIncidents(base), []);
  const enabled = researchCriticalIncidents({ ...base, schedulerEnabled: true });
  assert.deepEqual(enabled.map((row) => row.key), ['scheduler_heartbeat_missing', 'no_validated_model']);
  const runs = [0, 1, 2].map((minute) => ({ schedulerName: 'research_settlement', endedAt: `2026-10-27T11:5${9 - minute}:00Z`, success: false }));
  assert.equal(researchCriticalIncidents({ ...base, runs }).filter((row) => row.key === 'research_settlement_repeated_failure').length, 1);
  assert.equal(researchCriticalIncidents({ ...base, runs: [{ ...runs[0], success: true }, ...runs.slice(1)] }).length, 0);
  const broken = researchCriticalIncidents({ ...base, portfolios: [{ id: 'shadow_A', availableCents: 100001, committedCents: 0, equityCents: 100001 }],
    ledger: [{ portfolioId: 'shadow_A', event: 'OPEN', availableDeltaCents: 100000, committedDeltaCents: 0 }] });
  assert.equal(broken[0].key, 'virtual_accounting_integrity');
});

test('successful A checks and other competitions cannot hide persistent C or provider failures', () => {
  const base = { now: '2026-10-27T12:00:00Z', schedulerEnabled: false, models: [], markets: [], jobs: [], portfolios: [], bets: [], ledger: [] };
  const runs = [];
  for (let minute = 0; minute < 3; minute++) {
    const endedAt = `2026-10-27T11:5${7 + minute}:00Z`;
    runs.push({ schedulerName: 'research_model_check', endedAt, success: false, summary: { family: 'C', modelVersion: 'C-failed' } });
    runs.push({ schedulerName: 'research_model_check', endedAt, success: true, summary: { family: 'A', modelVersion: 'A-ok' } });
    runs.push({ schedulerName: 'research_model_check', endedAt, success: true, summary: { family: 'C', modelVersion: 'C-other' } });
    runs.push({ schedulerName: 'research_provider', endedAt, success: false, summary: { provider: 'odds_api', competition: 'Serie A' } });
    runs.push({ schedulerName: 'research_provider', endedAt, success: true, summary: { provider: 'odds_api', competition: 'Premier League' } });
  }
  const incidents = researchCriticalIncidents({ ...base, runs });
  assert.deepEqual(incidents.map((incident) => incident.key).sort(), [
    'research_model_check_repeated_failure:C:C-failed', 'research_provider_repeated_failure:odds_api:Serie A',
  ]);
  const recovered = [...runs, { schedulerName: 'research_model_check', endedAt: '2026-10-27T11:59:30Z', success: true,
    summary: { family: 'C', modelVersion: 'C-failed' } }];
  assert.ok(!researchCriticalIncidents({ ...base, runs: recovered }).some((incident) => incident.key.includes('C-failed')));
});

test('reconciliation isolates scheduler components and does not create an empty daily bankroll report', async (t) => {
  const { store } = await setup(t);
  const requested = [];
  const db = { researchMonitoring: store, research: {
    getModels: async () => [], listMarkets: async () => [], listJobs: async () => [],
    listPortfolios: async () => [], listBets: async () => [], listLedger: async () => [],
  }, listRecentSchedulerRuns: async () => { throw new Error('Unfiltered heartbeats hide component history'); },
  listRecentSchedulerRunsByName: async (name) => { requested.push(name); return name === 'research_t15'
    ? [{ schedulerName: name, endedAt: '2026-10-27T11:59:00Z', success: true }] : []; } };
  await reconcileResearchMonitoring(db, '2026-10-27T12:00:00Z', { schedulerEnabled: true });
  assert.deepEqual(requested.sort(), ['research_model_check', 'research_provider', 'research_settlement', 'research_t15']);
  const result = await readResearchMonitoring(db);
  assert.equal(result.dailySummary, null);
  assert.equal(result.notifications.length, 1);
  assert.equal(result.incidents[0].key, 'no_validated_model');
});

test('a ledger commit during monitoring defers integrity and summary rather than raising or resolving an incident', async (t) => {
  const { store } = await setup(t);
  const prior = { key: 'virtual_accounting_integrity', title: 'Integrity', message: 'Unresolved mismatch' };
  await store.reconcile([prior], '2026-10-27T11:00:00Z');
  let reads = 0;
  const opening = { portfolioId: 'shadow_A', event: 'OPEN', createdAt: '2026-10-26T10:00:00Z', availableDeltaCents: 100000, committedDeltaCents: 0 };
  const db = { researchMonitoring: store, research: { getModels: async () => [], listMarkets: async () => [], listJobs: async () => [],
    listBets: async () => [], listPortfolios: async () => [{ id: 'shadow_A', family: 'A', availableCents: 100000, committedCents: 0, equityCents: 100000 }],
    listLedger: async () => ++reads === 1 ? [] : [opening] }, listRecentSchedulerRuns: async () => [] };
  await reconcileResearchMonitoring(db, '2026-10-27T12:00:00Z', { schedulerEnabled: false });
  const result = await readResearchMonitoring(db);
  assert.equal(result.notifications.length, 1);
  assert.equal(result.incidents[0].key, prior.key);
  assert.equal(result.dailySummary, null);
});
