const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ModelAInputCapture, modelAInputSnapshotHash, modelASourceTimestampEvidence } = require('../dist/research/ModelAProspectiveInputs');

test('effective inputs are copied before use and hashed from the actual persisted JSON', () => {
  const capture = new ModelAInputCapture();
  const parameters = { attack: { home: 0.4 }, missing: undefined, date: new Date('2026-01-01T00:00:00Z') };
  capture.observe('contextual', { parameters, homeXG: 0, awayXG: null });
  parameters.attack.home = 10;
  capture.observe('ensemble', { poisson: null });
  capture.observe('analysis', { probability: 0.543217, callback: () => assert.fail('must not invoke') });
  const result = JSON.parse(JSON.stringify(capture.finish()));
  assert.equal(result.snapshot.values.contextual.parameters.attack.home, 0.4);
  assert.equal(result.snapshot.values.contextual.homeXG, 0);
  assert.equal(result.snapshot.values.contextual.awayXG, null);
  assert.equal(result.snapshot.values.contextual.parameters.date, '2026-01-01T00:00:00.000Z');
  assert.equal(result.inputSnapshotHash, modelAInputSnapshotHash(result.snapshot));
  assert.equal(result.temporalStatus, 'locally_observed');
  assert.equal(result.classification, 'technical_only');
  assert.equal(result.rigorousEligible, false);
  assert.equal(result.inputAvailableThrough, null, 'local observation is not upstream publication evidence');
  assert.ok(Date.parse(result.observedInputsThrough) <= Date.now());
  for (const component of result.components) {
    assert.equal(component.hash, modelAInputSnapshotHash(result.snapshot.values[component.name]));
  }
  result.snapshot.values.contextual.homeXG = 1;
  assert.notEqual(result.inputSnapshotHash, modelAInputSnapshotHash(result.snapshot));
});

test('snapshot hashing is stable across object key ordering but sensitive to array order', () => {
  assert.equal(modelAInputSnapshotHash({ b: [0, null], a: { c: 1, a: 2 } }),
    modelAInputSnapshotHash({ a: { a: 2, c: 1 }, b: [0, null] }));
  assert.notEqual(modelAInputSnapshotHash([0, null]), modelAInputSnapshotHash([null, 0]));
  const value = { date: new Date('2026-01-01T00:00:00Z'), absent: undefined, invalidNumber: NaN };
  assert.equal(modelAInputSnapshotHash(value), modelAInputSnapshotHash(JSON.parse(JSON.stringify(value))));
});

test('incomplete or failed capture remains unverified and cannot escape into inference', () => {
  const capture = new ModelAInputCapture();
  const cyclic = {}; cyclic.self = cyclic;
  assert.doesNotThrow(() => capture.observe('contextual', cyclic));
  capture.observe('ensemble', {});
  const result = capture.finish();
  assert.equal(result.inputSnapshotHash, null);
  assert.equal(result.temporalStatus, 'unverified');
  assert.ok(result.limitations.includes('snapshot_capture_failed:contextual'));
  assert.ok(result.limitations.includes('missing_component:analysis'));
});

test('existing SQLite write times are recorded distinctly from source publication', () => {
  const evidence = modelASourceTimestampEvidence({ source: 'understat', created_at: '2026-01-01 12:00:00',
    last_updated: '2026-01-02T13:30:00+01:00', raw_json: JSON.stringify({ resultObservation: {
      source: 'understat', observedAt: '2026-01-02T12:00:00Z' } }) }, '2026-01-03T00:00:00Z');
  assert.equal(evidence.created.utc, '2026-01-01T12:00:00.000Z');
  assert.equal(evidence.updated.utc, '2026-01-02T12:30:00.000Z');
  assert.equal(evidence.updated.status, 'observed');
  assert.equal(evidence.providerPublishedAt, null);
  assert.match(evidence.updated.meaning, /not_input_publication/);
  assert.equal(evidence.resultObservation.sourceMatchesRecord, true);
});

test('missing, invalid and future declarations never manufacture input availability', () => {
  const asOf = '2026-01-03T00:00:00Z';
  assert.equal(modelASourceTimestampEvidence(null, asOf).recordPresent, false);
  const evidence = modelASourceTimestampEvidence({ created_at: '2026-02-30 12:00:00', last_updated: '2026-01-04 12:00:00',
    source: 'understat', raw_json: JSON.stringify({ resultObservation: { source: 'football_data_csv', observedAt: '2026-01-02 12:00:00' } }) }, asOf);
  assert.equal(evidence.created.status, 'invalid');
  assert.equal(evidence.updated.status, 'future');
  assert.equal(evidence.resultObservation.sourceMatchesRecord, false);
  assert.equal(evidence.resultObservation.timestamp.status, 'invalid');
  assert.equal(modelASourceTimestampEvidence({ raw_json: '{' }, asOf).resultObservation.timestamp.status, 'missing');
  const capture = new ModelAInputCapture();
  capture.observe('contextual', { sourceTimestamps: evidence });
  capture.observe('ensemble', {}); capture.observe('analysis', {});
  const payload = capture.finish();
  assert.equal(payload.inputAvailableThrough, null);
  assert.equal(payload.temporalStatus, 'locally_observed');
  assert.equal(payload.inputSnapshotHash, modelAInputSnapshotHash(payload.snapshot));
});
