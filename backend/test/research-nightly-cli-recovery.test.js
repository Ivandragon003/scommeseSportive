const test = require('node:test');
const assert = require('node:assert/strict');
const { runNightly, recoveryPlanFor } = require('../scripts/research-nightly');
const { researchHash } = require('../dist/research/ResearchStore');
const { VIRTUAL_RECOMMENDATION_POLICY } = require('../dist/research/ResearchRecommendationPolicy');

const NOW = '2026-10-31T08:00:00.000Z';
const sourcePolicyHash = researchHash(VIRTUAL_RECOMMENDATION_POLICY);
const recoveryEnv = () => ({ RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED: 'true', RESEARCH_NIGHTLY_RECOVER_TECHNICAL: 'true',
  RESEARCH_NIGHTLY_RECOVERY_SOURCE_POLICY: sourcePolicyHash, RESEARCH_NIGHTLY_RECOVERY_DAY: '2026-10-31',
  RESEARCH_T15_SCHEDULER_ENABLED: 'false', TURSO_DATABASE_URL: 'libsql://synthetic-read-only.invalid',
  TURSO_WATCHDOG_READONLY_TOKEN: 'synthetic-watchdog-token', TURSO_AUTH_TOKEN: 'synthetic-fallback-token' });
const forbidden = () => assert.fail('Unexpected application initialization, provider access or database write');
const guardedOptions = env => ({ env, policy: { enabled: true }, clock: () => new Date(NOW),
  clientFactory: forbidden, get db() { return forbidden(); }, log: forbidden });
function injectedPlan() {
  const policy = { ...VIRTUAL_RECOMMENDATION_POLICY, recovery: { fixtureOnly: true } };
  return { parentPolicyHash: sourcePolicyHash, policy, policyHash: researchHash(policy),
    fixtures: [{ matchId: 'synthetic-fixture', kickoffAt: '2026-10-31T17:00:00.000Z' }] };
}
function emptyReadOnlyClient() {
  const calls = [];
  return { calls, closed: false, async execute(statement) {
    assert.match(statement.sql, /^\s*SELECT\b/i);
    assert.doesNotMatch(statement.sql, /;|\b(?:INSERT|UPDATE|DELETE|PRAGMA|CREATE|ALTER)\b/i);
    calls.push(statement);
    if (statement.sql.includes('FROM research_execution_policies')) return { rows: [{ hash: sourcePolicyHash,
      version: VIRTUAL_RECOMMENDATION_POLICY.version, descriptor_json: JSON.stringify(VIRTUAL_RECOMMENDATION_POLICY) }] };
    assert.match(statement.sql, /FROM matches m JOIN research_execution_jobs/);
    return { rows: [] };
  }, close() { this.closed = true; }, ready: forbidden, transaction: forbidden, executeMultiple: forbidden };
}

test('CLI recovery defaults off and preserves the disabled Nightly summary without accessing a client or clock', async () => {
  for (const env of [{}, { RESEARCH_NIGHTLY_RECOVER_TECHNICAL: 'false' }]) {
    assert.equal(await recoveryPlanFor(env, { clientFactory: forbidden, clock: forbidden }), undefined);
    const output = [];
    const result = await runNightly({ env, policy: { enabled: false }, clock: forbidden,
      clientFactory: forbidden, get db() { return forbidden(); }, log: value => output.push(value) });
    assert.deepEqual(result, { mode: 'NIGHTLY', enabled: false, reason: 'nightly_disabled' });
    assert.deepEqual(output, [result]);
  }
});

test('invalid recovery flags, source hashes and calendar days fail before application database access', async () => {
  for (const flag of ['', 'TRUE', 'yes', '1', true, 1]) {
    await assert.rejects(runNightly(guardedOptions({ ...recoveryEnv(), RESEARCH_NIGHTLY_RECOVER_TECHNICAL: flag })),
      /Invalid RESEARCH_NIGHTLY_RECOVER_TECHNICAL/);
  }
  for (const value of [undefined, '', 'not-a-hash', 'a'.repeat(63), 'g'.repeat(64)]) {
    await assert.rejects(runNightly(guardedOptions({ ...recoveryEnv(), RESEARCH_NIGHTLY_RECOVERY_SOURCE_POLICY: value })),
      /Invalid RESEARCH_NIGHTLY_RECOVERY_SOURCE_POLICY/);
  }
  for (const value of [null, true, 20261031, {}, '2026-02-30', '31-10-2026', '2026-10-31T00:00:00Z']) {
    await assert.rejects(runNightly(guardedOptions({ ...recoveryEnv(), RESEARCH_NIGHTLY_RECOVERY_DAY: value })), /day_invalid/);
  }
});

test('recovery requires enabled versioned Nightly execution and cannot overlap T15 or bypass its flag', async () => {
  for (const flag of [undefined, 'false']) {
    await assert.rejects(runNightly(guardedOptions({ ...recoveryEnv(), RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED: flag })),
      /requires_enabled_recommendations/);
  }
  const disabled = guardedOptions(recoveryEnv()); disabled.policy.enabled = false;
  await assert.rejects(runNightly(disabled), /requires_enabled_recommendations/);
  await assert.rejects(runNightly(guardedOptions({ ...recoveryEnv(), RESEARCH_T15_SCHEDULER_ENABLED: 'true' })), /Conflicting/);
  const previousT15 = process.env.RESEARCH_T15_SCHEDULER_ENABLED;
  try {
    process.env.RESEARCH_T15_SCHEDULER_ENABLED = 'true';
    await assert.rejects(runNightly(guardedOptions(recoveryEnv())), /Conflicting/);
  } finally {
    if (previousT15 === undefined) delete process.env.RESEARCH_T15_SCHEDULER_ENABLED;
    else process.env.RESEARCH_T15_SCHEDULER_ENABLED = previousT15;
  }
  const unflagged = guardedOptions({ ...recoveryEnv(), RESEARCH_NIGHTLY_RECOVER_TECHNICAL: 'false' });
  Object.defineProperty(unflagged, 'technicalRecovery', { value: injectedPlan() });
  await assert.rejects(runNightly(unflagged), /flag_required/);
});

test('an internal recovery plan passes unchanged to versioned execution and only the existing summary is printed', async t => {
  const execution = require('../dist/research/ResearchRecommendationNightly');
  const plan = injectedPlan(), db = { close: forbidden }, summary = { enabled: true, registeredBets: 0, errors: 0 }, output = [];
  let calls = 0;
  t.mock.method(execution, 'runRecommendationNightly', async (actualDb, options) => {
    calls++; assert.equal(actualDb, db); assert.equal(options.technicalRecovery, plan);
    assert.equal(options.policy.enabled, true); assert.equal(options.runId, 'synthetic-cli-recovery'); return summary;
  });
  const result = await runNightly({ env: recoveryEnv(), policy: { enabled: true }, clock: () => new Date(NOW),
    technicalRecovery: plan, clientFactory: forbidden, db, runId: 'synthetic-cli-recovery', log: value => output.push(value) });
  assert.equal(calls, 1); assert.equal(result, summary); assert.deepEqual(output, [summary]);
});

test('empty recovery evidence uses bounded SELECTs and closes the separate client before failing without application writes', async () => {
  for (const watchdog of ['synthetic-watchdog-token', '']) {
    const client = emptyReadOnlyClient(), options = guardedOptions({ ...recoveryEnv(), TURSO_WATCHDOG_READONLY_TOKEN: watchdog });
    options.clientFactory = configuration => {
      assert.deepEqual(configuration, { url: 'libsql://synthetic-read-only.invalid',
        authToken: watchdog || 'synthetic-fallback-token' }); return client;
    };
    await assert.rejects(runNightly(options), /no_eligible_fixtures/);
    assert.equal(client.closed, true); assert.equal(client.calls.length, 2);
    assert.deepEqual(client.calls[1].args, [sourcePolicyHash, '2026-10-30T23:00:00.000Z', '2026-10-31T23:00:00.000Z']);
  }
});

test('an omitted recovery day uses the current Rome calendar day rather than the UTC day', async () => {
  const env = recoveryEnv(); delete env.RESEARCH_NIGHTLY_RECOVERY_DAY;
  const client = emptyReadOnlyClient();
  await assert.rejects(recoveryPlanFor(env, { clock: () => new Date('2026-10-30T23:30:00.000Z'), clientFactory: () => client }),
    /no_eligible_fixtures/);
  assert.deepEqual(client.calls[1].args, [sourcePolicyHash, '2026-10-30T23:00:00.000Z', '2026-10-31T23:00:00.000Z']);
  assert.equal(client.closed, true);
});

test('blank optional workflow recovery days mean today in Rome, including whitespace', async () => {
  for (const day of ['', '  ', '\n\t']) {
    const client = emptyReadOnlyClient();
    await assert.rejects(recoveryPlanFor({ ...recoveryEnv(), RESEARCH_NIGHTLY_RECOVERY_DAY: day }, {
      clock: () => new Date('2026-10-30T23:30:00.000Z'), clientFactory: () => client }), /no_eligible_fixtures/);
    assert.deepEqual(client.calls[1].args, [sourcePolicyHash, '2026-10-30T23:00:00.000Z', '2026-10-31T23:00:00.000Z']);
    assert.equal(client.closed, true);
  }
});

test('source-read failures still close the read-only client and missing credentials cannot open it', async () => {
  const client = { closed: false, async execute(statement) { assert.match(statement.sql, /^SELECT/); throw new Error('synthetic_read_failure'); },
    close() { this.closed = true; } };
  const options = guardedOptions(recoveryEnv()); options.clientFactory = () => client;
  await assert.rejects(runNightly(options), /synthetic_read_failure/); assert.equal(client.closed, true);
  for (const change of [{ TURSO_DATABASE_URL: '' }, { TURSO_WATCHDOG_READONLY_TOKEN: '', TURSO_AUTH_TOKEN: '' }]) {
    await assert.rejects(runNightly(guardedOptions({ ...recoveryEnv(), ...change })), /credentials_missing/);
  }
});

test('internal plans with no eligible fixture or another parent policy are rejected before application writes', async () => {
  const plan = injectedPlan();
  for (const invalid of [null, { ...plan, policy: null }, { ...plan, fixtures: [] },
    { ...plan, parentPolicyHash: 'b'.repeat(64) }, { ...plan, policyHash: 'invalid' }]) {
    const options = guardedOptions(recoveryEnv()); Object.defineProperty(options, 'technicalRecovery', { value: invalid });
    await assert.rejects(runNightly(options), /no_eligible_fixtures|policy_mismatch/);
  }
});
