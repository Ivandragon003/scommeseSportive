const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProbabilityConfiguration } = require('../../dist/research/ProbabilityConfiguration');
const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../../dist/research/CoherentProbabilityPipeline');
const { scoreMatrixMarkets } = require('../../dist/research/GoalSettlement');
const { CURRENT_CHALLENGER_RELEASE } = require('../../dist/research/CurrentChallengerRelease');
const { inspectRecord, runReplay } = require('./strict-archive-replay');
const artifact = require('../../current-models/challenger.json');
const expected = { codeHash: '1'.repeat(64), configHash: '2'.repeat(64) };
const at = '2026-10-31T12:00:00.000Z';
function fixture() {
  const matrix = [[.2,.2,0],[.6,0,0],[0,0,0]];
  const config = buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion, pipelineHashV2: artifact.pipelineHashV2,
    mode: artifact.probabilityCalibrationMode, profile: artifact.calibrationProfilesV2.C });
  const decision = { validated: true, modelVersion: CURRENT_CHALLENGER_RELEASE.modelVersion, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
    calibrationPipelineHash: coherentProbabilityPipelineHash(), calibrationAvailableAt: at, prospectiveMatrix: matrix,
    probabilityConfiguration: config.descriptor, probabilityConfigurationHash: config.hash, probabilityStages: { decision: scoreMatrixMarkets(matrix) },
    forecastAt: at, challengerQuality: { modelFitAt: at, historyAvailableThrough: at } };
  const quotes = [['homeWin','home',2.5],['draw','draw',4],['awayWin','away',4]].map(([selection,side,odds]) => ({ selection, side, odds,
    market: '1x2', bookmaker: 'Book', source: 'odds_api', priceType: 'prematch', capturedAt: at, updatedAt: at }));
  const op = { selection:'homeWin', marketName:'Home', marketCategory:'goal_1x2', marketTier:'CORE', confidence:'MEDIUM',
    bookmakerOdds:2.5, ourProbability:60, expectedValue:50, edge:20, edgeNoVig:15, suggestedStakePercent:2, kellyFraction:3,
    isValueBet:true, evReason:'computed' };
  const packet = { policyVersion:'match-page-recommendation-v1', asOf:at, model:{source:'PredictionService', version:'APP-A-abc',
    ...expected, stateHash:'3'.repeat(64)}, odds:{source:'odds_api',capturedAt:at,bookmakerBySelection:{homeWin:'Book'}},
    ranked:[op], selected:op, probabilities:{raw:{homeWin:.6},decision:{homeWin:.6}} };
  return { id:'r1', matchId:'m1', kickoffAt:'2026-10-31T20:00:00Z', competition:'Serie A', homeGoals:1, awayGoals:0,
    stats:{}, baselineInput: { matchId: 'm1', kickoffAt: '2026-10-31T20:00:00Z', forecastAt: at, modelFitAt: at,
      maxTrainingAvailableAt: at, trainingCount: 100, baselineVersion: CURRENT_CHALLENGER_RELEASE.baselineVersion },
    snapshot:{observedAt:at, quoteSnapshots:{A:quotes}, forecasts:{A:packet,C:{decision}}} };
}
const run = records => runReplay({ format:'c-team-archive-input-v1', records }, expected);
test('valid current C and current A replay a real common sheet and settle fixed units', () => {
  const r = run([fixture()]); assert.equal(r.status,'ARCHIVE_CANDIDATE_PAIRS_ONLY'); assert.equal(r.pairs.length,1);
  assert.equal(r.pairs[0].A.returnMultiplier,2.5); assert.equal(r.pairs[0].C.returnMultiplier,2.5);
  assert.equal(r.pairs[0].cSelection,'homeWin'); assert.equal(r.economicComparison.roiA,null);
  assert.equal(r.economicComparison.profitUnitsC,null); assert.equal(r.economicComparison.status,'UNAVAILABLE');
});
test('earliest admissible pair only counts once per fixture', () => {
  const first=fixture(), second=structuredClone(first); second.id='r2'; second.snapshot.observedAt='2026-10-31T12:00:01Z';
  const r=run([second,first]); assert.equal(r.pairs.length,1); assert.equal(r.pairs[0].id,'r1');
});
test('old C never becomes current and zero-observation metrics remain null', () => {
  const f=fixture(); f.snapshot.forecasts.C.decision.modelVersion='C-old';
  const r=run([f]); assert.equal(r.status,'INSUFFICIENT_ARCHIVE_DATA'); assert.equal(r.pairs.length,0);
  assert.equal(r.economicComparison.roiA,null); assert.equal(r.economicComparison.profitUnitsC,null); assert.equal(r.allReasons.challenger_model_version_mismatch,1);
});
test('stale, synthetic and incomplete real sheets fail closed', () => {
  for(const change of [{source:'odds_api_plus_model_completion'}, {updatedAt:'2026-10-31T11:54:00Z'}]) {
    const f=fixture(); f.snapshot.quoteSnapshots.A.forEach(q=>Object.assign(q,change));
    assert.equal(run([f]).pairs.length,0);
  }
  const f=fixture(); f.snapshot.quoteSnapshots.A.pop(); assert.equal(run([f]).pairs.length,0);
});
test('unrepresented specialist probabilities and missing settlement stats cannot create a pair', () => {
  const f=fixture(); f.snapshot.quoteSnapshots.A.push({ ...f.snapshot.quoteSnapshots.A[0], selection:'yellow_over_4.5', market:'yellow_cards', side:'over', line:4.5 });
  f.snapshot.forecasts.A.probabilities.decision['yellow_over_4.5']=.6;
  assert.ok(inspectRecord(f,expected).reasons.includes('specialist_opportunities_incomplete'));
  const s=fixture(), op=s.snapshot.forecasts.A.selected;
  Object.assign(op,{selection:'cards_total_over_4.5',marketCategory:'yellow_cards',bookmakerOdds:2.5});
  s.snapshot.forecasts.A.probabilities.decision={'cards_total_over_4.5':.6};
  s.snapshot.forecasts.A.odds.bookmakerBySelection={'cards_total_over_4.5':'Book'};
  s.snapshot.quoteSnapshots.A=[{...s.snapshot.quoteSnapshots.A[0],selection:'cards_total_over_4.5',market:'cards_total',side:'over',line:4.5},
    {...s.snapshot.quoteSnapshots.A[1],selection:'cards_total_under_4.5',market:'cards_total',side:'under',line:4.5}];
  assert.ok(inspectRecord(s,expected).reasons.includes('settlement_data_unavailable'));
});

test('future or missing C training evidence and synthetic snake-case flags fail closed', () => {
  const future='2026-10-31T12:00:01.000Z';
  for (const mutate of [
    f => { f.snapshot.forecasts.C.decision.forecastAt=future; },
    f => { f.snapshot.forecasts.C.decision.challengerQuality.modelFitAt=future; },
    f => { f.snapshot.forecasts.C.decision.challengerQuality.historyAvailableThrough=future; },
    f => { f.snapshot.forecasts.C.decision.calibrationAvailableAt=future; },
    f => { f.baselineInput.forecastAt=future; },
    f => { f.baselineInput.modelFitAt=future; },
    f => { f.baselineInput.maxTrainingAvailableAt=future; },
    f => { f.baselineInput=null; },
    f => { f.baselineInput.baselineVersion='A-old'; },
    f => { f.snapshot.quoteSnapshots.A.forEach(q => { q.used_synthetic_odds=true; }); },
    f => { f.snapshot.quoteSnapshots.A.forEach(q => { q.usedSyntheticOdds=true; }); },
  ]) { const f=fixture(); mutate(f); assert.equal(run([f]).pairs.length,0); }
});
