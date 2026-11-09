const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const build = process.env.PAPER_TEST_BUILD_DIR || join(__dirname, '../dist');
const { ResearchStore, researchHash } = require(join(build, 'research/ResearchStore'));
const { ResearchRecommendationStore } = require(join(build, 'research/ResearchRecommendationStore'));
const { PAPER_RECOMMENDATION_POLICY } = require(join(build, 'research/ResearchRecommendationPolicy'));
const { paperSelectionKey } = require(join(build, 'research/PaperBetSelections'));
const START = '2026-11-06T10:00:00.000Z', KICKOFF = '2026-11-06T19:00:00.000Z', END = '2026-11-07T02:00:00.000Z';
const config = family => ({ version: 'fixture', family });
const policy = { ...PAPER_RECOMMENDATION_POLICY, familyC: { ...PAPER_RECOMMENDATION_POLICY.familyC, modelVersion: 'C-fixture' } };
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? Number(item) : item);

async function setup({ matches = 2, funded = false } = {}) {
  const path = join(tmpdir(), `paper-model-bets-${process.pid}-${randomUUID()}.db`), client = createClient({ url: `file:${path}` });
  for (const name of ['015_research_platform.sql', '020_research_nightly.sql', '023_research_recommendation_execution.sql', '028_paper_model_bets.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
  }
  await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT NOT NULL,home_goals INTEGER,away_goals INTEGER)');
  const clock = () => new Date(START), research = new ResearchStore(client, async () => {}, { now: clock });
  await research.initializePortfolios({ fundVirtual: funded });
  for (const family of ['A', 'C']) {
    await research.saveModel({ family, version: `${family}-fixture`, artifact: { fixture: true, family } });
    for (const market of ['1x2', 'totals', 'dnb']) await research.setMarketState({ family, modelVersion: `${family}-fixture`, market, state: 'EXPERIMENTAL' });
  }
  const fixtures = [];
  for (let index = 0; index < matches; index++) {
    const matchId = `paper-fixture-${index}`, job = `origin-job-${index}`, input = `origin-input-${index}`;
    fixtures.push({ matchId, kickoffAt: KICKOFF });
    await client.execute({ sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL)', args: [matchId, KICKOFF] });
    await client.execute({ sql: `INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,status,created_at,updated_at) VALUES(?,?,?,?,'COMPLETED',?,?)`, args: [job, matchId, KICKOFF, START, START, START] });
    await client.execute({ sql: 'INSERT INTO research_inputs VALUES(?,?,?,?,?,?)', args: [input, job, researchHash({ matchId }), json({ matchId }), START, KICKOFF] });
    for (const family of ['A', 'C']) await client.execute({ sql: `INSERT INTO research_decisions
      (id,job_id,input_id,family,model_version,market,portfolio_id,action,snapshot_json,created_at) VALUES(?,?,?,?,?,'1x2',?,'ABSTAIN','{}',?)`,
      args: [`origin-${index}-${family}`, job, input, family, `${family}-fixture`, `shadow_${family}`, START] });
  }
  const recommendations = new ResearchRecommendationStore(client, async () => {}, { now: clock, research });
  const registered = await recommendations.registerPolicy(policy);
  return { client, path, research, recommendations, registered, fixtures, clock,
    async claim(descriptor = registered) { return recommendations.claimBatch({ policyHash: descriptor.hash, runId: 'paper-test', windowStartAt: START, windowEndAt: END, fixtures }); },
    async fingerprint() { return json(await Promise.all(['research_inputs', 'research_decisions', 'research_bets', 'research_settlements', 'research_ledger'].map(async table => [table, (await client.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows]))); },
    async close() {
      client.close();
      // Windows native libSQL handles may remain alive until finalization.
      if (process.platform === 'win32') return;
      for (const suffix of ['', '-wal', '-shm']) try { rmSync(path + suffix, { force: true }); }
      catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
    } };
}

function selection(index, overrides = {}) {
  const quote = { market: 'totals', selection: `over${index + 0.5}`, side: 'over', line: index + .5, odds: 2,
    source: 'odds_api', bookmaker: 'Fixture bookmaker', priceType: 'prematch', capturedAt: START, updatedAt: START, ...overrides };
  return { market: quote.market, selection: quote.selection, selectionKey: paperSelectionKey(quote), quote, probability: .6, ev: .2, confidence: 'MEDIUM' };
}
function prepared(job, count = 1) {
  const children = Array.from({ length: count }, (_value, index) => selection(index));
  return { jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
    inputSnapshot: { observedAt: START, match: { matchId: job.matchId, matchLabel: 'Fixture Home – Fixture Away', competition: 'EPL', kickoffAt: KICKOFF }, quotes: children.map(item => item.quote) },
    decisions: ['A', 'C'].map(family => ({ family, modelVersion: `${family}-fixture`, originDecisionId: job.originDecisionIds[family],
      action: 'BET', recommended: true, validated: true, ...children[0], selections: children,
      probabilityConfiguration: config(family), probabilityConfigurationHash: researchHash(config(family)) })) };
}

test('paper batches sixteen matches under a simulated remote round-trip budget', async () => {
  const f = await setup({ matches: 16 });
  try {
    await f.client.executeMultiple(readFileSync(join(__dirname, '../migrations/019_research_worker.sql'), 'utf8'));
    await f.client.execute({ sql: 'INSERT INTO research_worker_state(scheduler,last_tick_json,updated_at) VALUES(?,?,?)',
      args: ['challenger_history_reset', JSON.stringify({ cutoff: '2026-11-06T09:59:59.999Z' }), START] });
    const commits = (await f.claim()).jobs.map(job => prepared(job, 7));
    const transaction = f.client.transaction.bind(f.client); let simulatedMs = 0, calls = 0;
    f.client.transaction = async (...args) => {
      const tx = await transaction(...args), execute = tx.execute.bind(tx), batch = tx.batch.bind(tx);
      const remote = async (fn, values) => {
        simulatedMs += 200; calls++;
        if (simulatedMs >= 5000) throw new Error('simulated transaction deadline');
        return fn(...values);
      };
      tx.execute = (...values) => remote(execute, values);
      tx.batch = (...values) => remote(batch, values);
      return tx;
    };
    const result = await f.recommendations.commitBatch(commits);
    assert.equal(result.bets.length, 128);
    assert.equal(result.decisions.length, 32);
    assert.equal(result.bets.filter(row => row.family === 'A').length, 112);
    assert.equal(result.bets.filter(row => row.family === 'C').length, 16);
    assert.ok(calls <= 8, `unexpected transaction round trips: ${calls}`);
    assert.equal((await f.recommendations.listPaperBets()).length, 128);
  } finally { await f.close(); }
});

test('paper rolls back every job if the batched writes fail after execution', async () => {
  const f = await setup({ matches: 2 });
  try {
    const commits = (await f.claim()).jobs.map(job => prepared(job, 7));
    const transaction = f.client.transaction.bind(f.client);
    f.client.transaction = async (...args) => {
      const tx = await transaction(...args), batch = tx.batch.bind(tx);
      tx.batch = async statements => {
        const result = await batch(statements);
        if (statements.some(statement => /^\s*INSERT INTO research_execution_inputs/i.test(statement.sql))) throw new Error('injected failure after writes');
        return result;
      };
      return tx;
    };
    await assert.rejects(f.recommendations.commitBatch(commits), /injected failure/);
    for (const table of ['research_execution_inputs', 'research_execution_decisions', 'paper_model_bets']) {
      assert.equal(Number((await f.client.execute(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count), 0);
    }
    assert.ok((await f.recommendations.listJobs()).every(job => job.status !== 'COMPLETED'));
  } finally { await f.close(); }
});

test('an invalid second fixture leaves the entire paper batch and its origins unchanged', async () => {
  const f = await setup({ matches: 2 });
  try {
    const commits = (await f.claim()).jobs.map(job => prepared(job, 3));
    const before = await f.fingerprint();
    commits[1].decisions[1].originDecisionId = 'missing-origin-decision';
    await assert.rejects(f.recommendations.commitBatch(commits), /origin decision mismatch/);
    for (const table of ['research_execution_inputs', 'research_execution_decisions', 'paper_model_bets']) {
      assert.equal(Number((await f.client.execute(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count), 0);
    }
    assert.equal(await f.fingerprint(), before);
    assert.ok((await f.recommendations.listJobs()).every(job => job.status !== 'COMPLETED'));
  } finally { await f.close(); }
});

for (const kind of ['lease', 'quote']) test(`paper rechecks ${kind} after batched writes and rolls back`, async () => {
  const f = await setup({ matches: 2 });
  try {
    const jobs = (await f.recommendations.claimBatch({ policyHash: f.registered.hash, runId: 'paper-test',
      windowStartAt: START, windowEndAt: END, fixtures: f.fixtures, leaseMs: 600000 })).jobs;
    let now = Date.parse(START); f.recommendations.clock = () => new Date(now);
    const transaction = f.client.transaction.bind(f.client);
    f.client.transaction = async (...args) => {
      const tx = await transaction(...args), batch = tx.batch.bind(tx);
      tx.batch = async statements => {
        const result = await batch(statements);
        if (statements.some(statement => /^\s*INSERT INTO research_execution_inputs/i.test(statement.sql))) now += kind === 'lease' ? 600001 : 300001;
        return result;
      };
      return tx;
    };
    await assert.rejects(f.recommendations.commitBatch(jobs.map(job => prepared(job, 2))), /lease|quote expired/i);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS count FROM paper_model_bets')).rows[0].count), 0);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS count FROM research_execution_inputs')).rows[0].count), 0);
  } finally { await f.close(); }
});

test('paper keeps an unregistered model as an abstention', async () => {
  const f = await setup({ matches: 1 });
  try {
    const commit = prepared((await f.claim()).jobs[0], 2);
    commit.decisions[1].modelVersion = 'C-not-registered';
    const result = await f.recommendations.commitBatch([commit]);
    assert.equal(result.decisions.find(row => row.family === 'C').reason, 'model_not_registered');
    assert.equal(result.bets.filter(row => row.family === 'C').length, 0);
    assert.equal(result.bets.filter(row => row.family === 'A').length, 2);
  } finally { await f.close(); }
});

test('paper prevents semantic duplicates between different policies in one batch', async () => {
  const f = await setup({ matches: 1 });
  try {
    const one = (await f.claim()).jobs[0];
    const secondPolicy = await f.recommendations.registerPolicy({ ...policy, revision: 'second-policy' });
    const two = (await f.claim(secondPolicy)).jobs[0];
    const result = await f.recommendations.commitBatch([prepared(one, 3), prepared(two, 3)]);
    assert.equal(result.bets.length, 4);
    assert.equal(result.decisions.filter(row => row.reason === 'paper_selection_already_recorded').length, 1);
    assert.equal(result.decisions.filter(row => row.reason === 'challenger_match_already_recorded').length, 1);
    assert.equal((await f.recommendations.listPaperBets()).length, 4);
  } finally { await f.close(); }
});

test('mixed completed and new paper jobs replay only their own recorded bets', async () => {
  const f = await setup({ matches: 2 });
  try {
    const commits = (await f.claim()).jobs.map(job => prepared(job, 2));
    await f.recommendations.commitBatch([commits[0]]);
    const result = await f.recommendations.commitBatch(commits);
    assert.equal(result.bets.length, 6);
    assert.equal(new Set(result.bets.map(bet => bet.id)).size, 6);
    assert.equal((await f.recommendations.listPaperBets()).length, 6);
  } finally { await f.close(); }
});

test('paper batch reads the current reset cutoff and does not recreate old decisions', async () => {
  const f = await setup({ matches: 1 });
  try {
    const commit = prepared((await f.claim()).jobs[0], 1);
    await f.client.executeMultiple(readFileSync(join(__dirname, '../migrations/019_research_worker.sql'), 'utf8'));
    await f.client.execute({ sql: `INSERT INTO research_worker_state(scheduler,last_tick_json,updated_at) VALUES(?,?,?)`,
      args: ['challenger_history_reset', JSON.stringify({ cutoff: START }), START] });
    await assert.rejects(f.recommendations.commitBatch([commit]), /predates challenger history reset/);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS count FROM paper_model_bets')).rows[0].count), 0);
    await f.client.execute({ sql: 'UPDATE research_worker_state SET last_tick_json=? WHERE scheduler=?',
      args: [JSON.stringify({ cutoff: '2026-11-06T09:59:59.999Z' }), 'challenger_history_reset'] });
    assert.equal((await f.recommendations.commitBatch([commit])).bets.length, 2);
  } finally { await f.close(); }
});
