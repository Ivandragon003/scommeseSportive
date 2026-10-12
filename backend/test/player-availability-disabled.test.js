const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes.js');
const { isPlayerAvailabilityEnabled } = require('../dist/services/PlayerAvailabilityConfig.js');

test('lineups are paused by default and require an explicit opt-in', () => {
  assert.equal(isPlayerAvailabilityEnabled({}), false);
  assert.equal(isPlayerAvailabilityEnabled({ PLAYER_AVAILABILITY_ENABLED: 'false' }), false);
  assert.equal(isPlayerAvailabilityEnabled({ PLAYER_AVAILABILITY_ENABLED: ' TRUE ' }), false);
  assert.equal(isPlayerAvailabilityEnabled({ PLAYER_DATA_ENABLED: 'true', PLAYER_AVAILABILITY_ENABLED: ' TRUE ' }), true);
});

test('paused availability routes avoid every database read/write and provider call, including older APK requests', async () => {
  let calls = 0;
  const unexpected = () => { calls++; throw new Error('Lineup access while paused'); };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    playerAvailabilityEnabled: false,
    db: {
      getMatchById: unexpected, getUpcomingMatches: unexpected,
      getPlayersByTeam: unexpected, getPlayerLineupStatuses: unexpected,
      getRecentCompletedMatchesForTeam: unexpected, savePlayerLineupStatuses: unexpected,
    },
    svc: {},
    apiFootballService: {
      enabled: true, getFixturesByDate: unexpected, getSquad: unexpected,
      getInjuries: unexpected, getConfirmedLineups: unexpected,
    },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    for (const [path, method] of [
      ['/fixture', 'GET'], ['/sync', 'POST'], ['/refresh/fixture', 'POST'], ['/sync-upcoming', 'POST'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/player-availability${path}`, { method });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.enabled, false);
      assert.equal(payload.skipped, 'player_availability_disabled');
      assert.equal(payload.saved, 0);
      assert.equal(payload.data, null);
    }
    assert.equal(calls, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
