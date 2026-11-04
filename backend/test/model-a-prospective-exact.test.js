const { test }=require('node:test');const assert=require('node:assert/strict');
const {ValueBettingEngine}=require('../dist/models/value/ValueBettingEngine');
const {scheduleModelAProspective,drainModelAProspective}=require('../dist/research/ModelAProspectiveRecorder');
process.env.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE='true';
test('observer sees the same unformatted value passed to EV, without changing opportunities',()=>{
  const engine=new ValueBettingEngine(),groups=engine.buildMarketGroups({over25:2.8,under25:1.5}),p={over25:.543217,under25:.456783};
  const base=engine.analyzeMarketsWithVigRemoval(p,groups,{}, {enableMarketBlending:true});
  let seen;const orig=engine.computeExpectedValue.bind(engine),used=[];
  engine.computeExpectedValue=(probability,odds)=>{used.push(probability);return orig(probability,odds);};
  const observed=engine.analyzeMarketsWithVigRemoval(p,groups,{}, {enableMarketBlending:true,
    onEffectiveProbability:(selection,value)=>{if(selection==='over25')seen=value;}});
  assert.deepEqual(observed,base);assert.ok(used.includes(seen));assert.ok(seen>0&&seen<1);
  assert.deepEqual(engine.analyzeMarketsWithVigRemoval(p,groups,{}, {enableMarketBlending:true,onEffectiveProbability:()=>{throw Error('observer');}}),base);
});
test('exact selected probability is stored only if matching candidates are unambiguous',async()=>{
  process.env.MODEL_A_PROSPECTIVE_ENABLED='true';const records=[];const now=Date.now(),input={
    match:{match_id:'m',home_team_id:'h',away_team_id:'a',home_goals:null,away_goals:null,date:new Date(now+3600000).toISOString()},
    request:{matchId:'m',homeTeamId:'h',awayTeamId:'a'},asOf:new Date(now).toISOString(),origin:'direct_a',
    model:{version:'A',codeHash:'',configHash:'',stateHash:''},contextual:{},calibrated:null,decision:{},
    selected:{selection:'over25',ourProbability:54.32},exactCandidates:[{selection:'over25',probability:.543217,origin:'vig'}],
    modelParametersHash:'',calibration:{profileHash:'',globalSamples:0,overSamples:null,underSamples:null,overCurve:'unavailable',underCurve:'unavailable'}};
  try {const sink={appendModelAProspectiveForecast:async r=>records.push(JSON.parse(r.payload))};
    scheduleModelAProspective(sink,input);assert.equal(await drainModelAProspective(1000),true);
    assert.equal(records[0].selected.exactProbability,.543217);
    input.exactCandidates.push({selection:'over25',probability:.543216,origin:'board'});
    scheduleModelAProspective(sink,input);assert.equal(await drainModelAProspective(1000),true);
    assert.equal(records[1].selected.exactProbability,null);assert.match(records[1].selected.exactReason,/uniquely/);
  } finally {delete process.env.MODEL_A_PROSPECTIVE_ENABLED;}
});
