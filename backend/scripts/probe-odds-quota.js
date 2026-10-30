#!/usr/bin/env node
// GET /sports is the zero-credit quota probe. No odds requests or database access.
const ENDPOINT = 'https://api.the-odds-api.com/v4/sports/';
const TIMEOUT_MS = 20_000;
const PROVIDER_CODES = new Set(['INVALID_KEY', 'OUT_OF_USAGE_CREDITS']);

const emptyReport = (providerErrorCode) => ({ httpStatus: null, providerErrorCode,
  remaining: null, used: null, lastCost: null, date: null });
function quotaNumber(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}
function providerDate(value) {
  if (typeof value !== 'string'
    || !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toUTCString() === value ? parsed.toISOString() : null;
}

async function probeOddsQuota(options = {}) {
  const env = options.env ?? process.env;
  const key = typeof env.ODDS_API_KEY === 'string' ? env.ODDS_API_KEY.trim() : '';
  if (!key) return { success: false, report: emptyReport('probe_key_missing') };
  const report = emptyReport(null);
  let response, signal;
  try {
    const url = new URL(ENDPOINT);
    url.searchParams.set('apiKey', key);
    signal = (options.timeoutSignal ?? AbortSignal.timeout)(TIMEOUT_MS);
    // Refuse redirects so the credential can only reach the fixed provider host.
    response = await (options.fetchImpl ?? fetch)(url, { method: 'GET', redirect: 'error', signal });
    report.httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status : null;
    report.remaining = quotaNumber(response.headers.get('x-requests-remaining'));
    report.used = quotaNumber(response.headers.get('x-requests-used'));
    report.lastCost = quotaNumber(response.headers.get('x-requests-last'));
    report.date = providerDate(response.headers.get('date'));
    if (report.httpStatus !== 200) {
      let code;
      try { code = (await response.json())?.error_code; } catch { /* Never expose a provider body or exception. */ }
      report.providerErrorCode = PROVIDER_CODES.has(code) ? code : 'probe_http_error';
      return { success: false, report };
    }
    if ([report.remaining, report.used, report.lastCost].some((value) => value === null)) {
      report.providerErrorCode = 'probe_quota_invalid';
      return { success: false, report };
    }
    if (report.lastCost !== 0) {
      report.providerErrorCode = 'probe_nonzero_cost';
      return { success: false, report };
    }
    return { success: true, report };
  } catch (error) {
    report.providerErrorCode = signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'probe_timeout' : 'probe_request_failed';
    return { success: false, report };
  } finally {
    // A successful sports catalogue is unnecessary: retain only quota metadata.
    try { await response?.body?.cancel(); } catch { /* Already consumed or aborted. */ }
  }
}

async function main(options = {}) {
  const result = await probeOddsQuota(options);
  (options.write ?? console.log)(JSON.stringify(result.report));
  return result.success ? 0 : 1;
}

if (require.main === module) main().then((code) => { process.exitCode = code; }).catch(() => {
  console.log(JSON.stringify(emptyReport('probe_request_failed')));
  process.exitCode = 1;
});

module.exports = { probeOddsQuota, main };
