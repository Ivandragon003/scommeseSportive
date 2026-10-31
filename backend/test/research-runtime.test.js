const test = require('node:test');
const assert = require('node:assert/strict');
const { ResearchRuntime, researchQuotesFromEvent, settleResearchBets } = require('../dist/research/ResearchRuntime');
const { OddsApiService } = require('../dist/services/OddsApiService');
const { quoteFreshnessReason } = require('../dist/research/T15Scheduler');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = require('../dist/research/ForecastCore');
const { COHERENT_PROBABILITY_PROTOCOL, coherentProbabilityPipelineHash, fitCoherentCalibration } = require('../dist/research/CoherentProbabilityPipeline');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');
const { ResearchStore } = require('../dist/research/ResearchStore');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');

const TARGET = '2026-10-27T19:30:00.000Z';
const KICKOFF = '2026-10-27T19:45:00.000Z';

const event = (changes = {}) => ({ matchId: 'odds_provider-id', homeTeam: 'Home', awayTeam: 'Away', commenceTime: KICKOFF,
  bookmakers: [{ bookmakerKey: 'test_international', bookmakerName: 'Fixture International', updatedAt: TARGET,
    markets: [{ marketKey: 'h2h', outcomes: [{ name: 'Home', price: 1.9 }, { name: 'Draw', price: 3.5 }, { name: 'Away', price: 4 }] }] }], ...changes });

test('provider parsing retains actual quote update times, including event markets', () => {
  const service = new OddsApiService('unit-test-only');
  const raw = { id: 'id', home_team: 'Home', away_team: 'Away', commence_time: KICKOFF,
    bookmakers: [{ key: 'test', title: 'Fixture Book', last_update: '2026-10-27T19:20:00Z',
      markets: [{ key: 'h2h', last_update: '2026-10-27T19:21:00Z', outcomes: [{ name: 'Home', price: 1.9 }] }] }] };
  for (const parsed of [service.parseOddsResponse([raw])[0], service.parseSingleEventResponse(raw)]) {
    assert.equal(parsed.bookmakers[0].updatedAt, raw.bookmakers[0].last_update);
    assert.equal(parsed.bookmakers[0].markets[0].updatedAt, raw.bookmakers[0].markets[0].last_update);
    const quote = researchQuotesFromEvent(parsed, TARGET)[0];
    assert.equal(quote.capturedAt, TARGET);
    assert.equal(quoteFreshnessReason(quote, Date.parse(TARGET)), 'quote_stale');
  }
});

test('quote normalization uses Eurobet when actually present, with one coherent sheet and no invented markets', () => {
  const fixture = event();
  fixture.bookmakers.push({ ...fixture.bookmakers[0], bookmakerKey: 'eurobet', bookmakerName: 'Eurobet',
    markets: [{ marketKey: 'h2h', outcomes: [{ name: 'Home', price: 1.85 }, { name: 'Draw', price: 3.4 }, { name: 'Away', price: 4.1 }] }] });
  const quotes = researchQuotesFromEvent(fixture, TARGET);
  assert.equal(quotes.length, 3);
  assert.ok(quotes.every((quote) => quote.bookmaker === 'Eurobet' && quote.source === 'odds_api'));
  assert.equal(quotes[0].odds, 1.85);
  fixture.bookmakers[1].updatedAt = '2026-10-27T19:20:00Z';
  assert.ok(researchQuotesFromEvent(fixture, TARGET).every((quote) => quote.bookmaker === 'Fixture International'));
  fixture.bookmakers[1].updatedAt = TARGET;
  fixture.bookmakers[1].markets[0].outcomes.pop();
  assert.ok(researchQuotesFromEvent(fixture, TARGET).every((quote) => quote.bookmaker === 'Fixture International'));
  const absent = researchQuotesFromEvent(event(), TARGET);
  assert.ok(absent.every((quote) => quote.bookmaker === 'Fixture International'));
  const missingTime = event(); delete missingTime.bookmakers[0].updatedAt;
  assert.equal(quoteFreshnessReason(researchQuotesFromEvent(missingTime, TARGET)[0], Date.parse(TARGET)), 'quote_timestamp_missing');
});

function runtimeHarness(providerEvent = event(), options = {}) {
  const commits = [], finishes = [], runs = [];
  const fixture = { match_id: 'fixture', home_team_id: 'h', away_team_id: 'a', home_team_name: 'Home', away_team_name: 'Away',
    date: KICKOFF, competition: 'Serie A', season: '2026/27', home_goals: null, away_goals: null };
  const history = Array.from({ length: 45 }, (_, index) => ({ ...fixture, match_id: `past-${index}`,
    date: new Date(Date.parse(TARGET) - (index + 2) * 86400000).toISOString(), home_goals: index % 3, away_goals: index % 2,
    home_xg: 1.4, away_xg: 1.1 }));
  let claimed = false, fetches = 0;
  const research = { initializePortfolios: async () => [], saveModel: async () => {},
    syncJobs: async () => [], claimDueJobs: async () => claimed ? [] : (claimed = true, [{ id: 'job', matchId: 'fixture', kickoffAt: KICKOFF,
      targetAt: TARGET, leaseToken: 'lease' }]), finishJob: async (...args) => finishes.push(args),
    getChampion: async () => null, getModels: async () => [], listMarkets: async () => [], getLatestBenchmark: async () => null,
    commitBatch: async (...args) => commits.push(args), listBets: async () => [] };
  const db = { research, getUpcomingMatches: async () => [fixture], getMatchById: async () => fixture,
    getMatches: async () => history, updateMatchKickoff: async () => {}, saveSchedulerRun: async (run) => runs.push(run) };
  const runtime = new ResearchRuntime(db, { clock: options.clock ?? (() => new Date(TARGET)),
    odds: { getOdds: async () => { fetches++; return options.getOdds ? options.getOdds() : [providerEvent]; } } });
  return { runtime, commits, finishes, runs, fetches: () => fetches, db, fixture, history };
}

test('only quality-tagged C rebuilds its baseline from quarantined history while A and legacy C remain unchanged', async () => {
  const { CHALLENGER_DATA_QUALITY_POLICY_HASH, filterChallengerHistory } = require('../dist/research/ChallengerDataQuality');
  const { buildForecastInput } = require('../dist/research/ForecastCore');
  const { researchMatchFromRow } = require('../dist/research/ResearchRuntime');
  const run = async (policyHash, targetId) => {
    const h = runtimeHarness();
    h.history[0] = { ...h.history[0], match_id: 'understat_22621', home_goals: 9, away_goals: 0 };
    if (targetId) h.fixture.match_id = targetId;
    const historyBefore = JSON.stringify(h.history);
    const artifact = { family: 'C', version: 'C-quality-fixture', featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
      baselineVersion: baselineManifest().version, candidateKind: 'no_ml', weight: 0, temperature: 1, models: {},
      trainedThrough: '2026-09-01T00:00:00Z', validationThrough: '2026-10-01T00:00:00Z', createdAt: '2026-10-02T00:00:00Z',
      probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2: coherentProbabilityPipelineHash(), probabilityCalibrationMode: 'identity',
      ...(policyHash !== undefined ? { dataQualityPolicyHash: policyHash, dataQualityBaselineClean: true } : {}) };
    h.db.research.getModels = async () => [{ version: artifact.version, artifact }];
    assert.equal((await h.runtime.tick()).completed, 1);
    assert.equal(JSON.stringify(h.history), historyBefore);
    return { h, batch: h.commits[0][0][0] };
  };
  const legacy = await run(), clean = await run(CHALLENGER_DATA_QUALITY_POLICY_HASH);
  assert.deepEqual(clean.batch.inputSnapshot.forecast, legacy.batch.inputSnapshot.forecast);
  assert.deepEqual(clean.batch.decisions.find((row) => row.family === 'A'), legacy.batch.decisions.find((row) => row.family === 'A'));
  const expected = buildForecastInput(filterChallengerHistory(clean.h.history.map(researchMatchFromRow)),
    researchMatchFromRow(clean.h.fixture), TARGET);
  assert.deepEqual(clean.batch.inputSnapshot.challengerForecast.baselineMatrix, expected.baselineMatrix);
  assert.equal(clean.batch.inputSnapshot.challengerForecast.trainingCount, 44);
  assert.equal(clean.batch.inputSnapshot.forecast.trainingCount, 45);
  assert.equal(clean.batch.inputSnapshot.challengerForecast.dataQualityBaselineClean, true);
  assert.equal(clean.batch.inputSnapshot.challengerDataQuality.evidence.history.excludedMatchIds[0], 'understat_22621');
  assert.equal(clean.batch.decisions.find((row) => row.family === 'C').validated, true);
  assert.equal(legacy.batch.inputSnapshot.challengerForecast, undefined);
  const wrong = await run('0'.repeat(64));
  assert.equal(wrong.batch.decisions.find((row) => row.family === 'C').reason, 'challenger_data_quality_policy_mismatch');
  assert.deepEqual(wrong.batch.decisions.find((row) => row.family === 'A'), legacy.batch.decisions.find((row) => row.family === 'A'));
  const quarantined = await run(CHALLENGER_DATA_QUALITY_POLICY_HASH, 'understat_22621');
  assert.equal(quarantined.batch.decisions.find((row) => row.family === 'C').reason, 'challenger_target_data_quality_quarantined');
});

test('the production T-15 feed uses the shared persistent manager and preserves cached transport timestamps', async (t) => {
  const previousKey = process.env.ODDS_API_T15_KEY;
  process.env.ODDS_API_T15_KEY = 'unit-test-only';
  t.after(() => { if (previousKey === undefined) delete process.env.ODDS_API_T15_KEY; else process.env.ODDS_API_T15_KEY = previousKey; });
  const h = runtimeHarness(), requests = [];
  const originalCapturedAt = '2026-10-27T19:27:00.000Z';
  h.db.oddsRequests = { execute: async (request) => {
    requests.push(request);
    return { cacheHit: true, fetchedAt: originalCapturedAt, headers: {}, data: [{ id: 'provider-id',
      home_team: 'Home', away_team: 'Away', commence_time: KICKOFF,
      bookmakers: [{ key: 'fixture', title: 'Fixture Book', last_update: originalCapturedAt,
        markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: 1.9 }, { name: 'Draw', price: 3.5 }, { name: 'Away', price: 4 }] }] }] }] };
  } };
  const runtime = new ResearchRuntime(h.db, { clock: () => new Date(TARGET) });
  assert.equal((await runtime.tick()).completed, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation, 't15');
  assert.equal(requests[0].priority, 'essential');
  assert.equal(requests[0].cacheMaxAgeMs, 300000);
  assert.equal(requests[0].expectedCredits, 3);
  assert.deepEqual(requests[0].markets, ['h2h', 'spreads', 'totals']);
  assert.ok(h.commits[0][0][0].inputSnapshot.quotes.every((quote) => quote.capturedAt === originalCapturedAt));
});

test('runtime persists safe budget denials instead of a generic provider failure or retroactive bet', async () => {
  const h = runtimeHarness(event(), { getOdds: async () => {
    throw Object.assign(new Error('authenticated URL must not be recorded'), { code: 'odds_credit_budget_exhausted' });
  } });
  assert.equal((await h.runtime.tick()).skipped, 1);
  assert.equal(h.finishes[0][2].reason, 'odds_credit_budget_exhausted');
  assert.equal(h.runs.find((run) => run.schedulerName === 'research_provider').error, 'odds_credit_budget_exhausted');
  assert.equal(h.commits.length, 0);
  assert.doesNotMatch(JSON.stringify(h.runs), /authenticated URL/);
});

test('actual runtime feeds A and C one immutable snapshot and safely abstains without a trained C or validation', async () => {
  const h = runtimeHarness();
  const result = await h.runtime.tick();
  assert.equal(result.completed, 1);
  assert.equal(h.fetches(), 1);
  const providerRun = h.runs.find((run) => run.schedulerName === 'research_provider');
  assert.equal(providerRun.success, true);
  assert.equal(providerRun.summary.quota, null);
  assert.equal(h.commits.length, 1);
  const batch = h.commits[0][0];
  assert.equal(batch.length, 1);
  const input = batch[0].inputSnapshot;
  assert.equal(input.observedAt, TARGET);
  assert.equal(input.forecast.forecastAt, TARGET);
  assert.ok(input.forecast.maxTrainingAvailableAt < TARGET);
  assert.ok(Object.isFrozen(input));
  assert.deepEqual(batch[0].decisions.map((decision) => [decision.family, decision.action]), [['A', 'ABSTAIN'], ['C', 'ABSTAIN']]);
  assert.match(batch[0].decisions[0].reason, /coherent_probability_protocol_required/);
  const health = h.runs.find((run) => run.schedulerName === 'research_model_check');
  assert.equal(health.success, false);
  assert.equal(health.summary.checks.calibrationCompatible, false);
  assert.equal(health.summary.matchId, input.forecast.matchId);
  assert.equal(typeof health.summary.snapshotHash, 'string');
  assert.match(batch[0].decisions[1].reason, /hybrid_model_unavailable/);
  assert.equal((await h.runtime.tick()).claimed, 0);
});

test('a transient provider failure is not cached across the next T-15 retry and is recorded without secrets', async () => {
  let now = Date.parse(TARGET), requests = 0;
  const h = runtimeHarness(event(), { clock: () => new Date(now), getOdds: async () => {
    if (++requests === 1) throw new Error('https://provider.example?apiKey=do-not-persist-this-value');
    return [event()];
  } });
  h.db.research.claimDueJobs = async () => [{ id: 'job', matchId: 'fixture', kickoffAt: KICKOFF,
    targetAt: TARGET, leaseToken: 'lease' }];
  assert.equal((await h.runtime.tick()).retried, 1);
  assert.equal(h.commits.length, 0);
  now += 15000;
  assert.equal((await h.runtime.tick()).completed, 1);
  assert.equal(h.fetches(), 2);
  const providerRuns = h.runs.filter((run) => run.schedulerName === 'research_provider');
  assert.deepEqual(providerRuns.map((run) => run.success), [false, true]);
  assert.equal(providerRuns[0].error, 'research_odds_provider_unavailable');
  assert.doesNotMatch(JSON.stringify(h.runs), /do-not-persist|apiKey|provider\.example/);
});

test('runtime reprograms an official kickoff change before any decision commit', async () => {
  const rescheduled = '2026-10-27T20:00:00.000Z';
  const h = runtimeHarness(event({ commenceTime: rescheduled })); const updates = [];
  h.db.updateMatchKickoff = async (...args) => updates.push(args);
  const summary = await h.runtime.tick();
  assert.equal(summary.retried, 1);
  assert.equal(h.commits.length, 0);
  assert.deepEqual(updates, [['fixture', rescheduled]]);
});

test('runtime immediately follows a kickoff changed by nightly without an unnecessary odds request', async () => {
  const h = runtimeHarness();
  const updates = [];
  h.fixture.date = '2026-10-27T20:00:00.000Z';
  h.db.research.syncJobs = async (jobs) => { updates.push(jobs); };
  const summary = await h.runtime.tick();
  assert.equal(summary.retried, 1);
  assert.equal(h.commits.length, 0);
  assert.equal(h.fetches(), 0);
  assert.equal(updates.at(-1)[0].kickoffAt, h.fixture.date);
});

test('a real persistent reschedule revokes its old lease without an error and an earlier elapsed window remains missed', async (t) => {
  const path = join(tmpdir(), `research-runtime-reschedule-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  t.after(() => { client.close(); try { rmSync(path, { force: true }); } catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; } });
  await client.executeMultiple(readFileSync(join(__dirname, '../migrations/015_research_platform.sql'), 'utf8'));
  const store = new ResearchStore(client, async () => {}, { now: () => new Date(TARGET) });
  for (const [id, kickoffAt, expected] of [['later', '2026-10-27T20:00:00.000Z', 'PENDING'],
    ['earlier', '2026-10-27T19:25:00.000Z', 'MISSED']]) {
    const fixture = { match_id: id, home_team_id: 'h', away_team_id: 'a', home_team_name: 'Home', away_team_name: 'Away',
      date: KICKOFF, competition: 'Serie A', home_goals: null, away_goals: null };
    const runs = [];
    const runtime = new ResearchRuntime({ research: store, getUpcomingMatches: async () => [fixture],
      getMatchById: async () => fixture, getMatches: async () => [],
      updateMatchKickoff: async (_matchId, date) => { fixture.date = date; }, saveSchedulerRun: async (run) => runs.push(run) },
    { clock: () => new Date(TARGET), odds: { getOdds: async () => [event({ commenceTime: kickoffAt })] } });
    const result = await runtime.tick();
    assert.equal(result.errors, 0);
    const job = (await store.listJobs()).find((entry) => entry.matchId === id);
    assert.equal(job.kickoffAt, kickoffAt);
    assert.equal(job.status, expected);
    assert.equal((await store.listBets()).length, 0);
    assert.ok(!runs.some((run) => run.schedulerName === 'research_t15' && run.success === false));
  }
});

test('runtime abstains when saved calibrators belong to a different probability pipeline', async () => {
  const h = runtimeHarness();
  const tree = { oblivious_trees: [{ leaf_values: [.1] }], scale_and_bias: [1, [0]] };
  const profile = { protocol: 'existing-isotonic-v1', calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    nObservations: 1000, byFamily: {}, learnedBlendWeights: {}, matches: 500, fittedThrough: '2026-10-01T00:00:00Z' };
  h.db.research.getModels = async () => [{ version: 'C-test', artifact: { family: 'C', version: 'C-test',
    featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION, candidateKind: 'intensity_correction', weight: .5, temperature: 1,
    trainedThrough: '2026-09-01T00:00:00Z', validationThrough: '2026-10-01T00:00:00Z', createdAt: '2026-10-02T00:00:00Z',
    models: { home: tree, away: tree }, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2: 'old-pipeline', calibrationProfilesV2: { A: profile, C: profile } } }];
  const result = await h.runtime.tick();
  assert.equal(result.completed, 1);
  const decisions = h.commits[0][0][0].decisions;
  assert.ok(decisions.every((decision) => decision.action === 'ABSTAIN' && decision.reason === 'calibration_pipeline_version_mismatch'));
});

test('diagnostic-only models never become an operational candidate or an A calibration source', async () => {
  const h = runtimeHarness();
  const tree = { oblivious_trees: [{ leaf_values: [.1] }], scale_and_bias: [1, [0]] };
  h.db.research.getModels = async () => [{ version: 'C-diagnostic', artifact: { family: 'C', version: 'C-diagnostic',
    featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION, baselineVersion: baselineManifest().version,
    candidateKind: 'intensity_correction', weight: .5, temperature: 1, diagnosticOnly: true,
    trainedThrough: '2026-09-01T00:00:00Z', validationThrough: '2026-10-01T00:00:00Z', createdAt: '2026-10-02T00:00:00Z',
    models: { home: tree, away: tree }, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
    pipelineHashV2: coherentProbabilityPipelineHash(), probabilityCalibrationMode: 'identity' } }];
  assert.equal((await h.runtime.tick()).completed, 1);
  const decisions = h.commits[0][0][0].decisions;
  assert.ok(decisions.every((decision) => decision.action === 'ABSTAIN' && decision.reason === 'diagnostic_model_not_operational'));
  assert.ok(!h.runs.some((run) => run.schedulerName === 'research_model_check' && run.success));
});

test('A cannot borrow a future C calibration configuration even in identity mode', async () => {
  const h = runtimeHarness();
  const tree = { oblivious_trees: [{ leaf_values: [.1] }], scale_and_bias: [1, [0]] };
  h.db.research.getModels = async () => [{ version: 'C-future', artifact: { family: 'C', version: 'C-future',
    featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION, baselineVersion: baselineManifest().version,
    candidateKind: 'intensity_correction', weight: .5, temperature: 1,
    trainedThrough: '2026-09-01T00:00:00Z', validationThrough: '2026-11-01T00:00:00Z', createdAt: '2026-11-02T00:00:00Z',
    models: { home: tree, away: tree }, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
    pipelineHashV2: coherentProbabilityPipelineHash(), probabilityCalibrationMode: 'identity' } }];
  assert.equal((await h.runtime.tick()).completed, 1);
  const decisions = h.commits[0][0][0].decisions;
  assert.equal(decisions[0].action, 'ABSTAIN');
  assert.equal(decisions[0].reason, 'calibration_configuration_not_available_at_forecast');
  assert.equal(decisions[1].action, 'ABSTAIN');
  assert.ok(!h.runs.some((run) => run.schedulerName === 'research_model_check' && run.success));
});

test('A market approval cannot survive a changed calibration configuration under the same raw baseline version', async () => {
  const tree = { oblivious_trees: [{ leaf_values: [.1] }], scale_and_bias: [1, [0]] };
  const baselineVersion = baselineManifest().version;
  const pipelineHashV2 = coherentProbabilityPipelineHash();
  const configurations = Object.fromEntries(['A', 'C'].map((family) => [family,
    buildProbabilityConfiguration({ family, baselineVersion, pipelineHashV2, mode: 'identity' })]));
  const samples = Array.from({ length: 500 }, (_, index) => ({ matchId: `configuration-fixture-${index}`,
    market: '1x2', probability: .1 + (index % 5) * .2, odds: 10, expectedValue: 0,
    returnMultiplier: 10, outcomeAvailableAt: '2026-09-01T00:00:00Z', phase: 'validation' }));
  const run = async (mode, includeApproval = true) => {
    const feed = event();
    feed.bookmakers[0].markets[0].outcomes.forEach((outcome) => { outcome.price = 10; });
    const h = runtimeHarness(feed);
    h.db.research.getModels = async () => [{ version: 'C-configuration-fixture', artifact: {
      family: 'C', version: 'C-configuration-fixture', featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
      baselineVersion, candidateKind: 'intensity_correction', weight: .5, temperature: 1,
      trainedThrough: '2026-09-01T00:00:00Z', validationThrough: '2026-10-01T00:00:00Z', createdAt: '2026-10-02T00:00:00Z',
      models: { home: tree, away: tree }, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2,
      probabilityCalibrationMode: mode, probabilityTemperature: mode === 'temperature' ? .9 : undefined,
      calibrationSamples: { A: samples, C: samples },
    } }];
    h.db.research.listMarkets = async ({ family }) => [{ family, market: '1x2', state: 'SHADOW', evidence: includeApproval
      ? { approvedProbabilityConfigurationHash: configurations[family].hash } : {} }];
    assert.equal((await h.runtime.tick()).completed, 1);
    return h.commits[0][0][0].decisions;
  };
  // These deliberately favorable synthetic prices/payouts exercise admission,
  // not predictive quality or production market eligibility.
  const approved = await run('identity');
  assert.ok(approved.every((decision) => decision.action === 'BET'));
  const changed = await run('temperature');
  assert.equal(changed[0].modelVersion, approved[0].modelVersion);
  assert.deepEqual(changed[0].probabilityStages.raw, approved[0].probabilityStages.raw);
  assert.notEqual(changed[0].probabilityConfigurationHash, approved[0].probabilityConfigurationHash);
  assert.ok(changed.every((decision) => decision.action === 'ABSTAIN' && decision.reason === 'probability_configuration_not_validated'));
  assert.deepEqual(approved[0].probabilityConfiguration, configurations.A.descriptor);
  assert.equal(approved[0].probabilityConfigurationHash, configurations.A.hash);
  const missing = await run('identity', false);
  assert.ok(missing.every((decision) => decision.action === 'ABSTAIN' && decision.reason === 'probability_configuration_not_validated'));
});

test('challenger compatibility probes share the snapshot without changing champion decisions or fetching extra prices', async () => {
  const h = runtimeHarness();
  const tree = { oblivious_trees: [{ leaf_values: [.1] }], scale_and_bias: [1, [0]] };
  const profile = fitCoherentCalibration([], '2026-10-01T00:00:00Z');
  const artifact = { family: 'C', featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION, baselineVersion: baselineManifest().version,
    candidateKind: 'intensity_correction', weight: .5, temperature: 1, trainedThrough: '2026-09-01T00:00:00Z',
    validationThrough: '2026-10-01T00:00:00Z', createdAt: '2026-10-02T00:00:00Z', models: { home: tree, away: tree },
    probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2: coherentProbabilityPipelineHash(),
    calibrationProfilesV2: { A: profile, C: profile } };
  const champion = { version: 'C-champion', artifact: { ...artifact, version: 'C-champion' } };
  const candidate = { version: 'C-candidate', artifact: { ...artifact, version: 'C-candidate' } };
  h.db.research.getChampion = async () => champion;
  h.db.research.getModels = async () => [champion, candidate];
  const result = await h.runtime.tick();
  assert.equal(result.completed, 1);
  assert.equal(h.fetches(), 1);
  assert.deepEqual(h.commits[0][0][0].decisions.map((decision) => decision.family), ['A', 'C']);
  assert.equal(h.commits[0][0][0].decisions[1].modelVersion, 'C-champion');
  const probe = h.runs.find((run) => run.summary?.role === 'CHALLENGER');
  assert.equal(probe.summary.modelVersion, 'C-candidate'); assert.equal(probe.success, true);
  assert.ok(Object.values(probe.summary.checks).every(Boolean));
  assert.equal(probe.startedAt, h.commits[0][0][0].inputSnapshot.observedAt);

  const failed = runtimeHarness();
  failed.db.research.getChampion = async () => champion;
  failed.db.research.getModels = async () => [champion, { version: 'C-broken', artifact: {} }];
  assert.equal((await failed.runtime.tick()).completed, 1);
  assert.equal(failed.commits[0][0][0].decisions[1].modelVersion, 'C-champion');
  assert.equal(failed.runs.find((run) => run.summary?.role === 'CHALLENGER').success, false);
});

test('settlement bridge uses saved market/line and source evidence and never creates a bet', async () => {
  const settlements = [];
  const quote = researchQuotesFromEvent(event(), TARGET)[0];
  const db = { research: { listBets: async () => [{ id: 'bet', matchId: 'fixture', snapshot: { quote } }],
    settleBet: async (...args) => { settlements.push(args); return { settled: true }; } },
  getMatchById: async () => ({ home_goals: 2, away_goals: 0, source: 'understat', date: KICKOFF }) };
  assert.deepEqual(await settleResearchBets(db), { checked: 1, settled: 1, unresolved: 0 });
  assert.equal(settlements[0][1], 1.9);
  assert.equal(settlements[0][2].source, 'understat');
});
