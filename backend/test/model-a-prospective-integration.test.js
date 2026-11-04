const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { PredictionService } = require('../dist/services/PredictionService');
const { DatabaseService } = require('../dist/db/DatabaseService');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');

const previous = { ...process.env }; process.env.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE='true';
after(() => { for (const name of ['MODEL_A_PROSPECTIVE_ENABLED', 'MODEL_A_PROSPECTIVE_ALLOW_VOLATILE', 'PLAYER_DATA_ENABLED', 'PLAYER_AVAILABILITY_ENABLED']) {
  if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
} });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(fn) { for (let i = 0; i < 100; i++) { const result = await fn(); if (result) return result; await wait(20); } throw Error('timed out'); }

test('live A integration persists immutable pre-match snapshots without changing probabilities or decisions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-a-store-'));
  const client = createClient({ url: `file:${path.join(dir, 'test.db')}` });
  t.after(async () => { client.close(); await wait(100); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await client.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
  process.env.PLAYER_DATA_ENABLED = 'false'; process.env.PLAYER_AVAILABILITY_ENABLED = 'false';
  const now = Date.now(), kickoff = new Date(now + 6 * 3600000).toISOString(), asOf = new Date(now - 1000).toISOString();
  const params = new DixonColesModel().getParams(); params.attackParams = { home: .4, away: -.4 }; params.defenceParams = { home: 0, away: 0 };
  const match = { match_id: 'prospective-test', home_team_id: 'home', away_team_id: 'away', competition: 'Test', season: '2026/27',
    date: kickoff, home_goals: null, away_goals: null };
  const db = { getLatestModelParams: async () => ({ params }),
    getTeamsByIds: async ids => ids.map(team_id => ({ team_id, name: team_id, competition: 'Test' })),
    getMatchById: async () => match, getTeamHistoricalCoverageBatch: async () => ({}), getTeamScheduleInsightsBatch: async () => ({}),
    appendModelAProspectiveForecast: record => DatabaseService.prototype.appendModelAProspectiveForecast.call({ execute: (sql, args) => client.execute({ sql, args }) }, record) };
  const service = new PredictionService(db, { getMatchDetails: async () => assert.fail('provider call') });
  service.applyAdaptiveTuning = async () => null;
  service.getCalibrationProfile = async () => ({ calibrationPoints: [{ x: 0, y: 0 }, { x: .5, y: .45 }, { x: 1, y: 1 }], nObservations: 200, byFamily: {}, learnedBlendWeights: {} });
  const request = { homeTeamId: 'home', awayTeamId: 'away', matchId: match.match_id, competition: 'Test', season: '2026/27' };
  const opts = { asOf, recordAudit: false, sharedOdds: { source: 'odds_api', capturedAt: new Date(now - 2000).toISOString(),
    odds: { over25: 2, under25: 1.9 }, bookmakerBySelection: { over25: 'Book', under25: 'Book' } } };
  const fixedRandom = Math.random; Math.random = () => .5; t.after(() => { Math.random = fixedRandom; });
  delete process.env.MODEL_A_PROSPECTIVE_ENABLED;
  const off = await service.predict(request, opts);
  assert.equal((await client.execute('SELECT COUNT(*) AS n FROM model_a_prospective_forecasts')).rows[0].n, 0);
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true';
  const on = await service.predict(request, opts);
  assert.deepEqual(on.probabilities, off.probabilities);
  assert.deepEqual(on.canonicalRecommendation, off.canonicalRecommendation);
  assert.deepEqual(on.bestBetDecision, off.bestBetDecision);
  const rows = await eventually(async () => { const x = await client.execute('SELECT * FROM model_a_prospective_forecasts'); return x.rows.length ? x.rows : null; });
  const reopened = createClient({ url: `file:${path.join(dir, 'test.db')}` });
  try { assert.equal((await reopened.execute('SELECT COUNT(*) AS n FROM model_a_prospective_forecasts')).rows[0].n, 1); }
  finally { reopened.close(); }
  const saved = JSON.parse(rows[0].payload_json);
  assert.equal(saved.stages.contextual.value.over, off.canonicalRecommendation.probabilities.raw.over25);
  assert.equal(saved.stages.ensembleRaw.value, null); assert.equal(saved.stages.marketBlended.value, null);
  assert.equal(saved.stages.calibrated.value.over, service.engine.calibrate(saved.stages.contextual.value.over, [{ x: 0, y: 0 }, { x: .5, y: .45 }, { x: 1, y: 1 }], 200));
  assert.equal(saved.quotes[0].updatedAt, null); assert.equal('homeGoals' in saved, false);
  assert.ok(Date.parse(saved.capturedAt) < Date.parse(saved.kickoffAt));
  await service.predict(request, opts);
  await eventually(async () => (await client.execute('SELECT COUNT(*) AS n FROM model_a_prospective_forecasts')).rows[0].n === 2);
  await assert.rejects(client.execute("UPDATE model_a_prospective_forecasts SET payload_json='{}'"), /append-only/);
  await assert.rejects(client.execute('DELETE FROM model_a_prospective_forecasts'), /append-only/);
  const originalError = console.error; let logged = '';
  console.error = (...args) => { logged = args.join(' '); };
  try {
    db.appendModelAProspectiveForecast = async () => { throw Error('storage offline'); };
    const failedWrite = await service.predict(request, opts);
    assert.deepEqual(failedWrite.probabilities, off.probabilities);
    assert.deepEqual(failedWrite.canonicalRecommendation, off.canonicalRecommendation);
    await eventually(() => logged); assert.match(logged, /recording failed.*storage offline/);
  } finally { console.error = originalError; }
  match.date = new Date(now - 1000).toISOString();
  await service.predict(request, opts); await wait(30);
  assert.equal((await client.execute('SELECT COUNT(*) AS n FROM model_a_prospective_forecasts')).rows[0].n, 2);
});

test('storage failure is reported asynchronously and never escapes the recorder', async () => {
  const { scheduleModelAProspective } = require('../dist/research/ModelAProspectiveRecorder');
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true';
  const now = Date.now(), asOf = new Date(now - 1000).toISOString(); let warning;
  const original = console.error; console.error = (...args) => { warning = args.join(' '); };
  try {
    scheduleModelAProspective({ appendModelAProspectiveForecast: async () => { throw Error('isolated storage failed'); } }, {
      match: { match_id: 'm', home_team_id: 'h', away_team_id: 'a', home_goals: null, away_goals: null, date: new Date(now + 3600000).toISOString() },
      request: { matchId: 'm', homeTeamId: 'h', awayTeamId: 'a' }, asOf, origin: 'direct_a',
      model: { version: 'A', codeHash: '', configHash: '', stateHash: '' }, contextual: {}, calibrated: null, decision: {}, selected: null,
      modelParametersHash: '', calibration: { profileHash: '', globalSamples: 0, overSamples: null, underSamples: null,
        overCurve: 'unavailable', underCurve: 'unavailable' },
    });
    await eventually(() => warning); assert.match(warning, /recording failed.*isolated storage failed/);
  } finally { console.error = original; }
});
