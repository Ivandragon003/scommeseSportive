const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');
const { fundedExecutionPolicy, fallbackChallengerState, PAPER_RECOMMENDATION_POLICY } = require('../dist/research/ResearchRecommendationPolicy');
const { paperSelectionKey } = require('../dist/research/PaperBetSelections');
const { inspectFundedAccounting, inspectPaperAccounting, researchCriticalIncidents } = require('../dist/research/ResearchMonitoring');
const { inspectDatabase } = require('../scripts/check-research-nightly');
const START = '2026-11-07T10:00:00.000Z', KICKOFF = '2026-11-07T19:00:00.000Z', END = '2026-11-08T02:07:00.000Z';
const NOW = new Date('2026-11-08T09:00:00Z');

async function setup(t, { migrateFunded = true } = {}) {
  const path = join(tmpdir(), `funded-monitoring-${process.pid}-${randomUUID()}.db`);
  const db = createClient({ url: `file:${path}` });
  t.after(() => {
    db.close();
    // Windows native libSQL handles may remain alive until finalization.
    if (process.platform === 'win32') return;
    for (const suffix of ['', '-wal', '-shm']) try { rmSync(path + suffix, { force: true }); }
    catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
  });
  for (const name of ['015_research_platform.sql', '018_smart_odds.sql', '020_research_nightly.sql',
    '023_research_recommendation_execution.sql', '026_manual_model_bets.sql', '028_paper_model_bets.sql',
    ...(migrateFunded ? ['029_funded_model_bets.sql'] : [])]) {
    await db.executeMultiple(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
  }
  await db.executeMultiple(`CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,home_goals INTEGER,away_goals INTEGER);
    CREATE TABLE scheduler_runs(scheduler_name TEXT,started_at TEXT,ended_at TEXT,success INTEGER,error TEXT,summary_json TEXT);`);
  const research = new ResearchStore(db, async () => {}, { now: () => new Date(START) });
  await research.initializePortfolios({ fundVirtual: true });
  for (const family of ['A', 'C']) {
    await research.saveModel({ family, version: `${family}-fixture`, artifact: { fixture: true, family } });
    await research.setMarketState({ family, modelVersion: `${family}-fixture`, market: 'totals', state: 'EXPERIMENTAL' });
  }
  await db.execute({ sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL)', args: ['fixture-match', KICKOFF] });
  await db.execute({ sql: `INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,status,created_at,updated_at)
    VALUES('origin-job','fixture-match',?,?,'COMPLETED',?,?)`, args: [KICKOFF, START, START, START] });
  await db.execute({ sql: 'INSERT INTO research_inputs VALUES(?,?,?,?,?,?)', args: ['origin-input', 'origin-job', researchHash({ fixture: true }), '{"fixture":true}', START, KICKOFF] });
  for (const family of ['A', 'C']) await db.execute({ sql: `INSERT INTO research_decisions
    (id,job_id,input_id,family,model_version,market,portfolio_id,action,snapshot_json,created_at)
    VALUES(?,'origin-job','origin-input',?,?,'totals',?,'ABSTAIN','{}',?)`,
  args: [`origin-${family}`, family, `${family}-fixture`, `shadow_${family}`, START] });
  const recommendations = new ResearchRecommendationStore(db, async () => {}, { now: () => new Date(START), research });
  const state = fallbackChallengerState(); state.deployment.modelVersion = 'C-fixture';
  async function commit(policy = fundedExecutionPolicy(state), confidence = ['LOW', 'MEDIUM', 'HIGH'], selectionOffset = 0) {
    const descriptor = await recommendations.registerPolicy(policy);
    const jobs = (await recommendations.claimBatch({ policyHash: descriptor.hash, runId: 'fixture-run', windowStartAt: START, windowEndAt: END,
      fixtures: [{ matchId: 'fixture-match', kickoffAt: KICKOFF }] })).jobs;
    const items = jobs.map(job => {
      const selections = confidence.map((value, index) => {
        const line = selectionOffset + index + .5;
        const quote = { market: 'totals', selection: `over${line}`, side: 'over', line, odds: 2.01,
          source: 'odds_api', bookmaker: 'Fixture bookmaker', priceType: 'prematch', capturedAt: START, updatedAt: START };
        return { market: quote.market, selection: quote.selection, selectionKey: paperSelectionKey(quote), quote,
          probability: .6, ev: .206, confidence: value };
      });
      return { jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
        inputSnapshot: { observedAt: START, match: { matchId: job.matchId, kickoffAt: KICKOFF }, quotes: selections.map(item => item.quote) },
        decisions: ['A', 'C'].map(family => {
          const configuration = { version: 'fixture', family };
          return { family, modelVersion: `${family}-fixture`, originDecisionId: job.originDecisionIds[family], action: 'BET',
            recommended: true, validated: true, ...selections[0], selections,
            probabilityConfiguration: configuration, probabilityConfigurationHash: researchHash(configuration) };
        }) };
    });
    return recommendations.commitBatch(items);
  }
  const readonly = { execute: query => {
    assert.match((typeof query === 'string' ? query : query.sql).trim(), /^SELECT\b/i);
    return db.execute(query);
  } };
  return { db, research, recommendations, commit, readonly };
}

test('funded monitoring accepts multiple same-match confidence stakes above five percent and remains SELECT-only', async t => {
  const f = await setup(t), committed = await f.commit();
  assert.equal(committed.bets.length, 6);
  const audit = await inspectFundedAccounting(f.readonly);
  assert.deepEqual(audit.failures, []); assert.equal(audit.errors, 0); assert.equal(audit.stable, true);
  const bets = await f.research.listBets(), portfolios = await f.research.listPortfolios(), ledger = await f.research.listLedger();
  assert.equal(bets.length, 6);
  assert.deepEqual(bets.filter(bet => bet.family === 'A').map(bet => bet.stakeCents).sort((a,b) => a-b), [1000, 3000, 5000]);
  assert.deepEqual(researchCriticalIncidents({ now: START, schedulerEnabled: false, runs: [], models: [], markets: [], jobs: [], portfolios, bets, ledger }), []);
  const result = await inspectDatabase(f.readonly, { now: NOW });
  assert.deepEqual(result.issues, []); assert.equal(result.fundedAccounting.errors, 0); assert.equal(result.accounting.errors, 0);
});

test('funded accounting never reports a missing or partial active schema as healthy', async t => {
  const f = await setup(t, { migrateFunded: false });
  assert.equal((await inspectFundedAccounting(f.readonly)).required, false);
  await f.db.execute("INSERT INTO research_execution_policies VALUES('fixture','funded-confidence-v1','{}','2026-11-07T00:00:00Z')");
  assert.deepEqual((await inspectDatabase(f.readonly, { now: NOW })).issues, ['funded_schema_required']);
  await f.db.execute('CREATE TABLE funded_model_bets(id TEXT)');
  assert.deepEqual((await inspectFundedAccounting(f.readonly)).failures, ['funded_schema_required']);
});

for (const corruption of ['missing_stake', 'wrong_stake', 'duplicate_stake', 'orphan_stake']) {
  test(`funded monitoring rejects ${corruption} ledger evidence`, async t => {
    const f = await setup(t), committed = await f.commit(), id = committed.bets[0].id;
    if (corruption === 'missing_stake') await f.db.execute('DROP TRIGGER research_ledger_immutable_delete');
    if (corruption === 'wrong_stake') await f.db.execute('DROP TRIGGER research_ledger_immutable_update');
    if (corruption === 'missing_stake') await f.db.execute({ sql: 'DELETE FROM research_ledger WHERE id=?', args: [`stake:${id}`] });
    else if (corruption === 'wrong_stake') await f.db.execute({ sql: 'UPDATE research_ledger SET available_delta_cents=available_delta_cents-1 WHERE id=?', args: [`stake:${id}`] });
    else if (corruption === 'duplicate_stake') await f.db.execute({ sql: `INSERT INTO research_ledger VALUES(?,?,NULL,'STAKE',-1000,1000,?)`, args: [`settle:${id}`, 'shadow_A', START] });
    else await f.db.execute({ sql: `INSERT INTO research_ledger VALUES('stake:funded:orphan','shadow_A',NULL,'STAKE',-1,1,?)`, args: [START] });
    const audit = await inspectFundedAccounting(f.readonly);
    assert.ok(audit.errors > 0); assert.ok(audit.failures.some(value => /stake_ledger|orphan_ledger/.test(value)), JSON.stringify(audit));
    assert.ok((await inspectDatabase(f.readonly, { now: NOW })).issues.includes('funded_accounting_integrity'));
  });
}

test('funded settlement returns use the variable stake and release precisely the committed amount', async t => {
  const f = await setup(t), committed = await f.commit(), bet = committed.bets[1];
  const multiplier = (bet.odds + 1) / 2, returned = Math.round(bet.stakeCents * multiplier);
  await f.db.execute({ sql: 'INSERT INTO funded_model_settlements VALUES(?,?,?,?,?)', args: [bet.id, multiplier, returned, '{"status":"HALF_WON","fixture":true}', '2026-11-07T21:00:00Z'] });
  await f.db.execute({ sql: `INSERT INTO research_ledger VALUES(?,?,NULL,'SETTLE',?,?,?)`, args: [`settle:${bet.id}`, bet.portfolioId, returned, -bet.stakeCents, '2026-11-07T21:00:00Z'] });
  assert.deepEqual((await inspectFundedAccounting(f.readonly)).failures, []);
  assert.deepEqual((await inspectDatabase(f.readonly, { now: NOW })).issues, []);
  await f.db.execute('DROP TRIGGER research_ledger_immutable_update');
  await f.db.execute({ sql: 'UPDATE research_ledger SET committed_delta_cents=committed_delta_cents+1 WHERE id=?', args: [`settle:${bet.id}`] });
  assert.ok((await inspectFundedAccounting(f.readonly)).failures.includes(`${bet.id}:settlement_ledger`));
});

test('cancelled old paper retains its evidence audit while leaving the operational settlement backlog', async t => {
  const f = await setup(t);
  const paper = await f.commit({ ...PAPER_RECOMMENDATION_POLICY, familyC: { ...PAPER_RECOMMENDATION_POLICY.familyC, modelVersion: 'C-fixture' } }, ['MEDIUM']);
  for (const bet of paper.bets) await f.db.execute({ sql: 'INSERT INTO paper_model_bet_cancellations VALUES(?,?,?)', args: [bet.id, '2026-11-07T10:01:00Z', 'User requested cancellation'] });
  await f.commit();
  await f.db.execute("UPDATE matches SET home_goals=1,away_goals=0 WHERE match_id='fixture-match'");
  const audit = await inspectPaperAccounting(f.readonly);
  assert.equal(audit.pendingSettlements, 0); assert.deepEqual(audit.failures, []);
  const monitored = await inspectDatabase(f.readonly, { now: NOW });
  assert.equal(monitored.pendingSettlements, 6); assert.deepEqual(monitored.issues, ['settlement_backlog']);
  assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM paper_model_bets')).rows[0].count, 2);
});


test('old research, manual, immutable paper and confidence-funded bets coexist without changing their accounting', async t => {
  const f = await setup(t);
  await f.commit({ ...PAPER_RECOMMENDATION_POLICY, familyC: { ...PAPER_RECOMMENDATION_POLICY.familyC, modelVersion: 'C-fixture' } }, ['MEDIUM']);
  await f.commit(undefined, undefined, 3);
  await f.db.execute({ sql: `INSERT INTO research_bets(id,decision_id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,snapshot_json,placed_at)
    VALUES('old-research','origin-A','shadow_A','fixture-match','A','A-fixture','totals','over0.5',2,2000,'{}',?)`, args: [START] });
  await f.db.execute({ sql: `INSERT INTO research_ledger VALUES('old-stake','shadow_A','old-research','STAKE',-2000,2000,?)`, args: [START] });
  await f.db.execute({ sql: `INSERT INTO manual_model_bets VALUES('manual:fixture','shadow_A','manual-match','A','A-fixture','totals','over0.5',2,1500,'{}',?)`, args: [START] });
  await f.db.execute({ sql: `INSERT INTO research_ledger VALUES('stake:manual:fixture','shadow_A',NULL,'STAKE',-1500,1500,?)`, args: [START] });
  const result = await inspectDatabase(f.readonly, { now: NOW });
  assert.deepEqual(result.issues, []); assert.equal(result.accounting.errors, 0);
  assert.equal(result.fundedAccounting.errors, 0); assert.equal(result.paperAccounting.errors, 0);
  const bets = await f.research.listBets(), portfolios = await f.research.listPortfolios(), ledger = await f.research.listLedger();
  assert.equal(bets.length, 8);
  assert.deepEqual(researchCriticalIncidents({ now: START, schedulerEnabled: false, runs: [], models: [], markets: [], jobs: [], portfolios, bets, ledger }), []);
});

test('funded settlement without its ledger event and inconsistent returned cents are independently detected', async t => {
  const f = await setup(t), committed = await f.commit(), bet = committed.bets[0];
  await f.db.execute({ sql: 'INSERT INTO funded_model_settlements VALUES(?,?,?,?,?)', args: [bet.id, 2.01, Math.round(bet.stakeCents * 2.01), '{"status":"WON"}', '2026-11-07T21:00:00Z'] });
  assert.ok((await inspectFundedAccounting(f.readonly)).failures.includes(`${bet.id}:settlement_ledger`));
  const corruptRead = { execute: async query => {
    const result = await f.readonly.execute(query), sql = typeof query === 'string' ? query : query.sql;
    return sql.startsWith('SELECT s.*,b.id AS existing_bet') ? { ...result, rows: result.rows.map(row => ({ ...row, return_cents: 1 })) } : result;
  } };
  assert.ok((await inspectFundedAccounting(corruptRead)).failures.includes(`${bet.id}:settlement`));
});
