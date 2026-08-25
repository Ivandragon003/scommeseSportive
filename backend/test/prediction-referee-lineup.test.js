const test = require('node:test');
const assert = require('node:assert/strict');
const {
  conditionalPlayerPropOverProbability,
  buildOperationalLineupStatusMap,
  mergeSnapshotRoster,
  resolvePredictionRefereeName,
} = require('../dist/services/PredictionService.js');

test('arbitro richiesto prevale, altrimenti viene usato quello salvato sulla partita', () => {
  assert.equal(resolvePredictionRefereeName('  Orsato  ', 'Rossi'), 'Orsato');
  assert.equal(resolvePredictionRefereeName('', '  Rossi  '), 'Rossi');
  assert.equal(resolvePredictionRefereeName(undefined, null), null);
});

test('una formazione ufficiale rende non eleggibili tutti i non titolari della squadra', () => {
  const players = [
    { player_id: 'starter', team_id: 'team-a' },
    { player_id: 'stale-predicted', team_id: 'team-a' },
    ...Array.from({ length: 10 }, (_, index) => ({ player_id: `official-${index}`, team_id: 'team-a' })),
    { player_id: 'other-team', team_id: 'team-b' },
  ];
  const rows = [
    { player_id: 'starter', team_id: 'team-a', status: 'confirmed_starter', probability: 1 },
    ...Array.from({ length: 10 }, (_, index) => ({
      player_id: `official-${index}`, team_id: 'team-a', status: 'confirmed_starter', probability: 1,
    })),
    { player_id: 'stale-predicted', team_id: 'team-a', status: 'predicted_starter', probability: 0.9 },
    { player_id: 'other-team', team_id: 'team-b', status: 'predicted_starter', probability: 0.8 },
  ];
  const statuses = buildOperationalLineupStatusMap(rows, players);
  assert.deepEqual(statuses.get('starter'), { status: 'confirmed_starter', probability: 1 });
  assert.deepEqual(statuses.get('stale-predicted'), { status: 'confirmed_bench', probability: 0 });
  assert.deepEqual(statuses.get('other-team'), { status: 'predicted_starter', probability: 0.8 });
});

test('over e under player restano condizionati a una giocata valida senza trasformare la non titolarita in under', () => {
  const over = conditionalPlayerPropOverProbability(0.72);
  const under = 1 - over;
  assert.equal(over, 0.72);
  assert.equal(under, 0.28);
  assert.equal(conditionalPlayerPropOverProbability(2), 1);
  assert.equal(conditionalPlayerPropOverProbability(-1), 0);
});

test('il replay include un giocatore oggi trasferito solo se era nello snapshot pre-partita', () => {
  const active = [
    { player_id: 'active', team_id: 'team-a', is_available: 1 },
    { player_id: 'joined-later', team_id: 'team-a', is_available: 1 },
  ];
  const snapshotPlayers = [
    { player_id: 'historical-transfer', team_id: 'new-team', is_available: 1 },
  ];
  const merged = mergeSnapshotRoster(active, snapshotPlayers, [
    { player_id: 'active', team_id: 'team-a', status: 'confirmed_starter' },
    { player_id: 'historical-transfer', team_id: 'team-a', status: 'confirmed_starter' },
  ], 'team-a');
  assert.deepEqual(merged.map((player) => player.player_id), ['active', 'historical-transfer']);
  assert.equal(merged.find((player) => player.player_id === 'historical-transfer').team_id, 'team-a');
});
