const {test}=require('node:test');const assert=require('node:assert/strict');
const {startModelAProspectiveRecovery,stopModelAProspectiveRecovery,drainModelAProspective,modelAProspectiveStats}=require('../dist/research/ModelAProspectiveRecorder');
test('drain waits boundedly for an in-flight result write',async t=>{
 process.env.MODEL_A_PROSPECTIVE_ENABLED='true';delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;t.after(()=>{stopModelAProspectiveRecovery();delete process.env.MODEL_A_PROSPECTIVE_ENABLED;});
 const kickoffAt=new Date(Date.now()-7200000).toISOString(),observedAt=new Date(Date.now()-3600000).toISOString();
 const row={match_id:'understat_1',source:'understat',source_match_id:'1',date:kickoffAt,home_goals:2,away_goals:1,raw_json:JSON.stringify({resultObservation:{source:'understat',observedAt},match:{id:'1',isResult:true,goals:{h:'2',a:'1'}}})};
 let release, forecastWrites=0;const sink={getModelAProspectiveResultCandidates:async()=>[row],appendModelAProspectiveResult:()=>new Promise(r=>{release=r;}),appendModelAProspectiveForecast:async()=>{forecastWrites++;}};
 startModelAProspectiveRecovery(sink,10000);while(!release)await new Promise(r=>setTimeout(r,5));stopModelAProspectiveRecovery();
 assert.equal(modelAProspectiveStats().reconciliationPending,true);assert.equal(await drainModelAProspective(30),false);release(true);
 assert.equal(await drainModelAProspective(1000),true);assert.equal(modelAProspectiveStats().reconciliationPending,false);assert.equal(forecastWrites,0);
});
