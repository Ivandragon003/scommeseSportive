const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');

function startWorker(url, options = {}) {
  const child = fork(join(__dirname, 'fixtures/smart-odds-process.cjs'), [], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FIXTURE_DATABASE_URL: url,
      FIXTURE_NOW: options.now ?? '2026-10-27T12:00:00.000Z', FIXTURE_HOLD: String(Boolean(options.hold)) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let resolveReady, resolveFetch;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const fetched = new Promise((resolve) => { resolveFetch = resolve; });
  const done = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      messages.push(message);
      if (message.type === 'ready') resolveReady();
      if (message.type === 'fetch') resolveFetch();
      if (message.type === 'result') resolve(message.result);
      if (message.type === 'error') reject(new Error(message.code));
    });
    child.on('error', reject);
    child.on('exit', (code) => { if (code && !messages.some((message) => message.type === 'result')) reject(new Error('fixture_process_failed')); });
  });
  // An intentionally killed process has no response to await.
  if (options.hold) done.catch(() => {});
  return { child, ready, fetched, done, messages };
}

async function setup() {
  const url = `file:${join(tmpdir(), `smart-odds-process-${randomUUID()}.db`)}`;
  const client = createClient({ url });
  await client.execute('PRAGMA journal_mode=WAL');
  await client.executeMultiple(readFileSync(join(__dirname, '../migrations/018_smart_odds.sql'), 'utf8'));
  return { url, client };
}

test('separate OS processes deduplicate a shared synthetic provider request and immutable cache', { timeout: 15000 }, async () => {
  const { url, client } = await setup();
  const workers = [startWorker(url), startWorker(url)];
  try {
    await Promise.all(workers.map((worker) => worker.ready));
    workers.forEach((worker) => worker.child.send('run'));
    const results = await Promise.all(workers.map((worker) => worker.done));
    assert.equal(workers.flatMap((worker) => worker.messages).filter((message) => message.type === 'fetch').length, 1);
    assert.equal(results.filter((result) => result.cacheHit).length, 1);
    assert.deepEqual(results[0].data, results[1].data);
    assert.equal(results[0].fetchedAt, results[1].fetchedAt);
    assert.equal((await client.execute('SELECT COUNT(*) AS count FROM smart_odds_requests')).rows[0].count, 1);
  } finally { workers.forEach((worker) => worker.child.kill()); client.close(); }
});

test('crashed odds process keeps unknown credit liability; new process recovers expired lease', { timeout: 15000 }, async () => {
  const { url, client } = await setup();
  const old = startWorker(url, { hold: true });
  let next;
  try {
    await old.ready; old.child.send('run'); await old.fetched;
    old.child.kill('SIGKILL'); await once(old.child, 'exit');
    next = startWorker(url, { now: '2026-10-27T12:01:01.000Z' });
    await next.ready; next.child.send('run');
    assert.equal((await next.done).data.testOnly, true);
    const results = (await client.execute('SELECT status,charged_credits,error_code FROM smart_odds_results')).rows;
    assert.equal(results.length, 2);
    assert.ok(results.some((result) => result.status === 'UNKNOWN' && result.charged_credits === 1 && result.error_code === 'lease_expired_unknown'));
    assert.equal(results.reduce((sum, row) => sum + Number(row.charged_credits), 0), 2);
  } finally { old.child.kill(); next?.child.kill(); client.close(); }
});
