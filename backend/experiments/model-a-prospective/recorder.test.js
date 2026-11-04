'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRecorder } = require('./recorder');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-a-prospective-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = new Date('2026-01-01T10:00:00Z');
  const recorder = createRecorder(dir, () => now);
  const unavailable = () => ({ status: 'unavailable', over: null, under: null, reason: 'not recorded' });
  const input = { match: { id: 'match-1', competition: 'Serie A', season: '2025/26', home: 'A', away: 'B', kickoffAt: '2026-01-01T12:00:00Z' },
    forecastAt: '2026-01-01T09:59:00Z', model: { version: 'APP-A-ab12', configHash: 'a'.repeat(64), codeHash: 'b'.repeat(64), stateHash: 'c'.repeat(64) },
    stages: { ensembleRaw: { status: 'applied', over: .54, under: .46 }, contextual: unavailable(), calibrated: unavailable(), marketBlended: unavailable(), decision: unavailable() },
    decisionInfo: { action: 'NOT_RECORDED', selection: null, reason: 'not recorded' },
    quotes: [], inputEvidence: { snapshotHash: null, availableThrough: null, reason: 'not verified' } };
  return { dir, recorder, input, setNow: value => { now = new Date(value); } };
}
test('separate immutable snapshots preserve probabilities, without inventing missing stages or odds', t => {
  const { recorder, input } = setup(t); const before = JSON.stringify(input);
  const a = recorder.forecast(input); const b = recorder.forecast(input);
  assert.notEqual(a.record.id, b.record.id); assert.equal(JSON.stringify(input), before);
  assert.equal(recorder.read(a.record.id).stages.ensembleRaw.over, .54);
  assert.equal(a.record.stages.calibrated.over, null); assert.deepEqual(a.record.quotes, []);
  assert.equal(a.record.match.id, b.record.match.id); assert.equal('homeGoals' in a.record, false);
});
test('rejects future inputs, ambiguous time, future or synthetic quote and post-kickoff write', t => {
  const { recorder, input, setNow } = setup(t);
  input.inputEvidence.availableThrough = '2026-01-01T10:00:00Z'; assert.throws(() => recorder.forecast(input), /future_input/);
  input.inputEvidence.availableThrough = null; input.forecastAt = '2026-01-01T09:59:00'; assert.throws(() => recorder.forecast(input), /invalid_forecast_time/);
  input.forecastAt = '2026-01-01T09:59:00Z';
  input.quotes = [{ selection: 'over25', odds: 2, provider: 'odds_api', bookmaker: 'X', capturedAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T09:58:00Z', synthetic: false }];
  assert.throws(() => recorder.forecast(input), /future_quote/);
  input.quotes[0].capturedAt = '2026-01-01T09:58:00Z'; input.quotes[0].synthetic = true; assert.throws(() => recorder.forecast(input), /invalid_quote/);
  input.quotes = []; input.result = { homeGoals: 3 }; assert.throws(() => recorder.forecast(input), /invalid_forecast/);
  delete input.result; setNow('2026-01-01T12:00:00Z'); assert.throws(() => recorder.forecast(input), /forecast_not_recorded_prematch/);
});
test('results are separate and only recorded after their declared availability', t => {
  const { recorder, input, setNow } = setup(t); const prediction = recorder.forecast(input).record;
  const result = { forecastId: prediction.id, homeGoals: 2, awayGoals: 1, finalAt: '2026-01-01T14:00:00Z', availableAt: '2026-01-01T14:05:00Z', source: 'results provider' };
  assert.throws(() => recorder.result(result), /result_not_available/);
  setNow('2026-01-01T14:06:00Z'); const stored = recorder.result(result).record;
  assert.equal(stored.forecastId, prediction.id); assert.equal(stored.homeGoals, 2);
  assert.deepEqual(recorder.read(prediction.id), prediction);
});
test('a real quote is preserved with provider and original timestamps', t => {
  const { recorder, input } = setup(t);
  const quote = { selection: 'over25', odds: 1.95, provider: 'odds_api', bookmaker: 'X',
    capturedAt: '2026-01-01T09:58:00Z', updatedAt: '2026-01-01T09:57:00Z', synthetic: false };
  input.quotes.push(quote);
  const forecast = recorder.forecast(input).record;
  assert.deepEqual(forecast.quotes, [quote]);
  assert.equal(forecast.forecastAt, input.forecastAt);
  assert.equal(forecast.recordedAt, '2026-01-01T10:00:00.000Z');
});
test('tampering is detected by the snapshot hash', t => {
  const { dir, recorder, input } = setup(t); const id = recorder.forecast(input).record.id;
  const file = path.join(dir, `${id}.json`); const e = JSON.parse(fs.readFileSync(file)); e.record.stages.ensembleRaw.over = .9; fs.writeFileSync(file, JSON.stringify(e));
  assert.throws(() => recorder.read(id), /integrity_failure/);
});
test('recording leaves the shared calibration calculation unchanged', t => {
  const { ValueBettingEngine } = require('../../dist/models/value/ValueBettingEngine');
  const engine = new ValueBettingEngine();
  const curve = [{ x: 0, y: 0 }, { x: .5, y: .48 }, { x: 1, y: 1 }];
  const before = engine.calibrate(.55, curve, 200);
  const { recorder, input } = setup(t); recorder.forecast(input);
  assert.equal(engine.calibrate(.55, curve, 200), before);
});
