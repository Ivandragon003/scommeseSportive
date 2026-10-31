const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes');

async function fixture(t, preview) {
  const calls = [];
  const forbidden = () => { throw new Error('Unexpected model A or accounting operation'); };
  const db = new Proxy({}, { get: forbidden });
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ db, svc: { predict: forbidden },
    challengerPreview: { preview: async (id) => { calls.push(id); return preview(id); } } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { calls, post: async (body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/research/challenger-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
  } };
}

test('the C preview endpoint forwards only the server-resolved match identity without invoking A or accounting', async (t) => {
  const payload = { kind: 'C_PREVIEW', family: 'C', matchId: 'match-1', status: 'RECOMMENDED', registered: false };
  const f = await fixture(t, async () => payload);
  const result = await f.post({ matchId: ' match-1 ' });
  assert.equal(result.status, 200);
  assert.equal(result.cache, 'no-store');
  assert.deepEqual(result.body, { success: true, data: payload });
  assert.deepEqual(f.calls, ['match-1']);
});

for (const body of [{}, { matchId: '' }, { matchId: 2 }, [], { matchId: 'x'.repeat(161) },
  { matchId: 'match-1', asOf: '2020-01-01' }, { matchId: 'match-1', quote: { odds: 9 } },
  { matchId: 'match-1', modelVersion: 'C-test' }]) {
  test(`invalid preview input never reaches the engine: ${JSON.stringify(body).slice(0, 65)}`, async (t) => {
    const f = await fixture(t, async () => { throw new Error('Must not prepare'); });
    const result = await f.post(body);
    assert.equal(result.status, 400);
    assert.equal(result.body.success, false);
    assert.deepEqual(f.calls, []);
  });
}

test('service failures never leak authenticated provider URLs or secrets', async (t) => {
  const f = await fixture(t, async () => { throw new Error('https://provider.invalid/?apiKey=secret-fixture'); });
  const result = await f.post({ matchId: 'match-1' });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'Anteprima del modello C temporaneamente non disponibile.');
  assert.equal(JSON.stringify(result.body).includes('secret-fixture'), false);
});
