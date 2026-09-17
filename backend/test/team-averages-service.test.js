const test = require('node:test');
const assert = require('node:assert/strict');
const { recomputeTeamAveragesForMatchRows } = require('../dist/services/TeamAveragesService.js');

/**
 * Characterization test for recomputeTeamAveragesForMatchRows, extracted from
 * api/routes.ts. Its only caller is the scraper-coupled
 * /scraper/sofascore/supplemental route, so a route-level test would be brittle;
 * this pins the unit behavior directly (dedup of team ids, skip empties, one
 * recompute call per unique team, returned count).
 */

test('recomputes each unique non-empty team id exactly once and returns the count', async () => {
  const calls = [];
  const db = { recomputeTeamAverages: async (teamId) => { calls.push(teamId); } };

  const rows = [
    { home_team_id: 'inter', away_team_id: 'milan' },
    { home_team_id: 'inter', away_team_id: 'roma' },   // inter duplicated
    { home_team_id: '', away_team_id: '  ' },           // empty/blank skipped
    { home_team_id: null, away_team_id: 'lazio' },      // null skipped, lazio kept
  ];

  const count = await recomputeTeamAveragesForMatchRows(db, rows);

  assert.deepEqual(calls, ['inter', 'milan', 'roma', 'lazio']);
  assert.equal(count, 4);
});

test('returns 0 for empty input and never calls the db', async () => {
  const calls = [];
  const db = { recomputeTeamAverages: async (teamId) => { calls.push(teamId); } };
  assert.equal(await recomputeTeamAveragesForMatchRows(db, []), 0);
  assert.equal(calls.length, 0);
});

test('prefers one batch for all unique teams when the adapter supports it', async () => {
  const calls = [];
  const db = {
    recomputeTeamAverages: async () => { throw new Error('unexpected single-team call'); },
    recomputeTeamAveragesBatch: async (ids) => { calls.push(ids); },
  };
  const count = await recomputeTeamAveragesForMatchRows(db, [
    { home_team_id: 'a', away_team_id: 'b' },
    { home_team_id: 'a', away_team_id: 'c' },
  ]);
  assert.equal(count, 3);
  assert.deepEqual(calls, [['a', 'b', 'c']]);
});

test('manual recomputation route calls the set-based adapter once', async () => {
  const express = require('express');
  const { createApiRouter } = require('../dist/api/routes.js');
  const calls = [];
  const db = {
    getTeams: async () => [{ team_id: 'a' }, { team_id: 'b' }],
    recomputeTeamAverages: async () => { throw new Error('unexpected single-team call'); },
    recomputeTeamAveragesBatch: async (ids) => { calls.push(ids); },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ db, svc: {} }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/model/recompute-averages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recomputePlayers: false, recomputeReferees: false }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).teamsUpdated, 2);
    assert.deepEqual(calls, [['a', 'b']]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
