const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes.js');
const { DatabaseService } = require('../dist/db/DatabaseService.js');

test('two concurrent overview requests share aggregate reads; a team write invalidates them', async () => {
  let coverageReads = 0;
  let leagueReads = 0;
  const db = {
    getMatchesCoverageStats: async () => {
      coverageReads++;
      return { fields: Object.fromEntries(['xg', 'shots', 'shotsOnTarget', 'yellowCards'].map((key) => [key, { pct: 100 }])) };
    },
    getLeagueSummaries: async () => { leagueReads++; return []; },
    getPlayerCoverageByLeague: async () => assert.fail('player coverage while paused'),
    upsertTeam: async () => undefined,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ db, svc: {} }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const responses = await Promise.all([fetch(`${url}/stats/overview`), fetch(`${url}/stats/overview`)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.playerDataEnabled, false);
    }
    assert.equal(coverageReads, 1);
    assert.equal(leagueReads, 1);
    assert.equal((await fetch(`${url}/teams`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal((await fetch(`${url}/stats/overview`)).status, 200);
    assert.equal(coverageReads, 2);
    assert.equal(leagueReads, 2);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('coverage SQL itself does not read the player table while paused', async () => {
  const db = Object.create(DatabaseService.prototype);
  const sql = [];
  db.get = async (query) => { sql.push(query); return {}; };
  await db.getMatchesCoverageStats();
  db.all = async () => assert.fail('player league query while paused');
  await db.getPlayerCoverageByLeague(['Serie A']);
  assert.ok(sql.some((query) => query.includes('FROM matches')));
  assert.equal(sql.some((query) => query.includes('FROM players')), false);
});
