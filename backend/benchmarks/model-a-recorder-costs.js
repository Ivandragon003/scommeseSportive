/* Local-only comparison of the committed recorder and current code with identical fixtures. */
require('ts-node/register/transpile-only');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const sourcePath = path.resolve(__dirname, '../src/research/ModelAProspectiveRecorder.ts');
const baselineRef = process.env.MODEL_A_BENCH_BASELINE_REF || '7a6c16b3';
const oldSource = execFileSync('git', ['show', `${baselineRef}:backend/src/research/ModelAProspectiveRecorder.ts`], { encoding: 'utf8' });
const oldModule = new Module(sourcePath, module);
oldModule.filename = sourcePath;
oldModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
oldModule._compile(ts.transpileModule(oldSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sourcePath);
const current = require(sourcePath);
const spool = require('../src/research/ModelAProspectiveSpool.ts');
function input() {
  const now=Date.now(); return { match:{match_id:'m',home_team_id:'h',away_team_id:'a',home_goals:null,away_goals:null,date:new Date(now+3600000).toISOString()},
    request:{matchId:'m',homeTeamId:'h',awayTeamId:'a'},asOf:new Date(now).toISOString(),origin:'direct_a',
    model:{version:'A',codeHash:'',configHash:'',stateHash:''},contextual:{},calibrated:null,decision:{},selected:null,modelParametersHash:'',
    calibration:{profileHash:'',globalSamples:0,overSamples:null,underSamples:null,overCurve:'unavailable',underCurve:'unavailable'} };
}
async function run(label, recorder, databaseMode = false) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-a-cost-'));process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=dir;
  if (databaseMode) process.env.MODEL_A_PROSPECTIVE_STORAGE='database'; else delete process.env.MODEL_A_PROSPECTIVE_STORAGE;
  const costsBefore=spool.modelAProspectiveSpoolCosts();
  try {
    const sink={appendModelAProspectiveForecast:async()=>{}};const started=process.hrtime.bigint();
    for(let i=0;i<50;i++) recorder.scheduleModelAProspective(sink,input());
    const admissionMs=Number(process.hrtime.bigint()-started)/1e6;
    if (!await recorder.drainModelAProspective(10000)) throw Error('drain failed');
    const costsAfter=spool.modelAProspectiveSpoolCosts();
    return {label,count:50,admissionMs,spoolMs:costsAfter.spoolMs-costsBefore.spoolMs,auditMs:costsAfter.auditMs-costsBefore.auditMs};
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
(async()=>{
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_DIAGNOSTICS='true';delete process.env.MODEL_A_PROSPECTIVE_STORAGE;
  const before=await run(baselineRef,oldModule.exports);const after=await run('working tree',current);
  const database=await run('working tree database with immediate mock sink',current,true);
  process.stdout.write(JSON.stringify({before,after,database,recorderCosts:current.modelAProspectiveCosts(),spoolCosts:spool.modelAProspectiveSpoolCosts(),note:'Local synchronous admission cost; One run per mode, diagnostic counters enabled. Mock sink; no real database/network. Not a statistical benchmark.'},null,2)+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
