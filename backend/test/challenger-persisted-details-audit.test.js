const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('../scripts/audit-challenger-persisted-details');
const match = { matchId: 'one', homeGoals: 1, awayGoals: 0, homeTotalShots: 10, awayTotalShots: 8,
  homeShotsOnTarget: 4, awayShotsOnTarget: 2, homeYellowCards: 1, awayYellowCards: 0, homeRedCards: 0, awayRedCards: 1 };
const details = () => ({ match_id: 'one', h_shots: 10, a_shots: 8, h_on_target: 4, a_on_target: 2,
  h_cards: JSON.stringify(Array.from({ length: 11 }, (_, index) => [String(index === 0 ? 1 : 0), '0'])),
  a_cards: JSON.stringify(Array.from({ length: 11 }, (_, index) => ['0', String(index === 0 ? 1 : 0)])) });
test('all available normalized fields reconcile with persisted primary statistics', () => {
  const result = reconcile([match], [details()]);
  assert.equal(result.comparedFields, 8);
  assert.equal(result.differingFields, 0);
});
test('missing primary values stay unknown and differences retain both observed values', () => {
  const source = details(); source.h_cards = JSON.stringify(Array.from({ length: 11 }, () => [null, null]));
  source.h_shots = null; source.a_shots = 9;
  const result = reconcile([match], [source]);
  assert.equal(result.coverage.homeYellowCards.unavailable, 1);
  assert.equal(result.coverage.homeTotalShots.unavailable, 1);
  assert.deepEqual(result.findings, [{ matchId: 'one', field: 'awayTotalShots', frozen: 8, persistedPrimary: 9 }]);
  assert.throws(() => reconcile([match], [source, source]), /Duplicate/);
});
