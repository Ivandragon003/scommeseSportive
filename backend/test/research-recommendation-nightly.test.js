const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@libsql/client');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');
const { runRecommendationNightly } = require('../dist/research/ResearchRecommendationNightly');
const { RECOMMENDATION_MODEL_C } = require('../dist/research/ResearchRecommendationPolicy');
const { runResearchNightly, loadNightlyPolicy } = require('../dist/research/ResearchNightly');
const { settleResearchBets } = require('../dist/research/ResearchRuntime');
const { baselineManifest } = require('../dist/research/ForecastCore');
const { coherentProbabilityPipelineHash } = require('../dist/research/CoherentProbabilityPipeline');
const { runNightly, recommendationEnabled } = require('../scripts/research-nightly');

const START = '2026-10-30T12:30:00.000Z', KICKOFF = '2026-10-30T18:00:00.000Z';
const policy = () => loadNightlyPolicy({ RESEARCH_NIGHTLY_ENABLED: 'true', RESEARCH_NIGHTLY_MINUTE: '7' });
async function fixture(t, options = {}) {
  const path = join(tmpdir(), `recommendation-nightly-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  t.after(() => { client.close(); for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(path + suffix, { force: true }); }
    catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
  } });
  for (const migration of ['015_research_platform.sql', '018_smart_odds.sql', '020_research_nightly.sql',
    '021_research_prospective.sql', '023_research_recommendation_execution.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
  }
  await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,home_goals INTEGER,away_goals INTEGER)');
  const clock = () => new Date(START), research = new ResearchStore(client, async () => {}, { now: clock });
  const recommendations = new ResearchRecommendationStore(client, async () => {}, { research, now: clock });
  const baseline = baselineManifest();
  // Isolated admission fixtures carry the policy's identity; they do not load or evaluate the real model.
  for (const [family, version, artifact] of [['A', baseline.version, baseline], ['C', RECOMMENDATION_MODEL_C, { family: 'C', fixtureOnly: true }],
    ['A', 'A-app-fixture', { family: 'A', fixtureOnly: true }]]) {
    await research.saveModel({ family, version, artifact });
    await research.setMarketState({ family, modelVersion: version, market: '1x2', state: 'EXPERIMENTAL' });
  }
  const matches = Array.from({ length: options.matches ?? 2 }, (_, index) => ({ match_id: `fixture-${index}`, date: KICKOFF,
    competition: 'Serie A', season: '2026/27', home_goals: null, away_goals: null }));
  for (const match of matches) await client.execute({ sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL)', args: [match.match_id, match.date] });
  const runs = [], counters = { diagnosticPreparations: 0, executionPreparations: 0, claims: 0, renewals: 0, cohorts: 0 };
  const originalClaim = recommendations.claimBatch.bind(recommendations);
  recommendations.claimBatch = async (...args) => { counters.claims++; return originalClaim(...args); };
  const originalRenew = recommendations.renewLeases.bind(recommendations);
  recommendations.renewLeases = async (...args) => { counters.renewals++; return options.leaseLost ? false : originalRenew(...args); };
  const quoteTime = options.staleQuote ? new Date(Date.parse(START) - 300001).toISOString() : START;
  const quote = () => ({ market: '1x2', selection: 'homeWin', side: 'home', odds: 2, source: 'odds_api',
    bookmaker: 'Isolated fixture bookmaker', priceType: 'prematch', capturedAt: quoteTime, updatedAt: quoteTime });
  const db = { research, recommendations, getUpcomingMatches: async ({ nowIso, untilIso }) => matches.filter((row) =>
    Date.parse(row.date) > Date.parse(nowIso) && Date.parse(row.date) <= Date.parse(untilIso)),
  getMatches: async () => matches, getMatchById: async (id) => matches.find((row) => row.match_id === id),
  saveSchedulerRun: async (run) => { runs.push(run); return runs.length; } };
  const diagnosticPreparer = { getQuotaStatus: () => ({ remaining: 190 }), prepareNightly: async (job) => {
    counters.diagnosticPreparations++;
    if (options.diagnosticThrows) throw new Error('Private diagnostic preparation failure');
    const shared = quote();
    return { job, kickoffAt: job.kickoffAt, status: 'upcoming', quotes: [shared], prospectiveObservations: [],
      inputSnapshot: { observedAt: START, forecast: {}, quotes: [shared] }, decisions: ['A', 'C'].map((family) => ({
        family, modelVersion: family === 'A' ? baseline.version : RECOMMENDATION_MODEL_C, validated: family !== 'C' || !options.invalidC,
        market: '1x2', selection: 'homeWin', quoteIndex: 0, quote: shared,
        action: family === 'C' && options.invalidC ? 'ABSTAIN' : 'BET',
        ...(family === 'C' && options.invalidC ? { reason: 'research_forecast_unavailable' } : {}), probability: .6,
        ev: .2, prudentialEv: .1, prudentialSamplesAvailable: 0,
      })) };
  } };
  const runtime = { beginCohort: () => { counters.cohorts++; }, getQuotaStatus: () => ({ remaining: 187 }), prepare: async (job) => {
    counters.executionPreparations++;
    if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
    if (options.prepareError) throw Object.assign(new Error('private URL must never be logged'), { code: 'odds_transport_failed' });
    const shared = quote();
    return { jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
      inputSnapshot: { observedAt: START, quotes: [shared], match: { matchId: job.matchId }, runId: job.runId, policyHash: job.policyHash },
      decisions: ['A', 'C'].map((family) => {
        const configuration = { fixtureOnly: true, family };
        const abstained = options.noRecommendation || family === 'C' && options.invalidC;
        return { family, modelVersion: family === 'A' ? 'A-app-fixture' : RECOMMENDATION_MODEL_C, originDecisionId: job.originDecisionIds[family],
          action: abstained ? 'ABSTAIN' : 'BET', ...(abstained ? { reason: options.noRecommendation ? 'no_app_recommendation' : 'research_forecast_unavailable' } : {}),
          recommended: !abstained, validated: family !== 'C' || !options.invalidC, confidence: 'MEDIUM', market: '1x2', selection: 'homeWin',
          quote: shared, probability: .6, ev: .2, suggestedStakePercent: 1.5, prudentialSamplesAvailable: 0,
          probabilityConfiguration: configuration, probabilityConfigurationHash: researchHash(configuration) };
      }) };
  } };
  return { client, db, research, recommendations, counters, runs, matches, clock, diagnosticPreparer, runtime };
}
const execute = (f, extra = {}) => runRecommendationNightly(f.db, { policy: policy(), clock: f.clock,
  runId: 'github-actions:fixture', diagnosticPreparer: f.diagnosticPreparer, runtime: f.runtime, ...extra });

test('strict recommendation flag defaults off and disabled CLI never reads a database, including with the new flag on', async () => {
  assert.equal(recommendationEnabled({}), false);
  assert.equal(recommendationEnabled({ RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED: 'false' }), false);
  assert.equal(recommendationEnabled({ RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED: 'true' }), true);
  for (const value of ['', 'yes', 'TRUE', '1', true, 1]) {
    assert.throws(() => recommendationEnabled({ RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED: value }), /Invalid/);
  }
  const result = await runNightly({ policy: loadNightlyPolicy({}), env: { RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED: 'true' },
    log: () => {}, get db() { throw new Error('Disabled means no DB access'); } });
  assert.deepEqual(result, { mode: 'NIGHTLY', enabled: false, reason: 'nightly_disabled' });
});

test('diagnostic origins cannot create v1 stakes even when their original synthetic decisions requested BET', async (t) => {
  const f = await fixture(t);
  const result = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, runId: 'diagnostic-only',
    preparer: f.diagnosticPreparer, diagnosticOnly: true });
  assert.equal(result.errors, 0); assert.equal(result.registeredBets, 0); assert.equal(result.diagnosticOnly, true);
  assert.equal((await f.research.listBets()).length, 0);
  assert.equal((await f.research.listLedger()).filter((row) => row.event === 'STAKE').length, 0);
  const originals = await f.research.listDecisions();
  assert.equal(originals.length, 4);
  assert.ok(originals.every((decision) => decision.action === 'ABSTAIN' && decision.reason === 'diagnostic_only'
    && decision.snapshot.stakeCents === 0 && decision.snapshot.diagnosticOriginalDecision.action === 'BET'));
  assert.deepEqual(f.runs.map((run) => run.schedulerName), ['research_nightly_diagnostic']);
});

test('CLI selects versioned execution only with the new flag and uses diagnostic-only origins when off', async (t) => {
  for (const enabled of [false, true]) {
    const f = await fixture(t, { matches: 1 }), output = [];
    const result = await runNightly({ db: f.db, policy: policy(), clock: f.clock, runId: 'cli-fixture',
      env: { RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED: String(enabled) }, preparer: f.diagnosticPreparer,
      diagnosticPreparer: f.diagnosticPreparer, runtime: f.runtime, log: (row) => output.push(row) });
    assert.equal(result.errors, 0); assert.equal(result.registeredBets, enabled ? 2 : 0);
    assert.equal(f.counters.executionPreparations, enabled ? 1 : 0);
    assert.equal(output.length, 1); assert.equal(output[0], result);
    if (!enabled) {
      assert.equal(result.diagnosticOnly, true);
      assert.deepEqual(f.runs.map((run) => run.schedulerName), ['research_nightly_diagnostic']);
      assert.equal((await f.research.listLedger()).filter((row) => row.event === 'STAKE').length, 0);
    }
  }
});

test('turning off or omitting the execution flag cannot revive eligible v1 stakes during rollback', async (t) => {
  const eligibleV1 = (f) => ({ ...f.diagnosticPreparer, prepareNightly: async (job) => {
    const result = await f.diagnosticPreparer.prepareNightly(job);
    result.decisions = result.decisions.map((decision) => {
      const configuration = { version: 'probability-configuration-v1', family: decision.family,
        baselineVersion: baselineManifest().version, probabilityProtocol: 'joint-goal-coherent-v2',
        pipelineHashV2: coherentProbabilityPipelineHash(), calibratorHash: '2'.repeat(64), mode: 'identity', temperature: 1 };
      return { ...decision, probabilityConfiguration: configuration, probabilityConfigurationHash: researchHash(configuration),
        calibrationAvailableAt: START, calibrationPipelineHash: configuration.pipelineHashV2, prudentialSamplesAvailable: 500 };
    });
    return result;
  } });
  // Positive control: the prepared synthetic evidence passes the unchanged historical API.
  const control = await fixture(t, { matches: 1 });
  const admitted = await runResearchNightly(control.db, { policy: policy(), clock: control.clock, runId: 'v1-control',
    preparer: eligibleV1(control) });
  assert.equal(admitted.registeredBets, 2);
  assert.equal((await control.research.listLedger()).filter((row) => row.event === 'STAKE').length, 2);
  for (const env of [{}, { RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED: 'false' }]) {
    const f = await fixture(t, { matches: 1 });
    const result = await runNightly({ db: f.db, policy: policy(), clock: f.clock, runId: 'cli-rollback', env,
      diagnosticOnly: false, preparer: eligibleV1(f), log: () => {} });
    assert.equal(result.errors, 0); assert.equal(result.diagnosticOnly, true); assert.equal(result.registeredBets, 0);
    assert.equal((await f.research.listBets()).length, 0);
    assert.equal((await f.research.listLedger()).filter((row) => row.event === 'STAKE').length, 0);
    assert.deepEqual(f.runs.map((run) => run.schedulerName), ['research_nightly_diagnostic']);
    assert.ok((await f.research.listDecisions()).every((decision) => decision.reason === 'diagnostic_only'));
  }
});

test('zero independent samples neither veto a valid virtual recommendation nor force a bet when recommendation is absent', async (t) => {
  for (const noRecommendation of [false, true]) {
    const f = await fixture(t, { noRecommendation });
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM research_prospective_results')).rows[0].n), 0);
    const result = await execute(f);
    assert.equal(result.errors, 0); assert.equal(result.analyzedMatches, 2); assert.equal(result.decisionCount, 4);
    assert.equal(result.registeredBets, noRecommendation ? 0 : 4);
    assert.match(result.policyHash, /^[a-f0-9]{64}$/);
    const bets = await f.research.listBets();
    assert.ok(bets.every((bet) => bet.executionDecisionId));
    if (!noRecommendation) assert.deepEqual(bets.map((bet) => bet.stakeCents).sort(), [1000, 1000, 1500, 1500]);
    assert.deepEqual(f.runs.map((run) => run.schedulerName), ['research_nightly_diagnostic', 'research_nightly']);
    assert.equal(f.runs[1].summary.registeredBets, bets.length);
    assert.equal((await f.research.getNightlyRunMetrics('github-actions:fixture')).registeredBets, 0);
  }
});

test('a second run with the same policy skips preparation before another feed or model boundary and preserves immutable origins', async (t) => {
  const f = await fixture(t);
  await execute(f);
  const originals = JSON.stringify(await f.research.listDecisions()), before = { ...f.counters };
  const result = await execute(f, { runId: 'github-actions:recovery' });
  assert.equal(result.errors, 0); assert.equal(result.registeredBets, 0); assert.equal(result.decisionCount, 0);
  assert.equal(f.counters.diagnosticPreparations, before.diagnosticPreparations);
  assert.equal(f.counters.executionPreparations, before.executionPreparations);
  assert.equal(f.counters.cohorts, before.cohorts);
  assert.equal(JSON.stringify(await f.research.listDecisions()), originals);
  assert.equal((await f.research.listBets()).length, 4);
});

test('execution still requires real fresh prices and settles new virtual bets with the existing idempotent accounting', async (t) => {
  const stale = await fixture(t, { matches: 1, staleQuote: true });
  const skipped = await execute(stale);
  assert.equal(skipped.errors, 0); assert.equal(skipped.registeredBets, 0);
  assert.equal(skipped.reasonCounts.real_fresh_quote_required, 2);
  const f = await fixture(t);
  await execute(f);
  f.matches.forEach((row) => { row.home_goals = 1; row.away_goals = 0; row.source = 'understat'; });
  assert.equal((await settleResearchBets(f.db)).settled, 4);
  assert.equal((await settleResearchBets(f.db)).settled, 0);
  assert.deepEqual((await f.research.listPortfolios()).map((row) => [row.id, row.equityCents, row.committedCents]),
    [['shadow_A', 103000, 0], ['shadow_C', 102000, 0]]);
});

test('data-gate failure and real diagnostic preparation errors prevent every new execution claim and stake', async (t) => {
  for (const diagnosticThrows of [false, true]) {
    const f = await fixture(t, { diagnosticThrows });
    const result = await execute(f, diagnosticThrows ? {} : { dataGatesPassed: false });
    assert.ok(result.errors > 0); assert.equal(f.counters.claims, 0); assert.equal(f.counters.executionPreparations, 0);
    assert.equal((await f.research.listBets()).length, 0);
    assert.equal(f.runs.at(-1).schedulerName, 'research_nightly'); assert.equal(f.runs.at(-1).success, false);
  }
});

test('an authentic diagnostic C abstention does not veto an independently valid App A recommendation', async (t) => {
  const f = await fixture(t, { invalidC: true });
  const result = await execute(f);
  assert.equal(result.errors, 0); assert.equal(result.registeredBets, 2);
  assert.ok((await f.research.listBets()).every((bet) => bet.family === 'A'));
  const originals = await f.research.listDecisions({ family: 'C' });
  assert.ok(originals.every((decision) => decision.action === 'ABSTAIN' && decision.reason === 'diagnostic_only'
    && decision.snapshot.diagnosticOriginalDecision.reason === 'research_forecast_unavailable'));
  const executions = await f.recommendations.listDecisions();
  assert.ok(executions.filter((decision) => decision.family === 'C').every((decision) => decision.action === 'ABSTAIN'));
});

test('execution preparation errors and lost leases release owned jobs and cannot leave a successful financial summary', async (t) => {
  for (const options of [{ prepareError: true }, { leaseLost: true, delay: 300 }]) {
    const f = await fixture(t, { matches: 1, ...options });
    const result = await execute(f, { leaseMs: 1000 });
    assert.ok(result.errors > 0); assert.equal(result.registeredBets, 0);
    assert.ok((await f.recommendations.listJobs()).every((job) => job.status !== 'CLAIMED'));
    if (options.leaseLost) assert.ok(f.counters.renewals >= 1);
    assert.equal(f.runs.at(-1).success, false);
    assert.doesNotMatch(JSON.stringify(f.runs), /private URL/);
  }
});
