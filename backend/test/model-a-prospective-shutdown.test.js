const {test}=require('node:test');const assert=require('node:assert/strict');const {spawn}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
for(const [signal,expected] of [['SIGTERM',143],['SIGINT',130]])test(`shutdown handler drains after simulated ${signal}`,async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-stop-')),file=path.join(dir,'marker');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const child=spawn(process.execPath,[path.join(__dirname,'../experiments/model-a-prospective/shutdown-helper.js'),signal,file],
    {env:{...process.env,MODEL_A_PROSPECTIVE_ENABLED:'true',MODEL_A_PROSPECTIVE_SPOOL_DIR:''},stdio:'ignore'});
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,sig)=>resolve({code,sig}));});
  assert.equal(exit.code,expected);assert.equal(fs.readFileSync(file,'utf8'),'written');
});
