const test = require('node:test');
const assert = require('node:assert/strict');
const {createClient} = require('@libsql/client');
const {randomUUID} = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {inspectOperational, resetOperational} = require('../scripts/reset-challenger-history');
const family = ['research_bets','paper_model_bets','funded_model_bets','dynamic_model_bets','manual_model_bets','manual_model_archives','research_prospective_observations','research_execution_decisions','research_decisions'];
async function fixture() {
 const db=createClient({url:'file:' + path.join(os.tmpdir(), 'reset-c-test-' + randomUUID() + '.db')});
 for(const t of family) {
  const extras=t==='research_bets'?'decision_id TEXT,execution_decision_id TEXT,':['paper_model_bets','funded_model_bets','dynamic_model_bets'].includes(t)?'execution_decision_id TEXT,':t==='research_execution_decisions'?'origin_decision_id TEXT,':'';
  await db.execute(`CREATE TABLE ${t}(id TEXT PRIMARY KEY,family TEXT,${extras} value TEXT)`);
  await db.execute(`INSERT INTO ${t}(id,family,value) VALUES('a','A','keep'),('c','C','remove')`);
  await db.execute(`CREATE TRIGGER ${t}_immutable_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`);
 }
 for(const t of ['research_settlements','paper_model_settlements','paper_model_bet_cancellations','funded_model_settlements','funded_model_bet_cancellations','dynamic_model_settlements','manual_model_settlements']) await db.execute(`CREATE TABLE ${t}(bet_id TEXT PRIMARY KEY,value TEXT)`);
 for(const t of ['research_prospective_results','research_prospective_invalidations']) await db.execute(`CREATE TABLE ${t}(observation_id TEXT PRIMARY KEY,value TEXT)`);
 await db.execute('CREATE TABLE research_bet_cancellations(bet_id TEXT PRIMARY KEY,bet_json TEXT)');
 await db.execute('CREATE TABLE research_ledger(id TEXT PRIMARY KEY,portfolio_id TEXT,bet_id TEXT,event TEXT,available_delta_cents INTEGER,committed_delta_cents INTEGER,created_at TEXT)');
 for(const t of ['research_inputs','research_execution_inputs','research_jobs','research_execution_jobs','research_markets','research_portfolios','research_execution_policies']) await db.execute(`CREATE TABLE ${t}(id TEXT PRIMARY KEY,value TEXT)`);
 await db.execute('CREATE TABLE research_models(family TEXT,version TEXT)');
 await db.execute("INSERT INTO research_models VALUES('C','C-test'),('C','C-reference')");
 await db.execute('CREATE TABLE challenger_candidates(id TEXT PRIMARY KEY,model_version TEXT)');
 await db.execute("INSERT INTO challenger_candidates VALUES('candidate','C-test')");
 await db.execute('CREATE TABLE challenger_paired_forecasts(id TEXT PRIMARY KEY,candidate_id TEXT REFERENCES challenger_candidates(id),snapshot_json TEXT,snapshot_hash TEXT)');
 const snapshot={candidate:{modelVersion:'C-test'},reference:{modelVersion:'C-reference'}};
 const {researchHash}=require('../scripts/lib/challenger-archive-reset');
 await db.execute({sql:'INSERT INTO challenger_paired_forecasts VALUES(?,?,?,?)',args:['forecast','candidate',JSON.stringify(snapshot),researchHash(snapshot)]});
 await db.execute('CREATE TABLE challenger_forecast_results(forecast_id TEXT PRIMARY KEY REFERENCES challenger_paired_forecasts(id))');
 await db.execute("INSERT INTO challenger_forecast_results VALUES('forecast')");
 await db.execute('CREATE TABLE challenger_candidate_reviews(candidate_id TEXT PRIMARY KEY)');
 await db.execute('CREATE TABLE challenger_adoption_events(candidate_id TEXT)');
 for (const t of ['challenger_paired_forecasts','challenger_forecast_results']) await db.execute(`CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END`);
 await db.execute({sql:'INSERT INTO research_bet_cancellations VALUES (?,?),(?,?)',args:['a','{"family":"A"}','c','{"family":"C"}']});
 await db.execute("INSERT INTO research_ledger VALUES ('open:shadow_A','shadow_A',NULL,'OPEN',123,0,'old'),('open:shadow_C','shadow_C',NULL,'OPEN',23,0,'old')");
 return db;
}
test('reset preserves A and guards, C balance is 1000 euros',async()=>{
 const db=await fixture();try{const plan=await inspectOperational(db),tx=await db.transaction('write');try{await resetOperational(tx,plan,'2026-11-07T10:00:00.000Z');await tx.commit();}finally{tx.close();}
 assert.equal((await db.execute("SELECT count(*) AS n FROM research_decisions WHERE family='C'")).rows[0].n,0);
 assert.equal((await db.execute('SELECT count(*) AS n FROM challenger_paired_forecasts')).rows[0].n,0);
 assert.equal((await db.execute('SELECT count(*) AS n FROM challenger_candidates')).rows[0].n,1);
 assert.equal((await db.execute("SELECT value FROM research_decisions WHERE family='A'")).rows[0].value,'keep');
 assert.equal((await db.execute("SELECT available_delta_cents FROM research_ledger WHERE portfolio_id='shadow_C'")).rows[0].available_delta_cents,100000);
 await assert.rejects(db.execute("DELETE FROM research_decisions WHERE family='A'"),/immutable/);
 }finally{db.close();}
});
test('changed plan rejects all mutation',async()=>{
 const db=await fixture();try{const plan=await inspectOperational(db);await db.execute("INSERT INTO research_decisions(id,family,value) VALUES('new','C','new')");const tx=await db.transaction('write');try{await assert.rejects(resetOperational(tx,plan,'2026-11-07T10:00:00.000Z'),/operational_plan_changed/);await tx.rollback();}finally{tx.close();}
 assert.equal((await db.execute("SELECT count(*) AS n FROM research_decisions WHERE family='C'")).rows[0].n,2);
 }finally{db.close();}
});

require('ts-node/register');
const {challengerHistoryCutoff,predatesChallengerReset} = require('../src/research/ChallengerHistoryReset');
test('cutoff prevents pre-reset replay and rejects malformed markers',async()=>{
 const absent={execute:async()=>({rows:[]})};
 assert.equal(await challengerHistoryCutoff(absent),null);
 let payload=JSON.stringify({cutoff:'2026-11-07T10:00:00.000Z'});
 const db={execute:async query=>({rows: typeof query==='string'?[{name:'research_worker_state'}]:[{last_tick_json:payload}]})};
 const cutoff=await challengerHistoryCutoff(db);
 assert.equal(predatesChallengerReset('2026-11-07T10:00:00.000Z',cutoff),true);
 assert.equal(predatesChallengerReset('2026-11-07T10:00:00.001Z',cutoff),false);
 payload='{}';await assert.rejects(challengerHistoryCutoff(db),/Invalid challenger history reset marker/);
});

test('paired forecasts linked to adoption review cannot be removed',async()=>{
 const db=await fixture();try{await db.execute("INSERT INTO challenger_candidate_reviews VALUES('candidate')");await assert.rejects(inspectOperational(db),/paired_forecasts_required_by_adoption_or_unknown_model/);assert.equal((await db.execute('SELECT count(*) AS n FROM challenger_paired_forecasts')).rows[0].n,1);}finally{db.close();}
});
