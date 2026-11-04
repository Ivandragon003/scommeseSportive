const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ModelAInputCapture, modelAInputSnapshotHash, modelASourceRecordEvidence } = require('../dist/research/ModelAProspectiveInputs');

const inspectedAt = '2026-01-03T00:00:00Z';

function completeCapture() {
  const capture = new ModelAInputCapture();
  for (const component of ['contextual', 'ensemble', 'analysis']) capture.observe(component, {});
  return capture;
}

test('source evidence identifies the consumed rows without persisting raw fields', () => {
  const row = { team_id: 'team-1', source_team_id: 1, last_updated: '2026-01-02 00:00:00',
    avg_home_xg: 1.25, raw_json: '{"publicFootballValue":4}', credential: 'must-not-persist' };
  const evidence = modelASourceRecordEvidence(row, inspectedAt);
  assert.deepEqual(evidence.identity, { team_id: 'team-1', source_team_id: 1 });
  assert.equal(evidence.recordHash, modelAInputSnapshotHash(row));
  assert.equal(evidence.inspectedAt, inspectedAt);
  assert.equal(evidence.localAcquiredAt, null);
  assert.equal(evidence.providerPublishedAt, null);
  assert.equal(evidence.providerRevisionAt, null);
  assert.equal(evidence.classification, 'technical_only');
  assert.equal(evidence.rigorousEligible, false);
  assert.ok(!JSON.stringify(evidence).includes('must-not-persist'));
  assert.ok(!JSON.stringify(evidence).includes('publicFootballValue'));
  assert.equal(modelASourceRecordEvidence({ ...row, avg_home_xg: 1.26 }, inspectedAt).identity.team_id, 'team-1');
  assert.notEqual(modelASourceRecordEvidence({ ...row, avg_home_xg: 1.26 }, inspectedAt).recordHash, evidence.recordHash);
});

test('local fit and aggregate computations do not certify training publication or revisions', () => {
  const evidence = modelASourceRecordEvidence({ id: 12, fitted_at: '2026-01-02 00:00:00',
    team_stats_json: JSON.stringify({ computed: { updatedAt: '2026-01-02T01:00:00Z' } }),
    providerPublishedAt: '2026-01-01T00:00:00Z', providerRevisionAt: '2026-01-02T00:00:00Z' }, inspectedAt);
  assert.equal(evidence.fitted.status, 'observed');
  assert.match(evidence.fitted.meaning, /not_training_input_availability/);
  assert.equal(evidence.aggregateComputed.status, 'observed');
  assert.equal(evidence.providerPublishedAt, null);
  assert.equal(evidence.providerRevisionAt, null);
  assert.ok(evidence.flags.includes('provider_timestamp_semantics_unverified'));
  assert.equal(evidence.rigorousEligible, false);
});

test('lineup capture time is a local snapshot write and never upstream acquisition', () => {
  const evidence = modelASourceRecordEvidence({ player_id: 'p1', fetched_at: '2026-01-02T12:00:00Z' }, inspectedAt);
  assert.equal(evidence.lineupCaptured.status, 'observed');
  assert.match(evidence.lineupCaptured.meaning, /capture_write_not_provider_publication/);
  assert.equal(evidence.localAcquiredAt, null);
  assert.equal(evidence.providerPublishedAt, null);
});

test('contradictory and unknown source metadata is flagged without creating temporal bounds', () => {
  const evidence = modelASourceRecordEvidence({ source: 'understat',
    created_at: '2026-01-02 00:00:00', last_updated: '2026-01-01 00:00:00',
    raw_json: JSON.stringify({ resultObservation: { source: 'football_data_csv', observedAt: '2026-01-04T00:00:00Z' } }) }, inspectedAt);
  assert.ok(evidence.flags.includes('database_write_order_mismatch'));
  assert.ok(evidence.flags.includes('result_observation_source_mismatch'));
  assert.ok(evidence.flags.includes('resultObservation_timestamp_future'));
  const unknown = modelASourceRecordEvidence({ raw_json: '{', last_updated: '2026-02-30 00:00:00' }, inspectedAt);
  assert.equal(unknown.source, null);
  assert.equal(unknown.resultObservation.timestamp.status, 'missing');
  assert.ok(unknown.flags.includes('updated_timestamp_invalid'));
});

test('technical capture continues with absent metadata and never becomes rigorous eligible', () => {
  const capture = completeCapture();
  capture.observeSources('contextual', { fixture: null, homeTeam: { team_id: 'home' }, players: [] }, inspectedAt);
  const result = capture.finish();
  assert.equal(result.temporalStatus, 'locally_observed');
  assert.equal(result.classification, 'technical_only');
  assert.equal(result.rigorousEligible, false);
  assert.equal(result.inputAvailableThrough, null);
  assert.equal(result.snapshot.sourceEvidence.contextual.fixture.recordPresent, false);
  assert.equal(result.snapshot.sourceEvidence.contextual.homeTeam.updated.status, 'missing');
  assert.equal(result.snapshot.sourceEvidence.contextual.players.recordCount, 0);
  assert.equal(result.inputSnapshotHash, modelAInputSnapshotHash(JSON.parse(JSON.stringify(result.snapshot))));
});

test('source collections preserve order and hashes at observation without mutating inference arguments', () => {
  const capture = completeCapture();
  const players = [{ player_id: 'p1', avg_xg_per_game: 0.4 }, { player_id: 'p2', avg_xg_per_game: 0 }];
  const original = JSON.stringify(players);
  capture.observeSources('contextual', { players }, inspectedAt);
  assert.equal(JSON.stringify(players), original);
  players[0].avg_xg_per_game = 2;
  players.reverse();
  const evidence = capture.finish().snapshot.sourceEvidence.contextual.players;
  assert.equal(evidence.recordHash, modelAInputSnapshotHash(JSON.parse(original)));
  assert.equal(evidence.records[0].identity.player_id, 'p1');
  assert.notEqual(evidence.recordHash, modelAInputSnapshotHash(players));
});

test('failed source evidence cannot prevent a usable technical effective-input snapshot', () => {
  const capture = completeCapture();
  const throwing = Object.defineProperty({}, 'team_id', { get() { throw new Error('unreadable'); } });
  assert.doesNotThrow(() => capture.observeSources('contextual', { homeTeam: throwing }, inspectedAt));
  const result = capture.finish();
  assert.equal(result.classification, 'technical_only');
  assert.ok(result.inputSnapshotHash);
  assert.ok(result.limitations.includes('source_evidence_capture_failed:contextual'));
});
