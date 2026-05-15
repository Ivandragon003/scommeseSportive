const test = require('node:test');
const assert = require('node:assert/strict');
const { OddsApiProvider } = require('../dist/services/odds-provider/OddsApiProvider.js');

const baseMatch = {
  matchId: 'odds_event_1',
  homeTeam: 'Inter',
  awayTeam: 'Milan',
  commenceTime: '2026-04-25T18:45:00.000Z',
  bookmakers: [
    {
      bookmakerKey: 'pinnacle',
      bookmakerName: 'Pinnacle',
      markets: [
        {
          marketKey: 'h2h',
          outcomes: [
            { name: 'Inter', price: 1.9 },
            { name: 'Draw', price: 3.4 },
            { name: 'Milan', price: 4.2 },
          ],
        },
      ],
    },
  ],
};

const eventMarket = (marketKey) => ({
  ...baseMatch,
  bookmakers: [
    {
      bookmakerKey: 'pinnacle',
      bookmakerName: 'Pinnacle',
      markets: [
        {
          marketKey,
          outcomes: [
            { name: 'Over', price: 1.83, point: marketKey === 'corners' ? 9.5 : 25.5, description: marketKey },
          ],
        },
      ],
    },
  ],
});

test('OddsApiProvider degrada i mercati evento singolarmente se il batch esteso fallisce', async () => {
  const provider = new OddsApiProvider('test-key');
  provider.service = {
    getRemainingRequests: () => 499,
    getOdds: async () => [baseMatch],
    getEventOdds: async (_competition, _eventId, markets) => {
      if (markets.length > 1) throw new Error('unsupported market in batch');
      if (markets[0] === 'fouls') throw new Error('fouls unavailable');
      return eventMarket(markets[0]);
    },
  };

  const result = await provider.getOddsForFixtures({
    competition: 'Serie A',
    fixtures: [{ homeTeam: 'Inter', awayTeam: 'Milan', commenceTime: '2026-04-25T18:45:00.000Z' }],
    markets: ['h2h', 'totals'],
    extraEventMarkets: ['shots', 'corners', 'fouls'],
  });

  const loadedMarketKeys = result.matches[0].bookmakers[0].markets.map((market) => market.marketKey);
  assert.ok(loadedMarketKeys.includes('h2h'));
  assert.ok(loadedMarketKeys.includes('shots'));
  assert.ok(loadedMarketKeys.includes('corners'));
  assert.ok(!loadedMarketKeys.includes('fouls'));
  assert.deepEqual(result.details.extraEventMarketsLoaded, ['shots', 'corners']);
  assert.match(result.warnings.join(' '), /batch non disponibili/i);
  assert.match(result.warnings.join(' '), /fouls unavailable/i);
});
