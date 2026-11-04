'use strict';
// PredictionService with mocked inputs and an isolated local libSQL sink; no HTTP/network.
const fs = require('node:fs'); const path = require('node:path'); const { performance } = require('node:perf_hooks');
const { createClient } = require('@libsql/client');
const { PredictionService } = require('../../dist/services/PredictionService');
const { DatabaseService } = require('../../dist/db/DatabaseService');
const { DixonColesModel } = require('../../dist/models/core/DixonColesModel');
const { drainModelAProspective, modelAProspectiveStats } = require('../../dist/research/ModelAProspectiveRecorder');
(async () => {
  process.env.PLAYER_DATA_ENABLED='false'; process.env.PLAYER_AVAILABILITY_ENABLED='false';
  process.env.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE='true';
  const durableDir=process.env.MODEL_A_BENCH_DURABLE_DIR;
  if(durableDir){fs.mkdirSync(durableDir,{recursive:true});process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR=path.join(durableDir,'spool');}
  const client = createClient({ url: durableDir ? `file:${path.join(durableDir,'benchmark.sqlite')}` : 'file::memory:' });
  try {
    await client.executeMultiple(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
    const params = new DixonColesModel().getParams(); params.attackParams={home:.4,away:-.4}; params.defenceParams={home:0,away:0};
    const now=Date.now(), fixture={match_id:'bench',home_team_id:'home',away_team_id:'away',competition:'Test',season:'2026/27',
      date:new Date(now+6*3600000).toISOString(),home_goals:null,away_goals:null};
    const wrapper={execute:(sql,args)=>client.execute({sql,args}),get:async(sql,args)=>(await client.execute({sql,args})).rows[0]??null};
    const db={getLatestModelParams:async()=>({params}), getTeamsByIds:async ids=>ids.map(team_id=>({team_id,name:team_id,competition:'Test'})),
      getMatchById:async()=>fixture,getTeamHistoricalCoverageBatch:async()=>({}),getTeamScheduleInsightsBatch:async()=>({}),
      appendModelAProspectiveForecast:r=>DatabaseService.prototype.appendModelAProspectiveForecast.call(wrapper,r)};
    const service=new PredictionService(db,{getMatchDetails:async()=>{throw Error('unexpected provider');}});
    service.applyAdaptiveTuning=async()=>null;service.getCalibrationProfile=async()=>({calibrationPoints:[{x:0,y:0},{x:1,y:1}],nObservations:0,byFamily:{},learnedBlendWeights:{}});
    const request={homeTeamId:'home',awayTeamId:'away',matchId:'bench',competition:'Test',season:'2026/27'},options={recordAudit:false};
    const pct=(a,p)=>[...a].sort((x,y)=>x-y)[Math.floor((a.length-1)*p)];
    const run=async flag=>{process.env.MODEL_A_PROSPECTIVE_ENABLED=flag;const latencies=[],admissionLatencies=[],confirmations=[];const start=performance.now();
      for(let block=0;block<5;block++)await Promise.all(Array.from({length:10},async()=>{const t=performance.now();let receipt;
        await service.predict(request,{...options,onProspectiveRecord:r=>{receipt=r;}});const responseMs=performance.now()-t;latencies.push(responseMs);
        if(flag==='true'){
          if(receipt?.durable || (!receipt && durableDir && process.env.MODEL_A_PROSPECTIVE_STORAGE!=='database'))admissionLatencies.push(responseMs);
          else if(receipt)confirmations.push(receipt.completion.then(result=>{if(result.status==='stored')admissionLatencies.push(performance.now()-t);}));
        }
      }));
      const elapsed=performance.now()-start;const drained=await drainModelAProspective(30000);await Promise.all(confirmations);const confirmedElapsedMs=performance.now()-start;
      return {requests:50,concurrency:10,p50Ms:pct(latencies,.5),p95Ms:pct(latencies,.95),elapsedMs:elapsed,requestsPerSecond:50000/elapsed,
        durableAdmissionSamples:admissionLatencies.length,durableAdmissionP50Ms:admissionLatencies.length?pct(admissionLatencies,.5):null,
        durableAdmissionP95Ms:admissionLatencies.length?pct(admissionLatencies,.95):null,confirmedElapsedMs,confirmedRequestsPerSecond:50000/confirmedElapsedMs,drained};};
    await service.predict(request,options); const off=await run('false'),on=await run('true');
    const rows=(await client.execute('SELECT COUNT(*) AS n FROM model_a_prospective_forecasts')).rows[0].n;
    const result={storage:process.env.MODEL_A_PROSPECTIVE_STORAGE||'file',scope:durableDir?'PredictionService with fixture stubs and local persistent libSQL; file mode uses fsynced spool, database mode admits only after commit; no HTTP or production database':
      'PredictionService with fixture stubs and in-memory libSQL; no HTTP, external providers, network or production database',off,on,rows,stats:modelAProspectiveStats()};
    if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n'); process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } finally {client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
