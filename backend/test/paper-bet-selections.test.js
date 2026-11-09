const test = require('node:test');
const assert = require('node:assert/strict');
const build = process.env.PAPER_TEST_BUILD ?? '../dist';
const { paperSelectionKey, bestPaperSelections } = require(`${build}/research/PaperBetSelections`);
const { appRecommendationQuote } = require(`${build}/research/AppRecommendationQuotes`);
const { ResearchRecommendationRuntime } = require(`${build}/research/ResearchRecommendationRuntime`);
const { CANONICAL_RECOMMENDATION_POLICY } = require(`${build}/services/CanonicalBetRecommendation`);
const { selectChallengerPayoutRecommendation } = require(`${build}/research/ChallengerSelection`);
const { PredictionService } = require(`${build}/services/PredictionService`);
const { DixonColesModel } = require(`${build}/models/core/DixonColesModel`);
const recorder = require(`${build}/research/ModelAProspectiveRecorder`);
const { researchQuotesFromEvent } = require(`${build}/research/ResearchRuntime`);
const { buildProbabilityConfiguration } = require(`${build}/research/ProbabilityConfiguration`);
const { scoreMatrixMarkets } = require(`${build}/research/GoalSettlement`);
const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require(`${build}/research/CoherentProbabilityPipeline`);
const { CHALLENGER_DATA_QUALITY_POLICY_HASH } = require(`${build}/research/ChallengerDataQuality`);
const { RECOMMENDATION_MODEL_C, RECOMMENDATION_BASELINE_C } = require(`${build}/research/ResearchRecommendationPolicy`);

const at = '2026-10-30T10:00:00.000Z';
const evidence = (odds, bookmaker) => ({ odds, bookmaker, source: 'odds_api', priceType: 'prematch',
  timestampEvidence: 'provider_update', capturedAt: at, updatedAt: at });

test('aliases are one semantic selection, while distinct lines remain separate', () => {
  const first = appRecommendationQuote('cardsTotalOver45', evidence(2, 'B'));
  const alias = appRecommendationQuote('cards_total_over_4.5', evidence(3, 'A'));
  const other = appRecommendationQuote('cards_total_over_5.5', evidence(2, 'B'));
  assert.equal(paperSelectionKey(first), paperSelectionKey(alias));
  assert.notEqual(paperSelectionKey(first), paperSelectionKey(other));
  const selection = (quote) => ({ selectionKey: paperSelectionKey(quote), quote });
  const result = bestPaperSelections([selection(first), selection(other), selection(alias)]);
  assert.equal(result.length, 2);
  assert.equal(result.find((item) => item.selectionKey === paperSelectionKey(first)).quote.odds, 3);
});

test('paper identity uses only the fields that determine each supported team outcome', () => {
  const cases = [
    ['1x2', 'home', 'away', false, false],
    ['double_chance', '1x', 'x2', false, false],
    ['dnb', 'home', 'away', false, false],
    ['btts', 'yes', 'no', false, false],
    ['totals', 'over', 'under', true, false],
    ['team_totals', 'over', 'under', true, true],
    ['european_handicap', 'home', 'draw', true, false],
    ['asian_handicap', 'home', 'away', true, false],
    ['shots', 'over', 'under', true, true],
    ['shots_on_target', 'over', 'under', true, false],
    ['yellow_cards', 'over', 'under', true, false],
    ['cards_total', 'over', 'under', true, false],
  ];
  for (const [market, side, otherSide, usesLine, usesTeam] of cases) {
    const quote = { ...evidence(2, 'Bookmaker A'), market, side, selection: 'first',
      ...(usesLine ? { line: 2 } : {}), ...(usesTeam ? { team: 'home' } : {}) };
    const key = paperSelectionKey(quote);
    const changedMetadata = { ...quote, selection: 'alias', odds: 3, bookmaker: 'Bookmaker B',
      source: 'different-source', capturedAt: '2026-10-30T09:00:00.000Z',
      playerId: 'irrelevant-id', playerName: 'irrelevant-name',
      ...(!usesLine ? { line: 4 } : {}), ...(!usesTeam ? { team: 'away' } : {}) };
    assert.equal(paperSelectionKey(changedMetadata), key, `${market}: irrelevant fields`);
    assert.notEqual(paperSelectionKey({ ...quote, side: otherSide }), key, `${market}: side`);
    if (usesLine) assert.notEqual(paperSelectionKey({ ...quote, line: 2.5 }), key, `${market}: line`);
    if (usesTeam) assert.notEqual(paperSelectionKey({ ...quote, team: 'away' }), key, `${market}: team`);
    assert.equal(key, JSON.stringify([market, side, usesLine ? 2 : null, usesTeam ? 'home' : null, null]),
      `${market}: existing clean key`);
  }
});

test('paper payout accepts positive EV without changing the legacy log-growth gate', () => {
  const quotes = [['homeWin', 'home', 2.001], ['draw', 'draw', 4], ['awayWin', 'away', 4]].map(([selection, side, odds]) =>
    ({ ...evidence(odds, 'A'), selection, side, market: '1x2' }));
  const input = { matrix: [[.5, 0], [.5, 0]], quotes, observedAt: at, allowedMarkets: ['1x2'],
    quality: { technicalValidation: true, calibrationAvailableAt: at, prospectiveResidualSamples: 50,
      parameterUncertainty: null, uncertaintyReason: 'parameter_uncertainty_not_supplied' } };
  const legacy = selectChallengerPayoutRecommendation(input);
  const paper = selectChallengerPayoutRecommendation({ ...input, paperFixedUnit: true });
  assert.ok(!legacy.opportunities.some((value) => value.selection === 'homeWin'));
  const candidate = paper.opportunities.find((value) => value.selection === 'homeWin');
  assert.ok(candidate.payout.expectedValue > 0);
  assert.ok(candidate.payout.expectedLogGrowth < 0);
});

test('C keeps the scientific sheet unchanged and exposes other bookmakers to paper', () => {
  const event = { provider: 'odds_api', capturedAt: at, homeTeam: 'Home', awayTeam: 'Away',
    bookmakers: [['eurobet', 'Eurobet', 1.9], ['other', 'Other', 2.2]].map(([bookmakerKey, bookmakerName, price]) =>
      ({ bookmakerKey, bookmakerName, updatedAt: at, markets: [{ marketKey: 'h2h', updatedAt: at,
        outcomes: [{ name: 'Home', price }, { name: 'Draw', price: 3.5 }, { name: 'Away', price: 3.5 }] }] })) };
  const original = researchQuotesFromEvent(event, at), all = researchQuotesFromEvent(event, at, { allSheets: true });
  assert.equal(original.length, 3); assert.equal(all.length, 6);
  assert.equal(original.find((quote) => quote.selection === 'homeWin').bookmaker, 'Eurobet');
  assert.equal(all.find((quote) => quote.bookmaker === 'Other' && quote.selection === 'homeWin').odds, 2.2);
});

test('C abstains without a principal and preserves archived quality evidence despite secondary paper prices', async () => {
  const matrix = [[.5, 0], [.5, 0]], probabilities = scoreMatrixMarkets(matrix);
  const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion: RECOMMENDATION_BASELINE_C,
    pipelineHashV2: coherentProbabilityPipelineHash(), mode: 'identity' });
  const decision = { family: 'C', modelVersion: RECOMMENDATION_MODEL_C, validated: true, action: 'ABSTAIN',
    probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, calibrationPipelineHash: coherentProbabilityPipelineHash(),
    calibrationAvailableAt: at, probabilityConfiguration: configuration.descriptor, probabilityConfigurationHash: configuration.hash,
    prospectiveMatrix: matrix, probabilityStages: { decision: probabilities }, dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH,
    dataQualityBaselineClean: true, dataQualityEvidence: { fixtureCheck: 'verified' } };
  const quotesFor = (bookmaker, homeOdds) => [['homeWin', 'home', homeOdds], ['draw', 'draw', 1.9], ['awayWin', 'away', 2]]
    .map(([selection, side, odds]) => ({ ...evidence(odds, bookmaker), selection, side, market: '1x2' }));
  const legacyQuotes = quotesFor('Eurobet', 1.9), paperQuotes = [...legacyQuotes, ...quotesFor('Other', 2.001)];
  const row = { match_id: 'm', home_team_id: 'h', away_team_id: 'a', competition: 'Serie A', season: '2026',
    date: '2026-10-30T19:00:00Z', home_goals: null, away_goals: null };
  const job = { id: 'j', leaseToken: 'l', originInputId: 'i', matchId: 'm', kickoffAt: row.date,
    windowStartAt: '2026-10-30T02:00:00Z', windowEndAt: '2026-10-31T02:00:00Z', runId: 'r', originDecisionIds: { A: 'a', C: 'c' } };
  const researchRuntime = { beginNightlyCohort: () => {}, getQuotaStatus: () => null,
    prepareNightly: async () => ({ job, status: 'upcoming', kickoffAt: row.date, quotes: legacyQuotes, paperQuotes, decisions: [decision] }) };
  const db = { getMatchById: async () => row, saveSchedulerRun: async () => {}, research: {
    listMarkets: async () => [{ market: '1x2', state: 'EXPERIMENTAL' }], saveModel: async () => {}, setMarketState: async () => {} } };
  const appOdds = { getQuotaStatus: () => null, load: async () => { throw Error('unavailable'); } };
  const deploymentC = { source: 'adopted', revision: 'test', deployment: { modelVersion: RECOMMENDATION_MODEL_C,
    baselineVersion: RECOMMENDATION_BASELINE_C, selectorPolicy: 'payout-aware-v1', probabilityConfigurationHash: null, artifactHash: null } };
  const runtime = new ResearchRecommendationRuntime(db, { clock: () => new Date(at), paperMode: true, researchRuntime, appOdds, deploymentC });
  const result = await runtime.prepare(job), c = result.decisions.find((value) => value.family === 'C');
  const archived = result.inputSnapshot.forecasts.C;
  assert.equal(archived.recommendation.selected, null);
  assert.equal(c.action, 'ABSTAIN'); assert.equal(c.selections?.length ?? 0, 0);
  assert.equal(c.reason, archived.recommendation.abstentionReason);
  assert.ok(result.inputSnapshot.quotes.some(quote => quote.bookmaker === 'Other' && quote.odds === 2.001));
  assert.equal(archived.decision.dataQualityPolicyHash, CHALLENGER_DATA_QUALITY_POLICY_HASH);
  assert.equal(archived.decision.dataQualityBaselineClean, true);
  assert.deepEqual(archived.decision.dataQualityEvidence, { fixtureCheck: 'verified' });
  const funded = new ResearchRecommendationRuntime(db, { clock: () => new Date(at), fundedMode: true, researchRuntime, appOdds, deploymentC });
  const fundedC = (await funded.prepare(job)).decisions.find((value) => value.family === 'C');
  assert.equal(fundedC.action, 'ABSTAIN');
  assert.equal(fundedC.reason, c.reason);
  const dynamic = new ResearchRecommendationRuntime(db, { clock: () => new Date(at), dynamicMode: true, researchRuntime, appOdds, deploymentC });
  const dynamicC = (await dynamic.prepare(job)).decisions.find((value) => value.family === 'C');
  assert.equal(dynamicC.action, 'ABSTAIN'); assert.equal(dynamicC.reason, c.reason);
  const canonicalQuotes = quotesFor('Best', 3.5);
  const canonicalRuntime = { ...researchRuntime, prepareNightly: async () => ({ job, status: 'upcoming', kickoffAt: row.date,
    quotes: canonicalQuotes, paperQuotes: canonicalQuotes, decisions: [decision] }) };
  const canonicalDeployment = { ...deploymentC, deployment: { ...deploymentC.deployment, selectorPolicy: 'canonical-binary-v1' } };
  const canonical = new ResearchRecommendationRuntime(db, { clock: () => new Date(at), dynamicMode: true,
    researchRuntime: canonicalRuntime, appOdds, deploymentC: canonicalDeployment });
  const actual = (await canonical.prepare(job)).decisions.find(value => value.family === 'C');
  const { buildChallengerRecommendation } = require(`${build}/research/ChallengerRecommendation`);
  const original = buildChallengerRecommendation({ decision, quotes: canonicalQuotes, observedAt: at,
    competition: row.competition, expectedIdentity: canonicalDeployment.deployment, allowedMarkets: ['1x2'], paperFixedUnit: true });
  const reference = original.opportunities.find(value => value.selection === actual.selections?.[0]?.selection);
  assert.equal(actual.action, 'BET'); assert.ok(reference);
  assert.equal(actual.selections[0].suggestedStakePercent, reference.engineSuggestedStakePercent);
  assert.notEqual(reference.engineSuggestedStakePercent, 1);
});

test('suppressProspective skips recorder while preserving the prediction and default recording', async (t) => {
  const previous = process.env.MODEL_A_PROSPECTIVE_ENABLED;
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true';
  t.after(() => { if (previous === undefined) delete process.env.MODEL_A_PROSPECTIVE_ENABLED;
    else process.env.MODEL_A_PROSPECTIVE_ENABLED = previous; });
  const row = { match_id: 'm', home_team_id: 'home', away_team_id: 'away', competition: 'Test League',
    season: '2026', date: '2026-10-30T19:00:00Z', home_goals: null, away_goals: null };
  const params = new DixonColesModel().getParams();
  params.attackParams = { home: .4, away: -.4 }; params.defenceParams = { home: 0, away: 0 };
  const db = { getMatchById: async () => row, getLatestModelParams: async () => ({ params }),
    getTeamsByIds: async (ids) => ids.map((team_id) => ({ team_id, name: team_id, competition: 'Test League' })),
    getTeamHistoricalCoverageBatch: async () => ({}), getTeamScheduleInsightsBatch: async () => ({}),
    appendPredictions: async () => assert.fail('unexpected audit write') };
  const predictor = new PredictionService(db, { getMatchDetails: async () => assert.fail('unexpected provider call') });
  predictor.applyAdaptiveTuning = async () => null;
  predictor.getCalibrationProfile = async () => ({ calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    nObservations: 0, byFamily: {}, learnedBlendWeights: {} });
  const sharedOdds = { odds: { homeWin: 3.6, draw: 3.9, awayWin: 2.1 },
    bookmakerBySelection: { homeWin: 'Book', draw: 'Book', awayWin: 'Book' }, source: 'odds_api', capturedAt: at };
  const request = { homeTeamId: 'home', awayTeamId: 'away', matchId: 'm', competition: 'Test League', season: '2026' };
  let receipts = 0;
  const options = { asOf: at, recordAudit: false, sharedOdds, onProspectiveRecord: () => { receipts++; } };
  const before = recorder.modelAProspectiveStats().attempted;
  const suppressed = await predictor.predict(request, { ...options, suppressProspective: true });
  assert.equal(recorder.modelAProspectiveStats().attempted, before);
  assert.equal(receipts, 0);
  const normal = await predictor.predict(request, options);
  assert.equal(recorder.modelAProspectiveStats().attempted, before + 1);
  assert.equal(receipts, 1);
  assert.deepEqual(suppressed.probabilities, normal.probabilities);
  assert.deepEqual(suppressed.valueOpportunities, normal.valueOpportunities);
  assert.deepEqual(suppressed.canonicalRecommendation.selected, normal.canonicalRecommendation.selected);
});

test('paper runtime keeps more than 100 qualifying selections and best qualified price without new provider calls', async () => {
  const prices = Array.from({ length: 120 }, (_, i) => appRecommendationQuote(`shots_total_over_${i + .5}`, evidence(2, 'B')));
  const alias = appRecommendationQuote('shotsOver5', evidence(3, 'A'));
  const sheet = (quotes) => ({ quotes, sharedOdds: { odds: Object.fromEntries(quotes.map((q) => [q.selection, q.odds])),
    bookmakerBySelection: Object.fromEntries(quotes.map((q) => [q.selection, q.bookmaker])), source: 'odds_api', capturedAt: at } });
  const sheets = [sheet(prices), sheet([alias])];
  const model = { source: 'PredictionService', version: `APP-A-${'a'.repeat(20)}`, codeHash: '1'.repeat(64),
    configHash: '2'.repeat(64), stateHash: '3'.repeat(64) };
  const makeOpportunity = (q) => ({ selection: q.selection, marketCategory: 'shots', marketTier: 'CORE', confidence: 'MEDIUM',
    bookmakerOdds: q.odds, ourProbability: 60, expectedValue: 20, suggestedStakePercent: 0, edge: 2, edgeNoVig: 1,
    calibrationSampleSize: 19, categoryCalibrationStatus: 'insufficient_sample', calibrationReliability: .16,
    dataWarnings: ['calibration_sample_insufficient'], dynamicEvThreshold: 3, rankingScore: 7, isValueBet: true });
  let loads = 0;
  const predictor = { predict: async (_request, options) => {
    assert.equal(options.suppressProspective, true);
    const source = sheets.find((s) => Object.keys(s.sharedOdds.odds).join() === Object.keys(options.sharedOdds.odds).join()) || sheets[0];
    const opportunities = source.quotes.map(makeOpportunity);
    return { valueOpportunities: opportunities, canonicalRecommendation: { policyVersion: CANONICAL_RECOMMENDATION_POLICY,
      selected: opportunities[0], ranked: opportunities.slice(0, 3), decisionStatus: 'RECOMMENDED', model, asOf: at,
      odds: { source: 'odds_api', capturedAt: at, bookmakerBySelection: options.sharedOdds.bookmakerBySelection },
      probabilities: { raw: { homeWin: .6 }, decision: { homeWin: .6 } } } };
  } };
  const row = { match_id: 'm', home_team_id: 'h', away_team_id: 'a', competition: 'Serie A', season: '2026',
    date: '2026-10-30T19:00:00Z', home_goals: null, away_goals: null };
  const db = { getMatchById: async () => row, saveSchedulerRun: async () => {}, research: { saveModel: async () => {},
    listMarkets: async () => [], setMarketState: async () => {} } };
  const appOdds = { getQuotaStatus: () => null, load: async () => { loads++; return { ...sheets[0], sheets, metadata: {} }; } };
  const researchRuntime = { beginNightlyCohort: () => {}, getQuotaStatus: () => null,
    prepareNightly: async () => { throw Error('unavailable'); } };
  const runtime = new ResearchRecommendationRuntime(db, { clock: () => new Date(at), paperMode: true,
    predictionService: predictor, researchRuntime, appOdds });
  const result = await runtime.prepare({ id: 'j', leaseToken: 'l', originInputId: 'i', matchId: 'm', kickoffAt: row.date,
    windowStartAt: '2026-10-30T02:00:00Z', windowEndAt: '2026-10-31T02:00:00Z', runId: 'r', originDecisionIds: { A: 'a', C: 'c' } });
  const a = result.decisions.find((d) => d.family === 'A');
  assert.equal(loads, 1);
  assert.equal(a.action, 'BET');
  assert.equal(a.selections.length, 120);
  assert.equal(a.selections.find((s) => s.selectionKey === paperSelectionKey(alias)).quote.odds, 3);
  assert.equal(a.selections[0].probability, .6);
  for (const item of a.selections) {
    assert.equal(item.qualificationEvidence.calibrationSampleSize, 19);
    assert.equal(item.qualificationEvidence.categoryCalibrationStatus, 'insufficient_sample');
    assert.equal(item.qualificationEvidence.calibrationReliability, .16);
    assert.deepEqual(item.qualificationEvidence.dataWarnings, ['calibration_sample_insufficient']);
    assert.equal(item.qualificationEvidence.edgeNoVig, 1);
    assert.equal(item.qualificationEvidence.dynamicEvThreshold, 3);
    assert.equal(item.qualificationEvidence.rankingScore, 7);
    assert.ok(!Object.hasOwn(item.qualificationEvidence, 'suggestedStakePercent'));
    assert.ok(!Object.hasOwn(item.qualificationEvidence, 'kellyFraction'));
  }
  assert.equal(result.decisions.length, 2);
  const funded = new ResearchRecommendationRuntime(db, { clock: () => new Date(at), fundedMode: true,
    predictionService: predictor, researchRuntime, appOdds });
  const fundedResult = await funded.prepare({ id: 'j', leaseToken: 'l', originInputId: 'i', matchId: 'm', kickoffAt: row.date,
    windowStartAt: '2026-10-30T02:00:00Z', windowEndAt: '2026-10-31T02:00:00Z', runId: 'r', originDecisionIds: { A: 'a', C: 'c' } });
  const fundedA = fundedResult.decisions.find((d) => d.family === 'A');
  assert.equal(fundedResult.inputSnapshot.metadata.policy.version, 'funded-confidence-v1');
  assert.equal(fundedA.selections.length, 120);
  assert.ok(fundedA.selections.every((selection) => selection.confidence === 'MEDIUM'));
});
