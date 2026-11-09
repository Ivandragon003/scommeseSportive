'use strict';
// Explicit, scoped maintenance; importing this module never opens a database.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createClient } = require('@libsql/client');
const { targetFor, verifiedBackup } = require('./reset-challenger-production');
const { CURRENT_CHALLENGER_RELEASE: release } = require('../dist/research/CurrentChallengerRelease');
const { researchHash } = require('../dist/research/ResearchStore');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows = async (db, sql, args = []) => (await db.execute({ sql, args })).rows.map(row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k, typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v])));
const familyTables = ['research_decisions','research_execution_decisions','research_bets','research_prospective_observations','manual_model_archives','paper_model_bets','funded_model_bets','dynamic_model_bets'];
const protectedTables = ['research_inputs','research_execution_inputs','research_jobs','research_execution_jobs','research_execution_policies','research_portfolios','research_worker_state','research_bet_cancellations','research_settlements','paper_model_settlements','paper_model_bet_cancellations','funded_model_settlements','funded_model_bet_cancellations','dynamic_model_settlements','research_prospective_results','research_prospective_invalidations','research_model_events','research_champions','challenger_candidate_reviews','challenger_paired_forecasts','challenger_forecast_results','research_monitor_incidents','research_notifications'];
const changedTables = ['manual_model_bets','manual_model_settlements','research_ledger','research_models','research_markets','research_market_events','research_benchmarks','challenger_candidates','challenger_adoption_events','scheduler_runs'];
const triggerNames = ['challenger_adoption_no_delete','challenger_candidates_no_delete','manual_model_bets_immutable_delete','manual_model_settlements_immutable_delete','research_benchmarks_immutable_delete','research_ledger_immutable_delete','research_market_events_immutable_delete','research_models_immutable_delete'];
async function fingerprint(db, table, where = '1', args = []) {
  const values = await rows(db, `SELECT * FROM "${table}" WHERE ${where}`, args);
  return { count: values.length, sha256: hash(values.map(hash).sort()) };
}
async function inspect(db) {
  const schema = await rows(db, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name");
  const tables = schema.filter(x => x.type === 'table').map(x => x.name);
  if ([...changedTables,...familyTables,...protectedTables].some(x => !tables.includes(x))) throw Error('required_schema_missing');
  for (const table of tables.filter(x => !x.startsWith('sqlite_'))) {
    if (!/^[A-Za-z0-9_]+$/.test(table)) throw Error('unexpected_table_name');
    const foreignKeys = await rows(db, `PRAGMA foreign_key_list("${table}")`);
    if (foreignKeys.some(f => changedTables.includes(f.table) && !['NO ACTION','RESTRICT'].includes(f.on_delete))) throw Error('unsafe_delete_dependency');
  }
  if ((await rows(db, 'PRAGMA foreign_key_check')).length) throw Error('foreign_key_violation');
  const scoped = {};
  for (const table of [...changedTables,...familyTables,...protectedTables]) scoped[table] = await fingerprint(db, table);
  for (const table of familyTables) if ((await rows(db, `SELECT count(*) AS n FROM "${table}" WHERE family='C'`))[0].n !== 0) throw Error('unexpected_c_operational_history');
  for (const table of ['challenger_candidate_reviews','challenger_paired_forecasts','challenger_forecast_results']) if (scoped[table].count) throw Error('challenger_evidence_dependency');
  if ((await rows(db, "SELECT count(*) AS n FROM research_bet_cancellations WHERE NOT json_valid(bet_json) OR COALESCE(json_extract(bet_json,'$.family'),'') NOT IN ('A','C') OR json_extract(bet_json,'$.family')='C'"))[0].n) throw Error('c_cancellation_dependency');
  if ((await rows(db, "SELECT count(*) AS n FROM research_model_events WHERE family='C'"))[0].n || (await rows(db, "SELECT count(*) AS n FROM research_champions WHERE family='C'"))[0].n) throw Error('c_model_dependency');
  const model = await rows(db, "SELECT * FROM research_models WHERE family='C' AND version=?", [release.modelVersion]);
  if (model.length !== 1 || model[0].artifact_hash !== release.artifactHash || researchHash(JSON.parse(model[0].artifact_json)) !== release.artifactHash) throw Error('current_model_mismatch');
  const adoption = await rows(db, 'SELECT * FROM challenger_adoption_events ORDER BY sequence');
  const latest = adoption.at(-1);
  if (!latest || latest.action !== 'ADOPT' || latest.candidate_id !== null || researchHash(JSON.parse(latest.deployment_json)) !== researchHash(release)) throw Error('current_adoption_mismatch');
  if (adoption.slice(0,-1).some(x => x.candidate_id !== null || x.action !== 'ADOPT')) throw Error('adoption_candidate_dependency');
  const bets = await rows(db, "SELECT b.id,b.model_version,b.stake_cents,s.return_cents FROM manual_model_bets b LEFT JOIN manual_model_settlements s ON s.bet_id=b.id WHERE b.family='C'");
  if (bets.some(b => b.model_version === release.modelVersion || b.return_cents === null)) throw Error('current_or_unsettled_manual_bet');
  const ledger = await rows(db, "SELECT * FROM research_ledger WHERE portfolio_id='shadow_C'");
  const open = ledger.filter(x => x.event === 'OPEN');
  if (open.length !== 1 || open[0].bet_id !== null || Number(open[0].committed_delta_cents) !== 0 || ledger.length !== 1 + bets.length * 2) throw Error('ledger_shape_mismatch');
  for (const bet of bets) {
    const stake = ledger.find(x => x.id === `stake:${bet.id}`), settle = ledger.find(x => x.id === `settle:${bet.id}`);
    if (!stake || !settle || stake.event !== 'STAKE' || settle.event !== 'SETTLE' || stake.bet_id !== null || settle.bet_id !== null
      || Number(stake.available_delta_cents) !== -Number(bet.stake_cents) || Number(stake.committed_delta_cents) !== Number(bet.stake_cents)
      || Number(settle.available_delta_cents) !== Number(bet.return_cents) || Number(settle.committed_delta_cents) !== -Number(bet.stake_cents)) throw Error('ledger_bet_mismatch');
  }
  const balance = ledger.reduce((a,x) => a + Number(x.available_delta_cents), 0);
  if (!Number.isSafeInteger(balance) || balance < 0 || ledger.reduce((a,x) => a + Number(x.committed_delta_cents), 0) !== 0) throw Error('ledger_balance_mismatch');
  const extraGuards = schema.filter(x => x.type === 'trigger' && changedTables.includes(x.tbl_name) && /(?:before|after|instead\s+of)\s+delete/i.test(x.sql) && !triggerNames.includes(x.name));
  if (extraGuards.length) throw Error('unexpected_delete_guard');
  const guards = schema.filter(x => x.type === 'trigger' && triggerNames.includes(x.name));
  if (guards.length !== triggerNames.length || guards.some(x => !changedTables.includes(x.tbl_name) || !/before\s+delete/i.test(x.sql))) throw Error('unexpected_delete_guards');
  for (const table of ['research_monitor_incidents','research_notifications']) {
    if (Number((await rows(db, `SELECT count(*) AS n FROM ${table} WHERE incident_key LIKE 'research_model_check_repeated_failure:C:%'`))[0].n)) throw Error('c_monitor_dependency');
  }
  const invalidScheduler = await rows(db, "SELECT count(*) AS n FROM scheduler_runs WHERE scheduler_name='research_model_check' AND (NOT json_valid(summary_json) OR COALESCE(json_extract(summary_json,'$.family'),'') NOT IN ('A','C') OR COALESCE(json_extract(summary_json,'$.modelVersion'),'')='')");
  if (Number(invalidScheduler[0].n)) throw Error('unclassified_scheduler_history');
  const obsoleteScheduler = Number((await rows(db, "SELECT count(*) AS n FROM scheduler_runs WHERE scheduler_name='research_model_check' AND json_extract(summary_json,'$.family')='C' AND json_extract(summary_json,'$.modelVersion')<>?", [release.modelVersion]))[0].n);
  const obsoleteModels = Number((await rows(db, "SELECT count(*) AS n FROM research_models WHERE family='C' AND version<>?", [release.modelVersion]))[0].n);
  const obsoleteMarkets = Number((await rows(db, "SELECT count(*) AS n FROM research_markets WHERE family='C' AND model_version<>?", [release.modelVersion]))[0].n);
  const obsoleteEvents = Number((await rows(db, "SELECT count(*) AS n FROM research_market_events WHERE family='C' AND model_version<>?", [release.modelVersion]))[0].n);
  const obsoleteBenchmarks = Number((await rows(db, "SELECT count(*) AS n FROM research_benchmarks WHERE family='C' AND model_version<>?", [release.modelVersion]))[0].n);
  if ((await rows(db, "SELECT count(*) AS n FROM research_benchmarks WHERE family='C' AND model_version IS NULL"))[0].n) throw Error('unclassified_benchmark');
  if ((await rows(db, 'SELECT count(*) AS n FROM challenger_candidates WHERE model_version=? OR reference_version=?', [release.modelVersion,release.modelVersion]))[0].n) throw Error('current_candidate_dependency');
  const preserved = {};
  for (const table of ['research_models','research_markets','research_market_events','research_benchmarks']) {
    const key = table === 'research_models' ? 'version' : 'model_version';
    preserved[table] = await fingerprint(db, table, `family<>'C' OR ${key}=?`, [release.modelVersion]);
  }
  preserved.manual_model_bets = await fingerprint(db,'manual_model_bets',"family<>'C'");
  preserved.manual_model_settlements = await fingerprint(db,'manual_model_settlements',"bet_id NOT IN (SELECT id FROM manual_model_bets WHERE family='C')");
  preserved.research_ledger = await fingerprint(db,'research_ledger',"portfolio_id<>'shadow_C'");
  preserved.scheduler_runs = await fingerprint(db,'scheduler_runs',"scheduler_name<>'research_model_check' OR json_extract(summary_json,'$.family')<>'C' OR json_extract(summary_json,'$.modelVersion')=?",[release.modelVersion]);
  preserved.challenger_adoption_events = await fingerprint(db,'challenger_adoption_events','sequence=?',[latest.sequence]);
  return { schemaHash: hash(schema), guards, scoped, preserved, balance, counts: { bets: bets.length, ledger: ledger.length, obsoleteScheduler, obsoleteModels, obsoleteMarkets, obsoleteEvents, obsoleteBenchmarks, candidates: scoped.challenger_candidates.count, adoption: adoption.length - 1 }, latestSequence: latest.sequence };
}
async function buildPlan(db, target) {
  const tx = await db.transaction('read');
  try { const snapshot = await inspect(tx); const plan = { format: 'selective-c-prune-v1', target, plannedAt: new Date().toISOString(), release, openingCents: 100000, snapshot }; return { ...plan, planHash: hash(plan) }; }
  finally { await tx.rollback(); tx.close(); }
}
async function applyPlan(db, plan) {
  const tx = await db.transaction('write');
  try {
    if (plan.openingCents !== 100000) throw Error('invalid_opening_amount');
    const before = await inspect(tx);
    if (hash(before) !== hash(plan.snapshot)) throw Error('planned_state_changed');
    for (const g of before.guards) await tx.execute(`DROP TRIGGER "${g.name}"`);
    await tx.execute("DELETE FROM manual_model_settlements WHERE bet_id IN (SELECT id FROM manual_model_bets WHERE family='C')");
    await tx.execute("DELETE FROM manual_model_bets WHERE family='C'");
    if (before.counts.bets || before.balance !== plan.openingCents) {
      await tx.execute("DELETE FROM research_ledger WHERE portfolio_id='shadow_C'");
      await tx.execute({sql:"INSERT INTO research_ledger(id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at) VALUES('open:shadow_C','shadow_C',NULL,'OPEN',?,0,?)",args:[plan.openingCents,plan.plannedAt]});
    }
    for (const table of ['research_market_events','research_markets','research_benchmarks']) await tx.execute({sql:`DELETE FROM ${table} WHERE family='C' AND model_version<>?`,args:[release.modelVersion]});
    await tx.execute({sql:"DELETE FROM research_models WHERE family='C' AND version<>?",args:[release.modelVersion]});
    await tx.execute({sql:'DELETE FROM challenger_adoption_events WHERE sequence<>?',args:[before.latestSequence]});
    await tx.execute('DELETE FROM challenger_candidates');
    await tx.execute({sql:"DELETE FROM scheduler_runs WHERE scheduler_name='research_model_check' AND json_extract(summary_json,'$.family')='C' AND json_extract(summary_json,'$.modelVersion')<>?",args:[release.modelVersion]});
    for (const g of before.guards) await tx.execute(g.sql);
    const after = await inspect(tx);
    if (after.schemaHash !== before.schemaHash || after.balance !== plan.openingCents || after.counts.bets || after.counts.obsoleteScheduler || after.counts.obsoleteModels || after.counts.obsoleteMarkets || after.counts.obsoleteEvents || after.counts.obsoleteBenchmarks || after.counts.candidates || after.counts.adoption) throw Error('postcondition_failed');
    for (const table of [...familyTables,...protectedTables]) if (hash(after.scoped[table]) !== hash(before.scoped[table])) throw Error('protected_data_changed');
    if (hash(after.preserved)!==hash(before.preserved)) throw Error('protected_data_changed');
    await tx.commit(); return after;
  } catch (e) { await tx.rollback().catch(() => {}); throw e; } finally { tx.close(); }
}
function optionsOf(args) {
  const o = {}; for (let i=0;i<args.length;i++) { const k=args[i]; if (!['--plan','--apply','--database','--expected-host','--backup-manifest','--expected-plan-hash','--receipt'].includes(k) || o[k] || !args[i+1] || args[i+1].startsWith('--')) throw Error('invalid_arguments'); o[k]=args[++i]; }
  if (!!o['--plan'] === !!o['--apply']) throw Error('select_plan_or_apply');
  return o;
}
function journal(fd, data) { const bytes=Buffer.from(JSON.stringify(data)+'\n'); let n=0; while(n<bytes.length) n+=fs.writeSync(fd,bytes,n,bytes.length-n,n); fs.ftruncateSync(fd,bytes.length); fs.fsyncSync(fd); }
async function main(args=process.argv.slice(2), env=process.env) {
  const o=optionsOf(args), target=targetFor(o,env), local=target.identity.kind==='local';
  const token=local ? undefined : o['--plan'] ? env.TURSO_WATCHDOG_READONLY_TOKEN : env.TURSO_AUTH_TOKEN;
  if (!local && !token) throw Error('database_token_required');
  const db=createClient({url:target.url,authToken:token});
  try {
    if (o['--plan']) {
      const plan=await buildPlan(db,target.identity); fs.writeFileSync(o['--plan'],JSON.stringify(plan)+'\n',{flag:'wx',mode:0o600});
      console.log(JSON.stringify({action:'plan_only',planHash:plan.planHash,counts:plan.snapshot.counts})); return;
    }
    if (!o['--backup-manifest'] || !o['--receipt'] || !/^[a-f0-9]{64}$/.test(o['--expected-plan-hash']||'')) throw Error('apply_requires_plan_backup_receipt');
    const plan=JSON.parse(fs.readFileSync(o['--apply'],'utf8')), {planHash,...content}=plan;
    if (planHash!==o['--expected-plan-hash'] || hash(content)!==planHash || hash(plan.target)!==hash(target.identity) || hash(plan.release)!==hash(release) || plan.openingCents!==100000) throw Error('plan_identity_mismatch');
    const backup=await verifiedBackup(o['--backup-manifest'],target.identity);
    if (!Number.isFinite(Date.parse(backup.startedAt)) || Date.parse(backup.startedAt)<Date.parse(plan.plannedAt)-86400000 || Date.parse(backup.startedAt)>Date.now()) throw Error('fresh_backup_required');
    const backupDb=createClient({url:`file:${path.join(path.dirname(path.resolve(o['--backup-manifest'])),'restore.db')}`});
    try { if (hash(await inspect(backupDb))!==hash(plan.snapshot)) throw Error('backup_state_mismatch'); } finally { backupDb.close(); }
    const fd=fs.openSync(o['--receipt'],'wx',0o600), pending={format:'selective-c-prune-receipt-v1',status:'PENDING',verified:false,planHash,backupHash:backup.databaseSha256,previousBalanceCents:plan.snapshot.balance,openingCents:plan.openingCents};
    try { journal(fd,pending); const result=await applyPlan(db,plan); journal(fd,{...pending,status:'COMPLETE',verified:true,counts:result.counts,balance:result.balance}); console.log(JSON.stringify({action:'applied',planHash,counts:result.counts})); }
    catch { try {journal(fd,{...pending,status:'FAILED_UNKNOWN'});} catch {} throw Error('prune_failed_check_receipt'); } finally {fs.closeSync(fd);}
  } finally {db.close();}
}
module.exports={inspect,buildPlan,applyPlan,optionsOf,main};
if (require.main===module) main().catch(e=>{console.error(/^[a-z_]+$/.test(e.message||'')?e.message:'selective_prune_failed');process.exitCode=1;});
