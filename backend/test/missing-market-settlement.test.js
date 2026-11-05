const test = require('node:test');
const assert = require('node:assert/strict');
const { PredictionService } = require('../dist/services/PredictionService.js');

const complete = { home_goals: 1, away_goals: 0, home_shots: 0, away_shots: 0, home_shots_on_target: 0, away_shots_on_target: 0, home_yellow_cards: 0, away_yellow_cards: 0, home_red_cards: 0, away_red_cards: 0 };
const cases = [
  ['shots_total_under_15.5', 'away_shots'], ['shotsUnder155', 'away_shots'], ['shots_under155', 'away_shots'],
  ['shots_home_under_5.5', 'home_shots'], ['shotsHomeUnder55', 'home_shots'],
  ['sot_total_under_5.5', 'away_shots_on_target'], ['shotsOTUnder55', 'away_shots_on_target'], ['sot_under55', 'away_shots_on_target'],
  ['yellow_under_4.5', 'away_yellow_cards'], ['yellowUnder45', 'away_yellow_cards'], ['cards_under45', 'away_yellow_cards'],
  ['cards_total_under_4.5', 'away_red_cards'], ['cardsTotalUnder45', 'away_red_cards'],
];

test('stat outcomes require observed nonnegative integer components; zero remains observed', () => {
  const service = new PredictionService({});
  for (const [selection, missingField] of cases) {
    assert.equal(service.evaluateSelectionAgainstMatch(selection, complete)?.status, 'WON', selection);
    for (const value of [null, undefined, '', ' ', -1, 1.5, NaN, false, []]) {
      assert.equal(service.evaluateSelectionAgainstMatch(selection, { ...complete, [missingField]: value }), null, `${selection} ${String(value)}`);
    }
  }
  assert.equal(service.evaluateSelectionAgainstMatch('shotsHomeUnder55', { ...complete, away_shots: null })?.status, 'WON');
  assert.equal(service.evaluateSelectionAgainstMatch('cardsTotalOver15', { ...complete, home_red_cards: 1 })?.status, 'WON');
  assert.equal(service.evaluateSelectionAgainstMatch('yellowUnder45', { ...complete, home_red_cards: null })?.status, 'WON');
});

test('player outcomes abstain without observations and settle zero in normalized records', () => {
  const service = new PredictionService({});
  for (const [market, field] of [['shots', 'shots'], ['sot', 'shotsOnTarget'], ['yellow', 'yellowCards']]) {
    const selection = `player_understat_player_77_${market}_under_0_5`;
    for (const value of [null, '', -1, 1.5, false]) {
      const match = { ...complete, raw_json: JSON.stringify({ playerStats: [{ sourcePlayerId: '77', [field]: value }] }) };
      assert.equal(service.evaluateSelectionAgainstMatch(selection, match), null);
    }
    const match = { ...complete, raw_json: JSON.stringify({ playerStats: [{ sourcePlayerId: '77', [field]: 0 }] }) };
    assert.equal(service.evaluateSelectionAgainstMatch(selection, match)?.status, 'WON');
  }
});

test('pending settlement persists only observable outcomes', async () => {
  const writes = [];
  const db = {
    getPendingPredictions: async () => [
      { prediction_id: 'known', selection: 'shotsHomeUnder55' },
      { prediction_id: 'missing', selection: 'shotsUnder155' },
      { prediction_id: 'cards', selection: 'cards_total_under_4.5' },
    ],
    settlePredictionsBatch: async (batch) => { writes.push(...batch); return batch.length; },
  };
  const service = new PredictionService(db);
  const result = await service.settlePendingPredictionsForMatch('test', { ...complete, away_shots: null, away_red_cards: null });
  assert.deepEqual(result, { settled: 1, unresolved: 2 });
  assert.deepEqual(writes, [{ predictionId: 'known', result: 'win' }]);
});
