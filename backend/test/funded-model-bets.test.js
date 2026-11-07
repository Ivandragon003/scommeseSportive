const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');

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


const { fundedExecutionPolicy, fallbackChallengerState } = require('../dist/research/ResearchRecommendationPolicy');
const { paperSelectionKey } = require('../dist/research/PaperBetSelections');
const migrations = async f => { for (const name of ['028_paper_model_bets.sql','029_funded_model_bets.sql'])
  await f.client.executeMultiple(readFileSync(join(__dirname, '../migrations', name), 'utf8')); };
const policyFor = () => { const state = fallbackChallengerState(); state.deployment.modelVersion = 'C-fixture'; return fundedExecutionPolicy(state); };
function withSelections(f, job) {
  const value = prepared(f, job); const original = value.inputSnapshot.quotes[0];
  const quotes = ['home','draw','away'].map((side, i) => ({ ...original, side, selection: ['homeWin','draw','awayWin'][i] }));
  value.inputSnapshot.quotes = quotes;
  for (const d of value.decisions) d.selections = quotes.map((quote, i) => ({ market: quote.market, selection: quote.selection,
    selectionKey: paperSelectionKey(quote), quote, probability: .6, ev: .2, confidence: ['LOW','MEDIUM','HIGH'][i] }));
  return value;
}
test('funded batch debits three confidence stakes per family from initial available balance, replays and settles idempotently', async () => {
 const f = await setup({matches:1}); try {
  await migrations(f); f.policy = await f.execution.registerPolicy(policyFor());
  const job = (await claim(f)).jobs[0], commit = withSelections(f, job);
  const initial = Object.fromEntries((await f.research.listPortfolios()).map(x => [x.id,x.availableCents]));
  const result = await f.execution.commitBatch([commit]); assert.equal(result.bets.length,6);
  for (const family of ['A','C']) {
   const own=result.bets.filter(x=>x.family===family), base=initial['shadow_'+family];
   assert.deepEqual(own.map(x=>x.stakeCents).sort((a,b)=>a-b),[1,3,5].map(p=>Math.floor(base*p/100)));
   const wallet=(await f.research.listPortfolios()).find(x=>x.id==='shadow_'+family);
   assert.equal(wallet.availableCents,base-own.reduce((s,x)=>s+x.stakeCents,0));
  }
  assert.equal((await f.execution.commitBatch([commit])).bets.length,6);
  const bet=result.bets[0], evidence={status:'LOST'};
  assert.equal((await f.research.settleBet(bet.id,0,evidence)).settled,true);
  assert.equal((await f.research.settleBet(bet.id,0,evidence)).settled,false);
  assert.equal((await f.research.listBets()).filter(x=>x.id===bet.id).length,1);
 } finally { await f.close(); }
});

test('insufficient funds skip whole stakes and leave the balance nonnegative', async () => {
 const f=await setup({matches:1}); try { await migrations(f); f.policy=await f.execution.registerPolicy(policyFor());
  for (const family of ['A','C']) {
   const balance=(await f.research.listPortfolios()).find(x=>x.id==='shadow_'+family).availableCents;
   await f.client.execute({sql:"INSERT INTO research_ledger(id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at) VALUES (?,?,NULL,'STAKE',?,?,?)",args:['fixture-debit-'+family,'shadow_'+family,-balance+1,balance-1,START]});
  }
  const result=await f.execution.commitBatch([withSelections(f,(await claim(f)).jobs[0])]);
  assert.equal(result.bets.length,0); assert.ok((await f.research.listPortfolios()).every(x=>x.availableCents>=0));
 } finally { await f.close(); }
});

test('expired quotes do not debit and a failed ledger write rolls back the batch', async () => {
 const f=await setup({matches:2}); try { await migrations(f); f.policy=await f.execution.registerPolicy(policyFor());
  const jobs=(await claim(f, f.fixtures, { leaseMs: 900000 })).jobs, expired=withSelections(f,jobs[0]); f.setTime('2026-10-30T12:36:00.000Z');
  const result=await f.execution.commitBatch([expired]); assert.equal(result.bets.length,0);
  const pending=withSelections(f,jobs[1]);
  await f.client.execute("CREATE TRIGGER fail_funded_stake BEFORE INSERT ON research_ledger WHEN NEW.id LIKE 'stake:funded:%' BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  await assert.rejects(f.execution.commitBatch([pending]),/test rollback/);
  assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM funded_model_bets')).rows[0].n),0);
  assert.equal(Number((await f.client.execute({sql:'SELECT COUNT(*) AS n FROM research_execution_inputs WHERE job_id=?',args:[jobs[1].id]})).rows[0].n),0);
 } finally { await f.close(); }
});

test('two database clients cannot duplicate funded bets on replay', async () => {
 const f=await setup({matches:1}); let other; try { await migrations(f); f.policy=await f.execution.registerPolicy(policyFor());
  const job=(await claim(f)).jobs[0], commit=withSelections(f,job);
  other=createClient({url:`file:${f.path}`}); const store=new ResearchRecommendationStore(other,async()=>{},{now:f.clock});
  const results=await Promise.allSettled([f.execution.commitBatch([commit]),store.commitBatch([commit])]);
  assert.ok(results.some(x=>x.status==='fulfilled'));
  assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM funded_model_bets')).rows[0].n),6);
 } finally { other?.close(); await f.close(); }
});


test('paper cancellation hides history from totals and settlement without mutating evidence', async () => {
 const f=await setup({matches:1}); try { await migrations(f);
  const {paperExecutionPolicy}=require('../dist/research/ResearchRecommendationPolicy');
  const state=fallbackChallengerState(); state.deployment.modelVersion='C-fixture';
  f.policy=await f.execution.registerPolicy(paperExecutionPolicy(state));
  const result=await f.execution.commitBatch([withSelections(f,(await claim(f)).jobs[0])]); assert.equal(result.bets.length,6);
  const id=result.bets[0].id;
  await f.client.execute({sql:'INSERT INTO paper_model_bet_cancellations(bet_id,cancelled_at,reason) VALUES (?,?,?)',args:[id,START,'superseded by funded execution']});
  assert.equal((await f.execution.listPaperBets()).length,5);
  assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM paper_model_bets')).rows[0].n),6);
  const {settlePaperBet}=require('../dist/research/PaperModelBetLedger');
  await assert.rejects(f.research.runResearchTransaction(tx=>settlePaperBet(tx,id,0,{status:'LOST'})),/Cancelled/);
  await assert.rejects(f.client.execute({sql:'DELETE FROM paper_model_bet_cancellations WHERE bet_id=?',args:[id]}),/immutable/);
 } finally { await f.close(); }
});

for (const kind of ['manual', 'research']) test(`${kind} prior selection blocks only the matching funded selection without consuming allocation`, async () => {
 const f=await setup({matches:1}); try { await migrations(f);
  await f.client.executeMultiple(readFileSync(join(__dirname,'../migrations/026_manual_model_bets.sql'),'utf8'));
  const quote={market:'1x2',selection:'homeWin',side:'home',odds:2,source:'odds_api',bookmaker:'B',priceType:'prematch',capturedAt:START,updatedAt:START};
  if (kind==='manual') await f.client.execute({sql:`INSERT INTO manual_model_bets(id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,snapshot_json,placed_at)
    VALUES ('manual:old','shadow_A',?,'A','A-app-fixture','1x2','homeWin',2,100,?,?)`,args:[f.fixtures[0].matchId,JSON.stringify({quote}),START]});
  else await f.client.execute({sql:`INSERT INTO research_bets(id,decision_id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,snapshot_json,placed_at)
    VALUES ('old','origin-decision-0-A','shadow_A',?,'A','A-app-fixture','1x2','homeWin',2,100,?,?)`,args:[f.fixtures[0].matchId,JSON.stringify({quote}),START]});
  f.policy=await f.execution.registerPolicy(policyFor()); const job=(await claim(f)).jobs[0];
  const result=await f.execution.commitBatch([withSelections(f,job)]), own=result.bets.filter(x=>x.family==='A');
  assert.equal(result.bets.length,5); assert.equal(own.some(x=>x.selection==='homeWin'),false);
  assert.deepEqual(own.map(x=>x.snapshot.stakePercent).sort((a,b)=>a-b),[3,5]);
  assert.equal(result.decisions.find(x=>x.family==='A').rejectedSelections[0].reason,'historical_selection_already_recorded');
 } finally { await f.close(); }
});

test('active paper selection aborts before freezing evidence; cancellation permits a retry', async () => {
 const f=await setup({matches:1}); try { await migrations(f);
  const {paperExecutionPolicy}=require('../dist/research/ResearchRecommendationPolicy');
  const state=fallbackChallengerState(); state.deployment.modelVersion='C-fixture';
  f.policy=await f.execution.registerPolicy(paperExecutionPolicy(state));
  const paper=await f.execution.commitBatch([withSelections(f,(await claim(f)).jobs[0])]); assert.equal(paper.bets.length,6);
  f.policy=await f.execution.registerPolicy(policyFor()); const job=(await claim(f)).jobs[0], commit=withSelections(f,job);
  await assert.rejects(f.execution.commitBatch([commit]),/active_paper_selection_requires_cancellation/);
  assert.equal(Number((await f.client.execute({sql:'SELECT COUNT(*) AS n FROM research_execution_inputs WHERE job_id=?',args:[job.id]})).rows[0].n),0);
  assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM funded_model_bets')).rows[0].n),0);
  for (const bet of paper.bets) await f.client.execute({sql:'INSERT INTO paper_model_bet_cancellations VALUES (?,?,?)',args:[bet.id,START,'transition']});
  assert.equal((await f.execution.commitBatch([commit])).bets.length,6);
 } finally { await f.close(); }
});

test('decision and comparison views expose one representative funded bet while wallet retains every selection', async () => {
 const f=await setup({matches:1}); try { await migrations(f); f.policy=await f.execution.registerPolicy(policyFor());
  const commit=withSelections(f,(await claim(f)).jobs[0]); commit.decisions.find(x=>x.family==='C').selections=commit.decisions.find(x=>x.family==='C').selections.slice(0,1);
  const result=await f.execution.commitBatch([commit]); assert.equal(result.bets.length,4);
  const views=await f.execution.listDecisionViews({matchId:f.fixtures[0].matchId}); assert.equal(views.length,2);
  for (const view of views) {
   const bet=result.bets.find(x=>x.id===view.betId); assert.ok(bet); assert.equal(view.betStatus,'PENDING');
   assert.equal(view.betStakeCents,bet.stakeCents); assert.equal(view.selection,bet.selection);
  }
  const comparison=await f.execution.getComparisonDecisionPairs({from:'2026-10-29T00:00:00.000Z',to:END});
  assert.equal(comparison.comparedCount,1); assert.equal(comparison.pairs.length,1);
  for (const family of ['A','C']) assert.ok(result.bets.some(x=>x.id===comparison.pairs[0][family].betId));
  assert.equal((await f.research.listBets()).length,4);
 } finally { await f.close(); }
});
