const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes.js');

const startRouter = async () => {
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
