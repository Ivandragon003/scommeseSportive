const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { evaluateChallengerPayout, selectChallengerPayoutRecommendation,
  CHALLENGER_PAYOUT_SELECTION_POLICY } = require('../dist/research/ChallengerSelection');
const { settleGoalQuote } = require('../dist/research/GoalSettlement');

const at = '2026-10-31T10:00:00.000Z';
const quote = (selection, side, overrides = {}) => ({ market: '1x2', selection, side, odds: 2,
  bookmaker: 'Actual Book', source: 'odds_api', priceType: 'prematch', capturedAt: at, updatedAt: at, ...overrides });
const quality = () => ({ technicalValidation: true, calibrationAvailableAt: '2026-10-27T10:00:00Z',
  prospectiveResidualSamples: 0, parameterUncertainty: null, uncertaintyReason: 'parameter_uncertainty_not_supplied' });
const results = () => [quote('homeWin', 'home'), quote('draw', 'draw', { odds: 4 }), quote('awayWin', 'away', { odds: 4 })];
const asian = (line, odds = 2) => [quote(`ahcp_${line}`, 'home', { market: 'asian_handicap', line, odds }),
  quote(`ahcp_away_${-line}`, 'away', { market: 'asian_handicap', line: -line, odds })];
const select = (matrix, quotes, extra = {}) => selectChallengerPayoutRecommendation({ matrix, quotes,
  observedAt: at, allowedMarkets: ['1x2', 'totals', 'asian_handicap'], quality: quality(), ...extra });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('payout selector has no dependency on the app value engine or canonical picker', () => {
  const source = readFileSync(join(__dirname, '../src/research/ChallengerSelection.ts'), 'utf8');
  assert.doesNotMatch(source, /ValueBettingEngine|CanonicalBetRecommendation|PredictionService/);
});

test('binary C payout keeps exact EV units and ranks on actual wealth growth at the fixed one-percent stake', () => {
  const matrix = [[.2, .2], [.6, 0]], price = results()[0];
  const payout = evaluateChallengerPayout(matrix, price);
  close(payout.probability, .6); close(payout.expectedValue, .2); close(payout.payoutVariance, .96);
  close(payout.expectedLogGrowth, .6 * Math.log(1.01) + .4 * Math.log(.99));
  const packet = select(matrix, results());
  assert.equal(packet.policyVersion, CHALLENGER_PAYOUT_SELECTION_POLICY);
  assert.equal(packet.selected.selection, 'homeWin');
  close(packet.selected.ourProbability, 60); close(packet.selected.expectedValue, 20);
  assert.equal(packet.selected.suggestedStakePercent, 1);
  assert.equal(packet.selected.confidence, null);
  assert.equal(packet.selected.quality.parameterUncertainty, null);
  assert.equal(packet.selected.quality.prospectiveResidualSamples, 0);
  assert.equal(packet.selected.quality.uncertaintyReason, 'parameter_uncertainty_not_supplied');
  assert.equal(packet.abstentionReason, null);
});

test('push, quarter losses and quarter wins retain their actual probabilities, risk and payout EV', () => {
  const matrix = [[.3, .2], [.5, 0]];
  for (const [line, expectedEv, status, expectedReturn] of [
    [0, .3, 'VOID', 1], [-.25, .15, 'HALF_LOST', .5], [.25, .45, 'HALF_WON', 1.5],
  ]) {
    const prices = asian(line), payout = evaluateChallengerPayout(matrix, prices[0]);
    close(payout.expectedValue, expectedEv);
    close(payout.outcomes.find((outcome) => outcome.status === status).probability, .3);
    close(payout.outcomes.find((outcome) => outcome.status === status).returnMultiplier, expectedReturn);
    assert.equal(settleGoalQuote(prices[0], 0, 0).status, status);
    const packet = select(matrix, prices);
    assert.equal(packet.selected.selection, prices[0].selection);
    close(packet.selected.expectedValue, expectedEv * 100);
    assert.equal(packet.selected.confidence, null);
    assert.equal(packet.exclusions.non_binary_payout_not_supported_by_canonical_engine, undefined);
  }
  close(evaluateChallengerPayout(matrix, asian(0)[0]).payoutVariance, .61);
  close(evaluateChallengerPayout(matrix, asian(-.25)[0]).payoutVariance, .7525);
});

test('quarter totals agree with the exact settlement of every score cell', () => {
  const matrix = [[.2, .1, .2, .1], [.1, .05, .1, 0], [.1, .05, 0, 0], [0, 0, 0, 0]];
  for (const line of [1.75, 2, 2.25, 2.75]) {
    for (const side of ['over', 'under']) {
      const price = quote(`${side}${line}`, side, { market: 'totals', line, odds: 2.15 });
      const evaluated = evaluateChallengerPayout(matrix, price);
      const expected = matrix.reduce((sum, row, home) => sum + row.reduce((subtotal, mass, away) =>
        subtotal + mass * settleGoalQuote(price, home, away).returnMultiplier, 0), 0);
      close(evaluated.expectedValue, expected - 1);
    }
  }
});

test('positive EV alone does not authorize negative expected log growth at the fixed stake', () => {
  const price = quote('homeWin', 'home', { odds: 100 });
  const packet = select([[.49, .499], [.011, 0]], [price, ...results().slice(1)]);
  assert.ok(evaluateChallengerPayout([[.49, .499], [.011, 0]], price).expectedValue > 0);
  assert.ok(packet.rejections.some((row) => row.selection === 'homeWin' && row.reason === 'non_positive_expected_log_growth'));
  assert.ok(packet.opportunities.every((row) => row.selection !== 'homeWin'));
});

test('precise reasons distinguish no price, registry veto, negative EV, missing technical quality and all-refund distribution', () => {
  const matrix = [[.2, .2], [.6, 0]];
  assert.equal(select(matrix, []).abstentionReason, 'real_fresh_quotes_unavailable');
  assert.equal(select(matrix, results(), { allowedMarkets: [] }).abstentionReason, 'market_not_allowed');
  assert.equal(select(matrix, results(), { quality: { ...quality(), technicalValidation: false } }).abstentionReason,
    'challenger_technical_validation_failed');
  const neutral = [quote('homeWin', 'home', { odds: 1.1 }), quote('draw', 'draw', { odds: 1.1 }), quote('awayWin', 'away', { odds: 1.1 })];
  assert.equal(select(matrix, neutral).abstentionReason, 'non_positive_payout_ev');
  assert.equal(select([[1, 0], [0, 0]], asian(0)).abstentionReason, 'all_stakes_refunded');
  assert.equal(select([[.2, .1], [.2, 0]], results()).abstentionReason, 'invalid_challenger_matrix');
});

test('bookmaker companions cannot cross update times, lines, books or conflicting outcomes', () => {
  const matrix = [[.2, .2], [.6, 0]];
  for (const corrupt of [
    (prices) => { prices[1].bookmaker = 'Different Book'; },
    (prices) => { prices[1].updatedAt = '2026-10-31T09:59:00Z'; },
    (prices) => { prices[1].capturedAt = '2026-10-31T09:59:00Z'; prices[1].updatedAt = '2026-10-31T09:59:00Z'; },
    (prices) => { prices.push({ ...prices[0], odds: 2.1 }); },
  ]) {
    const prices = results(); corrupt(prices);
    assert.equal(select(matrix, prices).selected, null);
    assert.ok(select(matrix, prices).exclusions.complete_bookmaker_market_required > 0);
  }
  const prices = asian(-.25); prices[1].line = .75;
  assert.equal(select(matrix, prices).selected, null);
});

test('synthetic, stale, future and unsupported markets remain excluded regardless of registry entries', () => {
  const matrix = [[.2, .2], [.6, 0]];
  for (const patch of [{ source: 'model_completion' }, { usedSyntheticOdds: true }, { priceType: 'closing' },
    { updatedAt: '2026-10-31T09:54:00Z' }, { updatedAt: '2026-10-31T10:01:00Z' }]) {
    assert.equal(select(matrix, results().map((price) => ({ ...price, ...patch }))).selected, null);
  }
  const dnb = quote('dnb_home', 'home', { market: 'dnb' });
  const packet = select(matrix, [dnb], { allowedMarkets: ['dnb'] });
  assert.equal(packet.abstentionReason, 'market_not_supported_by_challenger_selector');
});

test('ranking is deterministic under quote reordering and never mutates the matrix, quotes or evidence', () => {
  const matrix = [[.2, .2], [.6, 0]], prices = [...results(), ...asian(-.25)], evidence = quality();
  const before = JSON.stringify({ matrix, prices, evidence });
  const first = select(matrix, prices, { quality: evidence });
  const second = select(matrix, [...prices].reverse(), { quality: evidence });
  assert.deepEqual(first.ranked, second.ranked);
  assert.equal(JSON.stringify({ matrix, prices, evidence }), before);
  assert.equal(first.selected.suggestedStakePercent, 1);
});

test('missing history quality is explicit unknown and never becomes a zero sample or a high confidence', () => {
  const packet = select([[.2, .2], [.6, 0]], results());
  assert.equal(packet.selected.confidence, null);
  for (const field of ['homeHistorySample', 'awayHistorySample', 'homeXgCoverage', 'awayXgCoverage',
    'historyAvailableThrough', 'modelFitAt']) {
    assert.equal(packet.selected.quality[field], null, field);
    assert.ok(packet.selected.quality.dataQualityMissingFields.includes(field));
  }
  assert.equal(packet.selected.quality.uncertaintyAdjustment, 'not_applied_parameter_uncertainty_unavailable');
});

test('observed sample sizes and xG coverage are preserved without inventing an uncertainty penalty or minimum sample threshold', () => {
  const observed = { ...quality(), homeHistorySample: 1, awayHistorySample: 2, homeXgCoverage: 0,
    awayXgCoverage: .5, historyAvailableThrough: '2026-10-30T22:00:00Z', modelFitAt: '2026-10-29T10:00:00Z' };
  const packet = select([[.2, .2], [.6, 0]], results(), { quality: observed });
  assert.equal(packet.selected.selection, 'homeWin');
  for (const field of ['homeHistorySample', 'awayHistorySample', 'homeXgCoverage', 'awayXgCoverage',
    'historyAvailableThrough', 'modelFitAt']) assert.equal(packet.selected.quality[field], observed[field]);
  assert.deepEqual(packet.selected.quality.dataQualityMissingFields, []);
  assert.equal(packet.selected.quality.parameterUncertainty, null);
  assert.equal(packet.selected.quality.uncertaintyAdjustment, 'not_applied_parameter_uncertainty_unavailable');
  close(packet.selected.rankingScore, select([[.2, .2], [.6, 0]], results()).selected.rankingScore);
});

test('present nonfinite, negative, fractional sample counts and out-of-range coverage fail explicitly', () => {
  for (const field of ['homeHistorySample', 'awayHistorySample', 'prospectiveResidualSamples']) {
    for (const value of [NaN, Infinity, -1, .5, '20', false]) {
      const packet = select([[.2, .2], [.6, 0]], results(), { quality: { ...quality(), [field]: value } });
      assert.equal(packet.selected, null);
      assert.equal(packet.abstentionReason, 'invalid_challenger_sample_evidence', `${field}: ${value}`);
    }
  }
  for (const field of ['homeXgCoverage', 'awayXgCoverage']) {
    for (const value of [NaN, Infinity, -.01, 1.01, '0.5', false]) {
      const packet = select([[.2, .2], [.6, 0]], results(), { quality: { ...quality(), [field]: value } });
      assert.equal(packet.selected, null);
      assert.equal(packet.abstentionReason, 'invalid_challenger_xg_coverage', `${field}: ${value}`);
    }
  }
});

test('future or malformed data-availability, fit and calibration timestamps never authorize a payout-aware selection', () => {
  for (const field of ['historyAvailableThrough', 'modelFitAt', 'calibrationAvailableAt']) {
    const future = select([[.2, .2], [.6, 0]], results(), { quality: { ...quality(), [field]: '2026-10-31T10:00:00.001Z' } });
    assert.equal(future.selected, null);
    assert.equal(future.abstentionReason, 'future_challenger_quality_evidence', field);
    for (const value of ['', '2026-10-30T10:00:00', 'not-a-time', 0]) {
      const malformed = select([[.2, .2], [.6, 0]], results(), { quality: { ...quality(), [field]: value } });
      assert.equal(malformed.selected, null);
      assert.equal(malformed.abstentionReason, 'invalid_challenger_quality_timestamp', `${field}: ${value}`);
    }
  }
});
