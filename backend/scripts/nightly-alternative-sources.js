#!/usr/bin/env node
'use strict';
// No database, filesystem or network access unless a mode is explicitly selected.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const scopes = { PL: ['Premier League','E0'], SA: ['Serie A','I1'], PD: ['La Liga','SP1'], BL1: ['Bundesliga','D1'], FL1: ['Ligue 1','F1'] };
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
function sealManifest(result, targetSha256, generatedAt) {
  if (!Number.isFinite(Date.parse(generatedAt))) throw Error('nightly_sources_clock_invalid');
  const content={...result,schemaVersion:1,generatedAt,targetSha256};
  return {...content,manifestSha256:sha(JSON.stringify(canonical(content)))};
}
function parse(args) {
  const flags = new Set(['--plan','--execute','--collect-fdo','--collect-csv','--initialize-source-cache','--authorize-schema-writes','--csv-only']);
  const vals = new Set(['--season','--mapping','--target-sha256']); const out = {};
  for (let i=0;i<args.length;i++) {
    const key=args[i]; if ((!flags.has(key) && !vals.has(key)) || Object.hasOwn(out,key)) throw Error('nightly_sources_invalid_arguments');
    if (flags.has(key)) out[key]=true;
    else { if (!args[i+1] || args[i+1].startsWith('--')) throw Error('nightly_sources_invalid_arguments'); out[key]=args[++i]; }
  }
  if (!args.length) return { disabled:true };
  if ((!!out['--plan'] + !!out['--execute'] + !!out['--initialize-source-cache']) !== 1
    || !/^[a-f0-9]{64}$/.test(out['--target-sha256'] ?? '')
    || (!!out['--initialize-source-cache'] !== !!out['--authorize-schema-writes'])
    || (out['--csv-only'] && (out['--initialize-source-cache'] || out['--collect-fdo'] || out['--mapping']))
    || ((out['--collect-fdo'] || out['--collect-csv']) && !out['--execute'])) throw Error('nightly_sources_invalid_arguments');
  if (!out['--initialize-source-cache'] && (!/^20\d{2}$/.test(out['--season'] ?? '') || (!out['--csv-only'] && !out['--mapping']))) throw Error('nightly_sources_invalid_arguments');
  return out;
}
async function run(args, deps = {}) {
  const opts=parse(args); if (opts.disabled) return { mode:'disabled', networkRequests:0, writes:0 };
  const env=deps.env ?? process.env; const target=String(env.TURSO_DATABASE_URL ?? '');
  let url; try { url=new URL(target); } catch { throw Error('nightly_sources_target_invalid'); }
  if (!['libsql:','https:','file:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || sha(target)!==opts['--target-sha256']) throw Error('nightly_sources_target_mismatch');
  if (url.protocol === 'file:') {
    let stat;
    try { stat=fs.lstatSync(fileURLToPath(url)); } catch { throw Error('nightly_sources_target_missing'); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('nightly_sources_target_invalid');
  }
  const { createClient }=deps.libsql ?? require('@libsql/client');
  const dist=deps.dist ?? '../dist';
  const { SourceFeedStore }=require(path.join(dist,'services/SourceFeedStore'));
  const { NightlyCsvCache,collectNightlyCsv }=require(path.join(dist,'services/NightlyCsvCache'));
  const client=createClient({url:target,authToken:env.TURSO_AUTH_TOKEN || undefined});
  try {
    const seal = async result => {
      const clock=await client.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS generated_at");
      return sealManifest(result,opts['--target-sha256'],String(clock.rows[0]?.generated_at ?? ''));
    };
    const store=new SourceFeedStore(client), csvCache=new NightlyCsvCache(client);
    if (opts['--initialize-source-cache']) {
      await store.initialize({ shared:true,allowCreate:true }); await csvCache.initialize({allowCreate:true});
      return await seal({ mode:'schema_initialized', schemaWrites:true, networkRequests:0 });
    }
    const csvOnly=opts['--csv-only']===true;
    let feedReady=!csvOnly,csvReady=true;
    if (!csvOnly) try { await store.initialize({ shared:true }); } catch { feedReady=false; }
    try { await csvCache.initialize(); } catch { csvReady=false; }
    const mapping=csvOnly?null:JSON.parse(fs.readFileSync(opts['--mapping'],'utf8'));
    if (!csvOnly && (mapping?.version !== 'reviewed-source-mapping-v1' || typeof mapping.reference !== 'string' || !mapping.reference.trim()
      || !Number.isFinite(Date.parse(mapping.reviewedAt)) || !mapping.teams
      || Object.values(scopes).some(([name])=>!mapping.teams[name] || typeof mapping.teams[name] !== 'object'))) throw Error('nightly_sources_mapping_invalid');
    const season=Number(opts['--season']), execute=opts['--execute']===true;
    const result={ mode:execute?'execute':'plan', season, networkRequests:0, collection:{ fdo:null,csv:null }, competitions:[], updatedTeamIds:[], predictionsAttested:false };
    if (opts['--collect-fdo'] && !feedReady) result.collection.fdo={status:'unavailable',reason:'source_cache_unavailable'};
    if (opts['--collect-fdo'] && feedReady) {
      try {
        const { collectFootballDataOrgFeeds }=require(path.join(dist,'services/FootballDataOrgFeed'));
        const collected=await collectFootballDataOrgFeeds({store,season,apiKey:String(env.FOOTBALL_DATA_ORG_API_KEY ?? '')});
        result.networkRequests+=collected.networkRequests;
        result.collection.fdo={networkRequests:collected.networkRequests,successful:collected.successful,failed:collected.failed,cached:collected.cached};
      } catch { result.collection.fdo={status:'error',reason:'fdo_collection_failed'}; }
    }
    if (opts['--collect-csv'] && !csvReady) result.collection.csv={status:'unavailable',reason:'csv_cache_unavailable'};
    if (opts['--collect-csv'] && csvReady) {
      try { result.collection.csv=await collectNightlyCsv({cache:csvCache,season}); result.networkRequests+=result.collection.csv.networkRequests; }
      catch { result.collection.csv={status:'error',reason:'csv_collection_failed'}; }
    }
    const { runSourceFeedImport,applySourceFeedImport }=csvOnly?{}:require(path.join(dist,'services/SourceFeedImport'));
    const { importCapturedSupplement }=require(path.join(dist,'services/SourceSupplementImport'));
    const teams=new Set();
    for (const [competition,[local,csvCode]] of Object.entries(scopes)) {
      const item={ competition, local, feed:null, supplement:null }; result.competitions.push(item);
      const asOf=new Date().toISOString();
      if (csvOnly) item.feed={status:'skipped',reason:'csv_only',fixtures:[]};
      else try {
        if (!feedReady) throw Error('nightly_sources_feed_cache_unavailable');
        const sourceMapping={version:mapping.version,reference:mapping.reference,reviewedAt:mapping.reviewedAt,competition,season,teams:mapping.teams[local]};
        const planned=await runSourceFeedImport({client,store,competition,season,mapping:sourceMapping,asOf,allowCreateFixtures:true});
        const plan=planned.plan, state=await store.read(competition,season,asOf);
        const fixtureById=new Map((state.snapshot?.fixtures ?? []).map(f=>[f.providerMatchId,f]));
        item.feed={ source:'football-data.org', status:plan.status,reason:plan.reason,planHash:plan.planHash, mappingSha256:plan.mappingSha256,
          attemptedAt:state.latestAttempt?.requestedAt ?? null, acquiredAt:plan.source?.acquiredAt ?? null,
          payloadSha256:plan.source?.payloadSha256 ?? null, counts:plan.counts, result:null,
          fixtures:plan.entries.map(entry=>({ ...entry, providerStatus:fixtureById.get(entry.providerMatchId)?.status ?? null,
            homeTeamId:plan.mapping.teams[fixtureById.get(entry.providerMatchId)?.providerHomeTeamId] ?? null,
            awayTeamId:plan.mapping.teams[fixtureById.get(entry.providerMatchId)?.providerAwayTeamId] ?? null,
            kickoffUtc:fixtureById.get(entry.providerMatchId)?.kickoffUtc ?? null })) };
        if (execute && ['ready','blocked'].includes(plan.status)) {
          item.feed.result=await applySourceFeedImport({client,store,plan,asOf:new Date().toISOString(),
            allowVerifiedSubset:plan.status==='blocked',expectedPlanHash:plan.planHash});
          for (const row of plan.updates) { teams.add(row.before.home_team_id); teams.add(row.before.away_team_id); }
          for (const row of plan.creates) { teams.add(String(row.after.home_team_id)); teams.add(String(row.after.away_team_id)); }
        }
      } catch (error) { item.feed={...(item.feed ?? {fixtures:[]}),status:feedReady?'error':'unavailable',reason:!feedReady?'source_cache_unavailable':/^source_(?:import|feed)_[a-z_]+$/.test(error.message)?error.message:'nightly_sources_feed_failed'}; }
      try {
        if (!csvReady) throw Error('nightly_sources_csv_cache_unavailable');
        const cached=await csvCache.read(season,csvCode);
        if (!cached) item.supplement={status:'unavailable',reason:'csv_not_cached'};
        else {
          item.supplement={status:execute?'pending':'planned', acquiredAt:cached.acquiredAt, sha256:cached.sha256,
            attemptId:cached.attemptId, latestAttempt:cached.latestAttempt, result:null};
          if (execute) {
            const seasonCode=`${String(season).slice(-2)}${String(season+1).slice(-2)}`;
            const imported=await importCapturedSupplement({client,csv:cached.csv,competition:local,seasonStart:season, acquiredAt:cached.acquiredAt,
              asOf:new Date().toISOString(),sha256:cached.sha256,sourceUrl:`https://www.football-data.co.uk/mmz4281/${seasonCode}/${csvCode}.csv`,
              excludedMatchIds:(item.feed.fixtures ?? []).filter(f=>f.action==='BLOCK').flatMap(f=>[f.localMatchId,...(f.relatedLocalMatchIds ?? [])]).filter(Boolean)});
            item.supplement.status='applied'; item.supplement.result=imported; imported.updatedTeamIds.forEach(id=>teams.add(id));
          }
        }
      } catch (error) { item.supplement={status:csvReady?'error':'unavailable',reason:csvReady && /^(supplement|nightly_csv)_[a-z_]+$/.test(error.message)?error.message:csvReady?'nightly_sources_supplement_failed':'csv_cache_unavailable'}; }
    }
    result.updatedTeamIds=[...teams].sort(); return await seal(result);
  } finally { client.close(); }
}
module.exports={parse,run,canonical,sealManifest};
if (require.main===module) run(process.argv.slice(2)).then(result=>{process.stdout.write(`${JSON.stringify(result)}\n`);}).catch(error=>{process.stdout.write(`${JSON.stringify({mode:'error',error:/^nightly_sources_[a-z_]+$/.test(error.message)?error.message:'nightly_sources_failed'})}\n`);process.exitCode=1;});
