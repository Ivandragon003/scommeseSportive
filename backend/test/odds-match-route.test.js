const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes.js');
const {
  getConfiguredFallbackProviderName,
  getConfiguredPrimaryProviderName,
} = require('../dist/services/odds-provider/providerRuntimeConfig.js');

const fixedFetchedAt = '2026-04-25T12:00:00.000Z';

const buildOddsApiMatch = () => ({
  matchId: 'odds_event_123',
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
            { name: 'Inter', price: 1.91 },
            { name: 'Draw', price: 3.45 },
            { name: 'Milan', price: 4.2 },
          ],
        },
        {
          marketKey: 'totals',
          outcomes: [
            { name: 'Over', price: 1.83, point: 2.5 },
            { name: 'Under', price: 2.05, point: 2.5 },
          ],
        },
      ],
    },
  ],
});

const startRouter = async ({ coordinator, bundleOverrides = {}, snapshots }) => {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      saveOddsSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
      },
      findMatchByTeams: async () => null,
    },
    svc: {},
    createOddsProviderCoordinatorBundle: () => ({
      coordinator,
      primaryProviderName: 'odds_api',
      fallbackProviderName: null,
      apiKey: 'test-odds-api-key',
      skipEurobet: true,
      ...bundleOverrides,
    }),
  }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const postMatchOdds = async (baseUrl, body) => {
  const response = await fetch(`${baseUrl}/scraper/odds/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: await response.json(),
  };
};

const withProviderEnv = (nextEnv, fn) => {
  const keys = ['ODDS_API_KEY', 'THE_ODDS_API_KEY', 'ODDS_PRIMARY_PROVIDER', 'SKIP_EUROBET_SCRAPER'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, nextEnv);
    fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
};

test('provider runtime defaulta a Eurobet quando Eurobet non e skippato e Odds API non e configurata', () => {
  withProviderEnv({ SKIP_EUROBET_SCRAPER: 'false' }, () => {
    assert.equal(getConfiguredPrimaryProviderName(), 'eurobet');
    assert.equal(getConfiguredFallbackProviderName(), null);
  });
});

test('provider runtime rispetta ODDS_PRIMARY_PROVIDER=eurobet', () => {
  withProviderEnv({
    ODDS_PRIMARY_PROVIDER: 'eurobet',
    SKIP_EUROBET_SCRAPER: 'false',
    ODDS_API_KEY: 'configured',
  }, () => {
    assert.equal(getConfiguredPrimaryProviderName(), 'eurobet');
    assert.equal(getConfiguredFallbackProviderName(), 'odds_api');
  });
});

test('provider runtime rispetta ODDS_PRIMARY_PROVIDER=odds_api', () => {
  withProviderEnv({
    ODDS_PRIMARY_PROVIDER: 'odds_api',
    SKIP_EUROBET_SCRAPER: 'false',
    ODDS_API_KEY: 'configured',
  }, () => {
    assert.equal(getConfiguredPrimaryProviderName(), 'odds_api');
    assert.equal(getConfiguredFallbackProviderName(), 'eurobet');
  });
});

test('provider runtime usa Odds API quando Eurobet e skippato e chiave configurata', () => {
  withProviderEnv({
    SKIP_EUROBET_SCRAPER: 'true',
    ODDS_API_KEY: 'configured',
  }, () => {
    assert.equal(getConfiguredPrimaryProviderName(), 'odds_api');
    assert.equal(getConfiguredFallbackProviderName(), null);
  });
});

test('/scraper/odds/match ritorna selectedOdds da Odds API e salva snapshot con match locale', async () => {
  const snapshots = [];
  const oddsMatch = buildOddsApiMatch();
  const selectedOdds = {
    homeWin: 1.91,
    draw: 3.45,
    awayWin: 4.2,
    over25: 1.83,
    under25: 2.05,
  };
  const requests = [];
  const coordinator = {
    async getOddsForFixtures(request) {
      requests.push(request);
      return {
        primaryProvider: 'odds_api',
        fetchedAt: fixedFetchedAt,
        fallbackReason: null,
        providerHealth: {
          odds_api: {
            provider: 'odds_api',
            status: 'healthy',
            checkedAt: fixedFetchedAt,
          },
        },
        providerRuntime: {
          odds_api: {
            remainingRequests: 499,
            fetchDetails: {
              marketsUsed: ['h2h', 'totals', 'spreads'],
              candidateCount: 1,
              matchesReceived: 1,
            },
          },
        },
        isMerged: false,
        warnings: [],
        matches: [
          {
            match: oddsMatch,
            providerMatches: { odds_api: oddsMatch },
            oddsSource: 'odds_api',
            fallbackReason: null,
            providerHealth: {
              odds_api: {
                provider: 'odds_api',
                status: 'healthy',
                checkedAt: fixedFetchedAt,
              },
            },
            fetchedAt: fixedFetchedAt,
            isMerged: false,
            marketSources: { h2h: ['odds_api'], totals: ['odds_api'] },
            bestOddsByProvider: { odds_api: selectedOdds },
            bookmakerComparisonByProvider: { odds_api: { Pinnacle: selectedOdds } },
            marginsByProvider: { odds_api: {} },
          },
        ],
      };
    },
  };

  const server = await startRouter({ coordinator, snapshots });
  try {
    const { status, json } = await postMatchOdds(server.baseUrl, {
      matchId: 'understat_match_1',
      competition: 'Serie A',
      homeTeam: 'Inter',
      awayTeam: 'Milan',
      commenceTime: '2026-04-25T18:45:00.000Z',
    });

    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.found, true);
    assert.equal(json.data.source, 'odds_api');
    assert.equal(json.data.oddsSource, 'odds_api');
    assert.equal(json.data.primaryProvider, 'odds_api');
    assert.equal(json.data.fallbackProvider, null);
    assert.equal(json.data.selectedProvider, 'odds_api');
    assert.ok(json.data.timeoutMs >= 45000);
    assert.equal(json.data.providerHealth.odds_api.status, 'healthy');
    assert.deepEqual(json.data.warnings, []);
    assert.deepEqual(json.data.selectedOdds, selectedOdds);
    assert.deepEqual(json.data.fallbackOdds, {});
    assert.equal(json.data.providerMatchId, 'event_123');
    assert.equal(json.data.matchedHomeTeam, 'Inter');
    assert.equal(json.data.matchedAwayTeam, 'Milan');
    assert.ok(requests[0].markets.includes('double_chance'));
    assert.ok(requests[0].markets.includes('draw_no_bet'));
    assert.ok(requests[0].markets.includes('alternate_totals'));
    assert.ok(requests[0].fallbackMarkets.includes('h2h'));
    assert.ok(requests[0].fallbackMarkets.includes('totals'));
    assert.ok(requests[0].extraEventMarkets.includes('player_shots'));
    assert.ok(requests[0].extraEventMarkets.includes('shots_on_target'));
    assert.ok(requests[0].extraEventMarkets.includes('corners'));
    assert.ok(requests[0].extraEventMarkets.includes('cards'));
    assert.ok(requests[0].extraEventMarkets.includes('fouls'));
    assert.equal(requests[0].includeExtendedGroups, true);

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].matchId, 'understat_match_1');
    assert.equal(snapshots[0].oddsProviderMatchId, 'event_123');
    assert.equal(snapshots[0].source, 'odds_api');
    assert.deepEqual(snapshots[0].selectedOdds, selectedOdds);
    assert.deepEqual(snapshots[0].liveSelectedOdds, selectedOdds);
    assert.equal(snapshots[0].usedFallbackBookmaker, false);
  } finally {
    await server.close();
  }
});

test('/scraper/odds/match ritorna diagnostica quando Odds API non trova la fixture', async () => {
  const snapshots = [];
  const coordinator = {
    async getOddsForFixtures() {
      return {
        primaryProvider: 'odds_api',
        fetchedAt: fixedFetchedAt,
        fallbackReason: 'Fixture non trovata',
        providerHealth: {
          odds_api: {
            provider: 'odds_api',
            status: 'degraded',
            checkedAt: fixedFetchedAt,
            message: 'Nessun match compatibile',
          },
        },
        providerRuntime: {
          odds_api: {
            remainingRequests: 498,
            fetchDetails: {
              marketsUsed: ['h2h', 'totals', 'spreads'],
              candidateCount: 2,
              matchesReceived: 2,
              fixtureDiagnostics: [
                {
                  matched: false,
                  candidateCount: 2,
                  bestScore: 0.7,
                  warnings: ['home_away_inverted_candidate'],
                  candidates: [
                    {
                      candidate: {
                        matchId: 'odds_other_1',
                        homeTeam: 'Roma',
                        awayTeam: 'Lazio',
                        commenceTime: '2026-04-25T18:45:00.000Z',
                      },
                      score: 0.7,
                      reason: 'team_pair_weak',
                    },
                  ],
                },
              ],
            },
          },
        },
        isMerged: false,
        warnings: ['Fixture non trovate in Odds API: 1/1'],
        matches: [],
      };
    },
  };

  const server = await startRouter({ coordinator, snapshots });
  try {
    const { status, json } = await postMatchOdds(server.baseUrl, {
      matchId: 'understat_match_missing',
      competition: 'Serie A',
      homeTeam: 'Inter',
      awayTeam: 'Milan',
      commenceTime: '2026-04-25T18:45:00.000Z',
    });

    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.found, false);
    assert.equal(json.data.source, 'odds_api');
    assert.equal(json.data.primaryProvider, 'odds_api');
    assert.equal(json.data.fallbackProvider, null);
    assert.equal(json.data.selectedProvider, null);
    assert.ok(json.data.timeoutMs >= 45000);
    assert.equal(json.data.providerHealth.odds_api.status, 'degraded');
    assert.equal(json.data.candidateCount, 2);
    assert.equal(json.data.requestedFixture.homeTeam, 'Inter');
    assert.match(json.data.message, /Quote bookmaker non trovate/i);
    assert.match(json.data.warnings.join(' '), /Fixture non trovate/i);
    assert.equal(snapshots.length, 0);
  } finally {
    await server.close();
  }
});

test('/scraper/odds/match ritorna errore chiaro se ODDS_API_KEY manca con Odds API primario', async () => {
  const snapshots = [];
  let called = false;
  const coordinator = {
    async getOddsForFixtures() {
      called = true;
      return { matches: [] };
    },
  };

  const server = await startRouter({
    coordinator,
    snapshots,
    bundleOverrides: {
      apiKey: '',
      primaryProviderName: 'odds_api',
      fallbackProviderName: null,
    },
  });
  try {
    const { status, json } = await postMatchOdds(server.baseUrl, {
      matchId: 'understat_match_no_key',
      competition: 'Serie A',
      homeTeam: 'Inter',
      awayTeam: 'Milan',
      commenceTime: '2026-04-25T18:45:00.000Z',
    });

    assert.equal(status, 503);
    assert.equal(json.success, false);
    assert.match(json.error, /ODDS_API_KEY non configurata/i);
    assert.equal(json.data.found, false);
    assert.equal(json.data.source, 'odds_api');
    assert.equal(json.data.primaryProvider, 'odds_api');
    assert.equal(json.data.fallbackProvider, null);
    assert.equal(json.data.selectedProvider, null);
    assert.ok(json.data.timeoutMs >= 45000);
    assert.equal(json.data.providerHealth.odds_api.status, 'disabled');
    assert.match(json.data.warnings.join(' '), /ODDS_API_KEY non configurata/i);
    assert.equal(called, false);
    assert.equal(snapshots.length, 0);
  } finally {
    await server.close();
  }
});
