const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { settleGoalQuote } = require('../dist/research/GoalSettlement');

const START = '2026-10-29T02:12:00.000Z';
const END = '2026-10-30T02:00:00.000Z';
const KICKOFF = '2026-10-29T19:45:00.000Z';
const configuration = (family) => ({ version: 'probability-configuration-v1', family,
  baselineVersion: 'A-fixture', probabilityProtocol: 'joint-goal-coherent-v2', pipelineHashV2: '1'.repeat(64),
  mode: 'identity', temperature: 1, calibratorHash: '2'.repeat(64) });
const decisions = (overrides = {}) => ['A', 'C'].map((family) => ({ family, modelVersion: `${family}-fixture`,
  validated: true, market: '1x2', selection: 'homeWin', action: 'BET', marketState: 'EXPERIMENTAL',
  probabilityConfiguration: configuration(family), probabilityConfigurationHash: researchHash(configuration(family)),
  calibrationAvailableAt: '2026-10-28T00:00:00.000Z', calibrationPipelineHash: '1'.repeat(64),
  quote: { market: '1x2', selection: 'homeWin', side: 'home', odds: 2, source: 'odds_api',
    bookmaker: 'Fixture bookmaker', capturedAt: START, updatedAt: START, priceType: 'prematch' },
  probability: .6, ev: .2, prudentialEv: .1, score: .1, ...overrides }));

async function setup() {
  const path = join(tmpdir(), `research-nightly-${process.pid}-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  for (const file of ['015_research_platform.sql', '020_research_nightly.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', file), 'utf8'));
  }
  let time = Date.parse(START);
  const store = new ResearchStore(client, async () => {}, { now: () => new Date(time) });
  await store.initializePortfolios();
  for (const family of ['A', 'C']) {
    await store.saveModel({ family, version: `${family}-fixture`, artifact: { family, fixture: true } });
    for (const market of ['1x2', 'asian_handicap']) await store.setMarketState({ family, modelVersion: `${family}-fixture`, market, state: 'EXPERIMENTAL' });
  }
  return { path, client, store, setTime: (at) => { time = Date.parse(at); }, clock: () => new Date(time),
    close() { client.close(); for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(path + suffix, { force: true }); } catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
    } } };
}
const claim = (store, fixtures = [{ matchId: 'm1', kickoffAt: KICKOFF }], options = {}) => store.claimNightlyBatch({
  startedAt: START, windowEndAt: END, fixtures, ...options });
const input = (job, selected = decisions(), observedAt = START) => ({ jobId: job.id, leaseToken: job.leaseToken,
  inputSnapshot: { mode: 'NIGHTLY', runId: job.runId, windowStartAt: job.windowStartAt, observedAt,
    match: { matchId: job.matchId, competition: 'Serie_A', kickoffAt: job.kickoffAt, matchLabel: 'Fixture home - Fixture away' },
    forecast: { baselineVersion: 'A-fixture' }, quotes: selected.flatMap((decision) => decision.quote ? [decision.quote] : []) }, decisions: selected });

test('nightly admits technically eligible EXPERIMENTAL A/C using one snapshot and independent unchanged wallets', async () => {
  const f = await setup();
  try {
    const batch = await claim(f.store);
    assert.equal(batch.jobs[0].mode, 'NIGHTLY');
    const result = await f.store.commitDecisions(input(batch.jobs[0]));
    assert.equal(result.bets.length, 2);
    assert.deepEqual(result.bets.map((bet) => [bet.portfolioId, bet.stakeCents]), [['shadow_A', 1000], ['shadow_C', 1000]]);
    assert.equal(new Set(result.decisions.map((decision) => decision.inputHash)).size, 1);
    for (const bet of result.bets) {
      assert.equal(bet.snapshot.decisionMode, 'NIGHTLY');
      assert.equal(bet.snapshot.experimental, true);
      assert.equal(bet.snapshot.competition, 'Serie_A');
      assert.equal(bet.snapshot.quoteLeadTimeMs, Date.parse(KICKOFF) - Date.parse(START));
    }
    assert.deepEqual((await f.store.listMarkets()).map((market) => market.state), Array(4).fill('EXPERIMENTAL'));
    assert.equal((await f.store.getChampion('C')), null);
    await f.store.initializePortfolios();
    assert.deepEqual((await f.store.listPortfolios()).map((wallet) => [wallet.id, wallet.equityCents]), [['shadow_A', 100000], ['shadow_C', 100000]]);
  } finally { f.close(); }
});

test('two database clients share one nightly lease, while retries cannot duplicate decisions or ledger stakes', async () => {
  const f = await setup(); const second = createClient({ url: `file:${f.path}` });
  try {
    const other = new ResearchStore(second, async () => {}, { now: f.clock });
    const claims = await Promise.all([claim(f.store), claim(other)]);
    assert.equal(claims.filter((result) => result.busy).length, 1);
    const batch = claims.find((result) => !result.busy); const prepared = input(batch.jobs[0]);
    await f.store.commitDecisions(prepared);
    await other.commitDecisions(prepared);
    assert.equal((await f.store.listBets()).length, 2);
    assert.equal((await f.store.listDecisions()).length, 2);
    assert.equal((await f.store.listLedger()).filter((entry) => entry.event === 'STAKE').length, 2);
    await f.store.finishNightlyRun(batch.run.id, batch.run.leaseToken, { status: 'COMPLETED', summary: { registeredBets: 2 } });
    const retry = await claim(other);
    assert.equal(retry.alreadyCompleted, true);
    assert.equal(retry.jobs.length, 0);
    assert.equal((await f.store.listNightlyRuns())[0].summary.registeredBets, 2);
  } finally { second.close(); f.close(); }
});

test('lease expiry recovers a crashed nightly and rejects the stale owner before any write', async () => {
  const f = await setup();
  try {
    const first = await claim(f.store, undefined, { leaseMs: 1000 });
    f.setTime('2026-10-29T02:12:01.001Z');
    const recovered = await claim(f.store, undefined, { leaseMs: 1000 });
    assert.notEqual(recovered.run.leaseToken, first.run.leaseToken);
    await assert.rejects(f.store.commitDecisions(input(first.jobs[0])), /lease lost/);
    assert.equal((await f.store.listBets()).length, 0);
    assert.equal((await f.store.commitDecisions(input(recovered.jobs[0]))).bets.length, 2);
  } finally { f.close(); }
});

test('lease renewal extends both the batch and every claimed fixture without a T15 constraint', async () => {
  const f = await setup();
  try {
    const batch = await claim(f.store, undefined, { leaseMs: 1000 });
    f.setTime('2026-10-29T02:12:00.500Z');
    await f.store.renewNightlyLease(batch.run.id, batch.run.leaseToken, 30_000);
    f.setTime('2026-10-29T02:12:02.000Z');
    assert.equal((await f.store.commitDecisions(input(batch.jobs[0]))).bets.length, 2);
  } finally { f.close(); }
});

test('a failed run releases unfinished fixture leases for an immediate retry with the original execution start', async () => {
  const f = await setup();
  try {
    const first = await claim(f.store);
    await f.store.finishNightlyRun(first.run.id, first.run.leaseToken, { status: 'ERROR', summary: { errors: 1 } });
    f.setTime('2026-10-29T02:12:10.000Z');
    const retry = await claim(f.store, undefined, { startedAt: '2026-10-29T02:12:10.000Z' });
    assert.equal(retry.run.startedAt, START);
    assert.equal(retry.jobs.length, 1);
    assert.notEqual(retry.run.leaseToken, first.run.leaseToken);
    await assert.rejects(f.store.commitDecisions(input(first.jobs[0])), /lease lost/);
    assert.equal((await f.store.commitDecisions(input(retry.jobs[0]))).bets.length, 2);
  } finally { f.close(); }
});

test('delayed nightly skips started fixtures and never extends the configured endpoint', async () => {
  const f = await setup();
  try {
    const batch = await claim(f.store, [{ matchId: 'already-started', kickoffAt: START },
      { matchId: 'next-window', kickoffAt: new Date(Date.parse(END) + 1).toISOString() }, { matchId: 'm1', kickoffAt: KICKOFF }]);
    assert.deepEqual(batch.jobs.map((job) => job.matchId), ['m1']);
    assert.deepEqual(batch.skipped.map((skip) => skip.reason), ['match_started', 'outside_nightly_window']);
    f.setTime(KICKOFF);
    await assert.rejects(f.store.commitDecisions(input(batch.jobs[0])), /window closed|lease lost/);
    assert.equal((await f.store.listBets()).length, 0);
    assert.equal((await f.store.listDecisions()).length, 0);
  } finally { f.close(); }
});

test('a fixture exactly at the next nightly boundary is admitted today with prices observed before kickoff', async () => {
  const f = await setup();
  try {
    const batch = await claim(f.store, [{ matchId: 'exact-boundary', kickoffAt: END },
      { matchId: 'after-boundary', kickoffAt: new Date(Date.parse(END) + 1).toISOString() }]);
    assert.deepEqual(batch.jobs.map((job) => job.matchId), ['exact-boundary']);
    assert.deepEqual(batch.skipped, [{ matchId: 'after-boundary', reason: 'outside_nightly_window' }]);
    const result = await f.store.commitDecisions(input(batch.jobs[0]));
    assert.equal(result.bets.length, 2);
    assert.ok(result.bets.every((bet) => Date.parse(bet.placedAt) < Date.parse(END)
      && Date.parse(bet.snapshot.quote.capturedAt) < Date.parse(END)));
    assert.ok(result.bets.every((bet) => bet.snapshot.kickoffAt === END));
  } finally { f.close(); }
});

test('a future caller timestamp and retrospective shared input cannot bypass the authoritative clock', async () => {
  const f = await setup();
  try {
    await assert.rejects(claim(f.store, undefined, { startedAt: '2026-10-29T02:13:00.000Z' }), /Invalid nightly/);
    const batch = await claim(f.store);
    await assert.rejects(f.store.commitDecisions(input(batch.jobs[0], decisions(), '2026-10-29T02:11:59.000Z')), /predates execution/);
    assert.equal((await f.store.listBets()).length, 0);
  } finally { f.close(); }
});

test('nightly rechecks the official fixture in its write transaction after preparation', async () => {
  const f = await setup();
  try {
    await f.client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,home_goals INTEGER,away_goals INTEGER)');
    await f.client.execute({ sql: 'INSERT INTO matches VALUES (?,?,NULL,NULL)', args: ['m1', '2026-10-29T22:00:00.000Z'] });
    const batch = await claim(f.store);
    await assert.rejects(f.store.commitDecisions(input(batch.jobs[0])), /fixture changed/);
    assert.equal((await f.store.listBets()).length, 0);
    assert.equal((await f.store.listDecisions()).length, 0);
  } finally { f.close(); }
});

test('crossing kickoff during allocation rolls back decisions, bets and ledger as one transaction', async () => {
  const f = await setup();
  try {
    const batch = await claim(f.store);
    const original = f.client.transaction.bind(f.client);
    f.client.transaction = async (...args) => {
      const tx = await original(...args); const execute = tx.execute.bind(tx);
      tx.execute = async (statement) => {
        const result = await execute(statement);
        if (statement.sql?.includes('INSERT INTO research_decisions')) f.setTime(KICKOFF);
        return result;
      };
      return tx;
    };
    await assert.rejects(f.store.commitDecisions(input(batch.jobs[0])), /window closed|lease lost/);
    assert.equal((await f.store.listBets()).length, 0);
    assert.equal((await f.store.listDecisions()).length, 0);
    assert.equal((await f.store.listLedger()).length, 2);
  } finally { f.close(); }
});

test('nightly deterministic prudential EV ranking caps each wallet at 5 percent independently', async () => {
  const f = await setup();
  try {
    const batch = await claim(f.store, Array.from({ length: 6 }, (_, i) => ({ matchId: `m${i}`, kickoffAt: KICKOFF })));
    const prepared = batch.jobs.map((job, i) => input(job, decisions({ score: 100 - i }).map((decision) => ({ ...decision,
      prudentialEv: decision.family === 'A' ? .02 + i * .01 : .08 - i * .01 }))));
    const result = await f.store.commitBatch(prepared.reverse());
    assert.deepEqual(result.bets.filter((bet) => bet.family === 'A').map((bet) => bet.matchId), ['m5', 'm4', 'm3', 'm2', 'm1']);
    assert.deepEqual(result.bets.filter((bet) => bet.family === 'C').map((bet) => bet.matchId), ['m0', 'm1', 'm2', 'm3', 'm4']);
    assert.equal(result.decisions.filter((decision) => decision.reason === 'virtual_exposure_limit').length, 2);
    for (const wallet of await f.store.listPortfolios()) assert.deepEqual([wallet.availableCents, wallet.committedCents], [95000, 5000]);
  } finally { f.close(); }
});

test('fresh real quotes, supported settlement and unsuspended markets remain mandatory', async () => {
  for (const scenario of ['stale', 'synthetic', 'suspended', 'unsupported', 'mismatch', 'configuration', 'calibration', 'future_quote']) {
    const f = await setup();
    try {
      const batch = await claim(f.store); const selected = decisions();
      for (const decision of selected) {
        if (scenario === 'stale') decision.quote.updatedAt = '2026-10-29T02:06:59.000Z';
        if (scenario === 'synthetic') decision.quote.source = 'odds_api_plus_model_completion';
        if (scenario === 'unsupported') decision.quote.market = decision.market = 'corners';
        if (scenario === 'mismatch') decision.quote.selection = 'awayWin';
        if (scenario === 'configuration') decision.probabilityConfigurationHash = '3'.repeat(64);
        if (scenario === 'calibration') decision.calibrationAvailableAt = '2026-10-29T03:00:00.000Z';
        if (scenario === 'future_quote') {
          f.setTime('2026-10-29T02:14:00.000Z');
          decision.quote.capturedAt = decision.quote.updatedAt = '2026-10-29T02:13:00.000Z';
        }
        if (scenario === 'suspended') await f.store.setMarketState({ family: decision.family, modelVersion: decision.modelVersion, market: '1x2', state: 'SUSPENDED' });
      }
      const result = await f.store.commitDecisions(input(batch.jobs[0], selected));
      assert.equal(result.bets.length, 0, scenario);
      assert.equal(result.decisions.length, 2, scenario);
    } finally { f.close(); }
  }
});

test('nightly policy is immutable across retries and explicit configured EV/freshness gates are enforced', async () => {
  const f = await setup();
  try {
    const batch = await claim(f.store, undefined, { minEv: .25, minPrudentialEv: .15, quoteMaxAgeMs: 1000 });
    await assert.rejects(claim(f.store), /policy is immutable/);
    const result = await f.store.commitDecisions(input(batch.jobs[0]));
    assert.equal(result.bets.length, 0);
    assert.ok(result.decisions.every((decision) => decision.reason === 'prudential_value_threshold_required'));
  } finally { f.close(); }
});

test('nightly shares existing job identity and T15 claim cannot pick its pending retry', async () => {
  const f = await setup();
  try {
    await f.store.syncJobs([{ matchId: 'm1', kickoffAt: KICKOFF }]);
    const original = (await f.store.listJobs())[0];
    const batch = await claim(f.store);
    assert.equal(batch.jobs[0].id, original.id);
    await assert.rejects(f.store.commitDecisions(input(batch.jobs[0], decisions({ portfolioId: 'main' }))), /both A and C|independent virtual/);
    await f.store.finishJob(original.id, batch.run.leaseToken, { status: 'RETRY', reason: 'temporary_error' });
    await f.store.syncJobs([{ matchId: 'm1', kickoffAt: '2026-10-29T22:00:00.000Z' }]);
    assert.equal((await f.store.listJobs())[0].kickoffAt, KICKOFF);
    assert.deepEqual(await f.store.claimDueJobs(START), []);
  } finally { f.close(); }
});

test('nightly half-win, half-loss and refund settlements are idempotent with no negative balance', async () => {
  for (const [line, home, away, expected] of [[-.25, 0, 0, .5], [.25, 0, 0, 1.5], [0, 0, 0, 1]]) {
    const f = await setup();
    try {
      const batch = await claim(f.store);
      const selected = decisions().map((decision) => ({ ...decision, market: 'asian_handicap', selection: `ahcp_${line}`,
        quote: { ...decision.quote, market: 'asian_handicap', selection: `ahcp_${line}`, side: 'home', line } }));
      const result = await f.store.commitDecisions(input(batch.jobs[0], selected));
      assert.equal(result.bets.length, 2);
      for (const bet of result.bets) {
        const settled = settleGoalQuote(bet.snapshot.quote, home, away);
        assert.equal(settled.returnMultiplier, expected);
        const evidence = { homeGoals: home, awayGoals: away, source: 'fixture', status: settled.status };
        await f.store.settleBet(bet.id, expected, evidence);
        assert.equal((await f.store.settleBet(bet.id, expected, evidence)).settled, false);
      }
      for (const wallet of await f.store.listPortfolios()) assert.deepEqual([wallet.availableCents, wallet.committedCents], [99000 + 1000 * expected, 0]);
    } finally { f.close(); }
  }
});

test('migration 020 is additive and repeatable without rewriting existing portfolio history', async () => {
  const f = await setup();
  try {
    const before = await f.store.listLedger();
    await f.client.executeMultiple(readFileSync(join(__dirname, '../migrations/020_research_nightly.sql'), 'utf8'));
    assert.deepEqual(await f.store.listLedger(), before);
    assert.equal((await f.client.execute('PRAGMA integrity_check')).rows[0].integrity_check, 'ok');
    assert.equal((await f.client.execute('PRAGMA foreign_key_check')).rows.length, 0);
  } finally { f.close(); }
});

test('persisted nightly metrics recover partial completion, retries and lost responses without counting attempts', async () => {
  const f = await setup();
  try {
    const batch = await claim(f.store, ['m1', 'm2', 'm3'].map((matchId) => ({ matchId, kickoffAt: KICKOFF })));
    const firstInput = input(batch.jobs[0], decisions().map((decision) => decision.family === 'C'
      ? { ...decision, action: 'ABSTAIN', reason: 'fixture_no_value' } : decision));
    await f.store.commitDecisions(firstInput);
    await f.store.finishJob(batch.jobs[1].id, batch.run.leaseToken, { status: 'RETRY', reason: 'temporary_provider_error' });
    await f.store.commitDecisions(input(batch.jobs[2], decisions({ action: 'ABSTAIN', reason: 'fixture_no_value' })));
    await f.store.finishNightlyRun(batch.run.id, batch.run.leaseToken, { status: 'ERROR', summary: { errors: 1 } });
    assert.deepEqual(await f.store.getNightlyRunMetrics(batch.run.id), { analyzedMatches: 2, registeredBets: 1,
      abstainedMatches: 1, reasonCounts: { fixture_no_value: 3 } });
    const retry = await claim(f.store, ['m1', 'm2', 'm3'].map((matchId) => ({ matchId, kickoffAt: KICKOFF })));
    assert.deepEqual(retry.jobs.map((job) => job.matchId), ['m2']);
    const secondInput = input(retry.jobs[0]);
    await f.store.commitDecisions(secondInput);
    await f.store.commitDecisions(secondInput); // Retry after an unconfirmed successful response.
    const execute = f.client.execute.bind(f.client); const statements = [];
    f.client.execute = async (statement) => { statements.push(typeof statement === 'string' ? statement : statement.sql); return execute(statement); };
    assert.deepEqual(await f.store.getNightlyRunMetrics(batch.run.id), { analyzedMatches: 3, registeredBets: 3,
      abstainedMatches: 1, reasonCounts: { fixture_no_value: 3 } });
    assert.equal(statements.length, 1);
    assert.ok(statements.every((statement) => /^(?:WITH|SELECT)\b/.test(statement.trim())));
    assert.deepEqual(await f.store.getNightlyRunMetrics('unknown-run'), { analyzedMatches: 0, registeredBets: 0, abstainedMatches: 0, reasonCounts: {} });
    assert.equal((await f.store.listBets()).length, 3);
    assert.equal((await f.store.listLedger()).filter((entry) => entry.event === 'STAKE').length, 3);
    statements.length = 0;
    const readOnlyStore = new ResearchStore(f.client, async () => {}, { now: f.clock });
    assert.equal((await readOnlyStore.getNightlyRunMetrics(batch.run.id)).registeredBets, 3);
    assert.equal((await readOnlyStore.listNightlyRuns()).length, 1);
    assert.equal(statements.length, 3); // One schema lookup, one metrics query, one run-list query.
    assert.ok(statements.every((statement) => /^(?:WITH|SELECT)\b/.test(statement.trim())));
    statements.length = 0;
    const storedRun = await readOnlyStore.getNightlyRun(batch.run.id);
    assert.equal(storedRun.id, batch.run.id);
    assert.equal(storedRun.startedAt, START);
    assert.equal(storedRun.windowEndAt, END);
    assert.equal(statements.length, 1);
    assert.match(statements[0], /^SELECT\b/);
    assert.equal(await readOnlyStore.getNightlyRun('unknown-run'), null);
    assert.equal(statements.length, 2);
    assert.ok(statements.every((statement) => /^SELECT\b/.test(statement)));
  } finally { f.close(); }
});
