const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFrozenProspectiveObservations, prospectiveBucket, prospectivePartition,
  settleProspectiveEvidence } = require('../dist/research/ResearchProspectiveEvidence');
const { ORIGINAL_HOLDOUT_POLICY } = require('../dist/research/ResearchHoldoutPolicy');

const AT = '2026-10-29T02:12:00.000Z', KICKOFF = '2026-10-29T19:45:00.000Z';
const quote = (selection, side, odds = 2) => ({ market: '1x2', selection, side, odds, bookmaker: 'Fixture Book',
  source: 'odds_api', capturedAt: AT, updatedAt: AT, priceType: 'prematch' });
const input = () => ({ matchId: 'future-fixture', family: 'A', modelVersion: 'A-fixture', probabilityConfigurationHash: '1'.repeat(64),
  matrix: [[.2, .1], [.3, .4]], probabilities: { homeWin: .3, draw: .6, awayWin: .1 },
  quotes: [quote('homeWin', 'home'), quote('draw', 'draw'), quote('awayWin', 'away')], allowedMarkets: ['1x2'],
  forecastAt: AT, kickoffAt: KICKOFF, quoteMaxAgeMs: 300000 });

test('prospective selection fixes one observed quote per market/bucket before results and is invariant to provider order', () => {
  const request = input(); request.quotes.push({ ...quote('homeWin', 'home', 2.2), bookmaker: 'Another Book' });
  const result = buildFrozenProspectiveObservations(request);
  assert.equal(result.length, 3);
  assert.equal(result.find((row) => row.bucket === prospectiveBucket(.3)).quote.odds, 2.2);
  assert.deepEqual(buildFrozenProspectiveObservations({ ...request, quotes: [...request.quotes].reverse() }), result);
  assert.ok(result.every((row) => row.protocol === 'prospective-residual-v1'));
  assert.ok(result.every((row) => row.partition === prospectivePartition(request.matchId)));
  assert.throws(() => prospectiveBucket(1), /Invalid/);
  assert.throws(() => prospectivePartition(''), /identity/);
});

test('fixed prospective partition depends on match alone and reserves future test labels for both models', () => {
  const partitions = Array.from({ length: 1000 }, (_, index) => prospectivePartition(`future-match-${index}`));
  const reserved = partitions.filter((partition) => partition === 'FUTURE_TEST').length;
  assert.ok(reserved > 150 && reserved < 250);
  const request = input();
  assert.equal(buildFrozenProspectiveObservations(request)[0].partition,
    buildFrozenProspectiveObservations({ ...request, family: 'C', modelVersion: 'C-fixture' })[0].partition);
});

test('protected historical matches, pre-freeze forecasts, synthetic/stale/future prices and started matches produce no prospective evidence', () => {
  const request = input();
  assert.deepEqual(buildFrozenProspectiveObservations({ ...request, matchId: ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds[0] }), []);
  assert.deepEqual(buildFrozenProspectiveObservations({ ...request, forecastAt: ORIGINAL_HOLDOUT_POLICY.newIndependentForecastsAfter }), []);
  assert.deepEqual(buildFrozenProspectiveObservations({ ...request, kickoffAt: AT }), []);
  assert.deepEqual(buildFrozenProspectiveObservations({ ...request, probabilities: { homeWin: .9, draw: .9, awayWin: .9 } }), []);
  for (const change of [{ source: 'synthetic' }, { usedSyntheticOdds: true }, { bookmaker: '' }, { priceType: 'closing' }, { priceType: 'opening' },
    { priceType: 't15' }, { priceType: undefined }, { capturedAt: '2026-10-29T02:13:00Z' },
    { updatedAt: '2026-10-29T02:00:00Z' }, { market: 'fouls' }, { updatedAt: undefined }]) {
    assert.deepEqual(buildFrozenProspectiveObservations({ ...request, quotes: [{ ...request.quotes[0], ...change }] }), []);
  }
});

test('official result conversion uses the saved price and never reruns inference or moves money', async () => {
  const saved = { id: 'observation', matchId: 'fixture', kickoffAt: KICKOFF,
    snapshot: { quote: { ...quote('ahcp_-0.25', 'home'), market: 'asian_handicap', line: -.25 } } };
  const calls = [];
  const db = { research: { listPendingProspectiveObservations: async () => [saved],
    settleProspectiveObservation: async (...args) => { calls.push(args); return { settled: true }; } },
    getMatchById: async () => ({ date: KICKOFF, home_goals: 1, away_goals: 1, source: 'understat' }) };
  assert.deepEqual(await settleProspectiveEvidence(db, () => new Date('2026-10-30T02:12:00Z')), { checked: 1, settled: 1, unresolved: 0 });
  assert.equal(calls[0][1], .5);
  assert.equal(calls[0][2].source, 'understat');
  assert.equal(calls[0][2].availableAt, undefined, 'the store owns the actual availability clock');
  calls.length = 0;
  await settleProspectiveEvidence(db, () => new Date(AT));
  assert.equal(calls.length, 0);
});
