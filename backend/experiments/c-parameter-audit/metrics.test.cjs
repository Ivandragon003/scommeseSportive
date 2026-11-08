'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { metrics, compare } = require('./metrics.cjs');
const probabilities = { homeWin: 1 / 3, draw: 1 / 3, awayWin: 1 / 3, over25: .5 };
const makeRow = (date, goals) => ({ kickoffAt: date, homeGoals: goals[0], awayGoals: goals[1],
  forecasts: Object.fromEntries(['incumbent', 'candidate'].map(family => [family,
    Object.fromEntries(['raw', 'calibrated', 'decision'].map(stage => [stage, { ...probabilities }]))])) });

test('uniform predictions have analytical multiclass and binary proper scores', () => {
  const rows = [[2, 0], [0, 0], [0, 3]].map(goals => makeRow('2026-01-01T12:00:00Z', goals));
  const value = metrics(rows, 'incumbent', 'decision');
  assert(Math.abs(value.logLoss - Math.log(3)) < 1e-12);
  assert(Math.abs(value.brier - 2 / 3) < 1e-12);
  assert(Math.abs(value.over25LogLoss - Math.log(2)) < 1e-12);
  assert.equal(value.over25Brier, .25);
  assert.equal(value.eceTopLabel10Bins, 0);
});

test('paired weekly resampling preserves equality, chronology groups and row count', () => {
  const rows = [makeRow('2026-01-01T12:00:00Z', [1, 0]), makeRow('2026-01-02T12:00:00Z', [0, 0]),
    makeRow('2026-01-15T12:00:00Z', [0, 1])];
  const value = compare(rows, { replications: 2000, seed: 20261108 });
  for (const stage of Object.values(value)) {
    assert.equal(stage.incumbent.n, 3);
    assert.equal(stage.pairedWeekly95PercentInterval.blocks, 2);
    assert(Object.values(stage.deltaCandidateMinusIncumbent).every(v => v === 0));
    assert.deepEqual(stage.pairedWeekly95PercentInterval.intervals,
      { logLoss: { lower: 0, upper: 0 }, brier: { lower: 0, upper: 0 } });
  }
});
