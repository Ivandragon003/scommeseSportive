const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const dist=process.env.NIGHTLY_TEST_DIST ?? require('node:path').resolve(__dirname,'../dist');
const { NightlyCsvCache, collectNightlyCsv } = require(require('node:path').join(dist,'services/NightlyCsvCache'));
const { SourceFeedStore } = require(require('node:path').join(dist,'services/SourceFeedStore'));
const { parse, run, canonical, sealManifest } = require('../scripts/nightly-alternative-sources');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const testCsv=code=>`Div,Date,HomeTeam,AwayTeam,FTHG,FTAG\n${code},01/09/26,Home,Away,1,0`;

async function fixture() {
  const client=createClient({url:'file::memory:'});
  await client.execute('CREATE TABLE unrelated(id INTEGER)');
  const feed=new SourceFeedStore(client); await feed.initialize({shared:true,allowCreate:true});
  const cache=new NightlyCsvCache(client); await cache.initialize({allowCreate:true});
  await client.execute("UPDATE nightly_csv_meta SET value=strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days') WHERE key='collection_not_before'");
  return {client,cache};
}

test('cache schemas never bootstrap implicitly and support an explicitly shared database', async()=>{
  const client=createClient({url:'file::memory:'});
  try {
    await client.execute('CREATE TABLE unrelated(id INTEGER)');
    await assert.rejects(new SourceFeedStore(client).initialize({shared:true}), /source_feed_database_not_dedicated/);
    await assert.rejects(new NightlyCsvCache(client).initialize(), /nightly_csv_cache_not_initialized/);
    assert.equal((await client.execute("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'nightly_csv_%'")).rows[0].n,0);
    await new SourceFeedStore(client).initialize({shared:true,allowCreate:true});
    await new NightlyCsvCache(client).initialize({allowCreate:true});
    await new SourceFeedStore(client).initialize({shared:true}); await new NightlyCsvCache(client).initialize();
    assert.equal(await new NightlyCsvCache(client).initialize().then(async()=>{const c=new NightlyCsvCache(client);await c.initialize();return c.reserve(2026)}),null);
    await client.execute("DELETE FROM nightly_csv_meta WHERE key='collection_not_before'");
    await assert.rejects(new NightlyCsvCache(client).initialize(),/nightly_csv_cutover_uninitialized/);
    await new NightlyCsvCache(client).initialize({allowCreate:true});
    const restored=(await client.execute("SELECT value FROM nightly_csv_meta WHERE key='collection_not_before'")).rows[0].value;
    assert.ok(Date.parse(restored) > Date.now()+6*86400000);
  } finally {client.close();}
});

test('pending and failed collection attempts consume the shared rolling budget',async()=>{
  const {client,cache}=await fixture();
  try {
    const a=await cache.reserve(2026); assert.ok(a); assert.equal(await cache.reserve(2026),null);
    await cache.finish(a,2026,[]);
    const b=await cache.reserve(2026); assert.ok(b); await cache.finish(b,2026,[]);
    assert.equal(await cache.reserve(2025),null);
  } finally {client.close();}
});

test('two independent clients cannot reserve overlapping collection slots', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightly-csv-concurrency-'));
  const url=pathToFileURL(path.join(dir,'cache.sqlite')).href;
  const first=createClient({url}), second=createClient({url});
  try {
    const a=new NightlyCsvCache(first), b=new NightlyCsvCache(second);
    await a.initialize({allowCreate:true}); await b.initialize();
    await first.execute("UPDATE nightly_csv_meta SET value=strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days') WHERE key='collection_not_before'");
    const claims=await Promise.all([a.reserve(2026),b.reserve(2026)]);
    assert.equal(claims.filter(value=>value !== null).length,1);
    assert.equal((await first.execute('SELECT count(*) n FROM nightly_csv_attempts')).rows[0].n,1);
  } finally {first.close(); second.close(); await fs.promises.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});

test('cache hit retains actual acquisition time and 429 stops a collection',async()=>{
  const {client,cache}=await fixture();
  try {
    let calls=0;
    const collected=await collectNightlyCsv({cache,season:2026,fetcher:async()=>{
      calls++; return calls===1 ? new Response(testCsv('I1')) : new Response('',{status:429});
    }});
    assert.equal(calls,2); assert.equal(collected.networkRequests,2); assert.equal(collected.successful,1);
    assert.equal(collected.reason,'provider_rate_limited');
    assert.equal(await cache.reserve(2026),null);
    const saved=await cache.read(2026,'I1'); assert.ok(saved); assert.equal(saved.status,'partial');
    assert.deepEqual(await cache.read(2026,'I1'),saved);
    assert.equal(await cache.read(2026,'E0'),null);
  } finally {client.close();}
});

test('a complete collection observes 84 hour spacing and the rolling weekly limit across seasons',async()=>{
  const {client,cache}=await fixture();
  try {
    const fetcher=async url=>new Response(testCsv(/\/([^/]+)\.csv$/.exec(url)[1]));
    assert.equal((await collectNightlyCsv({cache,season:2026,fetcher})).successful,5);
    assert.equal(await cache.reserve(2027),null);
    await client.execute("UPDATE nightly_csv_attempts SET requested_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-84 hours','-1 minute'),finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-84 hours','-1 minute')");
    assert.equal((await collectNightlyCsv({cache,season:2027,fetcher})).successful,5);
    await client.execute("UPDATE nightly_csv_attempts SET requested_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-85 hours'),finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-85 hours') WHERE season=2027");
    assert.equal(await cache.reserve(2026),null);
  } finally {client.close();}
});

test('a failed partial collection can retry once without downloading successful files twice',async()=>{
  const {client,cache}=await fixture();
  try {
    const requested=[];
    const first=await collectNightlyCsv({cache,season:2026,fetcher:async url=>{
      const code=/\/([^/]+)\.csv$/.exec(url)[1]; requested.push(code);
      return code==='I1' ? new Response(testCsv(code)) : new Response('',{status:500});
    }});
    assert.equal(first.successful,1);
    const second=await collectNightlyCsv({cache,season:2026,fetcher:async url=>{const code=/\/([^/]+)\.csv$/.exec(url)[1];requested.push(code);return new Response(testCsv(code));}});
    assert.equal(second.successful,4); assert.equal(second.reason,null);
    assert.equal(requested.filter(code=>code==='I1').length,1);
    assert.equal((await client.execute('SELECT status FROM nightly_csv_attempts ORDER BY id DESC LIMIT 1')).rows[0].status,'success');
    assert.equal(await cache.reserve(2026),null);
  } finally {client.close();}
});

test('an HTTP 200 error page does not become a successful collection',async()=>{
  const {client,cache}=await fixture();
  try {
    const result=await collectNightlyCsv({cache,season:2026,fetcher:async()=>new Response('<html>error</html>')});
    assert.equal(result.successful,0); assert.equal(result.reason,'collection_incomplete');
    assert.equal((await client.execute('SELECT status FROM nightly_csv_attempts')).rows[0].status,'failure');
    assert.ok(await cache.reserve(2026));
  } finally {client.close();}
});

test('manifest digest binds canonical content and target',()=>{
  const manifest=sealManifest({mode:'plan',competitions:[]},'a'.repeat(64),'2026-11-06T00:00:00.000Z');
  const {manifestSha256,...content}=manifest;
  assert.equal(createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex'),manifestSha256);
  assert.notEqual(createHash('sha256').update(JSON.stringify(canonical({...content,mode:'execute'}))).digest('hex'),manifestSha256);
});

test('a missing cache degrades its own source without stopping the other source', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightly-independent-source-'));
  const mappingFile=path.join(dir,'mapping.json');
  fs.writeFileSync(mappingFile,JSON.stringify({version:'reviewed-source-mapping-v1',reference:'test',reviewedAt:'2026-01-01T00:00:00Z',
    teams:{'Premier League':{},'Serie A':{},'La Liga':{},'Bundesliga':{},'Ligue 1':{}}}));
  const clients=[];
  try {
    for (const available of ['feed','csv']) {
      const file=path.join(dir,`${available}.sqlite`); fs.closeSync(fs.openSync(file,'wx'));
      const url=pathToFileURL(file).href,client=createClient({url}); clients.push(client);
      if (available==='feed') await new SourceFeedStore(client).initialize({shared:true,allowCreate:true});
      else await new NightlyCsvCache(client).initialize({allowCreate:true});
      const hash=createHash('sha256').update(url).digest('hex');
      const result=await run(['--plan','--target-sha256',hash,'--season','2026','--mapping',mappingFile],{env:{TURSO_DATABASE_URL:url},dist});
      assert.equal(result.schemaVersion,1); assert.equal(result.targetSha256,hash); assert.equal(result.competitions.length,5);
      const {manifestSha256,...content}=result;
      assert.equal(createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex'),manifestSha256);
      for (const competition of result.competitions) {
        assert.equal(competition.feed.reason,available==='feed'?'source_import_latest_source_unavailable':'source_cache_unavailable');
        assert.equal(competition.supplement.reason,available==='csv'?'csv_not_cached':'csv_cache_unavailable');
      }
      if (available==='csv') {
        const csvOnly=await run(['--execute','--collect-csv','--csv-only','--target-sha256',hash,'--season','2026'],{env:{TURSO_DATABASE_URL:url},dist});
        assert.equal(csvOnly.networkRequests,0);
        assert.equal(csvOnly.collection.csv.reason,'collection_budget_or_pending');
        assert.ok(csvOnly.competitions.every(item=>item.feed.reason==='csv_only'));
      }
    }
  } finally {clients.forEach(client=>client.close()); await fs.promises.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});

test('CLI is inert by default and requires explicit operation and target attestation',async()=>{
  assert.equal((await run([])).mode,'disabled');
  assert.throws(()=>parse(['--execute']),/nightly_sources_invalid_arguments/);
  assert.throws(()=>parse(['--initialize-source-cache','--target-sha256','a'.repeat(64)]),/nightly_sources_invalid_arguments/);
  assert.throws(()=>parse(['--plan','--collect-csv','--target-sha256','a'.repeat(64),'--season','2026','--mapping','a']),/nightly_sources_invalid_arguments/);
  assert.throws(()=>parse(['--execute','--csv-only','--collect-fdo','--target-sha256','a'.repeat(64),'--season','2026']),/nightly_sources_invalid_arguments/);
  await assert.rejects(run(['--initialize-source-cache','--authorize-schema-writes','--target-sha256','a'.repeat(64)],{env:{TURSO_DATABASE_URL:'file:local.db'}}),/nightly_sources_target_mismatch/);
  const missing=pathToFileURL(path.join(os.tmpdir(),`source-target-missing-${cryptoRandom()}.sqlite`)).href;
  const hash=createHash('sha256').update(missing).digest('hex');
  await assert.rejects(run(['--initialize-source-cache','--authorize-schema-writes','--target-sha256',hash],{env:{TURSO_DATABASE_URL:missing}}),/nightly_sources_target_missing/);
  assert.equal(fs.existsSync(require('node:url').fileURLToPath(missing)),false);
});
function cryptoRandom() { return require('node:crypto').randomUUID(); }
