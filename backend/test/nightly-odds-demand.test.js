const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { forecastRemainingNightlyOddsDemand: forecast } = require(process.env.ODDS_DEMAND_TEST_MODULE
  || path.join(__dirname, '../dist/services/odds-provider/OddsDemandSimulation'));

const fixture = (id, date, competition = 'Serie A', extra = {}) => ({ matchId: id, date, competition, ...extra });
const options = (extra = {}) => ({ retryRate: 0, ...extra });

test('one request per league/nightly window serves different kickoff times and both models', () => {
  const result = forecast([fixture('a', '2026-10-29T12:00:00Z'), fixture('b', '2026-10-29T20:00:00Z'),
    fixture('c', '2026-10-29T23:00:00Z', 'La Liga')], '2026-10-29T01:00:00Z', options());
  assert.equal(result.competitionNightlyGroups, 2);
  assert.equal(result.calendarFixtures, 3);
  assert.equal(result.estimatedCredits, 6);
  assert.equal(result.estimatedHttpRequests, 2);
  assert.equal(result.nextScheduledAt, '2026-10-29T02:00:00.000Z');
  assert.deepEqual(result.assumptions.sharedByModels, ['A', 'C']);
  assert.equal(result.measuredQuota, null);
  assert.equal(result.completeCalendarVerified, false);
  assert.equal(result.kind, 'offline_remaining_nightly_calendar_projection');
});

test('remaining demand excludes elapsed nightly slots and leagues without fixtures', () => {
  const result = forecast([fixture('already-covered-window', '2026-10-29T20:00:00Z'),
    fixture('next', '2026-10-30T20:00:00Z')], '2026-10-29T12:00:00Z', options());
  assert.equal(result.competitionNightlyGroups, 1);
  assert.equal(result.calendarFixtures, 1);
  assert.equal(result.exclusions.outside_remaining_nightly_windows, 1);
  assert.equal(result.estimatedCredits, 3);
  assert.equal(forecast([], '2026-10-29T12:00:00Z', options()).estimatedCredits, 0);
});

test('Rome DST spring and autumn produce real 23-hour and 25-hour nightly windows', () => {
  const spring = forecast([fixture('spring', '2026-03-28T18:00:00Z')], '2026-03-28T00:00:00Z', options());
  assert.equal(spring.groups[0].decisionAt, '2026-03-28T02:00:00.000Z');
  assert.equal(spring.groups[0].windowEndAt, '2026-03-29T01:00:00.000Z');
  const autumn = forecast([fixture('autumn', '2026-10-24T18:00:00Z')], '2026-10-24T00:00:00Z', options());
  assert.equal(autumn.groups[0].decisionAt, '2026-10-24T01:00:00.000Z');
  assert.equal(autumn.groups[0].windowEndAt, '2026-10-25T02:00:00.000Z');
});

test('custom repeated or nonexistent DST hours never invent a local timestamp', () => {
  const skipped = forecast([fixture('before-gap', '2026-03-28T18:00:00Z')], '2026-03-28T00:00:00Z', options({ hour: 2 }));
  assert.equal(skipped.groups[0].decisionAt, '2026-03-28T01:00:00.000Z');
  assert.equal(skipped.groups[0].windowEndAt, '2026-03-30T00:00:00.000Z');
  const repeated = forecast([fixture('between-hours', '2026-10-25T00:30:00Z'), fixture('after-hours', '2026-10-25T02:00:00Z')],
    '2026-10-25T00:00:00Z', options({ hour: 2 }));
  assert.deepEqual(repeated.groups.map((group) => group.decisionAt), ['2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z']);
});

test('UTC quota month follows the nightly request even when kickoff is in the following month', () => {
  const result = forecast([fixture('november-kickoff', '2026-11-01T00:05:00Z'),
    fixture('november-slot', '2026-11-01T18:00:00Z')], '2026-10-31T00:00:00Z', options());
  assert.equal(result.month, '2026-10');
  assert.equal(result.through, '2026-11-01T00:00:00.000Z');
  assert.equal(result.calendarFixtures, 1);
  assert.equal(result.groups[0].decisionAt, '2026-10-31T02:00:00.000Z');
  assert.equal(result.groups[0].windowEndAt, '2026-11-01T02:00:00.000Z');
});

test('kickoff at the next boundary belongs to the preceding window, never a post-kickoff request', () => {
  const result = forecast([fixture('boundary', '2026-10-30T02:00:00Z')], '2026-10-29T02:00:00Z', options());
  assert.equal(result.calendarFixtures, 1);
  assert.equal(result.competitionNightlyGroups, 1);
  assert.equal(result.groups[0].decisionAt, '2026-10-29T02:00:00.000Z');
});

test('incomplete or contradictory calendars fail closed without inventing requests or complete coverage', () => {
  const good = fixture('good', '2026-10-30T18:00:00Z');
  const result = forecast([good, good, fixture('conflict', '2026-10-30T18:00:00Z'),
    fixture('conflict', '2026-10-31T18:00:00Z'), fixture('unknown', '2026-10-30', 'Serie A', { kickoffPrecision: 'date' }),
    fixture('missing-zone', '2026-10-30T20:00:00'), fixture('postponed', '2026-10-30T20:00:00Z', 'Serie A', { status: 'postponed' }),
    fixture('finished', '2026-10-30T20:00:00Z', 'Serie A', { homeGoals: 1 }),
    fixture('unsupported', '2026-10-30T20:00:00Z', 'Other league')], '2026-10-29T12:00:00Z', options());
  assert.equal(result.calendarFixtures, 1);
  assert.equal(result.estimatedCredits, 3);
  assert.equal(result.exclusions.duplicate_identity, 1);
  assert.equal(result.exclusions.conflicting_duplicate_identity, 1);
  assert.equal(result.exclusions.unknown_or_date_only_kickoff, 1);
  assert.equal(result.exclusions.invalid_or_timezone_missing_kickoff, 1);
  assert.equal(result.exclusions.fixture_not_scheduled, 2);
  assert.equal(result.completeCalendarVerified, false);
  assert.equal(result.futureKickoffsVerified, false);
});

test('database aliases and supplied quota availability limit the capacity scenario conservatively', () => {
  const result = forecast([{ match_id: 'a', competition: 'Serie A', kickoff_at: '2026-10-30T18:00:00Z' },
    fixture('b', '2026-10-30T20:00:00Z', 'La Liga')], '2026-10-29T12:00:00Z',
  options({ usedCredits: 100, availableCredits: 4 }));
  assert.equal(result.budget.availableCredits, 4);
  assert.equal(result.essentialScenario.admittedCredits, 3);
  assert.equal(result.essentialScenario.skippedGroups, 1);
  assert.equal(result.ordinaryScenario.admittedCredits, 0);
  assert.equal(result.measuredQuota, null);
});

function fullMonth() {
  return Array.from({ length: 31 }, (_, day) => ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1']
    .map((league, index) => fixture(`${day}-${index}`, `2026-10-${String(day + 1).padStart(2, '0')}T18:00:00Z`, league))).flat();
}

test('31-day upper scenario distinguishes 450 ordinary credits from the 500 essential maximum', () => {
  const result = forecast(fullMonth(), '2026-10-01T00:00:00Z', options());
  assert.equal(result.competitionNightlyGroups, 155);
  assert.equal(result.estimatedCredits, 465);
  assert.equal(result.budget.ordinaryMonthlyLimit, 450);
  assert.equal(result.budget.essentialMonthlyLimit, 500);
  assert.equal(result.ordinaryScenario.admittedCredits, 450);
  assert.equal(result.ordinaryScenario.skippedGroups, 5);
  assert.equal(result.essentialScenario.admittedCredits, 465);
  assert.equal(result.budget.monthlyLimit - result.essentialScenario.admittedCredits, 35);
  assert.equal(result.completeCalendarVerified, false);
});

test('retry allowance can exceed free capacity and never bypasses the hard monthly maximum', () => {
  const result = forecast(fullMonth(), '2026-10-01T00:00:00Z', { retryRate: .1 });
  assert.equal(result.baseCredits, 465);
  assert.equal(result.retryCreditAllowance, 48);
  assert.equal(result.estimatedCredits, 513);
  assert.equal(result.estimatedHttpRequests, 171);
  assert.ok(result.essentialScenario.admittedCredits <= 500);
  assert.ok(result.essentialScenario.skippedGroups > 0);
  assert.ok(result.ordinaryScenario.admittedCredits <= 450);
  assert.deepEqual(forecast(fullMonth().reverse(), '2026-10-01T00:00:00Z', { retryRate: .1 }), result);
});

test('configured time, bounded windows and partial horizon affect demand without adding daily empty requests', () => {
  const result = forecast([fixture('outside', '2026-10-30T20:00:00Z'), fixture('inside', '2026-10-30T06:00:00Z')],
    '2026-10-29T12:00:00Z', options({ hour: 4, minute: 30, windowHours: 6, through: '2026-10-30T12:00:00Z' }));
  assert.equal(result.calendarFixtures, 1);
  assert.equal(result.groups[0].decisionAt, '2026-10-30T03:30:00.000Z');
  assert.equal(result.groups[0].windowEndAt, '2026-10-30T09:30:00.000Z');
  assert.equal(result.assumptions.windowHours, 6);
});

test('invalid options and unknown as-of timezone are rejected', () => {
  assert.throws(() => forecast([], '2026-10-29T12:00:00'), /timezone/);
  for (const bad of [{ retryRate: 2 }, { hour: 24 }, { minute: 60 }, { windowHours: 49 },
    { reserveCredits: 501 }, { usedCredits: -1 }, { availableCredits: NaN }, { markets: ['correct_score'] },
    { through: '2026-10-28T00:00:00Z' }]) assert.throws(() => forecast([], '2026-10-29T12:00:00Z', bad));
});
