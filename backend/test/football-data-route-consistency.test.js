const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const footballData = require('../dist/services/FootballDataService.js');
const { createApiRouter } = require('../dist/api/routes.js');

async function runSync({ matchesDeleted = 0, updatedTeamIds = [], ready = true, recompute = true }) {
  const original = {
    pruneOldSeasons: footballData.pruneOldSeasons,
    syncFootballData: footballData.syncFootballData,
  };
  const calls = [];
  footballData.pruneOldSeasons = async () => ({ matchesDeleted });
  footballData.syncFootballData = async () => {
    calls.push(['sync']);
    return {
      updatedTeamIds, allExpectedSeasonsReady: ready,
      completed: ready ? 5 : 4, pending: ready ? 0 : 1, requested: 5,
    };
  };
  const db = {
    db: {},
    async getTeams() {
      assert.equal(calls[0]?.[0], 'dirty-all');
      calls.push(['teams']);
      return ['a', 'b', 'c'].map((team_id) => ({ team_id }));
    },
    markTeamAveragesDirty(ids) { calls.push(['dirty', [...ids]]); },
    markAllTeamAveragesDirty() { calls.push(['dirty-all']); },
    async recomputeTeamAveragesBatch(ids) { calls.push(['recompute', [...ids]]); },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ db, svc: {} }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scraper/football-data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ competitions: ['Ligue 1'], recomputeAverages: recompute }),
    });
    return { status: response.status, payload: await response.json(), calls };
  } finally {
    Object.assign(footballData, original);
    await new Promise((resolve) => server.close(resolve));
  }
}

test('football-data route: unchanged sync avoids team reads and recomputation', async () => {
  const result = await runSync({});
  assert.equal(result.status, 200);
  assert.equal(result.payload.teamsUpdated, 0);
  assert.equal(result.calls.some(([kind]) => kind === 'teams' || kind === 'recompute'), false);
});

test('football-data route: partial sync refreshes only changed teams before returning the failed gate', async () => {
  const result = await runSync({ updatedTeamIds: ['b', 'a', 'b'], ready: false });
  assert.equal(result.status, 502);
  assert.equal(result.payload.teamsUpdated, 2);
  assert.deepEqual(result.calls.filter(([kind]) => kind === 'recompute'), [['recompute', ['b', 'a']]]);
  assert.equal(result.calls.some(([kind]) => kind === 'teams'), false);
});

test('football-data route: retention with no supplemental changes refreshes all team averages', async () => {
  const result = await runSync({ matchesDeleted: 7 });
  assert.equal(result.status, 200);
  assert.equal(result.payload.teamsUpdated, 3);
  assert.deepEqual(result.calls[0], ['dirty-all']);
  assert.deepEqual(result.calls[1], ['teams']);
  assert.deepEqual(result.calls[2], ['dirty', ['a', 'b', 'c']]);
  assert.deepEqual(result.calls[3], ['sync']);
  assert.deepEqual(result.calls.at(-1), ['recompute', ['a', 'b', 'c']]);
});

test('football-data route: explicit recomputation opt-out still invalidates pending averages after retention', async () => {
  const result = await runSync({ matchesDeleted: 7, recompute: false });
  assert.equal(result.status, 200);
  assert.equal(result.payload.teamsUpdated, 0);
  assert.deepEqual(result.calls[0], ['dirty-all']);
  assert.deepEqual(result.calls[2], ['dirty', ['a', 'b', 'c']]);
  assert.equal(result.calls.some(([kind]) => kind === 'recompute'), false);
});
