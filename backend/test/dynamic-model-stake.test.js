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
const migrations = async f => { for (const name of ['028_paper_model_bets.sql','029_funded_model_bets.sql','030_dynamic_model_bets.sql'])
  await f.client.executeMultiple(readFileSync(join(__dirname, '../migrations', name), 'utf8')); };
const policyFor = () => { const state = fallbackChallengerState(); state.deployment.modelVersion = 'C-fixture'; return fundedExecutionPolicy(state); };
function withSelections(f, job) {
  const value = prepared(f, job); const original = value.inputSnapshot.quotes[0];
  const quotes = ['home','draw','away'].map((side, i) => ({ ...original, side, selection: ['homeWin','draw','awayWin'][i] }));
  value.inputSnapshot.quotes = quotes;
  for (const d of value.decisions) d.selections = quotes.map((quote, i) => ({ market: quote.market, selection: quote.selection,
    selectionKey: paperSelectionKey(quote), quote, probability: .6, ev: .2, confidence: ['LOW','MEDIUM','HIGH'][i], suggestedStakePercent: 1.53 }));
  return value;
}
const { dynamicFundedExecutionPolicy } = require('../dist/research/ResearchRecommendationPolicy');
const { allocateDynamicStakes } = require('../dist/research/DynamicModelStake');
const dynamicPolicy = () => { const state=fallbackChallengerState(); state.deployment.modelVersion='C-fixture'; return dynamicFundedExecutionPolicy(state); };
test('model percentages calculate whole stakes from opening equity and only available funds constrain allocation',async()=>{
 const f=await setup({matches:1}); try {await migrations(f); f.policy=await f.execution.registerPolicy(dynamicPolicy());
  for (const family of ['A','C']) await f.client.execute({sql:"INSERT INTO research_ledger(id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at) VALUES (?,?,NULL,'STAKE',?,?,?)",args:['seed-'+family,'shadow_'+family,-10000,10000,START]});
  const job=(await claim(f)).jobs[0], data=withSelections(f,job);
  for (const d of data.decisions) d.selections.forEach((c,i)=>c.suggestedStakePercent=[0.84,1.72,3.72][i]);
  const result=await f.execution.commitBatch([data]); assert.equal(result.bets.length,6);
  for (const family of ['A','C']) { const bets=result.bets.filter(b=>b.family===family);
   assert.deepEqual(bets.map(b=>b.stakeCents).sort((a,b)=>a-b),[840,1720,3720]);
   assert.ok(bets.every(b=>b.snapshot.baseEquityCents===100000 && b.snapshot.suggestedStakePercent===b.snapshot.stakePercent));
   assert.equal((await f.research.listPortfolios()).find(x=>x.family===family).availableCents,83720);
  }
  assert.equal((await f.execution.commitBatch([data])).bets.length,6);
  const bet=result.bets[0]; assert.equal((await f.research.settleBet(bet.id,0,{status:'LOST'})).settled,true);
  assert.equal((await f.research.settleBet(bet.id,0,{status:'LOST'})).settled,false);
  assert.equal((await f.research.listBets()).length,6);
  assert.ok((await f.execution.listDecisionViews({matchId:job.matchId})).every(x=>x.betId?.startsWith('dynamic:')));
  assert.equal((await f.execution.getRunMetrics(RUN)).registeredBets,6);
  assert.equal((await f.execution.getComparisonDecisionPairs({from:'2026-10-29T00:00:00.000Z',to:END})).comparedCount,1);
 } finally {await f.close();}
});
test('percent precision, zero and balance limits reject rather than alter the proposed stake',()=>{
 const r=allocateDynamicStakes([{key:'a',confidence:'HIGH',suggestedStakePercent:1.53},{key:'b',confidence:'LOW',suggestedStakePercent:3},
  {key:'c',confidence:'HIGH',suggestedStakePercent:1.531},{key:'d',suggestedStakePercent:0}],2000,100000);
 assert.equal(r.find(x=>x.key==='a').stakeCents,1530); assert.equal(r.find(x=>x.key==='b').reason,'insufficient_available_balance');
 assert.equal(r.find(x=>x.key==='c').reason,'invalid_suggested_stake_percent'); assert.equal(r.find(x=>x.key==='d').reason,'invalid_suggested_stake_percent');
});

test('switching policy never repeats an existing fixed-confidence semantic selection',async()=>{
 const f=await setup({matches:1}); try {await migrations(f); f.policy=await f.execution.registerPolicy(policyFor());
  const first=await f.execution.commitBatch([withSelections(f,(await claim(f)).jobs[0])]); assert.equal(first.bets.length,6);
  const before=JSON.stringify(await f.research.listLedger()); f.policy=await f.execution.registerPolicy(dynamicPolicy());
  const result=await f.execution.commitBatch([withSelections(f,(await claim(f)).jobs[0])]); assert.equal(result.bets.length,0);
  assert.equal(JSON.stringify(await f.research.listLedger()),before);
 } finally {await f.close();}
});

test('fixed pending cancellations refund exactly once, preserve evidence, and permit dynamic replacement',async()=>{
 const f=await setup({matches:1}); try {await migrations(f); f.policy=await f.execution.registerPolicy(policyFor());
  const fixed=await f.execution.commitBatch([withSelections(f,(await claim(f)).jobs[0])]); assert.equal(fixed.bets.length,6);
  const originals=JSON.stringify((await f.client.execute('SELECT * FROM funded_model_bets ORDER BY id')).rows);
  const opening=(await f.research.listPortfolios()).map(x=>[x.id,x.availableCents,x.committedCents]);
  await f.client.executeMultiple(readFileSync(join(__dirname,'../migrations/031_dynamic_funded_cancellations.sql'),'utf8'));
  for(const bet of fixed.bets) await f.client.execute({sql:'INSERT INTO funded_model_bet_cancellations VALUES (?,?,?)',args:[bet.id,START,'replace with dynamic policy']});
  assert.equal(JSON.stringify((await f.client.execute('SELECT * FROM funded_model_bets ORDER BY id')).rows),originals);
  const wallets=await f.research.listPortfolios(); for(const w of wallets) { assert.equal(w.availableCents,100000); assert.equal(w.committedCents,0); }
  assert.notDeepEqual(wallets.map(x=>[x.id,x.availableCents,x.committedCents]),opening);
  assert.equal((await f.research.listBets()).length,0); assert.equal((await f.execution.getRunMetrics(RUN)).registeredBets,0);
  assert.equal((await f.execution.listDecisionViews({matchId:f.fixtures[0].matchId})).length,0);
  await assert.rejects(f.research.settleBet(fixed.bets[0].id,0,{status:'LOST'}),/Cancelled/);
  await assert.rejects(f.client.execute({sql:'INSERT INTO funded_model_bet_cancellations VALUES (?,?,?)',args:[fixed.bets[0].id,START,'duplicate']}));
  assert.equal(Number((await f.client.execute("SELECT COUNT(*) AS n FROM research_ledger WHERE id LIKE 'cancel:funded:%'")).rows[0].n),6);
  f.policy=await f.execution.registerPolicy(dynamicPolicy()); const result=await f.execution.commitBatch([withSelections(f,(await claim(f)).jobs[0])]);
  assert.equal(result.bets.length,6); assert.ok(result.bets.every(x=>x.id.startsWith('dynamic:')));
 } finally {await f.close();}
});

test('cancellation rejects finished and settled bets and rolls back a partial refund batch',async()=>{
 const f=await setup({matches:1}); try {await migrations(f); f.policy=await f.execution.registerPolicy(policyFor());
  const fixed=await f.execution.commitBatch([withSelections(f,(await claim(f)).jobs[0])]);
  await f.client.executeMultiple(readFileSync(join(__dirname,'../migrations/031_dynamic_funded_cancellations.sql'),'utf8'));
  await f.research.settleBet(fixed.bets[1].id,0,{status:'LOST'});
  const balance=JSON.stringify(await f.research.listPortfolios());
  await assert.rejects(f.research.runResearchTransaction(async tx=>{
   for(const bet of fixed.bets.slice(0,2)) await tx.execute({sql:'INSERT INTO funded_model_bet_cancellations VALUES (?,?,?)',args:[bet.id,START,'transition']});
  }),/authorization mismatch/);
  assert.equal(JSON.stringify(await f.research.listPortfolios()),balance);
  assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM funded_model_bet_cancellations')).rows[0].n),0);
  await f.client.execute({sql:'UPDATE matches SET home_goals=0,away_goals=0 WHERE match_id=?',args:[f.fixtures[0].matchId]});
  await assert.rejects(f.client.execute({sql:'INSERT INTO funded_model_bet_cancellations VALUES (?,?,?)',args:[fixed.bets[0].id,START,'transition']}),/authorization mismatch/);
 } finally {await f.close();}
});
