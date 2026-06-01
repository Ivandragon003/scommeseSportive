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
