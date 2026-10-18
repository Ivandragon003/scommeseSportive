const test = require('node:test');
const assert = require('node:assert/strict');
const { ValueBettingEngine } = require('../dist/models/value/ValueBettingEngine');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
const { PredictionService } = require('../dist/services/PredictionService');
const { rows } = require('../benchmarks/calibration-cache');

test('presorted calibration is exactly identical, including ties and bucket boundaries', () => {
  const engine = new ValueBettingEngine();
  for (const size of [0, 1, 9, 10, 14, 17, 100, 1000]) {
    const samples = Array.from({ length: size }, (_, i) => ({ p: (i * 17 % 31) / 30, o: i % 2, index: i }));
    samples.push({ p: NaN, o: 1 }, { p: -1, o: 0 }, { p: Infinity, o: 0 });
    const predictions = samples.map((item) => item.p);
    const outcomes = samples.map((item) => item.o);
    const before = [...predictions];
    const expected = engine.fitIsotonicCalibration(predictions, outcomes);
    const ordered = samples.filter((item) => Number.isFinite(item.p) && item.p >= 0 && item.p <= 1)
      .sort((a, b) => a.p - b.p);
    assert.deepEqual(engine.fitIsotonicCalibration(ordered.map((item) => item.p), ordered.map((item) => item.o), { presorted: true }), expected);
    assert.deepEqual(engine.fitIsotonicCalibration(predictions, outcomes, { presorted: true }), expected, 'incorrect hints fall back to sorting');
    assert.deepEqual(predictions, before, 'caller arrays are immutable');
  }
});

test('shared stable ordering equals independently sorting every chronological prefix and family', () => {
  const engine = new ValueBettingEngine();
  const samples = Array.from({ length: 251 }, (_, i) => ({ p: (i * 29 % 37) / 36, o: i % 2, family: i % 3 }));
  const sorted = samples.map((_, i) => i).sort((a, b) => samples[a].p - samples[b].p);
  for (let count = 0; count <= samples.length; count += 7) {
    for (const family of [null, 0, 1, 2]) {
      const prefix = samples.slice(0, count).filter((item) => family === null || item.family === family);
      const actual = sorted.filter((i) => i < count).map((i) => samples[i]).filter((item) => family === null || item.family === family);
      assert.deepEqual(engine.fitIsotonicCalibration(actual.map((item) => item.p), actual.map((item) => item.o), { presorted: true }),
        engine.fitIsotonicCalibration(prefix.map((item) => item.p), prefix.map((item) => item.o)));
    }
  }
});

test('pairing reuse preserves the original fitted parameters within cross-platform rounding', () => {
  const reference = require('./fixtures/dixon-coles-fit-reference.json');
  const matches = new PredictionService({}).mapCompletedMatches(rows);
  const teams = [...new Set(matches.flatMap((match) => [match.homeTeamId, match.awayTeamId]))];
  for (const scenario of reference) {
    const params = new DixonColesModel().fitModel(matches, teams, 280, 0.04, {
      ...scenario.options, referenceDate: new Date(scenario.referenceDate),
    });
    const compare = (actual, expected) => {
      if (typeof expected === 'number') {
        // The reference was recorded before the optimization on Windows/Node24.
        // Linux/Node20 can differ at the last few binary digits in Math.exp.
        assert.ok(Math.abs(actual - expected) <= 1e-12, `${actual} differs from ${expected}`);
      } else {
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
        for (const key of Object.keys(expected)) compare(actual[key], expected[key]);
      }
    };
    compare(params, scenario.params);
  }
});
