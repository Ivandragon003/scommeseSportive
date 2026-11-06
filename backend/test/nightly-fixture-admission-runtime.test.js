const test = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');
const { ResearchRecommendationRuntime } = require('../src/research/ResearchRecommendationRuntime');
const { CANONICAL_RECOMMENDATION_POLICY } = require('../src/services/CanonicalBetRecommendation');

const at = '2026-11-06T12:00:00.000Z';
const allowed = () => ({ eligible: true, reasons: [] });
const denied = reason => ({ eligible: false, reasons: [reason] });
const markets = ['goal', 'shots', 'shots_on_target', 'yellow_cards', 'booking_points', 'player_props'];
const admission = () => ({ asOf: at, matchId: 'm1', common: allowed(), families: { A: allowed(), C: allowed() },
  markets: Object.fromEntries(markets.map(market => [market, { A: allowed(), C: allowed(), quote: allowed() }])) });
function fixture(check, predictionError) {
  const calls = { appOdds: 0, research: 0, predict: [] };
  const row = { match_id: 'm1', home_team_id: 'home', away_team_id: 'away', competition: 'Serie A', season: '2026/2027',
    date: '2026-11-07T12:00:00.000Z', home_goals: null, away_goals: null };
  const job = { id: 'job', leaseToken: 'lease', matchId: 'm1', kickoffAt: row.date, windowStartAt: '2026-11-06T00:00:00.000Z',
    windowEndAt: '2026-11-07T00:00:00.000Z', runId: 'run', policyHash: 'a'.repeat(64), originInputId: 'input', originDecisionIds: { A: 'A', C: 'C' } };
  const sheet = [
    { selection: 'homeWin', side: 'home', odds: 2, market: '1x2', bookmaker: 'Real', source: 'odds_api', priceType: 'prematch', capturedAt: at, updatedAt: at },
    { selection: 'shotsOver25', side: 'over', odds: 2, market: 'shots', line: 2.5, bookmaker: 'Real', source: 'odds_api', priceType: 'prematch', capturedAt: at, updatedAt: at },
  ];
  const db = { getMatchById: async () => row, saveSchedulerRun: async () => {}, research: { listMarkets: async () => [],
    saveModel: async () => {}, setMarketState: async () => {} } };
  const researchRuntime = { prepareNightly: async () => { calls.research++; return { job, status: 'upcoming', kickoffAt: row.date,
    quotes: [], inputSnapshot: {}, decisions: [] }; }, beginNightlyCohort: () => {}, getQuotaStatus: () => null };
  const appOdds = { getQuotaStatus: () => null, load: async () => { calls.appOdds++; return { quotes: sheet,
    sharedOdds: { odds: Object.fromEntries(sheet.map(q => [q.selection, q.odds])),
      bookmakerBySelection: Object.fromEntries(sheet.map(q => [q.selection, q.bookmaker])), source: 'odds_api', capturedAt: at } }; } };
  const predictor = { predict: async (_request, options) => { calls.predict.push(options); if (predictionError) throw predictionError; return { canonicalRecommendation: {
    policyVersion: CANONICAL_RECOMMENDATION_POLICY, asOf: at, selected: null, ranked: [], decisionStatus: 'NO_BET',
    model: { source: 'PredictionService', version: 'APP-A-abc', codeHash: '1'.repeat(64), configHash: '2'.repeat(64), stateHash: '3'.repeat(64) },
    odds: options.sharedOdds, probabilities: { raw: { homeWin: .6 }, decision: { homeWin: .6 } },
  } }; } };
  const runtime = new ResearchRecommendationRuntime(db, { clock: () => new Date(at), fixtureAdmission: check,
    researchRuntime, appOdds, predictionService: predictor });
  return { runtime, job, calls };
}

test('A calibration miss skips both A provider and inference while C continues', async () => {
  const state = admission(); state.families.A = denied('a_calibration_miss');
  const f = fixture(async () => state), result = await f.runtime.prepare(f.job);
  assert.equal(f.calls.appOdds, 0); assert.equal(f.calls.predict.length, 0); assert.equal(f.calls.research, 1);
  assert.equal(result.decisions.find(d => d.family === 'A').reason, 'a_calibration_miss');
});
test('C admission failure leaves A independent', async () => {
  const state = admission(); state.markets.goal.C = denied('c_artifact_unavailable');
  const f = fixture(async () => state), result = await f.runtime.prepare(f.job);
  assert.equal(f.calls.research, 0); assert.equal(f.calls.appOdds, 1); assert.equal(f.calls.predict.length, 1);
  assert.equal(result.decisions.find(d => d.family === 'C').reason, 'c_artifact_unavailable');
});
test('a typed cache miss remains an explicit calibration abstention', async () => {
  const error = Object.assign(new Error('cache missing'), { code: 'CALIBRATION_PROFILE_UNAVAILABLE' });
  const f = fixture(async () => admission(), error), result = await f.runtime.prepare(f.job);
  assert.equal(result.decisions.find(d => d.family === 'A').reason, 'a_calibration_profile_unavailable');
});
test('an unsupported market is removed before A prediction and EV', async () => {
  const state = admission(); state.markets.shots.A = denied('market_sample_insufficient:shots');
  const f = fixture(async () => state); await f.runtime.prepare(f.job);
  assert.equal(f.calls.predict.length, 1);
  assert.deepEqual(f.calls.predict[0].sharedOdds.odds, { homeWin: 2 });
  assert.deepEqual(f.calls.predict[0].sharedOdds.bookmakerBySelection, { homeWin: 'Real' });
});
test('a single league source failure does not veto another fixture', async () => {
  const check = async id => { const state = admission(); if (id === 'bad') {
    state.families.A = denied('calendar_network_error'); state.markets.goal.C = denied('calendar_network_error'); } return state; };
  const bad = fixture(check); bad.job.matchId = 'bad'; const badResult = await bad.runtime.prepare(bad.job);
  const good = fixture(check); await good.runtime.prepare(good.job);
  assert.equal(bad.calls.predict.length, 0); assert.equal(bad.calls.research, 0);
  assert.equal(badResult.decisions[0].reason, 'calendar_network_error');
  assert.equal(good.calls.predict.length, 1); assert.equal(good.calls.research, 1);
});
