const test = require('node:test');
const assert = require('node:assert/strict');
const { AppPredictionOddsService } = require('../dist/services/AppPredictionOddsService');
const { OddsApiService } = require('../dist/services/OddsApiService');
const { enabledMatchEventMarkets } = require('../dist/services/OddsMarketPolicy');

const now = '2026-10-30T10:00:00.000Z';
const kickoff = '2026-10-30T19:00:00.000Z';
const row = { competition: 'Serie A', date: kickoff, home_team_name: 'Inter', away_team_name: 'Milan' };
const market = (marketKey, outcomes, extra = {}) => ({ marketKey, outcomes, updatedAt: now, ...extra });
const pair = (point, description) => [{ name: 'Over', price: 1.9, point, description },
  { name: 'Under', price: 1.95, point, description }];
const bookmaker = (markets, extra = {}) => ({ bookmakerKey: 'book', bookmakerName: 'Real Book', updatedAt: now, markets, ...extra });
const event = (bookmakers, extra = {}) => ({ matchId: 'odds_e1', homeTeam: 'Inter', awayTeam: 'Milan',
  commenceTime: kickoff, provider: 'odds_api', capturedAt: now, bookmakers, ...extra });
function fixture(events) {
  const calls = [];
  const mapper = new OddsApiService('mapping-only-no-network');
  const provider = { getOddsForFixtures: async (request) => { calls.push(request); return {
    matches: events, warnings: [], fetchedAt: now, fallbackReason: null }; },
  compareBookmakers: (match) => mapper.compareBookmakers(match), getRuntimeMetadata: () => ({ remainingRequests: 200 }) };
  return { calls, service: new AppPredictionOddsService({}, { clock: () => new Date(now), provider }) };
}

test('A loads the existing app market policy including real cards, goal derivatives and supplied shots', async () => {
  const f = fixture([event([bookmaker([
    market('h2h', [{ name: 'Inter', price: 2 }, { name: 'Draw', price: 3.5 }, { name: 'Milan', price: 4 }]),
    market('alternate_totals_cards', pair(4.5)),
    market('totals', pair(24.5, 'Total Shots')),
    market('btts', [{ name: 'Yes', price: 1.8 }, { name: 'No', price: 2.1 }]),
    market('double_chance', [{ name: '1X', price: 1.3 }, { name: 'X2', price: 1.7 }, { name: '12', price: 1.5 }]),
    market('draw_no_bet', [{ name: 'Inter', price: 1.6 }, { name: 'Milan', price: 2.3 }]),
  ])])]);
  const result = await f.service.load(row);
  assert.deepEqual(f.calls[0].markets, ['h2h', 'totals', 'spreads']);
  assert.deepEqual(f.calls[0].extraEventMarkets, enabledMatchEventMarkets());
  for (const selection of ['cards_total_over_4.5', 'shots_total_over_24.5', 'btts', 'double_chance_1x', 'dnb_home']) {
    assert.ok(result.quotes.some((quote) => quote.selection === selection), selection);
    assert.ok(result.sharedOdds.odds[selection] > 1);
    assert.equal(result.sharedOdds.bookmakerBySelection[selection], 'Real Book');
  }
  for (const selection of ['cardsTotalOver45', 'shotsOver245']) {
    const alias = result.quotes.find((quote) => quote.selection === selection);
    assert.ok(alias, selection);
    assert.equal(alias.odds, 1.9); assert.equal(alias.bookmaker, 'Real Book');
    assert.equal(alias.capturedAt, now); assert.equal(alias.updatedAt, now);
    assert.equal(result.sharedOdds.odds[selection], undefined, 'only the predictor creates the engine aliases');
  }
  assert.ok(result.quotes.every((quote) => quote.source === 'odds_api' && quote.priceType === 'prematch'));
  assert.equal(result.metadata.providerEventId, 'odds_e1');
});

test('stale, future, missing-time and invalid prices never reach A; captures remain from each market response', async () => {
  const capturedAt = '2026-10-30T09:59:30.000Z';
  const updatedAt = '2026-10-30T09:59:00.000Z';
  const f = fixture([event([bookmaker([
    market('alternate_totals_cards', pair(4.5), { capturedAt, updatedAt }),
    market('totals', pair(2.5), { updatedAt: '2026-10-30T09:50:00.000Z' }),
    market('alternate_totals', pair(3.5), { updatedAt: '2026-10-30T10:00:01.000Z' }),
    market('btts', [{ name: 'Yes', price: 1 }, { name: 'No', price: NaN }]),
  ])])]);
  const result = await f.service.load(row);
  assert.deepEqual(Object.keys(result.sharedOdds.odds).sort(), ['cards_total_over_4.5', 'cards_total_under_4.5']);
  assert.equal(result.sharedOdds.capturedAt, capturedAt);
  assert.ok(result.quotes.every((quote) => quote.capturedAt === capturedAt && quote.updatedAt === updatedAt));
  const missing = fixture([event([bookmaker([market('alternate_totals_cards', pair(4.5), { updatedAt: undefined })],
    { updatedAt: undefined })])]);
  assert.deepEqual((await missing.service.load(row)).sharedOdds.odds, {});
});

test('coherent selection uses one bookmaker and one source sheet for both sides of a market', async () => {
  const earlier = '2026-10-30T09:59:00.000Z';
  const f = fixture([event([
    bookmaker([
      market('totals', [{ name: 'Over', price: 4, point: 2.5 }], { updatedAt: earlier }),
      market('alternate_totals', [{ name: 'Under', price: 4, point: 2.5 }]),
    ]),
    bookmaker([market('totals', pair(2.5))], { bookmakerKey: 'other', bookmakerName: 'Other Book' }),
  ])]);
  const result = await f.service.load(row);
  assert.equal(result.sharedOdds.bookmakerBySelection.over25, 'Other Book');
  assert.equal(result.sharedOdds.bookmakerBySelection.under25, 'Other Book');
  assert.equal(result.sharedOdds.odds.over25, 1.9);
  assert.ok(result.quotes.every((quote) => quote.bookmaker === 'Other Book' && quote.updatedAt === now));
});

test('A preserves fresh raw player prices for its existing separate props pipeline', async () => {
  const f = fixture([event([bookmaker([market('player_shots', pair(2.5, 'Lautaro Martinez'))])])]);
  const result = await f.service.load(row);
  assert.equal(result.sharedOdds.odds['player_shots_lautaro_martinez_over_2.5'], 1.9);
  assert.equal(result.sharedOdds.bookmakerBySelection['player_shots_lautaro_martinez_over_2.5'], 'Real Book');
  assert.equal(result.quotes.length, 0, 'player props stay outside the single team recommendation');
});

test('unmatched, inverted, ambiguous, moved, live and completed fixtures cannot authorize app prices', async () => {
  const base = event([bookmaker([market('alternate_totals_cards', pair(4.5))])]);
  const cases = [[], [{ ...base, homeTeam: 'Roma' }], [{ ...base, homeTeam: 'Milan', awayTeam: 'Inter' }],
    [base, { ...base, matchId: 'odds_e2' }], [{ ...base, commenceTime: '2026-10-30T20:00:00.000Z' }],
    [{ ...base, live: true }], [{ ...base, completed: true }], [{ ...base, provider: 'synthetic_model' }]];
  for (const events of cases) {
    const result = await fixture(events).service.load(row);
    assert.equal(result.quotes.length, 0);
    assert.deepEqual(result.sharedOdds.odds, {});
  }
});

test('the production loader shares the persistent cache and keeps event-network opt-in without losing core prices', async () => {
  const previousKey = process.env.ODDS_API_KEY;
  const previousExtra = process.env.ODDS_EXTRA_EVENT_NETWORK_ENABLED;
  process.env.ODDS_API_KEY = 'test-key-with-no-transport';
  process.env.ODDS_EXTRA_EVENT_NETWORK_ENABLED = 'false';
  const requests = [];
  const core = { id: 'e1', home_team: 'Inter', away_team: 'Milan', commence_time: kickoff,
    bookmakers: [{ key: 'real', title: 'Real Book', last_update: now, markets: [{ key: 'h2h', last_update: now,
      outcomes: [{ name: 'Inter', price: 2 }, { name: 'Draw', price: 3.5 }, { name: 'Milan', price: 4 }] }] }] };
  const oddsRequests = { execute: async (request) => {
    requests.push(request);
    if (request.endpoint.includes('/events/')) throw Object.assign(new Error('odds_cache_only'), { code: 'odds_cache_only' });
    return { data: [core], headers: {}, fetchedAt: now, cacheHit: true };
  } };
  try {
    const result = await new AppPredictionOddsService({ oddsRequests }, { clock: () => new Date(now) }).load(row);
    assert.equal(result.sharedOdds.odds.homeWin, 2);
    assert.equal(result.sharedOdds.capturedAt, now);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].allowNetwork, true);
    assert.equal(requests[1].allowNetwork, false);
    assert.equal(requests[0].operation, 'nightly');
    assert.equal(requests[1].operation, 'nightly_extra');
    assert.ok(requests.every((request) => request.priority === 'essential' && request.cacheMaxAgeMs === 300000));
    assert.ok(result.metadata.warnings.includes('odds_cache_only'));
  } finally {
    if (previousKey === undefined) delete process.env.ODDS_API_KEY; else process.env.ODDS_API_KEY = previousKey;
    if (previousExtra === undefined) delete process.env.ODDS_EXTRA_EVENT_NETWORK_ENABLED;
    else process.env.ODDS_EXTRA_EVENT_NETWORK_ENABLED = previousExtra;
  }
});

test('the nightly event opt-in admits real cards through the existing provider and persistent request manager', async () => {
  const previousKey = process.env.ODDS_API_KEY;
  const previousExtra = process.env.ODDS_EXTRA_EVENT_NETWORK_ENABLED;
  process.env.ODDS_API_KEY = 'test-key-with-no-transport';
  process.env.ODDS_EXTRA_EVENT_NETWORK_ENABLED = 'true';
  const requests = [];
  const core = { id: 'e1', home_team: 'Inter', away_team: 'Milan', commence_time: kickoff,
    bookmakers: [{ key: 'real', title: 'Real Book', last_update: now, markets: [{ key: 'h2h', last_update: now,
      outcomes: [{ name: 'Inter', price: 2 }, { name: 'Draw', price: 3.5 }, { name: 'Milan', price: 4 }] }] }] };
  const extra = { ...core, bookmakers: [{ ...core.bookmakers[0], markets: [
    { key: 'alternate_totals_cards', last_update: now, outcomes: pair(4.5) },
  ] }] };
  const oddsRequests = { execute: async (request) => {
    requests.push(request);
    return { data: request.endpoint.includes('/events/') ? extra : [core],
      headers: {}, fetchedAt: now, cacheHit: false };
  } };
  try {
    const result = await new AppPredictionOddsService({ oddsRequests }, { clock: () => new Date(now) }).load(row);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.allowNetwork && request.priority === 'essential'));
    assert.ok(requests[1].markets.includes('alternate_totals_cards'));
    assert.equal(result.sharedOdds.odds['cards_total_over_4.5'], 1.9);
    assert.ok(result.quotes.some((quote) => quote.selection === 'cardsTotalOver45'
      && quote.market === 'cards_total' && quote.updatedAt === now && quote.bookmaker === 'Real Book'));
  } finally {
    if (previousKey === undefined) delete process.env.ODDS_API_KEY; else process.env.ODDS_API_KEY = previousKey;
    if (previousExtra === undefined) delete process.env.ODDS_EXTRA_EVENT_NETWORK_ENABLED;
    else process.env.ODDS_EXTRA_EVENT_NETWORK_ENABLED = previousExtra;
  }
});
