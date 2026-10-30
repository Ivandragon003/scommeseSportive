const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { probeOddsQuota, main } = require('../scripts/probe-odds-quota');

const KEY = 'fixture-private-key?apiKey=https://untrusted.invalid/';
const env = { ODDS_API_KEY: KEY, ODDS_API_URL: 'https://untrusted.invalid/', TURSO_AUTH_TOKEN: 'unused-private-token' };
const headers = (overrides = {}) => new Headers({ 'x-requests-remaining': '205', 'x-requests-used': '295',
  'x-requests-last': '0', date: 'Fri, 30 Oct 2026 00:00:00 GMT', ...overrides });
const response = (status = 200, overrides = {}, body = {}) => ({ status, headers: headers(overrides),
  json: async () => body, body: { cancel: async () => {} } });
const safeKeys = ['httpStatus', 'providerErrorCode', 'remaining', 'used', 'lastCost', 'date'];

test('one fixed-host GET reports only numeric quota metadata and refuses redirects', async () => {
  let calls = 0, cancelled = false;
  const result = await probeOddsQuota({ env, timeoutSignal: (ms) => {
    assert.equal(ms, 20_000); return new AbortController().signal;
  }, fetchImpl: async (target, init) => {
    calls++;
    assert.equal(target.origin, 'https://api.the-odds-api.com');
    assert.equal(target.pathname, '/v4/sports/');
    assert.deepEqual([...target.searchParams.keys()], ['apiKey']);
    assert.equal(target.searchParams.get('apiKey'), KEY);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return { ...response(), json: () => { throw new Error('Success must not consume the catalogue'); },
      body: { cancel: async () => { cancelled = true; } } };
  } });
  assert.equal(calls, 1); assert.equal(cancelled, true); assert.equal(result.success, true);
  assert.deepEqual(Object.keys(result.report), safeKeys);
  assert.deepEqual(result.report, { httpStatus: 200, providerErrorCode: null, remaining: 205, used: 295,
    lastCost: 0, date: '2026-10-30T00:00:00.000Z' });
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|unused-private|untrusted/);
});

test('missing or invalid Date stays null without blocking a valid zero-cost quota', async () => {
  for (const date of [null, 'private-header-sentinel', 'Fri, 30 Oct 2026 00:00:00 GMT secret']) {
    const result = await probeOddsQuota({ env, fetchImpl: async () => ({ ...response(), headers: {
      get: (name) => name === 'date' ? date : headers().get(name),
    } }) });
    assert.equal(result.success, true); assert.equal(result.report.date, null);
  }
});

test('quota probe authenticates errors without exposing echoed credentials, bodies or arbitrary codes', async () => {
  for (const code of ['INVALID_KEY', 'OUT_OF_USAGE_CREDITS', `INVALID_KEY_${KEY}`, null]) {
    const lines = [];
    const exitCode = await main({ env, write: (line) => lines.push(line), fetchImpl: async () => response(401, {}, {
      error_code: code, message: `https://api.the-odds-api.com/?apiKey=${KEY}`, details: 'private-body-sentinel',
    }) });
    assert.equal(exitCode, 1); assert.equal(lines.length, 1);
    const report = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(report), safeKeys);
    assert.equal(report.httpStatus, 401);
    assert.equal(report.providerErrorCode, ['INVALID_KEY', 'OUT_OF_USAGE_CREDITS'].includes(code) ? code : 'probe_http_error');
    assert.doesNotMatch(lines[0], /fixture-private|apiKey|private-body|https:/);
  }
});

test('missing key fails locally before a request or alternate key lookup', async () => {
  const result = await probeOddsQuota({ env: { THE_ODDS_API_KEY: KEY }, fetchImpl: async () => {
    throw new Error('No request allowed');
  } });
  assert.equal(result.success, false); assert.equal(result.report.providerErrorCode, 'probe_key_missing');
  assert.equal(result.report.httpStatus, null);
});

test('abort and network failures are sanitized and never retried', async () => {
  for (const timeout of [true, false]) {
    let calls = 0;
    const result = await probeOddsQuota({ env,
      timeoutSignal: () => timeout ? AbortSignal.abort(new DOMException(KEY, 'TimeoutError')) : new AbortController().signal,
      fetchImpl: async (_target, init) => { calls++; throw timeout ? init.signal.reason : new Error(KEY); },
    });
    assert.equal(calls, 1); assert.equal(result.success, false);
    assert.equal(result.report.providerErrorCode, timeout ? 'probe_timeout' : 'probe_request_failed');
    assert.doesNotMatch(JSON.stringify(result), /fixture-private|apiKey|https:/);
  }
});

test('missing, negative, fractional, overflowing or malformed quota counters cannot pass', async () => {
  for (const value of [null, '', '-1', '1.5', '1e2', '9007199254740992', '1, 2', KEY]) {
    const result = await probeOddsQuota({ env, fetchImpl: async () => ({ ...response(), headers: {
      get: (name) => name === 'x-requests-remaining' ? value : headers().get(name),
    } }) });
    assert.equal(result.success, false); assert.equal(result.report.providerErrorCode, 'probe_quota_invalid');
    assert.equal(result.report.remaining, null);
    assert.doesNotMatch(JSON.stringify(result), /fixture-private|apiKey|https:/);
  }
  for (const field of ['x-requests-used', 'x-requests-last']) {
    const result = await probeOddsQuota({ env, fetchImpl: async () => ({ ...response(), headers: {
      get: (name) => name === field ? null : headers().get(name),
    } }) });
    assert.equal(result.success, false); assert.equal(result.report.providerErrorCode, 'probe_quota_invalid');
  }
});

test('zero remaining is valid metadata, while nonzero request cost and non-200 status fail', async () => {
  const exhausted = await probeOddsQuota({ env, fetchImpl: async () => response(200, {
    'x-requests-remaining': '0', 'x-requests-used': '500',
  }) });
  assert.equal(exhausted.success, true); assert.equal(exhausted.report.remaining, 0);
  const charged = await probeOddsQuota({ env, fetchImpl: async () => response(200, { 'x-requests-last': '1' }) });
  assert.equal(charged.success, false); assert.equal(charged.report.providerErrorCode, 'probe_nonzero_cost');
  const unexpected = await probeOddsQuota({ env, fetchImpl: async () => response(201) });
  assert.equal(unexpected.success, false); assert.equal(unexpected.report.providerErrorCode, 'probe_http_error');
});

test('quota-only workflow defaults on and cannot expose Turso or run the legacy odds job', () => {
  const workflow = readFileSync(join(__dirname, '../../.github/workflows/odds-api-smoke.yml'), 'utf8');
  assert.match(workflow, /quota_only:[\s\S]*type: boolean\s+default: true/);
  assert.match(workflow, /permissions:\s+contents: read/);
  const quota = workflow.split('\n  quota:')[1].split('\n  odds-api-smoke:')[0];
  assert.match(quota, /if: \$\{\{ inputs.quota_only \}\}/);
  assert.match(quota, /ODDS_API_KEY: \$\{\{ secrets.ODDS_API_KEY \}\}/);
  assert.match(quota, /node backend\/scripts\/probe-odds-quota.js/);
  assert.doesNotMatch(quota, /TURSO|THE_ODDS_API_KEY|npm |getOdds|artifacts/);
  assert.match(workflow, /odds-api-smoke:\s+if: \$\{\{ !inputs.quota_only \}\}/);
  const script = readFileSync(join(__dirname, '../scripts/probe-odds-quota.js'), 'utf8');
  assert.doesNotMatch(script, /require\(|TURSO|writeFile|appendFile|\.getOdds\(/);
});
