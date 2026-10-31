const test = require('node:test');
const assert = require('node:assert/strict');
if (process.env.RESEARCH_SOURCE_TESTS === '1') require('ts-node/register/transpile-only');
const moduleRoot = process.env.RESEARCH_SOURCE_TESTS === '1' ? '../src/research/' : '../dist/research/';
const { researchHash } = require(moduleRoot + 'ResearchStore');
const { VIRTUAL_RECOMMENDATION_POLICY, challengerExecutionPolicy } = require(moduleRoot + 'ResearchRecommendationPolicy');
const { buildRecoveryPlan, TECHNICAL_RECOVERY_REASONS } = require(moduleRoot + 'ResearchRecommendationRecovery');

const START = '2026-10-31T02:07:00.000Z';
const OBSERVED = '2026-10-31T02:08:00.000Z';
const NOW = '2026-10-31T08:00:00.000Z';
const KICKOFF = '2026-10-31T17:00:00.000Z';
const END = '2026-11-01T02:07:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
const policy = () => clone(VIRTUAL_RECOMMENDATION_POLICY);

function fixture(matchId = 'fixture-one', currentPolicy = policy()) {
  const parentHash = researchHash(currentPolicy), jobId = `job:${matchId}`, inputId = `input:${matchId}`;
  const originJobId = `origin-job:${matchId}`, originInputId = `origin-input:${matchId}`, runId = 'github-actions:failed-run';
  const snapshot = { observedAt: OBSERVED, quotes: [],
    match: { matchId, kickoffAt: KICKOFF }, metadata: { originInputId, policy: clone(currentPolicy) },
    forecasts: { A: null, C: { decision: null, recommendation: null } } };
  const inputHash = researchHash(snapshot);
  const originDecisions = ['A', 'C'].map(family => ({ id: `origin-decision:${matchId}:${family}`,
    inputId: originInputId, family, portfolioId: `shadow_${family}` }));
  const decisions = originDecisions.map(origin => {
    const id = `decision:${matchId}:${origin.family}`, reason = 'odds_credit_budget_exhausted';
    return { id, inputId, originDecisionId: origin.id, family: origin.family, portfolioId: origin.portfolioId,
      modelVersion: `${origin.family}-unavailable`, action: 'ABSTAIN', reason,
      snapshot: { family: origin.family, modelVersion: `${origin.family}-unavailable`, action: 'ABSTAIN', reason,
        portfolioId: origin.portfolioId, matchId, kickoffAt: KICKOFF, runId,
        originDecisionId: origin.id, originInputId, effectiveExecutionDecisionId: id,
        inputId, inputHash, policyHash: parentHash, stakeCents: 0, recommended: false, validated: false } };
  });
  return { match: { matchId, kickoffAt: KICKOFF, homeGoals: null, awayGoals: null },
    policy: { hash: parentHash, descriptor: clone(currentPolicy) },
    job: { id: jobId, matchId, policyHash: parentHash, runId, status: 'COMPLETED', kickoffAt: KICKOFF,
      claimedAt: START, windowStartAt: START, windowEndAt: END },
    input: { id: inputId, jobId, originInputId, inputHash, decisionsHash: researchHash([{ fixtureOnly: true }]),
      capturedAt: OBSERVED, kickoffAt: KICKOFF, snapshot },
    decisions, originJob: { id: originJobId, matchId }, originInput: { id: originInputId, jobId: originJobId },
    originDecisions, existingBets: [], existingRecoveries: [] };
}

function childRecovery(record, fields = {}) {
  return { jobId: `recovery-job:${record.match.matchId}`, status: 'COMPLETED',
    inputId: `recovery-input:${record.match.matchId}`, sourceJobId: record.job.id,
    sourceInputId: record.input.id, parentPolicyHash: record.policy.hash, ...fields };
}

function decisionReason(record, family, reason, action = 'ABSTAIN') {
  const decision = record.decisions.find(item => item.family === family);
  decision.reason = reason; decision.action = action;
  decision.snapshot.reason = reason; decision.snapshot.action = action;
}

test('technical recovery creates a deterministic append-only descriptor without mutating either engine or evidence', () => {
  const current = policy(), records = [fixture('zeta', current), fixture('alpha', current)];
  const before = JSON.stringify({ current, records });
  const first = buildRecoveryPlan(records, current, NOW);
  const second = buildRecoveryPlan([...records].reverse().map(record => ({ ...record,
    decisions: [...record.decisions].reverse(), originDecisions: [...record.originDecisions].reverse() })), current,
  '2026-10-31T08:01:00.000Z');
  assert.equal(first.policyHash, second.policyHash);
  assert.notEqual(first.policyHash, researchHash(current));
  assert.deepEqual(first.fixtures.map(item => item.matchId), ['alpha', 'zeta']);
  assert.equal(first.policy.version, current.version);
  const { recovery, ...execution } = first.policy;
  assert.deepEqual(execution, current);
  assert.deepEqual(recovery.matchIds, ['alpha', 'zeta']);
  assert.equal(recovery.parentPolicyHash, researchHash(current));
  assert.equal(recovery.retrospective, false);
  assert.equal(recovery.maxDepth, 1);
  assert.equal(recovery.sourceDecisionIds.length, 4);
  assert.equal(first.windowEndAt, END);
  assert.equal(JSON.stringify({ current, records }), before);
});

test('both original sports abstentions and mixed technical/sports decisions remain excluded', () => {
  for (const reason of ['app_no_recommendation', 'central_ev_below_threshold', 'real_fresh_quotes_unavailable']) {
    const record = fixture(); decisionReason(record, 'C', reason);
    const plan = buildRecoveryPlan([record], policy(), NOW);
    assert.equal(plan.policy, null);
    assert.equal(plan.policyHash, null);
    assert.deepEqual(plan.excluded, [{ matchId: record.match.matchId, reason: 'nontechnical_decision_preserved' }]);
  }
  const record = fixture(); decisionReason(record, 'A', 'app_no_recommendation'); decisionReason(record, 'C', 'challenger_no_recommendation');
  assert.equal(buildRecoveryPlan([record], policy(), NOW).fixtures.length, 0);
});

test('every existing bet or BET action preserves the entire match, including the other family', () => {
  for (const family of ['A', 'C']) {
    const record = fixture(); record.existingBets = [{ id: 'funded-bet', portfolioId: `shadow_${family}` }];
    assert.equal(buildRecoveryPlan([record], policy(), NOW).excluded[0].reason, 'existing_bet_preserved');
    const betDecision = fixture(); decisionReason(betDecision, family, null, 'BET');
    assert.equal(buildRecoveryPlan([betDecision], policy(), NOW).excluded[0].reason, 'nontechnical_decision_preserved');
  }
  const record = fixture(); delete record.existingBets;
  assert.equal(buildRecoveryPlan([record], policy(), NOW).excluded[0].reason, 'existing_bet_evidence_missing');
});

test('started/completed/changed fixtures and expired source windows cannot be backfilled', () => {
  assert.equal(buildRecoveryPlan([fixture()], policy(), KICKOFF).excluded[0].reason, 'fixture_already_started');
  const completed = fixture(); completed.match.homeGoals = 1;
  assert.equal(buildRecoveryPlan([completed], policy(), NOW).excluded[0].reason, 'fixture_already_completed');
  const changed = fixture(); changed.match.kickoffAt = '2026-10-31T18:00:00.000Z';
  assert.equal(buildRecoveryPlan([changed], policy(), NOW).excluded[0].reason, 'fixture_or_window_mismatch');
  const expired = fixture(); expired.job.windowEndAt = '2026-10-31T07:00:00.000Z';
  assert.equal(buildRecoveryPlan([expired], policy(), NOW).fixtures.length, 0);
  const missing = fixture(); delete missing.match.awayGoals;
  assert.equal(buildRecoveryPlan([missing], policy(), NOW).excluded[0].reason, 'fixture_result_state_missing');
});

test('parent family configuration and policy identities are checked without changing A', () => {
  const changed = policy(); changed.familyA.playerProps = true;
  assert.throws(() => buildRecoveryPlan([fixture()], changed, NOW), /parent_execution_configuration_changed/);
  const differentC = policy(); differentC.familyC.modelVersion = 'C-other';
  assert.throws(() => buildRecoveryPlan([fixture()], differentC, NOW), /parent_execution_configuration_changed/);
  const record = fixture(); record.policy.descriptor.familyA.playerProps = true;
  assert.equal(buildRecoveryPlan([record], policy(), NOW).excluded[0].reason, 'source_policy_identity_mismatch');
});

test('v3 adopted C deployment can recover only under exactly the same current deployment policy', () => {
  const current = challengerExecutionPolicy({ source: 'adopted', revision: 'adoption:one', deployment: {
    ...policy().familyC, modelVersion: 'C-adopted', selectorPolicy: 'payout-aware-v1',
    probabilityConfigurationHash: 'a'.repeat(64), artifactHash: 'b'.repeat(64) } });
  const plan = buildRecoveryPlan([fixture('adopted', current)], current, NOW);
  assert.equal(plan.fixtures.length, 1); assert.equal(plan.policy.version, 'virtual-recommendation-v3');
  assert.deepEqual(plan.policy.familyA, current.familyA); assert.deepEqual(plan.policy.familyC, current.familyC);
  const newer = clone(current); newer.familyC.deploymentRevision = 'adoption:two';
  assert.equal(buildRecoveryPlan([fixture('old', current)], newer, NOW).excluded[0].reason, 'source_policy_not_current');
});

test('source input, origin and final decision references must match exactly', () => {
  const mutations = [
    record => { record.input.snapshot.forecasts.A = { changed: true }; },
    record => { record.decisions[0].originDecisionId = record.originDecisions[1].id; },
    record => { record.originInput.jobId = 'wrong-origin-job'; },
    record => { record.decisions[1].snapshot.effectiveExecutionDecisionId = 'other'; },
    record => { record.decisions[0].snapshot.stakeCents = 1; },
    record => { record.decisions[0].snapshot.recommended = true; },
    record => { record.input.capturedAt = '2026-10-31T09:00:00.000Z'; },
    record => { record.job.status = 'ERROR'; },
    record => { record.decisions.pop(); },
  ];
  for (const mutate of mutations) {
    const record = fixture(); mutate(record);
    const plan = buildRecoveryPlan([record], policy(), NOW);
    assert.equal(plan.fixtures.length, 0);
    assert.equal(plan.excluded.length, 1);
  }
});

test('allowlist is closed to three technical reasons; each family must independently qualify', () => {
  for (const reason of TECHNICAL_RECOVERY_REASONS) {
    const record = fixture(); decisionReason(record, 'A', reason); decisionReason(record, 'C', reason);
    assert.equal(buildRecoveryPlan([record], policy(), NOW).fixtures.length, 1);
  }
  const record = fixture(); decisionReason(record, 'A', 'app_prediction_unavailable');
  assert.equal(buildRecoveryPlan([record], policy(), NOW).excluded[0].reason, 'nontechnical_decision_preserved');
});

test('recursive recoveries, duplicate match records, malformed timestamps and oversized cohorts fail closed', () => {
  const record = fixture(), first = buildRecoveryPlan([record], policy(), NOW);
  assert.throws(() => buildRecoveryPlan([record], first.policy, NOW), /recovery_ancestry_not_supported/);
  const duplicate = buildRecoveryPlan([record, clone(record)], policy(), NOW);
  assert.equal(duplicate.fixtures.length, 0);
  assert.ok(duplicate.excluded.every(item => item.reason === 'duplicate_match_record'));
  assert.throws(() => buildRecoveryPlan([], policy(), '2026-10-31T08:00:00'), /recovery_time_requires_timezone/);
  assert.throws(() => buildRecoveryPlan(Array.from({ length: 101 }, () => fixture()), policy(), NOW), /recovery_record_limit_exceeded/);
  assert.equal(buildRecoveryPlan([null], policy(), NOW).excluded[0].reason, 'invalid_recovery_record');
});

test('completed recovery NO_BETs cannot reopen when funded matches shrink a second cohort', () => {
  const funded = fixture('funded'), sportAbstain = fixture('sport-abstain');
  const first = buildRecoveryPlan([funded, sportAbstain], policy(), NOW);
  assert.equal(first.fixtures.length, 2);
  funded.existingBets = [{ id: 'recovery-funded-bet', portfolioId: 'shadow_A' }];
  funded.existingRecoveries = [childRecovery(funded)];
  sportAbstain.existingRecoveries = [childRecovery(sportAbstain)];
  const second = buildRecoveryPlan([funded, sportAbstain], policy(), '2026-10-31T08:01:00.000Z');
  assert.equal(second.policy, null);
  assert.equal(second.policyHash, null);
  assert.deepEqual(second.excluded, [
    { matchId: 'funded', reason: 'existing_bet_preserved' },
    { matchId: 'sport-abstain', reason: 'prior_recovery_preserved' },
  ]);
});

test('any persisted recovery input or terminal child is preserved independently of its outcome', () => {
  for (const status of ['COMPLETED', 'SKIPPED', 'ERROR', 'CLAIMED']) {
    const record = fixture(); record.existingRecoveries = [childRecovery(record, { status })];
    assert.equal(buildRecoveryPlan([record], policy(), NOW).excluded[0].reason, 'prior_recovery_preserved');
  }
  for (const status of ['COMPLETED', 'SKIPPED']) {
    const record = fixture(); record.existingRecoveries = [childRecovery(record, { status, inputId: null })];
    assert.equal(buildRecoveryPlan([record], policy(), NOW).excluded[0].reason, 'prior_recovery_preserved');
  }
});

test('only failed or expired recovery children without persisted input can retry', () => {
  for (const child of [
    { status: 'ERROR', inputId: null },
    { status: 'CLAIMED', inputId: null, leaseExpiresAt: '2026-10-31T07:59:00.000Z' },
    { status: 'CLAIMED', inputId: null, leaseExpiresAt: NOW },
  ]) {
    const record = fixture(); record.existingRecoveries = [childRecovery(record, child)];
    assert.equal(buildRecoveryPlan([record], policy(), NOW).fixtures.length, 1);
  }
  const active = fixture(); active.existingRecoveries = [childRecovery(active, {
    status: 'CLAIMED', inputId: null, leaseExpiresAt: '2026-10-31T08:05:00.000Z' })];
  assert.equal(buildRecoveryPlan([active], policy(), NOW).excluded[0].reason, 'prior_recovery_in_progress');
});

test('missing, malformed and mismatched recovery evidence fails closed', () => {
  const missing = fixture(); delete missing.existingRecoveries;
  assert.equal(buildRecoveryPlan([missing], policy(), NOW).excluded[0].reason, 'existing_recovery_evidence_missing');
  const malformed = [null, {}, { status: 'UNKNOWN' }, { inputId: undefined }, { inputId: '' },
    { status: 'CLAIMED', inputId: null }, { status: 'CLAIMED', inputId: null, leaseExpiresAt: '2026-10-31T07:59:00' },
    { leaseExpiresAt: 'invalid' }];
  for (const fields of malformed) {
    const record = fixture();
    record.existingRecoveries = [fields === null ? null : fields && Object.keys(fields).length
      ? childRecovery(record, fields) : {}];
    assert.equal(buildRecoveryPlan([record], policy(), NOW).excluded[0].reason, 'existing_recovery_evidence_invalid');
  }
  for (const fields of [{ sourceJobId: 'wrong' }, { sourceInputId: 'wrong' }, { parentPolicyHash: 'f'.repeat(64) }]) {
    const record = fixture(); record.existingRecoveries = [childRecovery(record, fields)];
    assert.equal(buildRecoveryPlan([record], policy(), NOW).excluded[0].reason, 'existing_recovery_origin_mismatch');
  }
  const duplicate = fixture(); duplicate.existingRecoveries = [childRecovery(duplicate), childRecovery(duplicate)];
  assert.equal(buildRecoveryPlan([duplicate], policy(), NOW).excluded[0].reason, 'existing_recovery_evidence_invalid');
});
