const { test } = require('node:test'); const assert = require('node:assert/strict');
const { scheduleModelAProspective, drainModelAProspective, modelAProspectiveStats } = require('../dist/research/ModelAProspectiveRecorder');
process.env.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE='true';
function input() { const now = Date.now(); return { match: { match_id:'m',home_team_id:'h',away_team_id:'a',home_goals:null,away_goals:null,date:new Date(now+3600000).toISOString() },
  request:{matchId:'m',homeTeamId:'h',awayTeamId:'a'},asOf:new Date(now).toISOString(),origin:'direct_a',
  model:{version:'A',codeHash:'',configHash:'',stateHash:''},contextual:{},calibrated:null,decision:{},selected:null,modelParametersHash:'',
  calibration:{profileHash:'',globalSamples:0,overSamples:null,underSamples:null,overCurve:'unavailable',underCurve:'unavailable'} }; }
test('collection rejects records when persistent spool is absent unless explicitly in test mode',()=>{
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';delete process.env.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE;
  const old=console.error;let logged='';console.error=(...args)=>{logged=args.join(' ');};
  try {const before=modelAProspectiveStats().rejected;scheduleModelAProspective({},input());
    assert.equal(modelAProspectiveStats().rejected,before+1);assert.match(logged,/durable spool required/);
  } finally {console.error=old;process.env.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE='true';delete process.env.MODEL_A_PROSPECTIVE_ENABLED;}
});
test('transient failure retries the same identifier and explicit drain waits', async () => {
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';const old=console.error;console.error=()=>{};
  try {const ids=[];scheduleModelAProspective({appendModelAProspectiveForecast:async r=>{ids.push(r.id);if(ids.length<3)throw Error('temporary');}},input());
    assert.equal(await drainModelAProspective(3000),true);assert.equal(ids.length,3);assert.equal(new Set(ids).size,1);
  } finally {console.error=old;delete process.env.MODEL_A_PROSPECTIVE_ENABLED;}
});
test('bounded queue signals rejected events under concurrent overload', async () => {
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';const old=console.error;let logged=0;console.error=()=>{logged++;};
  try {const before=modelAProspectiveStats();let written=0;const sink={appendModelAProspectiveForecast:async()=>{await new Promise(r=>setTimeout(r,2));written++;}};
    for(let i=0;i<260;i++)scheduleModelAProspective(sink,input());
    assert.equal(await drainModelAProspective(5000),true);const after=modelAProspectiveStats();
    assert.equal(after.accepted-before.accepted,256);assert.equal(after.rejected-before.rejected,4);assert.equal(written,256);assert.equal(logged,4);
  } finally {console.error=old;delete process.env.MODEL_A_PROSPECTIVE_ENABLED;}
});
test('drain reports a timeout if storage never completes, then drains when it recovers', async () => {
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';let release;
  try { scheduleModelAProspective({appendModelAProspectiveForecast:()=>new Promise(r=>{release=r;})},input());
    assert.equal(await drainModelAProspective(30),false);assert.equal(modelAProspectiveStats().pending,1);
    release();assert.equal(await drainModelAProspective(1000),true);
  } finally {delete process.env.MODEL_A_PROSPECTIVE_ENABLED;}
});

test('database receipt waits for confirmed storage and does not mark durable', async () => {
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_STORAGE='database';let release,record;
  try {const before=modelAProspectiveStats();const receipt=scheduleModelAProspective({appendModelAProspectiveForecast:r=>{record=r;return new Promise(resolve=>{release=resolve;});}},input());
    assert.equal(receipt.status,'pending');assert.equal(receipt.durable,false);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(record.durable,false);assert.equal(modelAProspectiveStats().accepted,before.accepted);release();
    assert.deepEqual(await receipt.completion,{status:'stored',id:receipt.id});assert.equal(modelAProspectiveStats().accepted,before.accepted+1);assert.equal(await drainModelAProspective(1000),true);
  } finally {delete process.env.MODEL_A_PROSPECTIVE_STORAGE;delete process.env.MODEL_A_PROSPECTIVE_ENABLED;}
});
test('database failure remains unconfirmed and never increments accepted', async () => {
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_STORAGE='database';const old=console.error;console.error=()=>{};
  try {const before=modelAProspectiveStats();const receipt=scheduleModelAProspective({appendModelAProspectiveForecast:async()=>{throw Error('offline');}},input());
    assert.equal(receipt.status,'pending');assert.deepEqual(await receipt.completion,{status:'unconfirmed',id:receipt.id});
    assert.equal(modelAProspectiveStats().accepted,before.accepted);assert.equal(await drainModelAProspective(1000),true);
  } finally {console.error=old;delete process.env.MODEL_A_PROSPECTIVE_STORAGE;delete process.env.MODEL_A_PROSPECTIVE_ENABLED;}
});
test('receipts expose disabled, ineligible and missing spool outcomes', async () => {
  delete process.env.MODEL_A_PROSPECTIVE_ENABLED;assert.equal(scheduleModelAProspective({},input()).status,'disabled');
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';delete process.env.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE;const old=console.error,oldWarn=console.warn;console.error=()=>{};console.warn=()=>{};
  try {const invalid=input();invalid.match.home_goals=1;const receipt=scheduleModelAProspective({},invalid);assert.equal(receipt.status,'ineligible');
    assert.equal((await receipt.completion).status,'unconfirmed');assert.equal(scheduleModelAProspective({},input()).reason,'spool_required');
  } finally {console.error=old;console.warn=oldWarn;process.env.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE='true';delete process.env.MODEL_A_PROSPECTIVE_ENABLED;}
});

test('file receipt is durable only after spool admission and exposes confirmed completion', async () => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-receipt-'));
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=dir;
  let release;try {const receipt=scheduleModelAProspective({appendModelAProspectiveForecast:()=>new Promise(resolve=>{release=resolve;})},input());
    assert.equal(receipt.status,'accepted');assert.equal(receipt.durable,true);assert.equal(fs.existsSync(path.join(dir,receipt.id+'.json')),true);
    await new Promise(resolve=>setImmediate(resolve));release();assert.deepEqual(await receipt.completion,{status:'stored',id:receipt.id});assert.equal(await drainModelAProspective(1000),true);
  } finally {delete process.env.MODEL_A_PROSPECTIVE_ENABLED;delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;fs.rmSync(dir,{recursive:true,force:true});}
});

test('directory synchronization failure cannot produce an accepted receipt', async () => {
  if(process.platform==='win32') return;
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-dir-fail-'));
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=dir;const oldSync=fs.fsyncSync,oldError=console.error;console.error=()=>{};
  fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory())throw Error('directory fsync failed');return oldSync(fd);};
  try {const before=modelAProspectiveStats().accepted;const receipt=scheduleModelAProspective({appendModelAProspectiveForecast:async()=>{}},input());
    assert.equal(receipt.status,'error');assert.equal(receipt.durable,false);assert.equal(modelAProspectiveStats().accepted,before);
    assert.equal(fs.existsSync(path.join(dir,receipt.id+'.json')),true);assert.equal((await receipt.completion).status,'unconfirmed');
  } finally {fs.fsyncSync=oldSync;console.error=oldError;delete process.env.MODEL_A_PROSPECTIVE_ENABLED;delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;fs.rmSync(dir,{recursive:true,force:true});}
});
test('collection identity is copied into payload and directory sync status is explicit', async () => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-dir-ok-'));
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=dir;let payload;
  try {const event=input();event.collection={protocolId:'p',manifestSha256:'sha',claimId:'claim'};const receipt=scheduleModelAProspective({appendModelAProspectiveForecast:async r=>{payload=JSON.parse(r.payload);}},event);
    assert.equal(receipt.status,'accepted');assert.equal(receipt.directorySyncConfirmed,process.platform!=='win32');
    assert.equal(receipt.durabilityScope,process.platform==='win32'?'process_crash_only':'directory_synced');
    event.collection.claimId='changed';await receipt.completion;assert.deepEqual(payload.collection,{protocolId:'p',manifestSha256:'sha',claimId:'claim'});
    assert.equal(await drainModelAProspective(1000),true);
  } finally {delete process.env.MODEL_A_PROSPECTIVE_ENABLED;delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;fs.rmSync(dir,{recursive:true,force:true});}
});
test('Windows strict directory sync fails closed', async () => {
  if(process.platform!=='win32') return;
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-dir-strict-'));
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=dir;process.env.MODEL_A_PROSPECTIVE_REQUIRE_DIRECTORY_SYNC='true';const oldError=console.error;console.error=()=>{};
  try {const receipt=scheduleModelAProspective({},input());assert.equal(receipt.status,'error');assert.equal(receipt.durable,false);assert.equal(fs.existsSync(path.join(dir,receipt.id+'.json')),true);}
  finally {console.error=oldError;delete process.env.MODEL_A_PROSPECTIVE_ENABLED;delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;delete process.env.MODEL_A_PROSPECTIVE_REQUIRE_DIRECTORY_SYNC;fs.rmSync(dir,{recursive:true,force:true});}
});

test('supported directory fsync is required before acceptance and errors fail closed', async () => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-dir-mock-'));
  const oldPlatform=Object.getOwnPropertyDescriptor(process,'platform'),oldOpen=fs.openSync,oldSync=fs.fsyncSync,oldError=console.error;
  let directoryFd,fail=false,directorySyncs=0;Object.defineProperty(process,'platform',{value:'linux'});console.error=()=>{};
  fs.openSync=(name,...args)=>{if(name===dir){directoryFd=oldOpen(path.join(dir,'sync-placeholder'),'w+');return directoryFd;}return oldOpen(name,...args);};
  fs.fsyncSync=fd=>{if(fd===directoryFd){directoryFd=undefined;directorySyncs++;if(fail)throw Error('simulated directory failure');}return oldSync(fd);};
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=dir;
  try {let receipt=scheduleModelAProspective({appendModelAProspectiveForecast:async()=>{}},input());
    assert.equal(receipt.status,'accepted');assert.equal(receipt.directorySyncConfirmed,true);assert.ok(directorySyncs>0);await receipt.completion;await drainModelAProspective(1000);
    fail=true;const accepted=modelAProspectiveStats().accepted;receipt=scheduleModelAProspective({},input());assert.equal(receipt.status,'error');assert.equal(modelAProspectiveStats().accepted,accepted);assert.ok(fs.existsSync(path.join(dir,receipt.id+'.json')));
  } finally {Object.defineProperty(process,'platform',oldPlatform);fs.openSync=oldOpen;fs.fsyncSync=oldSync;console.error=oldError;delete process.env.MODEL_A_PROSPECTIVE_ENABLED;delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;fs.rmSync(dir,{recursive:true,force:true});}
});
