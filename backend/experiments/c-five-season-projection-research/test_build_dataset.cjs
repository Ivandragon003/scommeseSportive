'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { optionsOf, buildPartition, mergeDatasets, TARGET_FROM, TARGET_UNTIL } = require('./build_dataset.cjs');
test('offline wrapper forwards exact forty-feature and per-match timing contract', () => {
  const history = [{ matchId: 'toy' }]; let called = false;
  const result = buildPartition(history, '2026-07-02T00:00:00Z', ['League'], {
    NIGHTLY_DECISION_TIME_PROTOCOL: 'nightly-europe-rome-v1', resolveNightlyForecastAt: (kickoff, schedule) => { assert.deepEqual(schedule, { hour: 3, minute: 7 }); return `${kickoff}:nightly`; },
    buildChallengerTrainingDataset: (rows, cutoff, options) => { called = true; assert.equal(rows, history); assert.deepEqual(options.blocks, []); assert.equal(options.targetFrom, TARGET_FROM); assert.equal(options.targetUntil, TARGET_UNTIL); assert.equal(options.forecastAt('toy'), 'toy:nightly'); assert.equal(options.forecastBuilder, undefined); return 'unchanged-builder'; },
  }); assert(called); assert.equal(result, 'unchanged-builder');
});
test('CPU parallelism is bounded and duplicate/invalid options fail', () => {
  const args = ['--plan', 'p', '--matches', 'h', '--asof', '2026-07-02T00:00:00Z', '--out', 'o'];
  assert.equal(optionsOf(args).workers, 2); assert.throws(() => optionsOf([...args, '--workers', '3']));
  assert.throws(() => optionsOf([...args, '--out', 'other']));
});
function part(id) { return { rows: [{ matchId: id, forecastAt: '2021-01-01T03:07:00Z', features: Array(40).fill(0), featureNames: Array(40).fill('x') }],
  featureNames: Array(40).fill('x'), featureBlocks: [], asOf: '2026-07-02T00:00:00Z', dataQualityBaselineClean: true,
  exclusions: { insufficientHistory: 1 }, protectedMatchesExcluded: 2, dataQualityEvidence: { history: { inputRows: 20 }, targets: { inputRows: 3, retainedRows: 2, excludedRows: 1, excludedMatchIds: [id] } } }; }
test('partition merge preserves global history and adds only disjoint target evidence', () => {
  const a = part('a'), b = part('b'), result = mergeDatasets([a, b]);
  assert.equal(result.rows.length, 2); assert.equal(result.protectedMatchesExcluded, 4); assert.equal(result.dataQualityEvidence.targets.inputRows, 6);
  assert.deepEqual(result.dataQualityEvidence.history, { inputRows: 20 }); assert.equal(a.dataQualityEvidence.targets.inputRows, 3);
  assert.throws(() => mergeDatasets([a, a])); b.featureNames[0] = 'other'; assert.throws(() => mergeDatasets([a, b]));
});
