#!/usr/bin/env node
'use strict';
// No provider calls or schema initialization. With no operation, this is inert.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const codes = ['I1', 'E0', 'SP1', 'D1', 'F1'];
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function parse(args) {
  if (!args.length) return { disabled: true };
  const flags = new Set(['--plan', '--execute', '--authorize-cache-writes']);
  const values = new Set(['--target-sha256', '--csv-directory', '--receipt', '--receipt-sha256', '--season', '--expected-plan-sha256']);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if ((!flags.has(key) && !values.has(key)) || Object.hasOwn(out, key)) throw Error('csv_seed_arguments_invalid');
    if (flags.has(key)) out[key] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('csv_seed_arguments_invalid'); out[key] = args[++i]; }
  }
  if ((out['--plan'] && out['--execute']) || (!!out['--execute'] !== !!out['--authorize-cache-writes'])
    || !/^[a-f0-9]{64}$/.test(out['--target-sha256'] ?? '') || !/^[a-f0-9]{64}$/.test(out['--receipt-sha256'] ?? '')
    || !/^20\d{2}$/.test(out['--season'] ?? '') || !out['--csv-directory'] || !out['--receipt']
    || (out['--execute'] && !/^[a-f0-9]{64}$/.test(out['--expected-plan-sha256'] ?? ''))
    || (!out['--execute'] && out['--expected-plan-sha256'])) throw Error('csv_seed_arguments_invalid');
  return { ...out, execute: out['--execute'] === true, season: Number(out['--season']) };
}
function regularFile(filename, limit) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error('csv_seed_file_invalid');
  return fs.readFileSync(filename);
}
function validCsv(csv, code, season, acquiredAt) {
  const lines=csv.split(/\r?\n/).filter(line=>line.trim());
  if (lines.length<2 || lines.some(line=>line.includes('"'))) throw Error('csv_seed_csv_invalid');
  const columns=lines[0].replace(/^\uFEFF/,'').split(',');
  const required=['Div','Date','HomeTeam','AwayTeam','FTHG','FTAG'];
  if (required.some(field=>columns.filter(column=>column===field).length!==1)) throw Error('csv_seed_csv_invalid');
  const positions=Object.fromEntries(required.map(field=>[field,columns.indexOf(field)]));
  for (const line of lines.slice(1)) {
    const fields=line.split(','); const match=/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(fields[positions.Date]?.trim() ?? '');
    if (fields.length!==columns.length || fields[positions.Div]?.trim()!==code || !match
      || !fields[positions.HomeTeam]?.trim() || !fields[positions.AwayTeam]?.trim()
      || !/^\d+$/.test(fields[positions.FTHG]?.trim() ?? '') || !/^\d+$/.test(fields[positions.FTAG]?.trim() ?? '')) throw Error('csv_seed_csv_invalid');
    const year=Number(match[3].length===2 ? `20${match[3]}` : match[3]);
    const iso=`${year}-${match[2]}-${match[1]}`, date=new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==iso || iso<`${season}-07-01`
      || iso>=`${season+1}-07-01` || date.getTime()>Date.parse(acquiredAt)) throw Error('csv_seed_csv_invalid');
  }
}
function loadReceipt(options) {
  const bytes=regularFile(options['--receipt'],100_000);
  if (sha(bytes)!==options['--receipt-sha256']) throw Error('csv_seed_receipt_hash_mismatch');
  let receipt; try { receipt=JSON.parse(bytes.toString('utf8')); } catch { throw Error('csv_seed_receipt_invalid'); }
  if (!receipt || receipt.season!==options.season || typeof receipt.acquiredAt!=='string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(receipt.acquiredAt)
    || !Number.isFinite(Date.parse(receipt.acquiredAt)) || !receipt.files || typeof receipt.files!=='object' || Array.isArray(receipt.files)
    || Object.keys(receipt.files).sort().join(',')!==[...codes].sort().join(',')) throw Error('csv_seed_receipt_invalid');
  const actual=new Date(receipt.acquiredAt);
  if (actual.toISOString()!==receipt.acquiredAt) throw Error('csv_seed_receipt_invalid');
  const dir=fs.lstatSync(options['--csv-directory']);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error('csv_seed_directory_invalid');
  const seasonCode=`${String(options.season).slice(-2)}${String(options.season+1).slice(-2)}`;
  const files=codes.map(code=>{
    const item=receipt.files[code], filename=`${code}-${seasonCode}.csv`;
    if (!item || item.filename!==filename || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw Error('csv_seed_receipt_invalid');
    const bytes=regularFile(path.join(options['--csv-directory'],filename),5_000_000);
    if (sha(bytes)!==item.sha256) throw Error('csv_seed_file_hash_mismatch');
    let csv; try { csv=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); } catch { throw Error('csv_seed_csv_invalid'); }
    validCsv(csv,code,options.season,receipt.acquiredAt);
    return {code,sha256:item.sha256,csv};
  });
  return { acquiredAt:receipt.acquiredAt, files };
}
async function inspect(client, options, capture) {
  const objects=await client.execute("SELECT name,type FROM sqlite_master WHERE name IN ('nightly_csv_meta','nightly_csv_attempts','nightly_csv_snapshots')");
  if (objects.rows.length!==3 || objects.rows.some(row=>row.type!=='table')) throw Error('csv_seed_cache_unavailable');
  const meta=await client.execute("SELECT key,value FROM nightly_csv_meta WHERE key IN ('marker','collection_not_before')");
  const values=Object.fromEntries(meta.rows.map(row=>[String(row.key),String(row.value)]));
  if (values.marker!=='nightly_csv_cache_v1' || !Number.isFinite(Date.parse(values.collection_not_before))) throw Error('csv_seed_cache_unavailable');
  const now=await client.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now");
  if (!Number.isFinite(Date.parse(String(now.rows[0]?.now))) || Date.parse(capture.acquiredAt)>Date.parse(String(now.rows[0].now))) throw Error('csv_seed_acquisition_future');
  const prior=await client.execute({sql:'SELECT id,status,requested_at,finished_at FROM nightly_csv_attempts WHERE season=? AND julianday(requested_at)=julianday(?) ORDER BY id',args:[options.season,capture.acquiredAt]});
  let action='insert';
  if (prior.rows.length) {
    if (prior.rows.length!==1 || prior.rows[0].status!=='success' || prior.rows[0].finished_at!==capture.acquiredAt) throw Error('csv_seed_existing_conflict');
    const rows=await client.execute({sql:'SELECT code,acquired_at,sha256,csv FROM nightly_csv_snapshots WHERE attempt_id=? ORDER BY code',args:[Number(prior.rows[0].id)]});
    if (rows.rows.length!==5 || capture.files.some(file=>{
      const matches=rows.rows.filter(row=>row.code===file.code);
      return matches.length!==1 || matches[0].acquired_at!==capture.acquiredAt || matches[0].sha256!==file.sha256 || sha(String(matches[0].csv))!==file.sha256;
    })) throw Error('csv_seed_existing_conflict');
    action='already_present';
  }
  const data={version:1,action,targetSha256:options['--target-sha256'],receiptSha256:options['--receipt-sha256'],season:options.season,
    acquiredAt:capture.acquiredAt,files:capture.files.map(({code,sha256})=>({code,sha256}))};
  return {...data,planSha256:sha(JSON.stringify(canonical(data)))};
}
async function run(args=[],dependencies={}) {
  const options=parse(args); if (options.disabled) return {mode:'disabled',writes:0,networkRequests:0};
  const env=dependencies.env ?? process.env,target=String(env.TURSO_DATABASE_URL ?? '');
  let url; try { url=new URL(target); } catch { throw Error('csv_seed_target_invalid'); }
  if (!['file:','libsql:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || sha(target)!==options['--target-sha256']) throw Error('csv_seed_target_mismatch');
  if (url.protocol==='file:') { let stat; try { stat=fs.lstatSync(fileURLToPath(url)); } catch { throw Error('csv_seed_target_missing'); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('csv_seed_target_invalid'); }
  const capture=loadReceipt(options);
  const createClient=dependencies.createClient ?? require('@libsql/client').createClient;
  const client=createClient({url:target,authToken:env.TURSO_AUTH_TOKEN || undefined});
  try {
    const plan=await inspect(client,options,capture);
    if (!options.execute) return {mode:'plan',plan,writes:0,networkRequests:0};
    const approved = candidate => {
      const {planSha256,...content}=candidate;
      return options['--expected-plan-sha256']===planSha256 || (candidate.action==='already_present'
        && options['--expected-plan-sha256']===sha(JSON.stringify(canonical({...content,action:'insert'}))));
    };
    if (!approved(plan)) throw Error('csv_seed_plan_changed');
    if (plan.action==='already_present') return {mode:'execute',plan,writes:0,networkRequests:0};
    const tx=await client.transaction('write');
    try {
      const checked=await inspect(tx,options,capture);
      if (checked.action==='already_present' && approved(checked)) {
        await tx.rollback();
        return {mode:'execute',plan:checked,writes:0,networkRequests:0};
      }
      if (checked.planSha256!==plan.planSha256 || checked.action!=='insert') throw Error('csv_seed_plan_changed');
      const result=await tx.execute({sql:"INSERT INTO nightly_csv_attempts(season,requested_at,finished_at,status) VALUES (?,?,?,'success') RETURNING id",
        args:[options.season,capture.acquiredAt,capture.acquiredAt]});
      if (result.rows.length!==1) throw Error('csv_seed_write_failed');
      const id=Number(result.rows[0].id);
      for (const file of capture.files) await tx.execute({sql:'INSERT INTO nightly_csv_snapshots(attempt_id,code,acquired_at,sha256,csv) VALUES (?,?,?,?,?)',
        args:[id,file.code,capture.acquiredAt,file.sha256,file.csv]});
      await tx.commit();
      return {mode:'execute',plan,writes:6,networkRequests:0};
    } catch(error) { try { await tx.rollback(); } catch { /* retain original error */ } throw error; }
    finally {tx.close?.();}
  } finally {client.close();}
}
module.exports={parse,loadReceipt,inspect,run};
if (require.main===module) run(process.argv.slice(2)).then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{
  process.stdout.write(`${JSON.stringify({mode:'error',error:/^csv_seed_[a-z_]+$/.test(error.message)?error.message:'csv_seed_failed'})}\n`);process.exitCode=1;
});
