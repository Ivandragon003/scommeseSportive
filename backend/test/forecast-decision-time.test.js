const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveNightlyForecastAt, nightlyDecisionTimeReason } = require('../dist/research/ForecastDecisionTime');

test('Nightly uses the last Rome decision boundary rather than T-15 and covers pre-boundary fixtures', () => {
  assert.equal(resolveNightlyForecastAt('2026-10-30T19:00:00+01:00'), '2026-10-30T02:07:00.000Z');
  assert.equal(resolveNightlyForecastAt('2026-07-10T20:00:00+02:00'), '2026-07-10T01:07:00.000Z');
  assert.equal(resolveNightlyForecastAt('2026-10-30T03:07:00+01:00'), '2026-10-29T02:07:00.000Z');
  assert.equal(resolveNightlyForecastAt('2026-10-30T02:00:00+01:00'), '2026-10-29T02:07:00.000Z');
});

test('Rome DST scans real instants without inventing a skipped boundary', () => {
  assert.equal(resolveNightlyForecastAt('2026-03-29T18:00:00Z'), '2026-03-29T01:07:00.000Z');
  assert.equal(resolveNightlyForecastAt('2026-10-25T18:00:00Z'), '2026-10-25T02:07:00.000Z');
  assert.equal(resolveNightlyForecastAt('2026-03-29T18:00:00Z', { hour: 2, minute: 30 }), '2026-03-28T01:30:00.000Z');
  assert.equal(resolveNightlyForecastAt('2026-10-25T18:00:00Z', { hour: 2, minute: 30 }), '2026-10-25T01:30:00.000Z');
});

test('T-15 cannot be retimestamped as Nightly and observed decision times remain explicit', () => {
  const kickoffAt = '2026-10-30T18:00:00Z';
  assert.equal(nightlyDecisionTimeReason({ kickoffAt, forecastAt: '2026-10-30T17:45:00Z' }), 'nightly_forecast_time_mismatch');
  assert.equal(nightlyDecisionTimeReason({ kickoffAt, forecastAt: '2026-10-30T03:00:00Z' }, {}, '2026-10-30T03:00:00Z'), null);
  assert.equal(nightlyDecisionTimeReason({ kickoffAt, forecastAt: '2026-10-30T01:00:00Z' }, {}, '2026-10-30T01:00:00Z'), 'recorded_nightly_time_mismatch');
  for (const invalid of ['2026-10-30', '2026-10-30T19:00:00', 'invalid']) assert.throws(() => resolveNightlyForecastAt(invalid));
  assert.throws(() => resolveNightlyForecastAt(kickoffAt, { hour: 24 }));
});
