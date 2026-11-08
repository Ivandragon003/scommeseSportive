'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('./selector-math.cjs');
const { buildChallengerTeamRecommendation } = require('../../dist/research/ChallengerTeamRecommendation');
const { scoreMatrixMarkets } = require('../../dist/research/GoalSettlement');
const { buildProbabilityConfiguration } = require('../../dist/research/ProbabilityConfiguration');
const { coherentProbabilityPipelineHash, applyCoherentProbabilityPipeline, COHERENT_PROBABILITY_PROTOCOL,
  COHERENT_CALIBRATION_TARGET } = require('../../dist/research/CoherentProbabilityPipeline');
const { RECOMMENDATION_MODEL_C, RECOMMENDATION_BASELINE_C } = require('../../dist/research/ResearchRecommendationPolicy');

// Deliberately artificial fixtures test numerical parity, never football quality.
const at = '2026-10-30T10:00:00.000Z';
const matrix = [[.2, .2, 0], [.6, 0, 0], [0, 0, 0]];
const config = buildProbabilityConfiguration({ family: 'C', baselineVersion: RECOMMENDATION_BASELINE_C,
  pipelineHashV2: coherentProbabilityPipelineHash(), mode: 'identity' });
const minimalDecision = (m = matrix) => ({ modelVersion: RECOMMENDATION_MODEL_C, probabilityConfiguration: config.descriptor,
  probabilityConfigurationHash: config.hash, prospectiveMatrix: m });
const operationalFixture = (m = matrix) => ({ ...minimalDecision(m), validated: true,
  probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, calibrationPipelineHash: coherentProbabilityPipelineHash(),
  calibrationAvailableAt: at, probabilityStages: { decision: scoreMatrixMarkets(m) } });
const quote = (selection, market, side, odds, extra = {}) => ({ selection, market, side, odds, bookmaker: 'Fixture Book',
  source: 'odds_api', priceType: 'prematch', capturedAt: at, updatedAt: at, ...extra });
const resultSheet = () => [quote('homeWin', '1x2', 'home', 2.5), quote('draw', '1x2', 'draw', 4), quote('awayWin', '1x2', 'away', 4)];
const closing = q => { const { updatedAt: _unused, ...rest } = q; return { ...rest, source: 'football_data_csv',
  priceType: 'closing', timestampEvidence: 'observed_snapshot', capturedAt: '2026-11-08T12:00:00.000Z' }; };
const plain = value => JSON.parse(JSON.stringify(value));
function compareSelector(quotes, m = matrix) {
  const input = { decision: minimalDecision(m), quotes, allowedMarkets: [...new Set(quotes.map(q => q.market))], competition: 'Serie A' };
  const before = JSON.stringify(input);
  const actual = buildChallengerTeamRecommendation({ ...input, decision: operationalFixture(m), observedAt: at });
  const retrospective = adapter.evaluateGoalRecommendations(input);
  for (const key of ['opportunities', 'ranked', 'selected', 'exclusions', 'decisionStatus', 'probabilityConfigurationHash']) {
    assert.deepEqual(plain(retrospective[key]), plain(actual[key]), key);
  }
  assert.equal(JSON.stringify(input), before);
  assert.equal(input.decision.validated, undefined);
  return retrospective;
}

test('all complete source builds and mechanical extract hashes are recorded', () => {
  const identity = adapter.identities();
  assert.ok(Object.values(identity.buildParity).every(Boolean));
  for (const collection of [identity.sourceHashes, identity.distHashes, identity.extracts]) {
    assert.ok(Object.values(collection).every(value => /^[a-f0-9]{64}$/.test(value)));
  }
});

test('complete 1X2 sheets match current operational mathematics exactly', () => {
  assert.ok(compareSelector(resultSheet()).opportunities.length);
});

for (const line of [-1, -.75, -.5, -.25, 0, .25, .5, .75, 1]) {
  test(`Asian handicap ${line}: exact current payouts, threshold, stake and ranking`, () => {
    const threshold = -line;
    compareSelector([quote(`ahcp_${threshold}`, 'asian_handicap', 'home', 3, { line }),
      quote(`ahcp_away_${threshold}`, 'asian_handicap', 'away', 3, { line: -line })]);
  });
}

for (const line of [2, 2.25, 2.5, 2.75, 3]) {
  test(`over/under ${line}: exact current payout math`, () => {
    compareSelector([quote(`over${line}`, 'totals', 'over', 2.5, { line }),
      quote(`under${line}`, 'totals', 'under', 2.5, { line })], [[.1, .05, .05], [.05, .05, .25], [.05, .25, .15]]);
  });
}

test('no positive opportunity, conflicting sheet, incomplete sheet and alias mismatch retain abstention', () => {
  const cheap = resultSheet().map(q => ({ ...q, odds: 1.01 }));
  assert.equal(compareSelector(cheap).selected, null);
  assert.equal(compareSelector(resultSheet().slice(0, 2)).selected, null);
  assert.equal(compareSelector([...resultSheet(), { ...resultSheet()[0], odds: 3 }]).selected, null);
  assert.equal(compareSelector(resultSheet().map((q, i) => i ? q : { ...q, side: 'away' })).selected, null);
});

test('closing CSV keeps actual observation provenance and never gains operational admission', () => {
  const quotes = resultSheet().map(closing);
  const result = adapter.evaluateGoalRecommendations({ decision: minimalDecision(), quotes, allowedMarkets: ['1x2'] });
  assert.ok(result.opportunities.length);
  assert.equal(result.admissionChecksApplied, false);
  assert.equal(result.selected.quote.source, 'football_data_csv');
  assert.equal(result.selected.quote.priceType, 'closing');
  assert.equal(result.selected.quote.capturedAt, '2026-11-08T12:00:00.000Z');
  assert.equal(result.selected.quote.updatedAt, undefined);
  const rejected = buildChallengerTeamRecommendation({ decision: operationalFixture(), quotes, allowedMarkets: ['1x2'], observedAt: at });
  assert.equal(rejected.selected, null);
  assert.equal(rejected.exclusions.real_prematch_quote_required, 3);
});

const profile = { protocol: 'existing-isotonic-v1', fittedThrough: '2025-12-30T12:00:00Z', matches: 1000,
  nObservations: 3000, calibrationPoints: [{ x: 0, y: 0 }, { x: .25, y: .1 }, { x: .6, y: .8 }, { x: 1, y: 1 }],
  byFamily: {}, learnedBlendWeights: { goal_1x2: { modelWeight: .35, sampleSize: 1000 } }, targetProtocol: COHERENT_CALIBRATION_TARGET };
for (const mode of ['identity', 'isotonic_1x2', 'temperature']) {
  test(`${mode}: calibration and extracted blend equal actual coherent pipeline`, () => {
    const input = { matrix, quotes: resultSheet(), forecastAt: at, mode, temperature: 1.1, profile };
    const actual = applyCoherentProbabilityPipeline(input), adapted = adapter.calibrateAndBlend(input);
    for (const key of ['matrix', 'raw', 'calibrated', 'decision', 'bookmaker', 'marketBlendingApplied']) {
      assert.deepEqual(plain(adapted[key]), plain(actual[key]), key);
    }
    const csv = adapter.calibrateAndBlend({ ...input, quotes: input.quotes.map(closing) });
    assert.deepEqual(plain(csv.matrix), plain(actual.matrix));
    assert.equal(csv.bookmaker.source, 'football_data_csv');
    assert.equal(csv.bookmaker.updatedAt, null);
    const withoutLearned = adapter.calibrateAndBlend({ ...input, profile: { ...profile, learnedBlendWeights: {} } });
    assert.notDeepEqual(plain(adapted.matrix), plain(withoutLearned.matrix), 'actual learned model weight is consumed');
  });
}

test('profile chronology is enforced by actual pipeline; stale operational time is deliberately not invented for closing math', () => {
  assert.throws(() => adapter.calibrateAndBlend({ matrix, quotes: [], forecastAt: '2025-12-29T12:00:00Z', profile }), /future_coherent/);
  const quotes = resultSheet().map(q => ({ ...q, updatedAt: '2026-10-30T09:50:00Z' }));
  assert.equal(buildChallengerTeamRecommendation({ decision: operationalFixture(), quotes, allowedMarkets: ['1x2'], observedAt: at }).selected, null);
  // This is only payout mathematics: it intentionally does not claim live freshness.
  assert.ok(adapter.evaluateGoalRecommendations({ decision: minimalDecision(), quotes, allowedMarkets: ['1x2'] }).opportunities.length);
});

test('dynamic runtime qualification uses all selections, best bookmaker and full recommended stake precision', () => {
  const opportunity = adapter.evaluateGoalRecommendations({ decision: minimalDecision(), quotes: resultSheet(), allowedMarkets: ['1x2'] }).opportunities[0];
  const all = Array.from({ length: 6 }, (_, index) => ({ ...opportunity,
    selection: `fixture_${index}`, quote: { ...opportunity.quote, selection: `fixture_${index}`, market: 'totals', side: 'over', line: index + .5 },
    engineSuggestedStakePercent: 2 }));
  const better = { ...all[0], quote: { ...all[0].quote, bookmaker: 'Better Book', odds: all[0].quote.odds + .1 } };
  const invalid = [0, -1, 5.01, 1.001, NaN, undefined].map((value, index) => ({ ...all[0],
    quote: { ...all[0].quote, line: index + 10.5 }, engineSuggestedStakePercent: value }));
  const candidates = adapter.qualifyAll([...all, better, ...invalid]);
  assert.equal(candidates.length, 6);
  assert.ok(candidates.some(c => c.quote.bookmaker === 'Better Book'));
  assert.ok(candidates.every(c => c.suggestedStakePercent === 2));
});
