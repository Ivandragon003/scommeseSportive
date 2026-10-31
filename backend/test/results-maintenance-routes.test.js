const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes');
const { MatchResultsMaintenanceService } = require('../dist/services/MatchResultsMaintenanceService');
const { buildOperationalStatus } = require('../dist/services/OperationalStatusService');

const report = () => ({ status: 'SUCCESS', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  from: '2026-10-28T12:00:00Z', to: '2026-10-31T12:00:00Z', checked: 7, updated: 7, unchanged: 0,
  rejected: 0, limitReached: false, reasonCounts: {}, errors: [], updates: [] });
const deny = () => { throw new Error('Unexpected model, provider or bet creation'); };

test('results maintenance coalesces refresh and existing settlement, records no-new-bets audit', async () => {
  let refreshes = 0, settlements = 0;
  const audit = [];
  const service = new MatchResultsMaintenanceService({ refresh: async () => { refreshes++; return report(); } },
    async () => { settlements++; return { checked: 8, settled: 4, unresolved: 0 }; },
    { saveSchedulerRun: async (row) => { audit.push(row); return 1; } });
  const [a, b] = await Promise.all([service.refresh(), service.refresh()]);
  assert.deepEqual(a, b); assert.equal(refreshes, 1); assert.equal(settlements, 1);
  assert.equal(a.settlement.settled, 4);
  assert.equal(audit[0].summary.createsNewBets, false);
  assert.equal(audit[0].schedulerName, 'results_refresh');
});

test('failed source refresh never settles, and partial settlement is not fabricated as zero', async () => {
  const failed = new MatchResultsMaintenanceService({ refresh: async () => ({ ...report(), status: 'FAILED' }) },
    deny, { saveSchedulerRun: async () => 1 });
  assert.equal((await failed.refresh()).settlement, null);
  const partial = new MatchResultsMaintenanceService({ refresh: async () => report() },
    async () => { throw new Error('sensitive transport detail'); }, { saveSchedulerRun: async () => 1 });
  const result = await partial.refresh();
  assert.equal(result.status, 'PARTIAL'); assert.equal(result.updated, 7); assert.equal(result.settlement, null);
  assert.deepEqual(result.errors, [{ reason: 'existing_bet_settlement_unavailable' }]);
});

test('status persistence failure reports partial work and clears the single-flight for retry', async () => {
  let calls = 0;
  const service = new MatchResultsMaintenanceService({ refresh: async () => { calls++; return report(); } },
    async () => ({ checked: 0, settled: 0, unresolved: 0 }), { saveSchedulerRun: async () => { throw new Error('private'); } });
  assert.equal((await service.refresh()).status, 'PARTIAL');
  await service.refresh(); assert.equal(calls, 2);
});

test('small operational status reads only four named run histories and never trusts disabled web flags', async () => {
  const calls = [];
  const now = new Date('2026-10-31T16:00:00Z');
  const data = { nightly: [{ startedAt: '2026-10-31T12:00:00Z', endedAt: '2026-10-31T12:11:00Z', success: true }],
    understat: [{ endedAt: '2026-10-31T12:10:00Z', success: true }], research_nightly: [{
      startedAt: '2026-10-31T12:05:00Z', endedAt: '2026-10-31T12:09:00Z', success: true, summary: { analyzedMatches: 3 } }] };
  const result = await buildOperationalStatus({ listRecentSchedulerRunsByName: async (name) => { calls.push(name); return data[name] || []; } }, now);
  assert.equal(result.nightly.state, 'SUCCESS'); assert.equal(result.nightly.analyzedMatches, 3);
  assert.equal(result.nightly.registeredBets, null); assert.equal(result.lastResultsRefreshAt, null);
  assert.equal(calls.length, 4); assert.ok(!JSON.stringify(result).includes('benchmark'));
});

test('missing measurements remain unavailable', async () => {
  const result = await buildOperationalStatus({ listRecentSchedulerRunsByName: async () => [] });
  assert.equal(result.nightly.state, 'NOT_OBSERVED'); assert.equal(result.nightly.lastCompletedAt, null);
  assert.equal(result.nightly.registeredBets, null);
});

for (const success of [true, false]) {
  test(`a newer execution never inherits yesterday's full-workflow success (execution success=${success})`, async () => {
    const data = { nightly: [{ startedAt: '2026-10-30T02:00:00Z', endedAt: '2026-10-30T02:40:00Z', success: true }],
      research_nightly: [{ startedAt: '2026-10-31T02:30:00Z', endedAt: '2026-10-31T02:40:00Z', success, summary: { analyzedMatches: 1 } }] };
    const result = await buildOperationalStatus({ listRecentSchedulerRunsByName: async (name) => data[name] || [] });
    assert.equal(result.nightly.state, success ? 'NOT_OBSERVED' : 'FAILED');
    assert.equal(result.nightly.lastCompletedAt, '2026-10-31T02:40:00Z');
    assert.equal(result.nightly.analyzedMatches, 1);
  });
}

test('execution measurements outside the completed workflow interval remain unavailable', async () => {
  const data = { nightly: [{ startedAt: '2026-10-31T02:00:00Z', endedAt: '2026-10-31T02:40:00Z', success: true }],
    research_nightly: [{ startedAt: '2026-10-30T02:00:00Z', endedAt: '2026-10-30T02:40:00Z', success: true, summary: { analyzedMatches: 99, registeredBets: 5 } }] };
  const result = await buildOperationalStatus({ listRecentSchedulerRunsByName: async (name) => data[name] || [] });
  assert.equal(result.nightly.state, 'SUCCESS'); assert.equal(result.nightly.analyzedMatches, null);
  assert.equal(result.nightly.registeredBets, null);
});

async function httpFixture(t, overrides = {}) {
  const calls = [];
  const app = express(); app.use(express.json());
  app.use('/api', createApiRouter({ db: new Proxy({}, { get: deny }), svc: { predict: deny },
    resultsMaintenance: { refresh: async () => { calls.push('refresh'); return { ...report(), settlement: null }; } },
    operationalStatus: async () => ({ checkedAt: new Date().toISOString(), nightly: { state: 'NOT_OBSERVED' } }), ...overrides }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { calls, request: async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    const parsedBody = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
    if (response.ok) assert.ok(parsedBody, 'Successful API responses must be JSON');
    return { status: response.status, cache: response.headers.get('cache-control'), body: parsedBody };
  } };
}

test('authenticated-router actions dispatch only results maintenance and small status', async (t) => {
  const f = await httpFixture(t);
  assert.equal((await f.request('/system/operational-status')).status, 200);
  const response = await f.request('/results/refresh', {});
  assert.equal(response.status, 200); assert.equal(response.cache, 'no-store'); assert.deepEqual(f.calls, ['refresh']);
});
for (const body of [[], null, { matchId: 'x' }, { asOf: '2020-01-01' }, { createBets: true }]) {
  test(`results endpoint rejects client overrides: ${JSON.stringify(body)}`, async (t) => {
    const f = await httpFixture(t); assert.equal((await f.request('/results/refresh', body)).status, 400);
    assert.deepEqual(f.calls, []);
  });
}
test('results errors never expose driver or provider details', async (t) => {
  const f = await httpFixture(t, { resultsMaintenance: { refresh: async () => { throw new Error('private SQL and credentials'); } } });
  const response = await f.request('/results/refresh', {});
  assert.equal(response.status, 503); assert.ok(!JSON.stringify(response).includes('private SQL'));
});
