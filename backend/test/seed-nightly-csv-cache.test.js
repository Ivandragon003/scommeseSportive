const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {createHash}=require('node:crypto');
const {createClient}=require('@libsql/client');
const {run}=require('../scripts/seed-nightly-csv-cache');
const sha=value=>createHash('sha256').update(value).digest('hex');

test('offline seed plans without writes, applies atomically and replays without changing the cooldown',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csv-seed-test-'));
  const dbPath=path.join(dir,'target.sqlite');fs.closeSync(fs.openSync(dbPath,'wx'));
  const target=pathToFileURL(dbPath).href,client=createClient({url:target});
  try {
    await client.batch([
      {sql:'CREATE TABLE nightly_csv_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)'},
      {sql:'CREATE TABLE nightly_csv_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT,season INTEGER NOT NULL,requested_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL)'},
      {sql:'CREATE TABLE nightly_csv_snapshots (attempt_id INTEGER NOT NULL,code TEXT NOT NULL,acquired_at TEXT NOT NULL,sha256 TEXT NOT NULL,csv TEXT NOT NULL,PRIMARY KEY(attempt_id,code))'},
      {sql:"INSERT INTO nightly_csv_meta VALUES ('marker','nightly_csv_cache_v1')"},
      {sql:"INSERT INTO nightly_csv_meta VALUES ('collection_not_before','2099-01-01T00:00:00.000Z')"},
    ],'write');
    const acquiredAt='2026-09-02T14:00:00.000Z',files={};
    for(const code of ['I1','E0','SP1','D1','F1']){
      const filename=`${code}-2627.csv`, csv=`Div,Date,HomeTeam,AwayTeam,FTHG,FTAG\n${code},01/09/26,Home,Away,1,0`;
      fs.writeFileSync(path.join(dir,filename),csv); files[code]={filename,sha256:sha(csv)};
    }
    const receipt=path.join(dir,'receipt.json');fs.writeFileSync(receipt,JSON.stringify({season:2026,acquiredAt,files}));
    const args=['--target-sha256',sha(target),'--csv-directory',dir,'--receipt',receipt,'--receipt-sha256',sha(fs.readFileSync(receipt)),'--season','2026'];
    const deps={env:{TURSO_DATABASE_URL:target}};
    const plan=await run(args,deps);
    assert.equal(plan.mode,'plan');assert.equal(plan.plan.action,'insert');assert.equal(plan.writes,0);
    assert.equal((await client.execute('SELECT count(*) n FROM nightly_csv_attempts')).rows[0].n,0);
    await assert.rejects(run([...args,'--execute','--authorize-cache-writes','--expected-plan-sha256','a'.repeat(64)],deps),/csv_seed_plan_changed/);
    const applied=await run([...args,'--execute','--authorize-cache-writes','--expected-plan-sha256',plan.plan.planSha256],deps);
    assert.equal(applied.writes,6);assert.equal(applied.networkRequests,0);
    const sameCommand=await run([...args,'--execute','--authorize-cache-writes','--expected-plan-sha256',plan.plan.planSha256],deps);
    assert.equal(sameCommand.writes,0);
    const rows=await client.execute('SELECT requested_at,finished_at,status FROM nightly_csv_attempts');
    assert.deepEqual({...rows.rows[0]},{requested_at:acquiredAt,finished_at:acquiredAt,status:'success'});
    assert.equal((await client.execute('SELECT count(*) n FROM nightly_csv_snapshots')).rows[0].n,5);
    assert.equal((await client.execute("SELECT value FROM nightly_csv_meta WHERE key='collection_not_before'")).rows[0].value,'2099-01-01T00:00:00.000Z');
    const replay=await run(args,deps);assert.equal(replay.plan.action,'already_present');
    assert.equal((await run([...args,'--execute','--authorize-cache-writes','--expected-plan-sha256',replay.plan.planSha256],deps)).writes,0);
    assert.equal((await client.execute('SELECT count(*) n FROM nightly_csv_attempts')).rows[0].n,1);
    const secondReceipt=path.join(dir,'second-receipt.json');
    fs.writeFileSync(secondReceipt,JSON.stringify({season:2026,acquiredAt:'2026-09-03T14:00:00.000Z',files}));
    const secondArgs=['--target-sha256',sha(target),'--csv-directory',dir,'--receipt',secondReceipt,'--receipt-sha256',sha(fs.readFileSync(secondReceipt)),'--season','2026'];
    const secondPlan=await run(secondArgs,deps);
    await client.execute("CREATE TRIGGER fail_last_csv BEFORE INSERT ON nightly_csv_snapshots WHEN NEW.code='F1' BEGIN SELECT RAISE(ABORT,'test failure'); END");
    await assert.rejects(run([...secondArgs,'--execute','--authorize-cache-writes','--expected-plan-sha256',secondPlan.plan.planSha256],deps));
    assert.equal((await client.execute('SELECT count(*) n FROM nightly_csv_attempts')).rows[0].n,1);
    assert.equal((await client.execute('SELECT count(*) n FROM nightly_csv_snapshots')).rows[0].n,5);
    await client.execute({sql:"UPDATE nightly_csv_snapshots SET sha256=? WHERE code='I1'",args:['0'.repeat(64)]});
    await assert.rejects(run(args,deps),/csv_seed_existing_conflict/);
    await client.execute({sql:"UPDATE nightly_csv_snapshots SET sha256=? WHERE code='I1'",args:[files.I1.sha256]});
    fs.appendFileSync(path.join(dir,'I1-2627.csv'),'\nchanged');
    await assert.rejects(run(args,deps),/csv_seed_file_hash_mismatch/);
    assert.equal((await client.execute('SELECT count(*) n FROM nightly_csv_snapshots')).rows[0].n,5);
  } finally {client.close();await fs.promises.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});

test('entrypoint is inert without arguments and does not create a missing target',async()=>{
  assert.equal((await run()).mode,'disabled');
  await assert.rejects(run(['--execute']),/csv_seed_arguments_invalid/);
  const file=path.join(os.tmpdir(),`csv-seed-missing-${require('node:crypto').randomUUID()}.sqlite`),url=pathToFileURL(file).href;
  await assert.rejects(run(['--target-sha256',sha(url),'--csv-directory','missing','--receipt','missing',
    '--receipt-sha256','a'.repeat(64),'--season','2026'],{env:{TURSO_DATABASE_URL:url}}),/csv_seed_target_missing/);
  assert.equal(fs.existsSync(file),false);
});
