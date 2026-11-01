const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PredictionJobService, PredictionJobBusyError } = require('../dist/services/PredictionJobService');
const { createApiRouter } = require('../dist/api/routes');
const { createPasswordHash, createSharedAdminAuth } = require('../dist/security/SharedAdminAuth');
const prediction = require('./fixtures/format-prediction.input');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const success = (data = { probabilities: [.25, .35, .4] }) => ({ responseStatus: 200, response: { success: true, data } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('create reserves a single slot, preserves the complete mutable input, and starts only when signalled', async () => {
  const scheduled = [], calls = [], input = { matchId: 'm1', bankroll: 1234, extra: { keep: false }, asOf: 'unchanged' };
  const service = new PredictionJobService({ schedule: (work) => scheduled.push(work) });
  const job = service.create('owner', input, async (body) => { calls.push(structuredClone(body)); body.extra.keep = true; return success(); });
  assert.deepEqual(job, { id: job.id, status: 'RUNNING' }); assert.match(job.id, /^[a-f0-9-]{36}$/);
  assert.equal(calls.length, 0); assert.equal(scheduled.length, 0);
  service.start(job.id); service.start(job.id); assert.equal(scheduled.length, 1);
  scheduled[0](); await flush();
  assert.deepEqual(calls, [input]); assert.equal(input.extra.keep, false);
  assert.deepEqual(service.get('owner', job.id), { id: job.id, status: 'COMPLETED', ...success() });
});

test('only identical complete inputs and namespace share the active operation', async () => {
  const pending = deferred(), service = new PredictionJobService(); let calls = 0;
  const input = { matchId: 'm1', odds: { home: 2, away: 3 }, optional: false };
  const first = service.create('owner', input, async () => { calls++; return pending.promise; });
  const same = service.create('owner', structuredClone(input), async () => { throw new Error('Duplicate work'); });
  assert.equal(first.id, same.id);
  for (const [owner, body] of [['other', input], ['owner', { ...input, optional: true }], ['owner', { ...input, asOf: 'new-field' }],
    ['owner', { optional: false, odds: { away: 3, home: 2 }, matchId: 'm1' }]]) {
    assert.throws(() => service.create(owner, body, async () => success()), PredictionJobBusyError);
  }
  assert.equal(service.get('other', first.id), null);
  service.start(first.id); service.start(same.id); await flush(); assert.equal(calls, 1);
  pending.resolve(success()); await flush(); assert.equal(service.get('owner', first.id).status, 'COMPLETED');
});

test('elapsed time never frees the slot while A is still computing; result TTL starts at completion', async () => {
  const pending = deferred(); let now = 0;
  const service = new PredictionJobService({ clock: () => now, resultTtlMs: 100 });
  const job = service.create('owner', {}, () => pending.promise); service.start(job.id); await flush();
  now = 10000; assert.equal(service.get('owner', job.id).status, 'RUNNING');
  assert.throws(() => service.create('owner', { different: true }, async () => success()), PredictionJobBusyError);
  pending.resolve(success()); await flush();
  now = 10099; assert.equal(service.get('owner', job.id).status, 'COMPLETED');
  const view = service.get('owner', job.id); view.response.data.probabilities[0] = 99;
  assert.equal(service.get('owner', job.id).response.data.probabilities[0], .25);
  now = 10100; assert.equal(service.get('owner', job.id), null);
});

test('completed response cache is bounded and a fresh service reports lost jobs explicitly', async () => {
  let now = 0; const service = new PredictionJobService({ clock: () => now, maxResults: 2 }), ids = [];
  for (let index = 0; index < 3; index++) {
    const job = service.create('owner', { index }, async () => success(index)); ids.push(job.id);
    service.start(job.id); await flush(); now++;
  }
  assert.equal(service.get('owner', ids[0]), null);
  assert.equal(service.get('owner', ids[1]).response.data, 1);
  assert.equal(new PredictionJobService().get('owner', ids[2]), null);
});

test('unexpected transport-envelope exceptions do not leak messages or leave an active slot', async () => {
  const service = new PredictionJobService();
  const job = service.create('owner', {}, async () => { throw new Error('https://example.invalid/?token=do-not-output'); });
  service.start(job.id); await flush();
  const result = service.get('owner', job.id);
  assert.equal(result.status, 'FAILED'); assert.equal(result.responseStatus, 500);
  assert.equal(JSON.stringify(result).includes('do-not-output'), false);
  assert.doesNotThrow(() => service.create('owner', { retry: true }, async () => success()));
});

function recorded(action = 'BET') {
  const at = '2026-11-01T10:00:00Z';
  return { id: 'recorded-a', matchId: 'm1', family: 'A', portfolioId: 'shadow_A', createdAt: at, action,
    modelVersion: 'operational-a', betId: action === 'BET' ? 'existing-bet' : null, betStakeCents: 1690, betPlacedAt: at,
    reason: action === 'ABSTAIN' ? 'virtual_exposure_limit' : null,
    snapshot: { quote: { odds: 2, bookmaker: 'Actual fixture bookmaker', source: 'odds_api' } },
    recommendationPacket: { selected: action === 'BET' ? { selection: 'homeWin', bookmakerOdds: 2 } : null,
      decisionStatus: action === 'BET' ? 'RECOMMENDED' : 'NO_BET', ranked: [], model: { source: 'PredictionService' } } };
}

async function fixture(t, options = {}) {
  const calls = [], scheduled = [], reads = [];
  const deny = (_target, key) => { throw new Error(`Unexpected DB operation: ${String(key)}`); };
  const research = new Proxy({ listLegacyDecisionViews: async (query) => { reads.push(query); return []; } }, { get: (target, key) => key in target ? target[key] : deny(target, key) });
  const recommendations = new Proxy({ listDecisionViews: async () => options.recorded ? [options.recorded] : [] }, { get: (target, key) => key in target ? target[key] : deny(target, key) });
  const db = new Proxy({ research, recommendations }, { get: (target, key) => key in target ? target[key] : deny(target, key) });
  const svc = { predict: async (body) => { calls.push(structuredClone(body)); if (options.predict) return options.predict(body);
    return { ...structuredClone(prediction), canonicalRecommendation: { selected: { selection: 'awayWin' } } }; } };
  const jobs = new PredictionJobService(options.manualSchedule ? { schedule: (work) => scheduled.push(work) } : {});
  const app = express(); app.use(express.json());
  if (options.auth) {
    const sessions = new Map();
    const auth = createSharedAdminAuth({ enabled: true, passwordHash: await createPasswordHash('unit-example'),
      sharedDataUserId: 'owner', secureCookies: false, sessionTtlMs: 60000,
      maxLoginAttempts: 3, loginWindowMs: 60000, maxTrackedLoginIps: 10,
      allowedOrigins: new Set(['https://localhost']), sessionStore: {
        createAdminSession: async (hash, expiresAt) => { sessions.set(hash, { expiresAt }); },
        getAdminSession: async (hash) => sessions.get(hash) ?? null, deleteAdminSession: async (hash) => { sessions.delete(hash); },
        purgeExpiredAdminSessions: async () => {},
      } });
    app.use('/api', auth.publicRouter); app.use('/api', auth.requireAdmin);
  } else app.use((req, res, next) => { res.locals.sharedDataUserId = req.get('x-test-owner') || 'owner'; next(); });
  app.use('/api', createApiRouter({ db, svc, predictionJobs: jobs }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://localhost', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) });
    const text = await response.text();
    return { status: response.status, cache: response.headers.get('cache-control'), headers: response.headers,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  };
  return { calls, reads, jobs, scheduled, request, base };
}

test('HTTP accepts immediately, shares one operation, and finish plus close starts A only once', async (t) => {
  const pending = deferred(), f = await fixture(t, { manualSchedule: true, predict: () => pending.promise });
  const input = { homeTeamId: 'h', awayTeamId: 'a', bookmakerOdds: { home: 2.2 }, arbitrary: { preserved: false } };
  const accepted = await f.request('/predict/jobs', input);
  assert.equal(accepted.status, 202); assert.equal(accepted.cache, 'no-store'); assert.equal(f.calls.length, 0);
  assert.equal(f.scheduled.length, 1); const id = accepted.body.data.id;
  const duplicate = await f.request('/predict/jobs', structuredClone(input));
  assert.equal(duplicate.body.data.id, id); assert.equal(f.scheduled.length, 1);
  assert.equal((await f.request(`/predict/jobs/${id}`)).body.data.status, 'RUNNING');
  assert.equal((await f.request(`/predict/jobs/${id}`)).cache, 'no-store');
  assert.equal((await f.request(`/predict/jobs/${id}`, undefined, { 'x-test-owner': 'other' })).status, 404);
  assert.equal((await f.request('/predict/jobs', { ...input, arbitrary: { preserved: true } })).status, 409);
  f.scheduled[0](); await flush(); assert.deepEqual(f.calls, [input]);
  pending.resolve({ ...structuredClone(prediction), canonicalRecommendation: null }); await flush();
  const complete = await f.request(`/predict/jobs/${id}`);
  assert.equal(complete.body.data.status, 'COMPLETED'); assert.equal(complete.body.data.responseStatus, 200);
  assert.equal(f.calls.length, 1); assert.equal(f.reads.length, 0);
});

test('aborting a status read neither cancels A nor starts a second computation', async (t) => {
  const pending = deferred(), f = await fixture(t, { predict: () => pending.promise });
  const accepted = await f.request('/predict/jobs', { input: 'complete' }); await flush();
  const id = accepted.body.data.id, controller = new AbortController();
  const read = fetch(`${f.base}/predict/jobs/${id}`, { signal: controller.signal }); controller.abort();
  await assert.rejects(read, { name: 'AbortError' });
  assert.equal((await f.request(`/predict/jobs/${id}`)).body.data.status, 'RUNNING');
  assert.equal((await f.request('/predict/jobs', { input: 'other' })).status, 409); assert.equal(f.calls.length, 1);
  pending.resolve({ ...structuredClone(prediction), canonicalRecommendation: null }); await flush();
  assert.equal((await f.request(`/predict/jobs/${id}`)).body.data.status, 'COMPLETED'); assert.equal(f.calls.length, 1);
});

for (const action of [null, 'BET', 'ABSTAIN']) {
  test(`job result exactly equals synchronous A including archived projection ${action}`, async (t) => {
    const f = await fixture(t, { recorded: action ? recorded(action) : null });
    const input = { matchId: 'm1', homeTeamId: 'h', awayTeamId: 'a', bankroll: 1234, bookmakerOdds: { homeWin: 2.1 },
      asOfDate: '2026-11-01T12:00:00Z', calibrationOption: false };
    const sync = await f.request('/predict', input), accepted = await f.request('/predict/jobs', input);
    await flush(); const completed = await f.request(`/predict/jobs/${accepted.body.data.id}`);
    assert.equal(sync.status, 200); assert.equal(completed.body.data.responseStatus, sync.status);
    assert.deepEqual(completed.body.data.response, sync.body); assert.deepEqual(f.calls, [input, input]);
    if (action) { assert.equal(sync.body.data.automaticRecommendation.decisionId, 'recorded-a');
      assert.equal(sync.body.data.canonicalRecommendation.selected?.selection ?? null, action === 'BET' ? 'homeWin' : null); }
    assert.deepEqual(f.reads, [{ matchId: 'm1', family: 'A', limit: 20, includeForecasts: true },
      { matchId: 'm1', family: 'A', limit: 20, includeForecasts: true }]);
  });
}

for (const [message, status] of [['Invalid prediction input', 400], ['Recorded recommendation packet unavailable', 503]]) {
  test(`job preserves the original A error response and HTTP status ${status}`, async (t) => {
    const f = await fixture(t, { predict: async () => { throw new Error(message); } });
    const sync = await f.request('/predict', { complete: 'input' }), accepted = await f.request('/predict/jobs', { complete: 'input' });
    await flush(); const terminal = await f.request(`/predict/jobs/${accepted.body.data.id}`);
    assert.equal(sync.status, status); assert.equal(terminal.body.data.status, 'FAILED');
    assert.equal(terminal.body.data.responseStatus, status); assert.deepEqual(terminal.body.data.response, sync.body);
  });
}

test('missing archived A evidence retains the synchronous 503 instead of exposing the live selection', async (t) => {
  const archive = recorded(); delete archive.recommendationPacket;
  const f = await fixture(t, { recorded: archive });
  const sync = await f.request('/predict', { matchId: 'm1' }), accepted = await f.request('/predict/jobs', { matchId: 'm1' });
  await flush(); const terminal = await f.request(`/predict/jobs/${accepted.body.data.id}`);
  assert.equal(sync.status, 503); assert.equal(terminal.body.data.status, 'FAILED');
  assert.equal(terminal.body.data.responseStatus, 503); assert.deepEqual(terminal.body.data.response, sync.body);
  assert.equal(terminal.body.data.response.data, undefined);
});

test('malformed requests and unknown jobs cannot trigger A or accounting', async (t) => {
  const f = await fixture(t);
  for (const body of [[], null, 'invalid']) assert.equal((await f.request('/predict/jobs', body)).status, 400);
  assert.equal((await f.request('/predict/jobs/not-present')).status, 404); assert.equal(f.calls.length, 0);
});

test('production authentication middleware protects both job routes before the prediction service', async (t) => {
  const f = await fixture(t, { auth: true });
  assert.equal((await f.request('/predict/jobs', {})).status, 401);
  assert.equal((await f.request('/predict/jobs/not-present')).status, 401); assert.equal(f.calls.length, 0);
  const login = await f.request('/auth/login', { password: 'unit-example' });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  const accepted = await f.request('/predict/jobs', {}, { cookie }); assert.equal(accepted.status, 202);
  await flush(); assert.equal((await f.request(`/predict/jobs/${accepted.body.data.id}`, undefined, { cookie })).status, 200);
  assert.equal(f.calls.length, 1);
});
