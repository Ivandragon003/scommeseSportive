const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes.js');
const { ValueBettingEngine } = require('../dist/models/value/ValueBettingEngine.js');

const fixedDate = '2026-05-23T16:00:00.000Z';
const fixedFetchedAt = '2026-05-23T10:00:00.000Z';

const buildMatchRows = (count) => Array.from({ length: count }, (_, index) => ({
  match_id: `match_${index + 1}`,
  home_team_id: `home_${index + 1}`,
  away_team_id: `away_${index + 1}`,
  home_team_name: `Home ${index + 1}`,
  away_team_name: `Away ${index + 1}`,
  competition: 'La Liga',
  date: fixedDate,
  home_goals: null,
  away_goals: null,
}));

const buildCoordinatedMatches = (matches) => matches.map((match, index) => {
  const oddsMatch = {
    matchId: `odds_${match.match_id}`,
    homeTeam: match.home_team_name,
    awayTeam: match.away_team_name,
    commenceTime: match.date,
    bookmakers: [],
  };
  const odds = {
    homeWin: Number((1.8 + index * 0.01).toFixed(2)),
    over25: 2.05,
    under25: 1.82,
    bttsNo: 2.1,
    yellowOver35: 1.95,
    yellowUnder55: 1.72,
  };
  return {
    match: oddsMatch,
    providerMatches: { odds_api: oddsMatch },
    oddsSource: 'odds_api',
    fallbackReason: null,
    providerHealth: {
      odds_api: { provider: 'odds_api', status: 'healthy', checkedAt: fixedFetchedAt },
    },
    fetchedAt: fixedFetchedAt,
    isMerged: false,
    marketSources: { h2h: ['odds_api'] },
    bestOddsByProvider: { odds_api: odds },
    bookmakerComparisonByProvider: { odds_api: {} },
    marginsByProvider: { odds_api: {} },
  };
});

const buildOpportunity = (matchId, overrides = {}) => ({
  matchId,
  selection: 'homeWin',
  marketName: '1X2 - Casa',
  marketCategory: 'goal_1x2',
  marketTier: 'CORE',
  selectionFamily: 'goal_1x2',
  ourProbability: 58,
  bookmakerOdds: 1.85,
  impliedProbability: 54,
  impliedProbabilityNoVig: 52,
  expectedValue: 7.3,
  kellyFraction: 1.4,
  suggestedStakePercent: 1.1,
  confidence: 'HIGH',
  isValueBet: true,
  edge: 4,
  edgeNoVig: 6,
  rankingScore: 0.26,
  ...overrides,
});

const startDailySlateRouter = async ({ matches, opportunitiesByMatchId }) => {
  const engine = new ValueBettingEngine();
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      getUpcomingMatches: async () => matches,
    },
    svc: {
      predict: async (request) => ({
        valueOpportunities: opportunitiesByMatchId[String(request.matchId)] ?? [],
      }),
      selectRecommendedSlateBets: (opportunities, options) =>
        engine.selectRecommendedSlateBets(opportunities, options),
    },
    createOddsProviderCoordinatorBundle: () => ({
      primaryProviderName: 'odds_api',
      fallbackProviderName: null,
      apiKey: 'test-odds-api-key',
      coordinator: {
        getOddsForFixtures: async () => ({
          primaryProvider: 'odds_api',
          fetchedAt: fixedFetchedAt,
          fallbackReason: null,
          providerHealth: {
            odds_api: { provider: 'odds_api', status: 'healthy', checkedAt: fixedFetchedAt },
          },
          providerRuntime: { odds_api: {} },
          isMerged: false,
          warnings: [],
          matches: buildCoordinatedMatches(matches),
        }),
      },
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

const postDailySlate = async (baseUrl, body) => {
  const response = await fetch(`${baseUrl}/predictions/daily-slate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: await response.json(),
  };
};

test('/predictions/daily-slate restituisce massimo 4 pick e non forza una pick per partita', async () => {
  const matches = buildMatchRows(9);
  const opportunitiesByMatchId = Object.fromEntries(matches.map((match, index) => [
    match.match_id,
    [buildOpportunity(match.match_id, { rankingScore: 0.35 - index * 0.01 })],
  ]));
  const server = await startDailySlateRouter({ matches, opportunitiesByMatchId });

  try {
    const { status, json } = await postDailySlate(server.baseUrl, {
      competition: 'La Liga',
      date: '2026-05-23',
      maxBets: 4,
    });

    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.matchesAnalyzed, 9);
    assert.equal(json.data.recommended.length, 4);
    assert.ok(json.data.recommended.length < 9);
  } finally {
    await server.close();
  }
});

test('/predictions/daily-slate rispetta cap cartellini e cap Under/No Goal', async () => {
  const matches = buildMatchRows(6);
  const opportunitiesByMatchId = {
    match_1: [buildOpportunity('match_1', { selection: 'yellowOver35', marketCategory: 'yellow_cards', selectionFamily: 'cards_over', rankingScore: 0.5 })],
    match_2: [buildOpportunity('match_2', { selection: 'yellowUnder55', marketCategory: 'yellow_cards', selectionFamily: 'cards_under', rankingScore: 0.49 })],
    match_3: [buildOpportunity('match_3', { selection: 'under25', marketCategory: 'goal_under', selectionFamily: 'goal_under', rankingScore: 0.48 })],
    match_4: [buildOpportunity('match_4', { selection: 'bttsNo', marketCategory: 'btts_no', selectionFamily: 'btts_no', rankingScore: 0.47 })],
    match_5: [buildOpportunity('match_5', { selection: 'homeWin', rankingScore: 0.46 })],
    match_6: [buildOpportunity('match_6', { selection: 'over25', marketCategory: 'goal_over', selectionFamily: 'goal_over', rankingScore: 0.45 })],
  };
  const server = await startDailySlateRouter({ matches, opportunitiesByMatchId });

  try {
    const { json } = await postDailySlate(server.baseUrl, {
      competition: 'La Liga',
      date: '2026-05-23',
      maxBets: 4,
      maxCardsBets: 1,
      maxFragileUnderBets: 1,
    });

    const recommendedCards = json.data.recommended.filter((pick) => pick.marketCategory === 'yellow_cards');
    const recommendedFragileUnders = json.data.recommended.filter((pick) =>
      pick.marketCategory === 'goal_under' || pick.marketCategory === 'btts_no'
    );
    assert.equal(recommendedCards.length, 1);
    assert.equal(recommendedFragileUnders.length, 1);
    assert.ok(json.data.skipped.some((pick) => pick.slateSkipReason === 'skippedBecauseDailyCardCap'));
    assert.ok(json.data.skipped.some((pick) => pick.slateSkipReason === 'skippedBecauseDailyUnderCap'));
  } finally {
    await server.close();
  }
});

test('/predictions/daily-slate scarta LOW confidence quando maxLowConfidence e zero', async () => {
  const matches = buildMatchRows(3);
  const opportunitiesByMatchId = Object.fromEntries(matches.map((match) => [
    match.match_id,
    [buildOpportunity(match.match_id, { confidence: 'LOW', rankingScore: 0.5 })],
  ]));
  const server = await startDailySlateRouter({ matches, opportunitiesByMatchId });

  try {
    const { json } = await postDailySlate(server.baseUrl, {
      competition: 'La Liga',
      date: '2026-05-23',
      maxLowConfidence: 0,
    });

    assert.equal(json.data.recommended.length, 0);
    assert.equal(json.data.diagnostics.skippedBecauseLowConfidence, 3);
  } finally {
    await server.close();
  }
});

test('/predictions/daily-slate ritorna lista vuota se nessuna opportunita supera minRankingScore', async () => {
  const matches = buildMatchRows(4);
  const opportunitiesByMatchId = Object.fromEntries(matches.map((match) => [
    match.match_id,
    [buildOpportunity(match.match_id, { rankingScore: 0.05, edgeNoVig: 1, expectedValue: 1 })],
  ]));
  const server = await startDailySlateRouter({ matches, opportunitiesByMatchId });

  try {
    const { json } = await postDailySlate(server.baseUrl, {
      competition: 'La Liga',
      date: '2026-05-23',
      minRankingScore: 0.5,
    });

    assert.equal(json.data.recommended.length, 0);
    assert.equal(json.data.diagnostics.skippedBecauseWeakSlateRank, 4);
  } finally {
    await server.close();
  }
});
