'use strict';
const { scheduleModelAProspective, modelAProspectiveStats } = require('../../dist/research/ModelAProspectiveRecorder');
const now=Date.now();process.env.MODEL_A_PROSPECTIVE_ENABLED='true';
const input={match:{match_id:'m',home_team_id:'h',away_team_id:'a',home_goals:null,away_goals:null,date:new Date(now+2000).toISOString()},
  request:{matchId:'m',homeTeamId:'h',awayTeamId:'a'},asOf:new Date(now).toISOString(),origin:'direct_a',
  model:{version:'A',codeHash:'',configHash:'',stateHash:''},contextual:{over25:.52},calibrated:null,decision:{},selected:null,
  modelParametersHash:'',calibration:{profileHash:'',globalSamples:0,overSamples:null,underSamples:null,overCurve:'unavailable',underCurve:'unavailable'}};
scheduleModelAProspective({appendModelAProspectiveForecast:()=>new Promise(()=>{})},input);
if(process.send)process.send(modelAProspectiveStats());setInterval(()=>{},1000);
