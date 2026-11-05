const AT = '2025-06-01T12:00:00.000Z';
const history = Array.from({length: 44}, (_, i) => {
  const match = {matchId:`m${i}`, homeTeamId:`t${i%4}`, awayTeamId:`t${(i+1+i%2)%4}`, date:new Date(Date.UTC(2024,7,1+i*5)).toISOString(), competition:'Serie A', homeGoals:i%4, awayGoals:(i*3)%3, homeTotalShots:8+i%5, awayTotalShots:6+i%4};
  const values = [undefined,null,'',0,1.25,2.1];
  match.homeXG=values[i%values.length]; match.awayXG=values[(i+2)%values.length];
  return match;
});
const target = {matchId:'target',homeTeamId:'t0',awayTeamId:'t1',date:'2025-06-02T12:00:00Z',competition:'Serie A'};
const profile = {protocol:'existing-isotonic-v1',fittedThrough:'2025-01-01T00:00:00Z',matches:1000,nObservations:3000,calibrationPoints:[{x:0,y:0},{x:.25,y:.1},{x:.6,y:.8},{x:1,y:1}],byFamily:{},learnedBlendWeights:{},targetProtocol:'joint_1x2_normalized-v2'};
const quotes=['homeWin','draw','awayWin'].map((selection,i)=>({selection, market:'1x2',side:['home','draw','away'][i], odds:[2,3.6,4][i],bookmaker:'Fixture bookmaker',source:'odds_api',capturedAt:AT,updatedAt:AT}));
module.exports={AT,history,target,profile,quotes};
