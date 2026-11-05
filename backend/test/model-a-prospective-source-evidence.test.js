const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ModelAInputCapture, modelAInputSnapshotHash, modelASourceRecordEvidence, modelAParameterSourceMetadata, modelATrainingInputEvidence } = require('../dist/research/ModelAProspectiveInputs');

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

test('fit writes after input as-of are visible even when already past at inspection', () => {
  const inputAsOf = '2026-01-02T12:00:00Z';
  const evidence = modelASourceRecordEvidence({ id: 42, fitted_at: '2026-01-02 13:00:00' }, inspectedAt, inputAsOf);
  assert.equal(evidence.fitted.status, 'observed');
  assert.equal(evidence.inputAsOf.utc, '2026-01-02T12:00:00.000Z');
  assert.ok(evidence.flags.includes('fitted_after_input_as_of'));
  assert.ok(!evidence.flags.includes('fitted_timestamp_future'));
  assert.equal(evidence.classification, 'technical_only');
  assert.equal(evidence.rigorousEligible, false);
  const atBoundary = modelASourceRecordEvidence({ fitted_at: '2026-01-02 12:00:00' }, inspectedAt, inputAsOf);
  assert.ok(!atBoundary.flags.includes('fitted_after_input_as_of'));
  const future = modelASourceRecordEvidence({ fitted_at: '2026-01-04 12:00:00' }, inspectedAt, inputAsOf);
  assert.ok(future.flags.includes('fitted_timestamp_future'));
  assert.ok(future.flags.includes('fitted_after_input_as_of'));
});

test('as-of checks propagate to consumed rows without discarding a technical capture', () => {
  const capture = completeCapture();
  const rows = [{ player_id: 'p1', fetched_at: '2026-01-02T13:00:00+01:00' },
    { player_id: 'p2', fetched_at: '2026-01-02T13:00:01+01:00' }];
  const original = JSON.stringify(rows);
  capture.observeSources('contextual', { players: rows }, inspectedAt, '2026-01-02T12:00:00Z');
  const result = capture.finish();
  const evidence = result.snapshot.sourceEvidence.contextual.players.records;
  assert.ok(!evidence[0].flags.includes('lineupCaptured_after_input_as_of'));
  assert.ok(evidence[1].flags.includes('lineupCaptured_after_input_as_of'));
  assert.equal(JSON.stringify(rows), original);
  assert.equal(result.inputSnapshotHash, modelAInputSnapshotHash(result.snapshot));
  assert.equal(result.inputAvailableThrough, null);
  assert.equal(result.rigorousEligible, false);
});

test('unusable as-of references do not manufacture a temporal comparison', () => {
  const row = { fitted_at: '2026-01-02 13:00:00' };
  for (const [reference, status] of [[undefined, 'missing'], ['2026-02-30T00:00:00Z', 'invalid'],
    ['2026-01-04T00:00:00Z', 'future'], ['2026-01-02 12:00:00', 'invalid']]) {
    const evidence = modelASourceRecordEvidence(row, inspectedAt, reference);
    assert.equal(evidence.inputAsOf.status, status);
    assert.ok(!evidence.flags.some(flag => flag.endsWith('_after_input_as_of')));
    if (status !== 'missing') assert.ok(evidence.flags.includes(`input_as_of_timestamp_${status}`));
  }
});

test('future aggregate and result observations remain distinct from the input as-of bound', () => {
  const evidence = modelASourceRecordEvidence({ source: 'understat',
    team_stats_json: JSON.stringify({ computed: { updatedAt: '2026-01-04T00:00:00Z' } }),
    raw_json: JSON.stringify({ resultObservation: { source: 'understat', observedAt: '2026-01-02T13:00:00Z' } }) },
  inspectedAt, '2026-01-02T12:00:00Z');
  assert.ok(evidence.flags.includes('aggregateComputed_timestamp_future'));
  assert.ok(evidence.flags.includes('aggregateComputed_after_input_as_of'));
  assert.ok(evidence.flags.includes('resultObservation_after_input_as_of'));
  assert.equal(evidence.resultObservation.timestamp.status, 'observed');
  assert.equal(evidence.providerPublishedAt, null);
  assert.equal(evidence.providerRevisionAt, null);
});

test('parameter metadata fingerprints the loaded blob without copying coefficients or inventing fit writes', () => {
  const row = { id: 42, fitted_at: '2026-01-02 13:00:00', params: { attackParams: { home: 4 }, poissonXg: { levelScale: 1 } } };
  const metadata = modelAParameterSourceMetadata('database_record', row);
  assert.equal(metadata.sourceParametersHash, modelAInputSnapshotHash(row.params));
  assert.equal(metadata.id, 42);
  assert.equal(metadata.fitted_at, row.fitted_at);
  assert.equal('params' in metadata, false);
  assert.ok(Object.isFrozen(metadata));
  row.params.attackParams.home = 0;
  assert.notEqual(metadata.sourceParametersHash, modelAInputSnapshotHash(row.params));
  const evidence = modelASourceRecordEvidence(metadata, inspectedAt, '2026-01-02T12:00:00Z');
  assert.ok(evidence.flags.includes('fitted_after_input_as_of'));
  assert.equal(evidence.parameterSource.sourceParametersHash, metadata.sourceParametersHash);
  const fit = modelAParameterSourceMetadata('in_memory_fit', { params: row.params }, '2026-01-02T12:30:00Z');
  assert.equal(fit.id, null);
  assert.equal(fit.fitted_at, null);
  assert.equal(fit.localFitCompletedAt, '2026-01-02T12:30:00Z');
  assert.equal(modelAParameterSourceMetadata('not_observed').sourceParametersHash, null);
  assert.equal(metadata.trainingInputs, null, 'loaded records have no reconstructed training lineage');
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(modelAParameterSourceMetadata('database_record', { params: cyclic }).captureError, true);
});

test('training evidence freezes actual fit arguments and distinguishes fixture times from availability', () => {
  const matches = [{ matchId: 'old', date: new Date('2026-01-01T00:00:00Z'), homeXG: 1.2 },
    { matchId: 'future', date: new Date('2026-01-04T00:00:00Z'), homeXG: 0 }, { matchId: 'invalid', date: new Date(NaN) }];
  const persisted = JSON.parse(JSON.stringify(matches));
  const evidence = modelATrainingInputEvidence(matches, inspectedAt);
  assert.equal(evidence.inputHash, modelAInputSnapshotHash(persisted));
  assert.equal(evidence.inputCount, 3);
  assert.equal(evidence.maximumKickoffAt, '2026-01-04T00:00:00.000Z');
  assert.equal(evidence.futureKickoffCount, 1);
  assert.equal(evidence.invalidKickoffCount, 1);
  assert.match(evidence.scope, /before_model_specific_validation/);
  assert.match(evidence.timeMeaning, /not_input_publication_or_availability/);
  matches[0].homeXG = 8;
  assert.notEqual(evidence.inputHash, modelAInputSnapshotHash(matches));
  const metadata = modelAParameterSourceMetadata('in_memory_fit', { params: {} }, inspectedAt, evidence);
  const source = modelASourceRecordEvidence(metadata, inspectedAt, '2026-01-02T00:00:00Z');
  assert.equal(source.parameterSource.trainingInputHash, evidence.inputHash);
  assert.ok(source.flags.includes('training_fixture_kickoff_after_fit_observation'));
  assert.ok(source.flags.includes('maximumTrainingKickoff_after_input_as_of'));
  assert.equal(source.rigorousEligible, false);
  const cyclic = []; cyclic.push(cyclic);
  assert.equal(modelATrainingInputEvidence(cyclic, inspectedAt).captureError, true);
  assert.equal(modelATrainingInputEvidence([], 'invalid-clock').futureKickoffCount, null);
});
