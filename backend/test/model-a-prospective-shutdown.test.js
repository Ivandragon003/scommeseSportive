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
for(const [label,closeDelay,lateDelay] of [['server close',40,70],['deadline',180,140]])test(`shutdown accepts in-flight predictions until ${label}, then rejects`,async()=>{
  const script=`
    const r=require('./dist/research/ModelAProspectiveRecorder');
    const {installModelAProspectiveShutdown}=require('./dist/research/ModelAProspectiveShutdown');
    let stored=0, exitCode; process.exit=code=>{exitCode=code;};
    const now=Date.now();const input={match:{match_id:'m',home_team_id:'h',away_team_id:'a',home_goals:null,away_goals:null,date:new Date(now+3600000).toISOString()},request:{matchId:'m',homeTeamId:'h',awayTeamId:'a'},asOf:new Date(now).toISOString(),origin:'direct_a',model:{version:'A',codeHash:'',configHash:'',stateHash:''},contextual:{},calibrated:null,decision:{},selected:null,modelParametersHash:'',calibration:{profileHash:'',globalSamples:0,overSamples:null,underSamples:null,overCurve:'unavailable',underCurve:'unavailable'}};
    const sink={appendModelAProspectiveForecast:async()=>{stored++;}};
    installModelAProspectiveShutdown({close:done=>{setTimeout(()=>r.scheduleModelAProspective(sink,input),15);setTimeout(done,${closeDelay});}});
    process.emit('SIGTERM');setTimeout(()=>r.scheduleModelAProspective(sink,input),${lateDelay});
    setTimeout(()=>console.log('RESULT '+JSON.stringify({stored,exitCode,stats:r.modelAProspectiveStats()})),250);
  `;
  const child=spawn(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),env:{...process.env,MODEL_A_PROSPECTIVE_ENABLED:'true',MODEL_A_PROSPECTIVE_ALLOW_VOLATILE:'true',MODEL_A_PROSPECTIVE_SPOOL_DIR:'',MODEL_A_PROSPECTIVE_SHUTDOWN_MS:'100'}});
  let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,errors);
  const match=output.match(/RESULT (\{[^\n]+\})/);assert.ok(match,output);const result=JSON.parse(match[1]);
  assert.equal(result.exitCode,143);assert.equal(result.stored,1);assert.equal(result.stats.accepted,1);assert.equal(result.stats.rejected,1);
});
