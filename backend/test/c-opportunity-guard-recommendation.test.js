const test = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');
const {
  buildCOpportunityGuardRecommendation, selectOpportunityGuardRecommendation, evaluateOpportunityGuard,
  opportunityGuardQuality, opportunityGuardReliability, C_OPPORTUNITY_GUARD_POLICY,
} = require('../src/research/COpportunityGuardRecommendation');
const { buildChallengerTeamRecommendation, selectChallengerTeamRecommendation } = require('../src/research/ChallengerTeamRecommendation');
const { ValueBettingEngine } = require('../src/models/value/ValueBettingEngine');
const { buildProbabilityConfiguration } = require('../src/research/ProbabilityConfiguration');
const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../src/research/CoherentProbabilityPipeline');
const { scoreMatrixMarkets } = require('../src/research/GoalSettlement');
const { researchHash } = require('../src/research/ResearchStore');
const fixture = require('./fixtures/c-opportunity-guard-2026.json');
const copy = value => structuredClone(value);
const quoteKey = q => q ? JSON.stringify([q.market, q.side, q.line ?? null, q.team ?? null, q.selection, q.bookmaker, q.odds]) : null;

function inputFor(row) {
  const config = buildProbabilityConfiguration({ family: 'C', baselineVersion: row.baselineVersion,
    pipelineHashV2: coherentProbabilityPipelineHash(), mode: 'identity' });
  // These are test prices. The archived CSV provenance remains unchanged in the fixture.
  const quotes = row.quotes.map(q => ({ selection: q.selection, market: q.market, side: q.side, line: q.line,
    team: q.team, odds: q.odds, bookmaker: q.bookmaker, source: 'odds_api', priceType: 'prematch',
    capturedAt: row.forecastAt, updatedAt: row.forecastAt }));
  const decision = { family: 'C', modelVersion: row.modelVersion, validated: true, forecastAt: row.forecastAt,
    probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, calibrationPipelineHash: coherentProbabilityPipelineHash(),
    probabilityConfiguration: config.descriptor, probabilityConfigurationHash: config.hash,
    calibrationAvailableAt: fixture.guard.profile.maxCalibrationAvailableAt, prospectiveMatrix: row.matrix,
    probabilityStages: { decision: scoreMatrixMarkets(row.matrix) }, opportunityGuard: copy(fixture.guard),
    opportunityGuardQuality: copy(row.quality) };
  return { decision, quotes, observedAt: row.forecastAt, competition: row.competition,
    expectedIdentity: { modelVersion: row.modelVersion, baselineVersion: row.baselineVersion, selectorPolicy: C_OPPORTUNITY_GUARD_POLICY },
    allowedMarkets: ['1x2', 'totals', 'asian_handicap'] };
}

test('C reproduces archived 2026 choices, abstentions, native stakes and engine ranking without changing A', () => {
  const before = ValueBettingEngine.prototype.computeRankingScore;
  for (const row of fixture.cases) {
    const input = inputFor(row), snapshot = JSON.stringify(input), packet = buildChallengerTeamRecommendation(input);
    assert.equal(quoteKey(packet.selected?.quote), quoteKey(row.expected), row.matchId);
    assert.equal(packet.policyVersion, C_OPPORTUNITY_GUARD_POLICY);
    assert.equal(packet.probabilityConfigurationHash, researchHash(packet.probabilityConfiguration));
    assert.equal(JSON.stringify(input), snapshot);
    if (packet.selected) {
      assert.ok(Math.abs(packet.selected.rankingScore - row.expectedRankingScore) <= 1e-9, row.matchId);
      assert.equal(packet.selected.engineSuggestedStakePercent, row.expectedStake);
      assert.equal(packet.selected.confidence, row.expectedConfidence);
      assert.ok(packet.selected.evReason === 'computed');
    }
    assert.equal(packet.opportunities.length, row.expectedOpportunities.length, row.matchId);
    for (const actual of packet.opportunities) {
      const expected = row.expectedOpportunities.find(op => quoteKey(op.quote) === quoteKey(actual.quote));
      assert.ok(expected, row.matchId);
      for (const field of ['rankingScore', 'engineSuggestedStakePercent', 'expectedValue', 'edge', 'edgeNoVig', 'uncertaintyFactor', 'logGrowth']) {
        assert.ok(Math.abs(actual[field] - expected[field]) <= 1e-9, `${row.matchId}: ${field}`);
      }
      assert.equal(actual.confidence, expected.confidence);
    }
  }
  assert.equal(ValueBettingEngine.prototype.computeRankingScore, before);
});

test('historical CSV evidence, synthetic prices and expired quotes cannot become live C opportunities', () => {
  const row = fixture.cases.find(r => r.expected);
  for (const patch of [q => q, q => ({ ...q, source: 'odds_api', priceType: 'prematch', updatedAt: row.forecastAt }),
    q => ({ ...q, source: 'odds_api', priceType: 'prematch', timestampEvidence: undefined, capturedAt: row.forecastAt,
      updatedAt: row.forecastAt, usedSyntheticOdds: true })]) {
    const input = inputFor(row); input.quotes = row.quotes.map(patch);
    assert.equal(buildCOpportunityGuardRecommendation(input).selected, null);
  }
  const input = inputFor(row);
  input.observedAt = new Date(Date.parse(row.forecastAt) + 300001).toISOString();
  assert.equal(buildCOpportunityGuardRecommendation(input).selected, null);
});

test('missing or malformed guard and future profiles fail closed for the new deployed selector', () => {
  const row = fixture.cases.find(r => r.expected);
  for (const mutate of [input => { delete input.decision.opportunityGuard; },
    input => { input.decision.opportunityGuard = {}; },
    input => { input.decision.opportunityGuard.profile.maxCalibrationAvailableAt = row.forecastAt; },
    input => { input.decision.opportunityGuard.reliabilityProfile.maxCalibrationAvailableAt = row.forecastAt; },
    input => { input.decision.opportunityGuard.reliabilityProfile.families['1x2'].n = 29; },
    input => { input.decision.opportunityGuardQuality.evidenceAsOf = '2030-01-01T00:00:00Z'; }]) {
    const input = inputFor(row); mutate(input);
    const packet = buildChallengerTeamRecommendation(input);
    assert.equal(packet.selected, null); assert.equal(packet.policyVersion, C_OPPORTUNITY_GUARD_POLICY);
    assert.ok(Object.keys(packet.exclusions).length);
  }
  const input = inputFor(row); delete input.decision.opportunityGuard; delete input.expectedIdentity.selectorPolicy;
  input.decision.probabilityConfiguration.version = 'c-joint-head-probability-configuration-v1';
  input.decision.probabilityConfigurationHash = researchHash(input.decision.probabilityConfiguration);
  assert.equal(buildChallengerTeamRecommendation(input).selected, null);
});

test('Asian handicap needs its own complete unambiguous bookmaker pair', () => {
  const row = fixture.cases.find(r => r.expected?.market === 'asian_handicap'), original = inputFor(row);
  for (const quotes of [original.quotes.filter(q => q.market !== 'asian_handicap' || q.side === row.expected.side),
    [...original.quotes, { ...original.quotes.find(q => q.market === 'asian_handicap'), odds: 9 }],
    original.quotes.map(q => q.market === 'asian_handicap' && q.side !== row.expected.side ? { ...q, bookmaker: 'Other book' } : q)]) {
    const packet = buildCOpportunityGuardRecommendation({ ...original, quotes });
    assert.ok(packet.opportunities.every(op => op.quote.market !== 'asian_handicap'));
  }
});

test('global selection uses engine scores, best prices and stable economic deduplication across sheets', () => {
  const row = fixture.cases.find(r => r.expected), base = buildCOpportunityGuardRecommendation(inputFor(row)).selected;
  const first = { ...base, selection: 'homeWin', quote: { ...base.quote, market: '1x2', selection: 'homeWin', side: 'home', line: undefined }, rankingScore: 1 };
  const principal = { ...base, selection: 'draw', quote: { ...first.quote, selection: 'draw', side: 'draw' }, rankingScore: 9 };
  const expensive = { ...first, bookmakerOdds: first.bookmakerOdds + .1, quote: { ...first.quote, bookmaker: 'Other book', odds: first.quote.odds + .1 }, rankingScore: 2 };
  const result = selectOpportunityGuardRecommendation([first, principal, expensive]);
  assert.equal(result.selected, principal); assert.equal(result.ranked.length, 2); assert.ok(result.ranked.includes(expensive));
  assert.ok(!result.ranked.includes(first));
  assert.deepEqual(selectChallengerTeamRecommendation(inputFor(row).decision, [first, principal, expensive]), result);
});

test('binary guard preserves its descriptive support and strictly positive conservative EV rule', () => {
  const row = fixture.cases[0], input = inputFor(row), quote = input.quotes.find(q => q.market === '1x2');
  const state = copy(fixture.guard), family = state.profile.families['1x2'];
  family.b = 0; family.SE = 0; family.support = { minX: -100, maxX: 100 };
  const op = { quote }, proof = evaluateOpportunityGuard(op, input.decision.prospectiveMatrix, input.quotes, state);
  assert.equal(proof.accepted, proof.conservativeEV > 0);
  family.support = { minX: proof.x + 2e-12, maxX: 100 };
  assert.equal(evaluateOpportunityGuard(op, input.decision.prospectiveMatrix, input.quotes, state).reason, 'outside_training_support');
  assert.equal(evaluateOpportunityGuard({ quote: { ...quote, market: 'asian_handicap' } }, [], [], state).reason, 'outside_binary_scope');
  assert.throws(() => opportunityGuardQuality({ ...row.quality, teamSampleSize: { home: -1, away: 10 } }, row.forecastAt));
  assert.throws(() => opportunityGuardReliability({ ...state, planSha256: 'invalid' }, row.forecastAt));
});
