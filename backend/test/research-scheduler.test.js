const test = require('node:test');
const assert = require('node:assert/strict');
const {
  T15Scheduler, T15_EXECUTION_TOLERANCE_MS, t15TargetAt,
} = require('../dist/research/T15Scheduler.js');

const KICKOFF = '2026-10-27T19:45:00.000Z'; // 20:45 Europe/Rome.
const TARGET = '2026-10-27T19:30:00.000Z'; // 20:30 Europe/Rome.
const job = (id = 'match-1', kickoffAt = KICKOFF) => ({
  id, matchId: id, kickoffAt, targetAt: t15TargetAt(kickoffAt), leaseToken: `lease-${id}`,
});
const prepared = (entry, changes = {}) => ({
  job: entry, kickoffAt: entry.kickoffAt, status: 'upcoming',
  quotes: [{ capturedAt: TARGET, updatedAt: TARGET, bookmaker: 'Pinnacle', source: 'odds_api', odds: 1.9 }],
  inputSnapshot: { dataCutoff: TARGET, quoteSnapshotId: 'one-shared-snapshot' },
  decisions: [
    { family: 'A', modelVersion: 'a-v1', validated: true, marketState: 'SHADOW', score: .2, quoteIndex: 0, action: 'BET' },
    { family: 'C', modelVersion: 'c-v1', validated: true, marketState: 'SHADOW', score: .1, quoteIndex: 0, action: 'BET' },
  ],
  ...changes,
});

function harness(options = {}) {
  let now = new Date(options.now ?? TARGET);
  let entries = options.jobs ?? [job()];
  const commits = [], finishes = [], errors = [], syncs = [];
  const scheduler = new T15Scheduler({
    clock: () => new Date(now),
    synchronize: async (at) => { syncs.push(at); await options.synchronize?.(at); },
    claimDueJobs: async (at) => entries.filter((entry) => Date.parse(entry.targetAt) <= Date.parse(at)),
    prepare: async (entry, at) => options.prepare ? options.prepare(entry, at) : prepared(entry),
    commitBatch: async (batch, at, order) => {
      if (options.commit) await options.commit(batch, at, order);
      commits.push({ batch, at, order });
      entries = entries.filter((entry) => !batch.some((result) => result.job.id === entry.id));
    },
    finishJob: async (entry, outcome, at) => {
      finishes.push({ entry, outcome, at });
      if (outcome.status !== 'RETRY') entries = entries.filter((candidate) => candidate.id !== entry.id);
    },
    recordError: async (details) => errors.push(details),
  });
  return { scheduler, commits, finishes, errors, syncs, setNow: (value) => { now = new Date(value); } };
}

test('night maintenance time cannot create T-15 decisions; the same job runs exactly at its target', async () => {
  const h = harness({ now: '2026-10-27T02:00:00Z' }); // 03:00 Roma.
  assert.equal((await h.scheduler.tick()).claimed, 0);
  assert.equal(h.commits.length, 0);
  h.setNow(TARGET);
  const result = await h.scheduler.tick();
  assert.equal(result.completed, 1);
  assert.equal(h.commits[0].at, TARGET);
  assert.equal(h.commits[0].batch[0].decisions.filter((decision) => decision.action === 'BET').length, 2);
  assert.equal(h.commits[0].batch[0].inputSnapshot.quoteSnapshotId, 'one-shared-snapshot');
  assert.ok(Object.isFrozen(h.commits[0].batch[0].inputSnapshot));
  assert.equal((await h.scheduler.tick()).completed, 0);
});

test('the tolerance is explicitly 60 seconds and late executions are marked missed without catch-up', async () => {
  assert.equal(T15_EXECUTION_TOLERANCE_MS, 60000);
  const h = harness({ now: '2026-10-27T19:31:00.001Z' });
  assert.equal((await h.scheduler.tick()).missed, 1);
  assert.equal(h.commits.length, 0);
  assert.equal(h.finishes[0].outcome.reason, 'decision_window_missed');
  const afterKickoff = harness({ now: KICKOFF });
  await afterKickoff.scheduler.tick();
  assert.equal(afterKickoff.finishes[0].outcome.reason, 'match_started');
});

test('inference and provider access must finish within the decision window', async () => {
  const h = harness({ prepare: async (entry) => {
    h.setNow('2026-10-27T19:31:01Z');
    return prepared(entry);
  } });
  assert.equal((await h.scheduler.tick()).missed, 1);
  assert.equal(h.commits.length, 0);
});

test('preparation retries only while the window is open', async () => {
  let attempts = 0;
  const h = harness({ prepare: async (entry) => {
    if (++attempts === 1) throw new Error('provider temporarily unavailable');
    return prepared(entry);
  } });
  assert.equal((await h.scheduler.tick()).retried, 1);
  h.setNow('2026-10-27T19:30:15Z');
  assert.equal((await h.scheduler.tick()).completed, 1);
  assert.equal(h.commits.length, 1);
  assert.equal((await h.scheduler.tick()).completed, 0);
});

test('persistent odds policy denials are terminal skips with their safe reason and no noisy technical alert', async () => {
  for (const code of ['odds_cache_only', 'odds_credit_budget_exhausted', 'odds_reset_unconfirmed', 'odds_persistent_manager_required']) {
    const h = harness({ prepare: async () => { throw Object.assign(new Error('secret must not be persisted'), { code }); } });
    assert.equal((await h.scheduler.tick()).skipped, 1);
    assert.deepEqual(h.finishes[0].outcome, { status: 'SKIPPED', reason: code });
    assert.equal(h.commits.length, 0);
    assert.equal(h.errors.length, 0);
    assert.equal((await h.scheduler.tick()).claimed, 0);
  }
});

test('transient managed odds failures retry inside the window; unsafe codes are never persisted', async () => {
  for (const code of ['odds_request_inflight_timeout', 'odds_transport_failed', 'odds_lease_lost', 'odds_bad?apiKey=secret']) {
    const h = harness({ prepare: async () => { throw Object.assign(new Error('secret'), { code }); } });
    assert.equal((await h.scheduler.tick()).retried, 1);
    assert.equal(h.finishes[0].outcome.reason, code.includes('?') ? 'preparation_failed' : code);
    assert.equal(h.errors.length, 1);
    h.setNow('2026-10-27T19:31:01.000Z');
    assert.equal((await h.scheduler.tick()).missed, 1);
    assert.equal(h.commits.length, 0);
    assert.doesNotMatch(JSON.stringify(h.finishes), /secret/);
  }
});

test('concurrent ticks do not evaluate the same leased cohort in one process', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const h = harness({ prepare: async (entry) => { await waiting; return prepared(entry); } });
  const first = h.scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await h.scheduler.tick();
  assert.equal(second.busy, true);
  release();
  assert.equal((await first).completed, 1);
  assert.equal(h.commits.length, 1);
});

test('postponed, cancelled, started and unverified fixtures cannot produce bets', async () => {
  for (const status of ['postponed', 'cancelled', 'started', 'finished', 'unknown']) {
    const h = harness({ prepare: async (entry) => prepared(entry, { status }) });
    const summary = await h.scheduler.tick();
    assert.equal(status === 'unknown' ? summary.retried : summary.skipped, 1);
    assert.equal(h.commits.length, 0);
    assert.equal(h.finishes[0].outcome.reason, `fixture_${status}`);
  }
});

test('an unverified fixture can recover inside the same window but is never retried after sixty seconds', async () => {
  let verified = false;
  const h = harness({ prepare: async (entry) => prepared(entry, { status: verified ? 'upcoming' : 'unknown' }) });
  assert.equal((await h.scheduler.tick()).retried, 1);
  verified = true; h.setNow('2026-10-27T19:30:15.000Z');
  assert.equal((await h.scheduler.tick()).completed, 1);
  assert.equal(h.commits.length, 1);

  const expired = harness({ prepare: async (entry) => prepared(entry, { status: 'unknown' }) });
  assert.equal((await expired.scheduler.tick()).retried, 1);
  expired.setNow('2026-10-27T19:31:01.000Z');
  assert.equal((await expired.scheduler.tick()).missed, 1);
  assert.equal(expired.commits.length, 0);
});

test('a kickoff change requires rescheduling instead of using the old target', async () => {
  const h = harness({ prepare: async (entry) => prepared(entry, { kickoffAt: '2026-10-27T20:45:00Z' }) });
  assert.equal((await h.scheduler.tick()).retried, 1);
  assert.equal(h.finishes[0].outcome.reason, 'kickoff_changed');
  assert.equal(h.commits.length, 0);
});

test('UTC targets preserve the exact fifteen minute lead across daylight saving changes', () => {
  assert.equal(t15TargetAt('2026-03-29T03:15:00+02:00'), '2026-03-29T01:00:00.000Z');
  assert.equal(t15TargetAt('2026-10-25T02:15:00+02:00'), '2026-10-25T00:00:00.000Z');
  assert.equal(t15TargetAt('2026-10-25T02:15:00+01:00'), '2026-10-25T01:00:00.000Z');
});

test('only selected quotes are freshness-gated; stale or synthetic prices become explicit abstentions', async () => {
  const h = harness({ prepare: async (entry) => {
    const result = prepared(entry);
    result.quotes.push({ ...result.quotes[0], updatedAt: '2026-10-27T19:24:59Z' });
    result.decisions[0].quoteIndex = 1;
    return result;
  } });
  await h.scheduler.tick();
  assert.equal(h.commits[0].batch[0].decisions[0].action, 'ABSTAIN');
  assert.equal(h.commits[0].batch[0].decisions[0].reason, 'quote_stale');
  assert.equal(h.commits[0].batch[0].decisions[1].action, 'BET');
  for (const quoteChange of [
    { source: 'odds_api_plus_model_completion' },
    { capturedAt: '2026-10-27T19:30:01Z' },
    { updatedAt: null },
    { bookmaker: '' },
  ]) {
    const invalid = harness({ prepare: async (entry) => {
      const result = prepared(entry);
      Object.assign(result.quotes[0], quoteChange);
      return result;
    } });
    await invalid.scheduler.tick();
    assert.ok(invalid.commits[0].batch[0].decisions.every((decision) => decision.action === 'ABSTAIN'));
  }
});

test('experimental markets and missing C versions remain abstentions while valid A is independent', async () => {
  const h = harness({ prepare: async (entry) => {
    const result = prepared(entry);
    result.decisions[1].validated = false;
    result.decisions[1].modelVersion = '';
    return result;
  } });
  await h.scheduler.tick();
  assert.equal(h.commits[0].batch[0].decisions[0].action, 'BET');
  assert.equal(h.commits[0].batch[0].decisions[1].reason, 'model_not_validated');
  const experimental = harness({ prepare: async (entry) => {
    const result = prepared(entry);
    result.decisions[0].marketState = 'EXPERIMENTAL';
    return result;
  } });
  await experimental.scheduler.tick();
  assert.equal(experimental.commits[0].batch[0].decisions[0].reason, 'market_not_shadow_enabled');
});

test('simultaneous opportunities are allocated in deterministic independent portfolio order', async () => {
  const h = harness({ jobs: [job('z'), job('a')], prepare: async (entry) => {
    const result = prepared(entry);
    if (entry.matchId === 'z') {
      result.decisions[0].score = .9;
      result.decisions[1].score = .1;
    } else {
      result.decisions[0].score = .1;
      result.decisions[1].score = .9;
    }
    return result;
  } });
  await h.scheduler.tick();
  assert.equal(h.commits.length, 1);
  assert.deepEqual(h.commits[0].order.map(({ family, matchId }) => `${family}:${matchId}`), ['A:z', 'A:a', 'C:a', 'C:z']);
});

test('a quote expiring during preparation of its cohort is rechecked before commit', async () => {
  const h = harness({ prepare: async (entry) => {
    const result = prepared(entry);
    result.quotes[0].updatedAt = '2026-10-27T19:25:00.000Z';
    h.setNow('2026-10-27T19:30:15.000Z');
    return result;
  } });
  await h.scheduler.tick();
  assert.equal(h.commits[0].batch[0].decisions[0].reason, 'quote_stale');
});

test('duplicate model decisions cannot consume two stakes or silently choose a duplicate', async () => {
  const h = harness({ prepare: async (entry) => {
    const result = prepared(entry);
    result.decisions.push({ ...result.decisions[0], score: 1 });
    return result;
  } });
  await h.scheduler.tick();
  assert.equal(h.commits[0].batch[0].decisions.filter((decision) => decision.family === 'A').length, 1);
  assert.equal(h.commits[0].batch[0].decisions[0].action, 'ABSTAIN');
  assert.equal(h.commits[0].batch[0].decisions[0].reason, 'duplicate_family_decision');
  assert.equal(h.commits[0].order.filter((entry) => entry.family === 'A').length, 0);
});

test('timestamps require an explicit timezone; equivalent offsets do not change the kickoff', async () => {
  assert.throws(() => t15TargetAt('2026-10-27T20:45:00'), /Invalid kickoff/);
  const h = harness({ prepare: async (entry) => prepared(entry, { kickoffAt: '2026-10-27T20:45:00+01:00' }) });
  assert.equal((await h.scheduler.tick()).completed, 1);
});
