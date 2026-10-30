const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { ResearchRecommendationStore, VIRTUAL_RECOMMENDATION_POLICY } = require('../dist/research/ResearchRecommendationStore');

const START = '2026-10-30T12:30:00.000Z';
const KICKOFF = '2026-10-30T19:00:00.000Z';
const END = '2026-10-31T02:07:00.000Z';
const RUN = 'execution:isolated-fixture-run';
const ORIGIN_RUN = 'nightly:isolated-origin-run';
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
const configuration = family => ({ version: 'fixture-probability-configuration', family,
  sourceVersion: family === 'A' ? 'A-app-fixture' : 'C-fixture', probabilityProtocol: 'fixture-protocol' });

async function originalRecords(client) {
  return json({ inputs: (await client.execute('SELECT * FROM research_inputs ORDER BY id')).rows,
    decisions: (await client.execute('SELECT * FROM research_decisions ORDER BY id')).rows });
}

async function setup(options = {}) {
  const path = join(tmpdir(), `research-execution-${process.pid}-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  for (const migration of ['015_research_platform.sql', '020_research_nightly.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
  }
  await client.execute(`CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT NOT NULL,home_goals INTEGER,away_goals INTEGER)`);
  let time = Date.parse(START);
  const clock = () => new Date(time), research = new ResearchStore(client, async () => {}, { now: clock });
  await research.initializePortfolios();
  for (const [family, version] of [['A', 'A-origin-fixture'], ['A', 'A-app-fixture'], ['C', 'C-fixture']]) {
    await research.saveModel({ family, version, artifact: { family, version, fixtureOnly: true } });
    await research.setMarketState({ family, modelVersion: version, market: '1x2', state: 'EXPERIMENTAL' });
  }
  await client.execute({ sql: `INSERT INTO research_nightly_runs
    (id,started_at,window_end_at,status,lease_token,lease_expires_at,quote_max_age_ms,min_ev,min_prudential_ev,summary_json,ended_at,updated_at)
    VALUES (?,?,?,'COMPLETED',?,?,300000,.04,.01,'{}',?,?)`,
  args: [ORIGIN_RUN, START, END, 'origin-token', END, START, START] });
  const fixtures = [];
  for (let index = 0; index < (options.matches ?? 5); index++) {
    const matchId = `execution-match-${index}`, jobId = `origin-job-${index}`, inputId = `origin-input-${index}`;
    fixtures.push({ matchId, kickoffAt: KICKOFF });
    await client.execute({ sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL)', args: [matchId, KICKOFF] });
    await client.execute({ sql: `INSERT INTO research_jobs
      (id,match_id,kickoff_at,target_at,status,created_at,updated_at) VALUES (?,?,?,?,'COMPLETED',?,?)`,
    args: [jobId, matchId, KICKOFF, START, START, START] });
    const snapshot = { fixtureOnly: true, matchId, observedAt: START, reason: 'original immutable diagnostic abstention' };
    await client.execute({ sql: 'INSERT INTO research_inputs VALUES(?,?,?,?,?,?)',
      args: [inputId, jobId, researchHash(snapshot), json(snapshot), START, KICKOFF] });
    await client.execute({ sql: 'INSERT INTO research_nightly_jobs VALUES(?,?,?,?)', args: [jobId, ORIGIN_RUN, START, END] });
    for (const family of ['A', 'C']) {
      await client.execute({ sql: `INSERT INTO research_decisions
        (id,job_id,input_id,family,model_version,market,selection,portfolio_id,action,reason,snapshot_json,created_at)
        VALUES (?,?,?,?,?,'',NULL,?,'ABSTAIN','insufficient_validation_calibration',?,?)`,
      args: [`origin-decision-${index}-${family}`, jobId, inputId, family, family === 'A' ? 'A-origin-fixture' : 'C-fixture',
        `shadow_${family}`, json({ original: true, prudentialSamplesAvailable: 0 }), START] });
    }
  }
  const originalBeforeMigration = await originalRecords(client);
  if (!options.deferExecutionMigration) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations/023_research_recommendation_execution.sql'), 'utf8'));
  }
  const execution = new ResearchRecommendationStore(client, async () => {}, { now: clock, research });
  const policy = options.deferExecutionMigration ? null : await execution.registerPolicy();
  return { path, client, research, execution, policy, fixtures, originalBeforeMigration, clock,
    setTime(value) { time = Date.parse(value); },
    async close() {
      client.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(path + suffix, { force: true }); }
        catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
      }
    } };
}

function claim(f, fixtures = f.fixtures, options = {}, execution = f.execution) {
  return execution.claimBatch({ policyHash: f.policy.hash, runId: RUN, windowStartAt: START, windowEndAt: END,
    fixtures, ...options });
}

function prepared(f, job, options = {}) {
  const observedAt = f.clock().toISOString();
  const quote = { market: '1x2', selection: 'homeWin', side: 'home', odds: 2, source: 'odds_api',
    bookmaker: 'Isolated fixture bookmaker', priceType: 'prematch', capturedAt: observedAt, updatedAt: observedAt,
    ...(options.quote ?? {}) };
  const decisions = ['A', 'C'].map(family => ({ family,
    modelVersion: family === 'A' ? 'A-app-fixture' : 'C-fixture', originDecisionId: job.originDecisionIds[family],
    action: 'BET', market: '1x2', selection: 'homeWin', recommended: true, validated: true,
    quote: { ...quote }, probability: .6, ev: .6 * quote.odds - 1,
    suggestedStakePercent: family === 'A' ? 1.53 : 9, confidence: 'MEDIUM',
    probabilityConfiguration: configuration(family), probabilityConfigurationHash: researchHash(configuration(family)),
    ...(options.decisions?.[family] ?? {}) }));
  return { jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
    inputSnapshot: { observedAt, mode: 'VIRTUAL_RECOMMENDATION', runId: job.runId, policyHash: job.policyHash,
      match: { matchId: job.matchId, kickoffAt: job.kickoffAt }, quotes: [quote], ...(options.snapshot ?? {}) }, decisions };
}

const walletAmounts = async research => (await research.listPortfolios())
  .map(wallet => [wallet.id, wallet.availableCents, wallet.committedCents, wallet.equityCents]);
const count = async (client, table) => Number((await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);

test('migration and five versioned abstentions preserve ten original immutable decisions without resetting wallets', async () => {
  const f = await setup();
  try {
    assert.equal(await originalRecords(f.client), f.originalBeforeMigration);
    const batch = await claim(f);
    assert.equal(batch.jobs.length, 5);
    const commits = batch.jobs.map(job => prepared(f, job, { decisions: {
      A: { action: 'ABSTAIN', reason: 'no_positive_recommendation' }, C: { action: 'ABSTAIN', reason: 'no_positive_recommendation' },
    } }));
    const result = await f.execution.commitBatch(commits);
    assert.equal(result.decisions.length, 10);
    assert.equal(result.bets.length, 0);
    assert.equal(await originalRecords(f.client), f.originalBeforeMigration);
    assert.equal(await count(f.client, 'research_decisions'), 10);
    assert.equal(await count(f.client, 'research_execution_inputs'), 5);
    assert.equal(await count(f.client, 'research_execution_decisions'), 10);
    assert.deepEqual(await walletAmounts(f.research), [['shadow_A', 100000, 0, 100000], ['shadow_C', 100000, 0, 100000]]);
    await assert.rejects(f.client.execute("UPDATE research_decisions SET reason='overwritten'"), /immutable/i);
    await assert.rejects(f.client.execute('DELETE FROM research_execution_decisions'), /immutable/i);
    assert.equal((await claim(f)).jobs.length, 0);
    assert.equal(await count(f.client, 'research_execution_decisions'), 10);
  } finally { await f.close(); }
});

test('policy registration is content-addressed and its recorded descriptor cannot be overwritten', async () => {
  const f = await setup({ matches: 1 });
  try {
    const duplicate = await f.execution.registerPolicy({ ...VIRTUAL_RECOMMENDATION_POLICY });
    assert.equal(duplicate.hash, f.policy.hash);
    assert.equal(await count(f.client, 'research_execution_policies'), 1);
    const changed = await f.execution.registerPolicy({ ...VIRTUAL_RECOMMENDATION_POLICY, version: 'virtual-recommendation-v2' });
    assert.notEqual(changed.hash, f.policy.hash);
    await assert.rejects(f.client.execute("UPDATE research_execution_policies SET descriptor_json='{}'"), /immutable/i);
    await assert.rejects(f.client.execute('DELETE FROM research_execution_policies'), /immutable/i);
  } finally { await f.close(); }
});

test('A reserves the exact 1.53 percent advice while C reserves one percent with explicit execution provenance', async () => {
  const f = await setup({ matches: 1 });
  try {
    const batch = await claim(f), result = await f.execution.commitBatch([prepared(f, batch.jobs[0])]);
    assert.equal(result.bets.length, 2);
    assert.deepEqual(result.bets.map(bet => [bet.family, bet.stakeCents]).sort(), [['A', 1530], ['C', 1000]]);
    assert.deepEqual(await walletAmounts(f.research), [['shadow_A', 98470, 1530, 100000], ['shadow_C', 99000, 1000, 100000]]);
    const bets = await f.research.listBets();
    for (const bet of bets) {
      assert.ok(bet.executionDecisionId);
      assert.equal(bet.snapshot.originDecisionId, `origin-decision-0-${bet.family}`);
      assert.equal(bet.snapshot.effectiveExecutionDecisionId, bet.executionDecisionId);
      assert.equal(bet.decisionId, `origin-decision-0-${bet.family}`);
      assert.equal(bet.modelVersion, bet.family === 'A' ? 'A-app-fixture' : 'C-fixture');
    }
    assert.equal((await f.research.getNightlyRunMetrics(ORIGIN_RUN)).registeredBets, 0);
    assert.equal((await f.execution.getRunMetrics(RUN, f.policy.hash)).registeredBets, 2);
    assert.equal(await originalRecords(f.client), f.originalBeforeMigration);
  } finally { await f.close(); }
});

test('two clients claim one policy job and retry the same commit without a second stake or preparation', async () => {
  const f = await setup({ matches: 1 }), second = createClient({ url: `file:${f.path}` });
  try {
    const otherResearch = new ResearchStore(second, async () => {}, { now: f.clock });
    const other = new ResearchRecommendationStore(second, async () => {}, { now: f.clock, research: otherResearch });
    const batches = await Promise.all([claim(f), claim(f, f.fixtures, {}, other)]);
    assert.equal(batches.flatMap(batch => batch.jobs).length, 1);
    const job = batches.flatMap(batch => batch.jobs)[0], commit = prepared(f, job);
    await Promise.all([f.execution.commitBatch([commit]), other.commitBatch([commit])]);
    assert.equal(await count(f.client, 'research_execution_inputs'), 1);
    assert.equal(await count(f.client, 'research_execution_decisions'), 2);
    assert.equal(await count(f.client, 'research_bets'), 2);
    assert.equal((await f.research.listLedger()).filter(event => event.event === 'STAKE').length, 2);
    let preparations = 0;
    const retry = await claim(f);
    for (const candidate of retry.jobs) { preparations++; prepared(f, candidate); }
    assert.equal(preparations, 0);
    const altered = { ...commit, inputSnapshot: { ...commit.inputSnapshot, changed: true } };
    await assert.rejects(f.execution.commitBatch([altered]), /immutable|input|replay/i);
  } finally { second.close(); await f.close(); }
});

test('expired policy lease is recoverable and the stale owner cannot commit', async () => {
  const f = await setup({ matches: 1 });
  try {
    const first = (await claim(f, f.fixtures, { leaseMs: 1000 })).jobs[0];
    f.setTime('2026-10-30T12:30:01.001Z');
    const recovered = (await claim(f, f.fixtures, { leaseMs: 30000 })).jobs[0];
    assert.ok(recovered);
    assert.notEqual(recovered.leaseToken, first.leaseToken);
    await assert.rejects(f.execution.commitBatch([prepared(f, first)]), /lease/i);
    assert.equal(await count(f.client, 'research_bets'), 0);
    assert.equal((await f.execution.commitBatch([prepared(f, recovered)])).bets.length, 2);
  } finally { await f.close(); }
});

test('a different policy cannot create a second bet for the same portfolio and match', async () => {
  const f = await setup({ matches: 1 });
  try {
    const first = await claim(f);
    await f.execution.commitBatch([prepared(f, first.jobs[0])]);
    const policy = await f.execution.registerPolicy({ ...VIRTUAL_RECOMMENDATION_POLICY, version: 'virtual-recommendation-v2' });
    const second = await claim(f, f.fixtures, { policyHash: policy.hash, runId: RUN + ':v2' });
    if (second.jobs.length) await f.execution.commitBatch(second.jobs.map(job => prepared(f, job)));
    assert.equal(await count(f.client, 'research_bets'), 2);
    assert.equal((await f.research.listLedger()).filter(event => event.event === 'STAKE').length, 2);
    assert.deepEqual(await walletAmounts(f.research), [['shadow_A', 98470, 1530, 100000], ['shadow_C', 99000, 1000, 100000]]);
  } finally { await f.close(); }
});

test('five percent aggregate exposure rejects an exact advice rather than silently shrinking it', async () => {
  const f = await setup({ matches: 2 });
  try {
    const batch = await claim(f);
    const result = await f.execution.commitBatch(batch.jobs.map(job => prepared(f, job, { decisions: { A: { suggestedStakePercent: 3 } } })));
    const aBets = result.bets.filter(bet => bet.family === 'A');
    assert.equal(aBets.length, 1);
    assert.equal(aBets[0].stakeCents, 3000);
    assert.equal(result.decisions.filter(decision => decision.family === 'A' && decision.action === 'ABSTAIN').length, 1);
    assert.equal((await f.research.listPortfolios()).find(wallet => wallet.family === 'A').committedCents, 3000);
    assert.equal(result.bets.filter(bet => bet.family === 'C').length, 2);
  } finally { await f.close(); }
});

test('stake advice must be positive and finite for A while C ignores an unrelated advised percentage', async () => {
  for (const invalid of [0, -1, NaN, Infinity]) {
    const f = await setup({ matches: 1 });
    try {
      const batch = await claim(f), result = await f.execution.commitBatch([prepared(f, batch.jobs[0], { decisions: { A: { suggestedStakePercent: invalid } } })]);
      assert.equal(result.bets.filter(bet => bet.family === 'A').length, 0);
      assert.deepEqual(result.bets.map(bet => [bet.family, bet.stakeCents]), [['C', 1000]]);
      assert.equal((await f.research.listPortfolios()).find(wallet => wallet.family === 'A').availableCents, 100000);
    } finally { await f.close(); }
  }
});

test('a quote outside the shared immutable input cannot fund a bet', async () => {
  const f = await setup({ matches: 1 });
  try {
    const job = (await claim(f)).jobs[0], commit = prepared(f, job);
    commit.decisions[0].quote = { ...commit.decisions[0].quote, odds: 2.1 };
    const result = await f.execution.commitBatch([commit]);
    assert.equal(result.bets.filter(bet => bet.family === 'A').length, 0);
    assert.equal(result.bets.filter(bet => bet.family === 'C').length, 1);
  } finally { await f.close(); }
});

test('stale, synthetic and future prices cannot produce any stake', async () => {
  for (const quote of [
    { updatedAt: '2026-10-30T12:24:59.999Z' },
    { source: 'synthetic_plus_model_completion' },
    { updatedAt: '2026-10-30T12:30:00.001Z' },
  ]) {
    const f = await setup({ matches: 1 });
    try {
      const commit = prepared(f, (await claim(f)).jobs[0], { quote });
      try { await f.execution.commitBatch([commit]); } catch (error) { assert.match(String(error.message), /quote|time|fresh|snapshot/i); }
      assert.equal(await count(f.client, 'research_bets'), 0);
      assert.equal((await f.research.listLedger()).filter(event => event.event === 'STAKE').length, 0);
      assert.deepEqual(await walletAmounts(f.research), [['shadow_A', 100000, 0, 100000], ['shadow_C', 100000, 0, 100000]]);
    } finally { await f.close(); }
  }
});

test('a changed official kickoff or already-started fixture prevents the whole commit without backdating', async () => {
  for (const changed of ['kickoff', 'started']) {
    const f = await setup({ matches: 1 });
    try {
      const job = (await claim(f)).jobs[0], commit = prepared(f, job);
      if (changed === 'kickoff') await f.client.execute({ sql: 'UPDATE matches SET date=?', args: ['2026-10-30T20:00:00.000Z'] });
      else f.setTime(KICKOFF);
      await assert.rejects(f.execution.commitBatch([commit]), /fixture|kickoff|lease|window|started/i);
      assert.equal(await count(f.client, 'research_execution_inputs'), 0);
      assert.equal(await count(f.client, 'research_bets'), 0);
      assert.equal(await originalRecords(f.client), f.originalBeforeMigration);
    } finally { await f.close(); }
  }
});

test('mismatched origin provenance or a missing model family rolls back the shared commit', async () => {
  for (const invalid of ['origin', 'family']) {
    const f = await setup({ matches: 1 });
    try {
      const commit = prepared(f, (await claim(f)).jobs[0]);
      if (invalid === 'origin') commit.decisions[0].originDecisionId = commit.decisions[1].originDecisionId;
      else commit.decisions = commit.decisions.slice(0, 1);
      await assert.rejects(f.execution.commitBatch([commit]), /origin|family|families|both|shared|A.*C/i);
      assert.equal(await count(f.client, 'research_execution_decisions'), 0);
      assert.equal(await count(f.client, 'research_bets'), 0);
      assert.equal((await f.research.listLedger()).filter(event => event.event === 'STAKE').length, 0);
    } finally { await f.close(); }
  }
});

test('settlement reuses reserved stakes, rounds returns, refunds voids and is idempotent', async () => {
  const f = await setup({ matches: 3 });
  try {
    const batch = await claim(f);
    const result = await f.execution.commitBatch(batch.jobs.map(job => prepared(f, job, { quote: { odds: 1.91 } })));
    const aBets = result.bets.filter(bet => bet.family === 'A').sort((a, b) => a.matchId.localeCompare(b.matchId));
    assert.equal(aBets.length, 3);
    const proof = id => ({ matchId: id, source: 'isolated-official-fixture', homeGoals: 2, awayGoals: 0 });
    const won = await f.research.settleBet(aBets[0].id, 1.91, proof(aBets[0].matchId));
    assert.equal(won.returnCents, Math.round(1530 * 1.91));
    await f.research.settleBet(aBets[1].id, 1, proof(aBets[1].matchId));
    await f.research.settleBet(aBets[2].id, 0, proof(aBets[2].matchId));
    const aWallet = (await f.research.listPortfolios()).find(wallet => wallet.family === 'A');
    assert.deepEqual([aWallet.availableCents, aWallet.committedCents, aWallet.equityCents], [99862, 0, 99862]);
    assert.equal((await f.research.settleBet(aBets[0].id, 1.91, proof(aBets[0].matchId))).settled, false);
    assert.equal((await f.research.listLedger('shadow_A')).filter(event => event.event === 'SETTLE').length, 3);
    assert.equal(await originalRecords(f.client), f.originalBeforeMigration);
  } finally { await f.close(); }
});

test('the next advised stake floors cents using current equity after a real settlement', async () => {
  const f = await setup({ matches: 2 });
  try {
    const firstJob = (await claim(f, [f.fixtures[0]])).jobs[0];
    const first = await f.execution.commitBatch([prepared(f, firstJob, { quote: { odds: 1.9 } })]);
    const aBet = first.bets.find(bet => bet.family === 'A');
    await f.research.settleBet(aBet.id, 1.9, { matchId: aBet.matchId, source: 'isolated-official-fixture', homeGoals: 2, awayGoals: 0 });
    const secondJob = (await claim(f, [f.fixtures[1]])).jobs[0];
    const second = await f.execution.commitBatch([prepared(f, secondJob)]);
    assert.equal(second.bets.find(bet => bet.family === 'A').stakeCents, Math.floor(101377 * 1.53 / 100));
    assert.equal(second.bets.find(bet => bet.family === 'A').stakeCents, 1551);
    assert.equal(second.bets.find(bet => bet.family === 'C').stakeCents, 1000);
  } finally { await f.close(); }
});

test('lease renewal updates metadata without invalidating a snapshot captured after the original claim', async () => {
  const f = await setup({ matches: 1 });
  try {
    const job = (await claim(f)).jobs[0], commit = prepared(f, job);
    const capturedBeforeRenewal = commit.inputSnapshot.observedAt;
    f.setTime('2026-10-30T12:30:10.000Z');
    assert.equal(await f.execution.renewLeases([job], 30000), true);
    const renewed = (await f.execution.listJobs()).find(entry => entry.id === job.id);
    assert.equal(Date.parse(renewed.claimedAt), Date.parse(START));
    assert.ok(Date.parse(renewed.updatedAt) > Date.parse(capturedBeforeRenewal));
    const result = await f.execution.commitBatch([commit]);
    assert.equal(result.bets.length, 2);
    assert.equal(await count(f.client, 'research_execution_inputs'), 1);
    assert.deepEqual(result.bets.map(bet => [bet.family, bet.stakeCents]).sort(), [['A', 1530], ['C', 1000]]);
  } finally { await f.close(); }
});

test('a completed snapshot cannot be replayed with a different action or advised stake', async () => {
  const f = await setup({ matches: 1 });
  try {
    const commit = prepared(f, (await claim(f)).jobs[0]);
    await f.execution.commitBatch([commit]);
    const balances = await walletAmounts(f.research), ledger = json(await f.research.listLedger());
    for (const change of [{ action: 'ABSTAIN', reason: 'changed_after_completion' }, { suggestedStakePercent: 1.54 }]) {
      const replay = structuredClone(commit);
      Object.assign(replay.decisions[0], change);
      assert.equal(researchHash(replay.inputSnapshot), researchHash(commit.inputSnapshot));
      await assert.rejects(f.execution.commitBatch([replay]), /immutable/i);
    }
    assert.equal(await count(f.client, 'research_execution_decisions'), 2);
    assert.equal(await count(f.client, 'research_bets'), 2);
    assert.equal(json(await f.research.listLedger()), ledger);
    assert.deepEqual(await walletAmounts(f.research), balances);
  } finally { await f.close(); }
});

test('missing or unknown A confidence abstains while C continues using its fixed one percent', async () => {
  for (const confidence of [undefined, 'UNKNOWN']) {
    const f = await setup({ matches: 1 });
    try {
      const job = (await claim(f)).jobs[0];
      const result = await f.execution.commitBatch([prepared(f, job, { decisions: { A: { confidence } } })]);
      assert.equal(result.decisions.find(decision => decision.family === 'A').action, 'ABSTAIN');
      assert.equal(result.bets.filter(bet => bet.family === 'A').length, 0);
      assert.deepEqual(result.bets.map(bet => [bet.family, bet.stakeCents]), [['C', 1000]]);
      assert.deepEqual(await walletAmounts(f.research), [['shadow_A', 100000, 0, 100000], ['shadow_C', 99000, 1000, 100000]]);
    } finally { await f.close(); }
  }
});

test('the database rejects a bet that cites an immutable ABSTAIN execution decision as authorization', async () => {
  const f = await setup({ matches: 1 });
  try {
    const job = (await claim(f)).jobs[0];
    const result = await f.execution.commitBatch([prepared(f, job, { decisions: {
      A: { action: 'ABSTAIN', reason: 'no_positive_recommendation' }, C: { action: 'ABSTAIN', reason: 'no_positive_recommendation' },
    } })]);
    const abstained = result.decisions.find(decision => decision.family === 'A');
    await assert.rejects(f.client.execute({ sql: `INSERT INTO research_bets
      (id,decision_id,execution_decision_id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,snapshot_json,placed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [randomUUID(), job.originDecisionIds.A, abstained.id, 'shadow_A', job.matchId, 'A', 'A-app-fixture', '1x2', 'homeWin', 2, 1530,
      json({ originDecisionId: job.originDecisionIds.A, effectiveExecutionDecisionId: abstained.id }), START] }), /execution|authorization|authoris|mismatch|abstain/i);
    assert.equal(await count(f.client, 'research_bets'), 0);
    assert.equal((await f.research.listLedger()).filter(event => event.event === 'STAKE').length, 0);
    assert.equal(await count(f.client, 'research_execution_decisions'), 2);
  } finally { await f.close(); }
});

test('read APIs stay compatible before migration and recheck an absent execution schema after additive DDL', async () => {
  const f = await setup({ matches: 1, deferExecutionMigration: true });
  try {
    assert.equal(await f.execution.hasSchema(), false);
    assert.deepEqual(await f.execution.listDecisionViews(), []);
    assert.deepEqual(await f.execution.listJobs(), []);
    const legacyBefore = await f.research.listLegacyDecisionViews({ matchId: f.fixtures[0].matchId });
    assert.equal(legacyBefore.length, 2);
    assert.ok(legacyBefore.every(row => row.action === 'ABSTAIN' && row.betId == null && row.existingBetExecutionDecisionId == null));
    assert.equal(Number((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'research_execution_%'")).rows[0].n), 0);
    await f.client.executeMultiple(readFileSync(join(__dirname, '../migrations/023_research_recommendation_execution.sql'), 'utf8'));
    assert.equal(await f.execution.hasSchema(), true);
    f.policy = await f.execution.registerPolicy();
    const result = await f.execution.commitBatch([prepared(f, (await claim(f)).jobs[0])]);
    const legacyAfter = await f.research.listLegacyDecisionViews({ matchId: f.fixtures[0].matchId });
    assert.equal(legacyAfter.length, 2);
    for (const row of legacyAfter) {
      const authorized = result.bets.find(bet => bet.family === row.family);
      assert.equal(row.action, 'ABSTAIN');
      assert.equal(row.betId, null);
      assert.equal(row.existingBetId, authorized.id);
      assert.equal(row.existingBetExecutionDecisionId, authorized.executionDecisionId);
      assert.equal(row.existingBetOriginDecisionId, row.id);
    }
    assert.equal(await originalRecords(f.client), f.originalBeforeMigration);
  } finally { await f.close(); }
});

test('decision views are bounded compact projections and frozen forecast packets require an explicit match scope', async () => {
  const f = await setup({ matches: 1 });
  try {
    const job = (await claim(f)).jobs[0];
    const heavy = 'UNEXPOSED_RAW_ARTIFACT_'.repeat(2000);
    const stages = { raw: { homeWin: .6 }, calibrated: { homeWin: .6 }, decision: { homeWin: .6 } };
    const aPacket = { packet: 'frozen-A-advice', suggestedStakePercent: 1.53 };
    const cPacket = { packet: 'frozen-C-advice', suggestedStakePercent: 1 };
    const commit = prepared(f, job, { snapshot: { history: heavy, forecasts: {
      A: aPacket, C: { recommendation: cPacket, artifact: heavy },
    } }, decisions: {
      A: { probabilityStages: stages, diagnosticDump: heavy, prospectiveMatrix: [[1]] },
      C: { probabilityStages: stages, diagnosticDump: heavy, prospectiveMatrix: [[1]] },
    } });
    await f.execution.commitBatch([commit]);
    const compact = await f.execution.listDecisionViews();
    assert.equal(compact.length, 2);
    assert.equal(json(compact).includes('UNEXPOSED_RAW_ARTIFACT_'), false);
    for (const row of compact) {
      assert.equal(row.snapshotJson, undefined);
      assert.equal(row.snapshot.diagnosticDump, undefined);
      assert.equal(row.snapshot.prospectiveMatrix, undefined);
      assert.equal(row.snapshot.probabilityStages, undefined);
      assert.equal(row.recommendationPacket, undefined);
    }
    assert.equal((await f.execution.listDecisionViews({ family: 'A', limit: 1 })).length, 1);
    assert.equal((await f.execution.listDecisionViews({ family: 'A', limit: 1 }))[0].family, 'A');
    for (const limit of [0, -1, 1001, 1.5]) await assert.rejects(f.execution.listDecisionViews({ limit }), /scope|limit/i);
    await assert.rejects(f.execution.listDecisionViews({ includeForecasts: true }), /scope/i);
    const scoped = await f.execution.listDecisionViews({ matchId: job.matchId, includeForecasts: true, includeProbabilityStages: true });
    assert.equal(scoped.length, 2);
    assert.deepEqual(scoped.find(row => row.family === 'A').recommendationPacket, aPacket);
    assert.deepEqual(scoped.find(row => row.family === 'C').recommendationPacket, cPacket);
    for (const row of scoped) assert.deepEqual(row.snapshot.probabilityStages, stages);
    assert.equal(json(scoped).includes('UNEXPOSED_RAW_ARTIFACT_'), false);
  } finally { await f.close(); }
});

test('later-policy abstention preserves the earlier authorized bet identity and cannot label its own decision as funded', async () => {
  const f = await setup({ matches: 1 });
  try {
    const first = await f.execution.commitBatch([prepared(f, (await claim(f)).jobs[0], {
      decisions: { C: { action: 'ABSTAIN', reason: 'C_has_no_positive_recommendation' } },
    })]);
    const actualBet = first.bets.find(bet => bet.family === 'A');
    assert.ok(actualBet);
    f.setTime('2026-10-30T12:30:10.000Z');
    const later = await f.execution.registerPolicy({ ...VIRTUAL_RECOMMENDATION_POLICY, version: 'virtual-recommendation-v2' });
    const job = (await claim(f, f.fixtures, { policyHash: later.hash, runId: RUN + ':v2' })).jobs[0];
    const second = await f.execution.commitBatch([prepared(f, job, { decisions: {
      A: { action: 'ABSTAIN', reason: 'new_policy_has_no_positive_recommendation' },
      C: { action: 'ABSTAIN', reason: 'new_policy_has_no_positive_recommendation' },
    } })]);
    assert.equal(second.bets.length, 0);
    const current = await f.execution.listDecisionViews({ matchId: job.matchId, family: 'A' });
    assert.equal(current.length, 1);
    assert.equal(current[0].id, actualBet.executionDecisionId);
    assert.equal(current[0].action, 'BET');
    assert.equal(current[0].betId, actualBet.id);
    assert.equal(current[0].existingBetId, actualBet.id);
    assert.equal(current[0].existingBetExecutionDecisionId, actualBet.executionDecisionId);
    assert.equal(current[0].existingBetOriginDecisionId, actualBet.originDecisionId);
    const effectivePair = await f.execution.listDecisionViews({ matchId: job.matchId });
    assert.deepEqual(effectivePair.map(row => row.family), ['C', 'A']);
    assert.equal(effectivePair[0].action, 'ABSTAIN');
    assert.equal(effectivePair[1].betId, actualBet.id);
    const history = (await f.execution.listDecisions({ matchId: job.matchId, fullSnapshot: true }))
      .filter(row => row.family === 'A');
    assert.equal(history.length, 2);
    const abstained = history.find(row => row.policyHash === later.hash);
    assert.equal(abstained.action, 'ABSTAIN');
    assert.notEqual(abstained.id, actualBet.executionDecisionId);
    assert.equal(abstained.snapshot.originDecisionId, actualBet.originDecisionId);
    assert.equal(abstained.snapshot.effectiveExecutionDecisionId, abstained.id);
    const compared = await f.execution.getComparisonDecisionPairs({ from: '2026-10-30T12:29:00Z', to: '2026-10-30T12:31:00Z' });
    assert.equal(compared.comparedCount, 1);
    assert.equal(compared.differentCount, 1);
    assert.equal(compared.incompleteCount, 0);
    assert.equal(compared.truncated, false);
    assert.equal(compared.pairs.length, 1);
    assert.equal(compared.pairs[0].A.id, actualBet.executionDecisionId);
    assert.equal(compared.pairs[0].A.betId, actualBet.id);
    assert.equal(compared.pairs[0].C.id, second.decisions.find(row => row.family === 'C').id);
    assert.equal(compared.pairs[0].C.action, 'ABSTAIN');
    const afterFunding = await f.execution.getComparisonDecisionPairs({ from: '2026-10-30T12:30:05Z', to: '2026-10-30T12:31:00Z' });
    assert.equal(afterFunding.comparedCount, 0);
    assert.equal(afterFunding.differentCount, 0);
    assert.equal(afterFunding.incompleteCount, 1);
    assert.deepEqual(afterFunding.pairs, []);
    assert.equal(afterFunding.truncated, false);
    const legacy = await f.research.listLegacyDecisionViews({ matchId: job.matchId, family: 'A' });
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].action, 'ABSTAIN');
    assert.equal(legacy[0].betId, null);
    assert.equal(legacy[0].existingBetExecutionDecisionId, actualBet.executionDecisionId);
    assert.equal((await f.research.getNightlyRunMetrics(ORIGIN_RUN)).registeredBets, 0);
    assert.equal((await f.execution.getRunMetrics(RUN + ':v2', later.hash)).registeredBets, 0);
    assert.equal(await count(f.client, 'research_bets'), 1);
    assert.deepEqual(await walletAmounts(f.research), [['shadow_A', 98470, 1530, 100000], ['shadow_C', 100000, 0, 100000]]);
  } finally { await f.close(); }
});

test('pre-023 comparison counts all 300 abstaining pairs exactly without truncating aggregate coverage', async () => {
  const f = await setup({ matches: 0, deferExecutionMigration: true });
  try {
    const legacyStatements = (index, families = ['A', 'C']) => {
      const matchId = `legacy-comparison-${index}`, jobId = `legacy-comparison-job-${index}`, inputId = `legacy-comparison-input-${index}`;
      const snapshot = { fixtureOnly: true, observedAt: START, matchId };
      return [
        { sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL)', args: [matchId, KICKOFF] },
        { sql: `INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,status,created_at,updated_at)
          VALUES (?,?,?,?,'COMPLETED',?,?)`, args: [jobId, matchId, KICKOFF, START, START, START] },
        { sql: 'INSERT INTO research_inputs VALUES(?,?,?,?,?,?)', args: [inputId, jobId, researchHash(snapshot), json(snapshot), START, KICKOFF] },
        ...families.map(family => ({ sql: `INSERT INTO research_decisions
          (id,job_id,input_id,family,model_version,market,selection,portfolio_id,action,reason,snapshot_json,created_at)
          VALUES (?,?,?,?,?,?,?,?, 'ABSTAIN',?,?,?)`, args: [`legacy-comparison-decision-${index}-${family}`, jobId, inputId, family,
          family === 'A' ? 'A-origin-fixture' : 'C-fixture', family === 'A' ? '1x2' : 'totals', family === 'A' ? 'homeWin' : 'over25',
          `shadow_${family}`, `${family}_has_no_positive_recommendation`, json({ fixtureOnly: true }), START] })),
      ];
    };
    await f.client.batch(Array.from({ length: 300 }, (_value, index) => legacyStatements(index)).flat(), 'write');
    assert.equal(await f.execution.hasSchema(), false);
    assert.equal(await count(f.client, 'research_decisions'), 600);
    const scope = { from: '2026-10-30T12:29:00Z', to: '2026-10-30T12:31:00Z' };
    const compared = await f.execution.getComparisonDecisionPairs(scope);
    assert.equal(compared.comparedCount, 300);
    assert.equal(compared.differentCount, 0);
    assert.equal(compared.incompleteCount, 0);
    assert.equal(compared.truncated, false);
    assert.deepEqual(compared.pairs, []);
    await f.client.batch(legacyStatements('partial', ['A']), 'write');
    const partial = await f.execution.getComparisonDecisionPairs({ ...scope, limit: 1 });
    assert.equal(partial.comparedCount, 300);
    assert.equal(partial.differentCount, 0);
    assert.equal(partial.incompleteCount, 1);
    assert.equal(partial.truncated, false);
    assert.deepEqual(partial.pairs, []);
    await assert.rejects(f.execution.getComparisonDecisionPairs({ ...scope, limit: 501 }), /scope/i);
    await assert.rejects(f.execution.getComparisonDecisionPairs({ ...scope, limit: 0 }), /scope/i);
  } finally { await f.close(); }
});
