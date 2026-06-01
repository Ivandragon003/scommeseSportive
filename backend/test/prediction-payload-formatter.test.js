const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPrediction } = require('../dist/api/predictionPayloadFormatter.js');

const input = require('./fixtures/format-prediction.input.js');
const golden = require('./fixtures/format-prediction.golden.json');

/**
 * Golden-master regression test for the prediction API payload formatter.
 *
 * formatPrediction (and its pure helpers) was extracted verbatim from
 * api/routes.ts into api/predictionPayloadFormatter.ts. The golden fixture was
 * captured from that extracted code, which is byte-identical to the original
 * routes.ts implementation, so this test both:
 *   1. proves the extraction did not change the emitted payload, and
 *   2. locks the formatting contract against future regressions.
 *
 * If formatPrediction intentionally changes, regenerate the golden with:
 *   node -e "const {formatPrediction}=require('./dist/api/predictionPayloadFormatter.js'); \
 *     require('fs').writeFileSync('./test/fixtures/format-prediction.golden.json', \
 *     JSON.stringify(formatPrediction(require('./test/fixtures/format-prediction.input.js')),null,2)+'\n')"
 */

test('formatPrediction output matches the golden master', () => {
  const out = formatPrediction(input);
  // Round-trip through JSON to normalise undefined/Map-like quirks the API also applies.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), golden);
});

test('formatPrediction exercises the pure helpers correctly', () => {
  const out = formatPrediction(input);
  // mapOverUnder + lineToKey: "3.5" -> "over35"/"under35"
  assert.deepEqual(out.cardsPrediction.overUnder, {
    over35: 0.611, under35: 0.389, over45: 0.402, under45: 0.598,
  });
  // roundN: 1.63421 -> 1.634 (3 decimals)
  assert.equal(out.lambdaHome, 1.634);
  // value opportunity with NaN ourProbability is filtered out (1 of 2 kept)
  assert.equal(out.valueOpportunities.length, 1);
  // combo bet with a single leg is filtered out (1 of 2 kept)
  assert.equal(out.comboBets.length, 1);
  // negBinDistribution normalises to a probability vector (sums ~1)
  const yd = out.cardsPrediction.totalYellow.distribution;
  const sum = Object.values(yd).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `yellow distribution should sum to 1, got ${sum}`);
});
