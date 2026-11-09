'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const {randomUUID}=require('node:crypto');
const os=require('node:os'); const path=require('node:path');
const {inspect,buildPlan,applyPlan}=require('../scripts/prune-obsolete-challenger');
const {CURRENT_CHALLENGER_RELEASE:r}=require('../dist/research/CurrentChallengerRelease');
const artifact=require('../current-models/challenger.json');
async function fixture(){
 const database=path.join(os.tmpdir(),`prune-${randomUUID()}.db`); const db=createClient({url:'file:'+database}); db.fixturePath=database;
 for(const t of ['research_decisions','research_execution_decisions','research_bets','research_prospective_observations','manual_model_archives','paper_model_bets','funded_model_bets','dynamic_model_bets']) await db.execute(`CREATE TABLE ${t}(id TEXT PRIMARY KEY,family TEXT,value TEXT)`);
 for(const t of ['research_inputs','research_execution_inputs','research_jobs','research_execution_jobs','research_execution_policies','research_portfolios','research_worker_state','research_settlements','paper_model_settlements','paper_model_bet_cancellations','funded_model_settlements','funded_model_bet_cancellations','dynamic_model_settlements','research_prospective_results','research_prospective_invalidations','challenger_candidate_reviews','challenger_paired_forecasts','challenger_forecast_results']) await db.execute(`CREATE TABLE ${t}(id TEXT PRIMARY KEY,value TEXT)`);
 for(const t of ['research_monitor_incidents','research_notifications']) await db.execute(`CREATE TABLE ${t}(incident_key TEXT)`);
 await db.execute('CREATE TABLE scheduler_runs(id TEXT,scheduler_name TEXT,summary_json TEXT)');
 await db.execute('CREATE TABLE research_bet_cancellations(id TEXT,bet_json TEXT)');
 await db.execute('CREATE TABLE research_model_events(id TEXT,family TEXT)');
 await db.execute('CREATE TABLE research_champions(id TEXT,family TEXT)');
 await db.execute('CREATE TABLE research_models(family TEXT,version TEXT,artifact_json TEXT,artifact_hash TEXT,PRIMARY KEY(family,version))');
 await db.execute('CREATE TABLE research_markets(family TEXT,model_version TEXT,market TEXT,FOREIGN KEY(family,model_version) REFERENCES research_models(family,version))');
 await db.execute('CREATE TABLE research_market_events(id TEXT,family TEXT,model_version TEXT)');
 await db.execute('CREATE TABLE research_benchmarks(id TEXT,family TEXT,model_version TEXT)');
 await db.execute('CREATE TABLE challenger_candidates(id TEXT,model_version TEXT,reference_version TEXT)');
 await db.execute('CREATE TABLE challenger_adoption_events(sequence INTEGER PRIMARY KEY,action TEXT,candidate_id TEXT,deployment_json TEXT)');
 await db.execute('CREATE TABLE manual_model_bets(id TEXT PRIMARY KEY,family TEXT,model_version TEXT,stake_cents INTEGER)');
 await db.execute('CREATE TABLE manual_model_settlements(bet_id TEXT PRIMARY KEY REFERENCES manual_model_bets(id),return_cents INTEGER)');
 await db.execute('CREATE TABLE research_ledger(id TEXT PRIMARY KEY,portfolio_id TEXT,bet_id TEXT,event TEXT,available_delta_cents INTEGER,committed_delta_cents INTEGER,created_at TEXT)');
 for(const [name,table] of Object.entries({challenger_adoption_no_delete:'challenger_adoption_events',challenger_candidates_no_delete:'challenger_candidates',manual_model_bets_immutable_delete:'manual_model_bets',manual_model_settlements_immutable_delete:'manual_model_settlements',research_benchmarks_immutable_delete:'research_benchmarks',research_ledger_immutable_delete:'research_ledger',research_market_events_immutable_delete:'research_market_events',research_models_immutable_delete:'research_models'})) await db.execute(`CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END`);
 await db.execute({sql:"INSERT INTO research_models VALUES('C',?,?,?),('C','C-old','{}','old'),('A','A-keep','{}','a')",args:[r.modelVersion,JSON.stringify(artifact),r.artifactHash]});
 await db.execute({sql:"INSERT INTO research_markets VALUES('C',?,'shots'),('C','C-old','shots'),('A','A-keep','shots')",args:[r.modelVersion]});
 await db.execute("INSERT INTO research_market_events VALUES('old','C','C-old'),('a','A','A-keep')");
 await db.execute("INSERT INTO research_benchmarks VALUES('old','C','C-old'),('a','A','A-keep')");
 await db.execute("INSERT INTO challenger_candidates VALUES('old','C-old','C-other')");
 await db.execute({sql:"INSERT INTO challenger_adoption_events VALUES(1,'ADOPT',NULL,'{}'),(2,'ADOPT',NULL,?)",args:[JSON.stringify(r)]});
 await db.execute("INSERT INTO manual_model_bets VALUES('manual:old','C','C-old',100),('manual:a','A','A-keep',5)");
 await db.execute("INSERT INTO manual_model_settlements VALUES('manual:old',150),('manual:a',7)");
 await db.execute("INSERT INTO research_ledger VALUES('open:shadow_C','shadow_C',NULL,'OPEN',1000,0,'old'),('stake:manual:old','shadow_C',NULL,'STAKE',-100,100,'old'),('settle:manual:old','shadow_C',NULL,'SETTLE',150,-100,'old'),('open:shadow_A','shadow_A',NULL,'OPEN',999,0,'old')");
 await db.execute("INSERT INTO research_inputs VALUES('shared','preserve')");
 await db.execute({sql:"INSERT INTO scheduler_runs VALUES('old','research_model_check',?),('a','research_model_check',?)",args:[JSON.stringify({family:'C',modelVersion:'C-old'}),JSON.stringify({family:'A',modelVersion:'A-keep'})]});
 return db;
}
test('preserves A and current release, resets C to 1000 euros, restores immutable guards and is idempotent',async()=>{
 const db=await fixture(); try {const plan=await buildPlan(db,{kind:'test'}); await applyPlan(db,plan);
 const state=await inspect(db); assert.equal(state.balance,100000); assert.equal(state.counts.obsoleteModels,0); assert.equal(state.counts.obsoleteScheduler,0);
 assert.equal((await db.execute("SELECT count(*) AS n FROM scheduler_runs WHERE id='a'")).rows[0].n,1); assert.equal(state.counts.bets,0);
 assert.equal((await db.execute("SELECT value FROM research_inputs WHERE id='shared'")).rows[0].value,'preserve');
 assert.equal((await db.execute("SELECT count(*) AS n FROM manual_model_bets WHERE family='A'")).rows[0].n,1);
 assert.equal((await db.execute("SELECT count(*) AS n FROM research_models WHERE family='C'")).rows[0].n,1);
 await assert.rejects(db.execute("DELETE FROM research_models WHERE family='C'"),/immutable/);
 const createdAt=(await db.execute("SELECT created_at FROM research_ledger WHERE portfolio_id='shadow_C'")).rows[0].created_at;
 const second=await buildPlan(db,{kind:'test'}); await applyPlan(db,second); assert.equal((await inspect(db)).balance,100000);
 assert.equal((await db.execute("SELECT created_at FROM research_ledger WHERE portfolio_id='shadow_C'")).rows[0].created_at,createdAt);
 }finally{db.close();}
});
test('rejects changed plan, unsettled bets and ledger mismatch without mutation',async()=>{
 const db=await fixture(); try {const plan=await buildPlan(db,{kind:'test'}); await db.execute("INSERT INTO research_inputs VALUES('new','change')"); await assert.rejects(applyPlan(db,plan),/planned_state_changed/);
 assert.equal((await db.execute("SELECT count(*) AS n FROM manual_model_bets WHERE family='C'")).rows[0].n,1);
 await db.execute("DELETE FROM research_inputs WHERE id='new'"); await db.execute("UPDATE research_ledger SET available_delta_cents=151 WHERE id='settle:manual:old'"); await assert.rejects(buildPlan(db,{kind:'test'}),/ledger_bet_mismatch/);
 await db.execute("UPDATE research_ledger SET available_delta_cents=150 WHERE id='settle:manual:old'");
 await db.execute('DROP TRIGGER manual_model_settlements_immutable_delete'); await db.execute("DELETE FROM manual_model_settlements WHERE bet_id='manual:old'");
 await assert.rejects(buildPlan(db,{kind:'test'}),/current_or_unsettled_manual_bet/);
 }finally{db.close();}
});

test('rejects a verified but mismatched backup before creating a receipt',async()=>{
 const fs=require('node:fs'), crypto=require('node:crypto'); const db=await fixture(), database=db.fixturePath;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prune-backup-')); const plan=await buildPlan(db,{kind:'local',file:database});
 await db.execute("INSERT INTO research_inputs VALUES('after-plan','changed')"); db.close();
 fs.copyFileSync(database,path.join(dir,'restore.db')); fs.writeFileSync(path.join(dir,'database.sql'),'fixture');
 const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 const manifest={complete:true,startedAt:new Date().toISOString(),verification:{readable:true,foreignKeyViolations:0,integrity:['ok'],databaseSha256:digest(path.join(dir,'restore.db'))},dump:{sha256:digest(path.join(dir,'database.sql'))}};
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest)); fs.writeFileSync(path.join(dir,'plan.json'),JSON.stringify(plan));
 const {main}=require('../scripts/prune-obsolete-challenger');
 await assert.rejects(main(['--apply',path.join(dir,'plan.json'),'--database',database,'--expected-plan-hash',plan.planHash,'--backup-manifest',path.join(dir,'manifest.json'),'--receipt',path.join(dir,'receipt.json')]),/backup_state_mismatch/);
 assert.equal(fs.existsSync(path.join(dir,'receipt.json')),false);
});
