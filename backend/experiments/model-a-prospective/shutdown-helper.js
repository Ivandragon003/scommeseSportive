'use strict';
const fs=require('node:fs');const {installModelAProspectiveShutdown}=require('../../dist/research/ModelAProspectiveShutdown');
const {scheduleModelAProspective}=require('../../dist/research/ModelAProspectiveRecorder');
process.env.MODEL_A_PROSPECTIVE_ENABLED='true';process.env.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE='true';const now=Date.now();
installModelAProspectiveShutdown({close:done=>setTimeout(done,10)});
scheduleModelAProspective({appendModelAProspectiveForecast:async()=>{await new Promise(r=>setTimeout(r,60));fs.writeFileSync(process.argv[3],'written');}},
  {match:{match_id:'m',home_team_id:'h',away_team_id:'a',home_goals:null,away_goals:null,date:new Date(now+3600000).toISOString()},
    request:{matchId:'m',homeTeamId:'h',awayTeamId:'a'},asOf:new Date(now).toISOString(),origin:'direct_a',
    model:{version:'A',codeHash:'',configHash:'',stateHash:''},contextual:{},calibrated:null,decision:{},selected:null,modelParametersHash:'',
    calibration:{profileHash:'',globalSamples:0,overSamples:null,underSamples:null,overCurve:'unavailable',underCurve:'unavailable'}});
process.emit(process.argv[2]);
