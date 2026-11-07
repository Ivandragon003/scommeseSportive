'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createClient}=require('@libsql/client');const tool=require('../scripts/reconcile-official-kickoff');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kickoff-review-')),file=path.join(dir,'fixture.db'),db=createClient({url:`file:${file}`});
 await db.execute(`CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,competition TEXT,season TEXT,home_team_name TEXT,away_team_name TEXT,home_goals INTEGER,away_goals INTEGER,home_xg REAL,away_xg REAL,home_shots INTEGER,away_shots INTEGER,home_shots_on_target INTEGER,away_shots_on_target INTEGER,home_fouls INTEGER,away_fouls INTEGER,home_corners INTEGER,away_corners INTEGER,home_yellow_cards INTEGER,away_yellow_cards INTEGER,home_red_cards INTEGER,away_red_cards INTEGER,referee TEXT,raw_json TEXT)`);
 await db.execute('CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
 await db.executeMultiple(fs.readFileSync(path.join(__dirname,'../migrations/034_final_observations.sql'),'utf8'));
 await db.execute({sql:'INSERT INTO matches(match_id,date,competition,season,home_team_name,away_team_name,home_goals,away_goals,home_shots,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)',args:['understat_32010','2026-10-24T15:15:00.000Z','Fixture League','2026/2027','Home','Away',0,0,4,'{"number":1.00,"dup":1,"dup":2,"fieldProvenance":{"other":{"source":"old"},"date":{"source":"prior"}}}']});
 await db.execute({sql:'INSERT INTO final_observations(match_id,field,value,source,evidence_json,evidence_sha256) VALUES(?,?,?,?,?,?)',args:['understat_32010','home_goals',0,'fixture','{}',hash('{}')]});
 const doc=path.join(dir,'evidence.txt');fs.writeFileSync(doc,'fixture only');const hosts=path.join(dir,'hosts.json');fs.writeFileSync(hosts,JSON.stringify(['one.example.test','two.example.test','three.example.test']));
 const m={format:'official-kickoff-review-v1',reviewedAt:'2026-11-07T00:00:00.000Z',matchId:'understat_32010',expectedDate:'2026-10-24T15:15:00.000Z',officialDate:'2026-10-25T16:15:00.000Z',identity:{competition:'Fixture League',season:'2026/2027',home:'Home',away:'Away',homeGoals:0,awayGoals:0},documents:[0,1,2].map(i=>({url:`https://${['one','two','three'][i]}.example.test/${i}`,file:doc,sha256:hash(fs.readFileSync(doc)),acquiredAt:'2026-11-07T00:00:00.000Z'})),evidence:{definition:'fixture',label:'fixture',jsonPath:'$.fixture',snippet:'fixture'}};
 const manifest=path.join(dir,'manifest.json');fs.writeFileSync(manifest,JSON.stringify(m));const evidence=tool.validateEvidence(manifest,hosts);
 return {dir,file,db,m,doc,hosts,manifest,evidence,target:{kind:'local',file}};
}
test('date, immutable proof and migration commit together while preserving old observations and raw source',async()=>{
 const f=await setup();try{const plan=await tool.snapshot(f.db,f.evidence,f.target,'2026-11-07T00:00:00.000Z');const receipt=await tool.apply(f.db,plan,f.evidence,path.join(f.dir,'before.json'));assert.equal(receipt.kickoffAt,f.m.officialDate);
 const row=(await f.db.execute('SELECT * FROM matches')).rows[0];assert.equal(row.date,f.m.officialDate);assert.equal(row.home_goals,0);assert.match(row.raw_json,/"number":1\.00/);assert.match(row.raw_json,/"dup":1,"dup":2/);const raw=JSON.parse(row.raw_json);assert.equal(raw.fieldProvenance.date.previous.source,'prior');assert.equal(raw.fieldProvenance.other.source,'old');
 assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM final_observations')).rows[0].n,1);assert.equal((await tool.schemaState(f.db)).status,'present');await assert.rejects(f.db.execute("UPDATE matches SET date='2026-01-01'"),/match_kickoff_observation_locked/);await assert.rejects(f.db.execute('DELETE FROM match_kickoff_observations'),/match_kickoff_observation_immutable/);
 }finally{f.db.close();}
});
test('rollback removes migration, date update and proof after injected faults',async()=>{
 for(const when of ['after_update','after_lock']){const f=await setup();try{const plan=await tool.snapshot(f.db,f.evidence,f.target,'2026-11-07T00:00:00.000Z');await assert.rejects(tool.apply(f.db,plan,f.evidence,path.join(f.dir,'before.json'),x=>{if(x===when)throw Error('fault');}),/fault/);assert.deepEqual(await tool.snapshot(f.db,f.evidence,f.target,plan.plannedAt),plan);assert.equal((await tool.schemaState(f.db)).status,'absent');}finally{f.db.close();}}
});
test('changed source, future timestamps and wrong identity stop the plan',async()=>{
 const f=await setup();try{fs.writeFileSync(f.doc,'tampered');assert.throws(()=>tool.validateEvidence(f.manifest,f.hosts),/document_invalid_or_changed/);fs.writeFileSync(f.doc,'fixture only');f.m.reviewedAt='2999-01-01T00:00:00.000Z';fs.writeFileSync(f.manifest,JSON.stringify(f.m));assert.throws(()=>tool.validateEvidence(f.manifest,f.hosts),/invalid_manifest/);
 f.m.reviewedAt='2026-11-07T00:00:00.000Z';f.m.identity.away='wrong';fs.writeFileSync(f.manifest,JSON.stringify(f.m));const e=tool.validateEvidence(f.manifest,f.hosts);await assert.rejects(tool.snapshot(f.db,e,f.target,'2026-11-07T00:00:00.000Z'),/row_or_identity_changed/);
 }finally{f.db.close();}
});
test('row races and evidence tampering inside transaction roll back',async()=>{
 const f=await setup();try{const plan=await tool.snapshot(f.db,f.evidence,f.target,'2026-11-07T00:00:00.000Z');await f.db.execute("UPDATE matches SET home_shots=5");await assert.rejects(tool.apply(f.db,plan,f.evidence,path.join(f.dir,'before.json')),/plan_changed/);
 await f.db.execute("UPDATE matches SET home_shots=4");await assert.rejects(tool.apply(f.db,plan,f.evidence,path.join(f.dir,'before2.json'),()=>fs.writeFileSync(f.doc,'tampered'),()=>tool.validateEvidence(f.manifest,f.hosts)),/document_invalid_or_changed/);assert.equal((await tool.schemaState(f.db)).status,'absent');assert.equal((await f.db.execute('SELECT date FROM matches')).rows[0].date,f.m.expectedDate);
 }finally{f.db.close();}
});
test('outputs cannot overlap inputs, backup or each other',async()=>{
 const f=await setup();try{const o={'--before':path.join(f.dir,'before.json'),'--receipt':path.join(f.dir,'receipt.json'),'--apply':path.join(f.dir,'plan.json'),'--manifest':f.manifest,'--approved-hosts':f.hosts,'--backup-manifest':path.join(f.dir,'backup.json'),'--database':f.file};fs.writeFileSync(o['--apply'],'{}');fs.writeFileSync(o['--backup-manifest'],'{}');tool.checkOutputPaths(o,f.evidence);for(const value of [o['--receipt'],o['--apply'],f.doc,f.file,path.join(f.dir,'restore.db')])assert.throws(()=>tool.checkOutputPaths({...o,'--before':value},f.evidence),/output_overlap_or_exists/);}finally{f.db.close();}
});
test('CLI seals plan, requires matching hash and a fresh verified backup',async()=>{
 const f=await setup();f.db.close();const child=require('node:child_process'),script=path.join(__dirname,'../scripts/reconcile-official-kickoff.js');
 const run=args=>child.spawnSync(process.execPath,[script,...args],{encoding:'utf8'});
 const planFile=path.join(f.dir,'plan.json'),common=['--manifest',f.manifest,'--approved-hosts',f.hosts,'--database',f.file];
 const planRun=run(['--plan',planFile,...common]);assert.equal(planRun.status,0,planRun.stderr);const plan=JSON.parse(fs.readFileSync(planFile));
 const backupDir=path.join(f.dir,'backup');fs.mkdirSync(backupDir);fs.copyFileSync(f.file,path.join(backupDir,'restore.db'));fs.writeFileSync(path.join(backupDir,'database.sql'),'fixture dump');
 const backupFile=path.join(backupDir,'manifest.json'),backup={complete:true,startedAt:'2000-01-01T00:00:00.000Z',verification:{readable:true,foreignKeyViolations:0,integrity:['ok'],databaseSha256:hash(fs.readFileSync(path.join(backupDir,'restore.db')))},dump:{sha256:hash(fs.readFileSync(path.join(backupDir,'database.sql')))}};fs.writeFileSync(backupFile,JSON.stringify(backup));
 const args=['--apply',planFile,...common,'--expected-plan-hash',plan.planHash,'--backup-manifest',backupFile,'--before',path.join(f.dir,'before-cli.json'),'--receipt',path.join(f.dir,'receipt-cli.json')];
 let result=run(args);assert.equal(result.status,1);assert.match(result.stderr,/fresh_backup_required/);
 backup.startedAt=new Date().toISOString();fs.writeFileSync(backupFile,JSON.stringify(backup));result=run(args.map(x=>x===plan.planHash?'0'.repeat(64):x));assert.equal(result.status,1);assert.match(result.stderr,/plan_identity_mismatch/);
 fs.appendFileSync(path.join(backupDir,'database.sql'),'changed');result=run(args);assert.equal(result.status,1);assert.match(result.stderr,/backup_hash_mismatch/);
 fs.writeFileSync(path.join(backupDir,'database.sql'),'fixture dump');result=run(args);assert.equal(result.status,0,result.stderr);assert.ok(fs.existsSync(path.join(f.dir,'receipt-cli.json')));
});
test('import does not open a database',()=>{const result=require('node:child_process').spawnSync(process.execPath,['-e',"require('./scripts/reconcile-official-kickoff')"],{cwd:path.join(__dirname,'..'),encoding:'utf8'});assert.equal(result.status,0);assert.equal(result.stdout,'');assert.equal(result.stderr,'');});
test('partial kickoff schema and pre-existing kickoff locks are rejected',async()=>{
 const f=await setup();try{await f.db.execute('CREATE TABLE match_kickoff_observations(match_id TEXT)');await assert.rejects(tool.schemaState(f.db),/kickoff_schema_partial/);}finally{f.db.close();}
 const g=await setup();try{for(const sql of tool.migrationStatements())await g.db.execute(sql);await g.db.execute({sql:'INSERT INTO schema_migrations(version) VALUES(?)',args:['036_match_kickoff_observations.sql']});await g.db.execute({sql:'INSERT INTO match_kickoff_observations(match_id,kickoff_at,source,evidence_json,evidence_sha256) VALUES(?,?,?,?,?)',args:['understat_32010',g.m.expectedDate,'fixture','{}',hash('{}')]});await assert.rejects(tool.snapshot(g.db,g.evidence,g.target,'2026-11-07T00:00:00.000Z'),/kickoff_already_protected/);}finally{g.db.close();}
});
test('future acquisition and three host requirement are enforced',async()=>{
 const f=await setup();try{f.m.documents[0].acquiredAt='2999-01-01T00:00:00.000Z';fs.writeFileSync(f.manifest,JSON.stringify(f.m));assert.throws(()=>tool.validateEvidence(f.manifest,f.hosts),/document_invalid_or_changed/);f.m.documents[0].acquiredAt='2026-11-07T00:00:00.000Z';f.m.documents[1].url=f.m.documents[0].url;fs.writeFileSync(f.manifest,JSON.stringify(f.m));assert.throws(()=>tool.validateEvidence(f.manifest,f.hosts),/independent_sources_required/);}finally{f.db.close();}
});
