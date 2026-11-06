const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes.js');

const startRouter = async (options = {}) => {
  const calls = [];
  const svc = {
    syncPendingBets: async (userId) => calls.push(['syncPendingBets', userId]),
    getBudget: async (userId) => ({ userId }),
    getBets: async (userId) => [{ userId }],
    placeBet: async (...args) => {
      calls.push(['placeBet', ...args]);
      return { userId: args[0] };
    },
    settleBet: async (betId) => ({ betId }),
  };
  const db = {
    recommendations: { listPaperBets: async () => {
      calls.push(['listPaperBets']);
      if (options.paperError) throw Object.assign(new Error('Missing paper schema'), { code: 'paper_schema_required' });
      return [];
    }, isPaperUninitialized: async () => options.paperUninitialized === true },
    getBet: async (betId) => ({ bet_id: betId, user_id: betId === 'owned' ? 'user1' : 'user2' }),
    getPredictionArchive: async (options) => {
      calls.push(['getPredictionArchive', options]);
      return [];
    },
    getBetOpportunityArchive: async (options) => {
      calls.push(['getBetOpportunityArchive', options]);
      return [];
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ db, svc, sharedDataUserId: 'user1' }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    calls,
    baseUrl: `http://127.0.0.1:${port}/api`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

test('paper endpoint returns complete unit metrics without initializing funded wallets', async () => {
  const { baseUrl, calls, close } = await startRouter();
  try {
    const response = await fetch(`${baseUrl}/paper-bets`), payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.accountingMode, 'PAPER_FIXED_UNIT'); assert.equal(payload.data.fixedStakeUnits, 1);
    assert.equal(payload.data.totalCount, 0); assert.equal(payload.data.profitUnits, 0);
    assert.equal(payload.data.roiPercent, null); assert.equal(payload.data.portfolios.length, 2);
    assert.deepEqual(calls, [['listPaperBets']]);
  } finally { await close(); }
});

test('paper endpoint reports an unprepared schema instead of claiming an empty ledger', async () => {
  const { baseUrl, close } = await startRouter({ paperError: true });
  try {
    const response = await fetch(`${baseUrl}/paper-bets`), payload = await response.json();
    assert.equal(response.status, 503); assert.equal(payload.success, false);
    assert.equal(payload.code, 'paper_schema_required'); assert.equal(payload.data, undefined);
  } finally { await close(); }
});

test('legacy synchronization continues before paper activation but does not mask a missing active paper schema', async () => {
  for (const paperUninitialized of [true, false]) {
    const { baseUrl, calls, close } = await startRouter({ paperError: true, paperUninitialized });
    try {
      const response = await fetch(`${baseUrl}/bets/sync`, { method: 'POST' });
      const payload = await response.json();
      assert.deepEqual(calls.find(row => row[0] === 'syncPendingBets'), ['syncPendingBets', 'user1']);
      assert.equal(response.status, paperUninitialized ? 200 : 500);
      if (paperUninitialized) assert.deepEqual(payload.paper, { checked: 0, settled: 0, unresolved: 0, accountingState: 'NOT_INITIALIZED' });
      else assert.equal(payload.success, false);
    } finally { await close(); }
  }
});

test('budget, bet list and placement always use the server-side shared user', async () => {
  const { baseUrl, calls, close } = await startRouter();
  try {
    const budget = await fetch(`${baseUrl}/budget/user2`);
    assert.equal((await budget.json()).data.userId, 'user1');

    const bets = await fetch(`${baseUrl}/bets/user2`);
    assert.equal((await bets.json()).data[0].userId, 'user1');
    assert.equal(calls.some((entry) => entry[0] === 'syncPendingBets'), false);

    const synchronized = await fetch(`${baseUrl}/bets/sync`, { method: 'POST' });
    assert.equal(synchronized.status, 200);
    assert.deepEqual(calls.find((entry) => entry[0] === 'syncPendingBets'), ['syncPendingBets', 'user1']);

    const placed = await fetch(`${baseUrl}/bets/place`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'user2',
        matchId: 'match-1',
        marketName: '1X2',
        selection: 'Home',
        odds: 2,
        stake: 10,
        ourProbability: 0.6,
        expectedValue: 0.2,
      }),
    });
    assert.equal((await placed.json()).data.userId, 'user1');
    assert.equal(calls.find((entry) => entry[0] === 'placeBet')[1], 'user1');
  } finally {
    await close();
  }
});

test('settlement cannot mutate a bet outside the shared dataset', async () => {
  const { baseUrl, close } = await startRouter();
  try {
    const denied = await fetch(`${baseUrl}/bets/not-owned/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ won: true }),
    });
    assert.equal(denied.status, 404);

    const owned = await fetch(`${baseUrl}/bets/owned/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ won: true }),
    });
    assert.equal(owned.status, 200);
  } finally {
    await close();
  }
});

test('prediction and opportunity archives are scoped to the shared user', async () => {
  const { baseUrl, calls, close } = await startRouter();
  try {
    assert.equal((await fetch(`${baseUrl}/predictions/archive`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/bet-opportunities/archive`)).status, 200);

    assert.equal(calls.find((entry) => entry[0] === 'getPredictionArchive')[1].userId, 'user1');
    assert.equal(calls.find((entry) => entry[0] === 'getBetOpportunityArchive')[1].userId, 'user1');
  } finally {
    await close();
  }
});
