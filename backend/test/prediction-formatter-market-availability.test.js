const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPrediction } = require('../dist/api/predictionPayloadFormatter.js');
const fixture = require('./fixtures/format-prediction.input.js');
const golden = require('./fixtures/format-prediction.golden.json');
const enabled = { shots: true, shotsOT: true, yellow: true, cardsTotal: true };
const input = (availability) => {
  const prediction = structuredClone(fixture);
  prediction.probabilities.statMarketAvailability = availability;
  return prediction;
};

test('all enabled families and legacy predictions retain their complete-data payload', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(formatPrediction(fixture))), golden);
  const formatted = JSON.parse(JSON.stringify(formatPrediction(input(enabled))));
  delete formatted.probabilities.statMarketAvailability;
  assert.deepEqual(formatted, golden);
});

test('unavailable total shots cannot be reconstructed from priors while shots on target stay available', () => {
  const prediction = input({ ...enabled, shots: false });
  const before = structuredClone(prediction);
  const formatted = formatPrediction(prediction);
  for (const side of ['home', 'away']) {
    assert.equal(formatted.shotsPrediction[side].totalShots.available, false);
    assert.deepEqual(formatted.shotsPrediction[side].totalShots.distribution, {});
    assert.deepEqual(formatted.shotsPrediction[side].shotsOnTarget, golden.shotsPrediction[side].shotsOnTarget);
  }
  assert.deepEqual(formatted.shotsPrediction.combined.overUnder, {});
  assert.equal(formatted.shotsPrediction.combined.totalShots.available, false);
  assert.equal(formatted.shotsPrediction.combined.totalShots.expected, golden.shotsPrediction.combined.totalShots.expected);
  assert.deepEqual(formatted.shotsPrediction.combined.onTargetOverUnder, golden.shotsPrediction.combined.onTargetOverUnder);
  assert.deepEqual(prediction, before, 'formatting must not mutate the service result');
});

test('unavailable target shots suppress their Poisson tables without removing supported total shots', () => {
  const formatted = formatPrediction(input({ ...enabled, shotsOT: false }));
  assert.deepEqual(formatted.shotsPrediction.combined.onTargetOverUnder, {});
  for (const side of ['home', 'away']) {
    assert.equal(formatted.shotsPrediction[side].shotsOnTarget.available, false);
    assert.deepEqual(formatted.shotsPrediction[side].shotsOnTarget.distribution, {});
    assert.deepEqual(formatted.shotsPrediction[side].totalShots, golden.shotsPrediction[side].totalShots);
  }
  assert.equal(formatted.shotsPrediction.combined.totalOnTarget.available, false);
  assert.deepEqual(formatted.shotsPrediction.combined.overUnder, golden.shotsPrediction.combined.overUnder);
});

test('yellow-card availability is independent of weighted-card availability', () => {
  const formatted = formatPrediction(input({ ...enabled, yellow: false }));
  assert.equal(formatted.cardsPrediction.totalYellow.available, false);
  assert.deepEqual(formatted.cardsPrediction.totalYellow.distribution, {});
  assert.deepEqual(formatted.cardsPrediction.overUnder, {});
  for (const side of ['homeYellow', 'awayYellow']) {
    assert.equal(formatted.cardsPrediction[side].available, false);
    assert.equal(formatted.cardsPrediction[side].over15, undefined);
  }
  assert.deepEqual(formatted.cardsPrediction.totalCardsWeighted, golden.cardsPrediction.totalCardsWeighted);
});

test('weighted-card failure never fabricates zero threshold probabilities or a red probability table', () => {
  const formatted = formatPrediction(input({ ...enabled, cardsTotal: false }));
  assert.equal(formatted.cardsPrediction.totalCardsWeighted.available, false);
  assert.equal(formatted.cardsPrediction.totalCardsWeighted.over35, undefined);
  assert.equal(formatted.cardsPrediction.totalRed.available, false);
  assert.equal(formatted.cardsPrediction.totalRed.probAtLeastOne, null);
  assert.deepEqual(formatted.cardsPrediction.totalRed.distribution, {});
  assert.deepEqual(formatted.cardsPrediction.totalYellow, golden.cardsPrediction.totalYellow);
  assert.deepEqual(formatted.cardsPrediction.overUnder, golden.cardsPrediction.overUnder);
});

test('unavailable fields without supplied means stay null rather than observed-looking zeros', () => {
  const formatted = formatPrediction({ probabilities: { statMarketAvailability: {
    shots: false, shotsOT: false, yellow: false, cardsTotal: false,
  } } });
  for (const side of ['home', 'away']) {
    assert.equal(formatted.shotsPrediction[side].totalShots.expected, null);
    assert.equal(formatted.shotsPrediction[side].shotsOnTarget.expected, null);
  }
  assert.equal(formatted.shotsPrediction.combined.totalShots.expected, null);
  assert.equal(formatted.shotsPrediction.combined.totalOnTarget.expected, null);
  assert.equal(formatted.cardsPrediction.totalYellow.expected, null);
  assert.equal(formatted.cardsPrediction.totalCardsWeighted.expected, null);
  assert.equal(formatted.cardsPrediction.totalRed.expected, null);
  assert.deepEqual(formatted.probabilities.statMarketAvailability, { shots: false, shotsOT: false, yellow: false, cardsTotal: false });
});

for (const missing of [undefined, null, '', '   ']) {
  test(`legacy missing means (${JSON.stringify(missing)}) never synthesize observed zeros`, () => {
    const formatted = formatPrediction({ probabilities: {
      shotsHome: { expected: missing, shotsOnTarget: { expected: missing } },
      shotsAway: { totalShots: { expected: missing }, shotsOnTarget: { expected: missing } },
      cards: { expectedTotalYellow: missing, expectedHomeYellow: missing, expectedAwayYellow: missing,
        expectedTotalCards: missing, expectedHomeRed: missing, expectedAwayRed: missing },
    } });
    for (const side of ['home', 'away']) {
      for (const field of ['totalShots', 'shotsOnTarget']) {
        assert.equal(formatted.shotsPrediction[side][field].available, false);
        assert.equal(formatted.shotsPrediction[side][field].expected, null);
        assert.deepEqual(formatted.shotsPrediction[side][field].distribution, {});
      }
    }
    assert.deepEqual(formatted.shotsPrediction.combined.overUnder, {});
    assert.deepEqual(formatted.shotsPrediction.combined.onTargetOverUnder, {});
    assert.equal(formatted.cardsPrediction.totalYellow.expected, null);
    assert.deepEqual(formatted.cardsPrediction.totalYellow.distribution, {});
    assert.equal(formatted.cardsPrediction.totalCardsWeighted.expected, null);
    assert.equal(formatted.cardsPrediction.totalCardsWeighted.over35, undefined);
    assert.equal(formatted.cardsPrediction.totalRed.probAtLeastOne, null);
  });
}

test('legacy explicit zero means are usable model estimates on every accepted stat path', () => {
  const formatted = formatPrediction({ probabilities: {
    shotsHome: { expected: 0 }, shotsAway: { totalShots: { expected: 0 } },
    shotsOnTargetHome: { expected: 0 }, shotsOnTargetAway: { expected: 0 },
    cards: { expectedTotalYellow: 0, expectedHomeYellow: 0, expectedAwayYellow: 0,
      expectedTotalCards: 0, expectedHomeRed: 0, expectedAwayRed: 0 },
  } });
  for (const side of ['home', 'away']) {
    for (const field of ['totalShots', 'shotsOnTarget']) {
      assert.equal(formatted.shotsPrediction[side][field].available, undefined);
      assert.equal(formatted.shotsPrediction[side][field].expected, 0);
      assert.equal(formatted.shotsPrediction[side][field].distribution[0], 1);
    }
  }
  assert.equal(formatted.cardsPrediction.totalYellow.available, undefined);
  assert.equal(formatted.cardsPrediction.totalYellow.distribution[0], 1);
  assert.equal(formatted.cardsPrediction.totalCardsWeighted.available, undefined);
  assert.equal(formatted.cardsPrediction.totalCardsWeighted.expected, 0);
});

for (const [homeRed, awayRed] of [[undefined, undefined], [null, null], [null, 0], [0, null], [undefined, 0], [0, undefined]]) {
  test(`weighted cards stay available when red means are incomplete (${homeRed}, ${awayRed})`, () => {
    const prediction = structuredClone(fixture);
    prediction.probabilities.cards.expectedHomeRed = homeRed;
    prediction.probabilities.cards.expectedAwayRed = awayRed;
    const formatted = formatPrediction(prediction);
    assert.deepEqual(formatted.cardsPrediction.totalCardsWeighted, golden.cardsPrediction.totalCardsWeighted);
    assert.equal(formatted.cardsPrediction.totalRed.available, false);
    assert.equal(formatted.cardsPrediction.totalRed.expected, null);
    assert.equal(formatted.cardsPrediction.totalRed.probAtLeastOne, null);
    assert.deepEqual(formatted.cardsPrediction.totalRed.distribution, {});
    assert.deepEqual(formatted.cardsPrediction.totalYellow, golden.cardsPrediction.totalYellow);
  });
}

test('two explicit zero red means retain the real zero distribution independently of weighted cards', () => {
  const prediction = structuredClone(fixture);
  prediction.probabilities.cards.expectedHomeRed = 0;
  prediction.probabilities.cards.expectedAwayRed = 0;
  const formatted = formatPrediction(prediction);
  assert.deepEqual(formatted.cardsPrediction.totalCardsWeighted, golden.cardsPrediction.totalCardsWeighted);
  assert.equal(formatted.cardsPrediction.totalRed.available, undefined);
  assert.equal(formatted.cardsPrediction.totalRed.expected, 0);
  assert.equal(formatted.cardsPrediction.totalRed.probAtLeastOne, 0);
  assert.equal(formatted.cardsPrediction.totalRed.distribution[0], 1);
});
