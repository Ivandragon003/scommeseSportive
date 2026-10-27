const test = require('node:test');
const assert = require('node:assert/strict');
const { fitResearchCalibration, applyResearchProbabilityPipeline } = require('../dist/research/ResearchProbabilityPipeline');
const { ValueBettingEngine } = require('../dist/models/value/ValueBettingEngine');

const observations = Array.from({ length: 160 }, (_, i) => ({ matchId: `cal-${i}`,
  availableAt: '2025-01-01T12:00:00Z', probabilities: { homeWin: 0.2 + i % 7 / 10 },
  outcomes: { homeWin: i % 3 ? 1 : 0 } }));
test('research calibration reuses existing isotonic math and excludes unavailable observations', () => {
  const profile = fitResearchCalibration(observations, '2025-01-02T00:00:00Z');
  const engine = new ValueBettingEngine();
  const expected = engine.fitIsotonicCalibration(observations.map((r) => r.probabilities.homeWin), observations.map((r) => r.outcomes.homeWin));
  assert.deepEqual(profile.calibrationPoints, expected.calibrationPoints);
  const future = { ...observations[0], matchId: 'future', availableAt: '2025-02-01T00:00:00Z', outcomes: { homeWin: 0 } };
  assert.deepEqual(fitResearchCalibration([...observations, future], '2025-01-02T00:00:00Z'), profile);
  assert.throws(() => applyResearchProbabilityPipeline({ homeWin: 0.8 }, profile, [], '2024-01-01T00:00:00Z'), /future_calibration/);
});
test('raw, isotonic and bookmaker-blended probabilities remain separately inspectable', () => {
  const profile = fitResearchCalibration(observations, '2025-01-02T00:00:00Z');
  const raw = { homeWin: 0.8, draw: 0.1, awayWin: 0.1 };
  const quotes = Object.entries({ homeWin: 2, draw: 3, awayWin: 4 }).map(([selection, odds], i) => ({
    selection, market: '1x2', side: ['home', 'draw', 'away'][i], odds, bookmaker: 'Real operator', source: 'odds_api',
    capturedAt: '2025-01-02T11:44:00Z', updatedAt: '2025-01-02T11:44:00Z',
  }));
  const output = applyResearchProbabilityPipeline(raw, profile, quotes, '2025-01-02T11:45:00Z');
  assert.deepEqual(output.raw, raw); assert.notEqual(output.decision.homeWin, output.calibrated.homeWin);
  assert.deepEqual(applyResearchProbabilityPipeline(raw, profile, [], '2025-01-02T11:45:00Z').decision, output.calibrated);
  assert.deepEqual(raw, { homeWin: 0.8, draw: 0.1, awayWin: 0.1 });
});
