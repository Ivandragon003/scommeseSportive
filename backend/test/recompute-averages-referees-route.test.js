const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes.js');

/**
 * Characterization test for the referee-derived-stats rebuild, exercised through
 * POST /api/model/recompute-averages with recomputeReferees=true and
 * recomputePlayers=false (so only the referee path runs).
 *
 * Written BEFORE extracting rebuildRefereeDerivedStats out of routes.ts: it pins
 * the current aggregation behavior (avg fouls/yellow/red, yellow dispersion,
 * match filtering, counts) so the extraction can be proven behavior-preserving.
 *
 * Seed (hand-verifiable):
 *   Rocchi  M1 fouls 10+12, yellow 2+3, red 0+1   -> totals 22 / 5 / 1
 *           M2 fouls  8+10, yellow 1+2, red 0+0   -> totals 18 / 3 / 0
 *   Orsato  M3 fouls 15+9,  yellow 4+4, red null  -> totals 24 / 8 / (red excluded)
 *   Excluded: M4 (home_goals null => not played), M5 (empty referee)
 */
const SEED_MATCHES = [
  { match_id: 'M1', referee: 'Rocchi', home_goals: 1, away_goals: 1, home_fouls: 10, away_fouls: 12, home_yellow_cards: 2, away_yellow_cards: 3, home_red_cards: 0, away_red_cards: 1 },
  { match_id: 'M2', referee: 'Rocchi', home_goals: 2, away_goals: 0, home_fouls: 8, away_fouls: 10, home_yellow_cards: 1, away_yellow_cards: 2, home_red_cards: 0, away_red_cards: 0 },
  { match_id: 'M3', referee: 'Orsato', home_goals: 0, away_goals: 0, home_fouls: 15, away_fouls: 9, home_yellow_cards: 4, away_yellow_cards: 4, home_red_cards: null, away_red_cards: null },
  { match_id: 'M4', referee: 'Maresca', home_goals: null, away_goals: null, home_fouls: 5, away_fouls: 6, home_yellow_cards: 1, away_yellow_cards: 1, home_red_cards: 0, away_red_cards: 0 },
  { match_id: 'M5', referee: '', home_goals: 1, away_goals: 2, home_fouls: 7, away_fouls: 8, home_yellow_cards: 2, away_yellow_cards: 2, home_red_cards: 0, away_red_cards: 0 },
];

const startRouter = async (captured) => {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      getTeams: async () => [],
      recomputeTeamAverages: async () => undefined,
      getMatches: async () => SEED_MATCHES,
      upsertReferee: async (payload) => { captured.push(payload); },
    },
    svc: {},
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/api`, close: () => new Promise((r) => server.close(r)) };
};

test('POST /model/recompute-averages rebuilds referee aggregates (characterization)', async () => {
  const captured = [];
  const { baseUrl, close } = await startRouter(captured);
  try {
    const res = await fetch(`${baseUrl}/model/recompute-averages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ competition: 'Serie A', recomputePlayers: false, recomputeReferees: true }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.refereesDetected, 2);
    assert.equal(body.refereesUpdated, 2);
    assert.equal(body.matchesConsidered, 3);

    const byName = Object.fromEntries(captured.map((r) => [r.name, r]));
    assert.deepEqual(byName.Rocchi, {
      name: 'Rocchi', avgFouls: 20, avgYellow: 4, avgRed: 0.5, games: 2, dispersionYellow: 1,
    });
    assert.deepEqual(byName.Orsato, {
      name: 'Orsato', avgFouls: 24, avgYellow: 8, avgRed: undefined, games: 1, dispersionYellow: 0,
    });
  } finally {
    await close();
  }
});
