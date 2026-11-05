'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PredictionContextBuilder } = require('../dist/services/PredictionContextBuilder');
const { playerShotStarterEvidence } = require('../dist/services/PredictionService');
const { SpecializedModels } = require('../dist/models/markets/SpecializedModels');
const cutoff = '2026-11-05T12:00:00Z';
const observed = (id, extra = {}) => ({ player_id: id, team_id: 'home', games_played: 20, shot_share_of_team: 0.2, avg_shots_per_game: 2, position_code: 'FW', ...extra });
const identity = (id, extra = {}) => ({ player_id: id, team_id: 'home', games_played: 0, shot_share_of_team: 0, avg_shots_per_game: 0, position_code: 'FW', stats_json: JSON.stringify({ identityOnly: true }), ...extra });
const lineup = (id, extra = {}) => ({ match_id: 'm', team_id: 'home', player_id: id, status: 'confirmed_starter', fetched_at: cutoff, ...extra });
const evidence = rows => playerShotStarterEvidence(rows, 'm', ['home', 'away'], cutoff);
const build = (players, rows = []) => new PredictionContextBuilder().build({ request: {}, homeTeam: {}, awayTeam: {}, referee: null, homePlayers: players, awayPlayers: [], playerShotStarters: evidence(rows) }).supplementaryData.homePlayers;
const predict = players => new SpecializedModels().computePlayerShotsPredictions(players, 12, 4);

test('unconfirmed identity-only roster cannot reduce observed players predicted shots', () => {
  const original = [observed('one'), observed('two', { shot_share_of_team: 0.1 })];
  const extra = Array.from({ length: 30 }, (_, index) => identity(`i${index}`));
  assert.deepEqual(predict(build([...original, ...extra])), predict(build(original)));
});

test('confirmed and predicted starter identity retains prior with zero observations', () => {
  for (const status of ['confirmed_starter', 'predicted_starter']) {
    const players = build([identity('i')], [lineup('i', { status })]);
    assert.equal(players.length, 1); assert.equal(players[0].gamesPlayed, 0); assert.equal(players[0].shotShareSampleSize, 0);
    assert.equal(predict(players).length, 1); assert.ok(predict(players)[0].expectedShots > 0);
  }
});

test('lineup evidence is bound to match, team, time and starter status', () => {
  const wrong = [lineup('i', { match_id: 'wrong' }), lineup('i', { team_id: 'away' }), lineup('i', { fetched_at: '2026-11-05T12:00:01Z' }), lineup('i', { fetched_at: null }), lineup('i', { fetched_at: '2026-11-05 11:59:00' }), lineup('i', { fetched_at: '2026-02-30T11:59:00Z' }), lineup('i', { status: 'confirmed_bench' }), lineup('i', { status: 'unavailable' })];
  for (const invalid of wrong) assert.equal(build([identity('i')], [invalid]).length, 0);
  assert.equal(build([identity('i')], [lineup('i'), lineup('i', { status: 'confirmed_bench' })]).length, 0);
  assert.equal(playerShotStarterEvidence([lineup('i')], undefined, ['home'], cutoff).size, 0);
});

test('goalkeeper aliases are excluded from outfield and observed zeros remain eligible', () => {
  const players = build([observed('zero', { shot_share_of_team: 0 }), observed('keeper', { position_code: 'Goalkeeper' })]);
  assert.equal(players.find(p => p.playerId === 'zero').shotShareOfTeam, 0);
  assert.equal(players.find(p => p.playerId === 'keeper').positionCode, 'GK');
  assert.deepEqual(predict(players).map(p => p.playerId), ['zero']);
  assert.deepEqual(build([], []), []);
});


test('transferred identity uses historical context team for starter evidence', () => {
  const player = identity('transfer', { team_id: 'current-team' });
  const create = (rows) => new PredictionContextBuilder().build({ request: {}, homeTeam: { team_id: 'home' }, awayTeam: {}, referee: null, homePlayers: [player], awayPlayers: [], playerShotStarters: evidence(rows) }).supplementaryData.homePlayers;
  assert.equal(create([lineup('transfer')]).length, 1);
  assert.equal(create([lineup('transfer', { team_id: 'away' })]).length, 0);
  assert.equal(create([lineup('transfer', { status: 'confirmed_bench' })]).length, 0);
  assert.equal(create([lineup('transfer', { fetched_at: '2026-11-05T12:00:01Z' })]).length, 0);
});
