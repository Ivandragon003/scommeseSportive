const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeScoreMatrix, settleGoalQuote, evaluateGoalQuote, scoreMatrixMarkets } = require('../dist/research/GoalSettlement');

const quote = (market, side, extra = {}) => ({
  selection: 'research-selection', market, side, odds: 2.4, bookmaker: 'Bookmaker', source: 'odds_api',
  capturedAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', ...extra,
});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('normalization preserves inputs and rejects missing or invalid joint distributions', () => {
  const original = [[1, 1], [2, 0]];
  assert.deepEqual(normalizeScoreMatrix(original), [[0.25, 0.25], [0.5, 0]]);
  assert.deepEqual(original, [[1, 1], [2, 0]]);
  for (const matrix of [null, [], [[1, 0]], [[0]], [[NaN]], [[Infinity]], [[-1]], [Array(1)], Array(1)]) {
    assert.throws(() => normalizeScoreMatrix(matrix));
  }
});

test('1X2, double chance, BTTS and DNB keep wins, losses and pushes distinct', () => {
  assert.deepEqual(settleGoalQuote(quote('1x2', 'home'), 2, 1), { status: 'WON', returnMultiplier: 2.4 });
  assert.deepEqual(settleGoalQuote(quote('1x2', 'draw'), 2, 1), { status: 'LOST', returnMultiplier: 0 });
  assert.equal(settleGoalQuote(quote('double_chance', 'x2'), 1, 1).status, 'WON');
  assert.equal(settleGoalQuote(quote('double_chance', '12'), 1, 1).status, 'LOST');
  assert.equal(settleGoalQuote(quote('btts', 'no'), 0, 2).status, 'WON');
  assert.equal(settleGoalQuote(quote('btts', 'yes'), 1, 2).status, 'WON');
  assert.deepEqual(settleGoalQuote(quote('dnb', 'away'), 1, 1), { status: 'VOID', returnMultiplier: 1 });
  assert.equal(settleGoalQuote(quote('dnb', 'away'), 1, 2).status, 'WON');
});

test('integer totals refund at equality and team totals use the selected team only', () => {
  assert.equal(settleGoalQuote(quote('totals', 'over', { line: 2 }), 1, 1).status, 'VOID');
  assert.equal(settleGoalQuote(quote('totals', 'under', { line: 2 }), 1, 1).status, 'VOID');
  assert.equal(settleGoalQuote(quote('totals', 'over', { line: 2.5 }), 2, 1).status, 'WON');
  assert.equal(settleGoalQuote(quote('team_totals', 'under', { line: 1, team: 'away' }), 4, 1).status, 'VOID');
  assert.equal(settleGoalQuote(quote('team_totals', 'over', { line: 1.5, team: 'home' }), 2, 0).status, 'WON');
});

test('European handicap uses the home adjustment and has a separate draw selection', () => {
  assert.equal(settleGoalQuote(quote('european_handicap', 'draw', { line: -1 }), 2, 1).status, 'WON');
  assert.equal(settleGoalQuote(quote('european_handicap', 'home', { line: -1 }), 2, 1).status, 'LOST');
  assert.equal(settleGoalQuote(quote('european_handicap', 'away', { line: -1 }), 0, 1).status, 'WON');
});

test('Asian handicap settles both team perspectives and both signs of quarter lines', () => {
  assert.deepEqual(settleGoalQuote(quote('asian_handicap', 'home', { line: -1 }), 2, 1), { status: 'VOID', returnMultiplier: 1 });
  assert.equal(settleGoalQuote(quote('asian_handicap', 'away', { line: 1 }), 2, 1).status, 'VOID');
  assert.deepEqual(settleGoalQuote(quote('asian_handicap', 'home', { line: 0.25 }), 1, 1), { status: 'HALF_WON', returnMultiplier: 1.7 });
  assert.deepEqual(settleGoalQuote(quote('asian_handicap', 'home', { line: -0.25 }), 1, 1), { status: 'HALF_LOST', returnMultiplier: 0.5 });
  assert.equal(settleGoalQuote(quote('asian_handicap', 'away', { line: -0.25 }), 1, 1).status, 'HALF_LOST');
  assert.equal(settleGoalQuote(quote('asian_handicap', 'home', { line: -0.75 }), 2, 1).status, 'HALF_WON');
  assert.equal(settleGoalQuote(quote('asian_handicap', 'away', { line: 0.75 }), 2, 1).status, 'HALF_LOST');
});

test('quarter totals split stake on the two adjacent half lines', () => {
  assert.equal(settleGoalQuote(quote('totals', 'over', { line: 2.25 }), 1, 1).status, 'HALF_LOST');
  assert.equal(settleGoalQuote(quote('totals', 'under', { line: 2.25 }), 1, 1).status, 'HALF_WON');
});

test('missing results, unsupported sides, invalid prices and non-real provenance stay unresolved', () => {
  const standard = quote('1x2', 'home');
  for (const goals of [[null, 1], [0, undefined], [NaN, 0], [-1, 1], [0.5, 1]]) {
    assert.deepEqual(settleGoalQuote(standard, ...goals), { status: 'UNRESOLVED', returnMultiplier: null });
  }
  for (const invalid of [null, { ...standard, odds: 1 }, { ...standard, odds: Infinity },
    { ...standard, side: 'over' }, { ...standard, bookmaker: '' }, { ...standard, capturedAt: '' },
    { ...standard, source: 'odds_api_plus_model_completion' }, quote('totals', 'over', { line: 2.3 })]) {
    assert.equal(settleGoalQuote(invalid, 1, 0).status, 'UNRESOLVED');
    assert.throws(() => evaluateGoalQuote([[1]], invalid));
  }
});

test('matrix payout expectation includes push and half outcomes without treating them as binary losses', () => {
  const matrix = [[0.2, 0.3], [0.5, 0]];
  const homeDnb = evaluateGoalQuote(matrix, quote('dnb', 'home'));
  close(homeDnb.win, 0.5); close(homeDnb.loss, 0.3); close(homeDnb.push, 0.2);
  close(homeDnb.probability, 0.5 / 0.8);
  close(homeDnb.expectedValue, 0.5 * 2.4 + 0.2 - 1);
  const quarter = evaluateGoalQuote(matrix, quote('asian_handicap', 'home', { line: 0.25 }));
  close(quarter.halfWin, 0.2); close(quarter.win, 0.5); close(quarter.loss, 0.3);
  close(quarter.probability, 0.6 / 0.9);
  close(quarter.expectedValue, 0.5 * 2.4 + 0.2 * 1.7 - 1);
  close(quarter.win + quarter.loss + quarter.push + quarter.halfWin + quarter.halfLoss, 1);
  const pushesOnly = evaluateGoalQuote([[1]], quote('dnb', 'home'));
  close(pushesOnly.probability, 0.5); close(pushesOnly.push, 1); close(pushesOnly.expectedValue, 0);
});

test('flat goal markets satisfy partitions, complementary totals, DNB and team symmetry', () => {
  const matrix = [[1, 2, 0], [3, 1, 0], [2, 1, 1]];
  const markets = scoreMatrixMarkets(matrix);
  close(markets.homeWin + markets.draw + markets.awayWin, 1);
  close(markets.btts + markets.bttsNo, 1);
  close(markets.dnb_home + markets.dnb_away, 1);
  close(markets.double_chance_12, 1 - markets.draw);
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    const key = String(line).replace('.', '');
    close(markets[`over${key}`] + markets[`under${key}`], 1);
    close(markets[`team_home_over_${line}`] + markets[`team_home_under_${line}`], 1);
    close(markets[`over${key}`], evaluateGoalQuote(matrix, quote('totals', 'over', { line })).probability);
  }
  const transposed = matrix.map((row, home) => row.map((_value, away) => matrix[away][home]));
  close(scoreMatrixMarkets(transposed).homeWin, markets.awayWin);
  close(scoreMatrixMarkets(transposed)['team_home_over_1.5'], markets['team_away_over_1.5']);
});
