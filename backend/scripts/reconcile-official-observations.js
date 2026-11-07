'use strict';
// Offline evidence review. Importing this module never opens a database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');
const { targetFor, verifiedBackup } = require('./reset-challenger-production');

const fields = new Set(['home_shots','away_shots','home_shots_on_target','away_shots_on_target',
  'home_yellow_cards','away_yellow_cards','home_red_cards','away_red_cards']);
const scopeHash = '0478875c5625e7e1bd50cf04a683871fb47f5a8a2bab7358b5147eedce2c5d02';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const key = x => `${x.matchId}|${x.field}`;
const count = x => Number.isSafeInteger(x) && x >= 0;
const read = file => fs.readFileSync(path.resolve(file));
const save = (file, value) => fs.writeFileSync(path.resolve(file), JSON.stringify(value, null, 2) + '\n', {flag:'wx', mode:0o600});
function check(condition, reason) { if (!condition) throw Error(reason); }
function parseOptions(args) {
  const o = {};
  const allowed = ['--plan','--apply','--manifest','--approved-hosts','--expected-plan-hash','--backup-manifest','--before','--receipt','--database','--expected-host'];
  for (let i = 0; i < args.length; i++) {
    const k = args[i]; check(allowed.includes(k) && !Object.hasOwn(o,k) && args[i+1] && !args[i+1].startsWith('--'), 'invalid_arguments'); o[k]=args[++i];
  }
  check(Boolean(o['--plan']) !== Boolean(o['--apply']) && o['--manifest'] && o['--approved-hosts'], 'invalid_arguments');
  if (o['--apply']) check(o['--backup-manifest'] && o['--before'] && o['--receipt'] && /^[a-f0-9]{64}$/.test(o['--expected-plan-hash'] || ''), 'apply_requires_backup_and_plan');
  return o;
}
function validateEvidence(manifestFile, hostsFile, expectedScopeHash=scopeHash) {
  const bytes=read(manifestFile), manifest=JSON.parse(bytes), hostsBytes=read(hostsFile), hosts=JSON.parse(hostsBytes);
  check(Array.isArray(manifest.scope) && manifest.scope.length===224 && Array.isArray(manifest.decisions), 'invalid_scope');
  const initial=manifest.scope.map(({matchId,field,database,csv})=>({matchId,field,database,csv}));
  check(jsonHash(initial)===expectedScopeHash, 'scope_artifact_changed');
  const scope = new Map(initial.map(x=>[key(x), x]));
  check(scope.size === 224, 'duplicate_initial_scope');
  const supplied = new Set();
  for (const s of manifest.scope) {
    const original=scope.get(key(s));
    check(original && !supplied.has(key(s)) && s.database===original.database && s.csv===original.csv, 'scope_mismatch'); supplied.add(key(s));
  }
  check(manifest.format === 'official-observation-review-v1' && Number.isFinite(Date.parse(manifest.reviewedAt)) && Date.parse(manifest.reviewedAt)<=Date.now(), 'invalid_manifest');
  check(Array.isArray(hosts) && hosts.length && hosts.every(h=>typeof h==='string' && /^[a-z0-9.-]+$/.test(h)), 'invalid_hosts');
  const seen = new Set();
  for (const d of manifest.decisions) {
    const original=scope.get(key(d));
    check(original && !seen.has(key(d)) && fields.has(d.field) && d.expectedValue===original.database && count(d.expectedValue) && count(d.officialValue), 'invalid_decision'); seen.add(key(d));
    check(['correct','confirm'].includes(d.decision) && (d.decision==='confirm')===(d.expectedValue===d.officialValue), 'invalid_decision_kind');
    const id=d.evidence?.identity;
    check(id && typeof id.date==='string' && typeof id.competition==='string' && typeof id.home==='string' && typeof id.away==='string' && count(id.homeGoals) && count(id.awayGoals) && typeof id.season==='string' && id.season.length>0, 'identity_mismatch');
    check(typeof d.evidence.definition==='string' && d.evidence.definition.trim() && typeof d.evidence.label==='string' && d.evidence.label.trim() && typeof d.evidence.snippet==='string' && d.evidence.snippet.trim() && typeof d.evidence.jsonPath==='string' && d.evidence.jsonPath.trim(), 'incomplete_evidence');
    check(Array.isArray(d.documents) && d.documents.length>0, 'missing_documents');
    for (const doc of d.documents) {
      let url; try { url=new URL(doc.url); } catch { throw Error('invalid_document_url'); }
      check(url.protocol==='https:' && !url.username && !url.password && !url.port && !url.hash && hosts.includes(url.hostname) && /^[a-f0-9]{64}$/.test(doc.sha256 || '') && Number.isFinite(Date.parse(doc.acquiredAt)) && Date.parse(doc.acquiredAt)<=Date.parse(manifest.reviewedAt) && typeof doc.file==='string' && hash(read(doc.file))===doc.sha256, 'document_invalid_or_changed');
    }
  }
  return {manifest, manifestSha256:hash(bytes), hostsSha256:hash(hostsBytes)};
}
async function triggerSnapshot(db) {
  const migration=fs.readFileSync(path.resolve(__dirname,'../migrations/034_final_observations.sql'),'utf8');
  const expected=[...migration.matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)[\s\S]*?\nEND;/g)].map(m=>({name:m[1],sql:m[0].replace(' IF NOT EXISTS','')}));
  check(expected.length===7, 'migration_trigger_contract_invalid');
  const result=await db.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'final_observation%' ORDER BY name");
  const normalize=s=>s.replace(/\s+/g,' ').trim().replace(/;$/, '');
  for (const trigger of expected) check(result.rows.some(x=>x.name===trigger.name && normalize(x.sql)===normalize(trigger.sql)), 'trigger_missing_or_changed');
  return result.rows.map(x=>({name:x.name,sql:x.sql}));
}
async function readMatchesAndLocks(db, ids, unique=false) {
  const matches=[], observations=[];
  for (let offset=0;offset<ids.length;offset+=40) {
    const chunk=ids.slice(offset,offset+40), placeholders=chunk.map(()=>'?').join(',');
    const extra=unique ? `,(SELECT COUNT(*) FROM matches d WHERE d.date=m.date AND d.competition=m.competition AND d.season=m.season AND d.home_team_name=m.home_team_name AND d.away_team_name=m.away_team_name) AS __fixture_count` : '';
    const [rows,locks]=await db.batch([
      {sql:`SELECT m.*${extra} FROM matches m WHERE m.match_id IN (${placeholders}) ORDER BY m.match_id`,args:chunk},
      {sql:`SELECT * FROM final_observations WHERE match_id IN (${placeholders}) ORDER BY match_id,field`,args:chunk}
    ]);
    check(rows.rows.length===chunk.length,'match_missing');
    for(const r of rows.rows) {const row={...r}; if(unique){check(Number(row.__fixture_count)===1,'fixture_not_unique');delete row.__fixture_count;}matches.push(row);}
    observations.push(...locks.rows.map(r=>({...r})));
  }
  return {matches,observations};
}
async function snapshot(db, evidence, target) {
  const triggers=await triggerSnapshot(db);
  const ids=[...new Set(evidence.manifest.decisions.map(d=>d.matchId))].sort();
  const {matches,observations}=await readMatchesAndLocks(db,ids,true);
  const local=createClient({url:'file::memory:'});
  try {
    for (const row of matches) {
      for (const d of evidence.manifest.decisions.filter(x=>x.matchId===row.match_id)) {
        const i=d.evidence.identity;
        check(row.date===i.date && row.competition===i.competition && row.season===i.season && row.home_team_name===i.home && row.away_team_name===i.away && row.home_goals===i.homeGoals && row.away_goals===i.awayGoals && row[d.field]===d.expectedValue,'row_or_identity_changed');
        const lock=observations.find(x=>x.match_id===row.match_id && x.field===d.field);
        check(!lock || lock.value===d.officialValue, 'protected_value_differs');
        const valid=await local.execute({sql:"SELECT json_valid(?) AS valid, (SELECT COUNT(*) FROM json_each(?) WHERE key='fieldProvenance') AS roots",args:[row.raw_json,row.raw_json]});
        check(Number(valid.rows[0].valid)===1 && Number(valid.rows[0].roots)<=1, 'invalid_raw_json');
        const provenance=await local.execute({sql:"SELECT type FROM json_each(?) WHERE key='fieldProvenance'",args:[row.raw_json]});
        check(!provenance.rows.length || provenance.rows[0].type==='object', 'invalid_field_provenance');
        const duplicate=await local.execute({sql:"SELECT COUNT(*) AS n FROM json_each(?, '$.fieldProvenance') WHERE key=?",args:[row.raw_json,d.field]});
        check(Number(duplicate.rows[0].n)<=1, 'duplicate_field_provenance');
      }
      const desired={...row}; for (const d of evidence.manifest.decisions.filter(x=>x.matchId===row.match_id)) desired[d.field]=d.officialValue;
      for (const side of ['home','away']) {const shots=desired[`${side}_shots`], sot=desired[`${side}_shots_on_target`];if(count(shots)&&count(sot))check(sot<=shots,'shots_incoherent');}
    }
  } finally { local.close(); }
  return {format:'official-observation-plan-v1',target,manifestSha256:evidence.manifestSha256,hostsSha256:evidence.hostsSha256,triggers,matches,observations};
}
function pathIdentity(file) {
  const absolute=path.resolve(file);
  const resolved=fs.existsSync(absolute) ? fs.realpathSync(absolute) : path.join(fs.realpathSync(path.dirname(absolute)),path.basename(absolute));
  return process.platform==='win32' ? resolved.toLowerCase() : resolved;
}
function checkOutputPaths(options, evidence) {
  const outputs=[options['--before'],options['--receipt']].map(pathIdentity);
  const inputs=[options['--apply'],options['--manifest'],options['--approved-hosts'],options['--backup-manifest'],options['--database'],...evidence.manifest.decisions.flatMap(d=>d.documents.map(doc=>doc.file))].filter(Boolean).map(pathIdentity);
  const backupDir=path.dirname(path.resolve(options['--backup-manifest']));
  inputs.push(pathIdentity(path.join(backupDir,'restore.db')),pathIdentity(path.join(backupDir,'database.sql')));
  check(outputs[0]!==outputs[1] && outputs.every(p=>!inputs.includes(p)) && outputs.every(p=>!fs.existsSync(p)), 'output_overlap_or_exists');
}
async function apply(db, plan, evidence, beforePath, hook, revalidate) {
  const tx=await db.transaction('write');
  const local=createClient({url:'file::memory:'});
  try {
    if (revalidate) revalidate();
    const now=await snapshot(tx,evidence,plan.target); check(jsonHash(now)===jsonHash(plan), 'plan_changed');
    save(beforePath,now);
    let inserted=0; const statements=[];
    for (const original of plan.matches) {
      const ds=evidence.manifest.decisions.filter(d=>d.matchId===original.match_id);
      const corrections=ds.filter(d=>d.decision==='correct');
      if (corrections.length) {
        let raw=original.raw_json;
        for (const d of corrections) {
          const prior=await local.execute({sql:"SELECT json_extract(?, '$.fieldProvenance.' || ?) AS value, json_type(?, '$.fieldProvenance.' || ?) AS type",args:[raw,d.field,raw,d.field]});
          const provenance={source:'official_report',documents:d.documents,evidence:d.evidence,oldValue:d.expectedValue,manifestSha256:evidence.manifestSha256};
          if (prior.rows[0].type) { const p=prior.rows[0]; provenance.previous=['object','array'].includes(p.type) ? JSON.parse(p.value) : p.type==='true' ? true : p.type==='false' ? false : p.value; }
          const changed=await local.execute({sql:"SELECT json_set(?, '$.fieldProvenance', json(COALESCE(json_extract(?, '$.fieldProvenance'),'{}'))) AS raw",args:[raw,raw]});
          raw=(await local.execute({sql:"SELECT json_set(?, '$.fieldProvenance.' || ?, json(?)) AS raw",args:[changed.rows[0].raw,d.field,JSON.stringify(provenance)]})).rows[0].raw;
        }
        check(Buffer.byteLength(raw) < 4*1024*1024, 'payload_too_large');
        const roots=await local.execute({sql:"SELECT json_remove(?, '$.fieldProvenance') AS before, json_remove(?, '$.fieldProvenance') AS after",args:[original.raw_json,raw]});
        check(roots.rows[0].before===roots.rows[0].after, 'raw_root_changed');
        let oldProvenance=original.raw_json,newProvenance=raw;
        for (const d of corrections) {
          oldProvenance=(await local.execute({sql:"SELECT json_remove(?, '$.fieldProvenance.' || ?) AS value",args:[oldProvenance,d.field]})).rows[0].value;
          newProvenance=(await local.execute({sql:"SELECT json_remove(?, '$.fieldProvenance.' || ?) AS value",args:[newProvenance,d.field]})).rows[0].value;
        }
        const oldField=await local.execute({sql:"SELECT COALESCE(json_extract(?, '$.fieldProvenance'), '{}') AS before, json_extract(?, '$.fieldProvenance') AS after",args:[oldProvenance,newProvenance]});
        check(oldField.rows[0].before===oldField.rows[0].after,'unrelated_provenance_changed');
        statements.push({sql:`UPDATE matches SET ${corrections.map(d=>`${d.field}=?`).join(',')},raw_json=? WHERE match_id=?`,args:[...corrections.map(d=>d.officialValue),raw,original.match_id]});
      }
      for (const d of ds) {
        if (plan.observations.some(x=>x.match_id===d.matchId && x.field===d.field)) continue;
        const proof=JSON.stringify({source:'official_report',documents:d.documents,evidence:d.evidence,oldValue:d.expectedValue,expectedRowSha256:jsonHash(original),originalRawSha256:hash(original.raw_json),manifestSha256:evidence.manifestSha256});
        check(Buffer.byteLength(proof) < 4*1024*1024, 'payload_too_large');
        statements.push({sql:'INSERT INTO final_observations(match_id,field,value,source,evidence_json,evidence_sha256) VALUES(?,?,?,?,?,?)',args:[d.matchId,d.field,d.officialValue,'official_report',proof,hash(proof)],isInsert:true});
      }
    }
    let chunk=[], size=0;
    async function flush() {
      if (!chunk.length) return;
      if (hook) {for (const item of chunk) {await tx.execute({sql:item.sql,args:item.args});if(item.isInsert) {inserted++;await hook(inserted);}}}
      else {await tx.batch(chunk.map(({sql,args})=>({sql,args})));inserted+=chunk.filter(x=>x.isInsert).length;}
      chunk=[];size=0;
    }
    for(const item of statements) {
      const bytes=Buffer.byteLength(JSON.stringify(item));check(bytes<4*1024*1024,'payload_too_large');
      if(chunk.length>=40 || size+bytes>=4*1024*1024) await flush();
      chunk.push(item);size+=bytes;
    }
    await flush();
    const fk=await tx.execute('PRAGMA foreign_key_check'); check(fk.rows.length===0,'foreign_key_violation');
    const post=await readMatchesAndLocks(tx,plan.matches.map(x=>x.match_id));
    for (const original of plan.matches) {
      const result={...post.matches.find(x=>x.match_id===original.match_id)}, ds=evidence.manifest.decisions.filter(d=>d.matchId===original.match_id);
      for (const d of ds.filter(d=>d.decision==='correct')) {check(result[d.field]===d.officialValue,'updated_value_mismatch');result[d.field]=original[d.field];}
      if (ds.some(d=>d.decision==='correct')) result.raw_json=original.raw_json;
      check(jsonHash(result)===jsonHash(original),'unrelated_row_changed');
      const locks=post.observations.filter(x=>x.match_id===original.match_id), old=plan.observations.filter(x=>x.match_id===original.match_id);
      for (const item of old) check(locks.some(x=>jsonHash(x)===jsonHash(item)), 'old_lock_changed');
      check(locks.length===old.length+ds.filter(d=>!old.some(x=>x.field===d.field)).length, 'lock_count_mismatch');
      for (const d of ds) check(locks.some(x=>x.field===d.field && x.value===d.officialValue), 'lock_missing');
    }
    if (revalidate) revalidate();
    await tx.commit(); return {inserted,backupBeforeSha256:hash(read(beforePath))};
  } catch (e) { await tx.rollback(); throw e; } finally { local.close(); }
}
async function main(args=process.argv.slice(2)) {
  const o=parseOptions(args), evidence=validateEvidence(o['--manifest'],o['--approved-hosts']);
  const env={...process.env}; if (o['--plan'] && !o['--database']) {check(Boolean(env.TURSO_WATCHDOG_READONLY_TOKEN),'read_only_token_required');env.TURSO_AUTH_TOKEN=env.TURSO_WATCHDOG_READONLY_TOKEN;}
  const target=targetFor(o,env); const client=createClient({url:target.url,authToken:target.authToken});
  try {
    if (o['--plan']) {const plan=await snapshot(client,evidence,target.identity);const planHash=jsonHash(plan);save(o['--plan'],{...plan,planHash});console.log(JSON.stringify({planHash,decisions:evidence.manifest.decisions.length}));return;}
    checkOutputPaths(o,evidence);
    const {planHash,...plan}=JSON.parse(read(o['--apply']));
    check(planHash===o['--expected-plan-hash'] && jsonHash(plan)===planHash && jsonHash(plan.target)===jsonHash(target.identity) && plan.manifestSha256===evidence.manifestSha256 && plan.hostsSha256===evidence.hostsSha256,'plan_identity_mismatch');
    const backup=await verifiedBackup(o['--backup-manifest'],target.identity);
    const revalidate=()=>{ const again=validateEvidence(o['--manifest'],o['--approved-hosts']); check(again.manifestSha256===evidence.manifestSha256 && again.hostsSha256===evidence.hostsSha256,'evidence_changed'); };
    const result=await apply(client,plan,evidence,o['--before'],undefined,revalidate);save(o['--receipt'],{planHash,backup,...result});console.log(JSON.stringify({planHash,...result}));
  } finally {client.close();}
}
module.exports={parseOptions,validateEvidence,checkOutputPaths,triggerSnapshot,snapshot,apply,main};
if (require.main===module) main().catch(e=>{console.error(/^[a-z_]+$/.test(e.message)?e.message:'official_review_failed');process.exitCode=1;});
