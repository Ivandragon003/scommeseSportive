const test = require('node:test');
const assert = require('node:assert/strict');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel.js');

function history() {
  return Array.from({ length: 36 }, (_, index) => ({
    matchId: `clock-${index}`, homeTeamId: index % 2 ? 'A' : 'B',
    awayTeamId: index % 2 ? 'B' : 'A', date: new Date(Date.UTC(2021, 7, index + 1)),
    season: '2021', homeGoals: index % 4, awayGoals: index % 3,
    homeXG: 0.8 + (index % 4) / 3, awayXG: 0.6 + (index % 3) / 3,
  }));
}

test('real historical Dixon-Coles fitting uses the supplied clock and stays unchanged across live dates', (t) => {
  const referenceDate = new Date('2021-10-01T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2024-01-01T00:00:00Z') });
  const firstModel = new DixonColesModel();
  const clocks = [];
  const originalWeight = firstModel.computeMatchWeight.bind(firstModel);
  t.mock.method(firstModel, 'computeMatchWeight', (fixture, current, previous, now, options) => {
    clocks.push(now.getTime());
    return originalWeight(fixture, current, previous, now, options);
  });
  const first = structuredClone(firstModel.fitModel(history(), ['A', 'B'], 35, 0.035, { referenceDate }));
  t.mock.timers.setTime(Date.parse('2026-10-04T00:00:00Z'));
  const second = new DixonColesModel().fitModel(history(), ['A', 'B'], 35, 0.035, { referenceDate });
  assert.ok(clocks.length >= 36);
  assert.ok(clocks.every((timestamp) => timestamp === referenceDate.getTime()));
  assert.deepEqual(second, first);
  assert.ok(Number.isFinite(first.homeAdvantage));
  assert.ok(Object.values(first.attackParams).every(Number.isFinite));
  assert.equal(referenceDate.toISOString(), '2021-10-01T12:00:00.000Z');
});

test('Dixon-Coles fits without a historical reference retain the live clock', (t) => {
  const liveTimestamp = Date.parse('2026-10-04T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: liveTimestamp });
  const model = new DixonColesModel();
  const clocks = [];
  const originalWeight = model.computeMatchWeight.bind(model);
  t.mock.method(model, 'computeMatchWeight', (fixture, current, previous, now, options) => {
    clocks.push(now.getTime());
    return originalWeight(fixture, current, previous, now, options);
  });
  model.fitModel(history(), ['A', 'B'], 5);
  assert.ok(clocks.length >= 36);
  assert.ok(clocks.every((timestamp) => timestamp === liveTimestamp));
});
