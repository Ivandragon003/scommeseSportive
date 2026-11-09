const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChallengerTeamRecommendation, buildChallengerTeamConfiguration } = require('../dist/research/ChallengerTeamRecommendation');
const { scoreMatrixMarkets } = require('../dist/research/GoalSettlement');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');
const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../dist/research/CoherentProbabilityPipeline');
const RECOMMENDATION_MODEL_C = 'C-legacy-team-unit-fixture', RECOMMENDATION_BASELINE_C = 'A-legacy-team-unit-fixture';
const { researchHash } = require('../dist/research/ResearchStore');
const at = '2026-10-30T10:00:00.000Z';
const matrix = [[.2, .2, 0], [.6, 0, 0], [0, 0, 0]];
const config = buildProbabilityConfiguration({ family: 'C', baselineVersion: RECOMMENDATION_BASELINE_C, pipelineHashV2: coherentProbabilityPipelineHash(), mode: 'identity' });
const decision = () => ({ modelVersion: RECOMMENDATION_MODEL_C, validated: true, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
  calibrationPipelineHash: coherentProbabilityPipelineHash(), calibrationAvailableAt: at, probabilityConfiguration: config.descriptor,
  probabilityConfigurationHash: config.hash, prospectiveMatrix: matrix, probabilityStages: { decision: scoreMatrixMarkets(matrix) } });
const quote = (selection, market, side, odds, extra = {}) => ({ selection, market, side, odds, bookmaker: 'Book',
  source: 'odds_api', priceType: 'prematch', capturedAt: at, updatedAt: at, ...extra });
const base = (quotes, extra = {}) => ({ decision: decision(), quotes, observedAt: at, allowedMarkets: ['1x2', 'cards_total'], expectedIdentity: { modelVersion: RECOMMENDATION_MODEL_C, baselineVersion: RECOMMENDATION_BASELINE_C }, ...extra });
const stat = (line = 4.5) => [quote(`cards_total_over_${line}`, 'cards_total', 'over', 2.5, { line }), quote(`cards_total_under_${line}`, 'cards_total', 'under', 1.8, { line })];
const model = { source: 'PredictionService', version: `APP-A-${'a'.repeat(20)}`, codeHash: '1'.repeat(64), configHash: '2'.repeat(64), stateHash: '3'.repeat(64) };
const specialist = (line = 4.5) => { const op = { selection: `cards_total_over_${line}`, marketName: 'Cards', marketCategory: 'yellow_cards', marketTier: 'CORE', confidence: 'MEDIUM', bookmakerOdds: 2.5, ourProbability: 60, expectedValue: 50, edge: 20, edgeNoVig: 10, kellyFraction: 3, suggestedStakePercent: 2, isValueBet: true, evReason: 'computed', calibrationSampleSize: 50 }; return { matchId: 'm1', opportunities: [op], packet: { policyVersion: 'match-page-recommendation-v1', asOf: at, model, odds: { source: 'odds_api', capturedAt: at, bookmakerBySelection: { [op.selection]: 'Book' } }, probabilities: { raw: {}, decision: { [op.selection]: .6 } } } }; };

test('configuration fingerprints goal and stays stable across specialist states', () => {
  const packet = specialist().packet, a = buildChallengerTeamConfiguration(decision(), packet);
  assert.equal(a.goalConfigurationHash, researchHash(a.goalConfiguration));
  assert.deepEqual(buildChallengerTeamConfiguration(decision(), { ...packet, model: { ...model, stateHash: '4'.repeat(64) } }), a);
});
test('unsupported statistics cannot enter the C goal catalog or replace a failed C forecast', () => {
  const result = buildChallengerTeamRecommendation(base(stat(), { specialist: specialist() }));
  assert.equal(result.selected, null); assert.ok(result.exclusions.market_not_supported > 0);
  const failed = buildChallengerTeamRecommendation(base(stat(), { decision: { ...decision(), validated: false }, specialist: specialist() }));
  assert.equal(failed.selected, null); assert.equal(failed.exclusions.challenger_technical_validation_failed, 1);
});
test('specialist rejects integer lines, stale packets, incomplete sheets and mismatched probabilities', () => {
  assert.equal(buildChallengerTeamRecommendation(base(stat(4), { specialist: specialist(4) })).selected, null);
  const stale = specialist(); stale.packet.asOf = '2026-10-30T09:59:59Z';
  assert.equal(buildChallengerTeamRecommendation(base(stat(), { specialist: stale })).selected, null);
  assert.equal(buildChallengerTeamRecommendation(base(stat().slice(0, 1), { specialist: specialist() })).selected, null);
  const changed = specialist(); changed.packet.probabilities.decision[changed.opportunities[0].selection] = .7;
  assert.equal(buildChallengerTeamRecommendation(base(stat(), { specialist: changed })).selected, null);
});
test('goal markets require complete, coherent real bookmaker sheets without input mutation', () => {
  const quotes = [quote('homeWin', '1x2', 'home', 2.5), quote('draw', '1x2', 'draw', 4), quote('awayWin', '1x2', 'away', 4)];
  const input = base(quotes), before = JSON.stringify(input), result = buildChallengerTeamRecommendation(input);
  assert.equal(JSON.stringify(input), before); assert.equal(result.selected.quote.selection, 'homeWin');
  assert.equal(result.selected.expectedValue, result.selected.payout.expectedValue * 100);
  assert.equal(buildChallengerTeamRecommendation(base([...quotes, { ...quotes[0], odds: 2.6 }])).selected, null);
  assert.equal(buildChallengerTeamRecommendation(base(quotes.map((q, i) => i === 1 ? { ...q, bookmaker: 'Other' } : q))).selected, null);
  assert.equal(buildChallengerTeamRecommendation(base(quotes.map(q => ({ ...q, updatedAt: '2026-10-30T09:50:00Z' })))).selected, null);
});
test('the C goal catalog excludes DNB and European handicap while supported Asian payouts retain split outcomes', () => {
  const dnb = [quote('dnb_home', 'dnb', 'home', 2.5), quote('dnb_away', 'dnb', 'away', 3)];
  assert.equal(buildChallengerTeamRecommendation(base(dnb, { allowedMarkets: ['dnb'] })).selected, null);
  const asian = [quote('ahcp_0.25', 'asian_handicap', 'home', 3, { line: -.25 }), quote('ahcp_away_0.25', 'asian_handicap', 'away', 3, { line: .25 })];
  const ah = buildChallengerTeamRecommendation(base(asian, { allowedMarkets: ['asian_handicap'] })).opportunities.find(o => o.quote.side === 'home');
  assert.ok(ah); assert.ok(ah.payout.outcomes.find(o => o.status === 'HALF_LOST').probability > 0);
  assert.ok(Math.abs(ah.expectedValue - ah.payout.expectedValue * 100) < 1e-8);
  const eu = [quote('hcp_home-1', 'european_handicap', 'home', 5, { line: -1 }), quote('hcp_draw-1', 'european_handicap', 'draw', 3, { line: -1 }), quote('hcp_away+1', 'european_handicap', 'away', 3, { line: -1 })];
  assert.equal(buildChallengerTeamRecommendation(base(eu, { allowedMarkets: ['european_handicap'] })).opportunities.length, 0);
});
test('double chance is outside the approved C recipe', () => {
  const dc = [quote('double_chance_1x', 'double_chance', '1x', 2), quote('double_chance_x2', 'double_chance', 'x2', 2), quote('double_chance_12', 'double_chance', '12', 2)];
  const result = buildChallengerTeamRecommendation(base(dc, { allowedMarkets: ['double_chance'] }));
  assert.equal(result.opportunities.length, 0); assert.ok(result.exclusions.market_not_supported > 0);
});

test('refund probability cannot activate a market outside the approved C recipe', () => {
  const m = [[.99, .004], [.006, 0]], d = decision();
  d.prospectiveMatrix = m; d.probabilityStages.decision = scoreMatrixMarkets(m);
  const quotes = [quote('dnb_home', 'dnb', 'home', 2), quote('dnb_away', 'dnb', 'away', 2)];
  const result = buildChallengerTeamRecommendation(base(quotes, { decision: d, allowedMarkets: ['dnb'] }));
  assert.equal(result.selected, null); assert.ok(result.exclusions.market_not_supported > 0);
});

test('only approved goal totals enter C; other app markets remain outside its recipe', () => {
  const d = decision(), m = [[.1, .05, .05], [.05, .05, .25], [.05, .25, .15]];
  d.prospectiveMatrix = m; d.probabilityStages.decision = scoreMatrixMarkets(m);
  const sheets = [
    [quote('btts', 'btts', 'yes', 2), quote('bttsNo', 'btts', 'no', 2)],
    [quote('team_home_over_0.5', 'team_totals', 'over', 1.6, { team: 'home', line: .5 }),
      quote('team_home_under_0.5', 'team_totals', 'under', 3, { team: 'home', line: .5 })],
    [quote('over25', 'totals', 'over', 2, { line: 2.5 }), quote('under25', 'totals', 'under', 2, { line: 2.5 })],
    [quote('hcp_home-1', 'european_handicap', 'home', 8, { line: -1 }),
      quote('hcp_draw-1', 'european_handicap', 'draw', 8, { line: -1 }),
      quote('hcp_away+1', 'european_handicap', 'away', 2, { line: -1 })],
  ];
  for (const sheet of sheets) {
    const result = buildChallengerTeamRecommendation(base(sheet, { decision: d, allowedMarkets: [sheet[0].market] }));
    if (sheet[0].market !== 'totals') { assert.equal(result.opportunities.length, 0); continue; }
    assert.ok(result.opportunities.length > 0, `${sheet[0].market}: ${JSON.stringify(result.exclusions)}`);
    for (const op of result.opportunities) {
      assert.equal(op.qualificationEvidence.source, 'C_goal');
      assert.ok(Math.abs(op.expectedValue - op.payout.expectedValue * 100) < 1e-8);
    }
  }
});

test('the app quote adapter keeps real statistical prices available to A without entering the C recipe', async () => {
  const { AppPredictionOddsService } = require('../dist/services/AppPredictionOddsService');
  const { OddsApiService } = require('../dist/services/OddsApiService');
  const mapper = new OddsApiService('mapping-only');
  const row = { competition: 'Serie A', date: '2026-10-30T19:00:00Z', home_team_name: 'Inter', away_team_name: 'Milan' };
  const event = { matchId: 'provider-fixture', homeTeam: 'Inter', awayTeam: 'Milan', commenceTime: row.date,
    provider: 'odds_api', capturedAt: at, bookmakers: [{ bookmakerKey: 'book', bookmakerName: 'Book', updatedAt: at,
      markets: [{ marketKey: 'alternate_totals_cards', updatedAt: at, outcomes: [
        { name: 'Over', point: 4.5, price: 2.5 }, { name: 'Under', point: 4.5, price: 1.8 }] }] }] };
  const provider = { getOddsForFixtures: async () => ({ matches: [event], warnings: [] }),
    compareBookmakers: match => mapper.compareBookmakers(match) };
  const loaded = await new AppPredictionOddsService({}, { clock: () => new Date(at), provider }).load(row);
  assert.ok(loaded.quotes.some(q => q.selection === 'cardsTotalOver45'));
  const s = specialist();
  const result = buildChallengerTeamRecommendation(base(loaded.quotes, { specialist: s }));
  assert.equal(result.selected, null); assert.ok(result.exclusions.market_not_supported > 0);
  assert.ok(loaded.quotes.every(q => q.bookmaker === 'Book' && q.source === 'odds_api'));
  const conflict = loaded.quotes.map(q => q.selection === 'cardsTotalOver45' ? { ...q, odds: 3 } : q);
  assert.equal(buildChallengerTeamRecommendation(base(conflict, { specialist: s })).selected, null);
});
