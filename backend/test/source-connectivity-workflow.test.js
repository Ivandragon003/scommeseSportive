const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/source-connectivity.yml'), 'utf8');
const script = workflow.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/)[1].replace(/^ {10}/gm, '');
const leagues = ['serie_a', 'epl', 'la_liga', 'bundesliga', 'ligue_1'];

async function runDiagnostic(reply, timestamp = '2026-11-05T12:00:00Z') {
  const calls = [], logs = [], state = { exitCode: 0 };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [timestamp])); } }
  const https = {
    get(options, callback) {
      calls.push(options);
      const request = new EventEmitter();
      request.destroy = error => { if (error) request.emit('error', error); request.emit('close'); };
      queueMicrotask(() => {
        const value = reply(options);
        if (value.error) { request.destroy(Object.assign(new Error('transport'), { code: value.error })); return; }
        const response = new EventEmitter();
        response.statusCode = value.status ?? 200;
        response.headers = { 'content-type': value.contentType ?? 'application/json' };
        response.setEncoding = () => response;
        response.destroy = () => request.emit('close');
        callback(response);
        response.emit('data', value.body ?? JSON.stringify({ dates: [{ id: '1' }] }));
        response.emit('end');
        request.emit('close');
      });
      return request;
    },
  };
  await vm.runInNewContext(script, {
    require(name) {
      if (name === 'node:https') return https;
      if (name === 'node:dns') return { promises: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] } };
      throw new Error('Unexpected dependency');
    },
    console: { log: line => logs.push(JSON.parse(line)), error: line => logs.push({ error: line }) },
    process: state, Buffer, Date: Clock, setTimeout, clearTimeout,
  });
  return { calls, logs, exitCode: state.exitCode, summary: logs.at(-1) };
}

test('connectivity rejects HTTP 200 maintenance pages for every league without logging the body', async () => {
  const result = await runDiagnostic(() => ({ body: '<html>We will come back soon PRIVATE_BODY_MARKER</html>', contentType: 'text/html' }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.understatReachable, false);
  assert.equal(result.summary.understatCoverage.length, 5);
  assert.ok(result.summary.understatCoverage.every(item => item.available === false));
  assert.deepEqual(result.calls.filter(call => call.hostname === 'understat.com').map(call => call.path), leagues.map(league => `/getLeagueData/${league}/2026`));
  assert.equal(JSON.stringify(result.logs).includes('PRIVATE_BODY_MARKER'), false);
});

test('connectivity certifies only nonempty calendars from all five HTTP-success responses', async () => {
  const result = await runDiagnostic(() => ({}));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.understatReachable, true);
  assert.ok(result.summary.understatCoverage.every(item => item.available === true));
  assert.equal(result.calls.length, 6);
  assert.ok(result.calls.every(call => !Object.keys(call.headers).some(key => /authorization|token/i.test(key))));
});

test('one absent, malformed or empty league prevents a false complete-coverage success', async () => {
  for (const body of ['{}', '{"dates":null}', '{"dates":[]}', 'invalid JSON']) {
    const result = await runDiagnostic(options => options.path.includes('/epl/') ? { body } : {});
    assert.equal(result.exitCode, 1);
    assert.equal(result.summary.understatReachable, false);
    assert.equal(result.summary.understatCoverage.filter(item => item.available).length, 4);
    const observation = result.logs.find(item => item.path?.includes('/epl/'));
    assert.equal(observation.matches, body === '{"dates":[]}' ? 0 : null);
  }
});

test('HTTP failures and network errors cannot pass through otherwise valid JSON', async () => {
  for (const failure of [{ status: 503 }, { error: 'EAI_AGAIN' }]) {
    const result = await runDiagnostic(options => options.path.includes('/serie_a/') ? failure : {});
    assert.equal(result.exitCode, 1);
    assert.equal(result.summary.understatReachable, false);
    assert.equal(result.calls.length, 6);
  }
});

test('connectivity bounds response size without exposing or accepting the oversized body', async () => {
  const body = 'BODY_MARKER' + 'x'.repeat(4 * 1024 * 1024);
  const result = await runDiagnostic(options => options.path.includes('/serie_a/') ? { body } : {});
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.understatReachable, false);
  assert.ok(result.logs.some(item => item.error === 'RESPONSE_TOO_LARGE'));
  assert.equal(JSON.stringify(result.logs).includes('BODY_MARKER'), false);
});

test('connectivity checks the current season across the July UTC boundary', async () => {
  for (const [at, year, csv] of [['2027-06-30T23:59:59Z', '2026', '2627'], ['2027-07-01T00:00:00Z', '2027', '2728']]) {
    const result = await runDiagnostic(() => ({}), at);
    assert.ok(result.calls.filter(call => call.hostname === 'understat.com').every(call => call.path.endsWith(`/${year}`)));
    assert.equal(result.calls.at(-1).path, `/mmz4281/${csv}/I1.csv`);
  }
});
