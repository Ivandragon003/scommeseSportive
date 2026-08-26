const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bookmakerMarketGroupKey,
  buildCoherentBookmakerOddsBundle,
  isExactScoreSelection,
} = require('../dist/services/BookmakerOddsSelectionService');

test('groups complementary selections on the same market line', () => {
  assert.equal(bookmakerMarketGroupKey('homeWin'), bookmakerMarketGroupKey('draw'));
  assert.equal(bookmakerMarketGroupKey('over25'), bookmakerMarketGroupKey('under25'));
  assert.equal(bookmakerMarketGroupKey('cards_total_over_4.5'), bookmakerMarketGroupKey('cards_total_under_4.5'));
  assert.equal(bookmakerMarketGroupKey('player_mario_shots_over_1.5'), bookmakerMarketGroupKey('player_mario_shots_under_1.5'));
  assert.notEqual(bookmakerMarketGroupKey('over25'), bookmakerMarketGroupKey('over35'));
});

test('selects one coherent bookmaker per group while expanding coverage', () => {
  const bundle = buildCoherentBookmakerOddsBundle({
    Codere: { homeWin: 1.8, draw: 3.2, awayWin: 4.1, over25: 1.9, under25: 1.9 },
    Pinnacle: {
      homeWin: 1.82, draw: 3.3, awayWin: 4.2,
      'cards_total_over_4.5': 2.05, 'cards_total_under_4.5': 1.75,
    },
    '1xBet': {
      'player_mario_shots_over_1.5': 2.1,
      'player_mario_shots_under_1.5': 1.7,
    },
  });

  assert.equal(bundle.bookmakerBySelection.homeWin, 'Pinnacle');
  assert.equal(bundle.bookmakerBySelection.draw, 'Pinnacle');
  assert.equal(bundle.bookmakerBySelection.awayWin, 'Pinnacle');
  assert.equal(bundle.bookmakerBySelection['cards_total_over_4.5'], 'Pinnacle');
  assert.equal(bundle.bookmakerBySelection['player_mario_shots_over_1.5'], '1xBet');
  assert.deepEqual(bundle.bookmakers, ['1xBet', 'Codere', 'Pinnacle']);
});

test('never imports exact-score selections into the operational bundle', () => {
  const bundle = buildCoherentBookmakerOddsBundle({
    Bookmaker: { homeWin: 1.8, 'exact_2-1': 8.5 },
  });

  assert.equal(isExactScoreSelection('exact_2-1'), true);
  assert.equal(bundle.odds.homeWin, 1.8);
  assert.equal(bundle.odds['exact_2-1'], undefined);
});
