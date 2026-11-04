const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
test('reusing an identifier cannot overwrite the original durable file',t=>{
 const {persistSpool}=require('../dist/research/ModelAProspectiveSpool');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-duplicate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const now=Date.now(),id='12345678-1234-1234-1234-123456789abc';const record={id,matchId:'m',forecastAt:new Date(now).toISOString(),kickoffAt:new Date(now+3600000).toISOString(),payload:'original'};
 persistSpool(dir,record);const before=fs.readFileSync(path.join(dir,id+'.json'),'utf8');assert.throws(()=>persistSpool(dir,{...record,payload:'different'}));assert.equal(fs.readFileSync(path.join(dir,id+'.json'),'utf8'),before);assert.ok(fs.existsSync(path.join(dir,id+'.json.partial')));
});

test('spool iteration skips corrupt records and stops reading when the consumer stops',t=>{
 const {iterateSpool}=require('../dist/research/ModelAProspectiveSpool');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-iterator-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const ids=['00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'];
 fs.writeFileSync(path.join(dir,ids[0]+'.json'),'{');fs.writeFileSync(path.join(dir,ids[2]+'.json'),'{');
 const forecastAt=new Date().toISOString(),kickoffAt=new Date(Date.now()+3600000).toISOString();
 const payload=JSON.stringify({id:ids[1],matchId:'m',forecastAt,kickoffAt,family:'A'});fs.writeFileSync(path.join(dir,ids[1]+'.json'),JSON.stringify({id:ids[1],matchId:'m',forecastAt,kickoffAt,payload,durable:true}));
 const old=console.error,logged=[];console.error=(...args)=>logged.push(args.join(' '));try{
   const iterator=iterateSpool(dir);assert.equal(iterator.next().value.id,ids[1]);iterator.return();
 }finally{console.error=old;}assert.equal(logged.length,1);assert.match(logged[0],new RegExp(ids[0]));
});
test('interruption after link retains one replayable record and diagnoses the partial file',t=>{
 const {persistSpool,iterateSpool}=require('../dist/research/ModelAProspectiveSpool');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-link-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const id='33333333-3333-3333-3333-333333333333',forecastAt=new Date().toISOString(),kickoffAt=new Date(Date.now()+3600000).toISOString();const payload=JSON.stringify({id,matchId:'m',forecastAt,kickoffAt,family:'A'});
 const original=fs.linkSync;fs.linkSync=(from,to)=>{original(from,to);throw Error('simulated interruption after link');};try{assert.throws(()=>persistSpool(dir,{id,matchId:'m',forecastAt,kickoffAt,payload}),/simulated interruption/);}finally{fs.linkSync=original;}
 assert.ok(fs.existsSync(path.join(dir,id+'.json')));assert.ok(fs.existsSync(path.join(dir,id+'.json.partial')));
 const old=console.error,errors=[];console.error=(...args)=>errors.push(args.join(' '));try{assert.deepEqual([...iterateSpool(dir)].map(r=>r.id),[id]);}finally{console.error=old;}assert.ok(errors.some(line=>line.includes('incomplete durable spool')));
});
test('kickoff reached after link removes the published name and rejects admission',t=>{
 const {persistSpool}=require('../dist/research/ModelAProspectiveSpool');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-kickoff-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const id='44444444-4444-4444-4444-444444444444',now=Date.now(),kickoffAt=new Date(now+1000).toISOString(),forecastAt=new Date(now).toISOString();let linked=false;
 const oldLink=fs.linkSync,oldNow=Date.now;fs.linkSync=(from,to)=>{oldLink(from,to);linked=true;};Date.now=()=>linked?now+1001:now;
 try{assert.throws(()=>persistSpool(dir,{id,matchId:'m',forecastAt,kickoffAt,payload:'{}'}),/kickoff reached during durable admission/);}finally{fs.linkSync=oldLink;Date.now=oldNow;}
 assert.equal(fs.existsSync(path.join(dir,id+'.json')),false);assert.equal(fs.existsSync(path.join(dir,id+'.json.partial')),false);
});
