const test = require('node:test');
const assert = require('node:assert/strict');
const build = process.env.CONFIDENCE_STAKE_TEST_BUILD ?? '../dist';
const { confidenceStakePercent, allocateConfidenceStakes } = require(`${build}/research/ConfidenceStake`);

test('confidence stakes use exactly LOW 1%, MEDIUM 3%, HIGH 5%, with normalized labels', () => {
  for (const [confidence, percent] of [['LOW', 1], [' medium ', 3], ['hIgH', 5]]) {
    assert.equal(confidenceStakePercent(confidence), percent);
  }
  for (const confidence of [null, undefined, '', 'UNKNOWN', 'SPECULATIVE', 1, {}, ['HIGH']]) {
    assert.equal(confidenceStakePercent(confidence), null);
  }
  assert.deepEqual(allocateConfidenceStakes([
    { key: 'low', confidence: 'LOW' }, { key: 'high', confidence: 'HIGH' },
    { key: 'medium', confidence: 'MEDIUM' }, { key: 'unknown' },
  ], 12345), [
    { key: 'high', stakeCents: 617, stakePercent: 5, baseAvailableCents: 12345, reason: null },
    { key: 'low', stakeCents: 123, stakePercent: 1, baseAvailableCents: 12345, reason: null },
    { key: 'medium', stakeCents: 370, stakePercent: 3, baseAvailableCents: 12345, reason: null },
    { key: 'unknown', stakeCents: 0, stakePercent: null, baseAvailableCents: 12345, reason: 'unknown_confidence' },
  ]);
});

test('all percentages use the opening available balance and no aggregate five-percent cap', () => {
  const candidates = Array.from({ length: 20 }, (_, index) => ({ key: String(index).padStart(2, '0'), confidence: 'HIGH' }));
  const funded = allocateConfidenceStakes(candidates, 10000);
  assert.equal(funded.length, 20);
  assert.ok(funded.every((allocation) => allocation.stakeCents === 500 && allocation.reason === null));
  assert.equal(funded.reduce((sum, allocation) => sum + allocation.stakeCents, 0), 10000);
  assert.ok(funded.every((allocation) => allocation.baseAvailableCents === 10000));
});

test('funding follows confidence, finite EV descending, then stable key; output is independent of input order', () => {
  const candidates = [
    ...Array.from({ length: 19 }, (_, index) => ({ key: `high-${index}`, confidence: 'HIGH', ev: 1 })),
    { key: 'high-remaining-a', confidence: 'HIGH', ev: .1 },
    { key: 'high-remaining-b', confidence: 'HIGH', ev: .1 },
    { key: 'medium', confidence: 'MEDIUM', ev: 100 },
    { key: 'low', confidence: 'LOW', ev: 1000 },
  ];
  const first = allocateConfidenceStakes(candidates, 10000);
  assert.deepEqual(allocateConfidenceStakes([...candidates].reverse(), 10000), first);
  assert.equal(first.find((allocation) => allocation.key === 'high-remaining-a').stakeCents, 500);
  for (const key of ['high-remaining-b', 'medium', 'low']) {
    assert.equal(first.find((allocation) => allocation.key === key).reason, 'insufficient_available_balance');
  }
  assert.deepEqual(first.map((allocation) => allocation.key), [...candidates.map((candidate) => candidate.key)].sort());
});

test('unavailable EV sorts after finite EV without filtering qualified selections', () => {
  const candidates = [
    ...Array.from({ length: 19 }, (_, index) => ({ key: `high-${index}`, confidence: 'HIGH', ev: 2 })),
    { key: 'a-nan', confidence: 'HIGH', ev: NaN },
    { key: 'b-infinite', confidence: 'HIGH', ev: Infinity },
    { key: 'z-finite-negative', confidence: 'HIGH', ev: -1 },
  ];
  const allocations = allocateConfidenceStakes(candidates, 10000);
  assert.equal(allocations.find((allocation) => allocation.key === 'z-finite-negative').stakeCents, 500);
  assert.equal(allocations.find((allocation) => allocation.key === 'a-nan').stakeCents, 0);
  assert.equal(allocations.find((allocation) => allocation.key === 'b-infinite').stakeCents, 0);
});

test('a whole stake that does not fit is skipped and smaller later stakes can still fit', () => {
  const candidates = [
    ...Array.from({ length: 19 }, (_, index) => ({ key: `high-${index}`, confidence: 'HIGH' })),
    { key: 'medium-a', confidence: 'MEDIUM', ev: 2 },
    { key: 'medium-b', confidence: 'MEDIUM', ev: 1 },
    { key: 'low-a', confidence: 'LOW', ev: 2 },
    { key: 'low-b', confidence: 'LOW', ev: 1 },
  ];
  const allocations = allocateConfidenceStakes(candidates, 10000);
  assert.equal(allocations.find((allocation) => allocation.key === 'medium-b').stakeCents, 0);
  assert.equal(allocations.find((allocation) => allocation.key === 'medium-b').reason, 'insufficient_available_balance');
  assert.equal(allocations.find((allocation) => allocation.key === 'low-a').stakeCents, 100);
  assert.equal(allocations.find((allocation) => allocation.key === 'low-b').stakeCents, 100);
  assert.equal(allocations.reduce((sum, allocation) => sum + allocation.stakeCents, 0), 10000);
});

test('zero and tiny balances do not fabricate a cent, and invalid confidence remains unclassified', () => {
  for (const balance of [0, 1, 19]) {
    const allocations = allocateConfidenceStakes([{ key: 'high', confidence: 'HIGH' }, { key: 'unknown', confidence: null }], balance);
    assert.equal(allocations[0].stakeCents, 0);
    assert.equal(allocations[0].reason, 'zero_stake_amount');
    assert.equal(allocations[1].reason, 'unknown_confidence');
  }
  assert.equal(allocateConfidenceStakes([{ key: 'high', confidence: 'HIGH' }], 20)[0].stakeCents, 1);
  assert.deepEqual(allocateConfidenceStakes([], 0), []);
});

test('cent flooring is exact up to MAX_SAFE_INTEGER and total funding never exceeds the balance', () => {
  for (const balance of [99, 100, 101, 12345, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
    const candidates = Array.from({ length: 111 }, (_, index) => ({
      key: String(index).padStart(3, '0'), confidence: ['LOW', 'MEDIUM', 'HIGH'][index % 3], ev: index % 5,
    }));
    const allocations = allocateConfidenceStakes(candidates, balance);
    let total = 0n;
    for (const allocation of allocations) {
      assert.ok(Number.isSafeInteger(allocation.stakeCents));
      const expected = BigInt(balance) * BigInt(allocation.stakePercent) / 100n;
      assert.equal(BigInt(allocation.stakeCents), allocation.reason === null ? expected : 0n);
      total += BigInt(allocation.stakeCents);
    }
    assert.ok(total <= BigInt(balance));
    assert.deepEqual(allocateConfidenceStakes([...candidates].reverse(), balance), allocations);
  }
});

test('allocation does not mutate frozen inputs and rejects invalid balances and keys', () => {
  const candidates = Object.freeze([Object.freeze({ key: 'a', confidence: 'HIGH', ev: 2 })]);
  assert.equal(allocateConfidenceStakes(candidates, 10000)[0].stakeCents, 500);
  for (const balance of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100']) {
    assert.throws(() => allocateConfidenceStakes(candidates, balance), /available_cents_must_be_nonnegative_safe_integer/);
  }
  for (const key of ['', '   ', null, 1]) {
    assert.throws(() => allocateConfidenceStakes([{ key }], 100), /candidate_key_required/);
  }
  assert.throws(() => allocateConfidenceStakes([{ key: 'a' }, { key: 'a' }], 100), /candidate_key_duplicate/);
});
