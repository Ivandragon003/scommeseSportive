'use strict';

// Experimental only. Preserve the existing binned, equally weighted PAVA fit;
// change only how a merged pool is represented by interpolation knots.
function fitPlateauCalibration(predictions, outcomes) {
  if (!Array.isArray(predictions) || !Array.isArray(outcomes)
    || predictions.length !== outcomes.length || predictions.length === 0) {
    throw new Error('Predictions and outcomes must be nonempty arrays of equal length.');
  }
  const paired = Array.from(predictions, (p, index) => {
    const o = outcomes[index];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`Invalid probability at index ${index}.`);
    }
    if (o !== 0 && o !== 1) throw new Error(`Invalid binary outcome at index ${index}.`);
    return { p, o };
  });
  // Node's stable sort retains the incumbent order of equal predictions.
  paired.sort((a, b) => a.p - b.p);
  const identity = () => [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const nBuckets = Math.min(10, Math.floor(paired.length / 5));
  const buckets = [];
  const pools = [];
  if (nBuckets >= 2) {
    const bSize = Math.ceil(paired.length / nBuckets);
    for (let i = 0; i < paired.length; i += bSize) {
      const slice = paired.slice(i, i + bSize);
      buckets.push({
        xMean: slice.reduce((sum, item) => sum + item.p, 0) / slice.length,
        yMean: slice.reduce((sum, item) => sum + item.o, 0) / slice.length,
        count: slice.length,
      });
    }
    // Reject ambiguous knots instead of silently choosing tie/anchor semantics.
    let previous = 0;
    for (const bucket of buckets) {
      if (!(bucket.xMean > previous && bucket.xMean < 1)) {
        throw new Error('Ambiguous duplicate or anchor calibration knot.');
      }
      previous = bucket.xMean;
    }
    pools.push(...buckets.map((bucket, index) => ({
      x: bucket.xMean, y: bucket.yMean, weight: 1,
      firstBucket: index, lastBucket: index,
    })));
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < pools.length - 1; i++) {
        if (pools[i].y > pools[i + 1].y) {
          const left = pools[i], right = pools[i + 1];
          const w1 = left.weight, w2 = right.weight;
          pools.splice(i, 2, {
            x: (left.x * w1 + right.x * w2) / (w1 + w2),
            y: (left.y * w1 + right.y * w2) / (w1 + w2),
            weight: w1 + w2,
            firstBucket: left.firstBucket, lastBucket: right.lastBucket,
          });
          changed = true;
          break;
        }
      }
    }
  }
  const legacyPoints = identity();
  legacyPoints.splice(1, 0, ...pools.map(({ x, y }) => ({ x, y })));
  const correctedPoints = identity();
  const endpoints = pools.flatMap((pool) => {
    const first = { x: buckets[pool.firstBucket].xMean, y: pool.y };
    return pool.firstBucket === pool.lastBucket ? [first]
      : [first, { x: buckets[pool.lastBucket].xMean, y: pool.y }];
  });
  correctedPoints.splice(1, 0, ...endpoints);
  let legacyWeightedSquaredError = 0, correctedWeightedSquaredError = 0;
  let maximumPlateauResidual = 0;
  for (const pool of pools) {
    for (let i = pool.firstBucket; i <= pool.lastBucket; i++) {
      const bucket = buckets[i];
      const legacy = interpolateCalibration(bucket.xMean, legacyPoints);
      const corrected = interpolateCalibration(bucket.xMean, correctedPoints);
      legacyWeightedSquaredError += bucket.count * (legacy - bucket.yMean) ** 2;
      correctedWeightedSquaredError += bucket.count * (corrected - bucket.yMean) ** 2;
      maximumPlateauResidual = Math.max(maximumPlateauResidual, Math.abs(corrected - pool.y));
    }
  }
  return {
    legacyPoints, correctedPoints, buckets, pools,
    objective: { legacyWeightedSquaredError, correctedWeightedSquaredError, maximumPlateauResidual },
  };
}

// Unshrunk piecewise linear value; the objective audits the fitted bin curve.
function interpolateCalibration(rawProb, points) {
  if (typeof rawProb !== 'number' || !Number.isFinite(rawProb) || rawProb < 0 || rawProb > 1) {
    throw new Error('Invalid interpolation probability.');
  }
  if (rawProb <= 0) return 0;
  if (rawProb >= 1) return 1;
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i], hi = points[i + 1];
    if (rawProb >= lo.x && rawProb <= hi.x) {
      const t = hi.x > lo.x ? (rawProb - lo.x) / (hi.x - lo.x) : 0;
      return lo.y + t * (hi.y - lo.y);
    }
  }
  throw new Error('Calibration points do not cover the probability.');
}

module.exports = { fitPlateauCalibration, interpolateCalibration };
