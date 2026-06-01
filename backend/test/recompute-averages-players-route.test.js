const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes.js');

/**
 * Characterization test for the player derived-stats rebuild, exercised through
 * POST /api/model/recompute-averages with recomputePlayers=true and
 * recomputeReferees=false. Written BEFORE extracting rebuildPlayerDerivedStats
 * out of routes.ts so the extraction can be proven behavior-preserving.
 *
 * Seed: one played match Inter (15 shots) vs Milan (10 shots) with a raw_json
 * shotmap. Lautaro (id 100, 90'): 4 shots, 1 goal, xG 0.8, 1 yellow; shotmap has
 * Goal(0.8) + SavedShot(0.3) => 2 on target, xGOT 1.1. Leao (id 200, 80'): 3
 * shots, xG 0.5; shotmap MissedShots => 0 on target.
 */
const RAW = JSON.stringify({
  details: {
    rosters: {
      h: { '1': { player_id: 100, player: 'Lautaro', position: 'F S', time: 90, shots: 4, goals: 1, xG: 0.8, yellow_card: 1, red_card: 0 } },
      a: { '2': { player_id: 200, player: 'Leao', position: 'M', time: 80, shots: 3, goals: 0, xG: 0.5, yellow_card: 0, red_card: 0 } },
    },
    shots: {
      h: [
        { player_id: 100, result: 'Goal', xG: 0.8 },
        { player_id: 100, result: 'SavedShot', xG: 0.3 },
      ],
      a: [{ player_id: 200, result: 'MissedShots', xG: 0.5 }],
    },
  },
});

const SEED_MATCHES = [
  {
    match_id: 'M1', home_team_id: 'inter', away_team_id: 'milan',
    home_goals: 1, away_goals: 0, home_shots: 15, away_shots: 10, raw_json: RAW,
  },
];

const startRouter = async (captured) => {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      getTeams: async () => [],
      recomputeTeamAverages: async () => undefined,
      getMatches: async () => SEED_MATCHES,
      markPlayersUnavailable: async () => 2,
      upsertPlayer: async (payload) => { captured.push(payload); },
    },
    svc: {},
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/api`, close: () => new Promise((r) => server.close(r)) };
};

const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} != ${expected}`);

test('POST /model/recompute-averages rebuilds player aggregates (characterization)', async () => {
  const captured = [];
  const { baseUrl, close } = await startRouter(captured);
  try {
    const res = await fetch(`${baseUrl}/model/recompute-averages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ competition: 'Serie A', recomputePlayers: true, recomputeReferees: false }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.playersMarkedUnavailable, 2);
    assert.equal(body.playersDetected, 2);
    assert.equal(body.playersUpdated, 2);
    assert.equal(body.playedMatchesConsidered, 1);
    assert.equal(body.matchesWithShotmap, 1);

    const byId = Object.fromEntries(captured.map((p) => [p.playerId, p]));

    const lautaro = byId['understat_player_100'];
    assert.ok(lautaro, 'Lautaro upserted');
    assert.equal(lautaro.positionCode, 'F');
    assert.equal(lautaro.gamesPlayed, 1);
    assert.equal(lautaro.totalShots, 4);
    assert.equal(lautaro.totalShotsOnTarget, 2);
    assert.equal(lautaro.totalGoals, 1);
    assert.equal(lautaro.yellowCardsTotal, 1);
    near(lautaro.avgShotsPerGame, 4, 'lautaro avgShots');
    near(lautaro.shotsPer90, 4, 'lautaro shotsPer90');
    near(lautaro.shotOnTargetPct, 0.5, 'lautaro sotPct');
    near(lautaro.goalConversion, 0.25, 'lautaro goalConv');
    near(lautaro.avgXGOTPerGame, 1.1, 'lautaro xgot');
    near(lautaro.shotShareOfTeam, 4 / 15, 'lautaro shotShare');
    near(lautaro.cardsPer90, 1, 'lautaro cardsPer90');

    const leao = byId['understat_player_200'];
    assert.ok(leao, 'Leao upserted');
    assert.equal(leao.positionCode, 'M');
    assert.equal(leao.totalShotsOnTarget, 0);
    near(leao.shotsPer90, (3 / 80) * 90, 'leao shotsPer90');
    near(leao.shotShareOfTeam, 3 / 10, 'leao shotShare');
    near(leao.shotOnTargetPct, 0, 'leao sotPct');
  } finally {
    await close();
  }
});
