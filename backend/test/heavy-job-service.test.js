const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const express = require('express');
const { HeavyJobBusyError, HeavyJobService } = require('../dist/services/HeavyJobService.js');
const { createApiRouter } = require('../dist/api/routes.js');

const request = {
  competition: 'Serie A',
  season: '2025/2026',
  historicalOdds: {},
  options: { maxFolds: 1 },
};

test('HeavyJobService mantiene responsivo il thread principale durante CPU nel worker', async () => {
  const service = new HeavyJobService({
    timeoutMs: 1_000,
    workerFactory: () => new Worker(`
      const { parentPort } = require('node:worker_threads');
      const deadline = Date.now() + 80;
      while (Date.now() < deadline) { Math.sqrt(42); }
      parentPort.postMessage({ type: 'result', result: { completedInWorker: true } });
    `, { eval: true }),
  });

  let timerAdvanced = false;
  const timer = setTimeout(() => { timerAdvanced = true; }, 10);
  const result = await service.runWalkForwardBacktest(request);
  clearTimeout(timer);

  assert.deepEqual(result, { completedInWorker: true });
  assert.equal(timerAdvanced, true);
});

test('HeavyJobService limita il backtest concorrente e serializza gli errori worker', async () => {
  let worker;
  const service = new HeavyJobService({
    timeoutMs: 1_000,
    workerFactory: () => {
      worker = new Worker(`
        const { parentPort } = require('node:worker_threads');
        parentPort.postMessage({ type: 'error', error: { message: 'worker failure', name: 'Error' } });
      `, { eval: true });
      return worker;
    },
  });

  const first = service.runWalkForwardBacktest(request);
  await assert.rejects(() => service.runWalkForwardBacktest(request), HeavyJobBusyError);
  await assert.rejects(first, /worker failure/);
  await worker.terminate();
});

test('HeavyJobService rifiuta subito un worker che esce pulito senza messaggio', async () => {
  const service = new HeavyJobService({
    timeoutMs: 1_000,
    workerFactory: () => new Worker('process.exit(0)', { eval: true }),
  });

  await assert.rejects(() => service.runWalkForwardBacktest(request), /exited without a result/i);
});

test('route backtest conserva payload e timeout e segnala 429 quando il worker e occupato', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {},
    svc: {},
    heavyJobService: {
      async runWalkForwardBacktest() {
        throw new HeavyJobBusyError();
      },
    },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/backtest/walk-forward`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ competition: 'Serie A' }),
    });
    assert.equal(response.status, 429);
    assert.match((await response.json()).error, /gia in esecuzione/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('worker chiude il database prima di notificare il risultato al servizio host', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'backtest.worker.ts'), 'utf8');
  assert.ok(source.indexOf('await db.close()') < source.indexOf('parentPort?.postMessage(response!);'));
});
