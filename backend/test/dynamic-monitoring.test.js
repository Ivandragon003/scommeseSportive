const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');
const { fundedExecutionPolicy, dynamicFundedExecutionPolicy, fallbackChallengerState } = require('../dist/research/ResearchRecommendationPolicy');
const { paperSelectionKey } = require('../dist/research/PaperBetSelections');
const { inspectFundedAccounting, inspectDynamicAccounting, researchCriticalIncidents } = require('../dist/research/ResearchMonitoring');
const { inspectDatabase } = require('../scripts/check-research-nightly');
const START = '2026-11-07T10:00:00.000Z', KICKOFF = '2026-11-07T19:00:00.000Z', END = '2026-11-08T02:07:00.000Z';
const NOW = new Date('2026-11-08T09:00:00Z');

async function setup(t, { migrateDynamic = true, migrateCancellation = true } = {}) {
  const path = join(tmpdir(), `dynamic-monitoring-${process.pid}-${randomUUID()}.db`);
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
    '029_funded_model_bets.sql', ...(migrateDynamic ? ['030_dynamic_model_bets.sql'] : []),
    ...(migrateCancellation ? ['031_dynamic_funded_cancellations.sql'] : [])]) {
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
  async function commit(policy = dynamicFundedExecutionPolicy(state), confidence = ['MEDIUM', 'MEDIUM', 'MEDIUM'], selectionOffset = 0, percentages = [1.53, 2.01, 4.37]) {
    const descriptor = await recommendations.registerPolicy(policy);
    const jobs = (await recommendations.claimBatch({ policyHash: descriptor.hash, runId: 'fixture-run', windowStartAt: START, windowEndAt: END,
      fixtures: [{ matchId: 'fixture-match', kickoffAt: KICKOFF }] })).jobs;
    const items = jobs.map(job => {
      const selections = confidence.map((value, index) => {
        const line = selectionOffset + index + .5;
        const quote = { market: 'totals', selection: `over${line}`, side: 'over', line, odds: 2.01,
          source: 'odds_api', bookmaker: 'Fixture bookmaker', priceType: 'prematch', capturedAt: START, updatedAt: START };
        return { market: quote.market, selection: quote.selection, selectionKey: paperSelectionKey(quote), quote,
          probability: .6, ev: .206, confidence: value, suggestedStakePercent: percentages[index] };
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
  return { db, research, recommendations, commit, readonly, state };
}


test('dynamic accounting preserves native percentages on equity and accepts multiple selections beyond five percent', async t => {
  const f = await setup(t);
  await f.commit(fundedExecutionPolicy(f.state), ['MEDIUM', 'MEDIUM', 'MEDIUM']);
  const result = await f.commit(undefined, undefined, 3);
  assert.equal(result.bets.length, 6);
  for (const family of ['A', 'C']) {
    const own = result.bets.filter(bet => bet.family === family);
    assert.deepEqual(own.map(bet => bet.stakeCents).sort((a,b) => a-b), [1530,2010,4370]);
    assert.ok(own.every(bet => bet.snapshot.baseEquityCents === 100000));
  }
  assert.deepEqual((await inspectDynamicAccounting(f.readonly)).failures, []);
  const monitored = await inspectDatabase(f.readonly, { now: NOW });
  assert.deepEqual(monitored.issues, []); assert.equal(monitored.dynamicAccounting.errors, 0);
  const bets = await f.research.listBets(), portfolios = await f.research.listPortfolios(), ledger = await f.research.listLedger();
  assert.equal(bets.length, 12);
  assert.deepEqual(researchCriticalIncidents({ now: START, schedulerEnabled: false, runs: [], models: [], markets: [], jobs: [], portfolios, bets, ledger }), []);
});

test('dynamic schema stays optional before activation and absent or partial after activation cannot be healthy', async t => {
  const f = await setup(t, { migrateDynamic: false });
  assert.equal((await inspectDynamicAccounting(f.readonly)).required, false);
  assert.deepEqual((await inspectDatabase(f.readonly, { now: NOW })).issues, []);
  await f.db.execute("INSERT INTO research_execution_policies VALUES('fixture','funded-dynamic-stake-v1','{}','2026-11-07T00:00:00Z')");
  assert.deepEqual((await inspectDatabase(f.readonly, { now: NOW })).issues, ['dynamic_schema_required']);
  await f.db.execute('CREATE TABLE dynamic_model_bets(id TEXT)');
  assert.deepEqual((await inspectDynamicAccounting(f.readonly)).failures, ['dynamic_schema_required']);
});

test('equal confidence does not replace native model stakes and low model percentages remain precise', async t => {
  const f = await setup(t), result = await f.commit(undefined, undefined, 0, [.01,1.53,4.37]);
  assert.deepEqual(result.bets.filter(bet => bet.family === 'A').map(bet => bet.stakeCents).sort((a,b) => a-b), [10,1530,4370]);
  assert.deepEqual((await inspectDynamicAccounting(f.readonly)).failures, []);
  const corrupt = { execute: async query => {
    const result = await f.readonly.execute(query), sql = typeof query === 'string' ? query : query.sql;
    return sql === 'SELECT * FROM dynamic_model_bets' ? { ...result, rows: result.rows.map(row => ({ ...row, stake_basis_points: 300 })) } : result;
  } };
  assert.ok((await inspectDynamicAccounting(corrupt)).failures.some(value => value.endsWith(':stake')));
});

for (const corruption of ['missing_stake', 'wrong_stake', 'orphan_stake']) test(`dynamic accounting rejects ${corruption}`, async t => {
  const f = await setup(t), result = await f.commit(), id = result.bets[0].id;
  if (corruption === 'missing_stake') {
    await f.db.execute('DROP TRIGGER research_ledger_immutable_delete');
    await f.db.execute({ sql: 'DELETE FROM research_ledger WHERE id=?', args: [`stake:${id}`] });
  } else if (corruption === 'wrong_stake') {
    await f.db.execute('DROP TRIGGER research_ledger_immutable_update');
    await f.db.execute({ sql: 'UPDATE research_ledger SET available_delta_cents=available_delta_cents-1 WHERE id=?', args: [`stake:${id}`] });
  } else await f.db.execute({ sql: "INSERT INTO research_ledger VALUES('stake:dynamic:orphan','shadow_A',NULL,'STAKE',-1,1,?)", args: [START] });
  assert.ok((await inspectDynamicAccounting(f.readonly)).errors > 0);
  assert.ok((await inspectDatabase(f.readonly, { now: NOW })).issues.includes('dynamic_accounting_integrity'));
});

test('dynamic variable-stake settlements release once and match exact returns and committed funds', async t => {
  const f = await setup(t), result = await f.commit(), bet = result.bets[1], evidence = { status: 'HALF_WON', fixture: true };
  const multiplier = (bet.odds + 1) / 2;
  assert.equal((await f.research.settleBet(bet.id, multiplier, evidence)).settled, true);
  const before = JSON.stringify(await f.research.listLedger());
  assert.equal((await f.research.settleBet(bet.id, multiplier, evidence)).settled, false);
  assert.equal(JSON.stringify(await f.research.listLedger()), before);
  assert.deepEqual((await inspectDynamicAccounting(f.readonly)).failures, []);
  assert.deepEqual((await inspectDatabase(f.readonly, { now: NOW })).issues, []);
  await f.db.execute('DROP TRIGGER research_ledger_immutable_update');
  await f.db.execute({ sql: 'UPDATE research_ledger SET committed_delta_cents=committed_delta_cents+1 WHERE id=?', args: [`settle:${bet.id}`] });
  assert.ok((await inspectDynamicAccounting(f.readonly)).failures.includes(`${bet.id}:settlement_ledger`));
});

test('fixed cancellations refund exactly once while preserving immutable evidence and dynamic replacement accounting', async t => {
  const f = await setup(t), fixed = await f.commit(fundedExecutionPolicy(f.state));
  const originals = JSON.stringify((await f.db.execute('SELECT * FROM funded_model_bets ORDER BY id')).rows);
  for (const bet of fixed.bets) await f.db.execute({ sql: 'INSERT INTO funded_model_bet_cancellations VALUES(?,?,?)', args: [bet.id, START, 'User requested replacement with native model stakes'] });
  assert.equal(JSON.stringify((await f.db.execute('SELECT * FROM funded_model_bets ORDER BY id')).rows), originals);
  assert.equal((await f.research.listBets()).length, 0);
  assert.deepEqual((await inspectFundedAccounting(f.readonly)).failures, []);
  assert.deepEqual((await inspectDatabase(f.readonly, { now: NOW })).issues, []);
  await assert.rejects(f.db.execute({ sql: 'INSERT INTO funded_model_bet_cancellations VALUES(?,?,?)', args: [fixed.bets[0].id, START, 'duplicate'] }));
  await assert.rejects(f.research.settleBet(fixed.bets[0].id, 0, { status: 'LOST' }), /Cancelled/);
  const replacement = await f.commit(); assert.equal(replacement.bets.length, 6);
  assert.deepEqual((await inspectDynamicAccounting(f.readonly)).failures, []);
  assert.deepEqual((await inspectDatabase(f.readonly, { now: NOW })).issues, []);
  await f.db.execute("UPDATE matches SET home_goals=1,away_goals=0 WHERE match_id='fixture-match'");
  const monitored = await inspectDatabase(f.readonly, { now: NOW });
  assert.equal(monitored.pendingSettlements, 6); assert.equal(monitored.fundedAccounting.pendingSettlements, 0);
  assert.deepEqual(monitored.issues, ['settlement_backlog']);
});

for (const corruption of ['missing_refund', 'wrong_refund', 'duplicate_refund', 'orphan_refund']) test(`fixed cancellation audit rejects ${corruption} independently`, async t => {
  const f = await setup(t), fixed = await f.commit(fundedExecutionPolicy(f.state)), id = fixed.bets[0].id;
  await f.db.execute({ sql: 'INSERT INTO funded_model_bet_cancellations VALUES(?,?,?)', args: [id, START, 'transition'] });
  const corrupt = { execute: async query => {
    const result = await f.readonly.execute(query), sql = typeof query === 'string' ? query : query.sql;
    if (!sql.startsWith('SELECT * FROM research_ledger WHERE')) return result;
    const target = result.rows.find(row => row.id === `cancel:${id}`);
    if (corruption === 'missing_refund') return { ...result, rows: result.rows.filter(row => row.id !== target.id) };
    if (corruption === 'wrong_refund') return { ...result, rows: result.rows.map(row => row.id === target.id ? { ...row, available_delta_cents: 1 } : row) };
    return { ...result, rows: [...result.rows, { ...target, id: corruption === 'duplicate_refund' ? target.id : 'cancel:funded:orphan' }] };
  } };
  const audit = await inspectFundedAccounting(corrupt);
  assert.ok(audit.errors > 0); assert.ok(audit.failures.some(value => /cancellation_ledger|orphan_ledger/.test(value)), JSON.stringify(audit));
});


test('dynamic audit reconstructs the equity base and available balance independently from the stored claim', async t => {
  const f = await setup(t);
  await f.commit(fundedExecutionPolicy(f.state));
  await f.commit(undefined, undefined, 3);
  const corruptBase = { execute: async query => {
    const result = await f.readonly.execute(query), sql = typeof query === 'string' ? query : query.sql;
    return sql === 'SELECT * FROM dynamic_model_bets' ? { ...result, rows: result.rows.map(row => ({ ...row, base_equity_cents: 91000 })) } : result;
  } };
  assert.ok((await inspectDynamicAccounting(corruptBase)).failures.some(value => value.endsWith(':stake_budget')));
  const overdrawn = { execute: async query => {
    const result = await f.readonly.execute(query), sql = typeof query === 'string' ? query : query.sql;
    return sql === 'SELECT rowid AS ledger_order,* FROM research_ledger ORDER BY rowid'
      ? { ...result, rows: result.rows.map(row => row.event === 'OPEN' ? { ...row, available_delta_cents: 100 } : row) } : result;
  } };
  assert.ok((await inspectDynamicAccounting(overdrawn)).failures.some(value => value.endsWith(':stake_budget')));
});
