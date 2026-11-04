const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ModelAInputCapture, modelAInputSnapshotHash } = require('../dist/research/ModelAProspectiveInputs');

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
