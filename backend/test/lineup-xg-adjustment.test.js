const test = require('node:test');
const assert = require('node:assert/strict');
const { computeLineupXgAdjustment } = require('../dist/services/LineupXgAdjustmentService.js');

function buildRoster() {
  return [
    { player_id: 'p1', name: 'Star Striker', avg_xg_per_game: 0.60 },
    { player_id: 'p2', name: 'Second Forward', avg_xg_per_game: 0.30 },
    { player_id: 'p3', name: 'Midfielder', avg_xg_per_game: 0.10 },
    { player_id: 'p4', name: 'Defender', xg_per90: 0.05, avg_minutes: 90 },
  ];
}

test('assenza del bomber riduce xG fino al cap massimo', () => {
  // Quota Star: 0.60/1.05 = 0.571; perdita netta 0.571*0.4 = 0.229 -> cap 0.18
  const result = computeLineupXgAdjustment(buildRoster(), ['star striker']);
  assert.equal(result.multiplier, 0.82);
  assert.deepEqual(result.matchedAbsences, ['Star Striker']);
  assert.deepEqual(result.unmatchedAbsences, []);
  assert.ok(result.absentXgShare > 0.55 && result.absentXgShare < 0.60);
});

test('assenza di un difensore a basso xG riduce poco', () => {
  const result = computeLineupXgAdjustment(buildRoster(), ['Defender']);
  assert.ok(result.multiplier > 0.95 && result.multiplier < 1);
});

test('match per player_id case-insensitive', () => {
  const result = computeLineupXgAdjustment(buildRoster(), ['P2']);
  assert.deepEqual(result.matchedAbsences, ['Second Forward']);
  assert.ok(result.multiplier < 1);
});

test('nomi sconosciuti restano neutri e vengono riportati', () => {
  const result = computeLineupXgAdjustment(buildRoster(), ['Giocatore Inventato']);
  assert.equal(result.multiplier, 1);
  assert.deepEqual(result.matchedAbsences, []);
  assert.deepEqual(result.unmatchedAbsences, ['giocatore inventato']);
});

test('lista assenze vuota o rosa vuota -> neutro', () => {
  assert.equal(computeLineupXgAdjustment(buildRoster(), []).multiplier, 1);
  assert.equal(computeLineupXgAdjustment(buildRoster(), null).multiplier, 1);
  assert.equal(computeLineupXgAdjustment([], ['Star Striker']).multiplier, 1);
});

test('replacementRatio 1 -> il sostituto compensa tutto, nessuna riduzione', () => {
  const result = computeLineupXgAdjustment(buildRoster(), ['Star Striker'], { replacementRatio: 1 });
  assert.equal(result.multiplier, 1);
});

test('rosa senza dati xG -> neutro anche con assenze riconosciute', () => {
  const roster = [
    { player_id: 'p1', name: 'NoData One' },
    { player_id: 'p2', name: 'NoData Two', avg_xg_per_game: 0 },
  ];
  const result = computeLineupXgAdjustment(roster, ['NoData One']);
  assert.equal(result.multiplier, 1);
});

test('fallback xg_per90 * minuti quando manca avg_xg_per_game', () => {
  const roster = [
    { player_id: 'p1', name: 'Per90 Player', xg_per90: 0.6, avg_minutes: 45 }, // peso 0.3
    { player_id: 'p2', name: 'Other', avg_xg_per_game: 0.3 },
  ];
  // Quota assente 0.3/0.6 = 0.5 -> perdita 0.5*0.4 = 0.2 -> cap 0.18
  const result = computeLineupXgAdjustment(roster, ['Per90 Player']);
  assert.equal(result.multiplier, 0.82);
});
