const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApiRouter } = require('../dist/api/routes');

const QUOTED_AT = '2026-10-29T18:00:00Z';
const REPLAY_AT = '2026-10-30T12:00:00Z';
const packet = () => ({ policyVersion: 'match-page-recommendation-v1',
  selected: { selection: 'homeWin', marketName: 'Vittoria casa', bookmakerOdds: 2, ourProbability: 60,
    confidence: 'MEDIUM', suggestedStakePercent: .5 }, ranked: [], decisionStatus: 'RECOMMENDED',
  asOf: REPLAY_AT, model: { source: 'PredictionService', version: 'APP-A-fixture' },
  odds: { source: 'historical_bookmaker_snapshot', capturedAt: null, bookmakerBySelection: {} },
  probabilities: { raw: { homeWin: .6 }, decision: { homeWin: .6 } } });

async function routerFixture(t, execution) {
  const calls = [];
  const db = { research: { listLegacyDecisionViews: async () => [], listDecisions: async () => [] },
    recommendations: { listDecisionViews: async (options) => { calls.push(['read', options]); return execution ? [execution] : []; } },
    getMatchById: async () => ({ match_id: 'match-1', home_team_id: 'h', away_team_id: 'a', home_team_name: 'Home',
      away_team_name: 'Away', competition: 'Serie A', date: '2026-10-29T19:00:00Z', home_goals: 2, away_goals: 0 }),
    getLatestOddsSnapshotForMatch: async () => ({ captured_at: QUOTED_AT, source: 'odds_api', liveSelectedOdds: { homeWin: 2 },
      usedSyntheticOdds: false, marketsRequested: ['h2h'] }),
    saveLearningReview: async () => {},
  };
  const svc = { predict: async () => ({ matchId: 'match-1', probabilities: {}, canonicalRecommendation: packet(),
    bestValueOpportunity: { selection: 'awayWin' } }),
    evaluateSelectionAgainstMatch: (selection) => { calls.push(['settle', selection]); return { won: selection === 'homeWin' }; },
    buildCompletedMatchLearningReview: () => ({ fixture: true }),
  };
  const app = express(); app.use(express.json()); app.use('/api', createApiRouter({ db, svc }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const post = async (path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matchId: 'match-1' }),
    });
    return { status: response.status, ...(await response.json()) };
  };
  return { post, calls };
}

test('replay preserves the canonical advice and its historical quote timestamp through the real router', async (t) => {
  const f = await routerFixture(t);
  const result = await f.post('/predict/replay');
  assert.equal(result.status, 200);
  assert.equal(result.data.canonicalRecommendation.selected.selection, 'homeWin');
  assert.equal(result.data.canonicalRecommendation.odds.capturedAt, QUOTED_AT);
  assert.equal(result.data.canonicalRecommendation.asOf, REPLAY_AT);
  assert.equal(result.data.recommendedBetResult.selection, 'homeWin');
  assert.equal(result.data.oddsReplaySource, 'historical_bookmaker_snapshot');
  assert.deepEqual(f.calls.find((entry) => entry[0] === 'settle'), ['settle', 'homeWin']);
});

test('replay prefers already funded frozen A advice and preserves its own price and forecast times', async (t) => {
  const saved = packet(); saved.asOf = '2026-10-29T17:55:00Z'; saved.odds.capturedAt = '2026-10-29T17:54:00Z';
  saved.odds.source = 'odds_api'; saved.selected.selection = 'draw'; saved.selected.bookmakerOdds = 3.5;
  const f = await routerFixture(t, { id: 'execution-A', family: 'A', portfolioId: 'shadow_A', matchId: 'match-1', action: 'BET',
    createdAt: saved.asOf, recommendationPacket: saved, betId: 'real-fixture-bet', betStakeCents: 507,
    betPlacedAt: saved.asOf, betStatus: 'SETTLED' });
  const result = await f.post('/predict/replay');
  assert.equal(result.status, 200);
  assert.equal(result.data.automaticRecommendation.selected.selection, 'draw');
  assert.equal(result.data.automaticRecommendation.selected.bookmakerOdds, 3.5);
  assert.equal(result.data.automaticRecommendation.asOf, saved.asOf);
  assert.equal(result.data.automaticRecommendation.odds.capturedAt, saved.odds.capturedAt);
  assert.equal(result.data.automaticRecommendation.actualStakeAmount, 5.07);
  assert.equal(result.data.recommendedBetResult.selection, 'draw');
  assert.equal(result.data.canonicalRecommendation.quoteStatus, 'ARCHIVED');
});

test('predict and replay return a recorded technical abstention without inventing or falling back to a live packet', async (t) => {
  const f = await routerFixture(t, { id: 'abstention-A', family: 'A', portfolioId: 'shadow_A', matchId: 'match-1', action: 'ABSTAIN',
    createdAt: QUOTED_AT, forecastAt: QUOTED_AT, recommendationPacket: null, reason: 'app_prediction_unavailable', modelVersion: 'APP-A-unavailable' });
  for (const path of ['/predict', '/predict/replay']) {
    const result = await f.post(path);
    assert.equal(result.status, 200);
    const advice = result.data.automaticRecommendation;
    assert.equal(advice.projectionKind, 'technical_abstention');
    assert.equal(advice.selected, null); assert.equal(advice.model, null); assert.equal(advice.odds, null);
    assert.equal(advice.probabilities, null); assert.equal(advice.actualStakeAmount, 0);
    assert.equal(advice.reason, 'app_prediction_unavailable'); assert.equal(advice.asOf, QUOTED_AT);
    assert.deepEqual(result.data.canonicalRecommendation, advice);
    if (path.endsWith('replay')) assert.equal(result.data.recommendedBetResult, null);
  }
  assert.equal(f.calls.some((entry) => entry[0] === 'settle'), false);
});

test('a funded BET with a missing frozen packet fails closed in predict and replay', async (t) => {
  const f = await routerFixture(t, { id: 'corrupt-A', family: 'A', portfolioId: 'shadow_A', matchId: 'match-1', action: 'BET',
    createdAt: QUOTED_AT, recommendationPacket: null, betId: 'funded', betStakeCents: 500 });
  for (const path of ['/predict', '/predict/replay']) {
    const result = await f.post(path);
    assert.equal(result.status, 503); assert.equal(result.success, false);
    assert.equal(result.error, 'Recorded recommendation packet unavailable');
  }
});
