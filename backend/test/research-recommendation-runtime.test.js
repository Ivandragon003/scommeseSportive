const test = require('node:test');
const assert = require('node:assert/strict');
const { ResearchRecommendationRuntime, buildChallengerRecommendation, challengerTechnicalReason } = require('../dist/research/ResearchRecommendationRuntime');
const { RECOMMENDATION_MODEL_C, RECOMMENDATION_BASELINE_C } = require('../dist/research/ResearchRecommendationPolicy');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');
const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../dist/research/CoherentProbabilityPipeline');
const { scoreMatrixMarkets } = require('../dist/research/GoalSettlement');
const { quoteForecast } = require('../dist/research/ResearchEvaluation');
const { researchHash } = require('../dist/research/ResearchStore');
const { ValueBettingEngine } = require('../dist/models/value/ValueBettingEngine');
const { CANONICAL_RECOMMENDATION_POLICY, pickCanonicalBetRecommendation } = require('../dist/services/CanonicalBetRecommendation');

const at = '2026-10-30T10:00:00.000Z';
const matrix = [[.2, .2, 0], [.6, 0, 0], [0, 0, 0]];
const quote = (selection, side, odds, overrides = {}) => ({ selection, side, odds, market: '1x2', bookmaker: 'Real Book',
  source: 'odds_api', priceType: 'prematch', capturedAt: at, updatedAt: at, ...overrides });
const quotes = () => [quote('homeWin', 'home', 2), quote('draw', 'draw', 4), quote('awayWin', 'away', 4)];
function challenger(overrides = {}) {
  const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion: RECOMMENDATION_BASELINE_C,
    pipelineHashV2: coherentProbabilityPipelineHash(), mode: 'identity' });
  return { family: 'C', modelVersion: RECOMMENDATION_MODEL_C, validated: true, action: 'ABSTAIN',
    reason: '{"insufficient_validation_calibration":3}', probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
    calibrationPipelineHash: coherentProbabilityPipelineHash(), calibrationAvailableAt: '2026-10-27T00:00:00Z',
    probabilityConfiguration: configuration.descriptor, probabilityConfigurationHash: configuration.hash,
    prospectiveMatrix: matrix, probabilityStages: { raw: scoreMatrixMarkets(matrix), decision: scoreMatrixMarkets(matrix) },
    forecastAt: at, ...overrides };
}
const opportunity = (overrides = {}) => ({ selection: 'homeWin', marketName: 'Vittoria casa', marketCategory: 'goal_1x2',
  marketTier: 'CORE', bookmakerOdds: 2, confidence: 'MEDIUM', ourProbability: 60, expectedValue: 20,
  edge: 10, edgeNoVig: 10, kellyFraction: 5, suggestedStakePercent: 2.34, isValueBet: true, ...overrides });
function fixture(options = {}) {
  let now = Date.parse(at);
  const calls = { prepare: 0, predict: [], registered: [], marketWrites: [], cohort: [], odds: 0, modelChecks: [] };
  const model = { source: 'PredictionService', version: `APP-A-${'a'.repeat(20)}`, codeHash: '1'.repeat(64),
    configHash: '2'.repeat(64), stateHash: '3'.repeat(64) };
  const selected = options.selected === undefined ? opportunity() : options.selected;
  const packet = { policyVersion: CANONICAL_RECOMMENDATION_POLICY, selected, ranked: selected ? [selected] : [],
    decisionStatus: selected ? 'RECOMMENDED' : 'NO_BET', asOf: at, model,
    odds: { source: 'odds_api', capturedAt: at, bookmakerBySelection: Object.fromEntries((options.quotes ?? quotes()).map((value) => [value.selection, value.bookmaker])) },
    probabilities: { raw: { homeWin: .61 }, decision: { homeWin: .6 } } };
  const row = { match_id: 'm1', home_team_id: 'h', away_team_id: 'a', home_team_name: 'Home', away_team_name: 'Away',
    competition: 'Serie A', season: '2026/2027', date: '2026-10-30T19:00:00Z', home_goals: null, away_goals: null };
  const job = { id: 'v2-job', leaseToken: 'owned-lease', matchId: 'm1', kickoffAt: row.date,
    windowStartAt: '2026-10-30T02:07:00Z', windowEndAt: '2026-10-31T02:07:00Z', runId: 'real-run',
    policyHash: '4'.repeat(64), originInputId: 'immutable-input-v1', originDecisionIds: { A: 'origin-A', C: 'origin-C' } };
  const prepared = { job, status: 'upcoming', kickoffAt: row.date, quotes: options.quotes ?? quotes(),
    inputSnapshot: { observedAt: at, match: { matchId: 'm1' }, providerEventId: 'odds-real-fixture' },
    decisions: [{ family: 'A', modelVersion: RECOMMENDATION_BASELINE_C, action: 'ABSTAIN', validated: true },
      options.challenger ?? challenger()] };
  const markets = ['1x2', 'asian_handicap'].map((market) => ({ family: 'C', market, state: 'EXPERIMENTAL' }));
  const db = { getMatchById: async () => row, saveSchedulerRun: async (run) => { calls.modelChecks.push(run); }, research: {
    listMarkets: async ({ family }) => markets.filter((market) => market.family === family),
    saveModel: async (value) => { calls.registered.push(value); now += 10; return value; },
    setMarketState: async (value) => { calls.marketWrites.push(value); markets.push(value); now += 10; },
  } };
  const researchRuntime = { prepareNightly: async () => { calls.prepare++; if (options.prepareFailure) throw options.prepareFailure; return prepared; },
    beginNightlyCohort: (id) => calls.cohort.push(id), getQuotaStatus: () => ({ remaining: 205 }) };
  const predictionService = { predict: async (request, settings) => {
    calls.predict.push({ request, settings }); if (options.predictionFailure) throw Error('private-url-sentinel');
    now += options.advanceDuringPrediction ?? 0;
    return { canonicalRecommendation: packet };
  } };
  const odds = { getQuotaStatus: () => ({ remaining: 205 }), getOdds: async () => {
    calls.odds++; return [{ matchId: 'odds-real-fixture', homeTeam: 'Home', awayTeam: 'Away', commenceTime: row.date,
      capturedAt: at, provider: 'odds_api', bookmakers: [{ bookmakerName: 'Real Book', bookmakerKey: 'real', updatedAt: at,
        markets: [{ marketKey: 'h2h', outcomes: [{ name: 'Home', price: 2 }, { name: 'Draw', price: 4 }, { name: 'Away', price: 4 }] }] }] }];
  } };
  const runtime = new ResearchRecommendationRuntime(db, { clock: () => new Date(now), researchRuntime, predictionService, odds });
  return { runtime, job, packet, prepared, row, calls, db, researchRuntime, predictionService, odds, clock: () => new Date(now),
    setTime: (value) => { now = Date.parse(value); } };
}

test('runtime accepts aliases emitted by the real app predictor while binding the actual pick to the original price sheet', async () => {
  const { PredictionService } = require('../dist/services/PredictionService');
  const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
  const sheet = [quote('homeWin', 'home', 3.6), quote('draw', 'draw', 3.9), quote('awayWin', 'away', 2.1)];
  const f = fixture({ quotes: sheet });
  f.row.home_team_id = 'home'; f.row.away_team_id = 'away'; f.row.competition = 'Test League';
  const params = new DixonColesModel().getParams();
  params.attackParams = { home: .4, away: -.4 }; params.defenceParams = { home: 0, away: 0 };
  Object.assign(f.db, {
    getLatestModelParams: async () => ({ params }),
    getTeamsByIds: async (ids) => ids.map((team_id) => ({ team_id, name: team_id, competition: 'Test League' })),
    getTeamHistoricalCoverageBatch: async () => ({}), getTeamScheduleInsightsBatch: async () => ({}),
    appendPredictions: async () => assert.fail('Preview must not duplicate app prediction audit'),
  });
  const predictor = new PredictionService(f.db, { getMatchDetails: async () => assert.fail('Unexpected provider request') });
  predictor.applyAdaptiveTuning = async () => null;
  // Preserve real DC/Poisson/engine inference; isolate only expensive calibration fitting with truthful zero observations.
  predictor.getCalibrationProfile = async () => ({ calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    nObservations: 0, byFamily: {}, learnedBlendWeights: {} });
  const runtime = new ResearchRecommendationRuntime(f.db, { clock: f.clock, researchRuntime: f.researchRuntime,
    predictionService: predictor, odds: f.odds });
  const result = await runtime.prepare(f.job);
  const packet = result.inputSnapshot.forecasts.A;
  assert.ok(Object.hasOwn(packet.odds.bookmakerBySelection, 'homewin'));
  assert.ok(Object.hasOwn(packet.odds.bookmakerBySelection, 'awaywin'));
  assert.equal(packet.selected.selection, 'homeWin');
  assert.equal(result.decisions[0].action, 'BET'); assert.equal(result.decisions[0].selection, packet.selected.selection);
  assert.equal(result.decisions[0].quote, sheet[0]); assert.equal(result.decisions[0].quote.odds, packet.selected.bookmakerOdds);
  assert.equal(result.decisions[0].suggestedStakePercent, packet.selected.suggestedStakePercent);
  const check = f.calls.modelChecks.find((run) => run.summary.source === 'PredictionService');
  assert.equal(check.success, true); assert.equal(check.summary.checks.sharedSnapshot, true);
});

test('C uses the canonical picker and existing engine units: probability .6 at odds2 remains EV20%, without double calibration', () => {
  const decision = challenger();
  assert.equal(challengerTechnicalReason(decision, at), null);
  const result = buildChallengerRecommendation({ decision, quotes: quotes(), observedAt: at,
    competition: 'Serie A', allowedMarkets: ['1x2'] });
  const home = result.opportunities.find((value) => value.selection === 'homeWin');
  assert.ok(home); assert.equal(home.ourProbability, 60); assert.equal(home.expectedValue, 20);
  assert.equal(home.calibratedProbability, 60); assert.equal(home.blendedProbability, 60);
  const expected = new ValueBettingEngine().analyzeMarketsWithVigRemoval({ homeWin: .6, draw: .2, awayWin: .2 }, {
    homeWin: { selection: 'homeWin', odds: 2, companions: [4, 4] },
    draw: { selection: 'draw', odds: 4, companions: [2, 4] }, awayWin: { selection: 'awayWin', odds: 4, companions: [2, 4] },
  }, { homeWin: 'homeWin', draw: 'draw', awayWin: 'awayWin' }, {
    competition: 'Serie A', enableMarketCalibration: false, enableMarketBlending: false,
  });
  const withoutPolicyStake = (value) => {
    const { engineSuggestedStakePercent, ...original } = value;
    return { ...original, suggestedStakePercent: engineSuggestedStakePercent };
  };
  assert.deepEqual(result.opportunities.map(withoutPolicyStake), expected);
  assert.deepEqual(result.ranked.map(withoutPolicyStake), pickCanonicalBetRecommendation({ valueOpportunities: expected }).ranked);
  assert.equal(result.selected.selection, 'homeWin');
  assert.equal(result.selected.suggestedStakePercent, 1);
});

test('quarter stakes keep their existing payout EV but cannot acquire an invented binary confidence; supported alternatives remain eligible', () => {
  const quarter = quote('ahcp_-0.25', 'home', 2, { market: 'asian_handicap', line: -.25 });
  const opposite = quote('ahcp_away_0.25', 'away', 2, { market: 'asian_handicap', line: .25 });
  const frozen = JSON.stringify(matrix);
  const payout = quoteForecast(matrix, quarter, scoreMatrixMarkets(matrix));
  assert.ok(payout.activeStake < 1);
  const result = buildChallengerRecommendation({ decision: challenger(), quotes: [...quotes(), quarter, opposite],
    observedAt: at, allowedMarkets: ['1x2', 'asian_handicap'] });
  assert.equal(result.exclusions.non_binary_payout_not_supported_by_canonical_engine, 2);
  assert.equal(result.selected.selection, 'homeWin');
  assert.ok(result.opportunities.every((value) => value.selection !== quarter.selection));
  assert.equal(JSON.stringify(matrix), frozen);
});

test('market companions never cross bookmakers, lines or incompatible challenger identities', () => {
  const mixed = quotes(); mixed[1] = { ...mixed[1], bookmaker: 'Other Book' };
  const result = buildChallengerRecommendation({ decision: challenger(), quotes: mixed, observedAt: at, allowedMarkets: ['1x2'] });
  assert.equal(result.selected, null); assert.equal(result.exclusions.complete_bookmaker_market_required, 3);
  for (const bad of [challenger({ validated: false }), challenger({ modelVersion: 'C-other' }),
    challenger({ calibrationPipelineHash: '0'.repeat(64) }), challenger({ probabilityConfigurationHash: '0'.repeat(64) }),
    challenger({ calibrationAvailableAt: '2026-11-01T00:00:00Z' }), challenger({ prospectiveMatrix: [[NaN]] }),
    challenger({ probabilityStages: { decision: { homeWin: .99 } } })]) {
    const reason = challengerTechnicalReason(bad, at);
    assert.ok(reason);
    const refused = buildChallengerRecommendation({ decision: bad, quotes: quotes(), observedAt: at, allowedMarkets: ['1x2'] });
    assert.equal(refused.selected, null); assert.equal(refused.exclusions[reason], 1);
  }
});

test('runtime preserves exact app A pick/stake and independent C1%, origin lineage and shared quote snapshot', async () => {
  const f = fixture(); f.runtime.beginCohort('real-run');
  const result = await f.runtime.prepare(f.job);
  assert.equal(f.calls.prepare, 1); assert.equal(f.calls.odds, 0); assert.deepEqual(f.calls.cohort, ['real-run']);
  assert.equal(f.calls.predict.length, 1);
  assert.equal(f.calls.predict[0].settings.recordAudit, false);
  assert.deepEqual(f.calls.predict[0].settings.sharedOdds.odds, { homeWin: 2, draw: 4, awayWin: 4 });
  assert.equal(result.originInputId, f.job.originInputId);
  assert.equal(result.inputSnapshot.match.matchId, f.job.matchId);
  assert.equal(result.inputSnapshot.forecasts.A, f.packet);
  assert.equal(result.inputSnapshot.forecasts.C.decision, f.prepared.decisions[1]);
  assert.deepEqual(result.decisions.map((value) => [value.family, value.action, value.originDecisionId]),
    [['A', 'BET', 'origin-A'], ['C', 'BET', 'origin-C']]);
  assert.equal(result.decisions[0].modelVersion, f.packet.model.version);
  assert.equal(result.decisions[0].suggestedStakePercent, 2.34); assert.equal(result.decisions[1].suggestedStakePercent, 1);
  assert.equal(result.inputSnapshot.forecasts.C.recommendation.selected.suggestedStakePercent, result.decisions[1].suggestedStakePercent);
  assert.ok(Number.isFinite(result.inputSnapshot.forecasts.C.recommendation.selected.engineSuggestedStakePercent));
  assert.equal(result.decisions[0].ev, .2); assert.equal(result.decisions[1].ev, .2);
  assert.equal(result.decisions[0].probability, .6); assert.equal(result.decisions[1].probability, .6);
  assert.equal(result.inputSnapshot.forecasts.A.asOf, at); assert.equal(result.inputSnapshot.forecasts.C.decision.forecastAt, at);
  assert.ok(Date.parse(result.inputSnapshot.observedAt) > Date.parse(at));
  assert.equal(f.calls.registered.length, 1); assert.equal(f.calls.registered[0].family, 'A');
  assert.deepEqual(f.calls.registered[0].artifact, result.inputSnapshot.modelDescriptorA);
  assert.equal('stateHash' in f.calls.registered[0].artifact, false);
  assert.ok(f.calls.marketWrites.every((value) => value.family === 'A' && value.state === 'EXPERIMENTAL'));
  assert.equal(result.decisions[0].probabilityConfigurationHash, researchHash(result.decisions[0].probabilityConfiguration));
});

test('technical C failure and zero independent residuals cannot silently veto exact app A; API failures do not retry', async () => {
  const f = fixture({ challenger: challenger({ validated: false }) });
  const result = await f.runtime.prepare(f.job);
  assert.equal(result.decisions[0].action, 'BET'); assert.equal(result.decisions[1].action, 'ABSTAIN');
  assert.equal(result.decisions[1].reason, 'challenger_technical_validation_failed');
  const unavailable = fixture({ prepareFailure: Error('private-history-failure') });
  const recovered = await unavailable.runtime.prepare(unavailable.job);
  assert.equal(unavailable.calls.odds, 1); assert.equal(recovered.decisions[0].action, 'BET');
  assert.equal(recovered.decisions[1].reason, 'research_forecast_unavailable');
  assert.doesNotMatch(JSON.stringify(recovered), /private-history/);
  const blocked = fixture({ prepareFailure: Object.assign(Error('private-request'), { code: 'odds_credit_budget_exhausted' }) });
  await assert.rejects(blocked.runtime.prepare(blocked.job), { code: 'odds_credit_budget_exhausted' });
  assert.equal(blocked.calls.odds, 0); assert.equal(blocked.calls.predict.length, 0);
});

test('the actual recommendation preparer pins C906 and keeps app A available when only a newer candidate exists', async () => {
  const f = fixture(); const exactReads = [], registry = [{ family: 'C', version: 'C-weekly-next' }];
  f.db.getMatches = async () => Array.from({ length: 45 }, (_, index) => ({ ...f.row, match_id: `history-${index}`,
    date: new Date(Date.parse(at) - (index + 2) * 86400000).toISOString(), home_goals: index % 3, away_goals: index % 2,
    home_xg: 1.4, away_xg: 1.1 }));
  Object.assign(f.db.research, {
    getModelByVersion: async (family, version) => {
      exactReads.push({ family, version }); return registry.find((model) => model.family === family && model.version === version) ?? null;
    },
    getModels: async () => assert.fail('Pinned preparation must not list weekly candidate artifacts'),
    getChampion: async () => assert.fail('Pinned preparation must not follow the champion'),
    getLatestBenchmark: async () => null, listProspectiveCalibrationSamples: async () => [],
  });
  const runtime = new ResearchRecommendationRuntime(f.db, { clock: f.clock, predictionService: f.predictionService, odds: f.odds });
  const result = await runtime.prepare(f.job);
  assert.deepEqual(exactReads, [{ family: 'C', version: RECOMMENDATION_MODEL_C }]);
  assert.equal(result.decisions[0].action, 'BET'); assert.equal(result.decisions[0].modelVersion, f.packet.model.version);
  assert.equal(result.decisions[1].action, 'ABSTAIN'); assert.equal(result.decisions[1].reason, 'challenger_technical_validation_failed');
});

test('app NO_BET and app technical error remain distinct, without forcing a replacement app pick', async () => {
  for (const options of [{ selected: null }, { predictionFailure: true }]) {
    const f = fixture(options); const result = await f.runtime.prepare(f.job);
    assert.equal(result.decisions[0].action, 'ABSTAIN');
    assert.equal(result.decisions[0].reason, options.predictionFailure ? 'app_prediction_unavailable' : 'app_no_recommendation');
    assert.equal(result.decisions[1].action, 'BET');
    const check = f.calls.modelChecks.find((run) => run.summary.source === 'PredictionService');
    assert.ok(check); assert.equal(check.schedulerName, 'research_model_check');
    assert.equal(check.success, !options.predictionFailure);
    assert.equal(check.summary.modelVersion, options.predictionFailure ? 'APP-A-unavailable' : f.packet.model.version);
    if (options.predictionFailure) assert.equal(check.summary.errorCode, 'app_prediction_unavailable');
    else assert.equal(check.summary.errorCode, undefined);
    assert.doesNotMatch(JSON.stringify(check), /private-url/);
  }
});

test('actual app A model monitoring identifies preview context and real positive checks independently of diagnostic A80', async () => {
  const f = fixture(); f.job.preview = true;
  await f.runtime.prepare(f.job);
  assert.equal(f.calls.modelChecks.length, 1);
  const check = f.calls.modelChecks[0];
  assert.equal(check.success, true); assert.equal(check.summary.executionContext, 'recommendations-preview');
  assert.equal(check.summary.source, 'PredictionService'); assert.equal(check.summary.modelVersion, f.packet.model.version);
  assert.equal(check.summary.jobId, f.job.id); assert.equal(check.startedAt, at);
  assert.ok(Object.values(check.summary.checks).every(Boolean));
});

test('malformed app packet provenance or nonfinite probabilities produce a failed actual-A check without blocking C', async () => {
  for (const corrupt of [(packet) => { packet.odds.source = 'model_completion'; },
    (packet) => { packet.odds.bookmakerBySelection.homeWin = 'Different Book'; },
    (packet) => { packet.selected.selection = 'homewin'; packet.odds.bookmakerBySelection.homewin = 'Real Book'; },
    (packet) => { packet.probabilities.raw.homeWin = NaN; },
    (packet) => { packet.policyVersion = 'unexpected-policy'; }]) {
    const f = fixture(); corrupt(f.packet);
    const result = await f.runtime.prepare(f.job);
    assert.equal(result.decisions[0].action, 'ABSTAIN'); assert.equal(result.decisions[1].action, 'BET');
    assert.equal(f.calls.registered.length, 0);
    assert.equal(f.calls.modelChecks[0].success, false);
    assert.equal(f.calls.modelChecks[0].summary.errorCode, 'invalid_app_recommendation_packet');
  }
});

test('app A quarter-line recommendation retains its original stake while C explicitly excludes that unsupported confidence path', async () => {
  const quarter = quote('ahcp_-0.25', 'home', 2, { market: 'asian_handicap', line: -.25 });
  const opposite = quote('ahcp_away_0.25', 'away', 2, { market: 'asian_handicap', line: .25 });
  const f = fixture({ quotes: [...quotes(), quarter, opposite], selected: opportunity({ selection: quarter.selection, marketCategory: 'handicap' }) });
  const result = await f.runtime.prepare(f.job);
  assert.equal(result.decisions[0].action, 'BET'); assert.equal(result.decisions[0].selection, quarter.selection);
  assert.equal(result.decisions[0].suggestedStakePercent, f.packet.selected.suggestedStakePercent);
  assert.equal(result.inputSnapshot.forecasts.A.selected, f.packet.selected);
  assert.equal(result.inputSnapshot.forecasts.C.recommendation.exclusions.non_binary_payout_not_supported_by_canonical_engine, 2);
  assert.equal(result.decisions[1].selection, 'homeWin');
});

test('a long app calculation cannot retimestamp old quotes or bypass the final kickoff check', async () => {
  const expired = fixture({ advanceDuringPrediction: 301000 });
  const result = await expired.runtime.prepare(expired.job);
  assert.ok(result.decisions.every((value) => value.action === 'ABSTAIN'));
  assert.equal(result.inputSnapshot.forecasts.A.asOf, at);
  assert.equal(result.inputSnapshot.forecasts.C.decision.forecastAt, at);
  assert.equal(result.inputSnapshot.quotes[0].capturedAt, at);
  const afterKickoff = fixture({ advanceDuringPrediction: 10 * 3600000 });
  await assert.rejects(afterKickoff.runtime.prepare(afterKickoff.job), /fixture_not_eligible/);
});

test('pre-kickoff/window and quote truth guards stop synthetic, stale or unavailable execution', async () => {
  const started = fixture(); started.setTime(started.row.date);
  await assert.rejects(started.runtime.prepare(started.job), /fixture_not_eligible/);
  assert.equal(started.calls.prepare, 0); assert.equal(started.calls.predict.length, 0);
  for (const patch of [{ source: 'model_completion' }, { priceType: 'closing' }, { updatedAt: '2026-10-30T09:54:00Z' }]) {
    const f = fixture({ quotes: quotes().map((value) => ({ ...value, ...patch })) });
    const result = await f.runtime.prepare(f.job);
    assert.equal(f.calls.predict.length, 0); assert.ok(result.decisions.every((value) => value.action === 'ABSTAIN'));
    assert.equal(result.decisions[0].reason, 'real_fresh_quotes_unavailable');
  }
});
