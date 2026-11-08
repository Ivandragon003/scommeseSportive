'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { fitPlateauCalibration, interpolateCalibration } = require('./plateau.cjs');

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-12,
  `${actual} differs from ${expected}`);

function fixture(successes, size = 5) {
  const predictions = [], outcomes = [];
  successes.forEach((count, bin) => {
    for (let index = 0; index < size; index++) {
      predictions.push((bin + 1) / (successes.length + 1));
      outcomes.push(Number(index < count));
    }
  });
  return { predictions, outcomes };
}

test('a downward block retains its first and last bin knots and fitted plateau', () => {
  const input = fixture([0, 4, 3, 1, 5]);
  const before = JSON.stringify(input);
  const fitted = fitPlateauCalibration(input.predictions, input.outcomes);
  assert.equal(JSON.stringify(input), before, 'caller arrays must not be mutated');
  const pool = fitted.pools.find((item) => item.weight === 3);
  assert.ok(pool);
  assert.equal(pool.firstBucket, 1);
  assert.equal(pool.lastBucket, 3);
  close(pool.y, 8 / 15);
  for (const x of [fitted.buckets[1].xMean, 0.5, fitted.buckets[3].xMean]) {
    close(interpolateCalibration(x, fitted.correctedPoints), pool.y);
  }
  assert.notEqual(interpolateCalibration(fitted.buckets[1].xMean, fitted.legacyPoints), pool.y);
  assert.equal(fitted.objective.maximumPlateauResidual, 0);
  assert.ok(fitted.objective.correctedWeightedSquaredError < fitted.objective.legacyWeightedSquaredError);
  assert.deepEqual(fitted.correctedPoints[0], { x: 0, y: 0 });
  assert.deepEqual(fitted.correctedPoints.at(-1), { x: 1, y: 1 });
});

test('an already monotonic binned fit preserves the exact incumbent curve', () => {
  const { predictions, outcomes } = fixture([0, 1, 2, 4, 5]);
  const fitted = fitPlateauCalibration(predictions, outcomes);
  assert.deepEqual(fitted.correctedPoints, fitted.legacyPoints);
  assert.equal(fitted.objective.maximumPlateauResidual, 0);
  assert.equal(fitted.objective.correctedWeightedSquaredError, 0);
});

test('stable sorting preserves label order when equal predictions cross a bin boundary', () => {
  const predictions = [...Array(7).fill(0.3), ...Array(3).fill(0.1),
    ...Array(5).fill(0.6), ...Array(5).fill(0.8)];
  const outcomes = [1, 1, 0, 0, 0, 0, 0, ...Array(3).fill(0), ...Array(10).fill(1)];
  const fitted = fitPlateauCalibration(predictions, outcomes);
  close(fitted.buckets[0].xMean, 0.18);
  close(fitted.buckets[0].yMean, 0.4);
  assert.equal(fitted.buckets[1].yMean, 0);
  close(fitted.pools[0].y, 0.2);
});

test('pooling retains equal bin weights when the final bin has fewer observations', () => {
  // 51 observations => ten requested buckets, nine actual buckets of size 6,6,...,3.
  const predictions = Array.from({ length: 51 }, (_, index) => (index + 1) / 52);
  const outcomes = Array.from({ length: 51 }, (_, index) => Number(index >= 42 && index < 48));
  const fitted = fitPlateauCalibration(predictions, outcomes);
  const last = fitted.pools.at(-1);
  assert.deepEqual(fitted.buckets.map((bucket) => bucket.count), [6, 6, 6, 6, 6, 6, 6, 6, 3]);
  assert.equal(last.weight, 2);
  assert.equal(last.y, 0.5, 'the change must not introduce observation-count weighting (2/3)');
  close(interpolateCalibration(fitted.buckets[7].xMean, fitted.correctedPoints), 0.5);
  close(interpolateCalibration(fitted.buckets[8].xMean, fitted.correctedPoints), 0.5);
});

test('the pinned C75 artifact reproduces its legacy curve and exposes the four-bin plateau', () => {
  const serialized = readFileSync(join(__dirname, '../../current-models/challenger.json'));
  assert.equal(createHash('sha256').update(serialized).digest('hex'),
    '772049b0d4462faa94c785390222501c609f7887a9b7e005c737c3c8988700d2',
    'this bounded audit must use the original frozen incumbent');
  const artifact = JSON.parse(serialized);
  assert.equal(artifact.version, 'C-75fd74eb875e9d0e');
  assert.equal(artifact.calibrationPredictions.length, 358);
  const predictions = [], outcomes = [];
  // Independent score-matrix marginalization in the same arithmetic order as
  // GoalSettlement.scoreMatrixMarkets; no diagnostic/test partition is read.
  for (const row of artifact.calibrationPredictions) {
    const matrix = row.matrixC;
    const total = matrix.reduce((sum, line) => sum + line.reduce((subtotal, p) => subtotal + p, 0), 0);
    const probabilities = [0, 0, 0];
    for (let home = 0; home < matrix.length; home++) {
      for (let away = 0; away < matrix.length; away++) {
        probabilities[home > away ? 0 : home === away ? 1 : 2] += matrix[home][away] / total;
      }
    }
    const marginalTotal = probabilities.reduce((sum, p) => sum + p, 0);
    predictions.push(...probabilities.map((p) => p / marginalTotal));
    const result = row.homeGoals > row.awayGoals ? 0 : row.homeGoals === row.awayGoals ? 1 : 2;
    outcomes.push(...probabilities.map((_, index) => Number(index === result)));
  }
  assert.equal(predictions.length, 1074);
  const fitted = fitPlateauCalibration(predictions, outcomes);
  const stored = artifact.calibrationProfilesV2.C.calibrationPoints;
  assert.equal(fitted.legacyPoints.length, stored.length);
  fitted.legacyPoints.forEach((point, index) => {
    close(point.x, stored[index].x);
    close(point.y, stored[index].y);
  });
  const pool = fitted.pools.find((item) => item.weight === 4);
  assert.ok(pool);
  close(pool.x, 0.26434850329662934);
  close(pool.y, 112 / 432);
  const expectedX = [0.22529421105190714, 0.25359275355107946, 0.2760469846155224, 0.30246006396800856];
  expectedX.forEach((x, offset) => {
    const bucket = fitted.buckets[pool.firstBucket + offset];
    assert.equal(bucket.count, 108);
    close(bucket.xMean, x);
    close(interpolateCalibration(bucket.xMean, fitted.correctedPoints), pool.y);
  });
  assert.ok(Math.abs(interpolateCalibration(expectedX[0], fitted.legacyPoints) - pool.y) > 0.01);
  assert.equal(fitted.objective.maximumPlateauResidual, 0);
  assert.ok(fitted.objective.correctedWeightedSquaredError < fitted.objective.legacyWeightedSquaredError);
});

test('valid short samples retain the original identity fallback', () => {
  const fitted = fitPlateauCalibration([0.2, 0.8], [0, 1]);
  assert.deepEqual(fitted.correctedPoints, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  assert.deepEqual(fitted.correctedPoints, fitted.legacyPoints);
  assert.deepEqual(fitted.buckets, []);
});

test('invalid probabilities and outcomes fail closed, including sparse arrays', () => {
  for (const probability of [NaN, Infinity, -0.1, 1.1, '0.2', null, undefined]) {
    assert.throws(() => fitPlateauCalibration([probability], [0]), /Invalid probability/);
  }
  for (const outcome of [NaN, Infinity, -1, 0.5, 2, '1', true, null, undefined]) {
    assert.throws(() => fitPlateauCalibration([0.2], [outcome]), /Invalid binary outcome/);
  }
  assert.throws(() => fitPlateauCalibration(new Array(1), [0]), /Invalid probability/);
  assert.throws(() => fitPlateauCalibration([0.2], new Array(1)), /Invalid binary outcome/);
  for (const [predictions, outcomes] of [[[], []], [[0.2], []], [null, [0]]]) {
    assert.throws(() => fitPlateauCalibration(predictions, outcomes), /nonempty arrays of equal length/);
  }
});

test('duplicate bin centroids and anchor collisions fail closed', () => {
  for (const probability of [0, 0.5, 1]) {
    assert.throws(() => fitPlateauCalibration(Array(10).fill(probability), Array(10).fill(0)),
      /Ambiguous duplicate or anchor calibration knot/);
  }
});
