const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { ResearchRecommendationStore, VIRTUAL_RECOMMENDATION_POLICY } = require('../dist/research/ResearchRecommendationStore');
const { ResearchBetCancellation } = require('../dist/research/ResearchBetCancellation');
const { argumentsOf, loadEnvironment } = require('../scripts/cancel-research-bets');

const START = '2026-10-30T10:00:00.000Z', KICKOFF = '2026-10-30T19:00:00.000Z', END = '2026-10-31T02:00:00.000Z';
async function fixture(t, options = {}) {
  const path = join(tmpdir(), `research-cancellation-${randomUUID()}.db`);
  const db = createClient({ url: `file:${path}` });
  t.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(path + suffix, { force: true }); } catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
  } });
  for (const migration of ['015_research_platform.sql', '020_research_nightly.sql', '023_research_recommendation_execution.sql']) {
    await db.executeMultiple(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
  }
  await db.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,home_goals INTEGER,away_goals INTEGER)');
  await db.execute({ sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL)', args: ['match', KICKOFF] });
  let now = START;
  const clock = () => new Date(now);
  const research = new ResearchStore(db, async () => {}, { now: clock });
  await research.initializePortfolios();
  const descriptor = { ...VIRTUAL_RECOMMENDATION_POLICY, version: options.policyVersion ?? 'virtual-recommendation-v1' };
  const policyHash = researchHash(descriptor);
  await db.execute({ sql: 'INSERT INTO research_execution_policies VALUES(?,?,?,?)', args: [policyHash, descriptor.version, JSON.stringify(descriptor), START] });
  await db.execute({ sql: `INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,status,created_at,updated_at) VALUES(?,?,?,?,'COMPLETED',?,?)`,
    args: ['origin-job', 'match', KICKOFF, START, START, START] });
  await db.execute({ sql: 'INSERT INTO research_inputs VALUES(?,?,?,?,?,?)', args: ['origin-input', 'origin-job', 'original-hash', '{}', START, KICKOFF] });
  await db.execute({ sql: `INSERT INTO research_execution_jobs(id,match_id,policy_hash,run_id,kickoff_at,window_start_at,window_end_at,status,claimed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'COMPLETED',?,?,?)`, args: ['execution-job', 'match', policyHash, 'wrong-v1-run', KICKOFF, START, END, START, START, START] });
  await db.execute({ sql: 'INSERT INTO research_execution_inputs VALUES(?,?,?,?,?,?,?,?)', args: ['execution-input', 'execution-job', 'origin-input', 'inputhash', 'decisionhash', '{}', START, KICKOFF] });
  for (const family of ['A', 'C']) {
    await research.saveModel({ family, version: `${family}-fixture`, artifact: { fixtureOnly: true, family } });
    await research.setMarketState({ family, modelVersion: `${family}-fixture`, market: '1x2', state: 'EXPERIMENTAL' });
    await db.execute({ sql: `INSERT INTO research_decisions(id,job_id,input_id,family,model_version,market,selection,portfolio_id,action,reason,snapshot_json,created_at)
      VALUES(?,?,?,?,?,'1x2',NULL,?,'ABSTAIN','diagnostic_only','{}',?)`,
    args: [`origin-${family}`, 'origin-job', 'origin-input', family, `${family}-fixture`, `shadow_${family}`, START] });
    const stake = family === 'A' ? 1530 : 1000;
    const quote = { selection: 'homeWin', market: '1x2', side: 'home', odds: 2, source: 'odds_api',
      bookmaker: 'Fixture Book', priceType: 'prematch', capturedAt: START, updatedAt: START };
    const snapshot = JSON.stringify({ quote, stakeCents: stake, originDecisionId: `origin-${family}`, effectiveExecutionDecisionId: `execution-${family}` });
    await db.execute({ sql: `INSERT INTO research_execution_decisions VALUES(?,?,?,?,?,?,'BET','1x2','homeWin',NULL,?,?)`,
      args: [`execution-${family}`, 'execution-input', `origin-${family}`, family, `${family}-fixture`, `shadow_${family}`, snapshot, START] });
    await db.execute({ sql: `INSERT INTO research_bets(id,decision_id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,snapshot_json,placed_at,execution_decision_id)
      VALUES(?,?,?,'match',?,?,'1x2','homeWin',2,?,?,?,?)`, args: [`bet-${family}`, `origin-${family}`, `shadow_${family}`, family, `${family}-fixture`,
      stake, snapshot, START, options.legacy ? null : `execution-${family}`] });
    await db.execute({ sql: `INSERT INTO research_ledger VALUES(?,?,?,'STAKE',?,?,?)`, args: [`stake:bet-${family}`, `shadow_${family}`, `bet-${family}`, -stake, stake, START] });
  }
  const service = new ResearchBetCancellation(db, { research, clock });
  const request = { betIds: ['bet-A', 'bet-C'], policyHash, runId: 'wrong-v1-run', reason: 'Explicit user correction of wrong v1 engine scope',
    authorizedBy: 'Fixture user', authorizedAt: START };
  return { db, research, service, request, clock, setTime: (value) => { now = value; } };
}

test('planning is read-only; applying archives exactly the original stakes and restores balances without rewriting decisions', async (t) => {
  const f = await fixture(t);
  const originals = JSON.stringify((await f.db.execute('SELECT * FROM research_execution_decisions ORDER BY id')).rows);
  const plan = await f.service.plan(f.request);
  assert.equal((await f.db.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='research_bet_cancellations'")).rows[0].n, 0);
  assert.equal((await f.research.listBets()).length, 2);
  const result = await f.service.apply(plan);
  assert.deepEqual([result.cancelled, result.alreadyCancelled, result.releasedCents], [2, 0, 2530]);
  assert.equal((await f.research.listBets()).length, 0);
  const archived = (await f.db.execute('SELECT * FROM research_bet_cancellations ORDER BY bet_id')).rows;
  assert.equal(archived.length, 2);
  assert.equal(JSON.parse(archived[0].bet_json).id, 'bet-A');
  assert.equal(JSON.parse(archived[0].stake_ledger_json).available_delta_cents, -1530);
  assert.equal(archived[0].authorized_by, f.request.authorizedBy);
  assert.equal(JSON.stringify((await f.db.execute('SELECT * FROM research_execution_decisions ORDER BY id')).rows), originals);
  assert.ok((await f.research.listLedger()).every((entry) => entry.event === 'OPEN'));
  assert.ok((await f.research.listPortfolios()).every((wallet) => wallet.availableCents === 100000 && wallet.committedCents === 0));
  f.setTime('2026-10-31T10:00:00.000Z');
  assert.deepEqual(await f.service.apply(plan), { cancelled: 0, alreadyCancelled: 2, releasedCents: 0, planHash: plan.planHash });
  await assert.rejects(f.db.execute("DELETE FROM research_ledger WHERE event='OPEN'"), /immutable/);
  await assert.rejects(f.db.execute('DELETE FROM research_bet_cancellations'), /immutable/);
  await assert.rejects(f.db.execute("UPDATE research_execution_decisions SET reason='changed'"), /immutable/);
});

test('the same origin and real match accept exactly one newly computed v2 replacement after cancellation', async (t) => {
  const f = await fixture(t);
  await f.service.apply(await f.service.plan(f.request));
  const store = new ResearchRecommendationStore(f.db, async () => {}, { research: f.research, now: f.clock });
  assert.deepEqual(await store.listDecisionViews({ matchId: 'match' }), []);
  assert.equal((await store.listDecisions({ matchId: 'match', fullSnapshot: true })).length, 2,
    'cancelled execution decisions stay available as historical evidence');
  const policy = await store.registerPolicy();
  const claim = await store.claimBatch({ policyHash: policy.hash, runId: 'correct-v2-run', windowStartAt: START, windowEndAt: END,
    fixtures: [{ matchId: 'match', kickoffAt: KICKOFF }] });
  assert.equal(claim.jobs.length, 1);
  const job = claim.jobs[0];
  const quote = { selection: 'homeWin', market: '1x2', side: 'home', odds: 2, source: 'odds_api',
    bookmaker: 'New Fixture Book', priceType: 'prematch', capturedAt: START, updatedAt: START };
  const prepared = { jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
    inputSnapshot: { observedAt: START, quotes: [quote] }, decisions: ['A', 'C'].map((family) => {
      const configuration = { family, fixtureOnly: true };
      return { family, modelVersion: `${family}-fixture`, originDecisionId: job.originDecisionIds[family], action: 'BET',
        market: '1x2', selection: 'homeWin', quote, probability: .6, ev: .2, recommended: true, validated: true,
        suggestedStakePercent: 1.5, confidence: 'MEDIUM', probabilityConfiguration: configuration, probabilityConfigurationHash: researchHash(configuration) };
    }) };
  const replacement = await store.commitBatch([prepared]);
  assert.equal(replacement.bets.length, 2);
  assert.ok(replacement.bets.every((bet) => !['bet-A', 'bet-C'].includes(bet.id)));
  assert.equal((await store.commitBatch([prepared])).bets.length, 2);
  assert.equal((await f.research.listBets()).length, 2);
  const effective = await store.listDecisionViews({ matchId: 'match' });
  assert.equal(effective.length, 2);
  assert.ok(effective.every((decision) => decision.policyVersion === 'virtual-recommendation-v2'
    && replacement.bets.some((bet) => bet.id === decision.betId)));
  assert.equal((await f.research.listLedger()).filter((entry) => entry.event === 'STAKE').length, 2);
  await assert.rejects(f.db.execute(`INSERT INTO research_bets SELECT 'another-id',decision_id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,snapshot_json,placed_at,execution_decision_id
    FROM research_bets LIMIT 1`));
});

test('wrong IDs, policies, runs, legacy records, settled bets and changed fixtures fail closed', async (t) => {
  for (const options of [{ legacy: true }, { policyVersion: 'virtual-recommendation-v2' }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.service.plan(f.request));
  }
  const f = await fixture(t);
  for (const patch of [{ betIds: ['missing'] }, { betIds: ['bet-A', 'bet-A'] }, { policyHash: '0'.repeat(64) }, { runId: 'another-run' }]) {
    await assert.rejects(f.service.plan({ ...f.request, ...patch }));
  }
  await f.research.settleBet('bet-A', 1, { fixtureOnly: true });
  await assert.rejects(f.service.plan(f.request), /Settled/);
  assert.equal((await f.research.listBets()).length, 2);
  const moved = await fixture(t);
  const plan = await moved.service.plan(moved.request);
  await moved.db.execute("UPDATE matches SET date='2026-10-30T20:00:00Z'");
  await assert.rejects(moved.service.apply(plan), /unchanged upcoming/);
  assert.equal((await moved.research.listBets()).length, 2);
});

test('manifest tampering, stale fingerprints, active leases and kickoff reject the entire batch', async (t) => {
  const f = await fixture(t);
  const plan = await f.service.plan(f.request);
  await assert.rejects(f.service.apply({ ...plan, reason: 'tampered' }), /identity/);
  const forged = { ...plan, bets: plan.bets.map((bet, index) => index ? bet : { ...bet, stakeCents: bet.stakeCents + 1 }) };
  const { planHash: _hash, ...body } = forged;
  forged.planHash = researchHash(body);
  await assert.rejects(f.service.apply(forged), /exact original/);
  await f.db.execute({ sql: "UPDATE research_execution_jobs SET status='CLAIMED',lease_expires_at=?", args: [END] });
  await assert.rejects(f.service.apply(plan), /active execution/);
  f.setTime(KICKOFF);
  await assert.rejects(f.service.apply(plan), /upcoming/);
  assert.equal((await f.research.listBets()).length, 2);
  assert.equal((await f.research.listLedger()).filter((entry) => entry.event === 'STAKE').length, 2);
});

test('CLI requires an explicit plan and reads UTF16LE or UTF8 BOM credentials without printing them', () => {
  assert.throws(() => argumentsOf([]));
  assert.throws(() => argumentsOf(['apply', '--ids', 'all']));
  assert.deepEqual(argumentsOf(['apply', '--env-file', 'production.env', '--plan', 'reviewed.json']),
    { command: 'apply', options: { '--plan': 'reviewed.json' }, envFile: 'production.env' });
  const path = join(tmpdir(), `cancellation-env-${randomUUID()}`);
  try {
    const env = {};
    const content = 'TURSO_DATABASE_URL="file:fixture.db"\r\nTURSO_AUTH_TOKEN=fixture-token\r\nUNRELATED=ignored\r\n';
    for (const bytes of [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]),
      Buffer.from(`\uFEFF${content}`, 'utf8')]) {
      writeFileSync(path, bytes); loadEnvironment(path, env);
      assert.deepEqual(env, { TURSO_DATABASE_URL: 'file:fixture.db', TURSO_AUTH_TOKEN: 'fixture-token' });
    }
  } finally { rmSync(path, { force: true }); }
});
