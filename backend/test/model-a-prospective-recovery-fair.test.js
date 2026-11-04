const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {startModelAProspectiveRecovery,stopModelAProspectiveRecovery,modelAProspectiveStats}=require('../dist/research/ModelAProspectiveRecorder');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('recovery rotates past 256 permanently failing files',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-fair-'));process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=dir;
 const old=console.error;console.error=()=>{};t.after(async()=>{stopModelAProspectiveRecovery();while(modelAProspectiveStats().pending)await wait(10);console.error=old;delete process.env.MODEL_A_PROSPECTIVE_ENABLED;delete process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR;fs.rmSync(dir,{recursive:true,force:true});});
 const forecastAt=new Date(Date.now()-120000).toISOString(),kickoffAt=new Date(Date.now()-60000).toISOString();let last;
 for(let i=0;i<257;i++){const id=i.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';last=id;const payload=JSON.stringify({id,matchId:'m',forecastAt,kickoffAt,family:'A'});fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({id,matchId:'m',forecastAt,kickoffAt,payload,durable:true}));}
 let stored=0;startModelAProspectiveRecovery({appendModelAProspectiveForecast:async r=>{if(r.id!==last)throw Error('conflict');stored++;}},50);
 const deadline=Date.now()+10000;while(!stored&&Date.now()<deadline)await wait(20);
 assert.equal(stored,1);assert.equal(fs.existsSync(path.join(dir,last+'.json')),false);assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.json')).length,256);
});
