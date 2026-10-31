const test = require('node:test');
const assert = require('node:assert/strict');
const { ResearchRuntime } = require('../dist/research/ResearchRuntime');
const { ResearchRecommendationRuntime } = require('../dist/research/ResearchRecommendationRuntime');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = require('../dist/research/ForecastCore');
const { CHALLENGER_FEATURE_SCHEMA_VERSION, CHALLENGER_FEATURE_PROTOCOL, challengerFeatureNames } = require('../dist/research/ChallengerFeatures');
const { COHERENT_PROBABILITY_PROTOCOL, coherentProbabilityPipelineHash } = require('../dist/research/CoherentProbabilityPipeline');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');
const { researchHash } = require('../dist/research/ResearchStore');
const { scoreMatrixMarkets } = require('../dist/research/GoalSettlement');
const { VIRTUAL_RECOMMENDATION_POLICY, challengerExecutionPolicy, fallbackChallengerState, unavailableChallengerState } = require('../dist/research/ResearchRecommendationPolicy');

const AT = '2026-10-31T12:00:00.000Z', KICKOFF = '2026-10-31T19:00:00.000Z';
const policy = { quoteMaxAgeMs: 300000, minEv: .04, minPrudentialEv: .01 };
function artifact(extended = false) {
  return { family: 'C', version: extended ? 'C-integration-extended' : 'C-integration-legacy',
    featureNames: extended ? challengerFeatureNames() : FEATURE_NAMES,
    featureSchema: extended ? CHALLENGER_FEATURE_SCHEMA_VERSION : FEATURE_SCHEMA_VERSION,
    baselineVersion: baselineManifest().version, candidateKind: 'no_ml', weight: 0, temperature: 1, models: {},
    trainedThrough: '2026-08-01T00:00:00Z', validationThrough: '2026-10-01T00:00:00Z', createdAt: '2026-10-02T00:00:00Z',
    probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2: coherentProbabilityPipelineHash(), probabilityCalibrationMode: 'identity',
    ...(extended ? { featureBlocks: ['recent_xg', 'schedule'], featureProtocol: CHALLENGER_FEATURE_PROTOCOL,
      trainingForecastTiming: { policy: 'nightly-asof', forecastBeforeKickoff: true, resultDelayMs: 7200000 },
      trainingSplit: { protocol: 'purged-temporal-train-selection-calibration-test-v1',
        ...Object.fromEntries(['train', 'selection', 'calibration', 'test'].map((key, index) => [key, {
          from: `2026-0${index + 1}-01T00:00:00Z`, to: `2026-0${index + 1}-10T00:00:00Z`,
          availableThrough: `2026-0${index + 1}-11T00:00:00Z`, n: 20,
        }])) } } : {}) };
}
function deployment(model) {
  return { modelVersion: model.version, baselineVersion: model.baselineVersion, selectorPolicy: 'payout-aware-v1',
    artifactHash: researchHash(model), probabilityConfigurationHash: buildProbabilityConfiguration({ family: 'C',
      baselineVersion: model.baselineVersion, pipelineHashV2: model.pipelineHashV2, mode: 'identity' }).hash };
}
function harness(model, options = {}) {
  const row = { match_id: 'integration-fixture', home_team_id: 'h', away_team_id: 'a', home_team_name: 'Home', away_team_name: 'Away',
    date: KICKOFF, competition: 'Serie A', season: '2026/27', home_goals: null, away_goals: null };
  const history = Array.from({ length: 45 }, (_, index) => ({ ...row, match_id: `history-${index}`,
    date: new Date(Date.parse(AT) - (index + 2) * 86400000).toISOString(), home_goals: index % 3,
    away_goals: index % 2, home_xg: 1.4, away_xg: 1.1 }));
  const calls = { modelReads: [], runs: [], paired: [], collecting: 0 };
  const db = { research: { getModelByVersion: async (family, version) => {
    calls.modelReads.push([family, version]); return version === model.version ? { version, artifact: model, artifactHash: researchHash(model) } : null;
  }, getLatestBenchmark: async (family) => family === 'C' && options.changedBenchmark
    ? { createdAt: AT, report: { ...model, probabilityCalibrationMode: 'temperature', probabilityTemperature: 2 } } : null,
  listMarkets: async ({ family }) => [{ family, market: '1x2', state: 'EXPERIMENTAL' }],
  listProspectiveCalibrationSamples: async () => [],
  }, getMatchById: async () => row, getMatches: async () => history, saveSchedulerRun: async (run) => calls.runs.push(run) };
  if (options.sidecar) db.challengerAdoption = { listCollectingCandidates: async () => { calls.collecting++; return [{ id: 'dossier' }]; },
    recordPairedChallengerForecast: async (input) => {
      calls.paired.push(input); if (options.sidecarFailure) throw Error('private sidecar failure'); return { recorded: true, id: 'paired' };
    } };
  const odds = { getOdds: async () => [{ matchId: 'provider-fixture', homeTeam: 'Home', awayTeam: 'Away', commenceTime: KICKOFF,
    capturedAt: AT, bookmakers: [{ bookmakerKey: 'fixture', bookmakerName: 'Fixture Book', updatedAt: AT,
      markets: [{ marketKey: 'h2h', outcomes: [{ name: 'Home', price: 2 }, { name: 'Draw', price: 4 }, { name: 'Away', price: 4 }] }] }] }] };
  const runtime = new ResearchRuntime(db, { clock: () => new Date(AT), odds, nightly: policy, deploymentC: deployment(model) });
  const job = { id: 'job', runId: 'cohort', matchId: row.match_id, kickoffAt: KICKOFF, targetAt: AT, leaseToken: 'lease' };
  return { runtime, job, row, db, calls };
}

test('fallback keeps the original immutable execution policy; adoption changes only C and policy identity', () => {
  assert.equal(challengerExecutionPolicy(fallbackChallengerState()), VIRTUAL_RECOMMENDATION_POLICY);
  const state = { deployment: deployment(artifact(true)), source: 'adopted', revision: 'revision-1' };
  const policy = challengerExecutionPolicy(state);
  assert.equal(policy.familyA, VIRTUAL_RECOMMENDATION_POLICY.familyA);
  assert.equal(policy.version, 'virtual-recommendation-v3'); assert.equal(policy.familyC.modelVersion, state.deployment.modelVersion);
  assert.notEqual(researchHash(policy), researchHash(VIRTUAL_RECOMMENDATION_POLICY));
  assert.notEqual(researchHash(policy), researchHash(challengerExecutionPolicy({ ...state, revision: 'revision-2' })));
});

test('extended C features leave the entire baseline input and diagnostic A probabilities unchanged', async () => {
  const legacy = harness(artifact()), extended = harness(artifact(true));
  const before = await legacy.runtime.prepareNightly(legacy.job), after = await extended.runtime.prepareNightly(extended.job);
  assert.deepEqual(after.inputSnapshot.forecast, before.inputSnapshot.forecast);
  const aBefore = before.decisions.find((row) => row.family === 'A'), aAfter = after.decisions.find((row) => row.family === 'A');
  assert.deepEqual(aAfter.probabilityStages, aBefore.probabilityStages);
  assert.equal(aAfter.action, aBefore.action); assert.equal(aAfter.probabilityConfigurationHash, aBefore.probabilityConfigurationHash);
  assert.equal(after.inputSnapshot.forecast.featureSchema, FEATURE_SCHEMA_VERSION);
  assert.equal(after.inputSnapshot.challengerForecast.featureSchema, CHALLENGER_FEATURE_SCHEMA_VERSION);
  const c = after.decisions.find((row) => row.family === 'C');
  assert.equal(c.validated, true); assert.equal(c.challengerQuality.homeHistorySample, 45);
  assert.equal(c.challengerQuality.homeXgCoverage, 1);
});

test('approved C artifact and calibration remain pinned while a mutable benchmark suggests a different configuration', async () => {
  const model = artifact(true), h = harness(model, { changedBenchmark: true });
  const first = await h.runtime.prepareNightly(h.job), second = await h.runtime.prepareNightly({ ...h.job, id: 'job-two' });
  for (const result of [first, second]) assert.equal(result.decisions.find((row) => row.family === 'C').probabilityConfigurationHash,
    deployment(model).probabilityConfigurationHash);
  assert.deepEqual(h.calls.modelReads, [['C', model.version]]);
});

test('candidate sidecar records once per match without changing A and keeps failures as explicit evidence', async () => {
  const control = harness(artifact()), h = harness(artifact(), { sidecar: true, sidecarFailure: true });
  const baseline = await control.runtime.prepareNightly(control.job), first = await h.runtime.prepareNightly(h.job);
  const repeated = await h.runtime.prepareNightly(h.job);
  assert.deepEqual(first.decisions.find((row) => row.family === 'A'), baseline.decisions.find((row) => row.family === 'A'));
  assert.equal(h.calls.collecting, 1); assert.equal(h.calls.paired.length, 1);
  assert.deepEqual(h.calls.paired[0].input, baseline.inputSnapshot.forecast);
  assert.ok(h.calls.paired[0].history.length); assert.ok(h.calls.paired[0].quotes.length);
  assert.equal(first.inputSnapshot.challengerCollection.failures[0].reason, 'paired_challenger_forecast_failed');
  assert.deepEqual(repeated.inputSnapshot.challengerCollection, first.inputSnapshot.challengerCollection);
  assert.ok(h.calls.runs.some((row) => row.schedulerName === 'research_challenger_collection' && row.success === false));
});

test('adopted payout-aware C can execute a split payout while the exact A packet and advice stay untouched', async () => {
  const model = artifact(), state = { deployment: deployment(model), source: 'adopted', revision: 'approved' };
  const matrix = [[.1, .1], [.8, 0]], quote = { selection: 'ahcp_-0.25', market: 'asian_handicap', side: 'home', line: -.25,
    odds: 2, bookmaker: 'Real Book', source: 'odds_api', priceType: 'prematch', capturedAt: AT, updatedAt: AT };
  const opposite = { ...quote, selection: 'ahcp_away_0.25', side: 'away', line: .25 };
  const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion: model.baselineVersion,
    pipelineHashV2: coherentProbabilityPipelineHash(), mode: 'identity' });
  const decision = { family: 'C', modelVersion: model.version, validated: true, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
    calibrationPipelineHash: coherentProbabilityPipelineHash(), calibrationAvailableAt: AT, prospectiveMatrix: matrix,
    probabilityStages: { decision: scoreMatrixMarkets(matrix) }, probabilityConfiguration: configuration.descriptor,
    probabilityConfigurationHash: configuration.hash, prudentialSamplesAvailable: 0 };
  const packetA = { policyVersion: 'match-page-recommendation-v1', selected: null, ranked: [], decisionStatus: 'NO_BET', asOf: AT,
    model: { source: 'PredictionService', version: `APP-A-${'a'.repeat(20)}`, codeHash: '1'.repeat(64), configHash: '2'.repeat(64), stateHash: '3'.repeat(64) },
    odds: { source: 'odds_api', capturedAt: AT, bookmakerBySelection: { homeWin: 'Real Book' } },
    probabilities: { raw: { homeWin: .6 }, decision: {} } };
  const row = { match_id: 'match', date: KICKOFF, home_goals: null, away_goals: null, competition: 'Serie A' };
  const runtime = new ResearchRecommendationRuntime({ getMatchById: async () => row, saveSchedulerRun: async () => {}, research: {
    listMarkets: async ({ family }) => family === 'C' ? [{ market: 'asian_handicap', state: 'EXPERIMENTAL' }] : [],
    saveModel: async () => {}, setMarketState: async () => {},
  } }, { clock: () => new Date(AT), deploymentC: state,
    researchRuntime: { prepareNightly: async () => ({ status: 'upcoming', kickoffAt: KICKOFF, quotes: [quote, opposite], decisions: [decision] }),
      beginNightlyCohort: () => {}, getQuotaStatus: () => null }, predictionService: { predict: async () => ({ canonicalRecommendation: packetA }) },
    appOdds: { getQuotaStatus: () => null, load: async () => ({ quotes: [{ ...quote, selection: 'homeWin', market: '1x2', side: 'home' }],
      sharedOdds: { odds: { homeWin: 2 }, bookmakerBySelection: { homeWin: 'Real Book' }, source: 'odds_api', capturedAt: AT } }) } });
  const result = await runtime.prepare({ id: 'job', matchId: 'match', kickoffAt: KICKOFF, windowStartAt: AT,
    windowEndAt: '2026-11-01T02:00:00Z', leaseToken: 'lease', originInputId: 'input', originDecisionIds: { A: 'a', C: 'c' } });
  assert.equal(result.inputSnapshot.forecasts.A, packetA); assert.equal(result.decisions[0].action, 'ABSTAIN');
  assert.equal(result.decisions[1].action, 'BET'); assert.equal(result.decisions[1].suggestedStakePercent, 1);
  assert.equal(result.decisions[1].selectorPolicy, 'payout-aware-v1'); assert.ok(result.decisions[1].payout.outcomes.length);
  assert.equal(result.inputSnapshot.metadata.policy.version, 'virtual-recommendation-v3');
  runtime.beginCohort('state-unavailable', unavailableChallengerState());
  const unavailable = await runtime.prepare({ id: 'job', matchId: 'match', kickoffAt: KICKOFF, windowStartAt: AT,
    windowEndAt: '2026-11-01T02:00:00Z', leaseToken: 'lease', originInputId: 'input', originDecisionIds: { A: 'a', C: 'c' } });
  assert.equal(unavailable.inputSnapshot.forecasts.A, packetA);
  assert.equal(unavailable.decisions[0].action, 'ABSTAIN');
  assert.equal(unavailable.decisions[1].action, 'ABSTAIN');
  assert.equal(unavailable.decisions[1].reason, 'adoption_state_unavailable');
  assert.equal(unavailable.inputSnapshot.forecasts.C.decision, null);
  decision.challengerQuality = { homeHistorySample: -1 };
  runtime.beginCohort('invalid-c-quality', state);
  const degraded = await runtime.prepare({ id: 'job', matchId: 'match', kickoffAt: KICKOFF, windowStartAt: AT,
    windowEndAt: '2026-11-01T02:00:00Z', leaseToken: 'lease', originInputId: 'input', originDecisionIds: { A: 'a', C: 'c' } });
  assert.equal(degraded.inputSnapshot.forecasts.A, packetA);
  assert.ok(degraded.inputSnapshot.forecasts.C.recommendation.abstentionReason);
  assert.equal(degraded.decisions[1].reason, degraded.inputSnapshot.forecasts.C.recommendation.abstentionReason);
});
