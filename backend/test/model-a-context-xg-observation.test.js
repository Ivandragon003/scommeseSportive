const test = require('node:test');
const assert = require('node:assert/strict');
const { PredictionContextBuilder } = require('../dist/services/PredictionContextBuilder');

function build(homeXg, awayXg) {
  return new PredictionContextBuilder().build({ request: {},
    homeTeam: { avg_home_xg: homeXg }, awayTeam: { avg_away_xg: awayXg },
    homePlayers: [], awayPlayers: [], referee: null });
}

test('missing or invalid team xG cannot add the xG richness bonus', () => {
  for (const missing of [null, undefined, '', ' ', false, true, 'NaN', NaN, Infinity, -1, '-1', {}]) {
    for (const side of ['home', 'away']) {
      const result = build(side === 'home' ? missing : 1.2, side === 'away' ? missing : 1.3);
      assert.equal(result.richnessScore, 0.3, `${side}: ${String(missing)}`);
      assert.equal(side === 'home' ? result.homeXG : result.awayXG, undefined);
    }
  }
  // Before correction two nulls were converted to zero and produced 0.42.
  const both = build(null, null);
  assert.equal(both.richnessScore, 0.3);
  assert.equal(both.homeXG, undefined);
  assert.equal(both.awayXG, undefined);
});

test('observed zero and finite numeric xG preserve the existing bonus', () => {
  for (const [home, away] of [[0, 0], ['0', '0'], [1.25, 2.1], ['1.25', '2.1']]) {
    const result = build(home, away);
    assert.equal(result.richnessScore, 0.42);
    assert.equal(result.homeXG, Number(home));
    assert.equal(result.awayXG, Number(away));
  }
});
