const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pickCanonicalBetRecommendation, recommendationStateHash, validateSharedPredictionOdds,
} = require('../dist/services/CanonicalBetRecommendation');
const { PredictionService } = require('../dist/services/PredictionService');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');

const opportunity = (overrides = {}) => ({ selection: 'homeWin', marketName: '1X2 - Casa',
  marketCategory: '1X2', marketTier: 'CORE', confidence: 'LOW', bookmakerOdds: 2.5,
  ourProbability: 55, expectedValue: 10, edge: 8, edgeNoVig: 8, kellyFraction: 1.7,
  suggestedStakePercent: .37, isValueBet: true, ...overrides });

test('canonical picker preserves the match-page HIGH/MEDIUM priority over a stronger LOW', () => {
  const low = opportunity({ expectedValue: 99, edge: 80 });
  const high = opportunity({ selection: 'draw', confidence: 'HIGH', expectedValue: 5, edge: 2 });
  const medium = opportunity({ selection: 'awayWin', confidence: 'MEDIUM', expectedValue: 25, edge: 15 });
  const result = pickCanonicalBetRecommendation({ bestValueOpportunity: low, valueOpportunities: [high, medium] });
  assert.deepEqual(result.ranked.map((item) => item.selection), ['awayWin', 'draw', 'homeWin']);
  assert.equal(result.selected, medium);
  assert.equal(result.decisionStatus, 'RECOMMENDED');
});

test('canonical picker accepts a worthwhile LOW with no prospective samples and preserves its exact stake', () => {
  const low = Object.freeze(opportunity({ calibrationSampleSize: 0 }));
  const inputs = Object.freeze([low]);
  const first = pickCanonicalBetRecommendation({ valueOpportunities: inputs });
  assert.equal(first.selected, low);
  assert.equal(first.selected.suggestedStakePercent, .37);
  assert.deepEqual(pickCanonicalBetRecommendation({ valueOpportunities: inputs }), first);
  assert.equal(low.calibrationSampleSize, 0);
});

test('canonical picker retains the explained duplicate and stable ties instead of replacing its stake', () => {
  const explained = opportunity({ suggestedStakePercent: 1.27, humanSummary: 'Existing explanation' });
  const duplicate = opportunity({ suggestedStakePercent: 3 });
  const second = opportunity({ selection: 'draw' });
  const result = pickCanonicalBetRecommendation({ bestValueOpportunity: explained, valueOpportunities: [duplicate, second] });
  assert.deepEqual(result.ranked, [explained, second]);
  assert.equal(result.selected.suggestedStakePercent, 1.27);
});

test('LOW is not recommended without its positive EV, no-vig edge, Kelly, stake and real price', () => {
  for (const field of ['expectedValue', 'edgeNoVig', 'kellyFraction', 'suggestedStakePercent', 'bookmakerOdds']) {
    assert.equal(pickCanonicalBetRecommendation({ valueOpportunities: [opportunity({ [field]: 0 })] }).selected, null, field);
  }
  assert.equal(pickCanonicalBetRecommendation({ valueOpportunities: [opportunity({ isValueBet: false })] }).selected, null);
});

test('speculative, missing or synthetic prices and player props never become the team recommendation', () => {
  const result = pickCanonicalBetRecommendation({ valueOpportunities: [
    opportunity({ confidence: 'HIGH', bestBetStatus: 'SPECULATIVE' }),
    opportunity({ confidence: 'HIGH', marketTier: 'SPECULATIVE' }),
    opportunity({ bookmakerOdds: undefined }), opportunity({ bookmakerOdds: NaN }),
    opportunity({ confidence: 'HIGH', usedSyntheticOdds: true }),
    opportunity({ confidence: 'HIGH', evReason: 'synthetic_odds' }),
    opportunity({ confidence: 'HIGH', marketCategory: 'player_goal_scorer_anytime' }),
  ] });
  assert.deepEqual(result.ranked, []);
  assert.equal(result.decisionStatus, 'NO_BET');
});

test('shared-price validation rejects future snapshots, invented provenance and unmapped bookmakers', () => {
  const valid = { odds: { homeWin: 2.2 }, bookmakerBySelection: { homeWin: 'Real bookmaker' },
    source: 'odds_api', capturedAt: '2026-10-30T03:07:00Z' };
  assert.doesNotThrow(() => validateSharedPredictionOdds(valid, '2026-10-30T03:07:01Z'));
  for (const invalid of [{ ...valid, capturedAt: '2026-10-30T03:07:02Z' },
    { ...valid, source: 'model_estimated' }, { ...valid, bookmakerBySelection: {} }]) {
    assert.throws(() => validateSharedPredictionOdds(invalid, '2026-10-30T03:07:01Z'), /invalid_shared_prediction_odds/);
  }
});

test('state identity is stable across object-key order and changes with actual model state', () => {
  assert.equal(recommendationStateHash({ params: { home: .4, away: .1 }, probability: .6 }),
    recommendationStateHash({ probability: .6, params: { away: .1, home: .4 } }));
  assert.notEqual(recommendationStateHash({ params: { home: .4 } }), recommendationStateHash({ params: { home: .5 } }));
});

function operationalService() {
  const params = new DixonColesModel().getParams();
  params.attackParams = { home: .4, away: -.4 };
  params.defenceParams = { home: 0, away: 0 };
  let auditWrites = 0;
  const db = {
    getLatestModelParams: async () => ({ params }),
    getTeamsByIds: async (ids) => ids.map((team_id) => ({ team_id, name: team_id, competition: 'Test League' })),
    getMatchById: async () => ({ date: '2026-10-30T18:00:00Z' }),
    getTeamHistoricalCoverageBatch: async () => ({}),
    getTeamScheduleInsightsBatch: async () => ({}),
    appendPredictions: async () => { auditWrites++; },
  };
  const service = new PredictionService(db, { getMatchDetails: async () => assert.fail('Unexpected provider request') });
  service.applyAdaptiveTuning = async () => null;
  // Isolate the packet contract from expensive training; sample 0 remains truthful and caps confidence LOW.
  service.getCalibrationProfile = async () => ({ calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    nObservations: 0, byFamily: {}, learnedBlendWeights: {} });
  return { service, auditWrites: () => auditWrites };
}

test('operational App A uses the same shared real prices and picker, with no provider or duplicate audit', async () => {
  const { service, auditWrites } = operationalService();
  const request = { homeTeamId: 'home', awayTeamId: 'away', competition: 'Test League', matchId: 'isolated-fixture' };
  const sharedOdds = { odds: { homeWin: 3.6, draw: 3.9, awayWin: 2.1 },
    bookmakerBySelection: { homeWin: 'Book', draw: 'Book', awayWin: 'Book' },
    source: 'odds_api', capturedAt: '2026-10-30T03:07:00Z' };
  const asOf = '2026-10-30T03:07:01Z';
  const page = await service.predict({ ...request, bookmakerOdds: sharedOdds.odds,
    bookmakerBySelection: sharedOdds.bookmakerBySelection, oddsSource: sharedOdds.source }, { asOf });
  const nightly = await service.predict({ ...request, bookmakerOdds: { homeWin: 99 }, oddsSource: 'model_estimated' },
    { asOf, recordAudit: false, sharedOdds });
  assert.equal(auditWrites(), 1);
  assert.deepEqual(nightly.canonicalRecommendation.selected, page.canonicalRecommendation.selected);
  assert.ok(nightly.canonicalRecommendation.selected, 'fixture must produce a real recommended opportunity');
  assert.deepEqual(nightly.canonicalRecommendation.ranked, pickCanonicalBetRecommendation({
    bestValueOpportunity: nightly.bestValueOpportunity, valueOpportunities: nightly.valueOpportunities,
  }).ranked);
  assert.equal(nightly.canonicalRecommendation.model.source, 'PredictionService');
  assert.match(nightly.canonicalRecommendation.model.version, /^APP-A-[a-f0-9]{20}$/);
  assert.match(nightly.canonicalRecommendation.model.stateHash, /^[a-f0-9]{64}$/);
  assert.equal(nightly.canonicalRecommendation.odds.capturedAt, sharedOdds.capturedAt);
  assert.equal(nightly.canonicalRecommendation.odds.source, 'odds_api');
  assert.equal(nightly.canonicalRecommendation.probabilities.decision[nightly.canonicalRecommendation.selected.selection],
    Number(nightly.canonicalRecommendation.selected.ourProbability) / 100);
  assert.deepEqual(nightly.probabilities.flatProbabilities, page.probabilities.flatProbabilities);
  assert.equal(nightly.canonicalRecommendation.model.version, page.canonicalRecommendation.model.version);
});

test('invalid shared prices fail before any model, database or provider access', async () => {
  const service = new PredictionService({}, { getMatchDetails: async () => assert.fail('Unexpected provider request') });
  await assert.rejects(service.predict({ homeTeamId: 'home', awayTeamId: 'away' }, {
    asOf: '2026-10-30T03:07:00Z', sharedOdds: { odds: { homeWin: 2 }, bookmakerBySelection: {},
      source: 'odds_api', capturedAt: '2026-10-30T03:06:59Z' },
  }), /invalid_shared_prediction_odds/);
});
