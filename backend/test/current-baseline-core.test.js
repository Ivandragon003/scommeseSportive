const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildForecastInput, baselineManifest, FEATURE_NAMES } = require('../dist/research/ForecastCore');
function matches() {
  const start = Date.parse('2023-01-01T12:00:00Z');
  return Array.from({ length: 45 }, (_, i) => ({ matchId: `current-${i}`, homeTeamId: `team-${i % 4}`,
    awayTeamId: `team-${(i + 1) % 4}`, date: new Date(start + i * 86400000).toISOString(),
    competition: 'Serie A', season: '2022-23', homeGoals: i % 3, awayGoals: (i + 1) % 3,
    homeXG: 0.6 + i % 4 * 0.3, awayXG: 0.8 + i % 3 * 0.2 }));
}
function forecast(rows) {
  const target = rows[40];
  return buildForecastInput(rows, target, new Date(Date.parse(target.date) - 900000).toISOString());
}
test('current statistical baseline identifies shared current code and does not load the frozen copy', () => {
  const manifest = baselineManifest();
  assert.equal(manifest.protocolVersion, 'current-a-statistical-asof-v2');
  assert.match(manifest.probabilityProtocol, /not the full operational A application state/);
  assert.doesNotMatch(manifest.version, /^A-80cb25df/);
  assert.equal(FEATURE_NAMES.length, 40);
  const keys = Object.keys(manifest.codeHashes);
  assert.ok(keys.some((key) => key.includes('models/core/DixonColesModel')));
  assert.ok(keys.some((key) => key.includes('services/MarketBlendLearningService')));
  assert.ok(keys.every((key) => !key.includes('/frozen/')));
  for (const name of ['ForecastCore', 'CoherentProbabilityPipeline', 'ResearchProbabilityPipeline']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/research', `${name}.ts`), 'utf8');
    assert.doesNotMatch(source, /frozen\/a-80cb25df|\beval\s*\(|\bvm\.run/);
    assert.match(source, /from '\.\.\/(?:models|config|services)\//);
  }
});
test('current adapter excludes future outcomes and distinguishes missing xG from observed zero', () => {
  const rows = matches();
  const original = forecast(rows);
  const changed = rows.map((row, i) => i >= 40 ? { ...row, homeGoals: 50, awayGoals: 45, homeXG: 100 } : row);
  assert.deepEqual(forecast(changed), original);
  assert.ok(Date.parse(original.maxTrainingAvailableAt) <= Date.parse(original.forecastAt));
  const missing = rows.map((row) => ({ ...row, homeXG: null, awayXG: null }));
  const zero = rows.map((row) => ({ ...row, homeXG: 0, awayXG: 0 }));
  const a = forecast(missing), b = forecast(zero);
  assert.equal(a.features[FEATURE_NAMES.indexOf('home_xg_coverage')], 0);
  assert.equal(b.features[FEATURE_NAMES.indexOf('home_xg_coverage')], 1);
  assert.equal(b.features[FEATURE_NAMES.indexOf('home_xg_for')], 0);
  assert.equal(a.features[FEATURE_NAMES.indexOf('home_xg_for')], 1.3);
});
