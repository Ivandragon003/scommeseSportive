const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { SmartOddsRequestStore } = require(join(process.env.SMART_ODDS_TEST_DIST || join(__dirname, '../dist'),
  'services/odds-provider/SmartOddsRequestStore.js'));

const request = (overrides = {}) => ({ provider: 'odds_api', accountScope: 'personal-main', endpoint: '/v4/sports/soccer/odds',
  operation: 'fixture_odds', markets: ['h2h', 'totals'], regions: ['eu'], requestKey: 'fixture-1',
  expectedCredits: 2, priority: 'essential', cacheMaxAgeMs: 300000, ...overrides });
const headers = (used, remaining, cost) => ({ 'x-requests-used': String(used), 'x-requests-remaining': String(remaining), 'x-requests-last': String(cost) });
async function setup(options = {}) {
  const file = join(tmpdir(), `smart-odds-${randomUUID()}.db`);
  const clients = [createClient({ url: `file:${file}` }), createClient({ url: `file:${file}` })];
  await clients[0].executeMultiple(readFileSync(join(__dirname, '../migrations/018_smart_odds.sql'), 'utf8'));
  let clock = Date.parse('2026-10-27T12:00:00Z');
  const stores = clients.map((client) => new SmartOddsRequestStore(client, async () => {}, { clock: () => new Date(clock), ...options }));
  return { clients, stores, setClock: (value) => { clock = Date.parse(value); }, advance: (ms) => { clock += ms; }, close() {
    clients.forEach((client) => client.close());
    // The libSQL local driver retains transaction connections until GC; do not unlink an active WAL.
  } };
}
const provider = async (store) => (await store.overview()).providers[0];
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('two SQLite clients share one transport reservation and an unchanged cached snapshot', async () => {
  const ctx = await setup();
  try {
    let calls = 0;
    const payload = { fixture: 'real-payload-shaped-fixture', bookmakerUpdatedAt: '2026-10-27T11:59:00Z', prices: [] };
    const fetcher = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 30)); return { data: payload, headers: headers(2, 498, 2) }; };
    const results = await Promise.all(ctx.stores.map((store) => store.execute(request(), fetcher)));
    assert.equal(calls, 1);
    assert.deepEqual(results[0].data, payload); assert.deepEqual(results[1].data, payload);
    assert.equal(results.filter((result) => result.cacheHit).length, 1);
    assert.equal(results[0].fetchedAt, results[1].fetchedAt);
    const overview = await ctx.stores[0].overview();
    assert.equal(overview.providers[0].requests, 1); assert.equal(overview.providers[0].chargedCredits, 2);
    assert.deepEqual(overview.usage[0].markets, ['h2h', 'totals']);
    assert.equal(overview.events.find((event) => event.type === 'CACHE_HIT').count, 1);
    results[0].data.prices.push('caller mutation');
    assert.deepEqual((await ctx.stores[1].execute(request({ allowNetwork: false }), fetcher)).data, payload);
    await assert.rejects(ctx.clients[0].execute('DELETE FROM smart_odds_requests'), /immutable/);
  } finally { ctx.close(); }
});

test('cache-only denies absent and stale data; essential caching is capped at five minutes without retimestamping', async () => {
  const ctx = await setup();
  try {
    let calls = 0; const fetcher = async () => { calls++; return { data: { observed: 'fixed' }, headers: headers(calls, 500 - calls, 1) }; };
    await assert.rejects(ctx.stores[0].execute(request({ allowNetwork: false }), fetcher), /odds_cache_only/);
    const original = await ctx.stores[0].execute(request({ cacheMaxAgeMs: 1800000 }), fetcher);
    ctx.advance(300001);
    await assert.rejects(ctx.stores[0].execute(request({ cacheMaxAgeMs: 1800000, allowNetwork: false }), fetcher), /odds_cache_only/);
    const preview = await ctx.stores[0].execute(request({ priority: 'informational', cacheMaxAgeMs: 1800000, allowNetwork: false }), fetcher);
    assert.equal(preview.cacheHit, true); assert.equal(preview.fetchedAt, original.fetchedAt); assert.equal(calls, 1);
  } finally { ctx.close(); }
});

test('informational requests preserve reserve, essential requests can use it, and inflight reservations count', async () => {
  const ctx = await setup({ monthlyLimit: 10, reserveCredits: 5 });
  try {
    const gate = deferred(), entered = deferred();
    const pending = ctx.stores[0].execute(request({ expectedCredits: 6 }), async () => { entered.resolve(); await gate.promise; return { data: [] }; });
    await entered.promise;
    await assert.rejects(ctx.stores[1].execute(request({ requestKey: 'other', priority: 'informational', expectedCredits: 1 }), async () => ({ data: [] })), /budget_exhausted/);
    await assert.rejects(ctx.stores[1].execute(request({ requestKey: 'too-big', expectedCredits: 5 }), async () => ({ data: [] })), /budget_exhausted/);
    const before = await provider(ctx.stores[0]); assert.equal(before.reservedCredits, 6); assert.equal(before.observedUsed, null);
    gate.resolve(); await pending;
    await ctx.stores[1].execute(request({ requestKey: 'essential-rest', expectedCredits: 4 }), async () => ({ data: [] }));
    assert.equal((await provider(ctx.stores[0])).availableCredits, 0);
    assert.equal((await ctx.stores[0].execute(request({ allowNetwork: false }), async () => { throw Error('must not fetch'); })).cacheHit, true);
  } finally { ctx.close(); }
});

test('measured header credits replace estimates, including zero-cost empty responses; HTTP calls are not credits', async () => {
  const ctx = await setup();
  try {
    await ctx.stores[0].execute(request({ expectedCredits: 8 }), async () => ({ data: [], headers: { ...headers(3, 497, 0), Authorization: 'never-store-secret' } }));
    const summary = await provider(ctx.stores[0]);
    assert.equal(summary.requests, 1); assert.equal(summary.plannedCredits, 8); assert.equal(summary.chargedCredits, 0);
    assert.equal(summary.observedUsed, 3); assert.equal(summary.observedRemaining, 497); assert.equal(summary.availableCredits, 497);
    const row = (await ctx.clients[0].execute('SELECT headers_json FROM smart_odds_results')).rows[0];
    assert.equal(row.headers_json.includes('secret'), false);
    assert.equal((await ctx.stores[0].overview()).usage[0].measuredCredits, 0);
  } finally { ctx.close(); }
});

test('unknown failures retain the reservation estimate; errors with authoritative zero cost do not charge', async () => {
  const ctx = await setup({ monthlyLimit: 10, reserveCredits: 0 });
  try {
    await assert.rejects(ctx.stores[0].execute(request({ expectedCredits: 7 }), async () => { throw Error('secret-url'); }), /odds_transport_failed/);
    const unknown = await provider(ctx.stores[0]); assert.equal(unknown.chargedCredits, 7); assert.equal(unknown.unknownChargedCredits, 7);
    assert.equal(unknown.availableCredits, 3); assert.equal(unknown.reservedCredits, 0);
    await assert.rejects(ctx.stores[0].execute(request({ requestKey: 'invalid-api-market', expectedCredits: 2 }), async () => {
      throw { response: { headers: headers(7, 3, 0) } };
    }), /odds_transport_failed/);
    assert.equal((await provider(ctx.stores[0])).chargedCredits, 7);
    await assert.rejects(ctx.stores[0].execute(request({ requestKey: 'over-budget', expectedCredits: 4 }), async () => ({ data: [] })), /budget_exhausted/);
    assert.equal(JSON.stringify((await ctx.clients[0].execute('SELECT * FROM smart_odds_results')).rows).includes('secret-url'), false);
  } finally { ctx.close(); }
});

test('out-of-order quota headers never restore used or remaining credits', async () => {
  const ctx = await setup();
  try {
    const gate = deferred(), entered = deferred();
    const older = ctx.stores[0].execute(request({ expectedCredits: 1 }), async () => { entered.resolve(); await gate.promise; return { data: 'older', headers: headers(100, 400, 1) }; });
    await entered.promise;
    await ctx.stores[1].execute(request({ requestKey: 'newer', expectedCredits: 1 }), async () => ({ data: 'newer', headers: headers(101, 399, 1) }));
    const earlierAvailable = (await provider(ctx.stores[1])).availableCredits;
    gate.resolve(); await older;
    const overview = await provider(ctx.stores[0]);
    assert.equal(overview.observedUsed, 101); assert.equal(overview.observedRemaining, 399);
    assert.ok(overview.availableCredits <= earlierAvailable);
  } finally { ctx.close(); }
});

test('a UTC planning month cannot mint credits before a free fresh-header probe confirms the provider reset', async () => {
  const ctx = await setup();
  try {
    await ctx.stores[0].execute(request(), async () => ({ data: [], headers: headers(499, 1, 1) }));
    ctx.setClock('2026-11-01T00:00:00Z');
    await assert.rejects(ctx.stores[0].execute(request({ requestKey: 'november-paid' }), async () => ({ data: [] })), /odds_reset_unconfirmed/);
    assert.equal((await provider(ctx.stores[0])).resetConfirmed, false);
    await ctx.stores[0].execute(request({ requestKey: 'events-probe-before-reset', operation: 'events', expectedCredits: 0 }),
      async () => ({ data: [], headers: headers(499, 1, 0) }));
    assert.equal((await provider(ctx.stores[0])).resetConfirmed, false);
    await ctx.stores[0].execute(request({ requestKey: 'events-probe-after-reset', operation: 'events', expectedCredits: 0 }),
      async () => ({ data: [], headers: headers(0, 500, 0) }));
    assert.equal((await provider(ctx.stores[0])).resetConfirmed, true);
    await ctx.stores[0].execute(request({ requestKey: 'november-paid' }), async () => ({ data: [], headers: headers(2, 498, 2) }));
    const november = await provider(ctx.stores[0]); assert.equal(november.chargedCredits, 2); assert.equal(november.observedRemaining, 498);
    assert.equal(november.resetAt, '2026-12-01T00:00:00.000Z');
  } finally { ctx.close(); }
});

test('an old-month inflight response cannot establish the next month quota', async () => {
  const ctx = await setup();
  try {
    ctx.setClock('2026-10-31T23:59:59Z');
    const gate = deferred(), entered = deferred();
    const prior = ctx.stores[0].execute(request(), async () => { entered.resolve(); await gate.promise; return { data: [], headers: headers(0, 500, 0) }; });
    await entered.promise; ctx.setClock('2026-11-01T00:00:01Z');
    await assert.rejects(ctx.stores[1].execute(request({ requestKey: 'next-month' }), async () => ({ data: [] })), /odds_reset_unconfirmed/);
    gate.resolve(); await prior;
    assert.equal((await provider(ctx.stores[0])).resetConfirmed, false);
    assert.equal((await provider(ctx.stores[0])).observedRemaining, null);
  } finally { ctx.close(); }
});

test('expired lease is charged unknown and fenced late response cannot overwrite a newer cache', async () => {
  const ctx = await setup();
  try {
    const gate = deferred(), entered = deferred();
    const old = ctx.stores[0].execute(request(), async () => { entered.resolve(); await gate.promise; return { data: { generation: 'old' } }; });
    const rejection = assert.rejects(old, /odds_lease_lost/);
    await entered.promise; ctx.advance(60001);
    const current = await ctx.stores[1].execute(request(), async () => ({ data: { generation: 'new' }, headers: headers(4, 496, 2) }));
    gate.resolve(); await rejection;
    const cached = await ctx.stores[0].execute(request({ allowNetwork: false }), async () => { throw Error('no'); });
    assert.deepEqual(cached.data, current.data); assert.equal(cached.fetchedAt, current.fetchedAt);
    const summary = await provider(ctx.stores[0]); assert.equal(summary.requests, 2); assert.equal(summary.chargedCredits, 4);
    assert.equal(summary.unknownChargedCredits, 2);
  } finally { ctx.close(); }
});

test('later zero-cost and stricter cumulative headers never refund an ambiguous earlier charge', async () => {
  const ctx = await setup();
  try {
    await assert.rejects(ctx.stores[0].execute(request({ expectedCredits: 7 }), async () => { throw Error('ambiguous delivery'); }), /odds_transport_failed/);
    await ctx.stores[0].execute(request({ requestKey: 'free-probe', expectedCredits: 0 }), async () => ({ data: [], headers: headers(0, 500, 0) }));
    let summary = await provider(ctx.stores[0]);
    assert.equal(summary.availableCredits, 493); assert.equal(summary.unknownChargedCredits, 7);
    await ctx.stores[0].execute(request({ requestKey: 'next-response', expectedCredits: 1 }), async () => ({ data: [], headers: headers(1, 499, 1) }));
    summary = await provider(ctx.stores[0]);
    assert.equal(summary.availableCredits, 492); assert.equal(summary.unknownChargedCredits, 7);
  } finally { ctx.close(); }
});

test('safe HTTP authentication, quota and rate-limit status survives without provider secrets', async () => {
  const ctx = await setup();
  try {
    for (const [status, code] of [[401, 'odds_provider_authentication_failed'], [403, 'odds_provider_authentication_failed'],
      [402, 'odds_provider_quota_exhausted'], [429, 'odds_provider_rate_limited']]) {
      await assert.rejects(ctx.stores[0].execute(request({ requestKey: `failure-${status}` }), async () => {
        throw { response: { status, headers: { 'x-requests-last': '0' } }, message: 'URL-with-secret' };
      }), (error) => error.code === code && error.httpStatus === status && !error.message.includes('secret'));
    }
    assert.equal((await provider(ctx.stores[0])).chargedCredits, 0);
  } finally { ctx.close(); }
});

test('overview is read-only and reports cache denominator and only bookmakers/markets observed in payloads', async () => {
  const ctx = await setup();
  try {
    const initial = await ctx.stores[0].overview();
    assert.equal(initial.cache.hitRate, null); assert.deepEqual(initial.providers, []);
    assert.equal((await ctx.clients[0].execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'")).rows[0].n, 0);
    await ctx.stores[0].execute(request(), async () => ({ data: [{ bookmakers: [{ key: 'fixture_book', title: 'Fixture Book',
      markets: [{ key: 'h2h' }, { key: 'totals' }] }] }], headers: headers(2, 498, 2) }));
    await ctx.stores[0].execute(request({ allowNetwork: false }), async () => { throw Error('never'); });
    await assert.rejects(ctx.stores[0].execute(request({ requestKey: 'denied', allowNetwork: false }), async () => ({ data: [] })), /cache_only/);
    const result = await ctx.stores[0].overview();
    assert.deepEqual(result.cache, { window: 'last_90_days', hits: 1, fetchReservations: 1, hitRate: .5 });
    assert.deepEqual(result.providers[0].actualBookmakers, ['Fixture Book']);
    assert.deepEqual(result.providers[0].actualMarkets, ['h2h', 'totals']);
    assert.equal(result.providers[0].actualCoverageAsOf, '2026-10-27T12:00:00.000Z');
  } finally { ctx.close(); }
});

test('a held cumulative probe cannot absorb a later partially measured paid request', async () => {
  const ctx = await setup();
  try {
    await ctx.stores[0].execute(request({ requestKey: 'initial-quota', expectedCredits: 0 }),
      async () => ({ data: [], headers: headers(50, 450, 0) }));
    ctx.advance(1);
    const gate = deferred(), entered = deferred();
    const held = ctx.stores[0].execute(request({ requestKey: 'held-probe', expectedCredits: 0 }), async () => {
      entered.resolve(); await gate.promise; return { data: [], headers: headers(100, 400, 0) };
    });
    await entered.promise; ctx.advance(1);
    await ctx.stores[1].execute(request({ requestKey: 'paid-after-probe', expectedCredits: 3 }),
      async () => ({ data: [], headers: { 'x-requests-last': '3' } }));
    gate.resolve(); await held;
    const result = await provider(ctx.stores[0]);
    assert.equal(result.observedUsed, 100); assert.equal(result.observedRemaining, 400);
    assert.equal(result.availableCredits, 397);
  } finally { ctx.close(); }
});

test('a fresh unchanged full allowance permits the next planning month without falsely requiring an observed drop', async () => {
  const ctx = await setup();
  try {
    await ctx.stores[0].execute(request({ requestKey: 'october-full', expectedCredits: 0 }),
      async () => ({ data: [], headers: headers(0, 500, 0) }));
    ctx.setClock('2026-11-01T00:00:00Z');
    await assert.rejects(ctx.stores[0].execute(request({ requestKey: 'november-needs-confirmation' }), async () => ({ data: [] })), /odds_reset_unconfirmed/);
    await ctx.stores[0].execute(request({ requestKey: 'november-full', expectedCredits: 0 }),
      async () => ({ data: [], headers: headers(0, 500, 0) }));
    assert.equal((await provider(ctx.stores[0])).resetConfirmed, true);
    await ctx.stores[0].execute(request({ requestKey: 'november-paid' }), async () => ({ data: [], headers: headers(2, 498, 2) }));
    assert.equal((await provider(ctx.stores[0])).availableCredits, 498);
  } finally { ctx.close(); }
});

test('prior-month inflight billing remains a liability after a fresh new-month allowance is confirmed', async () => {
  const ctx = await setup();
  try {
    ctx.setClock('2026-10-31T23:59:58Z');
    await ctx.stores[0].execute(request({ requestKey: 'old-quota', expectedCredits: 0 }),
      async () => ({ data: [], headers: headers(499, 1, 0) }));
    ctx.advance(1000);
    const gate = deferred(), entered = deferred();
    const oldRequest = ctx.stores[0].execute(request({ requestKey: 'billed-across-boundary', expectedCredits: 1 }), async () => {
      entered.resolve(); await gate.promise; return { data: [], headers: headers(1, 499, 1) };
    });
    await entered.promise; ctx.setClock('2026-11-01T00:00:01Z');
    await ctx.stores[1].execute(request({ requestKey: 'new-quota', expectedCredits: 0 }),
      async () => ({ data: [], headers: headers(0, 500, 0) }));
    let result = await provider(ctx.stores[1]);
    assert.equal(result.resetConfirmed, true); assert.equal(result.carryoverCredits, 1); assert.equal(result.availableCredits, 499);
    gate.resolve(); await oldRequest;
    result = await provider(ctx.stores[1]);
    assert.equal(result.observedUsed, 0); assert.equal(result.observedRemaining, 500);
    assert.equal(result.carryoverCredits, 1); assert.equal(result.availableCredits, 499);
    await assert.rejects(ctx.stores[1].execute(request({ requestKey: 'cannot-overspend', expectedCredits: 500 }),
      async () => ({ data: [] })), /odds_credit_budget_exhausted/);
  } finally { ctx.close(); }
});

test('free calendar requests retain their requested thirty-minute cache instead of the paid essential cap', async () => {
  const ctx = await setup();
  try {
    let calls = 0;
    const calendar = request({ endpoint: '/v4/sports/soccer/events', operation: 'events', requestKey: 'free-calendar',
      expectedCredits: 0, cacheMaxAgeMs: 1800000 });
    const fetcher = async () => { calls++; return { data: [{ id: 'fixture-calendar' }], headers: headers(0, 500, 0) }; };
    const first = await ctx.stores[0].execute(calendar, fetcher);
    ctx.advance(300001);
    const cached = await ctx.stores[0].execute(calendar, fetcher);
    assert.equal(calls, 1); assert.equal(cached.cacheHit, true); assert.equal(cached.fetchedAt, first.fetchedAt);
    ctx.advance(1500000);
    assert.equal((await ctx.stores[0].execute(calendar, fetcher)).cacheHit, false);
    assert.equal(calls, 2);
  } finally { ctx.close(); }
});

test('concurrent startup schema guards retry SQLITE_BUSY before request admission', async () => {
  const ctx = await setup();
  try {
    let attempts = 0;
    const client = ctx.clients[0];
    const wrapped = { protocol: client.protocol, execute: client.execute.bind(client), transaction: client.transaction.bind(client),
      executeMultiple: async (sql) => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        return client.executeMultiple(sql);
      } };
    const store = new SmartOddsRequestStore(wrapped, async () => {}, { clock: () => new Date('2026-10-27T12:00:00Z') });
    await store.execute(request(), async () => ({ data: { testOnly: true } }));
    assert.equal(attempts, 3);
    assert.equal((await provider(store)).requests, 1);
  } finally { ctx.close(); }
});

test('a failed startup guard can recover on the next call without admitting an earlier request', async () => {
  const ctx = await setup();
  try {
    let attempts = 0;
    const client = ctx.clients[0];
    const wrapped = { protocol: client.protocol, execute: client.execute.bind(client), transaction: client.transaction.bind(client),
      executeMultiple: async (sql) => {
        if (++attempts === 1) throw new Error('fixture_schema_temporarily_unavailable');
        return client.executeMultiple(sql);
      } };
    const store = new SmartOddsRequestStore(wrapped, async () => {}, { clock: () => new Date('2026-10-27T12:00:00Z') });
    await assert.rejects(store.execute(request(), async () => ({ data: [] })), /fixture_schema_temporarily_unavailable/);
    assert.equal((await client.execute('SELECT COUNT(*) AS count FROM smart_odds_requests')).rows[0].count, 0);
    await store.execute(request(), async () => ({ data: { testOnly: true } }));
    assert.equal(attempts, 2);
    assert.equal((await provider(store)).requests, 1);
  } finally { ctx.close(); }
});
