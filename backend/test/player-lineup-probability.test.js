const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assessPlayerLineup,
  estimateStartingProbability,
} = require('../dist/services/PlayerLineupProbabilityService.js');

test('la formazione ufficiale prevale sul modello storico', () => {
  const result = assessPlayerLineup(
    { avg_minutes: 20, games_played: 3 },
    { status: 'confirmed_starter', probability: 1 },
  );
  assert.equal(result.probability, 1);
  assert.equal(result.tier, 'confirmed_starter');
  assert.deepEqual(result.warnings, []);
});

test('il modello distingue titolare probabile e ballottaggio', () => {
  const regular = assessPlayerLineup({ avg_minutes: 86, games_played: 15 });
  const rotation = assessPlayerLineup({ avg_minutes: 60, games_played: 8 });
  assert.equal(regular.tier, 'probable_starter');
  assert.equal(rotation.tier, 'ballotaggio');
  assert.ok(regular.probability > rotation.probability);
});

test('campione e minuti troppo bassi producono una probabilità prudente', () => {
  assert.ok(estimateStartingProbability({ avg_minutes: 25, games_played: 2 }) < 0.70);
  const result = assessPlayerLineup({ avg_minutes: 25, games_played: 2 });
  assert.equal(result.tier, 'uncertain');
  assert.ok(result.warnings.includes('lineup_modelled_not_confirmed'));
});

test('panchina e indisponibilità bloccano la player bet', () => {
  assert.equal(assessPlayerLineup({}, { status: 'confirmed_bench', probability: 0 }).tier, 'confirmed_bench');
  assert.equal(assessPlayerLineup({}, { status: 'unavailable', probability: 0 }).tier, 'unavailable');
});
