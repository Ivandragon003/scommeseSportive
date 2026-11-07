'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const replay = require('./kernel-replay');
const backend = path.resolve(__dirname, '../..');
const quality = require(path.join(backend, 'dist/research/ChallengerDataQuality'));
const holdout = require(path.join(backend, 'dist/research/ResearchHoldoutPolicy'));

function withExternalFixture(run) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'replay-reference-unit-'));
  try {
    fs.mkdirSync(path.join(root, 'research'));
    fs.mkdirSync(path.join(root, 'models/core'), { recursive: true });
    const reference = path.join(root, 'research/ForecastCore.js');
    fs.writeFileSync(path.join(root, 'models/core/DixonColesModel.js'), "exports.syntheticReference = true;\n");
    fs.writeFileSync(reference, "exports.model = require('../models/core/DixonColesModel');\nfunction eligibleHistory() {}\nfunction fitBaseline() {}\nfunction forecastWithFit() {}\nfunction normalizeCompetition() {}\n");
    run(reference, root);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('historical kernel requires an explicit external source with no repository fallback', () => {
  assert.throws(() => replay.loadKernel(false), /historical reference unavailable.*missing --reference-source/);
  assert.throws(() => replay.loadKernel(true, __filename), /historical reference unavailable.*outside this workspace/);
  assert.throws(() => replay.optionsOf(['--matches', 'm', '--dataset', 'd', '--out', 'o']), /missing --reference-source/);
});

test('external synthetic source exposes replay hooks and selects each dependency tree explicitly', () => {
  withExternalFixture(reference => {
    const old = replay.loadKernel(false, reference), current = replay.loadKernel(true, reference);
    assert.equal(old.model.syntheticReference, true);
    assert.equal(typeof current.model.DixonColesModel, 'function');
    for (const hook of ['__eligibleHistory', '__fitBaseline', '__forecastWithFit', '__normalizeCompetition']) {
      assert.equal(typeof old[hook], 'function', hook);
      assert.equal(typeof current[hook], 'function', hook);
    }
  });
});

test('missing reference fails before reading datasets or writing output', () => {
  withExternalFixture((_reference, root) => {
    const output = path.join(root, 'must-not-exist.json');
    assert.throws(() => replay.main(['--matches', 'missing-matches', '--dataset', 'missing-dataset', '--out', output,
      '--reference-source', path.join(root, 'deleted-reference.js')]), /historical reference unavailable/);
    assert.equal(fs.existsSync(output), false);
  });
});
test('target projection excludes outcome and statistics', () => {
  const input = replay.targetInput({ matchId: 'a', homeTeamId: 'h', awayTeamId: 'a', date: '2025-01-01', competition: 'Serie A', season: '2024', homeGoals: 8, homeXG: 12 });
  assert.equal(Object.hasOwn(input, 'homeGoals'), false);
  assert.equal(Object.hasOwn(input, 'homeXG'), false);
});
test('dependency mapping selects current compiled code only for approved paths', () => {
  assert.equal(replay.mappedRequest('../models/core/DixonColesModel', false), '../models/core/DixonColesModel');
  assert.equal(replay.mappedRequest('../models/core/DixonColesModel', true), path.join(backend, 'dist/models/core/DixonColesModel'));
  assert.equal(replay.mappedRequest('../services/ProbabilityEnsembleService', true), path.join(backend, 'dist/services/ProbabilityEnsembleService'));
  assert.equal(replay.mappedRequest('node:crypto', true), 'node:crypto');
});
test('rejects missing provenance, wrong format, protected targets and invalid limit', () => {
  const validate = (m, d) => replay.validateInput(m, d, 'hash', quality, new Set(holdout.ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds));
  assert.throws(() => validate({}, {}), /invalid input/);
  assert.throws(() => validate([], { rows: [] }), /invalid input/);
  assert.throws(() => replay.optionsOf(['--matches', 'm', '--dataset', 'd', '--out', 'o', '--reference-source', 'external.js', '--limit', '0']), /invalid limit/);
  const id = holdout.ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds[0];
  const m = { matchId: id, date: '2025-01-02T00:00:00Z', homeGoals: 0, awayGoals: 0 };
  const d = { rows: [{ matchId: id, forecastAt: '2025-01-01T00:00:00Z', homeGoals: 0, awayGoals: 0 }],
    baselineManifest: { version: 'A-80cb25df' }, reproduction: { matchesFileHash: 'hash' },
    dataQualityPolicyHash: quality.CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true,
    featureBlocks: ['schedule'], asOf: '2025-01-03T00:00:00Z' };
  assert.throws(() => validate([m], d), /invalid target/);
});
test('numeric comparison detects identity and forecast drift', () => {
  assert.equal(replay.compare({ p: [0.3], id: 'a' }, { p: [0.3], id: 'a' }).firstMismatch, null);
  assert.ok(replay.compare({ p: 0.3 }, { p: 0.4 }).firstMismatch);
  assert.ok(replay.compare({ id: 'a' }, { id: 'b' }).firstMismatch);
});

test('rejects invalid explicit result availability', () => {
  const d = { rows: [{ matchId: 'a' }], baselineManifest: { version: 'A-80cb25df' }, reproduction: { matchesFileHash: 'hash' },
    dataQualityPolicyHash: quality.CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true,
    featureBlocks: ['schedule'], asOf: '2025-01-03T00:00:00Z' };
  assert.throws(() => replay.validateInput([{ matchId: 'a', availableAt: 'invalid' }], d, 'hash', quality, new Set()), /invalid explicit availableAt/);
});
test('fit cache shares only same competition and decision instant', () => {
  let fits = 0;
  const kernel = { __normalizeCompetition: value => value, __eligibleHistory: () => [],
    __fitBaseline: () => ({ n: ++fits }), __forecastWithFit: (_h, _t, _f, fit) => fit.n };
  const cache = new Map(), target = { matchId: 'a', competition: 'Serie A' };
  assert.equal(replay.cachedForecast(kernel, cache, [], target, '2025-01-01T00:00:00Z'), 1);
  assert.equal(replay.cachedForecast(kernel, cache, [], { ...target, matchId: 'b' }, '2025-01-01T00:00:00Z'), 1);
  assert.equal(replay.cachedForecast(kernel, cache, [], target, '2025-01-02T00:00:00Z'), 2);
  assert.equal(replay.cachedForecast(kernel, cache, [], { ...target, competition: 'Ligue 1' }, '2025-01-01T00:00:00Z'), 3);
});
