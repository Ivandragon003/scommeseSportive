const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchWorkerCoordinator } = require('../dist/research/ResearchWorkerCoordinator');
const { startWorker } = require('../scripts/research-worker');

async function setup(t) {
  const path = join(tmpdir(), `research-worker-${randomUUID()}.db`);
  const clients = [createClient({ url: `file:${path}` }), createClient({ url: `file:${path}` })];
  await clients[0].execute('PRAGMA journal_mode=WAL');
  await clients[0].executeMultiple(readFileSync(join(__dirname, '../migrations/019_research_worker.sql'), 'utf8'));
  let now = Date.parse('2026-10-27T12:00:00.000Z');
  const coordinators = clients.map((client) => new ResearchWorkerCoordinator(client, async () => {}, { clock: () => new Date(now) }));
  t.after(() => {
    for (const client of clients) client.close();
    if (process.platform !== 'win32') rmSync(path, { force: true });
  });
  return { clients, coordinators, advance: (ms) => { now += ms; } };
}

test('disabled worker stays disconnected and does not initialize models or portfolios', async () => {
  const logs = [];
  const db = new Proxy({}, { get: () => { throw new Error('disabled worker must not access DB'); } });
  const worker = await startWorker({ enabled: false, db, log: (entry) => logs.push(entry) });
  assert.equal(worker.enabled, false);
  assert.equal(worker.state.phase, 'disabled');
  assert.equal(worker.runtime, undefined);
  await worker.stop();
  assert.equal(logs[0].event, 'worker_disabled');
});

test('separate database clients elect exactly one persistent worker, including simultaneous startup', async (t) => {
  const { coordinators: [first, second], clients } = await setup(t);
  const claims = await Promise.all([first.acquire('first'), second.acquire('second')]);
  assert.equal(claims.filter(Boolean).length, 1);
  const leader = claims.find(Boolean), follower = leader.ownerId === 'first' ? second : first;
  assert.equal(await follower.acquire('standby'), null);
  const row = (await clients[0].execute('SELECT * FROM research_worker_state')).rows[0];
  assert.equal(row.owner_id, leader.ownerId);
  assert.equal(row.enabled, 1);
  assert.equal(row.heartbeat_at, '2026-10-27T12:00:00.000Z');
});

test('crash lease expiry fences the old owner and preserves heartbeat, decision summary and last safe error', async (t) => {
  const { coordinators: [first, second], clients, advance } = await setup(t);
  const old = await first.acquire('first');
  await first.complete(old, { completed: 2 }, 'research_runtime_failed');
  advance(15_000);
  assert.equal(await first.renew(old), true);
  advance(29_999);
  assert.equal(await second.acquire('second'), null);
  advance(1);
  const recovered = await second.acquire('second');
  assert.ok(recovered);
  assert.notEqual(recovered.token, old.token);
  await assert.rejects(first.assertOwned(old), /lease lost/);
  assert.equal(await first.renew(old), false);
  await first.complete(old, { completed: 999 }, 'research_runtime_failed');
  await first.release(old);
  let row = (await clients[0].execute('SELECT * FROM research_worker_state')).rows[0];
  assert.equal(row.owner_id, 'second');
  assert.equal(JSON.parse(row.last_tick_json).completed, 2);
  assert.equal(row.last_error, 'research_runtime_failed');
  await second.complete(recovered, { completed: 0, errors: 1 }, 't15_prepare_failed');
  assert.equal((await clients[0].execute('SELECT last_error FROM research_worker_state')).rows[0].last_error, 't15_prepare_failed');
  await second.complete(recovered, { completed: 1 }, 'https://secret.example?apiKey=do-not-store');
  row = (await clients[0].execute('SELECT * FROM research_worker_state')).rows[0];
  assert.equal(row.last_error, null);
  await second.release(recovered);
  row = (await clients[0].execute('SELECT * FROM research_worker_state')).rows[0];
  assert.equal(row.enabled, 0);
  assert.equal(row.owner_id, null);
  assert.equal(JSON.parse(row.last_tick_json).completed, 1);
});

test('default production coordination uses the shared database UTC clock', async (t) => {
  const { clients } = await setup(t);
  const coordinator = new ResearchWorkerCoordinator(clients[0]);
  const before = Date.now();
  const lease = await coordinator.acquire('database-clock');
  const row = (await clients[0].execute('SELECT * FROM research_worker_state')).rows[0];
  assert.ok(Date.parse(row.heartbeat_at) >= before - 1000 && Date.parse(row.heartbeat_at) <= Date.now() + 1000);
  assert.equal(Date.parse(row.lease_expires_at) - Date.parse(row.heartbeat_at), 30000);
  await coordinator.assertOwned(lease);
});

test('operational status reads never acquire or refresh a lease and expose a stopped or stale worker', async (t) => {
  const { coordinators: [coordinator], clients, advance } = await setup(t);
  assert.equal((await coordinator.status()).enabled, false);
  assert.equal((await clients[0].execute('SELECT COUNT(*) AS n FROM research_worker_state')).rows[0].n, 0);
  const lease = await coordinator.acquire('operational');
  const started = await coordinator.status();
  assert.equal(started.active, true);
  assert.equal(started.heartbeatFresh, true);
  advance(46_000);
  const stale = await coordinator.status();
  assert.equal(stale.enabled, true);
  assert.equal(stale.active, false);
  assert.equal(stale.heartbeatFresh, false);
  assert.equal(stale.heartbeatAt, started.heartbeatAt);
  await coordinator.release(lease);
  assert.equal((await coordinator.status()).enabled, false);
});
