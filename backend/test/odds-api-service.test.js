const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { OddsApiService } = require('../dist/services/OddsApiService.js');
// Explicit fake persistence boundary: all HTTP below is intercepted by axios stubs.
const interceptedTransport = { execute: async (_request, fetcher) => ({ ...(await fetcher()), fetchedAt: '2026-10-27T10:00:00.000Z', cacheHit: false }) };

test('measured quota is unknown before provider headers and cache restoration cannot invent an observation', () => {
  const service = new OddsApiService('test-key');
  assert.deepEqual(service.getQuotaStatus(), { remaining: null, used: null, lastCost: null, observedAt: null, source: null });
  service.setRemainingRequests(123);
  assert.equal(service.getRemainingRequests(), 123);
  assert.equal(service.getQuotaStatus().remaining, null);
});

test('quota telemetry records actual header credits and retains their timestamp when a response has no usable headers', async () => {
  const originalGet = axios.get;
  let responseHeaders = { 'X-Requests-Remaining': '473', 'X-Requests-Used': '27', 'X-Requests-Last': '3' };
  axios.get = async () => ({ headers: responseHeaders, data: [] });
  try {
    const service = new OddsApiService('test-key', { store: interceptedTransport });
    await service.getOdds('Serie A');
    const measured = service.getQuotaStatus();
    assert.equal(measured.remaining, 473); assert.equal(measured.used, 27); assert.equal(measured.lastCost, 3);
    assert.equal(measured.source, 'provider_headers'); assert.ok(Number.isFinite(Date.parse(measured.observedAt)));
    responseHeaders = { 'X-Requests-Remaining': '999garbage' };
    await service.getOdds('Serie A');
    assert.deepEqual(service.getQuotaStatus(), measured);
    measured.remaining = 1;
    assert.equal(service.getQuotaStatus().remaining, 473);
  } finally { axios.get = originalGet; }
});

test('network requests fail closed without the persistent manager, while extraction remains available', async () => {
  const service = new OddsApiService('test-key');
  await assert.rejects(service.getOdds('Serie A'), { code: 'odds_persistent_manager_required' });
  await assert.rejects(service.getScores('Serie A'), { code: 'odds_persistent_manager_required' });
  await assert.rejects(service.getEvents('Serie A'), { code: 'odds_persistent_manager_required' });
  await assert.rejects(service.getEventOdds('Serie A', 'event1', ['h2h']), { code: 'odds_persistent_manager_required' });
});

test('HTTP failures retain only approved provider codes and numeric quota headers, including zero', async () => {
  const originalGet = axios.get;
  try {
    for (const rawCode of ['OUT_OF_USAGE_CREDITS', 'INVALID_KEY', 'UNKNOWN_CODE_WITH_SECRET', null]) {
      const service = new OddsApiService('private-key-sentinel', { store: interceptedTransport });
      axios.get = async () => { throw {
        message: 'https://provider.invalid/?apiKey=private-key-sentinel',
        response: { status: 401, data: { error_code: rawCode, message: 'private-body-sentinel' },
          headers: { 'X-Requests-Used': '500', 'X-Requests-Remaining': '0', 'X-Requests-Last': '0',
            authorization: 'private-header-sentinel', 'set-cookie': 'private-cookie-sentinel' } },
      }; };
      await assert.rejects(service.getOdds('Serie A'), (error) => {
        assert.deepEqual(error.response, { status: 401,
          headers: { 'x-requests-used': '500', 'x-requests-remaining': '0', 'x-requests-last': '0' } });
        assert.equal(error.providerErrorCode, ['OUT_OF_USAGE_CREDITS', 'INVALID_KEY'].includes(rawCode) ? rawCode : undefined);
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private-|provider\.invalid|UNKNOWN_CODE/);
        return true;
      });
      const quota = service.getQuotaStatus();
      assert.equal(quota.remaining, 0); assert.equal(quota.used, 500); assert.equal(quota.lastCost, 0);
      assert.equal(quota.source, 'provider_headers'); assert.ok(Number.isFinite(Date.parse(quota.observedAt)));
      assert.equal(service.getRemainingRequests(), 0);
      axios.get = async () => { throw { response: { status: 403, data: { error_code: 'INVALID_KEY' },
        headers: { 'x-requests-remaining': 'private-invalid-header' } } }; };
      await assert.rejects(service.getOdds('Serie A'), (error) => {
        assert.deepEqual(error.response.headers, {}); return true;
      });
      assert.deepEqual(service.getQuotaStatus(), quota);
    }
  } finally { axios.get = originalGet; }
});

test('managed metadata preserves the original snapshot and scores/calendar costs differ', async () => {
  const requests = [];
  const capturedAt = '2026-10-27T10:00:00.000Z';
  const service = new OddsApiService('test-key', { operation: 't15', priority: 'essential', store: { execute: async (request) => {
    requests.push(request);
    return { data: [{ id: 'event1', home_team: 'Home', away_team: 'Away', commence_time: '2026-10-27T20:00:00Z', bookmakers: [] }], headers: {}, fetchedAt: capturedAt, cacheHit: true };
  } } });
  const events = await service.getEvents('Serie A');
  const odds = await service.getOdds('Serie A', ['totals', 'h2h', 'h2h']);
  await service.getScores('Serie A');
  assert.deepEqual(requests.map((request) => request.expectedCredits), [0, 2, 2]);
  assert.ok(requests.every((request) => request.operation === 't15' && !JSON.stringify(request).includes('test-key')));
  assert.equal(events[0].source, 'events');
  assert.equal(odds[0].capturedAt, capturedAt);
  assert.equal(odds[0].cacheHit, true);
  assert.equal(service.getQuotaStatus().observedAt, null);
});

test('core and extra markets retain their own cache observation without replacing provider update time', async () => {
  const coreCapture = '2026-10-30T09:59:00.000Z', extraCapture = '2026-10-30T10:00:00.000Z';
  const providerUpdate = '2026-10-30T09:58:30.000Z';
  const service = new OddsApiService('test-key', { store: { execute: async (request) => {
    const extra = request.endpoint.includes('/events/');
    const event = { id: 'e1', home_team: 'Inter', away_team: 'Milan', commence_time: '2026-10-30T19:00:00Z',
      bookmakers: [{ key: 'real', title: 'Real', last_update: providerUpdate,
        markets: [{ key: extra ? 'alternate_totals_cards' : 'totals', last_update: providerUpdate,
          outcomes: [{ name: 'Over', point: extra ? 4.5 : 2.5, price: 1.9 }] }] }] };
    return { data: extra ? event : [event], headers: {}, fetchedAt: extra ? extraCapture : coreCapture, cacheHit: true };
  } } });
  const [core] = await service.getOdds('Serie A');
  const extra = await service.getEventOdds('Serie A', 'e1', ['alternate_totals_cards']);
  assert.equal(core.bookmakers[0].markets[0].capturedAt, coreCapture);
  assert.equal(extra.bookmakers[0].markets[0].capturedAt, extraCapture);
  assert.equal(core.bookmakers[0].markets[0].updatedAt, providerUpdate);
  assert.equal(extra.bookmakers[0].markets[0].updatedAt, providerUpdate);
});

test('new planning month confirms quota with a fresh free probe before retrying the paid request', async () => {
  const requests = [];
  let confirmed = false;
  const service = new OddsApiService('test-key', { priority: 'essential', store: { execute: async (request) => {
    requests.push(request);
    if (request.expectedCredits > 0 && !confirmed) throw Object.assign(new Error('blocked'), { code: 'odds_reset_unconfirmed' });
    if (request.expectedCredits === 0) confirmed = true;
    return { data: [], headers: {}, fetchedAt: '2026-11-01T10:00:00Z', cacheHit: false };
  } } });
  await service.getOdds('Serie A');
  assert.deepEqual(requests.map((request) => request.expectedCredits), [2, 0, 2]);
  assert.equal(requests[1].cacheMaxAgeMs, 0);
  assert.match(requests[1].endpoint, /\/events$/);
});

test('unsupported competition markets are rejected before any request reservation', async () => {
  let calls = 0;
  const service = new OddsApiService('test-key', { store: { execute: async () => { calls++; throw new Error('unexpected'); } } });
  await assert.rejects(service.getOdds('Serie A', ['h2h', 'correct_score']), { code: 'odds_unsupported_market' });
  assert.equal(calls, 0);
});

test('Eurobet is preferred only when its actual price sheet exists; alternatives retain their identity', () => {
  const service = new OddsApiService('test-key');
  const sheet = (bookmakerKey, bookmakerName) => ({ bookmakerKey, bookmakerName,
    markets: [{ marketKey: 'h2h', outcomes: [{ name: 'Home', price: 1.9 }, { name: 'Draw', price: 3 }, { name: 'Away', price: 4 }] }] });
  const match = { matchId: 'fixture', homeTeam: 'Home', awayTeam: 'Away', commenceTime: '2026-10-27T20:00:00Z',
    bookmakers: [sheet('pinnacle', 'Pinnacle'), sheet('codere_it', 'Codere IT'), sheet('eurobet_it', 'Eurobet IT')] };
  assert.equal(service.getSelectedBookmaker(match).bookmakerName, 'Eurobet IT');
  assert.equal(service.getSelectedBookmaker({ ...match, bookmakers: match.bookmakers.slice(0, 2) }).bookmakerName, 'Codere IT');
});

test('compareBookmakers keeps non-h2h soccer markets such as corners and cards', () => {
  const service = new OddsApiService('test-key');
  const match = {
    matchId: 'odds_1',
    homeTeam: 'Inter',
    awayTeam: 'Milan',
    commenceTime: '2026-03-28T19:45:00Z',
    bookmakers: [
      {
        bookmakerKey: 'eurobet',
        bookmakerName: 'Eurobet',
        markets: [
          {
            marketKey: 'h2h',
            outcomes: [
              { name: 'Inter', price: 1.95 },
              { name: 'Draw', price: 3.4 },
              { name: 'Milan', price: 4.1 },
            ],
          },
          {
            marketKey: 'alternate_totals_corners',
            outcomes: [
              { name: 'Over', price: 1.88, point: 9.5 },
              { name: 'Under', price: 1.92, point: 9.5 },
            ],
          },
          {
            marketKey: 'alternate_totals_cards',
            outcomes: [
              { name: 'Over', price: 1.83, point: 4.5 },
              { name: 'Under', price: 1.97, point: 4.5 },
            ],
          },
        ],
      },
    ],
  };

  const eurobetOdds = service.extractBestOdds(match, 'eurobet');
  const comparison = service.compareBookmakers(match);

  assert.equal(eurobetOdds.homeWin, 1.95);
  assert.equal(eurobetOdds['corners_over_9.5'], 1.88);
  assert.equal(eurobetOdds['corners_under_9.5'], 1.92);
  assert.equal(eurobetOdds['cards_total_over_4.5'], 1.83);
  assert.equal(eurobetOdds['cards_total_under_4.5'], 1.97);

  assert.equal(comparison.Eurobet.homeWin, 1.95);
  assert.equal(comparison.Eurobet['corners_over_9.5'], 1.88);
  assert.equal(comparison.Eurobet['cards_total_over_4.5'], 1.83);
});

test('extractBestOdds maps extended statistical and player markets without collapsing selections', () => {
  const service = new OddsApiService('test-key');
  const match = {
    matchId: 'odds_2',
    homeTeam: 'Inter',
    awayTeam: 'Milan',
    commenceTime: '2026-03-28T19:45:00Z',
    bookmakers: [
      {
        bookmakerKey: 'pinnacle',
        bookmakerName: 'Pinnacle',
        markets: [
          {
            marketKey: 'shots',
            outcomes: [
              { name: 'Over', price: 1.9, point: 25.5, description: 'Shots' },
              { name: 'Under', price: 1.9, point: 25.5, description: 'Shots' },
            ],
          },
          {
            marketKey: 'shots_on_target',
            outcomes: [
              { name: 'Over', price: 1.85, point: 8.5, description: 'Shots On Target' },
            ],
          },
          {
            marketKey: 'corners',
            outcomes: [
              { name: 'Over', price: 1.8, point: 9.5, description: 'Corners' },
            ],
          },
          {
            marketKey: 'cards',
            outcomes: [
              { name: 'Over', price: 1.77, point: 4.5, description: 'Cards' },
            ],
          },
          {
            marketKey: 'fouls',
            outcomes: [
              { name: 'Over', price: 1.92, point: 22.5, description: 'Fouls' },
            ],
          },
          {
            marketKey: 'player_shots',
            outcomes: [
              { name: 'Over', price: 2.1, point: 1.5, description: 'Lautaro Martinez' },
              { name: 'Over', price: 2.35, point: 1.5, description: 'Rafael Leao' },
            ],
          },
        ],
      },
    ],
  };

  const odds = service.extractBestOdds(match, 'pinnacle');

  assert.equal(odds['shots_total_over_25.5'], 1.9);
  assert.equal(odds['shots_total_under_25.5'], 1.9);
  assert.equal(odds['sot_total_over_8.5'], 1.85);
  assert.equal(odds['corners_over_9.5'], 1.8);
  assert.equal(odds['cards_total_over_4.5'], 1.77);
  assert.equal(odds['fouls_over_22.5'], 1.92);
  assert.equal(odds['player_shots_lautaro_martinez_over_1.5'], 2.1);
  assert.equal(odds['player_shots_rafael_leao_over_1.5'], 2.35);
});

test('sceglie un bookmaker con quote traducibili quando il primo non ha mercati utilizzabili', () => {
  const service = new OddsApiService('test-key');
  const match = {
    matchId: 'odds_3',
    homeTeam: 'Inter',
    awayTeam: 'Milan',
    commenceTime: '2026-03-28T19:45:00Z',
    bookmakers: [
      {
        bookmakerKey: 'codere_it',
        bookmakerName: 'Codere IT',
        markets: [{ marketKey: 'unsupported_market', outcomes: [{ name: 'X', price: 2.1 }] }],
      },
      {
        bookmakerKey: 'pinnacle',
        bookmakerName: 'Pinnacle',
        markets: [{
          marketKey: 'h2h',
          outcomes: [{ name: 'Inter', price: 1.9 }, { name: 'Draw', price: 3.4 }],
        }],
      },
    ],
  };

  assert.deepEqual(service.getSelectedBookmaker(match), { bookmakerKey: 'pinnacle', bookmakerName: 'Pinnacle' });
  assert.deepEqual(service.extractBestOdds(match), { homeWin: 1.9, draw: 3.4 });
});

test('getScores normalizza eventi scores senza quote per correzione calendario', async () => {
  const originalGet = axios.get;
  axios.get = async (url, config) => {
    assert.match(url, /\/sports\/soccer_italy_serie_a\/scores\/$/);
    assert.equal(config.params.apiKey, 'test-key');
    assert.equal(config.params.daysFrom, '3');
    assert.equal(config.params.dateFormat, 'iso');

    return {
      headers: { 'x-requests-remaining': '321' },
      data: [
        {
          id: 'bologna_inter',
          home_team: 'Bologna',
          away_team: 'Inter',
          commence_time: '2026-05-23T16:00:00Z',
          completed: true,
          scores: [
            { name: 'Bologna', score: '1' },
            { name: 'Inter', score: '2' },
          ],
        },
      ],
    };
  };

  try {
    const service = new OddsApiService('test-key', { store: interceptedTransport });
    const scores = await service.getScores('Serie A', 3);

    assert.equal(scores.length, 1);
    assert.equal(scores[0].matchId, 'scores_bologna_inter');
    assert.equal(scores[0].homeTeam, 'Bologna');
    assert.equal(scores[0].awayTeam, 'Inter');
    assert.equal(scores[0].commenceTime, '2026-05-23T16:00:00Z');
    assert.equal(scores[0].completed, true);
    assert.equal(scores[0].live, false);
    assert.deepEqual(scores[0].bookmakers, []);
    assert.equal(service.getRemainingRequests(), 321);
  } finally {
    axios.get = originalGet;
  }
});
