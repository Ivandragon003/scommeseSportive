const { test }=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const path=require('node:path');const os=require('node:os');const {fork}=require('node:child_process');const {createClient}=require('@libsql/client');
const {DatabaseService}=require('../dist/db/DatabaseService');
const {recoverModelAProspective,drainModelAProspective,scheduleModelAProspective,modelAProspectiveStats}=require('../dist/research/ModelAProspectiveRecorder');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('fsynced forecast survives process kill and recovers into persistent libSQL after kickoff',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-durable-')),spool=path.join(dir,'spool'),dbfile=path.join(dir,'db.sqlite');
  const oldFlag=process.env.MODEL_A_PROSPECTIVE_ENABLED,oldDir=process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;
  const db=createClient({url:`file:${dbfile}`});
  t.after(async()=>{db.close();if(oldFlag===undefined)delete process.env.MODEL_A_PROSPECTIVE_ENABLED;else process.env.MODEL_A_PROSPECTIVE_ENABLED=oldFlag;
    if(oldDir===undefined)delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;else process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=oldDir;
    await wait(100);await fs.promises.rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  await db.executeMultiple(fs.readFileSync(path.join(__dirname,'../experiments/model-a-prospective/schema.sql'),'utf8'));
  const child=fork(path.join(__dirname,'../experiments/model-a-prospective/crash-helper.js'),[],{
    env:{...process.env,MODEL_A_PROSPECTIVE_ENABLED:'true',MODEL_A_PROSPECTIVE_SPOOL_DIR:spool},stdio:['ignore','ignore','ignore','ipc']});
  const message=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('message',resolve);});
  assert.equal(message.accepted,1);const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exit;
  assert.equal(fs.readdirSync(spool).filter(n=>n.endsWith('.json')).length,1);
  await wait(2200);process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=spool;
  const wrapper={execute:(sql,args)=>db.execute({sql,args}),get:async(sql,args)=>(await db.execute({sql,args})).rows[0]??null};
  const sink={appendModelAProspectiveForecast:r=>DatabaseService.prototype.appendModelAProspectiveForecast.call(wrapper,r)};
  assert.equal(recoverModelAProspective(sink),1);assert.equal(await drainModelAProspective(5000),true);
  assert.equal((await db.execute('SELECT count(*) n FROM model_a_prospective_forecasts')).rows[0].n,1);
  assert.equal(recoverModelAProspective(sink),0);assert.equal(fs.readdirSync(spool).filter(n=>n.endsWith('.json')).length,0);
});
test('database outage retains a durable event for later idempotent recovery',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-outage-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const oldFlag=process.env.MODEL_A_PROSPECTIVE_ENABLED,oldDir=process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR,oldErr=console.error;
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=dir;console.error=()=>{};
  t.after(()=>{console.error=oldErr;if(oldFlag===undefined)delete process.env.MODEL_A_PROSPECTIVE_ENABLED;else process.env.MODEL_A_PROSPECTIVE_ENABLED=oldFlag;
    if(oldDir===undefined)delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;else process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=oldDir;});
  const now=Date.now();scheduleModelAProspective({appendModelAProspectiveForecast:async()=>{throw Error('offline');}},
    {match:{match_id:'m',home_team_id:'h',away_team_id:'a',home_goals:null,away_goals:null,date:new Date(now+3600000).toISOString()},
      request:{matchId:'m',homeTeamId:'h',awayTeamId:'a'},asOf:new Date(now).toISOString(),origin:'direct_a',
      model:{version:'A',codeHash:'',configHash:'',stateHash:''},contextual:{},calibrated:null,decision:{},selected:null,modelParametersHash:'',
      calibration:{profileHash:'',globalSamples:0,overSamples:null,underSamples:null,overCurve:'unavailable',underCurve:'unavailable'}});
  assert.equal(await drainModelAProspective(3000),false);assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.json')).length,1);
  let saved=0;assert.equal(recoverModelAProspective({appendModelAProspectiveForecast:async()=>{saved++;}}),1);
  assert.equal(await drainModelAProspective(1000),true);assert.equal(saved,1);assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.json')).length,0);
});
test('unwritable spool rejects and reports capture failure without throwing',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-bad-spool-')),file=path.join(dir,'not-a-directory');fs.writeFileSync(file,'x');
  const oldFlag=process.env.MODEL_A_PROSPECTIVE_ENABLED,oldDir=process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR,oldErr=console.error;
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=file;let logs=0;console.error=()=>{logs++;};
  t.after(()=>{console.error=oldErr;if(oldFlag===undefined)delete process.env.MODEL_A_PROSPECTIVE_ENABLED;else process.env.MODEL_A_PROSPECTIVE_ENABLED=oldFlag;
    if(oldDir===undefined)delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;else process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=oldDir;fs.rmSync(dir,{recursive:true,force:true});});
  const now=Date.now(),before=modelAProspectiveStats().captureErrors;
  scheduleModelAProspective({}, {match:{match_id:'m',home_team_id:'h',away_team_id:'a',home_goals:null,away_goals:null,date:new Date(now+3600000).toISOString()},
    request:{matchId:'m',homeTeamId:'h',awayTeamId:'a'},asOf:new Date(now).toISOString(),origin:'direct_a',
    model:{version:'A',codeHash:'',configHash:'',stateHash:''},contextual:{},calibrated:null,decision:{},selected:null,modelParametersHash:'',
    calibration:{profileHash:'',globalSamples:0,overSamples:null,underSamples:null,overCurve:'unavailable',underCurve:'unavailable'}});
  assert.equal(modelAProspectiveStats().captureErrors,before+1);assert.ok(logs>=1);
});
