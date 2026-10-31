const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename, sep } = require('node:path');
const { researchHash } = require('../dist/research/ResearchStore');
const { VIRTUAL_RECOMMENDATION_POLICY } = require('../dist/research/ResearchRecommendationPolicy');
const { buildRecoveryPlan } = require('../dist/research/ResearchRecommendationRecovery');
const { loadTechnicalRecoveryRecords, writePlan, readOnlyClient, romeDayWindow, parseArgs, main } = require('../scripts/recover-recommendation-technical');

const START = '2026-10-31T02:07:00.000Z', OBSERVED = '2026-10-31T02:08:00.000Z';
const NOW = '2026-10-31T08:00:00.000Z', KICKOFF = '2026-10-31T17:00:00.000Z', END = '2026-11-01T02:07:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
function removeTestDirectory(directory) {
  const target = resolve(directory), root = resolve(tmpdir());
  assert.ok(target.startsWith(`${root}${sep}`) && basename(target).startsWith('technical-recovery-'));
  rmSync(target, { recursive: true, force: true });
}

function record(matchId) {
  const descriptor = clone(VIRTUAL_RECOMMENDATION_POLICY), policyHash = researchHash(descriptor);
  const jobId = `execution-job:${matchId}`, inputId = `execution-input:${matchId}`, originInputId = `origin-input:${matchId}`;
  const runId = 'synthetic-nightly-failure';
  const snapshot = { observedAt: OBSERVED, match: { matchId, kickoffAt: KICKOFF }, quotes: [],
    metadata: { originInputId, policy: descriptor } };
  const inputHash = researchHash(snapshot);
  const originDecisions = ['A', 'C'].map(family => ({ id: `origin-decision:${matchId}:${family}`,
    inputId: originInputId, family, portfolioId: `shadow_${family}` }));
  const decisions = originDecisions.map(origin => {
    const id = `execution-decision:${matchId}:${origin.family}`, modelVersion = `${origin.family}-unavailable`, reason = 'odds_credit_budget_exhausted';
    return { id, inputId, originDecisionId: origin.id, family: origin.family, portfolioId: origin.portfolioId,
      modelVersion, action: 'ABSTAIN', reason, snapshot: { family: origin.family, modelVersion, action: 'ABSTAIN', reason,
        portfolioId: origin.portfolioId, matchId, kickoffAt: KICKOFF, runId, originDecisionId: origin.id, originInputId,
        effectiveExecutionDecisionId: id, inputId, inputHash, policyHash, stakeCents: 0, recommended: false, validated: false } };
  });
  return { match: { matchId, kickoffAt: KICKOFF, homeGoals: null, awayGoals: null }, policy: { hash: policyHash, descriptor },
    job: { id: jobId, matchId, policyHash, runId, status: 'COMPLETED', kickoffAt: KICKOFF, claimedAt: START, windowStartAt: START, windowEndAt: END },
    input: { id: inputId, jobId, originInputId, inputHash, decisionsHash: researchHash({ opaqueFrozenPreparedDecisions: matchId }),
      capturedAt: OBSERVED, kickoffAt: KICKOFF, snapshot }, decisions, originDecisions,
    originInput: { id: originInputId, jobId: `origin-job:${matchId}` }, originJob: { id: `origin-job:${matchId}`, matchId }, existingBets: [], existingRecoveries: [] };
}

function database(records) {
  const descriptor = records[0]?.policy.descriptor ?? clone(VIRTUAL_RECOMMENDATION_POLICY);
  const tables = {
    research_execution_policies: [{ hash: researchHash(descriptor), version: descriptor.version, descriptor_json: JSON.stringify(descriptor) }],
    research_execution_jobs: [],
    matches: records.map(({ match, job }) => ({ id: job.id, match_id: job.matchId, policy_hash: job.policyHash, run_id: job.runId,
      status: job.status, kickoff_at: job.kickoffAt, window_start_at: job.windowStartAt, window_end_at: job.windowEndAt, claimed_at: job.claimedAt,
      fixture_kickoff_at: match.kickoffAt, fixture_home_goals: match.homeGoals, fixture_away_goals: match.awayGoals })),
    research_execution_inputs: records.map(({ input }) => ({ id: input.id, job_id: input.jobId, origin_input_id: input.originInputId,
      input_hash: input.inputHash, decisions_hash: input.decisionsHash, captured_at: input.capturedAt, kickoff_at: input.kickoffAt,
      snapshot_json: JSON.stringify(input.snapshot) })),
    research_execution_decisions: records.flatMap(({ decisions }) => decisions.map(d => ({ id: d.id, input_id: d.inputId,
      origin_decision_id: d.originDecisionId, family: d.family, model_version: d.modelVersion, portfolio_id: d.portfolioId,
      action: d.action, reason: d.reason, snapshot_json: JSON.stringify(d.snapshot) }))),
    research_inputs: records.map(({ originInput }) => ({ id: originInput.id, job_id: originInput.jobId })),
    research_jobs: records.map(({ originJob }) => ({ id: originJob.id, match_id: originJob.matchId })),
    research_decisions: records.flatMap(({ originDecisions }) => originDecisions.map(d => ({ id: d.id, input_id: d.inputId, family: d.family, portfolio_id: d.portfolioId }))),
    research_bets: records.flatMap(({ existingBets, match }) => existingBets.map(b => ({ id: b.id, portfolio_id: b.portfolioId, match_id: match.matchId }))),
  };
  const calls = [];
  return { tables, calls, closed: false, async execute(statement) {
    const { sql, args = [] } = typeof statement === 'string' ? { sql: statement } : statement;
    assert.match(sql, /^\s*SELECT\b/i); assert.doesNotMatch(sql, /;|\b(?:PRAGMA|UPDATE|DELETE|INSERT|CREATE|ALTER)\b/i);
    assert.doesNotMatch(sql, /SELECT\s+\*/i);
    calls.push({ sql, args: [...args] });
    const table = /\bFROM\s+(\w+)/i.exec(sql)?.[1];
    assert.ok(Object.hasOwn(tables, table), `Unexpected table: ${table}`);
    let selected;
    if (table === 'research_execution_policies') selected = tables[table].filter(row => row.hash === args[0]);
    else if (table === 'matches') {
      assert.match(sql, /JOIN research_execution_jobs j ON j.match_id=m.match_id AND j.policy_hash=\?/);
      assert.match(sql, /WHERE m.date>=\? AND m.date<\?/);
      selected = tables[table].filter(row => row.policy_hash === args[0] && row.fixture_kickoff_at >= args[1] && row.fixture_kickoff_at < args[2]);
    } else if (table === 'research_execution_jobs') {
      assert.match(sql, /LEFT JOIN research_execution_inputs i ON i.job_id=j.id/);
      assert.match(sql, /json_extract\(p.descriptor_json,'\$\.recovery.parentPolicyHash'\)=\?/);
      assert.match(sql, /j.match_id IN \(/);
      assert.ok(args.length <= 102);
      const ids = args.slice(0, -2), excludedPolicy = args.at(-2), parentHash = args.at(-1);
      selected = tables[table].filter(row => ids.includes(row.match_id) && row.policy_hash !== excludedPolicy
        && JSON.parse(row.descriptor_json).recovery?.parentPolicyHash === parentHash);
    } else {
      const key = ['research_execution_inputs'].includes(table) ? 'job_id'
        : ['research_execution_decisions', 'research_decisions'].includes(table) ? 'input_id'
          : table === 'research_bets' ? 'match_id' : 'id';
      assert.match(sql, new RegExp(`${key} IN \\(`));
      assert.ok(args.length <= 100);
      selected = tables[table].filter(row => args.includes(row[key]) && (table !== 'research_bets' || ['shadow_A', 'shadow_C'].includes(row.portfolio_id)));
      if (table === 'research_bets') assert.match(sql, /portfolio_id IN \('shadow_A','shadow_C'\)/);
    }
    const limit = Number(/\bLIMIT (\d+)/i.exec(sql)?.[1]);
    assert.ok(limit > 0, 'Every read has a hard row limit');
    return { rows: selected.slice(0, limit) };
  }, close() { this.closed = true; },
  ready() { assert.fail('Application bootstrap is forbidden'); }, transaction() { assert.fail('Transactions are forbidden'); },
  executeMultiple() { assert.fail('Multiple statements are forbidden'); } };
}

test('read-only wrapper rejects every mutation and multiple-statement form before calling the client', async () => {
  const calls = [], client = readOnlyClient({ execute: sql => { calls.push(sql); return { rows: [] }; } });
  for (const sql of ['UPDATE x SET n=1', 'PRAGMA query_only=ON', 'BEGIN', 'WITH x AS (SELECT 1) DELETE FROM x',
    'SELECT 1; DELETE FROM x', '-- comment\nSELECT 1', 'SELECT 1 /* hidden */']) assert.throws(() => client.execute(sql), /select_only/);
  assert.deepEqual(calls, []); assert.equal(client.transaction, undefined); assert.equal(client.executeMultiple, undefined);
  await client.execute('SELECT 1'); assert.equal(calls.length, 1);
});

test('Rome kickoff days have exact UTC boundaries including both DST changes', () => {
  assert.deepEqual(romeDayWindow('2026-10-31'), { dayStartAt: '2026-10-30T23:00:00.000Z', dayEndAt: '2026-10-31T23:00:00.000Z' });
  for (const [day, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) {
    const range = romeDayWindow(day);
    assert.equal((Date.parse(range.dayEndAt) - Date.parse(range.dayStartAt)) / 3600000, hours);
  }
  assert.throws(() => romeDayWindow('2026-02-30'), /day_invalid/);
});

test('bounded loader preserves 18 technical sources and excludes sports choices and either family existing bets', async () => {
  const records = Array.from({ length: 22 }, (_, i) => record(`fixture-${i}`));
  for (const index of [18, 19]) for (const decision of records[index].decisions) {
    decision.reason = 'app_no_recommendation'; decision.snapshot.reason = decision.reason;
  }
  records[20].existingBets = [{ id: 'existing-A-bet', portfolioId: 'shadow_A' }];
  records[21].existingBets = [{ id: 'existing-C-bet', portfolioId: 'shadow_C' }];
  const db = database(records), before = JSON.stringify(db.tables);
  const loaded = await loadTechnicalRecoveryRecords(db, { sourcePolicyHash: records[0].policy.hash, day: '2026-10-31', now: NOW });
  const plan = buildRecoveryPlan(loaded.records, loaded.currentPolicy, NOW);
  assert.equal(plan.fixtures.length, 18); assert.equal(plan.sources.length, 18); assert.equal(plan.excluded.length, 4);
  assert.equal(plan.sources.reduce((n, item) => n + item.sourceDecisionIds.length, 0), 36);
  assert.equal(plan.excluded.filter(item => item.reason === 'existing_bet_preserved').length, 2);
  assert.equal(plan.excluded.filter(item => item.reason === 'nontechnical_decision_preserved').length, 2);
  assert.equal(plan.sources[0].sourcePreparedDecisionsHash, records[0].input.decisionsHash);
  assert.equal(JSON.stringify(db.tables), before); assert.equal(db.calls.length, 9);
  assert.ok(loaded.records.every(item => Array.isArray(item.existingRecoveries) && item.existingRecoveries.length === 0));
  assert.ok(db.calls.every(call => !/ledger|scheduler_runs|COUNT\(/i.test(call.sql)));
});

function childRecoveryRows(records, plan, status = 'COMPLETED', withInput = true) {
  return records.map(source => ({ id: `child-job:${source.match.matchId}`, match_id: source.match.matchId,
    policy_hash: plan.policyHash, stored_policy_hash: plan.policyHash, descriptor_json: JSON.stringify(plan.policy),
    status, recovery_input_id: withInput ? `child-input:${source.match.matchId}` : null, lease_expires_at: null }));
}

test('a second parent plan preserves both the first child bet and its sports abstention despite a changed cohort', async () => {
  const records = [record('first-child-bet'), record('first-child-sports-abstention')], db = database(records);
  const args = { sourcePolicyHash: records[0].policy.hash, day: '2026-10-31', now: NOW };
  const initial = await loadTechnicalRecoveryRecords(db, args), firstPlan = buildRecoveryPlan(initial.records, initial.currentPolicy, NOW);
  assert.equal(firstPlan.fixtures.length, 2);
  db.tables.research_execution_jobs = childRecoveryRows(records, firstPlan);
  db.tables.research_bets.push({ id: 'first-child-A-bet', portfolio_id: 'shadow_A', match_id: records[0].match.matchId });
  const before = JSON.stringify(db.tables), second = await loadTechnicalRecoveryRecords(db, args);
  assert.ok(second.records.every(source => source.existingRecoveries.length === 1));
  const secondPlan = buildRecoveryPlan(second.records, second.currentPolicy, NOW);
  assert.equal(secondPlan.fixtures.length, 0); assert.equal(secondPlan.policy, null);
  assert.equal(secondPlan.excluded.find(item => item.matchId === records[0].match.matchId).reason, 'existing_bet_preserved');
  assert.equal(secondPlan.excluded.find(item => item.matchId === records[1].match.matchId).reason, 'prior_recovery_preserved');
  assert.equal(JSON.stringify(db.tables), before);
});

test('failed child jobs without an input can retry while active claims and any frozen child input remain preserved', async () => {
  const records = [record('child-state')], args = { sourcePolicyHash: records[0].policy.hash, day: '2026-10-31', now: NOW };
  const initial = buildRecoveryPlan(records, VIRTUAL_RECOMMENDATION_POLICY, NOW);
  for (const [status, withInput, lease, eligible, reason] of [
    ['ERROR', false, null, 1, null], ['ERROR', true, null, 0, 'prior_recovery_preserved'],
    ['CLAIMED', false, '2026-10-31T09:00:00.000Z', 0, 'prior_recovery_in_progress'],
    ['CLAIMED', false, '2026-10-31T07:00:00.000Z', 1, null],
    ['SKIPPED', false, null, 0, 'prior_recovery_preserved'],
  ]) {
    const db = database(records);
    db.tables.research_execution_jobs = childRecoveryRows(records, initial, status, withInput);
    db.tables.research_execution_jobs[0].lease_expires_at = lease;
    const loaded = await loadTechnicalRecoveryRecords(db, args), plan = buildRecoveryPlan(loaded.records, loaded.currentPolicy, NOW);
    assert.equal(plan.fixtures.length, eligible, `${status}/${withInput}/${lease}`);
    if (reason) assert.equal(plan.excluded[0].reason, reason);
  }
});

test('all prior child policies are checked against canonical hashes and exact source identities with a hard 500 row limit', async () => {
  const records = [record('prior-source')], args = { sourcePolicyHash: records[0].policy.hash, day: '2026-10-31', now: NOW };
  const plan = buildRecoveryPlan(records, VIRTUAL_RECOMMENDATION_POLICY, NOW);
  for (const change of ['hash', 'source', 'protocol', 'unknown_status', 'missing_input_evidence', 'too_many']) {
    const db = database(records), rows = childRecoveryRows(records, plan);
    if (change === 'hash') rows[0].policy_hash = rows[0].stored_policy_hash = 'f'.repeat(64);
    else if (change === 'unknown_status') rows[0].status = 'UNKNOWN';
    else if (change === 'missing_input_evidence') delete rows[0].recovery_input_id;
    else if (change !== 'too_many') {
      const descriptor = JSON.parse(rows[0].descriptor_json);
      if (change === 'source') descriptor.recovery.sources[0].sourceInputId = 'unverifiable-input';
      else descriptor.recovery.protocol = 'unknown-protocol';
      rows[0].descriptor_json = JSON.stringify(descriptor);
      rows[0].policy_hash = rows[0].stored_policy_hash = researchHash(descriptor);
    }
    db.tables.research_execution_jobs = change === 'too_many'
      ? Array.from({ length: 501 }, (_, index) => ({ ...rows[0], id: `child-${index}` })) : rows;
    await assert.rejects(loadTechnicalRecoveryRecords(db, args), /prior_policy_invalid|prior_source_identity_mismatch|prior_job_invalid|related_record_limit_exceeded/);
  }
});

test('loader fails above 100 sources without truncation or loading snapshots', async () => {
  const records = Array.from({ length: 101 }, (_, i) => record(`over-limit-${i}`)), db = database(records);
  await assert.rejects(loadTechnicalRecoveryRecords(db, { sourcePolicyHash: records[0].policy.hash, day: '2026-10-31', now: NOW }), /record_limit_exceeded/);
  assert.equal(db.calls.length, 2);
});

test('missing result fields, zero goals, corrupt snapshots and absent origins fail closed', async () => {
  const source = record('guarded'), args = { sourcePolicyHash: source.policy.hash, day: '2026-10-31', now: NOW };
  const missingResult = database([source]); delete missingResult.tables.matches[0].fixture_home_goals;
  await assert.rejects(loadTechnicalRecoveryRecords(missingResult, args), /fixture_result_state_missing/);
  const completed = database([source]); completed.tables.matches[0].fixture_home_goals = 0;
  const loaded = await loadTechnicalRecoveryRecords(completed, args);
  assert.equal(buildRecoveryPlan(loaded.records, loaded.currentPolicy, NOW).excluded[0].reason, 'fixture_already_completed');
  const corrupt = database([source]); corrupt.tables.research_execution_inputs[0].snapshot_json = '{invalid';
  await assert.rejects(loadTechnicalRecoveryRecords(corrupt, args), /snapshot_json_invalid/);
  const changed = database([source]); changed.tables.research_execution_inputs[0].snapshot_json = JSON.stringify({ changed: true });
  const changedInput = await loadTechnicalRecoveryRecords(changed, args);
  assert.equal(buildRecoveryPlan(changedInput.records, changedInput.currentPolicy, NOW).excluded[0].reason, 'source_input_hash_mismatch');
  const absent = database([source]); absent.tables.research_inputs = [];
  const absentInput = await loadTechnicalRecoveryRecords(absent, args);
  assert.equal(buildRecoveryPlan(absentInput.records, absentInput.currentPolicy, NOW).fixtures.length, 0);
  await assert.rejects(loadTechnicalRecoveryRecords(database([]), { ...args, now: '2026-10-31T08:00:00' }), /time_invalid/);
});

test('plan files are exclusive, hash verified and never overwrite old JSON', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'technical-recovery-plan-'));
  try {
    const source = record('file'), loaded = await loadTechnicalRecoveryRecords(database([source]), {
      sourcePolicyHash: source.policy.hash, day: '2026-10-31', now: NOW });
    const plan = buildRecoveryPlan(loaded.records, loaded.currentPolicy, NOW), output = join(directory, 'plan.json');
    const written = writePlan(output, plan, loaded), { planHash, ...payload } = written;
    assert.equal(planHash, researchHash(payload)); assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), written);
    assert.equal(written.metadata.readOnly, true); assert.equal(written.metadata.sourcePolicyHash, source.policy.hash);
    const old = readFileSync(output, 'utf8');
    assert.throws(() => writePlan(output, plan, loaded), /output_exists/); assert.equal(readFileSync(output, 'utf8'), old);
    writeFileSync(join(directory, 'historical.json'), '{"immutable":"historical"}\n');
    assert.throws(() => writePlan(join(directory, 'historical.json'), plan, loaded), /output_exists/);
    assert.equal(readFileSync(join(directory, 'historical.json'), 'utf8'), '{"immutable":"historical"}\n');
  } finally { removeTestDirectory(directory); }
});

test('CLI only plans, prefers the read-only credential, emits counts and handles no eligible sources', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'technical-recovery-cli-'));
  try {
    const source = record('not-eligible');
    for (const decision of source.decisions) { decision.reason = 'app_no_recommendation'; decision.snapshot.reason = decision.reason; }
    const db = database([source]), logs = [], output = join(directory, 'plan.json');
    const argv = ['plan', '--source-policy', source.policy.hash, '--day', '2026-10-31', '--out', output];
    let configuration;
    const result = await main(argv, { env: { TURSO_DATABASE_URL: 'libsql://synthetic.invalid', TURSO_WATCHDOG_READONLY_TOKEN: 'read-only-secret',
      TURSO_AUTH_TOKEN: 'write-secret' }, createClient: value => { configuration = value; return db; }, clock: () => new Date(NOW), log: value => logs.push(value) });
    assert.equal(configuration.authToken, 'read-only-secret'); assert.equal(db.closed, true);
    assert.equal(result.policy, null); assert.equal(result.policyHash, null); assert.deepEqual(result.fixtures, []);
    assert.equal(logs.length, 1); assert.equal(logs[0].eligible, 0); assert.equal(logs[0].readOnly, true);
    assert.doesNotMatch(JSON.stringify(logs), /secret|snapshot|origin-input|not-eligible/);
    assert.throws(() => parseArgs(['execute', ...argv.slice(1)]), /plan_only/);
    assert.throws(() => parseArgs([...argv, '--out', output]), /arguments_invalid/);
    const empty = database([]);
    const emptyPlan = await main(['plan', '--source-policy', source.policy.hash, '--day', '2026-10-31', '--out', join(directory, 'empty.json')], {
      client: empty, clock: () => new Date(NOW), log: () => {} });
    assert.equal(emptyPlan.fixtures.length, 0); assert.equal(empty.calls.length, 2); assert.equal(empty.closed, false);
    assert.ok(!Object.keys(require.cache).some(path => /[/\\]db[/\\]DatabaseService\.js$/.test(path)));
  } finally { removeTestDirectory(directory); }
});
