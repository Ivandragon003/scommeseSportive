const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { PredictionService } = require('../dist/services/PredictionService.js');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel.js');
const { predictionConfig } = require('../dist/config/predictionConfig.js');
const {
  calibrationPayloadHash, calibrationProfileFingerprint, decodeCalibrationProfile,
} = require('../dist/services/CalibrationProfileCache.js');

const DAY = 86400000;
const START = Date.parse('2025-08-01T12:00:00Z');
const cutoff = (days) => new Date(START + days * DAY);
const fixtures = () => Array.from({ length: 90 }, (_, index) => ({
  match_id: `m-${index}`, home_team_id: `t-${index % 6}`, away_team_id: `t-${(index + 1) % 6}`,
  date: new Date(START + index * DAY).toISOString(), competition: 'Serie A', season: '2025/26',
  home_goals: index % 4, away_goals: index % 3, home_xg: 1.5, away_xg: 1.1,
  home_shots: 12, away_shots: 10, home_shots_on_target: 5, away_shots_on_target: 3,
  home_yellow_cards: 2, away_yellow_cards: 3, home_red_cards: 0, away_red_cards: 0,
}));

function sharedStore(rows = fixtures()) {
  const cache = new Map();
  const odds = Object.fromEntries(rows.map((row) => [row.match_id, { odds: { homeWin: 2.1, draw: 3.3, awayWin: 3.7 } }]));
  const db = {
    getMatches: async () => structuredClone(rows),
    getHistoricalOddsDetailMap: async () => structuredClone(odds),
    getCalibrationProfileCache: async (key) => cache.get(key) ?? null,
    saveCalibrationProfileCache: async (key, _competition, payloadJson, payloadSha256) => {
      cache.set(key, { payloadJson, payloadSha256 });
    },
  };
  const service = () => new PredictionService(db, { getMatchDetails: async () => { throw new Error('Unexpected provider call'); } });
  return { cache, db, service, rows, odds };
}

function stubFits(t) {
  let fits = 0;
  const params = new DixonColesModel().getParams();
  t.mock.method(DixonColesModel.prototype, 'fitModel', (past) => {
    fits++;
    return { ...structuredClone(params), homeAdvantage: past.reduce((sum, row) => sum + row.homeGoals, 0) / (past.length * 10) };
  });
  t.mock.method(DixonColesModel.prototype, 'computeFullProbabilities', function () {
    return { flatProbabilities: { homeWin: 0.4 + this.getParams().homeAdvantage, draw: 0.25, awayWin: 0.3 } };
  });
  return () => fits;
}

test('deployment preparation verifies persisted hits in a fresh service for every league', async (t) => {
  stubFits(t);
  const { warmAndVerify } = require('../scripts/warm-calibration');
  const store = sharedStore();
  const originalRead = store.db.getCalibrationProfileCache;
  const profiles = await warmAndVerify(store.db, store.service, ['Serie A'], () => {});
  assert.equal(profiles.length, 1);
  assert.ok(profiles[0].observations > 0);
  assert.equal(store.db.getCalibrationProfileCache, originalRead);
  assert.equal(store.cache.size, 1);
});

test('deployment preparation fails if storage is unavailable even when live calculation succeeds', async (t) => {
  stubFits(t);
  const { warmAndVerify } = require('../scripts/warm-calibration');
  const store = sharedStore();
  store.db.saveCalibrationProfileCache = async () => {};
  const originalRead = store.db.getCalibrationProfileCache;
  await assert.rejects(warmAndVerify(store.db, store.service, ['Serie A'], () => {}), /could not all be reused/);
  assert.equal(store.db.getCalibrationProfileCache, originalRead);
});

test('a restarted service reuses the identical real calibration without fitting; force refresh still rebuilds', async (t) => {
  const store = sharedStore();
  let fits = 0;
  const original = DixonColesModel.prototype.fitModel;
  t.mock.method(DixonColesModel.prototype, 'fitModel', function (...args) {
    fits++;
    return original.apply(this, args);
  });
  const cold = await store.service().getCalibrationProfile('Serie A', false, cutoff(100));
  assert.ok(fits > 0);
  const afterCold = fits;
  assert.equal(store.cache.size, 1);
  const restarted = store.service();
  const cached = await restarted.getCalibrationProfile('Serie A', false, cutoff(101));
  assert.deepEqual(cached, cold, 'different clocks with identical available cohorts must produce the identical profile');
  assert.equal(fits, afterCold, 'a process restart must not repeat historical fits');
  const rebuilt = await restarted.getCalibrationProfile('Serie A', true, cutoff(101));
  assert.deepEqual(rebuilt, cold, 'persisted and freshly recomputed probabilities/weights must be identical');
  assert.ok(fits > afterCold);
});

test('data corrections, real entry odds, settings, competitions and eligible-result cutoffs invalidate persisted profiles', async (t) => {
  const fits = stubFits(t);
  const store = sharedStore();
  await store.service().getCalibrationProfile('Serie A', false, cutoff(70));
  const baselineFits = fits();
  store.rows[80].home_goals = 99;
  store.odds['m-80'].odds.homeWin = 9;
  await store.service().getCalibrationProfile('Serie A', false, cutoff(70));
  assert.equal(fits(), baselineFits, 'future labels/odds must not affect or invalidate an earlier cohort');
  store.rows[50].home_goals++;
  await store.service().getCalibrationProfile('Serie A', false, cutoff(70));
  assert.ok(fits() > baselineFits);
  let previous = fits();
  store.odds['m-50'].odds.homeWin = 2.3;
  await store.service().getCalibrationProfile('Serie A', false, cutoff(70));
  assert.ok(fits() > previous);
  previous = fits();
  await store.service().getCalibrationProfile('Serie A', false, cutoff(71));
  assert.ok(fits() > previous, 'a newly available result must rebuild');
  previous = fits();
  const priorScale = predictionConfig.model.homeAdvantageScale;
  try {
    predictionConfig.model.homeAdvantageScale = priorScale + 0.01;
    await store.service().getCalibrationProfile('Serie A', false, cutoff(70));
    assert.ok(fits() > previous, 'evaluated environment configuration participates in the signature');
  } finally { predictionConfig.model.homeAdvantageScale = priorScale; }
  previous = fits();
  await store.service().getCalibrationProfile('La Liga', false, cutoff(70));
  assert.ok(fits() > previous, 'profiles cannot leak across competitions');
});

test('same-day cohorts respect the exact two-hour availability boundary', async (t) => {
  const fits = stubFits(t);
  const store = sharedStore();
  const kickoff = START + 70 * DAY;
  const before = await store.service().getCalibrationProfile('Serie A', false, new Date(kickoff + 2 * 3600000 - 1));
  const previous = fits();
  const after = await store.service().getCalibrationProfile('Serie A', false, new Date(kickoff + 2 * 3600000));
  assert.ok(fits() > previous);
  assert.ok(after.nObservations > before.nObservations);
});

test('damaged profiles and unavailable persistence preserve the complete calculation', async (t) => {
  const fits = stubFits(t);
  const store = sharedStore();
  const baseline = await store.service().getCalibrationProfile('Serie A', false, cutoff(100));
  const previous = fits();
  const key = [...store.cache.keys()][0];
  const entry = store.cache.get(key);
  store.cache.set(key, { ...entry, payloadJson: entry.payloadJson.replace('calibrationPoints', 'brokenPoints') });
  assert.deepEqual(await store.service().getCalibrationProfile('Serie A', false, cutoff(100)), baseline);
  assert.ok(fits() > previous);
  store.db.getCalibrationProfileCache = async () => { throw new Error('Cache temporarily unavailable'); };
  store.db.saveCalibrationProfileCache = async () => { throw new Error('Cache temporarily unavailable'); };
  assert.deepEqual(await store.service().getCalibrationProfile('Serie A', false, cutoff(100)), baseline);
});

test('nightly warmup refreshes previously loaded inputs before publishing profiles', async (t) => {
  stubFits(t);
  const store = sharedStore();
  const service = store.service();
  const before = await service.getCalibrationProfile('Serie A');
  store.rows[60].home_goals++;
  const warmed = await service.warmCalibrationProfiles(['Serie A', 'Serie A']);
  assert.equal(warmed.length, 1);
  const actual = await service.getCalibrationProfile('Serie A');
  assert.notDeepEqual(actual, before);
  assert.equal(store.cache.size, 2);
  assert.deepEqual(await store.service().getCalibrationProfile('Serie A'), actual);
});

test('cache decoder rejects a valid checksum with invalid curves or sample counts', () => {
  const identity = { calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }], nObservations: 0, byFamily: {}, learnedBlendWeights: {} };
  for (const value of [null, { ...identity, nObservations: -1 }, { ...identity, calibrationPoints: [{ x: 0, y: 0.8 }, { x: 1, y: 0.2 }] }, { ...identity, learnedBlendWeights: { goals: { modelWeight: 2, sampleSize: 10 } } }]) {
    const payload = JSON.stringify(value);
    assert.equal(decodeCalibrationProfile(payload, calibrationPayloadHash(payload)), null);
  }
  const payload = JSON.stringify(identity);
  assert.deepEqual(decodeCalibrationProfile(payload, calibrationPayloadHash(payload)), identity);
  assert.notEqual(calibrationProfileFingerprint({ result: 1 }, { scale: 0.5 }), calibrationProfileFingerprint({ result: 2 }, { scale: 0.5 }));
});

test('warmup prepares bounded prematch cutoffs for recent replays without leaking results', async (t) => {
  const fits = stubFits(t);
  const store = sharedStore();
  const warmed = await store.service().warmCalibrationProfiles(['Serie A'], { recentReplayLimit: 3 });
  assert.equal(warmed[0].replayProfiles, 3);
  const afterWarm = fits();
  for (const row of store.rows.slice(-3)) {
    const profile = await store.service().getCalibrationProfile('Serie A', false, new Date(row.date));
    assert.ok(profile.nObservations > 0);
  }
  assert.equal(fits(), afterWarm, 'new services reuse replay profiles without fitting');
  store.rows[89].home_goals++;
  await store.service().getCalibrationProfile('Serie A', false, new Date(store.rows[89].date));
  assert.equal(fits(), afterWarm, 'the target outcome is excluded at its prematch cutoff');
  await assert.rejects(store.service().warmCalibrationProfiles(['Serie A'], { recentReplayLimit: 21 }), /recentReplayLimit/);
});

test('deployment verification includes every prepared replay profile', async (t) => {
  stubFits(t);
  const { warmAndVerify } = require('../scripts/warm-calibration');
  const store = sharedStore();
  const logs = [];
  const profiles = await warmAndVerify(store.db, store.service, ['Serie A'], (line) => logs.push(JSON.parse(line)), { recentReplayLimit: 3 });
  assert.equal(profiles[0].replayProfiles, 3);
  assert.equal(logs.at(-1).profiles, 4);
});

test('separate processes reject changed implementation code while sharing identical LF/CRLF deployments', () => {
  const root = mkdtempSync(join(tmpdir(), 'calibration-code-'));
  const directory = join(root, 'services');
  const cacheModule = join(directory, 'CalibrationProfileCache.js');
  const modelModule = join(root, 'model.js');
  mkdirSync(directory);
  try {
    writeFileSync(cacheModule, readFileSync(join(__dirname, '../dist/services/CalibrationProfileCache.js')));
    writeFileSync(modelModule, 'module.exports = 1;\n');
    const fingerprint = () => execFileSync(process.execPath, ['-e',
      'process.stdout.write(require(process.argv[1]).calibrationProfileFingerprint([], {}));', cacheModule,
    ], { encoding: 'utf8' });
    const original = fingerprint();
    writeFileSync(modelModule, 'module.exports = 1;\r\n');
    assert.equal(fingerprint(), original, 'checkout line endings must not prevent sharing identical deployed code');
    writeFileSync(modelModule, 'module.exports = 2;\n');
    assert.notEqual(fingerprint(), original, 'changed implementation must invalidate without a manual version bump');
  } finally {
    unlinkSync(modelModule);
    unlinkSync(cacheModule);
    rmdirSync(directory);
    rmdirSync(root);
  }
});

test('cache reads recover interrupted sockets without changing keys or stored probabilities', async () => {
  const { DatabaseService } = require('../dist/db/DatabaseService.js');
  for (const code of ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']) {
    const db = Object.create(DatabaseService.prototype);
    const calls = [];
    db.get = async (sql, args) => {
      calls.push({ sql, args });
      if (calls.length === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('closed'), { code }) });
      return { payload_json: 'unchanged-profile', payload_sha256: 'unchanged-checksum' };
    };
    assert.deepEqual(await db.getCalibrationProfileCache('same-key'), {
      payloadJson: 'unchanged-profile', payloadSha256: 'unchanged-checksum',
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  }
});

test('cache read retries are bounded and do not retry SQL, authorization or unknown failures', async () => {
  const { DatabaseService } = require('../dist/db/DatabaseService.js');
  for (const code of ['UND_ERR_SOCKET', 'SQLITE_ERROR', 'UNAUTHORIZED', undefined]) {
    const db = Object.create(DatabaseService.prototype);
    let calls = 0;
    const failure = Object.assign(new Error('read failed'), { code });
    db.get = async () => { calls++; throw failure; };
    await assert.rejects(db.getCalibrationProfileCache('key'), (error) => error === failure);
    assert.equal(calls, code === 'UND_ERR_SOCKET' ? 3 : 1);
  }
});

test('libSQL cache migration is additive and cache writes stay bounded without touching match history', async () => {
  process.env.TURSO_DATABASE_URL = 'file::memory:';
  process.env.TURSO_AUTH_TOKEN = 'test-token';
  const { DatabaseService } = require('../dist/db/DatabaseService.js');
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute('CREATE TABLE matches (match_id TEXT PRIMARY KEY)');
    await client.execute("INSERT INTO matches VALUES ('preserved')");
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations/014_runtime_calibration_cache.sql'), 'utf8'));
    const db = Object.create(DatabaseService.prototype);
    db.db = client;
    db.initPromise = Promise.resolve();
    assert.equal(await db.getCalibrationProfileCache('missing'), null);
    for (let index = 0; index < 130; index++) {
      await db.saveCalibrationProfileCache(String(index).padStart(3, '0'), 'serie a', '{"value":1}', 'checksum');
    }
    assert.equal(Number((await client.execute('SELECT COUNT(*) AS n FROM runtime_calibration_profiles')).rows[0].n), 128);
    assert.deepEqual((await client.execute('SELECT * FROM matches')).rows, [{ match_id: 'preserved' }]);
    assert.deepEqual(await db.getCalibrationProfileCache('129'), { payloadJson: '{"value":1}', payloadSha256: 'checksum' });
    await db.saveCalibrationProfileCache('129', 'serie a', '{"value":2}', 'changed');
    assert.deepEqual(await db.getCalibrationProfileCache('129'), { payloadJson: '{"value":2}', payloadSha256: 'changed' });
  } finally { client.close(); }
});

test('the warmup API validates league requests and returns useful failures without running a provider', async () => {
  const { createApiRouter } = require('../dist/api/routes.js');
  let called = 0;
  const service = {
    warmCalibrationProfiles: async (competitions) => {
      called++;
      if (competitions.includes('La Liga')) throw new Error('Warmup calculation failed');
      return competitions.map((competition) => ({ competition, observations: 120 }));
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ db: {}, svc: service }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/model/calibration/warm`;
    const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const invalid = await post({ competitions: ['Invalid league'] });
    assert.equal(invalid.status, 400);
    assert.equal(called, 0);
    assert.equal((await post({ competitions: ['Serie A'], recentReplayLimit: 21 })).status, 400);
    assert.equal(called, 0);
    const valid = await post({ competitions: ['Serie A'] });
    assert.equal(valid.status, 200);
    assert.deepEqual((await valid.json()).data, [{ competition: 'Serie A', observations: 120 }]);
    const failed = await post({ competitions: ['La Liga'] });
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).success, false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
