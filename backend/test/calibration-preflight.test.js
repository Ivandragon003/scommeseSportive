const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const {
  loadRuntime, readOnlyDatabase, calibrationInputs, preflightCalibration,
} = require('../scripts/calibration-preflight');

const runtime = loadRuntime();
const asOf = new Date('2026-11-06T00:00:00Z');
const row = (id, date = '2026-11-01T12:00:00Z') => ({
  match_id: id, home_team_id: 'home', away_team_id: 'away', date,
  competition: 'Serie A', home_goals: 0, away_goals: 1, home_xg: 0, away_xg: 1.1,
});
const identity = {
  calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }], nObservations: 300,
  byFamily: { goals: { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], nObservations: 120 } },
  learnedBlendWeights: {},
};
function store(rows = [row('played')]) {
  const cache = new Map();
  let writes = 0;
  const db = {
    getMatches: async () => rows,
    getHistoricalOddsDetailMap: async () => ({ played: { odds: { homeWin: 2.1, awayWin: 3.5 } } }),
    getCalibrationProfileCache: async (key) => cache.get(key) ?? null,
    saveCalibrationProfileCache: async () => { writes++; throw new Error('Forbidden write'); },
  };
  return { db, cache, rows, writes: () => writes };
}
function put(cache, key, value = identity) {
  const payloadJson = JSON.stringify(value);
  cache.set(key, { payloadJson, payloadSha256: runtime.cache.calibrationPayloadHash(payloadJson) });
}

test('preflight reports exact miss, hit and invalid without fitting or writing', async (t) => {
  t.mock.method(runtime.PredictionService.prototype, 'loadCalibrationProfile', () => { throw new Error('Forbidden calibration'); });
  const fixture = store();
  const miss = await preflightCalibration(fixture.db, ['Serie A'], { asOf });
  assert.equal(miss.competitions[0].status, 'MISS');
  assert.equal(miss.ready, false);
  put(fixture.cache, miss.competitions[0].cacheKey);
  const hit = await preflightCalibration(fixture.db, ['Serie A'], { asOf });
  assert.equal(hit.ready, true);
  assert.equal(hit.competitions[0].status, 'HIT');
  assert.deepEqual(hit.competitions[0].byFamily, { goals: 120 });
  fixture.cache.get(hit.competitions[0].cacheKey).payloadSha256 = 'corrupt';
  assert.equal((await preflightCalibration(fixture.db, ['Serie A'], { asOf })).competitions[0].status, 'INVALID');
  assert.equal(fixture.writes(), 0);
  assert.deepEqual([hit.writes, hit.fits, hit.providerRequests], [0, 0, 0]);
});

test('preflight key is accepted unchanged by the actual runtime calibration loader', async (t) => {
  const fixture = store();
  const result = await preflightCalibration(fixture.db, ['Serie A'], { asOf });
  put(fixture.cache, result.competitions[0].cacheKey);
  // No constructor: prospective recovery and provider construction cannot run.
  const service = Object.create(runtime.PredictionService.prototype);
  Object.assign(service, {
    db: fixture.db, calibrationGenerations: new Map(), calibrationCache: new Map(),
    calibrationInputs: new Map(), calibrationInputLoads: new Map(), calibrationLoads: new Map(),
  });
  const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
  t.mock.method(DixonColesModel.prototype, 'fitModel', () => { throw new Error('Unexpected fit'); });
  assert.deepEqual(await service.loadCalibrationProfile('Serie A', false, asOf), identity);
  assert.equal(fixture.writes(), 0);
});

test('full-row fields, order, selected quote order, configuration and two-hour cutoff invalidate independently', async () => {
  const fixture = store([row('played'), row('second'), row('boundary', '2026-11-05T22:00:00Z')]);
  const key = async (cutoff = asOf) => (await preflightCalibration(fixture.db, ['Serie A'], { asOf: cutoff })).competitions[0].cacheKey;
  const original = await key();
  assert.notEqual(await key(new Date(asOf.getTime() - 1)), original);
  fixture.rows[0].source = 'supplemented';
  const changedField = await key();
  assert.notEqual(changedField, original, 'even shared nonnumeric row fields participate');
  fixture.rows.reverse();
  const changedOrder = await key();
  assert.notEqual(changedOrder, changedField);
  fixture.db.getHistoricalOddsDetailMap = async () => ({ played: { odds: { awayWin: 3.5, homeWin: 2.1 } } });
  assert.notEqual(await key(), changedOrder, 'JSON object property ordering remains part of the contract');
  const prior = runtime.predictionConfig.model.homeAdvantageScale;
  try {
    runtime.predictionConfig.model.homeAdvantageScale = prior + 0.01;
    assert.notEqual(await key(), changedOrder);
  } finally { runtime.predictionConfig.model.homeAdvantageScale = prior; }
});

test('target/future labels remain outside the calibration cohort and zero is retained', () => {
  const inputs = calibrationInputs(runtime, 'Serie A', [row('played'), row('future', '2026-11-07T12:00:00Z')], {}, asOf);
  assert.deepEqual(inputs.rows.map((entry) => entry.match_id), ['played']);
  assert.equal(inputs.rows[0].home_xg, 0);
  assert.deepEqual(inputs.odds, [['played', null]]);
});

test('read errors and identity profiles with no observations cannot authorize predictions', async () => {
  const fixture = store();
  const miss = await preflightCalibration(fixture.db, ['Serie A'], { asOf });
  put(fixture.cache, miss.competitions[0].cacheKey, { ...identity, nObservations: 0 });
  const hit = await preflightCalibration(fixture.db, ['Serie A'], { asOf });
  assert.equal(hit.competitions[0].status, 'HIT');
  assert.equal(hit.ready, false);
  fixture.db.getHistoricalOddsDetailMap = async () => { throw new Error('Sensitive database endpoint'); };
  const failure = await preflightCalibration(fixture.db, ['Serie A'], { asOf });
  assert.equal(failure.competitions[0].status, 'ERROR');
  assert.ok(!JSON.stringify(failure).includes('Sensitive'));
});

test('read-only facade executes actual SQL on an isolated database and rejects all writes', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute('CREATE TABLE runtime_calibration_profiles (cache_key TEXT, payload_json TEXT, payload_sha256 TEXT)');
    const db = readOnlyDatabase(client, runtime);
    assert.equal(await db.getCalibrationProfileCache('absent'), null);
    await assert.rejects(db.saveCalibrationProfileCache('key', 'serie a', '{}', 'hash'), /SELECT only/);
    await assert.rejects(db.db.execute('SELECT 1; DELETE FROM runtime_calibration_profiles'), /SELECT only/);
    assert.equal((await client.execute('SELECT COUNT(*) AS n FROM runtime_calibration_profiles')).rows[0].n, 0);
  } finally { client.close(); }
});

test('strict prediction service rejects misses, corruption, cache errors and refresh without a fit', async (t) => {
  const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
  t.mock.method(DixonColesModel.prototype, 'fitModel', () => { throw new Error('Unexpected fit'); });
  const fixture = store();
  const service = new runtime.PredictionService(fixture.db, {
    getMatchDetails: async () => { throw new Error('Unexpected provider'); },
  }, { allowCalibrationRebuild: false });
  const rejectReason = (reason) => (error) => error.code === 'CALIBRATION_PROFILE_UNAVAILABLE' && error.reason === reason;
  await assert.rejects(service.getCalibrationProfile('Serie A', false, asOf), rejectReason('cache_miss'));
  const initial = await preflightCalibration(fixture.db, ['Serie A'], { asOf });
  put(fixture.cache, initial.competitions[0].cacheKey);
  assert.deepEqual(await service.getCalibrationProfile('Serie A', false, asOf), identity);
  fixture.rows[0].home_goals++;
  await assert.rejects(service.getCalibrationProfile('Serie A', false, asOf), rejectReason('cache_miss'));
  fixture.rows[0].home_goals--;
  fixture.cache.get(initial.competitions[0].cacheKey).payloadSha256 = 'invalid';
  await assert.rejects(service.getCalibrationProfile('Serie A', false, asOf), rejectReason('invalid_profile'));
  fixture.db.getCalibrationProfileCache = async () => { throw new Error('Private endpoint'); };
  await assert.rejects(service.getCalibrationProfile('Serie A', false, asOf), rejectReason('cache_read_error'));
  await assert.rejects(service.getCalibrationProfile('Serie A', true, asOf), rejectReason('refresh_forbidden'));
  fixture.db.getHistoricalOddsDetailMap = async () => { throw new Error('Private odds endpoint'); };
  await assert.rejects(service.getCalibrationProfile('Serie A', false, asOf), rejectReason('historical_odds_read_error'));
  assert.equal(fixture.writes(), 0);
});
