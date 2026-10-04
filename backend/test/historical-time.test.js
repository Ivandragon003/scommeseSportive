const test = require('node:test');
const assert = require('node:assert/strict');
const { historicalTimestamp } = require('../dist/utils/historicalTime.js');
const { PredictionService } = require('../dist/services/PredictionService.js');

test('historical UTC SQL timestamps and explicit offsets resolve to the same instant', () => {
  const utc = Date.parse('2026-06-01T20:00:00Z');
  assert.equal(historicalTimestamp('2026-06-01 20:00:00'), utc);
  assert.equal(historicalTimestamp('2026-06-01T20:00:00'), utc);
  assert.equal(historicalTimestamp('2026-06-01T22:00:00+02:00'), utc);
  assert.equal(historicalTimestamp(new Date(utc)), utc);
  for (const value of ['2026-02-30 20:00:00', '2026-01-01 24:00:00', '', null, 'unknown']) {
    assert.ok(Number.isNaN(historicalTimestamp(value)));
  }
});

test('the calibration/backtest DB mapping preserves UTC timestamps and missing statistics', () => {
  const service = new PredictionService({});
  const rows = service.mapCompletedMatches([{
    match_id: 'sql-date', home_team_id: 'A', away_team_id: 'B', date: '2026-06-01 20:00:00',
    home_goals: 1, away_goals: 0, home_xg: null, home_shots: null,
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date.toISOString(), '2026-06-01T20:00:00.000Z');
  assert.equal(rows[0].homeXG, undefined);
  assert.equal(rows[0].homeTotalShots, undefined);
});
