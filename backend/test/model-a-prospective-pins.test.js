'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { evaluateRows, evaluateProspective, optionsFor, canonical, selectOnly, parseArgs } = require('../scripts/model-a-prospective-evaluate');
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const options = { cutoff: '2026-11-05T12:00:00Z', origin: 'direct_a', expectedCodeHash: A, resultSource: 'understat' };
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function forecast(id, matchId = id, overrides = {}) {
  const snapshot = { available: true };
  return { schema: 'model-a-operational-prospective-v1', family: 'A', id, matchId, forecastAt: '2026-11-04T12:00:00Z', inputAsOf: '2026-11-04T11:59:00Z', kickoffAt: '2026-11-04T18:00:00Z', origin: 'direct_a', competition: 'Serie A', season: '2026/27', model: { version: 'A-v1', codeHash: A, configHash: B, stateHash: C }, provenance: { snapshot, inputSnapshotHash: hash(snapshot), classification: 'verified', rigorousEligible: true, inputAvailableThrough: '2026-11-04T11:58:00Z' }, stages: {}, ...overrides };
}
function row(p, fields = {}) { return { id: p.id, match_id: p.matchId, forecast_at: p.forecastAt, kickoff_at: p.kickoffAt, payload_json: JSON.stringify(p), evidence_id: 'e', source: 'understat', observed_at: '2026-11-04T20:00:00Z', recorded_at: '2026-11-04T20:01:00Z', home_goals: 2, away_goals: 1, ...fields }; }

test('strict pins are mandatory and validated; technical pins are optional but applied', () => {
  assert.throws(() => optionsFor({ cutoff: options.cutoff, origin: options.origin }), /strict_pins_required/);
  assert.throws(() => optionsFor({ ...options, expectedCodeHash: 'x' }), /invalid_expected_code_hash/);
  assert.throws(() => optionsFor({ ...options, resultSource: 'unsafe source' }), /invalid_result_source/);
  assert.equal(optionsFor({ cutoff: options.cutoff, origin: options.origin, mode: 'technical' }).mode, 'technical');
  assert.equal(parseArgs(['--expected-code-hash', A, '--result-source', 'understat']).resultSource, 'understat');
  const p = forecast('p'), r = row(p);
  assert.equal(evaluateRows([r], [r], options).denominators.scoredMatches, 1);
  assert.equal(evaluateRows([r], [r], { ...options, expectedCodeHash: B }).exclusions.expected_code_hash_mismatch, 1);
  assert.equal(evaluateRows([r], [r], { ...options, resultSource: 'other' }).exclusions.result_source_mismatch, 1);
  assert.equal(evaluateRows([r], [], { ...options, mode: 'technical', expectedCodeHash: B }).exclusions.expected_code_hash_mismatch, 1);
  assert.equal(evaluateRows([r], [], { mode: 'technical', cutoff: options.cutoff, origin: options.origin }).denominators.scoredMatches, 1);
});

test('strict availability must be proven by inputAsOf, before the forecast', () => {
  for (const value of [null, '2026-11-04T11:59:30Z']) {
    const p = forecast('p'); p.provenance.inputAvailableThrough = value;
    const r = row(p), report = evaluateRows([r], [r], options);
    assert.equal(report.denominators.scoredMatches, 0);
    assert.equal(report.exclusions.strict_temporal_gate_excluded, 1);
  }
  const p = forecast('p'); p.provenance.inputAvailableThrough = p.inputAsOf;
  const r = row(p); assert.equal(evaluateRows([r], [r], options).denominators.scoredMatches, 1);
});

const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || major === 22 && minor >= 13;
test('first forecast and latest source/lifecycle are selected before pin checks', { skip: !hasSqlite }, async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
  const client = { async execute({ sql, args }) { selectOnly(sql); return { rows: db.prepare(sql).all(args) }; } };
  const put = p => db.prepare('INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)').run(p.id, p.matchId, p.forecastAt, p.kickoffAt, JSON.stringify(p));
  const result = (id, match, source, observed, recorded) => db.prepare('INSERT INTO model_a_prospective_results VALUES (?,?,?,?,?,?,?,?,?)').run(id, match, source, '2026-11-04T18:00:00Z', observed, recorded, 2, 1, '{}');
  const lifecycle = (id, match, source, status, observed, recorded) => db.prepare('INSERT INTO model_a_prospective_result_observations VALUES (?,?,?,?,?,?,?,?,?)').run(id, match, source, '2026-11-04T18:00:00Z', observed, recorded, status, 'test', '{}');
  const bad = forecast('first', 'm1'); bad.model.codeHash = B; put(bad);
  put(forecast('later', 'm1', { forecastAt: '2026-11-04T13:00:00Z' }));
  result('r1', 'm1', 'understat', '2026-11-04T20:00:00Z', '2026-11-04T20:01:00Z');
  put(forecast('m2')); result('r2a', 'm2', 'understat', '2026-11-04T20:00:00Z', '2026-11-04T20:01:00Z');
  result('r2b', 'm2', 'other', '2026-11-04T21:00:00Z', '2026-11-04T21:01:00Z');
  put(forecast('m3')); result('r3', 'm3', 'understat', '2026-11-04T20:00:00Z', '2026-11-04T20:01:00Z');
  lifecycle('l3', 'm3', 'other', 'final', '2026-11-04T20:00:00Z', '2026-11-04T20:01:00Z');
  put(forecast('m4')); result('r4', 'm4', 'understat', '2026-11-04T20:00:00Z', '2026-11-04T20:01:00Z');
  lifecycle('l4', 'm4', 'understat', 'conflict', '2026-11-04T21:00:00Z', '2026-11-04T21:01:00Z');
  put(forecast('m5')); result('r5', 'm5', 'understat', '2026-11-04T20:00:00Z', '2026-11-04T20:01:00Z');
  const report = await evaluateProspective(client, options);
  assert.equal(report.denominators.firstForecastCandidates, 5);
  assert.equal(report.denominators.scoredMatches, 1);
  assert.equal(report.exclusions.expected_code_hash_mismatch, 1);
  assert.equal(report.exclusions.result_source_mismatch, 1);
  assert.equal(report.exclusions.latest_lifecycle_not_confirmed, 1);
  assert.equal(report.exclusions.missing_or_unconfirmed_result, 1);
});
