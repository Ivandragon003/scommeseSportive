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
const { buildRecoveryPlan } = require('../dist/research/ResearchRecommendationRecovery');
const { VIRTUAL_RECOMMENDATION_POLICY } = require('../dist/research/ResearchRecommendationPolicy');
const { nextNightlyBoundary } = require('../dist/research/ResearchNightly');

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
    if (options.diagnosticThrows) throw options.diagnosticError ?? new Error('Private diagnostic preparation failure');
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
        const abstained = options.noRecommendation || family === 'C' && (options.invalidC || options.diagnosticThrows);
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

async function historicalRecoveryFixture(t) {
  const f = await fixture(t, { matches: 4 });
  await runResearchNightly(f.db, { policy: policy(), clock: f.clock, runId: 'original-diagnostics',
    preparer: f.diagnosticPreparer, diagnosticOnly: true });
  const parent = await f.recommendations.registerPolicy(VIRTUAL_RECOMMENDATION_POLICY);
  const end = nextNightlyBoundary(f.clock(), 3, 7).toISOString();
  const claimed = await f.recommendations.claimBatch({ policyHash: parent.hash, runId: 'original-execution',
    windowStartAt: START, windowEndAt: end, fixtures: f.matches.map((row) => ({ matchId: row.match_id, kickoffAt: row.date })) });
  const inputs = [];
  for (const [index, job] of claimed.jobs.entries()) {
    const item = await f.runtime.prepare(job);
    item.inputSnapshot.match.kickoffAt = job.kickoffAt;
    item.inputSnapshot.metadata = { originInputId: item.originInputId, policy: VIRTUAL_RECOMMENDATION_POLICY };
    if (index !== 2) item.decisions = item.decisions.map((decision) => ({ ...decision, action: 'ABSTAIN',
      reason: index < 2 ? 'odds_credit_budget_exhausted' : 'app_no_recommendation', recommended: false, validated: false }));
    inputs.push(item);
  }
  // Reproduce immutable rows written before the technical-pair retry fix.
  await f.recommendations.commitBatch(inputs, f.clock());
  const raw = async (sql, args = []) => (await f.client.execute({ sql, args })).rows;
  const job = (await raw('SELECT * FROM research_execution_jobs WHERE match_id=? AND policy_hash=?', ['fixture-0', parent.hash]))[0];
  const input = (await raw('SELECT * FROM research_execution_inputs WHERE job_id=?', [job.id]))[0];
  const originInput = (await raw('SELECT * FROM research_inputs WHERE id=?', [input.origin_input_id]))[0];
  const origins = await raw('SELECT * FROM research_decisions WHERE input_id=? ORDER BY family', [originInput.id]);
  const decisions = await raw('SELECT * FROM research_execution_decisions WHERE input_id=? ORDER BY family', [input.id]);
  const record = { match: { matchId: 'fixture-0', kickoffAt: KICKOFF, homeGoals: null, awayGoals: null },
    policy: { hash: parent.hash, descriptor: VIRTUAL_RECOMMENDATION_POLICY },
    job: { id: job.id, matchId: job.match_id, policyHash: job.policy_hash, runId: job.run_id, status: job.status,
      kickoffAt: job.kickoff_at, windowStartAt: job.window_start_at, windowEndAt: job.window_end_at, claimedAt: job.claimed_at },
    input: { id: input.id, jobId: input.job_id, originInputId: input.origin_input_id, inputHash: input.input_hash,
      decisionsHash: input.decisions_hash, capturedAt: input.captured_at, kickoffAt: input.kickoff_at, snapshot: JSON.parse(input.snapshot_json) },
    originJob: { id: originInput.job_id, matchId: 'fixture-0' }, originInput: { id: originInput.id, jobId: originInput.job_id },
    originDecisions: origins.map((row) => ({ id: row.id, inputId: row.input_id, family: row.family, portfolioId: row.portfolio_id })),
    decisions: decisions.map((row) => ({ id: row.id, inputId: row.input_id, family: row.family,
      portfolioId: row.portfolio_id, originDecisionId: row.origin_decision_id, modelVersion: row.model_version,
      action: row.action, reason: row.reason, snapshot: JSON.parse(row.snapshot_json) })), existingBets: [], existingRecoveries: [] };
  assert.equal(Number((await raw('SELECT COUNT(*) AS n FROM research_execution_jobs WHERE match_id=? AND policy_hash<>?',
    ['fixture-0', parent.hash]))[0].n), 0);
  const plan = buildRecoveryPlan([record], VIRTUAL_RECOMMENDATION_POLICY, f.clock());
  assert.equal(plan.sources.length, 1); assert.equal(plan.excluded.length, 0);
  const originalHistory = async () => ({
    jobs: await raw('SELECT * FROM research_execution_jobs WHERE policy_hash=? ORDER BY id', [parent.hash]),
    inputs: await raw('SELECT i.* FROM research_execution_inputs i JOIN research_execution_jobs j ON j.id=i.job_id WHERE j.policy_hash=? ORDER BY i.id', [parent.hash]),
    decisions: await raw('SELECT d.* FROM research_execution_decisions d JOIN research_execution_inputs i ON i.id=d.input_id JOIN research_execution_jobs j ON j.id=i.job_id WHERE j.policy_hash=? ORDER BY d.id', [parent.hash]),
    origins: await raw('SELECT * FROM research_inputs ORDER BY id'),
  });
  return { ...f, plan, raw, originalHistory };
}

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

test('entirely technical A/C quote failures remain retryable without freezing execution evidence', async (t) => {
  for (const code of ['odds_credit_budget_exhausted', 'odds_cache_only', 'odds_reset_unconfirmed']) {
    const f = await fixture(t, { matches: 1 }), prepare = f.runtime.prepare, jobs = [];
    let failed = true;
    f.runtime.prepare = async (job) => {
      jobs.push({ id: job.id, originInputId: job.originInputId });
      const item = await prepare(job);
      if (failed) item.decisions = item.decisions.map((decision) => ({ ...decision,
        action: 'ABSTAIN', reason: code, recommended: false, validated: false }));
      return item;
    };
    const first = await execute(f);
    assert.equal(first.errors, 1); assert.equal(first.retryableMatches, 1); assert.equal(first.registeredBets, 0);
    assert.equal(first.reasonCounts[code], 1); assert.equal(f.runs.at(-1).success, false);
    const originalEvidence = JSON.stringify(await f.research.listDecisions());
    assert.equal((await f.research.listDecisions()).length, 2);
    assert.equal((await f.recommendations.listDecisions()).length, 0);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM research_execution_inputs')).rows[0].n), 0);
    assert.equal((await f.recommendations.listJobs())[0].status, 'ERROR');
    assert.equal((await f.recommendations.listJobs())[0].reason, code);
    failed = false;
    const recovered = await execute(f);
    assert.equal(recovered.errors, 0); assert.equal(recovered.registeredBets, 2);
    assert.equal(recovered.decisionCount, 2); assert.equal(f.runs.at(-1).success, true);
    assert.deepEqual(jobs[1], jobs[0]);
    assert.equal((await f.recommendations.listJobs())[0].status, 'COMPLETED');
    assert.equal(JSON.stringify(await f.research.listDecisions()), originalEvidence);
    assert.equal(f.counters.diagnosticPreparations, 1); assert.equal(f.counters.executionPreparations, 2);
  }
});

test('thrown quote budget/cache/reset denials finish as retryable errors rather than permanent skipped jobs', async (t) => {
  for (const code of ['odds_credit_budget_exhausted', 'odds_cache_only', 'odds_reset_unconfirmed']) {
    const f = await fixture(t, { matches: 1 }), prepare = f.runtime.prepare;
    f.runtime.prepare = async () => { throw Object.assign(new Error('Private technical denial'), { code }); };
    const failed = await execute(f);
    assert.equal(failed.errors, 1); assert.equal(failed.retryableMatches, 1);
    assert.equal(failed.reasonCounts[code], 1); assert.equal(f.runs.at(-1).success, false);
    assert.equal((await f.recommendations.listJobs())[0].status, 'ERROR');
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM research_execution_inputs')).rows[0].n), 0);
    f.runtime.prepare = prepare;
    assert.equal((await execute(f)).registeredBets, 2);
    assert.doesNotMatch(JSON.stringify(f.runs), /Private technical/);
  }
});

test('a valid mixed pair and a genuine no-recommendation pair keep their completed immutable decisions', async (t) => {
  for (const mode of ['mixed', 'sporting_no_bet', 'different_no_bet_reason']) {
    const f = await fixture(t, { matches: 1, noRecommendation: mode !== 'mixed' }), prepare = f.runtime.prepare;
    f.runtime.prepare = async (job) => {
      const item = await prepare(job);
      if (mode === 'mixed') item.decisions[1] = { ...item.decisions[1], action: 'ABSTAIN',
        reason: 'odds_credit_budget_exhausted', recommended: false, validated: false };
      if (mode === 'different_no_bet_reason') item.decisions[0].reason = 'odds_credit_budget_exhausted';
      return item;
    };
    const result = await execute(f);
    assert.equal(result.errors, 0); assert.equal(result.retryableMatches, undefined);
    assert.equal(result.registeredBets, mode === 'mixed' ? 1 : 0); assert.equal(result.decisionCount, 2);
    assert.equal((await f.recommendations.listJobs())[0].status, 'COMPLETED');
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM research_execution_inputs')).rows[0].n), 1);
    const before = JSON.stringify(await f.recommendations.listDecisions()), preparations = f.counters.executionPreparations;
    await execute(f, { runId: `repeat-${mode}` });
    assert.equal(f.counters.executionPreparations, preparations);
    assert.equal(JSON.stringify(await f.recommendations.listDecisions()), before);
  }
});

test('an explicit bounded recovery appends only its allowed fixture under a new policy and preserves all old evidence', async (t) => {
  const f = await historicalRecoveryFixture(t), before = await f.originalHistory();
  const existingBets = await f.raw('SELECT * FROM research_bets ORDER BY id');
  const preparedMatches = [], prepare = f.runtime.prepare;
  f.runtime.prepare = async (job) => { preparedMatches.push(job.matchId); return prepare(job); };
  const result = await execute(f, { runId: 'explicit-technical-recovery', technicalRecovery: f.plan });
  assert.equal(result.errors, 0); assert.equal(result.policyHash, f.plan.policyHash);
  assert.equal(result.recoveryOf, f.plan.parentPolicyHash); assert.equal(result.recoveryTargetCount, 1);
  assert.equal(result.registeredBets, 2); assert.equal(result.decisionCount, 2);
  assert.deepEqual(preparedMatches, ['fixture-0']);
  assert.deepEqual(await f.originalHistory(), before);
  assert.deepEqual((await f.raw('SELECT * FROM research_bets ORDER BY id')).filter((row) => existingBets.some((old) => old.id === row.id)), existingBets);
  const childJobs = await f.recommendations.listJobs({ policyHash: f.plan.policyHash });
  assert.equal(childJobs.length, 1); assert.equal(childJobs[0].matchId, 'fixture-0'); assert.equal(childJobs[0].status, 'COMPLETED');
  const packet = JSON.parse((await f.raw('SELECT snapshot_json FROM research_execution_inputs WHERE job_id=?', [childJobs[0].id]))[0].snapshot_json);
  assert.equal(researchHash(packet.metadata.policy), f.plan.policyHash);
  assert.equal(packet.metadata.technicalRecovery.source.sourceInputId, f.plan.sources[0].sourceInputId);
  const repeated = await execute(f, { runId: 'recovery-retry', technicalRecovery: f.plan });
  assert.equal(repeated.registeredBets, 0); assert.deepEqual(preparedMatches, ['fixture-0']);
  assert.equal((await f.raw('SELECT COUNT(*) AS n FROM research_bets'))[0].n, 4);
});

test('recovery policy, window and source-list tampering fail before registering or claiming a new policy', async (t) => {
  const f = await historicalRecoveryFixture(t), history = await f.originalHistory(), claims = f.counters.claims;
  const mutations = [
    (plan) => { plan.policy.familyA.marketCoverage = 'goals_only'; },
    (plan) => { plan.policy.maxExposureFraction = .06; },
    (plan) => { plan.windowEndAt = '2026-11-01T02:07:00.000Z'; plan.sources[0].windowEndAt = plan.windowEndAt;
      plan.policy.recovery.sources = plan.sources; },
    (plan) => { plan.sources[0].sourceDecisionIds = ['unrelated-A', 'unrelated-C']; plan.policy.recovery.sources = plan.sources; },
    (plan) => { plan.parentPolicyHash = '0'.repeat(64); },
    (plan) => { plan.policy.recovery.maxDepth = 2; },
    (plan) => { plan.fixtures[0].matchId = 'fixture-1'; },
    (plan) => { plan.plannedAt = '2026-10-30T12:31:00.000Z'; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const plan = JSON.parse(JSON.stringify(f.plan)); mutate(plan); plan.policyHash = researchHash(plan.policy);
    const result = await execute(f, { runId: `tampered-recovery-${index}`, technicalRecovery: plan });
    assert.ok(result.errors > 0); assert.equal(f.counters.claims, claims);
    assert.deepEqual(await f.originalHistory(), history);
    assert.equal(Number((await f.raw('SELECT COUNT(*) AS n FROM research_execution_policies'))[0].n), 1);
    assert.equal(Number((await f.raw('SELECT COUNT(*) AS n FROM research_bets'))[0].n), 2);
  }
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

test('data-gate failure and diagnostic database errors prevent every new execution claim and stake', async (t) => {
  for (const databaseFailure of [false, true]) {
    const f = await fixture(t, { diagnosticThrows: databaseFailure,
      diagnosticError: Object.assign(new Error('Private database error'), { name: 'LibsqlError', code: 'SQLITE_BUSY' }) });
    const result = await execute(f, databaseFailure ? {} : { dataGatesPassed: false });
    assert.ok(result.errors > 0); assert.equal(f.counters.claims, 0); assert.equal(f.counters.executionPreparations, 0);
    assert.equal((await f.research.listBets()).length, 0);
    assert.equal(f.runs.at(-1).schedulerName, 'research_nightly'); assert.equal(f.runs.at(-1).success, false);
  }
});

test('failed diagnostic inference records unavailable origins while independent A advice still executes', async (t) => {
  const f = await fixture(t, { diagnosticThrows: true });
  const result = await execute(f);
  assert.equal(result.diagnosticPreparationErrors, 2); assert.equal(result.errors, 2);
  assert.equal(result.reasonCounts.diagnostic_preparation_failed, 2);
  assert.equal(result.reasonCounts.diagnostic_stage_failed, undefined);
  assert.equal(result.registeredBets, 2); assert.equal(result.decisionCount, 4);
  assert.equal(f.counters.executionPreparations, 2);
  const bets = await f.research.listBets();
  assert.ok(bets.every((bet) => bet.family === 'A' && bet.executionDecisionId));
  const origins = await f.research.listDecisions();
  assert.equal(origins.length, 4);
  assert.ok(origins.every((decision) => decision.action === 'ABSTAIN' && decision.snapshot.stakeCents === 0
    && decision.snapshot.diagnosticOriginalDecision.reason === 'diagnostic_unavailable'
    && decision.snapshot.diagnosticOriginalDecision.validated === false));
  const inputs = (await f.client.execute('SELECT snapshot_json FROM research_inputs')).rows
    .map((row) => JSON.parse(row.snapshot_json));
  assert.ok(inputs.every((input) => input.observedAt === START && input.quotes.length === 0
    && input.diagnosticPreparation.reason === 'research_forecast_unavailable'
    && !input.forecast && !input.probabilities));
  assert.ok((await f.recommendations.listDecisions()).filter((decision) => decision.family === 'C')
    .every((decision) => decision.action === 'ABSTAIN'));
  assert.ok(f.runs.every((run) => run.success === false));
  assert.doesNotMatch(JSON.stringify(f.runs), /Private diagnostic/);
  const before = JSON.stringify(origins);
  await execute(f, { runId: 'diagnostic-failure-repeat' });
  assert.equal((await f.research.listBets()).length, 2);
  assert.equal(JSON.stringify(await f.research.listDecisions()), before);
});

test('invalid diagnostic job identity and changed fixture do not become fallback origins', async (t) => {
  for (const fault of ['job_identity', 'changed_fixture', 'origin_commit']) {
    const f = await fixture(t, { matches: 1, diagnosticThrows: fault === 'changed_fixture' });
    const originalPrepare = f.diagnosticPreparer.prepareNightly;
    f.diagnosticPreparer.prepareNightly = async (job) => {
      if (fault === 'changed_fixture') {
        f.matches[0].date = '2026-10-30T19:00:00Z';
        return originalPrepare(job);
      }
      const prepared = await originalPrepare(job);
      return fault === 'job_identity' ? { ...prepared, job: { ...job, matchId: 'another-match' } } : prepared;
    };
    if (fault === 'origin_commit') f.research.commitBatch = async () => { throw new Error('Origin store unavailable'); };
    const result = await execute(f);
    assert.ok(result.errors > 0); assert.equal(result.diagnosticPreparationErrors, 0);
    assert.equal(f.counters.claims, 0); assert.equal(f.counters.executionPreparations, 0);
    assert.equal((await f.research.listDecisions()).length, 0);
    assert.equal((await f.research.listBets()).length, 0);
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

test('an unreadable adoption registry blocks only C rather than guessing the C906 fallback', async (t) => {
  const f = await fixture(t, { matches: 1 }); let stateReads = 0, pinned;
  f.db.challengerAdoption = { reviewCandidates: async () => {}, getState: async () => {
    stateReads++; throw Error('Private adopted registry unavailable');
  } };
  f.runtime.beginCohort = (_runId, state) => { pinned = state; };
  const result = await execute(f);
  assert.equal(stateReads, 1); assert.equal(pinned.resolutionUnavailable, true);
  assert.equal(result.protocol, 'virtual-recommendation-v3'); assert.ok(result.errors > 0);
  const bets = await f.research.listBets();
  assert.equal(bets.length, 1); assert.equal(bets[0].family, 'A'); assert.equal(bets[0].stakeCents, 1500);
  const c = (await f.recommendations.listDecisions()).find((row) => row.family === 'C');
  assert.equal(c.action, 'ABSTAIN'); assert.equal(c.reason, 'adoption_state_unavailable');
  assert.doesNotMatch(JSON.stringify(f.runs), /Private adopted/);
});

test('failed candidate review still reads and pins the actual adopted C while preserving A advice', async (t) => {
  const f = await fixture(t, { matches: 1 }); let stateReads = 0, pinned;
  const state = { source: 'adopted', revision: 'actual-adoption', deployment: {
    modelVersion: 'C-already-adopted', baselineVersion: baselineManifest().version, selectorPolicy: 'payout-aware-v1',
    probabilityConfigurationHash: '1'.repeat(64), artifactHash: '2'.repeat(64) } };
  await f.research.saveModel({ family: 'C', version: state.deployment.modelVersion, artifact: { fixtureOnly: true } });
  await f.research.setMarketState({ family: 'C', modelVersion: state.deployment.modelVersion, market: '1x2', state: 'EXPERIMENTAL' });
  f.db.challengerAdoption = { reviewCandidates: async () => { throw Error('Private review failure'); },
    getState: async () => { stateReads++; return state; } };
  f.runtime.beginCohort = (_runId, value) => { pinned = value; };
  const prepare = f.runtime.prepare;
  f.runtime.prepare = async (job) => {
    const item = await prepare(job);
    item.decisions.find((row) => row.family === 'C').modelVersion = pinned.deployment.modelVersion;
    return item;
  };
  const result = await execute(f);
  assert.equal(stateReads, 1); assert.deepEqual(pinned, state); assert.ok(result.errors > 0);
  const bets = await f.research.listBets();
  assert.equal(bets.length, 2); assert.equal(bets.find((row) => row.family === 'C').modelVersion, state.deployment.modelVersion);
  assert.equal(bets.find((row) => row.family === 'A').stakeCents, 1500);
  assert.equal(result.reasonCounts.adoption_state_unavailable, undefined);
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
