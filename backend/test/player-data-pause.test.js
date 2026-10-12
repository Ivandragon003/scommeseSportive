const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { isPlayerDataEnabled } = require('../dist/services/PlayerDataConfig.js');
const { PredictionService } = require('../dist/services/PredictionService.js');
const { enabledMatchEventMarkets } = require('../dist/services/OddsMarketPolicy.js');
const { createApiRouter } = require('../dist/api/routes.js');

test('player pause needs explicit opt-in and omits provider player markets', () => {
  assert.equal(isPlayerDataEnabled({}), false);
  assert.equal(isPlayerDataEnabled({ PLAYER_DATA_ENABLED: ' TRUE ' }), true);
  assert.equal(enabledMatchEventMarkets().some((key) => key.startsWith('player_')), false);
  assert.ok(enabledMatchEventMarkets().includes('alternate_totals_cards'));
});

test('team prediction reaches context without reading players or lineup snapshots while paused', async () => {
  const service = new PredictionService({
    getTeamsByIds: async (ids) => ids.map((team_id) => ({ team_id })),
    getMatchById: async () => ({ date: '2026-10-12T18:00:00Z' }),
    getTeamHistoricalCoverageBatch: async () => ({}),
    getTeamScheduleInsightsBatch: async () => ({}),
    getPlayersByTeams: async () => { assert.fail('players read while paused'); },
    getPlayerLineupStatuses: async () => { assert.fail('lineup read while paused'); },
  });
  service.getModel = async () => ({});
  service.applyAdaptiveTuning = async () => undefined;
  const reachedContext = new Error('context reached');
  service.contextBuilder.build = (input) => {
    assert.deepEqual(input.homePlayers, []);
    assert.deepEqual(input.awayPlayers, []);
    throw reachedContext;
  };
  await assert.rejects(service.predict({ homeTeamId: 'home', awayTeamId: 'away', matchId: 'fixture' }), (error) => error === reachedContext);
  assert.deepEqual(service.buildPlayerPropMarkets({ odds: { player_goals_someone_over_0_5: 2 } }).probabilities, {});
});

test('players API requests from older clients do not read or write stored players', async () => {
  const unexpected = () => { assert.fail('players access while paused'); };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ db: { getPlayersByTeam: unexpected, upsertPlayer: unexpected, upsertPlayers: unexpected }, svc: {} }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    for (const [path, method] of [['/players/team', 'GET'], ['/players', 'POST'], ['/players/bulk', 'POST']]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.skipped, 'player_data_disabled');
      assert.deepEqual(payload.data, []);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
