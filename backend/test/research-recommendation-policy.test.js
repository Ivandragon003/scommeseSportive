const test = require('node:test');
const assert = require('node:assert/strict');
const { VIRTUAL_RECOMMENDATION_POLICY, recommendationQuoteReason } = require('../dist/research/ResearchRecommendationPolicy');

const now = new Date('2026-10-30T10:00:00Z');
const quote = { selection: 'homeWin', market: '1x2', side: 'home', odds: 2, bookmaker: 'Actual Bookmaker',
  source: 'odds_api', priceType: 'prematch', capturedAt: now.toISOString(), updatedAt: now.toISOString() };

test('virtual policy identifies actual app A, frozen challenger C and separate stake rules without a residual veto', () => {
  assert.equal(VIRTUAL_RECOMMENDATION_POLICY.virtualOnly, true);
  assert.equal(VIRTUAL_RECOMMENDATION_POLICY.familyA.source, 'PredictionService');
  assert.equal(VIRTUAL_RECOMMENDATION_POLICY.familyC.modelVersion, 'C-906371b0b3a1e2c8');
  assert.equal(VIRTUAL_RECOMMENDATION_POLICY.familyC.baselineVersion, 'A-80cb25df5552621e');
  assert.equal(VIRTUAL_RECOMMENDATION_POLICY.stakeModeA, 'RECOMMENDED_PERCENT');
  assert.equal(VIRTUAL_RECOMMENDATION_POLICY.stakeModeC, 'FIXED_ONE_PERCENT');
  assert.equal(VIRTUAL_RECOMMENDATION_POLICY.independentCalibrationRequired, false);
  assert.equal(VIRTUAL_RECOMMENDATION_POLICY.maxExposureFraction, .05);
  assert.equal(VIRTUAL_RECOMMENDATION_POLICY.quoteMaxAgeMs, 300000);
});

test('technical quote checks require real fresh prematch prices and supported settlement', () => {
  assert.equal(recommendationQuoteReason(quote, now), null);
  for (const invalid of [{ source: 'model_completion' }, { source: 'unknown' }, { priceType: 'closing' },
    { timestampEvidence: 'observed_snapshot' }, { market: 'corners' }, { bookmaker: '' }, { odds: NaN },
    { updatedAt: '' }, { capturedAt: '2026-10-30T09:54:59Z' }, { updatedAt: '2026-10-30T10:00:01Z' }]) {
    assert.ok(recommendationQuoteReason({ ...quote, ...invalid }, now), JSON.stringify(invalid));
  }
  // Supported settlement is a technical condition, not a new veto on the app's quarter-line recommendation.
  assert.equal(recommendationQuoteReason({ ...quote, selection: 'ahcp_-0.25', market: 'asian_handicap', side: 'home', line: -.25 }, now), null);
});
