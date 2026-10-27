const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildOddsDemandGroups, quoteRequestCredits, originalMonthlyApproximation, simulateOddsDemandMonth, simulateOddsDemandScenarios, forecastRemainingOddsDemand } = require(
  process.env.ODDS_DEMAND_TEST_MODULE || path.join(__dirname, '../dist/services/odds-provider/OddsDemandSimulation.js'));

const ASOF = '2026-10-27T07:30:00Z';
const fixture = (id, date, competition = 'Serie A', extra = {}) => ({ matchId: id, date, competition, ...extra });
const options = (extra = {}) => ({ month: '2026-10', asOf: ASOF, retryRate: 0, nightlyOddsEnabled: false, ...extra });

test('credits and HTTP requests are distinct; the prior 855 is a 30-day estimate', () => {
  assert.equal(quoteRequestCredits(3, 1), 3);
  assert.equal(quoteRequestCredits(3, 1, 11), 6);
  assert.deepEqual(originalMonthlyApproximation(), { groups: 135, days: 30, competitions: 5, t15Credits: 405,
    nightlyCredits: 450, totalCredits: 855, measuredConsumption: false, excludesRetriesUiKickoffAndExtraMarkets: true });
});

test('one sport feed serves simultaneous fixtures and both models without duplicating credit demand', () => {
  const fixtures = [fixture('a', '2026-10-01T19:45:00Z'), fixture('b', '2026-10-01T19:45:00Z'),
    fixture('c', '2026-10-01T19:45:00Z', 'La Liga')];
  const result = simulateOddsDemandMonth(fixtures, options());
  assert.equal(result.groupCount, 2);
  assert.equal(result.credits.requiredWithoutBudgetLimit, 6);
  assert.equal(result.httpRequests.requiredWithoutBudgetLimit, 2);
  assert.equal(result.coverage.coveredFixtures, 3);
  assert.equal(result.eventSpecificAlternative.baseCredits, 9);
  assert.equal(result.measuredQuota, null);
});

test('UTC decision month and DST offsets are explicit; unknown or date-only kickoffs are excluded', () => {
  const fixtures = [fixture('boundary', '2026-11-01T00:05:00Z'), fixture('dst-before', '2026-10-25T02:30:00+02:00'),
    fixture('dst-after', '2026-10-25T02:30:00+01:00'), fixture('date-only', '2026-10-01', 'Serie A', { kickoffPrecision: 'date' }),
    fixture('unknown', '2026-10-01T20:00:00Z', 'Serie A', { kickoffKnown: false }),
    fixture('cancelled', '2026-10-01T20:00:00Z', 'Serie A', { status: 'cancelled' })];
  const result = buildOddsDemandGroups(fixtures, '2026-10', ASOF);
  assert.equal(result.eligibleFixtureCount, 3);
  assert.equal(result.groups.find((group) => group.fixtureIds.includes('boundary')).decisionAt, '2026-10-31T23:50:00.000Z');
  assert.equal(result.groups.length, 3);
  assert.equal(result.exclusions.unknown_or_date_only_kickoff, 2);
  assert.equal(buildOddsDemandGroups(fixtures, '2026-11', ASOF).eligibleFixtureCount, 0);
});

test('duplicate identities do not reduce cost twice; conflicting identities are not silently selected', () => {
  const item = fixture('a', '2026-10-01T20:00:00Z');
  const result = buildOddsDemandGroups([item, item, fixture('conflict', '2026-10-01T20:00:00Z'), fixture('conflict', '2026-10-02T20:00:00Z')], '2026-10', ASOF);
  assert.equal(result.eligibleFixtureCount, 1);
  assert.equal(result.exclusions.duplicate_identity, 1);
  assert.equal(result.exclusions.conflicting_duplicate_identity, 1);
});

test('cache reuse respects original provider age and the five-minute maximum', () => {
  const fixtures = [fixture('a', '2026-10-01T20:00:00Z'), fixture('b', '2026-10-01T20:01:00Z')];
  const fresh = simulateOddsDemandMonth(fixtures, options({ cacheWindowSeconds: 300, providerPriceAgeAtFetchSeconds: 0 }));
  assert.equal(fresh.httpRequests.requiredWithoutBudgetLimit, 1);
  assert.equal(fresh.coverage.cacheHitGroups, 1);
  const aged = simulateOddsDemandMonth(fixtures, options({ cacheWindowSeconds: 300, providerPriceAgeAtFetchSeconds: 250 }));
  assert.equal(aged.httpRequests.requiredWithoutBudgetLimit, 2);
  const stale = simulateOddsDemandMonth(fixtures, options({ providerPriceAgeAtFetchSeconds: 301 }));
  assert.equal(stale.coverage.coveredFixtures, 0);
  assert.ok(stale.decisions.every((decision) => decision.reason === 'stale_price_scenario'));
});

test('budget coverage is deterministic and distinguishes ordinary reserve from T15 priority', () => {
  const fixtures = Array.from({ length: 3 }, (_, index) => fixture(String(index), `2026-10-0${index + 1}T20:00:00Z`));
  const conservative = simulateOddsDemandMonth(fixtures, options({ monthlyBudgetCredits: 10, reserveCredits: 4 }));
  const priority = simulateOddsDemandMonth(fixtures, options({ monthlyBudgetCredits: 10, reserveCredits: 4, reserveAppliesToT15: false }));
  assert.equal(conservative.coverage.coveredFixtures, 2);
  assert.equal(conservative.coverage.skippedFixtures, 1);
  assert.equal(conservative.credits.admitted, 6);
  assert.equal(priority.coverage.coveredFixtures, 3);
  assert.deepEqual(simulateOddsDemandMonth([...fixtures].reverse(), options({ monthlyBudgetCredits: 10, reserveCredits: 4 })), conservative);
});

test('retry allowance has explicit charged cost without pretending to measure real failure frequency', () => {
  const fixtures = Array.from({ length: 10 }, (_, index) => fixture(String(index), `2026-10-${String(index + 1).padStart(2, '0')}T20:00:00Z`));
  const result = simulateOddsDemandMonth(fixtures, options({ retryRate: .1 }));
  assert.equal(result.assumptions.retryGroups, 1);
  assert.equal(result.credits.requiredWithoutBudgetLimit, 33);
  assert.equal(result.httpRequests.requiredWithoutBudgetLimit, 11);
  assert.equal(result.coverage.coveredFixtures, 10);
  assert.throws(() => simulateOddsDemandMonth(fixtures, options({ retryRate: 1.1 })), /retry rate/);
});

test('31-day nightly demand is not the 30-day example, and fallback capacity is never invented', () => {
  const scenarios = simulateOddsDemandScenarios([], '2026-10', ASOF);
  assert.equal(scenarios.currentCallPaths.days, 31);
  assert.equal(scenarios.currentCallPaths.credits.requiredWithoutBudgetLimit, 465);
  assert.equal(scenarios.currentCallPaths.httpRequests.requiredWithoutBudgetLimit, 155);
  assert.equal(scenarios.optimizedConservative.credits.requiredWithoutBudgetLimit, 0);
  assert.equal(scenarios.distinctFreeFallback.status, 'BLOCKED_UNCONFIGURED');
  assert.equal(scenarios.distinctFreeFallback.additionalProvenCoverage, 0);
});

test('admin projection accepts database aliases and limits cost to future decision targets in this UTC month', () => {
  const fixtures = [{ match_id: 'past', competition: 'Serie A', date: '2026-10-26T20:00:00Z' },
    { match_id: 'future', competition: 'Serie A', date: '2026-10-28T20:00:00Z' },
    { matchId: 'same-feed', competition: 'Serie A', kickoffAt: '2026-10-28T20:00:00Z' },
    { match_id: 'next-month', competition: 'La Liga', date: '2026-11-02T20:00:00Z' }];
  const projection = forecastRemainingOddsDemand(fixtures, ASOF, { retryRate: 0 });
  assert.equal(projection.calendarFixtures, 2);
  assert.equal(projection.competitionKickoffGroups, 1);
  assert.equal(projection.estimatedCredits, 3);
  assert.equal(projection.estimatedHttpRequests, 1);
  assert.equal(projection.through, '2026-11-01T00:00:00.000Z');
  assert.equal(projection.completeCalendarVerified, false);
  assert.equal(projection.measuredQuota, null);
});
