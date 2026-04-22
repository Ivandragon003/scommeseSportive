const test = require('node:test');
const assert = require('node:assert/strict');
const { OddsProviderCoordinator } = require('../dist/services/odds-provider/OddsProviderCoordinator.js');

const buildMatch = ({
  matchId = 'match_1',
  homeTeam = 'Inter',
  awayTeam = 'Milan',
  commenceTime = '2026-04-20T18:45:00Z',
  bookmakers,
}) => ({
  matchId,
  homeTeam,
  awayTeam,
  commenceTime,
  bookmakers: bookmakers ?? [
    {
      bookmakerKey: 'default',
      bookmakerName: 'Default',
      markets: [
        {
          marketKey: 'h2h',
          outcomes: [
            { name: homeTeam, price: 1.9 },
            { name: 'Draw', price: 3.4 },
            { name: awayTeam, price: 4.2 },
          ],
        },
      ],
    },
  ],
});

const createProvider = (name, options = {}) => ({
  getProviderName: () => name,
  async getCompetitionOdds() {
    if (options.competitionError) throw new Error(options.competitionError);
    return {
      matches: options.competitionMatches ?? [],
      fetchedAt: '2026-04-16T10:00:00.000Z',
      fallbackReason: options.fallbackReason ?? null,
      warnings: options.warnings ?? [],
    };
  },
  async getOddsForFixtures() {
    if (options.fixtureError) throw new Error(options.fixtureError);
    return {
      matches: options.fixtureMatches ?? options.competitionMatches ?? [],
      fetchedAt: '2026-04-16T10:00:00.000Z',
      fallbackReason: options.fallbackReason ?? null,
      warnings: options.warnings ?? [],
    };
  },
  async healthCheck() {
    return {
      provider: name,
      status: options.healthStatus ?? 'healthy',
      checkedAt: '2026-04-16T10:00:00.000Z',
    };
  },
  extractBestOdds(match) {
    const bookmaker = match.bookmakers[0];
    const result = {};
    for (const market of bookmaker.markets ?? []) {
      for (const outcome of market.outcomes ?? []) {
        if (market.marketKey === 'h2h' && outcome.name === match.homeTeam) result.homeWin = outcome.price;
        if (market.marketKey === 'h2h' && outcome.name === 'Draw') result.draw = outcome.price;
        if (market.marketKey === 'h2h' && outcome.name === match.awayTeam) result.awayWin = outcome.price;
        if (market.marketKey === 'totals' && outcome.name === 'Over') result[`over${String(outcome.point).replace('.', '')}`] = outcome.price;
      }
    }
    return result;
  },
  compareBookmakers(match) {
    return Object.fromEntries(
      (match.bookmakers ?? []).map((bookmaker) => [bookmaker.bookmakerName, { markets: (bookmaker.markets ?? []).length }])
    );
  },
  calculateMargin() {
    return null;
  },
  getRuntimeMetadata() {
    return options.runtime ?? {};
  },
  async close() {},
});

test('OddsProviderCoordinator usa Eurobet come primario quando e sano', async () => {
  const eurobet = createProvider('eurobet', {
    competitionMatches: [buildMatch({ bookmakers: [{ bookmakerKey: 'eurobet', bookmakerName: 'Eurobet', markets: [{ marketKey: 'h2h', outcomes: [{ name: 'Inter', price: 1.91 }, { name: 'Draw', price: 3.4 }, { name: 'Milan', price: 4.0 }] }] }] })],
  });
  const fallback = createProvider('odds_api', {
    competitionMatches: [buildMatch({ matchId: 'match_2' })],
    runtime: { remainingRequests: 321 },
  });

  const coordinator = new OddsProviderCoordinator(eurobet, fallback);
  const result = await coordinator.getCompetitionOdds({ competition: 'Serie A' }, { mergeMarkets: false, useFallback: true });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].oddsSource, 'eurobet');
  assert.equal(result.matches[0].isMerged, false);
  assert.equal(result.matches[0].fallbackReason, null);
  assert.equal(result.providerHealth.eurobet.status, 'healthy');
  assert.equal(result.providerHealth.odds_api.status, 'not_checked');
});

test('OddsProviderCoordinator attiva il fallback quando Eurobet fallisce', async () => {
  const eurobet = createProvider('eurobet', {
    fixtureError: 'Eurobet scraping failed',
  });
  const fallback = createProvider('odds_api', {
    fixtureMatches: [buildMatch({ bookmakers: [{ bookmakerKey: 'codere_it', bookmakerName: 'Codere', markets: [{ marketKey: 'h2h', outcomes: [{ name: 'Inter', price: 1.95 }, { name: 'Draw', price: 3.5 }, { name: 'Milan', price: 4.2 }] }] }] })],
    runtime: { remainingRequests: 210 },
  });

  const coordinator = new OddsProviderCoordinator(eurobet, fallback);
  const result = await coordinator.getOddsForFixtures({
    competition: 'Serie A',
    fixtures: [{ homeTeam: 'Inter', awayTeam: 'Milan', commenceTime: '2026-04-20T18:45:00Z' }],
  }, { mergeMarkets: true, useFallback: true });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].oddsSource, 'odds_api');
  assert.match(result.matches[0].fallbackReason, /Provider primario eurobet/i);
  assert.equal(result.providerHealth.eurobet.status, 'unhealthy');
  assert.equal(result.providerHealth.odds_api.status, 'healthy');
  assert.equal(result.providerRuntime.odds_api.remainingRequests, 210);
});

test('OddsProviderCoordinator mergea copertura mercati parziale e mantiene provenance', async () => {
  const eurobet = createProvider('eurobet', {
    fixtureMatches: [
      buildMatch({
        bookmakers: [{
          bookmakerKey: 'eurobet',
          bookmakerName: 'Eurobet',
          markets: [{
            marketKey: 'h2h',
            outcomes: [
              { name: 'Inter', price: 1.9 },
              { name: 'Draw', price: 3.5 },
              { name: 'Milan', price: 4.1 },
            ],
          }],
        }],
      }),
    ],
  });
  const fallback = createProvider('odds_api', {
    fixtureMatches: [
      buildMatch({
        bookmakers: [{
          bookmakerKey: 'codere_it',
          bookmakerName: 'Codere',
          markets: [{
            marketKey: 'totals',
            outcomes: [
              { name: 'Over', price: 1.83, point: 2.5 },
              { name: 'Under', price: 1.97, point: 2.5 },
            ],
          }],
        }],
      }),
    ],
  });

  const coordinator = new OddsProviderCoordinator(eurobet, fallback);
  const result = await coordinator.getOddsForFixtures({
    competition: 'Serie A',
    fixtures: [{ homeTeam: 'Inter', awayTeam: 'Milan', commenceTime: '2026-04-20T18:45:00Z' }],
  }, { mergeMarkets: true, useFallback: true });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].isMerged, true);
  assert.equal(result.matches[0].oddsSource, 'eurobet+odds_api');
  assert.deepEqual(result.matches[0].marketSources.h2h, ['eurobet']);
  assert.deepEqual(result.matches[0].marketSources.totals, ['odds_api']);
  assert.equal(result.matches[0].bestOddsByProvider.eurobet.homeWin, 1.9);
  assert.equal(result.matches[0].bestOddsByProvider.odds_api.over25, 1.83);
});

test('OddsProviderCoordinator mergea senza duplicare outcome identici sullo stesso bookmaker', async () => {
  const sharedBookmaker = {
    bookmakerKey: 'shared',
    bookmakerName: 'SharedBook',
    markets: [{
      marketKey: 'h2h',
      outcomes: [
        { name: 'Inter', price: 1.9 },
        { name: 'Draw', price: 3.5 },
        { name: 'Milan', price: 4.1 },
      ],
    }],
  };

  const eurobet = createProvider('eurobet', {
    fixtureMatches: [buildMatch({ bookmakers: [sharedBookmaker] })],
  });
  const fallback = createProvider('odds_api', {
    fixtureMatches: [buildMatch({ bookmakers: [sharedBookmaker] })],
  });

  const coordinator = new OddsProviderCoordinator(eurobet, fallback);
  const result = await coordinator.getOddsForFixtures({
    competition: 'Serie A',
    fixtures: [{ homeTeam: 'Inter', awayTeam: 'Milan', commenceTime: '2026-04-20T18:45:00Z' }],
  }, { mergeMarkets: true, useFallback: true });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].match.bookmakers.length, 1);
  assert.equal(result.matches[0].match.bookmakers[0].markets[0].outcomes.length, 3);
});

test('OddsProviderCoordinator espone health check healthy con Eurobet attivo', async () => {
  const eurobet = createProvider('eurobet', { healthStatus: 'healthy' });
  const fallback = createProvider('odds_api', { healthStatus: 'healthy' });
  const coordinator = new OddsProviderCoordinator(eurobet, fallback);

  const result = await coordinator.healthCheck({ competition: 'Serie A' });

  assert.equal(result.status, 'healthy');
  assert.equal(result.primaryProvider, 'eurobet');
  assert.equal(result.activeProvider, 'eurobet');
  assert.equal(result.oddsSource, 'eurobet');
  assert.equal(result.fallbackReason, null);
  assert.equal(result.providerHealth.eurobet.status, 'healthy');
  assert.equal(result.providerHealth.odds_api.status, 'healthy');
});

test('OddsProviderCoordinator espone health check degraded con Eurobet degradato ma attivo', async () => {
  const eurobet = createProvider('eurobet', { healthStatus: 'degraded' });
  const fallback = createProvider('odds_api', { healthStatus: 'healthy' });
  const coordinator = new OddsProviderCoordinator(eurobet, fallback);

  const result = await coordinator.healthCheck({ competition: 'Serie A' });

  assert.equal(result.status, 'degraded');
  assert.equal(result.activeProvider, 'eurobet');
  assert.equal(result.oddsSource, 'eurobet');
  assert.equal(result.fallbackReason, null);
  assert.equal(result.providerHealth.eurobet.status, 'degraded');
});

test('OddsProviderCoordinator espone health check con fallback attivo quando Eurobet e giu', async () => {
  const eurobet = createProvider('eurobet', { healthStatus: 'unhealthy' });
  const fallback = createProvider('odds_api', { healthStatus: 'healthy' });
  const coordinator = new OddsProviderCoordinator(eurobet, fallback);

  const result = await coordinator.healthCheck({ competition: 'Serie A' });

  assert.equal(result.status, 'degraded');
  assert.equal(result.activeProvider, 'odds_api');
  assert.equal(result.oddsSource, 'odds_api');
  assert.match(result.fallbackReason, /fallback odds_api attivo/i);
  assert.equal(result.providerHealth.eurobet.status, 'unhealthy');
  assert.equal(result.providerHealth.odds_api.status, 'healthy');
});

test('OddsProviderCoordinator espone provider unavailable quando nessun provider e operativo', async () => {
  const eurobet = createProvider('eurobet', { healthStatus: 'unhealthy' });
  const fallback = createProvider('odds_api', { healthStatus: 'disabled' });
  const coordinator = new OddsProviderCoordinator(eurobet, fallback);

  const result = await coordinator.healthCheck({ competition: 'Serie A' });

  assert.equal(result.status, 'unhealthy');
  assert.equal(result.activeProvider, null);
  assert.equal(result.oddsSource, null);
  assert.match(result.fallbackReason, /non operativo/i);
  assert.equal(result.providerHealth.eurobet.status, 'unhealthy');
  assert.equal(result.providerHealth.odds_api.status, 'disabled');
});
