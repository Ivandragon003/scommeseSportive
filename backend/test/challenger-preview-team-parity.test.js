const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ChallengerPreviewService } = require('../dist/research/ChallengerPreviewService');
const { CURRENT_CHALLENGER_RELEASE } = require('../dist/research/CurrentChallengerRelease');
const { buildJointHeadProbabilityConfiguration } = require('../dist/research/JointHeadConfiguration');
const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../dist/research/CoherentProbabilityPipeline');
const { scoreMatrixMarkets } = require('../dist/research/GoalSettlement');
const { researchHash } = require('../dist/research/ResearchStore');
const at = '2026-10-31T12:00:00.000Z', matrix = [[.2,.2,0],[.6,0,0],[0,0,0]];
const model = { source: 'PredictionService', version: `APP-A-${'a'.repeat(20)}`, codeHash: '1'.repeat(64), configHash: '2'.repeat(64), stateHash: '3'.repeat(64) };
function fixture() {
  const artifact = require('../current-models/challenger.json');
  const configuration = buildJointHeadProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion, pipelineHashV2: artifact.pipelineHashV2, mode: artifact.probabilityCalibrationMode, profile: artifact.calibrationProfilesV2.C }, artifact.jointHeadIdentity.classifierHash);
  const state = { deployment: { ...CURRENT_CHALLENGER_RELEASE }, revision: 'test', source: 'fallback' };
  const row = { match_id: 'm1', date: '2026-10-31T20:00:00Z', competition: 'Serie A', season: '2026/2027', home_team_id: 'home', away_team_id: 'away', home_goals: null, away_goals: null };
  const decision = { family: 'C', modelVersion: state.deployment.modelVersion, validated: true, forecastAt: at,
    probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, calibrationPipelineHash: coherentProbabilityPipelineHash(), calibrationAvailableAt: at,
    probabilityConfiguration: configuration.descriptor, probabilityConfigurationHash: configuration.hash,
    prospectiveMatrix: matrix, probabilityStages: { decision: scoreMatrixMarkets(matrix) }, opportunityGuard: structuredClone(artifact.opportunityGuard),
    opportunityGuardQuality: structuredClone(require('./fixtures/c-opportunity-guard-2026.json').cases[0].quality) };
  const quotes = ['over', 'under'].map((side, i) => ({ selection: `cards_total_${side}_4.5`, market: 'cards_total', side, line: 4.5,
    bookmaker: 'Book', source: 'odds_api', priceType: 'prematch', capturedAt: at, updatedAt: at, odds: i ? 1.8 : 2.5 }));
  const sharedOdds = { odds: Object.fromEntries(quotes.map(q => [q.selection,q.odds])), bookmakerBySelection: Object.fromEntries(quotes.map(q => [q.selection,q.bookmaker])), source: 'odds_api', capturedAt: at };
  const op = { selection: quotes[0].selection, marketName: 'Cards', marketCategory: 'yellow_cards', marketTier: 'CORE', confidence: 'MEDIUM', bookmakerOdds: 2.5, ourProbability: 60, expectedValue: 50, edge: 20, edgeNoVig: 10, kellyFraction: 3, suggestedStakePercent: 2, isValueBet: true, evReason: 'computed' };
  const packet = { policyVersion: 'match-page-recommendation-v1', asOf: at, model, odds: { source: 'odds_api', capturedAt: at, bookmakerBySelection: sharedOdds.bookmakerBySelection }, probabilities: { raw: {}, decision: { [op.selection]: .6 } } };
  const calls = { app: 0, predict: [] };
  const db = { getMatchById: async () => row, research: { listLegacyDecisionViews: async () => [], listMarkets: async () => [{ market: 'cards_total', state: 'ACTIVE' }] },
    recommendations: { listDecisionViews: async () => [] }, challengerAdoption: { getState: async () => state } };
  const options = { clock: () => new Date(at), odds: { getOdds: async () => assert.fail('network'), getQuotaStatus: () => null },
    runtimeFactory: () => ({ preparePreviewC: async job => ({ job, status: 'upcoming', kickoffAt: row.date, quotes: [], decisions: [decision] }) }),
    appOdds: { load: async () => { calls.app++; return { quotes, sharedOdds, sheets: [{ quotes, sharedOdds }], metadata: {} }; } },
    predictionService: { predict: async (request, options) => { calls.predict.push({ request, options }); return { canonicalRecommendation: packet, valueOpportunities: [op] }; } } };
  return { service: new ChallengerPreviewService(db, options), calls, options, decision, quotes, packet, state, op, db };
}
test('current C preview excludes statistical quotes without calling the A specialist', async () => {
  const f = fixture(), result = await f.service.preview('m1');
  assert.equal(result.status, 'NO_BET', JSON.stringify(result)); assert.equal(result.quote, null);
  assert.equal(f.calls.predict.length, 0); assert.equal(f.calls.app, 1);
});
test('current C preview retains the exact guarded primary goal quote and composite identity', async () => {
  const f = fixture(), row = require('./fixtures/c-opportunity-guard-2026.json').cases.find(item => item.expected);
  f.decision.prospectiveMatrix = row.matrix; f.decision.probabilityStages.decision = scoreMatrixMarkets(row.matrix);
  f.decision.opportunityGuardQuality = structuredClone(row.quality);
  f.quotes.splice(0, f.quotes.length, ...row.quotes.map(q => ({ selection: q.selection, market: q.market, side: q.side,
    line: q.line, team: q.team, odds: q.odds, bookmaker: q.bookmaker, source: 'odds_api', priceType: 'prematch', capturedAt: at, updatedAt: at })));
  const result = await f.service.preview('m1');
  assert.equal(result.status, 'RECOMMENDED', JSON.stringify(result)); assert.equal(result.quote.market, 'asian_handicap');
  assert.equal(result.quote.selection, row.expected.selection); assert.equal(result.quote.odds, row.expected.odds);
  assert.equal(result.quote.bookmaker, row.expected.bookmaker);
  assert.equal(result.quote.marketPolicyVersion, 'c-opportunity-guard-markets-v1');
  assert.equal(result.quote.qualificationEvidence.source, 'C_goal');
  assert.equal(result.quote.probabilityConfigurationHash, researchHash(result.quote.probabilityConfiguration));
  assert.equal(f.calls.predict.length, 0);
});
test('failed C never loads specialist data; missing real quotes never fabricate advice', async () => {
  const bad = fixture(); bad.decision.validated = false;
  assert.equal((await bad.service.preview('m1')).status, 'UNAVAILABLE'); assert.equal(bad.calls.app, 0); assert.equal(bad.calls.predict.length, 0);
  const absent = fixture(); absent.quotes.splice(0);
  const result = await absent.service.preview('m1'); assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.quote, null);
});
test('stale and synthetic specialist quotes do not enter preview', async () => {
  for (const change of [{ source: 'odds_api_plus_model_completion' }, { updatedAt: '2026-10-31T11:54:00Z' }]) {
    const f = fixture(); f.quotes.forEach(q => Object.assign(q, change));
    const result = await f.service.preview('m1'); assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.quote, null);
  }
});



test('the full app quote provider is configured cache-only by default', () => {
  const providerModule = require('../dist/services/odds-provider/OddsApiProvider');
  const original = providerModule.OddsApiProvider, captured = [];
  try {
    providerModule.OddsApiProvider = class { constructor(_key, options) { captured.push(options); } };
    const f = fixture();
    new ChallengerPreviewService(f.db, { clock: f.options.clock, odds: f.options.odds, runtimeFactory: f.options.runtimeFactory,
      predictionService: f.options.predictionService });
    assert.equal(captured.length, 1); assert.equal(captured[0].allowNetwork, false);
    assert.equal(captured[0].cacheMaxAgeMs, 300000);
  } finally { providerModule.OddsApiProvider = original; }
});
