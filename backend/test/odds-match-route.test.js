const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes.js');
const { OddsProviderCoordinator } = require('../dist/services/odds-provider/OddsProviderCoordinator.js');
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

const getJson = async (baseUrl, path) => {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    json: await response.json(),
  };
};

const withProviderEnv = (nextEnv, fn) => {
  const keys = ['ODDS_API_KEY', 'THE_ODDS_API_KEY', 'ODDS_PRIMARY_PROVIDER', 'SKIP_EUROBET_SCRAPER'];
  for (const key of Object.keys(nextEnv)) {
    if (!keys.includes(key)) keys.push(key);
  }
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const restore = () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };

  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, nextEnv);
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
};

const createRouteProvider = (name, options = {}) => ({
  getProviderName: () => name,
  async getCompetitionOdds() {
    return {
      matches: [],
      fetchedAt: fixedFetchedAt,
      fallbackReason: null,
      warnings: [],
    };
  },
  async getOddsForFixtures() {
    options.calls.count += 1;
    if (options.calls.count === 1 && options.firstNeverResolves) {
      return new Promise(() => {});
    }

    return {
      matches: options.matchesAfterFirst ?? [],
      fetchedAt: fixedFetchedAt,
      fallbackReason: options.fallbackReason ?? null,
      warnings: options.warnings ?? [],
    };
  },
  async healthCheck() {
    return {
      provider: name,
      status: 'healthy',
      checkedAt: fixedFetchedAt,
    };
  },
  extractBestOdds(match) {
    const result = {};
    for (const bookmaker of match.bookmakers ?? []) {
      for (const market of bookmaker.markets ?? []) {
        for (const outcome of market.outcomes ?? []) {
          if (market.marketKey === 'h2h' && outcome.name === match.homeTeam) result.homeWin = outcome.price;
          if (market.marketKey === 'h2h' && outcome.name === 'Draw') result.draw = outcome.price;
          if (market.marketKey === 'h2h' && outcome.name === match.awayTeam) result.awayWin = outcome.price;
        }
      }
    }
    return result;
  },
  compareBookmakers() {
    return {};
  },
  calculateMargin() {
    return null;
  },
  getRuntimeMetadata() {
    return {};
  },
  async close() {},
});

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
            providerMatches: {
              odds_api: oddsMatch,
              eurobet: {
                ...oddsMatch,
                matchId: 'eurobet_event_456',
                eventAlias: 'calcio/it-serie-a/inter-milan',
                meetingAlias: 'it-serie-a',
                loadedGroupAliases: ['base', 'statistiche-partita'],
                unavailableGroupAliases: ['speciali-partita'],
              },
            },
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
            bestOddsByProvider: { odds_api: selectedOdds, eurobet: { homeWin: 1.9 } },
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
    assert.deepEqual(json.data.loadedGroupAliases, ['base', 'statistiche-partita']);
    assert.deepEqual(json.data.unavailableGroupAliases, ['speciali-partita']);
    assert.equal(json.data.marketCount, 2);
    assert.equal(json.data.selectedOddsCount, 5);
    assert.equal(json.data.eurobetOddsCount, 1);
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
    assert.deepEqual(json.data.loadedGroupAliases, []);
    assert.deepEqual(json.data.unavailableGroupAliases, []);
    assert.equal(json.data.marketCount, 0);
    assert.equal(json.data.selectedOddsCount, 0);
    assert.equal(json.data.eurobetOddsCount, 0);
    assert.equal(json.data.candidateCount, 2);
    assert.equal(json.data.requestedFixture.homeTeam, 'Inter');
    assert.match(json.data.message, /Quote bookmaker non trovate/i);
    assert.match(json.data.warnings.join(' '), /Fixture non trovate/i);
    assert.equal(snapshots.length, 0);
  } finally {
    await server.close();
  }
});

test('/scraper/odds/match non salva in cache una risposta found=false', async () => {
  const snapshots = [];
  const selectedOdds = { homeWin: 1.91, draw: 3.45, awayWin: 4.2 };
  let calls = 0;
  const coordinator = {
    async getOddsForFixtures() {
      calls += 1;
      if (calls === 1) {
        return {
          primaryProvider: 'odds_api',
          fetchedAt: fixedFetchedAt,
          fallbackReason: 'Timeout provider',
          providerHealth: {
            odds_api: {
              provider: 'odds_api',
              status: 'degraded',
              checkedAt: fixedFetchedAt,
              message: 'Timeout provider',
            },
          },
          providerRuntime: {
            odds_api: {
              remainingRequests: 498,
              fetchDetails: { candidateCount: 0, matchesReceived: 0 },
            },
          },
          isMerged: false,
          warnings: ['Timeout provider'],
          matches: [],
        };
      }

      const oddsMatch = buildOddsApiMatch();
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
            remainingRequests: 497,
            fetchDetails: { candidateCount: 1, matchesReceived: 1 },
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
            marketSources: { h2h: ['odds_api'] },
            bestOddsByProvider: { odds_api: selectedOdds },
            bookmakerComparisonByProvider: { odds_api: { Pinnacle: selectedOdds } },
            marginsByProvider: { odds_api: {} },
          },
        ],
      };
    },
  };

  const server = await startRouter({ coordinator, snapshots });
  const body = {
    matchId: 'understat_match_retry_after_timeout',
    competition: 'Serie A',
    homeTeam: 'Inter',
    awayTeam: 'Milan',
    commenceTime: '2026-04-25T18:45:00.000Z',
  };

  try {
    const first = await postMatchOdds(server.baseUrl, body);
    const second = await postMatchOdds(server.baseUrl, body);

    assert.equal(first.status, 200);
    assert.equal(first.json.data.found, false);
    assert.equal(second.status, 200);
    assert.equal(second.json.data.found, true);
    assert.deepEqual(second.json.data.selectedOdds, selectedOdds);
    assert.equal(calls, 2);
  } finally {
    await server.close();
  }
});

test('/scraper/odds/match risponde found=false dopo timeout primario senza fallback e non cachea', async () => {
  await withProviderEnv({
    ODDS_PROVIDER_MATCH_TIMEOUT_MS: '25',
    EUROBET_MATCH_TIMEOUT_MS: '1000',
  }, async () => {
    const snapshots = [];
    const calls = { count: 0 };
    const provider = createRouteProvider('eurobet', {
      calls,
      firstNeverResolves: true,
      matchesAfterFirst: [buildOddsApiMatch()],
    });
    const coordinator = new OddsProviderCoordinator(provider, null);
    const server = await startRouter({
      coordinator,
      snapshots,
      bundleOverrides: {
        primaryProviderName: 'eurobet',
        fallbackProviderName: null,
        skipEurobet: false,
      },
    });
    const body = {
      matchId: 'understat_match_timeout_no_fallback',
      competition: 'Serie A',
      homeTeam: 'Inter',
      awayTeam: 'Milan',
      commenceTime: '2026-04-25T18:45:00.000Z',
    };

    try {
      const first = await postMatchOdds(server.baseUrl, body);
      const second = await postMatchOdds(server.baseUrl, body);

      assert.equal(first.status, 200);
      assert.equal(first.json.success, true);
      assert.equal(first.json.data.found, false);
      assert.match(first.json.data.warnings.join(' '), /Provider eurobet timeout after 25ms/i);
      assert.equal(first.json.data.primaryProvider, 'eurobet');
      assert.equal(first.json.data.fallbackProvider, null);
      assert.equal(second.status, 200);
      assert.equal(second.json.data.found, true);
      assert.equal(second.json.data.source, 'eurobet');
      assert.equal(calls.count, 2);
      assert.equal(snapshots.length, 1);
    } finally {
      await server.close();
    }
  });
});

test('/scraper/odds/debug-config espone configurazione runtime senza segreti', async () => {
  await withProviderEnv({
    ODDS_API_KEY: 'super-secret-key',
    ODDS_PRIMARY_PROVIDER: 'eurobet',
    SKIP_EUROBET_SCRAPER: 'false',
    EUROBET_MATCH_TIMEOUT_MS: '180000',
    ODDS_PROVIDER_MATCH_TIMEOUT_MS: '45000',
    ODDS_EVENT_TIMEOUT_MS: '60000',
    EUROBET_BROWSER_HEADLESS: 'true',
    EUROBET_PERSISTENT_PROFILE_ENABLED: 'true',
  }, async () => {
    const snapshots = [];
    const coordinator = { async getOddsForFixtures() { return { matches: [] }; } };
    const server = await startRouter({
      coordinator,
      snapshots,
      bundleOverrides: {
        primaryProviderName: 'eurobet',
        fallbackProviderName: 'odds_api',
        apiKey: 'super-secret-key',
        skipEurobet: false,
      },
    });

    try {
      const { status, json } = await getJson(server.baseUrl, '/scraper/odds/debug-config');
      const serialized = JSON.stringify(json);

      assert.equal(status, 200);
      assert.equal(json.success, true);
      assert.equal(json.data.hasOddsApiKey, true);
      assert.equal(json.data.ODDS_PRIMARY_PROVIDER, 'eurobet');
      assert.equal(json.data.SKIP_EUROBET_SCRAPER, false);
      assert.equal(json.data.primaryProvider, 'eurobet');
      assert.equal(json.data.fallbackProvider, 'odds_api');
      assert.equal(json.data.EUROBET_MATCH_TIMEOUT_MS, 180000);
      assert.equal(json.data.ODDS_PROVIDER_MATCH_TIMEOUT_MS, 45000);
      assert.equal(json.data.ODDS_EVENT_TIMEOUT_MS, 60000);
      assert.equal(serialized.includes('super-secret-key'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(json.data, 'ODDS_API_KEY'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(json.data, 'THE_ODDS_API_KEY'), false);
    } finally {
      await server.close();
    }
  });
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
