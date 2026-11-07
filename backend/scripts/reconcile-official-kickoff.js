'use strict';
// One reviewed kickoff correction. Importing this module does not open a database.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createClient}=require('@libsql/client');
const {targetFor,verifiedBackup}=require('./reset-challenger-production');
const {triggerSnapshot}=require('./reconcile-official-observations');
const MATCH='understat_32010',OLD='2026-10-24T15:15:00.000Z',NEW='2026-10-25T16:15:00.000Z';
const MIGRATION='036_match_kickoff_observations.sql';
const migrationPath=path.resolve(__dirname,'../migrations',MIGRATION);
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const jsonHash=x=>hash(JSON.stringify(x));
const read=x=>fs.readFileSync(path.resolve(x));
const save=(x,v)=>fs.writeFileSync(path.resolve(x),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
function check(v,e){if(!v)throw Error(e);}
function argumentsOf(args){
 const o={},allowed=['--plan','--apply','--manifest','--approved-hosts','--expected-plan-hash','--backup-manifest','--before','--receipt','--database','--expected-host'];
 for(let i=0;i<args.length;i++){const k=args[i];check(allowed.includes(k)&&!Object.hasOwn(o,k)&&args[i+1]&&!args[i+1].startsWith('--'),'invalid_arguments');o[k]=args[++i];}
 check(Boolean(o['--plan'])!==Boolean(o['--apply'])&&o['--manifest']&&o['--approved-hosts'],'invalid_arguments');
 if(o['--apply'])check(o['--backup-manifest']&&o['--before']&&o['--receipt']&&/^[a-f0-9]{64}$/.test(o['--expected-plan-hash']||''),'apply_requires_backup_and_plan');
 return o;
}
function validateEvidence(manifestFile,hostsFile){
 const bytes=read(manifestFile),m=JSON.parse(bytes),hostBytes=read(hostsFile),hosts=JSON.parse(hostBytes);
 check(m.format==='official-kickoff-review-v1'&&m.matchId===MATCH&&m.expectedDate===OLD&&m.officialDate===NEW&&Number.isFinite(Date.parse(m.reviewedAt))&&Date.parse(m.reviewedAt)<=Date.now(),'invalid_manifest');
 const i=m.identity;check(i&&['competition','season','home','away'].every(k=>typeof i[k]==='string'&&i[k].trim())&&['homeGoals','awayGoals'].every(k=>Number.isSafeInteger(i[k])&&i[k]>=0),'invalid_identity');
 check(m.evidence&&['definition','label','jsonPath','snippet'].every(k=>typeof m.evidence[k]==='string'&&m.evidence[k].trim()),'incomplete_evidence');
 check(Array.isArray(hosts)&&hosts.length&&hosts.every(h=>typeof h==='string'&&/^[a-z0-9.-]+$/.test(h)),'invalid_hosts');
 check(Array.isArray(m.documents)&&m.documents.length>=3,'missing_documents');
 const sourceHosts=new Set();
 for(const d of m.documents){let url;try{url=new URL(d.url);}catch{throw Error('invalid_document_url');}
  sourceHosts.add(url.hostname);
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&hosts.includes(url.hostname)&&/^[a-f0-9]{64}$/.test(d.sha256||'')&&Number.isFinite(Date.parse(d.acquiredAt))&&Date.parse(d.acquiredAt)<=Date.parse(m.reviewedAt)&&typeof d.file==='string'&&hash(read(d.file))===d.sha256,'document_invalid_or_changed');}
 check(sourceHosts.size>=3,'independent_sources_required');
 return {manifest:m,manifestSha256:hash(bytes),hostsSha256:hash(hostBytes)};
}
function migrationStatements(){
 const source=read(migrationPath).toString('utf8').replace(/^\s*--[^\n]*\n/gm,'');
 const table=source.match(/CREATE TABLE IF NOT EXISTS match_kickoff_observations\s*\([\s\S]*?\n\);/);
 const triggers=[...source.matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)[\s\S]*?\nEND;/g)];
 check(table&&triggers.length===5,'migration_contract_invalid');return [table[0],...triggers.map(m=>m[0])];
}
const normal=s=>s.replace(' IF NOT EXISTS','').replace(/\s+/g,' ').trim().replace(/;$/,'');
async function schemaState(db){
 const expected=migrationStatements(),objects=(await db.execute("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger') AND (name LIKE 'match_kickoff_observations%' OR tbl_name='match_kickoff_observations') ORDER BY type,name")).rows.map(r=>({...r}));
 const registry=(await db.execute({sql:'SELECT version,applied_at FROM schema_migrations WHERE version=?',args:[MIGRATION]})).rows.map(r=>({...r}));
 if(!objects.length&&!registry.length)return {status:'absent',objects,registry};
 check(objects.length===6&&registry.length===1,'kickoff_schema_partial');
 const expectedByName=new Map(expected.map(sql=>[sql.match(/(?:TABLE|TRIGGER) IF NOT EXISTS (\w+)/)[1],normal(sql)]));
 for(const item of objects)check(expectedByName.has(item.name)&&normal(item.sql)===expectedByName.get(item.name),'kickoff_schema_changed');
 return {status:'present',objects,registry};
}
async function snapshot(db,evidence,target,plannedAt){
 const triggers=await triggerSnapshot(db),schema=await schemaState(db);
 const rows=await db.execute({sql:'SELECT * FROM matches WHERE match_id=?',args:[MATCH]});check(rows.rows.length===1,'match_missing');const row={...rows.rows[0]},i=evidence.manifest.identity;
 check(row.date===OLD&&row.competition===i.competition&&row.season===i.season&&row.home_team_name===i.home&&row.away_team_name===i.away&&row.home_goals===i.homeGoals&&row.away_goals===i.awayGoals,'row_or_identity_changed');
 const duplicate=await db.execute({sql:'SELECT COUNT(*) AS n FROM matches WHERE competition=? AND season=? AND home_team_name=? AND away_team_name=? AND date IN (?,?)',args:[i.competition,i.season,i.home,i.away,OLD,NEW]});check(Number(duplicate.rows[0].n)===1,'fixture_not_unique');
 const locks=(await db.execute({sql:'SELECT * FROM final_observations WHERE match_id=? ORDER BY field',args:[MATCH]})).rows.map(r=>({...r}));
 const kickoffLocks=schema.status==='present'?(await db.execute({sql:'SELECT * FROM match_kickoff_observations WHERE match_id=?',args:[MATCH]})).rows.map(r=>({...r})):[];
 check(!kickoffLocks.length,'kickoff_already_protected');
 const local=createClient({url:'file::memory:'});try{
  const valid=await local.execute({sql:"SELECT json_valid(?) AS valid, (SELECT COUNT(*) FROM json_each(?) WHERE key='fieldProvenance') AS roots",args:[row.raw_json,row.raw_json]});
  check(Number(valid.rows[0].valid)===1&&Number(valid.rows[0].roots)<=1,'invalid_raw_json');
  const provenance=await local.execute({sql:"SELECT type FROM json_each(?) WHERE key='fieldProvenance'",args:[row.raw_json]});check(!provenance.rows.length||provenance.rows[0].type==='object','invalid_field_provenance');
  const count=await local.execute({sql:"SELECT COUNT(*) AS n FROM json_each(?, '$.fieldProvenance') WHERE key='date'",args:[row.raw_json]});check(Number(count.rows[0].n)<=1,'duplicate_field_provenance');
 }finally{local.close();}
 return {format:'official-kickoff-plan-v1',plannedAt,target,manifestSha256:evidence.manifestSha256,hostsSha256:evidence.hostsSha256,migrationSha256:hash(read(migrationPath)),implementationSha256:hash(read(__filename)),helperSha256:hash(read(path.resolve(__dirname,'reset-challenger-production.js'))),observationsHelperSha256:hash(read(path.resolve(__dirname,'reconcile-official-observations.js'))),triggers,schema,row,locks,kickoffLocks};
}
function pathIdentity(file){const abs=path.resolve(file),resolved=fs.existsSync(abs)?fs.realpathSync(abs):path.join(fs.realpathSync(path.dirname(abs)),path.basename(abs));return process.platform==='win32'?resolved.toLowerCase():resolved;}
function checkOutputPaths(o,e){
 const outputs=[o['--before'],o['--receipt']].map(pathIdentity),backupDir=path.dirname(path.resolve(o['--backup-manifest']));
 const inputs=[o['--apply'],o['--manifest'],o['--approved-hosts'],o['--backup-manifest'],o['--database'],migrationPath,path.join(backupDir,'restore.db'),path.join(backupDir,'database.sql'),...e.manifest.documents.map(x=>x.file)].filter(Boolean).map(pathIdentity);
 check(outputs[0]!==outputs[1]&&outputs.every(x=>!inputs.includes(x))&&outputs.every(x=>!fs.existsSync(x)),'output_overlap_or_exists');
}
async function apply(db,plan,evidence,beforePath,hook,revalidate){
 const tx=await db.transaction('write');const local=createClient({url:'file::memory:'});
 try{
  if(revalidate)revalidate();const now=await snapshot(tx,evidence,plan.target,plan.plannedAt);check(jsonHash(now)===jsonHash(plan),'plan_changed');save(beforePath,now);
  if(plan.schema.status==='absent'){
   for(const sql of migrationStatements())await tx.execute(sql);
   await tx.execute({sql:'INSERT INTO schema_migrations(version) VALUES(?)',args:[MIGRATION]});
  }
  const schema=await schemaState(tx);check(schema.status==='present','kickoff_schema_missing');
  const previous=(await local.execute({sql:"SELECT json_extract(?, '$.fieldProvenance.date') AS value,json_type(?, '$.fieldProvenance.date') AS type",args:[plan.row.raw_json,plan.row.raw_json]})).rows[0];
  const provenance={source:'official_report',oldValue:OLD,documents:evidence.manifest.documents,evidence:evidence.manifest.evidence,manifestSha256:evidence.manifestSha256};
  if(previous.type)provenance.previous=['object','array'].includes(previous.type)?JSON.parse(previous.value):previous.type==='true'?true:previous.type==='false'?false:previous.value;
  const root=(await local.execute({sql:"SELECT json_set(?, '$.fieldProvenance', json(COALESCE(json_extract(?, '$.fieldProvenance'),'{}'))) AS raw",args:[plan.row.raw_json,plan.row.raw_json]})).rows[0].raw;
  const raw=(await local.execute({sql:"SELECT json_set(?, '$.fieldProvenance.date',json(?)) AS raw",args:[root,JSON.stringify(provenance)]})).rows[0].raw;
  const comparison=(await local.execute({sql:"SELECT json_remove(?, '$.fieldProvenance') AS oldRoot,json_remove(?, '$.fieldProvenance') AS newRoot,COALESCE(json_extract(json_remove(?, '$.fieldProvenance.date'),'$.fieldProvenance'),'{}') AS oldProof,json_extract(json_remove(?, '$.fieldProvenance.date'),'$.fieldProvenance') AS newProof",args:[plan.row.raw_json,raw,plan.row.raw_json,raw]})).rows[0];
  check(comparison.oldRoot===comparison.newRoot&&comparison.oldProof===comparison.newProof,'unrelated_provenance_changed');
  check(Buffer.byteLength(raw)<4*1024*1024,'payload_too_large');
  const updated=await tx.execute({sql:'UPDATE matches SET date=?,raw_json=? WHERE match_id=? AND date=?',args:[NEW,raw,MATCH,OLD]});check(Number(updated.rowsAffected)===1,'kickoff_update_failed');
  if(hook)await hook('after_update');
  const proof=JSON.stringify({source:'official_report',oldValue:OLD,newValue:NEW,documents:evidence.manifest.documents,identity:evidence.manifest.identity,evidence:evidence.manifest.evidence,manifestSha256:evidence.manifestSha256,expectedRowSha256:jsonHash(plan.row),originalRawSha256:hash(plan.row.raw_json)});
  await tx.execute({sql:'INSERT INTO match_kickoff_observations(match_id,kickoff_at,source,evidence_json,evidence_sha256) VALUES(?,?,?,?,?)',args:[MATCH,NEW,'official_report',proof,hash(proof)]});
  if(hook)await hook('after_lock');
  const row={...(await tx.execute({sql:'SELECT * FROM matches WHERE match_id=?',args:[MATCH]})).rows[0]};check(row.date===NEW&&row.raw_json===raw,'kickoff_postcondition_failed');row.date=plan.row.date;row.raw_json=plan.row.raw_json;check(jsonHash(row)===jsonHash(plan.row),'unrelated_row_changed');
  const locks=(await tx.execute({sql:'SELECT * FROM final_observations WHERE match_id=? ORDER BY field',args:[MATCH]})).rows.map(r=>({...r}));check(jsonHash(locks)===jsonHash(plan.locks),'old_observations_changed');
  const inserted=(await tx.execute({sql:'SELECT * FROM match_kickoff_observations WHERE match_id=?',args:[MATCH]})).rows;check(inserted.length===1&&inserted[0].kickoff_at===NEW&&inserted[0].source==='official_report'&&inserted[0].evidence_json===proof&&inserted[0].evidence_sha256===hash(proof),'kickoff_lock_mismatch');
  check(jsonHash(await triggerSnapshot(tx))===jsonHash(plan.triggers),'trigger_changed');check((await schemaState(tx)).status==='present','kickoff_schema_changed');
  check((await tx.execute('PRAGMA foreign_key_check')).rows.length===0,'foreign_key_violation');
  if(revalidate)revalidate();check(hash(read(migrationPath))===plan.migrationSha256,'migration_changed');await tx.commit();return {matchId:MATCH,kickoffAt:NEW,beforeSha256:hash(read(beforePath))};
 }catch(e){await tx.rollback();throw e;}finally{local.close();}
}
async function main(args=process.argv.slice(2)){
 const o=argumentsOf(args),evidence=validateEvidence(o['--manifest'],o['--approved-hosts']),env={...process.env};
 if(o['--plan']&&!o['--database']){check(Boolean(env.TURSO_WATCHDOG_READONLY_TOKEN),'read_only_token_required');env.TURSO_AUTH_TOKEN=env.TURSO_WATCHDOG_READONLY_TOKEN;}
 const target=targetFor(o,env),client=createClient({url:target.url,authToken:target.authToken});
 try{
  if(o['--plan']){const plan=await snapshot(client,evidence,target.identity,new Date().toISOString()),planHash=jsonHash(plan);save(o['--plan'],{...plan,planHash});console.log(JSON.stringify({planHash,matchId:MATCH}));return;}
  checkOutputPaths(o,evidence);const {planHash,...plan}=JSON.parse(read(o['--apply']));
  check(planHash===o['--expected-plan-hash']&&jsonHash(plan)===planHash&&jsonHash(plan.target)===jsonHash(target.identity)&&plan.manifestSha256===evidence.manifestSha256&&plan.hostsSha256===evidence.hostsSha256&&plan.migrationSha256===hash(read(migrationPath))&&plan.implementationSha256===hash(read(__filename))&&plan.helperSha256===hash(read(path.resolve(__dirname,'reset-challenger-production.js')))&&plan.observationsHelperSha256===hash(read(path.resolve(__dirname,'reconcile-official-observations.js'))),'plan_identity_mismatch');
  const backup=await verifiedBackup(o['--backup-manifest'],target.identity);check(Number.isFinite(Date.parse(backup.startedAt))&&Date.parse(backup.startedAt)>=Date.parse(plan.plannedAt)&&Date.parse(backup.startedAt)<=Date.now(),'fresh_backup_required');
  const revalidate=()=>{const e=validateEvidence(o['--manifest'],o['--approved-hosts']);check(e.manifestSha256===evidence.manifestSha256&&e.hostsSha256===evidence.hostsSha256,'evidence_changed');};
  const result=await apply(client,plan,evidence,o['--before'],undefined,revalidate);save(o['--receipt'],{planHash,backup,...result});console.log(JSON.stringify({planHash,...result}));
 }finally{client.close();}
}
module.exports={argumentsOf,validateEvidence,migrationStatements,schemaState,snapshot,checkOutputPaths,apply,main};
if(require.main===module)main().catch(e=>{console.error(/^[a-z_]+$/.test(e.message)?e.message:'official_kickoff_failed');process.exitCode=1;});
