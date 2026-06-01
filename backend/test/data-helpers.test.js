const test = require('node:test');
const assert = require('node:assert/strict');
const { numOrNull, parseRawJson, normalizeShotResult, safePct } = require('../dist/utils/dataHelpers.js');

// Characterization tests for the shared data-coercion helpers extracted from
// api/routes.ts (verbatim). Lock the exact current behavior.

test('numOrNull coerces finite numbers and rejects empty/invalid', () => {
  assert.equal(numOrNull(5), 5);
  assert.equal(numOrNull('3.5'), 3.5);
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(NaN), null);
  assert.equal(numOrNull(Infinity), null);
});

test('parseRawJson parses valid JSON strings, else null', () => {
  assert.deepEqual(parseRawJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseRawJson('[1,2]'), [1, 2]);
  assert.equal(parseRawJson(''), null);
  assert.equal(parseRawJson('   '), null);
  assert.equal(parseRawJson('not json'), null);
  assert.equal(parseRawJson(42), null);
  assert.equal(parseRawJson(null), null);
});

test('normalizeShotResult lowercases, trims and strips whitespace', () => {
  assert.equal(normalizeShotResult('  Saved Shot '), 'savedshot');
  assert.equal(normalizeShotResult('GOAL'), 'goal');
  assert.equal(normalizeShotResult(null), '');
  assert.equal(normalizeShotResult(undefined), '');
});

test('safePct divides safely, 0 on invalid/zero denominator', () => {
  assert.equal(safePct(1, 4), 0.25);
  assert.equal(safePct(3, 0), 0);
  assert.equal(safePct(3, -2), 0);
  assert.equal(safePct(NaN, 4), 0);
  assert.equal(safePct(1, NaN), 0);
});
