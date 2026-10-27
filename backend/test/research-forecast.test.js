const test = require('node:test');
const assert = require('node:assert/strict');
const { buildForecastInput, buildTrainingDataset, FEATURE_NAMES, baselineManifest } = require('../dist/research/ForecastCore');

function history(count = 45) {
  const start = Date.parse('2023-01-01T12:00:00Z');
  return Array.from({ length: count }, (_, i) => ({ matchId: `forecast-test-${i}`, homeTeamId: `team-${i % 4}`,
    awayTeamId: `team-${(i + 1) % 4}`, date: new Date(start + i * 86400000).toISOString(),
    competition: 'Serie A', season: '2022-23', homeGoals: i % 3, awayGoals: (i + 1) % 3,
    homeXG: 0.6 + i % 4 * 0.3, awayXG: 0.8 + i % 3 * 0.2 }));
}

test('A is reproducible and target/future outcomes cannot affect an earlier input', () => {
  const matches = history(), target = matches[40];
  const at = new Date(Date.parse(target.date) - 15 * 60000).toISOString();
  const first = buildForecastInput(matches, target, at);
  const changed = matches.map((row, i) => i >= 40 ? { ...row, homeGoals: 50, awayGoals: 45, homeXG: 100, awayXG: 100 } : row);
  const second = buildForecastInput(changed, { ...target, homeGoals: 99, awayGoals: 99 }, at);
  assert.deepEqual(first, second);
  assert.equal(first.features.length, FEATURE_NAMES.length);
  assert.ok(first.features.every(Number.isFinite));
  assert.ok(Date.parse(first.maxTrainingAvailableAt) <= Date.parse(at));
  assert.ok(Math.abs(first.baselineMatrix.flat().reduce((a, b) => a + b) - 1) < 1e-10);
  assert.ok(Math.abs(first.baselineProbabilities.homeWin + first.baselineProbabilities.draw + first.baselineProbabilities.awayWin - 1) < 1e-10);
});

test('frozen A regression fixture retains the reference intensities and goal probabilities', () => {
  const matches = history(), target = matches[40];
  const input = buildForecastInput(matches, target, new Date(Date.parse(target.date) - 900000).toISOString());
  const expected = { homeWin: .22869701458825487, draw: .3280167255091808,
    awayWin: .4432862599025644, over25: .24967498051262854, btts: .3178716621535522 };
  assert.ok(Math.abs(input.lambdaHome - .6197404434488859) < 1e-9);
  assert.ok(Math.abs(input.lambdaAway - 1.0424420360949416) < 1e-9);
  for (const [selection, probability] of Object.entries(expected)) {
    assert.ok(Math.abs(input.baselineProbabilities[selection] - probability) < 1e-9, selection);
  }
});

test('result availability delay excludes same-time and not-yet-observed results', () => {
  const matches = history(), target = { ...matches[44], matchId: 'target', date: '2023-03-01T20:00:00Z' };
  const at = '2023-03-01T19:45:00Z';
  const baseline = buildForecastInput(matches, target, at);
  const withheld = { ...matches[20], matchId: 'withheld', date: '2023-03-01T19:00:00Z', homeGoals: 10, awayGoals: 0 };
  const observedLater = { ...matches[20], matchId: 'late-report', availableAt: '2023-03-02T01:00:00Z' };
  assert.deepEqual(buildForecastInput([...matches, withheld, observedLater], target, at), baseline);
  assert.throws(() => buildForecastInput(matches, target, '2023-03-01T20:01:00Z'), /before kickoff/);
});

test('training export covers all eligible targets, freezes the baseline and avoids recommendation filters', () => {
  const dataset = buildTrainingDataset(history(), '2023-04-01T00:00:00Z');
  assert.equal(dataset.rows.length, 15);
  assert.equal(dataset.exclusions.insufficientHistory, 30);
  assert.deepEqual(dataset.baselineManifest, baselineManifest());
  assert.ok(dataset.rows.every((row) => Date.parse(row.maxTrainingAvailableAt) <= Date.parse(row.forecastAt)));
  assert.equal(dataset.baselineManifest.oddsAsFeatures, false);
  assert.throws(() => buildTrainingDataset([...history(), history()[0]], '2024-01-01T00:00:00Z'), /duplicate_match_id/);
});

module.exports = { history };
