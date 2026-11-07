'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {createClient}=require('@libsql/client');
const tool=require('../scripts/reconcile-official-observations');
const initial=Array.from({length:224},(_,i)=>({matchId:`fixture_${i}`,field:'home_shots_on_target',database:2,csv:3,competition:'Fixture League',date:`2026-08-${String(i%28+1).padStart(2,'0')}T14:00:00.000Z`,home:`Home ${i}`,away:`Away ${i}`,score:[1,0]}));
const fixtureScopeHash=digestForScope();
function digestForScope(){return crypto.createHash('sha256').update(JSON.stringify(initial.map(({matchId,field,database,csv})=>({matchId,field,database,csv})))).digest('hex');}
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
async function setup() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'official-review-'));
 const db=createClient({url:`file:${path.join(dir,'fixture.db')}`});
 await db.execute(`CREATE TABLE matches(match_id TEXT PRIMARY KEY, date TEXT,competition TEXT,season TEXT,home_team_name TEXT,away_team_name TEXT,home_goals INTEGER,away_goals INTEGER,home_shots INTEGER,away_shots INTEGER,home_shots_on_target INTEGER,away_shots_on_target INTEGER,home_fouls INTEGER,away_fouls INTEGER,home_corners INTEGER,away_corners INTEGER,home_yellow_cards INTEGER,away_yellow_cards INTEGER,home_red_cards INTEGER,away_red_cards INTEGER,referee TEXT,home_xg REAL,away_xg REAL,raw_json TEXT)`);
 const migration=fs.readFileSync(path.join(__dirname,'../migrations/034_final_observations.sql'),'utf8');
 await db.executeMultiple(migration);
 const source=path.join(dir,'test-evidence.txt'); fs.writeFileSync(source,'fixture evidence only');
 const hosts=path.join(dir,'hosts.json');fs.writeFileSync(hosts,JSON.stringify(['example.test']));
 const cases=initial.filter(x=>x.field.includes('shots_on_target')).slice(0,2);
 const decisions=[];
 for(const [index,x] of cases.entries()) {
  const season='2026/2027';
  await db.execute({sql:`INSERT INTO matches(match_id,date,competition,season,home_team_name,away_team_name,home_goals,away_goals,home_shots,away_shots,home_shots_on_target,away_shots_on_target,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[x.matchId,x.date,x.competition,season,x.home,x.away,...x.score,30,30,x.field==='home_shots_on_target'?x.database:0,x.field==='away_shots_on_target'?x.database:0,'{"number":1.00,"duplicate":1,"duplicate":2,"fieldProvenance":{"other":{"source":"old"},"home_shots_on_target":{"source":"prior"}}}']});
  decisions.push({matchId:x.matchId,field:x.field,expectedValue:x.database,officialValue:index===0?x.csv:x.database,decision:index===0?'correct':'confirm',documents:[{url:'https://example.test/fixture',file:source,sha256:digest(fs.readFileSync(source)),acquiredAt:'2026-11-07T00:00:00.000Z'}],evidence:{identity:{date:x.date,competition:x.competition,season,home:x.home,away:x.away,homeGoals:x.score[0],awayGoals:x.score[1]},definition:'fixture definition',label:'fixture label',jsonPath:'$.fixture',snippet:'fixture evidence only'}});
 }
 const manifest={format:'official-observation-review-v1',reviewedAt:'2026-11-07T00:00:00.000Z',scope:initial.map(({matchId,field,database,csv})=>({matchId,field,database,csv})),decisions};
 const manifestFile=path.join(dir,'manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 const evidence=tool.validateEvidence(manifestFile,hosts,fixtureScopeHash);
 return {dir,db,source,hosts,manifestFile,manifest,evidence,decisions};
}
test('correction and confirmation preserve original fields, proof and existing provenance',async()=>{
 const f=await setup();try {
  const plan=await tool.snapshot(f.db,f.evidence,{kind:'local'});
  const result=await tool.apply(f.db,plan,f.evidence,path.join(f.dir,'before.json'));
  assert.equal(result.inserted,2);
  const rows=await f.db.execute('SELECT * FROM matches ORDER BY match_id');
  const corrected=rows.rows.find(r=>r.match_id===f.decisions[0].matchId);
  assert.equal(corrected[f.decisions[0].field],f.decisions[0].officialValue);
  assert.match(corrected.raw_json,/"number":1\.00/);assert.match(corrected.raw_json,/"duplicate":1,"duplicate":2/);
  assert.equal(JSON.parse(corrected.raw_json).fieldProvenance.other.source,'old');
  assert.equal(JSON.parse(corrected.raw_json).fieldProvenance[f.decisions[0].field].previous.source,'prior');
  assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM final_observations')).rows[0].n,2);
  const d=f.decisions[1]; const only={...f.evidence,manifest:{...f.manifest,decisions:[d]}};
  const repeat=await tool.snapshot(f.db,only,{kind:'local'});
  assert.equal((await tool.apply(f.db,repeat,only,path.join(f.dir,'again.json'))).inserted,0);
 }finally{f.db.close();}
});
test('transaction rolls back after two inserts and changed row aborts',async()=>{
 const f=await setup();try {
  const plan=await tool.snapshot(f.db,f.evidence,{kind:'local'});
  await assert.rejects(tool.apply(f.db,plan,f.evidence,path.join(f.dir,'before.json'),n=>{if(n===2)throw Error('fault');}),/fault/);
  assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM final_observations')).rows[0].n,0);
  const row=await f.db.execute({sql:'SELECT * FROM matches WHERE match_id=?',args:[f.decisions[0].matchId]});assert.equal(row.rows[0][f.decisions[0].field],f.decisions[0].expectedValue);
  await f.db.execute({sql:'UPDATE matches SET home_team_name=? WHERE match_id=?',args:['changed',f.decisions[0].matchId]});
  await assert.rejects(tool.apply(f.db,plan,f.evidence,path.join(f.dir,'before2.json')),/row_or_identity_changed/);
 }finally{f.db.close();}
});
test('tampered source and invalid counts are rejected',async()=>{
 const f=await setup();try {
  fs.writeFileSync(f.source,'tampered'); assert.throws(()=>tool.validateEvidence(f.manifestFile,f.hosts,fixtureScopeHash),/document_invalid_or_changed/);
  fs.writeFileSync(f.source,'fixture evidence only');f.manifest.decisions[0].officialValue=0.5;fs.writeFileSync(f.manifestFile,JSON.stringify(f.manifest));assert.throws(()=>tool.validateEvidence(f.manifestFile,f.hosts,fixtureScopeHash),/invalid_decision/);
 }finally{f.db.close();}
});
test('incoherent shots and altered trigger are rejected',async()=>{
 const f=await setup();try {
  await f.db.execute({sql:'UPDATE matches SET home_shots=0 WHERE match_id=?',args:[f.decisions[0].matchId]});
  await assert.rejects(tool.snapshot(f.db,f.evidence,{kind:'local'}),/shots_incoherent/);
  await f.db.execute('DROP TRIGGER final_observations_no_delete');
  await assert.rejects(tool.snapshot(f.db,f.evidence,{kind:'local'}),/trigger_missing_or_changed/);
 }finally{f.db.close();}
});
test('protected values block correction and modified locks invalidate the plan',async()=>{
 const f=await setup();try {
  const d=f.decisions[0];
  await f.db.execute({sql:'INSERT INTO final_observations(match_id,field,value,source,evidence_json,evidence_sha256) VALUES(?,?,?,?,?,?)',args:[d.matchId,d.field,d.expectedValue,'fixture','{}',digest('{}')]});
  await assert.rejects(tool.snapshot(f.db,f.evidence,{kind:'local'}),/protected_value_differs/);
  const only={...f.evidence,manifest:{...f.manifest,decisions:[f.decisions[1]]}};
  const plan=await tool.snapshot(f.db,only,{kind:'local'});
  const d2=f.decisions[1]; await f.db.execute({sql:'INSERT INTO final_observations(match_id,field,value,source,evidence_json,evidence_sha256) VALUES(?,?,?,?,?,?)',args:[d2.matchId,d2.field,d2.expectedValue,'fixture','{}',digest('{}')]});
  await assert.rejects(tool.apply(f.db,plan,only,path.join(f.dir,'before-lock.json')),/plan_changed/);
 }finally{f.db.close();}
});
test('actual zero is accepted, while missing values and invalid decisions are not',async()=>{
 const f=await setup();try {
  const d=f.manifest.decisions[0], entry=f.manifest.scope.find(x=>x.matchId===d.matchId && x.field===d.field);
  entry.database=0; d.expectedValue=0; d.officialValue=0; d.decision='confirm';
  const hash=digest(JSON.stringify(f.manifest.scope));
  fs.writeFileSync(f.manifestFile,JSON.stringify(f.manifest));
  const evidence=tool.validateEvidence(f.manifestFile,f.hosts,hash);
  await f.db.execute({sql:`UPDATE matches SET ${d.field}=0 WHERE match_id=?`,args:[d.matchId]});
  const plan=await tool.snapshot(f.db,evidence,{kind:'local'});assert.ok(plan.matches.some(x=>x[d.field]===0));
  d.officialValue=null;fs.writeFileSync(f.manifestFile,JSON.stringify(f.manifest));assert.throws(()=>tool.validateEvidence(f.manifestFile,f.hosts,hash),/invalid_decision/);
 }finally{f.db.close();}
});
test('import does not open a database',()=>{
 const child=require('node:child_process').spawnSync(process.execPath,['-e',"require('./scripts/reconcile-official-observations')"],{cwd:path.join(__dirname,'..'),encoding:'utf8'});
 assert.equal(child.status,0);assert.equal(child.stdout,'');assert.equal(child.stderr,'');
});
test('future evidence times and nonstandard URL ports are rejected',async()=>{
 const f=await setup();try {
  f.manifest.reviewedAt='2999-01-01T00:00:00.000Z';fs.writeFileSync(f.manifestFile,JSON.stringify(f.manifest));
  assert.throws(()=>tool.validateEvidence(f.manifestFile,f.hosts,fixtureScopeHash),/invalid_manifest/);
  f.manifest.reviewedAt='2026-11-07T00:00:00.000Z';f.manifest.decisions[0].documents[0].acquiredAt='2999-01-01T00:00:00.000Z';fs.writeFileSync(f.manifestFile,JSON.stringify(f.manifest));
  assert.throws(()=>tool.validateEvidence(f.manifestFile,f.hosts,fixtureScopeHash),/document_invalid_or_changed/);
  f.manifest.decisions[0].documents[0].acquiredAt='2026-11-07T00:00:00.000Z';f.manifest.decisions[0].documents[0].url='https://example.test:444/fixture';fs.writeFileSync(f.manifestFile,JSON.stringify(f.manifest));
  assert.throws(()=>tool.validateEvidence(f.manifestFile,f.hosts,fixtureScopeHash),/document_invalid_or_changed/);
 }finally{f.db.close();}
});
test('output paths cannot overlap inputs, backup or each other',async()=>{
 const f=await setup();try {
  const base={'--before':path.join(f.dir,'before.json'),'--receipt':path.join(f.dir,'receipt.json'),'--apply':path.join(f.dir,'plan.json'),'--manifest':f.manifestFile,'--approved-hosts':f.hosts,'--backup-manifest':path.join(f.dir,'backup.json')};
  for (const name of ['--apply','--backup-manifest']) fs.writeFileSync(base[name],'{}');
  tool.checkOutputPaths(base,f.evidence);
  for (const file of [base['--receipt'],base['--apply'],base['--manifest'],f.source,path.join(f.dir,'restore.db')]) assert.throws(()=>tool.checkOutputPaths({...base,'--before':file},f.evidence),/output_overlap_or_exists/);
 }finally{f.db.close();}
});
test('evidence changed during transaction rolls everything back',async()=>{
 const f=await setup();try {
  const plan=await tool.snapshot(f.db,f.evidence,{kind:'local'});
  const revalidate=()=>tool.validateEvidence(f.manifestFile,f.hosts,fixtureScopeHash);
  await assert.rejects(tool.apply(f.db,plan,f.evidence,path.join(f.dir,'before-tamper.json'),n=>{if(n===1)fs.writeFileSync(f.source,'tampered');},revalidate),/document_invalid_or_changed/);
  assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM final_observations')).rows[0].n,0);
  const row=await f.db.execute({sql:'SELECT * FROM matches WHERE match_id=?',args:[f.decisions[0].matchId]}); assert.equal(row.rows[0][f.decisions[0].field],f.decisions[0].expectedValue);
 }finally{f.db.close();}
});
test('snapshot batches fixture and lock reads and keeps deterministic plans',async()=>{
 const f=await setup();try {
  const template=f.decisions[0], extra=[];
  for(let i=2;i<82;i++) {
   const x=initial[i], d={...template,matchId:x.matchId,evidence:{...template.evidence,identity:{date:x.date,competition:x.competition,season:'2026/2027',home:x.home,away:x.away,homeGoals:1,awayGoals:0}}};extra.push(d);
   await f.db.execute({sql:`INSERT INTO matches(match_id,date,competition,season,home_team_name,away_team_name,home_goals,away_goals,home_shots,away_shots,home_shots_on_target,away_shots_on_target,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[x.matchId,x.date,x.competition,'2026/2027',x.home,x.away,1,0,30,30,2,0,'{}']});
  }
  const evidence={...f.evidence,manifest:{...f.manifest,decisions:[...f.decisions,...extra]}};
  const ordinary=await tool.snapshot(f.db,evidence,{kind:'local'});let calls=0;
  const counted={execute:async(...args)=>{calls++;return f.db.execute(...args);},batch:async(...args)=>{calls++;return f.db.batch(...args);}};
  const batched=await tool.snapshot(counted,evidence,{kind:'local'});
  assert.deepEqual(batched,ordinary);assert.equal(calls,4);
 }finally{f.db.close();}
});
test('normal batched writes roll back when the second lock insert fails',async()=>{
 const f=await setup();try {
  await f.db.execute(`CREATE TRIGGER fixture_reject_second_lock BEFORE INSERT ON final_observations WHEN (SELECT COUNT(*) FROM final_observations)>=1 BEGIN SELECT RAISE(ABORT,'fixture_second_insert'); END`);
  const plan=await tool.snapshot(f.db,f.evidence,{kind:'local'});
  await assert.rejects(tool.apply(f.db,plan,f.evidence,path.join(f.dir,'before-batch-fault.json')),/fixture_second_insert/);
  const after=await tool.snapshot(f.db,f.evidence,{kind:'local'});
  assert.deepEqual(after,plan);
  assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM final_observations')).rows[0].n,0);
 }finally{f.db.close();}
});
