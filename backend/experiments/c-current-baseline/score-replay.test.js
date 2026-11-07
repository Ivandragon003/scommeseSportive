'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { metrics, groupedMetrics, pairedIntervals, diagnosticArtifact, uniqueRows, equalIds,
  compareConsumed, validateTemporal, project, optionsOf, validateReplays, verifySourceHashes, main } = require('./score-replay');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');

const row = (id = 'fixture') => ({ matchId: id, competition: 'Serie A', season: '2024/2025',
  homeTeamId: 'home', awayTeamId: 'away', kickoffAt: '2024-08-03T18:00:00Z', forecastAt: '2024-08-03T01:07:00Z',
  maxTrainingAvailableAt: '2024-08-02T18:00:00Z', modelFitAt: '2024-08-03T01:07:00Z', trainingCount: 10,
  homeGoals: 2, awayGoals: 1, featureNames: ['consumed', 'unused'], features: [5, 9], featureSchema: 'schema',
  baselineMatrix: [[0.2, 0.1], [0.3, 0.4]], lambdaHome: 1.2, lambdaAway: 1,
  baselineProbabilities: { homeWin: 0.3, cardsTotalOver35: 0.6 } });
const forecast = { matchId: 'fixture', forecastAt: '2024-08-03T01:07:00Z' };
const artifact = () => ({ version: 'C-reference', baselineVersion: 'A-old', createdAt: '2026-11-07T12:00:00Z',
  trainedThrough: '2024-01-31T00:00:00Z', validationThrough: '2024-06-01T00:00:00Z',
  trainingSplit: Object.fromEntries(['train', 'selection', 'calibration'].map(part => [part,
    { to: '2024-06-30T23:59:59Z', availableThrough: '2024-06-01T00:00:00Z' }])),
  calibrationProfilesV2: { C: { fittedThrough: '2024-06-01T00:00:00Z' } },
  holdoutProtection: { protectedRowsUsed: 0 }, productionAdoptionEligible: false });

test('metrics use multiclass summed Brier and top-label ECE10', () => {
  const rows = [{ target: 0, frozen: [0.8, 0.1, 0.1] }, { target: 2, frozen: [0.2, 0.5, 0.3] }];
  const m = metrics(rows, 'frozen');
  assert.equal(m.n, 2); assert.equal(m.accuracy, 0.5);
  assert.ok(Math.abs(m.logLoss - (-Math.log(0.8) - Math.log(0.3)) / 2) < 1e-15);
  assert.ok(Math.abs(m.brier - (0.06 + 0.78) / 2) < 1e-15);
  assert.ok(Math.abs(m.ece10 - 0.35) < 1e-15);
  assert.throws(() => metrics([{ target: 0, frozen: [1, 1, 1] }], 'frozen'), /invalid metric/);
});
test('missing, duplicate and unexpected identities fail', () => {
  assert.throws(() => uniqueRows([row(), row()], 'fixture'), /duplicate/);
  assert.throws(() => equalIds(uniqueRows([row()], 'a'), uniqueRows([row(), row('other')], 'b'), 'test'), /missing/);
  assert.throws(() => equalIds(uniqueRows([row('other')], 'a'), uniqueRows([row()], 'b'), 'test'), /unexpected/);
});
test('any consumed difference requires refit, even below reference tolerance', () => {
  const old = row(), current = structuredClone(old); current.features[0] += 1e-14;
  assert.equal(compareConsumed([old], [current], ['consumed']).differingConsumedRows, 1);
  current.features[0] = old.features[0]; current.baselineMatrix[0][0] += 1e-14;
  assert.equal(compareConsumed([old], [current], ['consumed']).differingConsumedRows, 1);
});
test('flat cards and unused projected features are reported separately', () => {
  const old = row(), current = structuredClone(old); current.features[1] = 99; current.baselineProbabilities.cardsTotalOver35 = 0.7;
  const result = compareConsumed([old], [current], ['consumed']);
  assert.equal(result.differingConsumedRows, 0); assert.equal(result.flatBaselineDifferingRows, 1);
  assert.deepEqual(result.flatBaselineDifferingKeys, { cardsTotalOver35: 1 });
  assert.deepEqual(project(current, ['consumed']).features, [5]);
});
test('cross-arm label, timing and metadata drift fail', () => {
  for (const [key, value] of [['homeGoals', 3], ['forecastAt', '2024-08-02T01:07:00Z'], ['competition', 'La Liga']]) {
    const old = row(), current = { ...old, [key]: value };
    assert.throws(() => compareConsumed([old], [current], ['consumed']), /identity drift/);
  }
  const old = { ...row(), maxTrainingAvailableAt: row().forecastAt };
  assert.throws(() => compareConsumed([old], [old], ['consumed']), /future baseline/);
});
test('model, calibration and every split must precede forecast; retrospective creation is honest', () => {
  assert.doesNotThrow(() => validateTemporal(forecast, artifact()));
  for (const key of ['trainedThrough', 'validationThrough']) {
    assert.throws(() => validateTemporal(forecast, { ...artifact(), [key]: forecast.forecastAt }), /future/);
  }
  const calibration = artifact(); calibration.calibrationProfilesV2.C.fittedThrough = forecast.forecastAt;
  assert.throws(() => validateTemporal(forecast, calibration), /calibration/);
  const split = artifact(); split.trainingSplit.selection.availableThrough = forecast.forecastAt;
  assert.throws(() => validateTemporal(forecast, split), /selection/);
});
test('diagnostic derivative has separate identity and baseline, preserving source', () => {
  const original = artifact(), before = JSON.stringify(original);
  const derived = diagnosticArtifact(original, 'experimental-current-kernel-abc', 'abc', '2026-11-07T13:00:00Z');
  assert.equal(JSON.stringify(original), before);
  assert.notEqual(derived.artifact.version, original.version);
  assert.notEqual(derived.artifact.baselineVersion, original.baselineVersion);
  assert.equal(derived.artifact.createdAt, '2026-11-07T13:00:00Z');
  assert.equal(derived.artifact.registerable, false); assert.equal(derived.artifact.productionAdoptionEligible, false);
  assert.deepEqual(derived.artifact.calibrationProfilesV2, original.calibrationProfilesV2);
  assert.notEqual(derived.hash, diagnosticArtifact(original, 'experimental-other', 'abc', '2026-11-07T13:00:00Z').hash);
});
test('identical paired forecasts have exact zero conditional intervals and same grouped metrics', () => {
  const rows = [0, 1, 2].map((target, index) => ({ target, matchId: String(index), competition: 'Serie A',
    season: '2024/2025', forecastAt: '2024-08-03T01:07:00Z', frozen: [0.5, 0.3, 0.2], currentProxy: [0.5, 0.3, 0.2] }));
  const result = pairedIntervals(rows);
  assert.deepEqual(result.logLossDelta95, [0, 0]); assert.deepEqual(result.brierDelta95, [0, 0]);
  assert.equal(result.conditionalOnModel, true); assert.equal(result.samples, 0);
  const grouped = groupedMetrics(rows); assert.deepEqual(grouped.ALL.frozen, grouped.ALL.currentProxy);
  assert.equal(grouped.byLeague['Serie A'].frozen.n, 3);
});
test('nonidentical paired block intervals are deterministic', () => {
  const rows = ['Serie A', 'La Liga', 'Bundesliga', 'Ligue 1', 'Premier League'].flatMap(competition =>
    [0, 1].map(index => ({ target: 0, competition, forecastAt: `2024-08-${index ? '12' : '03'}T01:07:00Z`,
      frozen: [0.4, 0.3, 0.3], currentProxy: [0.6, 0.2, 0.2] })));
  assert.deepEqual(pairedIntervals(rows, 20, 42), pairedIntervals(rows, 20, 42));
  const result = pairedIntervals(rows, 20, 42);
  assert.equal(result.probabilityLeagueJointImprovement, 1); assert.ok(result.logLossDelta95[1] < 0);
});
test('CLI refuses missing, repeated and unknown options', () => {
  assert.throws(() => optionsOf([]), /missing/);
  assert.throws(() => optionsOf(['--dataset', 'a', '--dataset', 'b']), /invalid/);
  assert.throws(() => optionsOf(['--env', 'a']), /invalid/);
  assert.throws(() => optionsOf(['--replays', 'r', '--dataset', 'd', '--comparison', 'c', '--artifacts', 'a', '--out', 'o']),
    /historical reference unavailable.*missing --reference-source/);
});

test('source verification requires the supplied historical reference and still pins implementation hashes', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'score-reference-unit-'));
  const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  try {
    const reference = path.join(root, 'ForecastCore.js');
    fs.writeFileSync(reference, 'exports.syntheticHistoricalReference = true;\n');
    const backend = path.resolve(__dirname, '../..');
    const manifest = { codeHashes: { 'dist/research/ForecastCore.js': hashFile(path.join(backend, 'dist/research/ForecastCore.js')) },
      frozenForecastCoreHash: hashFile(reference), comparatorHash: hashFile(path.join(__dirname, 'kernel-replay.js')) };
    assert.throws(() => verifySourceHashes(manifest), /historical reference unavailable/);
    assert.doesNotThrow(() => verifySourceHashes(manifest, reference));
    assert.throws(() => verifySourceHashes({ ...manifest, codeHashes: { 'dist/research/ForecastCore.js': 'changed' } }, reference), /compiled source changed/);
    fs.appendFileSync(reference, '// changed reference\n');
    assert.throws(() => verifySourceHashes(manifest, reference), /historical reference source changed/);
    const output = path.join(root, 'must-not-exist');
    assert.throws(() => main(['--replays', 'missing-replays', '--dataset', 'missing-dataset', '--comparison', 'missing-comparison',
      '--artifacts', 'missing-artifacts', '--out', output, '--reference-source', path.join(root, 'deleted-reference.js')]),
    /historical reference unavailable/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('replay gate rejects duplicate partitions, missing reference rows and altered source identity', () => {
  const identity = { protocol: 'current-kernel-raw-historical-proxy-v1', frozenForecastCoreHash: 'frozen',
    comparatorHash: 'runner', codeHashes: { 'dist/module.js': 'source' } };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const manifest = { ...identity, fingerprint, version: `experimental-current-kernel-${fingerprint.slice(0, 16)}`,
    description: 'proxy', registerable: false };
  const original = row(), current = { ...original, baselineVersion: manifest.version };
  const dataset = { rows: [original], reproduction: { matchesFileHash: 'matches' } };
  const replay = { diagnosticOnly: true, registerable: false, datasetFileHash: 'dataset', matchesFileHash: 'matches',
    baselineManifest: manifest, referenceVerificationTolerance: 1e-12, referenceRowsVerified: 1,
    selection: { selectedRows: 1, totalCanonicalRows: 1 }, currentDataset: { rows: [current], baselineManifest: manifest },
    differences: [{ matchId: original.matchId, verification: { firstMismatch: null, maxAbsoluteDifference: 0 } }] };
  assert.equal(validateReplays([replay], dataset, 'dataset').current.length, 1);
  assert.throws(() => validateReplays([replay, replay], dataset, 'dataset'), /duplicate/);
  assert.throws(() => validateReplays([{ ...replay, differences: [] }], dataset, 'dataset'), /missing/);
  assert.throws(() => validateReplays([{ ...replay, matchesFileHash: 'wrong' }], dataset, 'dataset'), /provenance/);
  const altered = structuredClone(replay); altered.baselineManifest.codeHashes['dist/module.js'] = 'other';
  assert.throws(() => validateReplays([altered], dataset, 'dataset'), /fingerprint/);
});
