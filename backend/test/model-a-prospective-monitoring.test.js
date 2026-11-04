const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {scheduleModelAProspective,startModelAProspectiveRecovery,stopModelAProspectiveRecovery,closeModelAProspectiveAdmission,drainModelAProspective,modelAProspectiveStats}=require('../dist/research/ModelAProspectiveRecorder');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('periodic recovery resumes an unavailable database and shutdown prevents further admissions',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-monitor-'));process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=dir;
 const oldError=console.error;console.error=()=>{};t.after(()=>{stopModelAProspectiveRecovery();console.error=oldError;delete process.env.MODEL_A_PROSPECTIVE_ENABLED;delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;fs.rmSync(dir,{recursive:true,force:true});});
 const now=Date.now(), input={match:{match_id:'m',home_team_id:'h',away_team_id:'a',home_goals:null,away_goals:null,date:new Date(now+3600000).toISOString()},request:{matchId:'m',homeTeamId:'h',awayTeamId:'a'},asOf:new Date(now).toISOString(),origin:'direct_a',model:{version:'A',codeHash:'',configHash:'',stateHash:''},contextual:{},calibrated:null,decision:{},selected:null,modelParametersHash:'',calibration:{profileHash:'',globalSamples:0,overSamples:null,underSamples:null,overCurve:'unavailable',underCurve:'unavailable'}};
 let online=false, stored=0;const sink={appendModelAProspectiveForecast:async()=>{if(!online)throw Error('offline');stored++;}};
 startModelAProspectiveRecovery(sink,700);scheduleModelAProspective(sink,input);assert.equal(await drainModelAProspective(2000),false);
 assert.equal(modelAProspectiveStats().durableAuditCounts.counts.recovered ?? 0,0);online=true;
 const deadline=Date.now()+2000;while(!stored&&Date.now()<deadline)await wait(20);
 assert.equal(stored,1);assert.equal(await drainModelAProspective(1000),true);
 const counts=modelAProspectiveStats().durableAuditCounts;assert.equal(counts.counts.attempted,1);assert.equal(counts.counts.accepted,1);assert.ok(counts.counts.recovered>=1);assert.equal(counts.counts.stored,1);assert.ok(counts.counts.delivery_unconfirmed>=1);
 stopModelAProspectiveRecovery();closeModelAProspectiveAdmission();scheduleModelAProspective(sink,input);await wait(80);assert.equal(stored,1);assert.equal(modelAProspectiveStats().durableAuditCounts.counts.rejected,1);
});
test('partial and corrupted files are retained and diagnosed',t=>{
 const {readSpool,readSpoolAuditCounts}=require('../dist/research/ModelAProspectiveSpool');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-corrupt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const files=['12345678-1234-1234-1234-123456789abc.json','12345678-1234-1234-1234-123456789abc.json.partial'];for(const f of files)fs.writeFileSync(path.join(dir,f),'{');fs.writeFileSync(path.join(dir,'audit.ndjson'),'{broken\n');
 const old=console.error;let logs='';console.error=(...args)=>{logs+=args.join(' ')+'\n';};try{assert.deepEqual(readSpool(dir),[]);}finally{console.error=old;}
 assert.match(logs,/incomplete durable spool/);assert.match(logs,/invalid durable spool/);assert.equal(readSpoolAuditCounts(dir).invalidLines,1);for(const f of files)assert.ok(fs.existsSync(path.join(dir,f)));
});
