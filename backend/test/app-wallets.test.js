const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const dist = process.env.APP_WALLET_DIST_DIR ?? path.join(__dirname, '../dist');
const { buildAppWallets, parseAppWalletQuery, targetsAppWallet } = require(path.join(dist, 'services/AppWalletService'));
const { createApiRouter } = require(path.join(dist, 'api/routes'));
const { createSharedAdminAuth } = require(path.join(dist, 'security/SharedAdminAuth'));

const NOW = new Date('2026-10-30T16:00:00Z');
const AUTH_HEADER = { 'x-internal-admin-token': 'wallet-route-test-only' };

function fixture() {
  const state = { portfolios: [], bets: [], ledger: [], decisions: [], jobs: [] };
  const reads = [];
  const store = Object.fromEntries(['Portfolios', 'Bets', 'Ledger', 'Decisions', 'Jobs'].map((name) =>
    [`list${name}`, async () => { reads.push(name); return state[name.toLowerCase()]; }]));
  for (const name of ['initializePortfolios', 'placeBet', 'settleBet', 'getModels', 'getOverviewModels']) {
    store[name] = () => { throw new Error(`Wallet reads must not call ${name}`); };
  }
  for (const family of ['A', 'C']) {
    const id = `shadow_${family}`;
    state.portfolios.push({ id, family, availableCents: 100000, committedCents: 0, equityCents: 100000 });
    state.ledger.push({ id: `open:${id}`, portfolioId: id, event: 'OPEN', availableDeltaCents: 100000,
      committedDeltaCents: 0, createdAt: '2026-10-29T12:00:00Z' });
  }
  function addBet(id, family, stakeCents, options = {}) {
    const portfolioId = `shadow_${family}`;
    const placedAt = options.placedAt ?? '2026-10-30T14:17:00Z';
    const odds = options.odds ?? 2;
    const row = { id, family, portfolioId, matchId: `fixture:${id}`, modelVersion: `${family}-fixture`,
      placedAt, stakeCents, odds, market: options.market ?? '1x2', selection: 'homeWin', status: 'PENDING',
      snapshot: { match: { matchId: `fixture:${id}`, homeTeam: 'Home fixture', awayTeam: 'Away fixture',
        competition: 'Fixture league', kickoffAt: '2026-10-30T20:00:00Z' },
      quote: { odds, bookmaker: `Fixture bookmaker ${family}`, source: 'fixture-provider',
        capturedAt: placedAt, updatedAt: placedAt, priceType: 'prematch' } } };
    state.bets.push(row);
    state.ledger.push({ id: `stake:${id}`, portfolioId, betId: id, event: 'STAKE',
      availableDeltaCents: -stakeCents, committedDeltaCents: stakeCents, createdAt: placedAt });
    if (options.multiplier !== undefined) {
      const settledAt = '2026-10-30T15:00:00Z';
      const returnCents = Math.round(stakeCents * options.multiplier);
      Object.assign(row, { status: 'SETTLED', settledAt, multiplier: options.multiplier,
        returnCents, profitCents: returnCents - stakeCents });
      state.ledger.push({ id: `settle:${id}`, portfolioId, betId: id, event: 'SETTLE',
        availableDeltaCents: returnCents, committedDeltaCents: -stakeCents, createdAt: settledAt });
    }
    balance();
    return row;
  }
  function balance() {
    for (const wallet of state.portfolios) {
      const ledger = state.ledger.filter((entry) => entry.portfolioId === wallet.id);
      wallet.availableCents = ledger.reduce((total, entry) => total + entry.availableDeltaCents, 0);
      wallet.committedCents = ledger.reduce((total, entry) => total + entry.committedDeltaCents, 0);
      wallet.equityCents = wallet.availableCents + wallet.committedCents;
    }
  }
  return { state, store, reads, addBet };
}

function fundedFixture() {
  const f = fixture();
  f.addBet('a1', 'A', 420, { odds: 8 });
  f.addBet('a2', 'A', 1800, { odds: 2.14, market: 'totals' });
  f.addBet('a3', 'A', 2200, { odds: 1.93, market: 'totals' });
  f.addBet('c1', 'C', 1000, { odds: 2.9, market: 'totals' });
  f.addBet('c2', 'C', 1000, { odds: 2.94, market: 'totals' });
  return f;
}

async function startRouter(f, options = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  if (options.auth) {
    const auth = createSharedAdminAuth({ enabled: true, passwordHash: 'unused-test-hash',
      sharedDataUserId: 'user1', secureCookies: false, sessionTtlMs: 60000, maxLoginAttempts: 3,
      loginWindowMs: 60000, maxTrackedLoginIps: 10, allowedOrigins: new Set(),
      internalAccessToken: AUTH_HEADER['x-internal-admin-token'],
      sessionStore: { getAdminSession: async () => null } });
    app.use('/api', auth.requireAdmin);
  }
  const svc = {
    initBudget: async (...args) => { calls.push(['initBudget', ...args]); return { initialized: true }; },
    placeBet: async (...args) => { calls.push(['placeBet', ...args]); return { placed: true }; },
  };
  app.use('/api', createApiRouter({ db: { research: f.store }, svc, sharedDataUserId: 'user1' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}/api`, calls,
    close: () => new Promise((resolve) => server.close(resolve)) };
}

test('main app wallets expose the same five funded records and separate real ledger balances without writes', async () => {
  const f = fundedFixture();
  const before = JSON.stringify(f.state);
  const result = await buildAppWallets(f.store, { period: 'all' }, NOW);
  assert.equal(result.period.label, 'Dall’apertura dei portafogli');
  assert.equal(result.bets.total, 5);
  assert.deepEqual(result.portfolios.map((wallet) => ({ family: wallet.family, initial: wallet.initialCents,
    available: wallet.currentAvailableCents, committed: wallet.currentCommittedCents, equity: wallet.currentEquityCents,
    count: wallet.betCount })), [
    { family: 'A', initial: 100000, available: 95580, committed: 4420, equity: 100000, count: 3 },
    { family: 'C', initial: 100000, available: 98000, committed: 2000, equity: 100000, count: 2 },
  ]);
  assert.deepEqual(result.bets.rows.filter((row) => row.family === 'A').map((row) => row.stakeCents).sort((a, b) => a - b), [420, 1800, 2200]);
  assert.equal(result.bets.rows.filter((row) => row.family === 'C').length, 2);
  assert.equal(result.bets.rows.find((row) => row.id === 'a1').quote.odds, 8);
  assert.equal(result.bets.rows.find((row) => row.id === 'c1').bookmaker, 'Fixture bookmaker C');
  assert.equal(result.availableCents, undefined, 'independent wallets are never exposed as a combined balance');
  assert.equal(JSON.stringify(f.state), before);
  assert.deepEqual([...new Set(f.reads)].sort(), ['Bets', 'Decisions', 'Jobs', 'Ledger', 'Portfolios']);
});

test('wallet totals remain complete when the detail list is capped and legacy rows remain excluded', async () => {
  const f = fundedFixture();
  for (let index = 0; index < 501; index++) f.addBet(`extra-${index}`, 'A', 1);
  f.state.bets.push({ ...f.state.bets[0], id: 'legacy', portfolioId: 'main' });
  const result = await buildAppWallets(f.store, { period: 'all' }, NOW);
  assert.equal(result.bets.total, 506);
  assert.equal(result.bets.rows.length, 500);
  assert.equal(result.bets.truncated, true);
  assert.equal(result.portfolios[0].betCount, 504);
  assert.equal(result.portfolios[0].stakeCents, 4921);
  assert.equal(result.portfolios[1].betCount, 2);
  assert.equal(result.bets.rows.some((row) => row.id === 'legacy'), false);
});

test('half outcomes preserve the actual payout and fractional ROI, without treating a half loss as zero return', async () => {
  const f = fixture();
  f.addBet('half-win', 'A', 1000, { odds: 2.2, multiplier: 1.6, market: 'asian_handicap' });
  f.addBet('half-loss', 'C', 1001, { odds: 2.2, multiplier: 0.5, market: 'asian_handicap' });
  const before = JSON.stringify(f.state);
  const result = await buildAppWallets(f.store, { period: 'all' }, NOW);
  const win = result.bets.rows.find((row) => row.id === 'half-win');
  const loss = result.bets.rows.find((row) => row.id === 'half-loss');
  assert.equal(win.status, 'HALF_WON');
  assert.equal(win.stakeCents + win.profitCents, 1600);
  assert.equal(loss.status, 'HALF_LOST');
  assert.equal(loss.stakeCents + loss.profitCents, 501);
  assert.equal(result.portfolios[0].roi, 0.6);
  assert.equal(result.portfolios[1].roi, -500 / 1001);
  assert.equal(result.portfolios[0].initialCents, 100000);
  assert.equal(result.portfolios[0].currentEquityCents, 100600);
  assert.equal(JSON.stringify(f.state), before);
});

test('invalid wallet periods and dates are rejected before database reads', async () => {
  const f = fixture();
  for (const query of [
    { period: 'today' }, { period: 'custom' },
    { period: 'custom', from: '2026-02-30', to: '2026-03-01' },
    { period: 'custom', from: '2026-10-30', to: '2026-10-29' },
  ]) await assert.rejects(buildAppWallets(f.store, query, NOW));
  assert.throws(() => parseAppWalletQuery({ period: ['all', '7d'] }), /must be a string/);
  assert.deepEqual(f.reads, []);
});

test('wallet GET uses the existing administrator middleware and returns no data to anonymous callers', async () => {
  const f = fundedFixture();
  const server = await startRouter(f, { auth: true });
  try {
    const denied = await fetch(`${server.base}/wallets?period=all`);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).success, false);
    assert.deepEqual(f.reads, []);
    const allowed = await fetch(`${server.base}/wallets?period=all`, { headers: AUTH_HEADER });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).data.bets.total, 5);
    assert.deepEqual(server.calls, []);
  } finally { await server.close(); }
});

test('wallet route rejects ambiguous query input and fails explicitly when the ledger is unavailable', async () => {
  const f = fundedFixture();
  const server = await startRouter(f);
  try {
    for (const suffix of ['period=all&period=7d', 'period=invalid', 'period=custom&from=2026-02-30&to=2026-03-01']) {
      const response = await fetch(`${server.base}/wallets?${suffix}`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).success, false);
    }
    assert.deepEqual(f.reads, []);
    f.store.listPortfolios = async () => { throw new Error('private database diagnostic'); };
    const response = await fetch(`${server.base}/wallets?period=all`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.data, undefined);
    assert.equal(body.error, 'Portafogli non disponibili.');
  } finally { await server.close(); }
});

test('legacy placement and reset reject an explicit A/C target before calling a mutation service', async () => {
  const f = fundedFixture();
  const server = await startRouter(f);
  try {
    for (const target of [
      { modelFamily: 'A' }, { family: 'C' }, { model: 'A' },
      { portfolioId: 'shadow_A' }, { portfolioId: 'shadow_C' }, { userId: 'shadow_A' },
      { portfolio_id: 'shadow_A' }, { model_family: 'C' }, { userId: 'A' }, { userId: 'C' },
      { portfolio_id: ' a ' }, { model_family: ' shadow_c ' }, { user_id: ' c ' },
      { PORTFOLIO_ID: ' SHADOW_a ' }, { MODEL_FAMILY: ' a ' }, { USER_ID: ' SHADOW_C ' },
    ]) {
      assert.equal(targetsAppWallet(target), true);
      for (const path of ['/bets/place', '/budget/user1/init']) {
        const response = await fetch(`${server.base}${path}`, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 1000, ...target }) });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, 'APP_WALLET_MANAGED_AUTOMATICALLY');
      }
    }
    for (const alias of ['shadow_C', 'A', 'C', 'a', 'c', '%20SHADOW_c%20', '%20a%20']) {
      const pathTarget = await fetch(`${server.base}/budget/${alias}/init`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 1000 }) });
      assert.equal(pathTarget.status, 409, `path target ${alias}`);
      assert.equal((await pathTarget.json()).code, 'APP_WALLET_MANAGED_AUTOMATICALLY');
    }
    assert.deepEqual(server.calls, []);
  } finally { await server.close(); }
});

test('previous shared-user clients keep their existing placement and initialization contract', async () => {
  const f = fundedFixture();
  const server = await startRouter(f);
  try {
    for (const [path, body] of [['/budget/user2/init', { amount: 1000 }], ['/bets/place', { userId: 'user2', matchId: 'old-client' }]]) {
      const response = await fetch(`${server.base}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(server.calls.map((row) => [row[0], row[1]]), [['initBudget', 'user1'], ['placeBet', 'user1']]);
  } finally { await server.close(); }
});
