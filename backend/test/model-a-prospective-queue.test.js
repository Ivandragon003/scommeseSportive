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
