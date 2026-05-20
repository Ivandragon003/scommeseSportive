const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPlayerPropSelectionKey,
  normalizePlayerNameForProp,
  parseLegacyPlayerPropOddsKey,
  parsePlayerPropSelectionKey,
} = require('../dist/services/playerProps.js');

test('normalizes player prop selection keys with stable line tokens', () => {
  const key = buildPlayerPropSelectionKey('understat_player_123', 'shots', 'over', 1.5);
  assert.equal(key, 'player_understat_player_123_shots_over_1_5');

  const parsed = parsePlayerPropSelectionKey(key);
  assert.deepEqual(parsed, {
    playerId: 'understat_player_123',
    marketType: 'shots',
    side: 'over',
    line: 1.5,
    lineKey: '1_5',
  });
});

test('normalizes player names and parses legacy Eurobet player prop keys', () => {
  assert.equal(normalizePlayerNameForProp('Nicolò Barella'), 'nicolo_barella');

  const parsed = parseLegacyPlayerPropOddsKey('player_sot_lautaro_martinez_over_0.5');
  assert.deepEqual(parsed, {
    playerSlug: 'lautaro_martinez',
    marketType: 'sot',
    side: 'over',
    line: 0.5,
    lineKey: '0_5',
  });
});
