'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { ModelAProspectiveCollection, collectionScopeManifest } = require('../dist/research/ModelAProspectiveCollection');

async function setup(now = Date.now()) {
  const client = createClient({ url: 'file::memory:' });
  await client.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
  await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,home_team_id TEXT,away_team_id TEXT,competition TEXT,season TEXT,date TEXT,home_goals INTEGER,away_goals INTEGER,raw_json TEXT)');
  const scope = { protocolId: 'test', manifestSha256: 'a'.repeat(64), seasons: ['2026/27'], from: new Date(now - 48 * 3600000).toISOString(), to: new Date(now + 48 * 3600000).toISOString() };
  scope.manifestSha256 = collectionScopeManifest(scope).sha256;
  const insert = (id, offset, raw = '{}') => client.execute({ sql: 'INSERT INTO matches VALUES(?,?,?,?,?,?,?,?,?)', args: [id, 'home', 'away', 'Serie A', '2026/27', new Date(now + offset * 3600000).toISOString(), null, null, raw] });
  return { client, scope, insert, now, close: () => client.close() };
}

test('impossible scope dates and nested canceled fixtures never produce a forecast', async () => {
  assert.throws(() => collectionScopeManifest({ protocolId: 'invalid-date', seasons: ['2026/27'],
    from: '2026-02-30T00:00:00Z', to: '2026-03-10T00:00:00Z' }), /collection_interval_invalid/);
  const x = await setup();
  try {
    await x.insert('canceled-nested', 2, JSON.stringify({ match: { status: 'cancelled' } }));
    let predictions = 0;
    const collector = new ModelAProspectiveCollection(x.client, { async predict() { predictions++; } }, x.scope, () => new Date(x.now));
    await collector.run();
    assert.equal(predictions, 0);
    const row = (await x.client.execute("SELECT reason FROM model_a_collection_ledger WHERE match_id='canceled-nested'")).rows[0];
    assert.equal(row.reason, 'cancelled_or_postponed');
  } finally { x.close(); }
});
const rows = async (client, sql) => (await client.execute(sql)).rows;
test('window boundaries, concurrency, missing prices and persistent failures', async () => {
  const x = await setup();
  try {
    await x.insert('start', 24); await x.insert('end', 1); await x.insert('early', 24.01); await x.insert('late', 0.99); await x.insert('cancel', 2, '{"status":"cancelled"}'); await x.insert('failure', 3);
    let calls = 0;
    const predictor = { async predict(request, options) {
      calls++; assert.equal(request.bookmakerOdds, undefined); assert.equal(options.recordAudit, false); assert.equal(options.prospectiveOrigin, 'prospective_a');
      if (request.matchId === 'failure') throw Error('failed');
      const match = (await rows(x.client, `SELECT date FROM matches WHERE match_id='${request.matchId}'`))[0];
      const id = 'forecast-' + request.matchId, at = new Date(x.now).toISOString();
      await x.client.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES(?,?,?,?,?)', args: [id, request.matchId, at, match.date, JSON.stringify({ origin: 'prospective_a', collection: options.prospectiveCollection, competition: 'Serie A', season: '2026/27' })] });
      options.onProspectiveRecord({ status: 'pending', id, durable: false, completion: Promise.resolve({ status: 'stored', id }) });
    } };
    const a = new ModelAProspectiveCollection(x.client, predictor, x.scope, () => new Date(x.now));
    const b = new ModelAProspectiveCollection(x.client, predictor, x.scope, () => new Date(x.now));
    await Promise.all([a.run(), b.run()]);
    assert.equal(calls, 3);
    await a.run(); assert.equal(calls, 3);
    const ledger = Object.fromEntries((await rows(x.client, 'SELECT match_id,state,reason FROM model_a_collection_ledger')).map(r => [r.match_id, r]));
    assert.equal(ledger.start.state, 'stored'); assert.equal(ledger.end.state, 'stored');
    assert.equal(ledger.early.reason, 'not_due'); assert.equal(ledger.late.reason, 'window_expired');
    assert.equal(ledger.cancel.reason, 'cancelled_or_postponed'); assert.equal(ledger.failure.reason, 'prediction_or_storage_error');
  } finally { x.close(); }
});
test('unconfirmed does not become stored without a persisted forecast or regenerate after restart', async () => {
  const x = await setup(); try {
    await x.insert('missing', 3); let calls = 0;
    const predictor = { async predict(request, options) { calls++; options.onProspectiveRecord({ status: 'accepted', id: 'missing', durable: true, completion: Promise.resolve({ status: 'stored', id: 'missing' }) }); } };
    await new ModelAProspectiveCollection(x.client, predictor, x.scope, () => new Date(x.now)).run();
    await new ModelAProspectiveCollection(x.client, predictor, x.scope, () => new Date(x.now + 1000)).run();
    assert.equal(calls, 1); const [r] = await rows(x.client, 'SELECT state,reason FROM model_a_collection_ledger');
    assert.equal(r.state, 'unconfirmed'); assert.equal(r.reason, 'forecast_missing_or_outside_window');
    const changed = { ...x.scope, seasons: ['other'] }; changed.manifestSha256 = collectionScopeManifest(changed).sha256;
    await assert.rejects(new ModelAProspectiveCollection(x.client, predictor, changed).run(), /scope_mismatch/);
  } finally { x.close(); }
});
test('disabled CLI does not load credentials or application', async () => {
  const { main } = require('../scripts/model-a-prospective-collect');
  await main({});
});

test('actual PredictionService records a sporting forecast without bookmaker odds', async () => {
  const { PredictionService } = require('../dist/services/PredictionService');
  const { DatabaseService } = require('../dist/db/DatabaseService');
  const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
  const { drainModelAProspective } = require('../dist/research/ModelAProspectiveRecorder');
  const previous = Object.fromEntries(['PLAYER_DATA_ENABLED','PLAYER_AVAILABILITY_ENABLED','MODEL_A_PROSPECTIVE_ENABLED','MODEL_A_PROSPECTIVE_STORAGE'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { PLAYER_DATA_ENABLED: 'false', PLAYER_AVAILABILITY_ENABLED: 'false', MODEL_A_PROSPECTIVE_ENABLED: 'true', MODEL_A_PROSPECTIVE_STORAGE: 'database' });
  const x = await setup();
  try {
    await x.insert('real', 6);
    const fixture = (await rows(x.client, 'SELECT * FROM matches'))[0];
    const params = new DixonColesModel().getParams(); params.attackParams = { home: .4, away: -.4 }; params.defenceParams = { home: 0, away: 0 };
    const wrapper = { execute: (sql, args) => x.client.execute({ sql, args }), get: async (sql, args) => (await x.client.execute({ sql, args })).rows[0] ?? null };
    const db = { getLatestModelParams: async () => ({ params }), getTeamsByIds: async ids => ids.map(team_id => ({ team_id, name: team_id, competition: 'Serie A' })),
      getMatchById: async () => fixture, getTeamHistoricalCoverageBatch: async () => ({}), getTeamScheduleInsightsBatch: async () => ({}), getPromotedTeamHistoryBatch: async () => ({}),
      appendModelAProspectiveForecast: record => DatabaseService.prototype.appendModelAProspectiveForecast.call(wrapper, record) };
    const service = new PredictionService(db, { getMatchDetails: async () => { throw Error('unexpected provider'); } });
    service.applyAdaptiveTuning = async () => null;
    service.getCalibrationProfile = async () => ({ calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }], nObservations: 0, byFamily: {}, learnedBlendWeights: {} });
    await new ModelAProspectiveCollection(x.client, service, x.scope).run();
    const ledgerRow = (await rows(x.client, 'SELECT state,reason FROM model_a_collection_ledger'))[0];
    assert.equal(ledgerRow.state, 'stored', JSON.stringify(ledgerRow));
    const [forecast] = await rows(x.client, 'SELECT payload_json FROM model_a_prospective_forecasts');
    const payload = JSON.parse(forecast.payload_json);
    assert.equal(payload.origin, 'prospective_a'); assert.deepEqual(payload.quotes, []); assert.ok(payload.stages.contextual.value); assert.equal(payload.selected, null);
    assert.equal(await drainModelAProspective(5000), true);
  } finally {
    x.close(); for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('reconciles a committed event after an interrupted claim and records kickoff change', async () => {
  const x = await setup(); try {
    await x.insert('restart', 6); let calls = 0;
    const predictor = { async predict() { calls++; throw Error('interrupted'); } };
    const collector = new ModelAProspectiveCollection(x.client, predictor, x.scope, () => new Date(x.now));
    await collector.run();
    const kickoff = (await rows(x.client, 'SELECT date FROM matches'))[0].date;
    const claim = (await rows(x.client, 'SELECT claim_id FROM model_a_collection_ledger'))[0].claim_id;
    await x.client.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES(?,?,?,?,?)', args: ['committed', 'restart', new Date(x.now + 1).toISOString(), kickoff, JSON.stringify({ origin: 'prospective_a', competition: 'Serie A', season: '2026/27', collection: { protocolId: x.scope.protocolId, manifestSha256: x.scope.manifestSha256, claimId: claim } })] });
    await collector.run();
    assert.equal(calls, 1); assert.equal((await rows(x.client, 'SELECT state FROM model_a_collection_ledger'))[0].state, 'stored');
    await x.client.execute({ sql: 'UPDATE matches SET date=? WHERE match_id=?', args: [new Date(x.now + 40 * 3600000).toISOString(), 'restart'] });
    await collector.run();
    const ledger = await rows(x.client, 'SELECT reason FROM model_a_collection_ledger ORDER BY kickoff_at');
    assert.equal(ledger[0].reason, 'kickoff_changed'); assert.equal(ledger[1].reason, 'not_due');
  } finally { x.close(); }
});

test('calendar scope stays bounded and unchanged observations do not rewrite the ledger', async () => {
  const x = await setup(); try {
    await x.insert('future', 30); await x.insert('outside', 60);
    await x.client.execute({ sql: 'INSERT INTO matches VALUES(?,?,?,?,?,?,?,?,?)', args: ['invalid', 'home', 'away', 'Serie A', '2026/27', 'bad', null, null, '{}'] });
    let now = x.now;
    const collector = new ModelAProspectiveCollection(x.client, { async predict() { throw Error('unexpected prediction'); } }, x.scope, () => new Date(now));
    const result = await collector.run(); assert.equal(result.invalidKickoffCount, 1); assert.equal(result.examined, 1);
    const before = await rows(x.client, 'SELECT match_id,updated_at FROM model_a_collection_ledger');
    now += 10000; await collector.run();
    assert.deepEqual(await rows(x.client, 'SELECT match_id,updated_at FROM model_a_collection_ledger'), before);
    const run = (await rows(x.client, 'SELECT invalid_kickoff_count FROM model_a_collection_runs ORDER BY started_at DESC'))[0];
    assert.equal(Number(run.invalid_kickoff_count), 1);
  } finally { x.close(); }
});

test('a different protocol claim cannot confirm an unacknowledged prediction', async () => {
  const x = await setup(); try {
    await x.insert('shared', 6);
    const other = { ...x.scope, protocolId: 'other' }; other.manifestSha256 = collectionScopeManifest(other).sha256;
    const predictor = { async predict() { throw Error('interrupted'); } };
    const one = new ModelAProspectiveCollection(x.client, predictor, x.scope, () => new Date(x.now));
    const two = new ModelAProspectiveCollection(x.client, predictor, other, () => new Date(x.now));
    await one.run(); await two.run();
    const claim = (await rows(x.client, "SELECT claim_id FROM model_a_collection_ledger WHERE protocol_id='test'"))[0].claim_id;
    const kickoff = (await rows(x.client, 'SELECT date FROM matches'))[0].date;
    await x.client.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES(?,?,?,?,?)', args: ['one', 'shared', new Date(x.now + 1).toISOString(), kickoff, JSON.stringify({ origin: 'prospective_a', competition: 'Serie A', season: '2026/27', collection: { protocolId: x.scope.protocolId, manifestSha256: x.scope.manifestSha256, claimId: claim } })] });
    await one.run(); await two.run();
    const ledger = await rows(x.client, 'SELECT protocol_id,state FROM model_a_collection_ledger ORDER BY protocol_id');
    assert.equal(ledger[0].state, 'unconfirmed'); assert.equal(ledger[1].state, 'stored');
  } finally { x.close(); }
});
test('priority paging and cooperative shutdown prevent new claims', async () => {
  const x = await setup(); try {
    for (let i = 0; i < 105; i++) await x.insert(`old-${String(i).padStart(3, '0')}`, -1);
    await x.insert('urgent', 2); let stop = false; const seen = [];
    const collector = new ModelAProspectiveCollection(x.client, { async predict(request) { seen.push(request.matchId); stop = true; throw Error('stopped'); } }, x.scope, () => new Date(x.now), () => stop);
    await collector.run(); assert.deepEqual(seen, ['urgent']);
    const ledger = await rows(x.client, 'SELECT match_id FROM model_a_collection_ledger'); assert.equal(ledger.length, 1);
    assert.equal((await rows(x.client, 'SELECT status FROM model_a_collection_runs'))[0].status, 'interrupted');
  } finally { x.close(); }
});

test('keyset pagination records every fixture and flags a kickoff moved outside scope', async () => {
  const x = await setup(); try {
    for (let i = 0; i < 105; i++) await x.insert(`f-${String(i).padStart(3, '0')}`, 30);
    const collector = new ModelAProspectiveCollection(x.client, { async predict() { throw Error('unexpected'); } }, x.scope, () => new Date(x.now));
    const result = await collector.run(); assert.equal(result.examined, 105);
    assert.equal((await rows(x.client, 'SELECT COUNT(*) AS n FROM model_a_collection_ledger'))[0].n, 105);
    await x.client.execute({ sql: 'UPDATE matches SET date=? WHERE match_id=?', args: [new Date(x.now + 60 * 3600000).toISOString(), 'f-000'] });
    await collector.run();
    assert.equal((await rows(x.client, "SELECT reason FROM model_a_collection_ledger WHERE match_id='f-000'"))[0].reason, 'kickoff_changed');
  } finally { x.close(); }
});

test('diagnostic budgets persist separate response and stored confirmation without changing the forecast', async () => {
  const x = await setup(); try {
    await x.insert('budget', 3); let tick = 0;
    const predictor = { async predict(request, options) {
      const match = (await rows(x.client, "SELECT date FROM matches WHERE match_id='budget'"))[0];
      await x.client.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES(?,?,?,?,?)', args: ['budget-id', request.matchId, new Date(x.now).toISOString(), match.date, JSON.stringify({ origin: 'prospective_a', collection: options.prospectiveCollection, competition: 'Serie A', season: '2026/27' })] });
      tick = 40; options.onProspectiveRecord({ status: 'pending', id: 'budget-id', durable: false, completion: Promise.resolve({ status: 'stored', id: 'budget-id' }) });
      await Promise.resolve(); tick = 80;
    } };
    const collector = new ModelAProspectiveCollection(x.client, predictor, x.scope, () => new Date(x.now), () => false, { predictMs: 50, confirmationMs: 30 }, () => tick);
    const result = await collector.run(); assert.equal(result.performance.alert, true);
    assert.equal(result.performance.predict.maxMs, 80); assert.equal(result.performance.confirmation.maxMs, 40);
    assert.equal(result.performance.confirmation.stored, 1); assert.equal(result.performance.confirmation.unconfirmed, 0);
    assert.equal(result.performance.predict.overBudget, 1); assert.equal(result.performance.confirmation.overBudget, 1);
    const [run] = await rows(x.client, 'SELECT performance_json FROM model_a_collection_runs');
    assert.deepEqual(JSON.parse(run.performance_json), result.performance);
    assert.equal((await rows(x.client, 'SELECT state FROM model_a_collection_ledger'))[0].state, 'stored');
  } finally { x.close(); }
});

test('recorder rejection remains visible after unconfirmed completion and restart', async () => {
  const x = await setup(); try {
    await x.insert('rejected', 3); let calls = 0;
    const predictor = { async predict(request, options) { calls++; options.onProspectiveRecord({ status: 'rejected', reason: 'queue_full', durable: false, completion: Promise.resolve({ status: 'unconfirmed' }) }); } };
    const collector = new ModelAProspectiveCollection(x.client, predictor, x.scope, () => new Date(x.now));
    await collector.run(); await collector.run(); assert.equal(calls, 1);
    const [ledger] = await rows(x.client, 'SELECT state,reason,recorder_status,recorder_reason FROM model_a_collection_ledger');
    assert.equal(ledger.state, 'unconfirmed'); assert.equal(ledger.reason, 'delivery_unconfirmed');
    assert.equal(ledger.recorder_status, 'rejected'); assert.equal(ledger.recorder_reason, 'queue_full');
  } finally { x.close(); }
});
test('recorder free-form errors are redacted from durable ledger', async () => {
  const x = await setup(); try {
    await x.insert('error', 3);
    const predictor = { async predict(request, options) { options.onProspectiveRecord({ status: 'error', reason: 'private://token/path', durable: false, completion: Promise.resolve({ status: 'unconfirmed' }) }); } };
    await new ModelAProspectiveCollection(x.client, predictor, x.scope, () => new Date(x.now)).run();
    const [ledger] = await rows(x.client, 'SELECT recorder_status,recorder_reason FROM model_a_collection_ledger');
    assert.equal(ledger.recorder_status, 'error'); assert.equal(ledger.recorder_reason, 'redacted');
  } finally { x.close(); }
});
