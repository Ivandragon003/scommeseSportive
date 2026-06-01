const test = require('node:test');
const assert = require('node:assert/strict');
const MathUtils = require('../dist/models/utils/MathUtils.js');

/**
 * Numerical regression / characterization tests for the Poisson and Negative
 * Binomial PMFs.
 *
 * src/api/routes.ts now DELEGATES both PMFs to src/models/utils/MathUtils.ts
 * (single source of truth). Previously routes.ts carried its own iterative
 * product / log-sum implementation. The pre-unification routes algorithm is
 * reproduced verbatim below (legacyRoutes*) and kept as the regression baseline
 * that justified the migration: it proves the OLD routes math and MathUtils are
 * interchangeable on the domain the API actually feeds them, so importing
 * MathUtils does not change any emitted value.
 *
 * Conclusion (see assertions):
 *   - On the REALISTIC input domain (integer k >= 0, mu/lambda > 0, 0 < r <= 500
 *     — the only domain routes.ts ever reaches: r is clamped to [1, 200]) the two
 *     algorithms are equivalent to ~1e-13, far below the 4-decimal precision the
 *     API emits (toFixed(4) => rounding step 5e-5). The migration is safe THERE.
 *   - For NEGATIVE k both return 0 (MathUtils guards k<0; the old routes code
 *     gained the same guard before being retired).
 *   - For invalid/huge r the OLD routes code and MathUtils DIVERGED BY DESIGN
 *     (point mass vs Poisson fallback). Those inputs are unreachable from the
 *     real call sites, which is why delegating to MathUtils' more robust handling
 *     is safe. The divergences are pinned below as documentation.
 */

// --- Verbatim copy of the PRE-unification src/api/routes.ts implementation ---
// routes.ts no longer contains these; they are the migration baseline.
function legacyRoutesPoissonPMF(k, lambda) {
  if (k < 0) return 0;
  if (!isFinite(lambda) || lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return isFinite(p) ? p : 0;
}

function legacyRoutesNegBinPMF(k, mu, r) {
  if (k < 0) return 0;
  if (!isFinite(mu) || !isFinite(r) || mu <= 0 || r <= 0) return k === 0 ? 1 : 0;
  const p = r / (r + mu);
  let combLog = 0;
  for (let i = 0; i < k; i++) combLog += Math.log(r + i) - Math.log(i + 1);
  const logP = combLog + r * Math.log(p) + k * Math.log(1 - p);
  const val = Math.exp(logP);
  return isFinite(val) ? val : 0;
}

// Rounding step introduced by the toFixed(4) the API applies to every emitted
// probability (roundN / formatPrediction in routes.ts). Two values closer than
// this almost always serialize to the same 4-decimal string.
const API_PRECISION = 5e-5;
// Threshold actually used to claim "equivalent": 4 orders of magnitude tighter
// than API_PRECISION, comfortably above the observed ~1e-13 floating drift.
const EQUIVALENCE_EPS = 1e-9;

const LAMBDAS = [0.1, 0.5, 1, 1.5, 2.3, 2.7, 3.5, 5, 8, 12, 20];
const MUS = [0.5, 1, 2.3, 2.7, 3.5, 5, 8, 12, 20];
const REALISTIC_R = [1.5, 3, 5, 9, 12, 13, 40, 60, 200, 500];

// --- Equivalence on the realistic domain ------------------------------------

test('poissonPMF: MathUtils matches routes.ts for integer k>=0', () => {
  let maxDiff = 0;
  for (const lambda of LAMBDAS) {
    for (let k = 0; k <= 30; k++) {
      const diff = Math.abs(legacyRoutesPoissonPMF(k, lambda) - MathUtils.poissonPMF(k, lambda));
      maxDiff = Math.max(maxDiff, diff);
    }
  }
  assert.ok(maxDiff < EQUIVALENCE_EPS, `max abs diff ${maxDiff} should be < ${EQUIVALENCE_EPS}`);
  assert.ok(maxDiff < API_PRECISION, 'difference must be invisible at API precision');
});

test('negBinPMF: MathUtils matches routes.ts for integer k>=0 and 0<r<=500', () => {
  let maxDiff = 0;
  for (const mu of MUS) {
    for (const r of REALISTIC_R) {
      for (let k = 0; k <= 40; k++) {
        const diff = Math.abs(legacyRoutesNegBinPMF(k, mu, r) - MathUtils.negBinPMF(k, mu, r));
        maxDiff = Math.max(maxDiff, diff);
      }
    }
  }
  assert.ok(maxDiff < EQUIVALENCE_EPS, `max abs diff ${maxDiff} should be < ${EQUIVALENCE_EPS}`);
  assert.ok(maxDiff < API_PRECISION, 'difference must be invisible at API precision');
});

// --- Negative k: defensive guard (now consistent in both implementations) ---
// Previously routes.ts returned a spurious P(0) for k<0 (its loops never run);
// the `if (k < 0) return 0;` guard fixes that. This test pins the new behavior.

test('negative k returns 0 in both routes.ts and MathUtils', () => {
  for (const k of [-1, -2, -10, -0.5]) {
    assert.equal(legacyRoutesPoissonPMF(k, 2.5), 0, `routes poisson(${k}) must be 0`);
    assert.equal(MathUtils.poissonPMF(k, 2.5), 0, `MathUtils poisson(${k}) must be 0`);
    assert.equal(legacyRoutesNegBinPMF(k, 2.5, 12), 0, `routes negbin(${k}) must be 0`);
    assert.equal(MathUtils.negBinPMF(k, 2.5, 12), 0, `MathUtils negbin(${k}) must be 0`);
  }
});

test('negative k guard does not affect k>=0 (regression against the fix)', () => {
  // Spot-check that adding the guard changed nothing for valid k.
  for (const lambda of [0.5, 2.5, 8]) {
    for (const k of [0, 1, 3, 7]) {
      assert.ok(legacyRoutesPoissonPMF(k, lambda) > 0, `poisson(${k},${lambda}) stays positive`);
    }
  }
  for (const k of [0, 1, 3, 7]) {
    assert.ok(legacyRoutesNegBinPMF(k, 2.5, 12) > 0, `negbin(${k}) stays positive`);
  }
});

// --- Divergences intentionally left as-is (design differences on r) ---------
// These pin CURRENT behavior of BOTH implementations and document why they are
// not unified.

test('DIVERGENCE (by design): invalid r (NaN/Infinity/<=0) — routes.ts degenerates, MathUtils falls back to Poisson', () => {
  const mu = 2.5;
  const k = 2;
  const poissonRef = MathUtils.poissonPMF(k, mu); // ~0.2565
  for (const badR of [NaN, Infinity, -5, 0]) {
    // routes.ts: invalid r => returns (k===0 ? 1 : 0), i.e. a point mass at 0.
    assert.equal(legacyRoutesNegBinPMF(k, mu, badR), 0, `routes negbin degenerate for r=${badR}`);
    // MathUtils: invalid/huge r => Poisson(mu), a real distribution.
    assert.ok(
      Math.abs(MathUtils.negBinPMF(k, mu, badR) - poissonRef) < EQUIVALENCE_EPS,
      `MathUtils falls back to Poisson for r=${badR}`
    );
  }
});

test('DIVERGENCE (by design): r>500 — MathUtils switches to Poisson, routes.ts keeps exact NegBin (> API precision)', () => {
  const mu = 2.5;
  const k = 2;
  const routes = legacyRoutesNegBinPMF(k, mu, 600);        // exact NegBin
  const mathUtils = MathUtils.negBinPMF(k, mu, 600); // Poisson approximation
  const diff = Math.abs(routes - mathUtils);
  assert.ok(diff > API_PRECISION, `r>500 divergence (${diff}) is visible at API precision`);
});

// --- Shared-behavior sanity (where the two DO agree on edge cases) ----------

test('SHARED: non-finite / non-positive lambda and mu collapse to a point mass at 0', () => {
  for (const badLambda of [NaN, Infinity, 0, -1]) {
    assert.equal(legacyRoutesPoissonPMF(0, badLambda), 1);
    assert.equal(MathUtils.poissonPMF(0, badLambda), 1);
    assert.equal(legacyRoutesPoissonPMF(3, badLambda), 0);
    assert.equal(MathUtils.poissonPMF(3, badLambda), 0);
  }
  for (const badMu of [NaN, Infinity, 0, -1]) {
    assert.equal(legacyRoutesNegBinPMF(0, badMu, 12), 1);
    assert.equal(MathUtils.negBinPMF(0, badMu, 12), 1);
    assert.equal(legacyRoutesNegBinPMF(3, badMu, 12), 0);
    assert.equal(MathUtils.negBinPMF(3, badMu, 12), 0);
  }
});
