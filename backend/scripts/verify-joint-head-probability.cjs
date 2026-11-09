'use strict';
// Read-only parity check against the archived final fold; no provider or database access.
const assert = require('node:assert/strict');
const path = require('node:path');
const base = path.resolve(__dirname, '../artifacts/research/c-joint-head-study-20261108-v2');
const prepared = require(path.join(base, 'prepared/inputs.json'));
const evidence = require(path.join(base, 'probabilities.json')).arms.joint_head;
const classifier = require(path.join(base, 'trained/fold-2026/model.json'));
const predictions = require(path.join(base, 'trained/fold-2026/predictions.json'));
const { jointHeadMatrix, restoreJointHeadSpread } = require('../dist/research/JointHeadProbability');
const { predictCatBoostJson } = require('../dist/research/CatBoostModel');
const { applyCoherentProbabilityPipeline } = require('../dist/research/CoherentProbabilityPipeline');
const groupMasses = matrix => { const masses = Array(6).fill(0); matrix.forEach((row, h) => row.forEach((v, a) => { masses[(h > a ? 0 : h === a ? 1 : 2) * 2 + Number(h + a >= 3)] += v; })); return masses; };
const rows = prepared.folds.find(f => f.year === 2026).targetRows;
const byEvidence = new Map(evidence.probabilityEvidence.folds['2026'].rows.map(r => [r.matchId, r]));
const byPrediction = new Map(predictions.rows.filter(r => r.partition === 'target').map(r => [r.matchId, r]));
const byForecast = new Map(evidence.forecasts.filter(f => f.modelVersion.includes('-2026-')).map(f => [f.matchId, f]));
let maxRaw = 0, maxMass = 0, maxRestored = 0, maxCalibrated = 0, maxDecision = 0;
const profile = evidence.calibration.folds['2026'];
for (const row of rows) {
  const expected = byEvidence.get(row.matchId), pred = byPrediction.get(row.matchId), forecast = byForecast.get(row.matchId);
  assert(expected && pred && forecast);
  const raw = predictCatBoostJson(classifier, row.features40);
  raw.forEach((v, i) => { maxRaw = Math.max(maxRaw, Math.abs(v - pred.nativeRaw6[i])); });
  const rawMatrix = jointHeadMatrix(row.baselineMatrix, classifier, row.features40);
  const masses = groupMasses(rawMatrix);
  masses.forEach((v, i) => { maxMass = Math.max(maxMass, Math.abs(v - expected.postTemperature[i])); });
  // The original close prices were observed retrospectively. These fabricated timestamps
  // test mathematics only and are never persisted or represented as executable quotes.
  const quotes = row.quotes.map(q => ({ ...q, source: 'odds_api', capturedAt: row.forecastAt,
    updatedAt: row.forecastAt, priceType: 'prematch', timestampEvidence: 'provider_update' }));
  const pipeline = applyCoherentProbabilityPipeline({ matrix: rawMatrix, profile, mode: 'isotonic_1x2',
    quotes, forecastAt: row.forecastAt });
  const calibrated = applyCoherentProbabilityPipeline({ matrix: rawMatrix, profile, mode: 'isotonic_1x2',
    quotes: [], forecastAt: row.forecastAt }).matrix;
  calibrated.forEach((r, h) => r.forEach((v, a) => { maxCalibrated = Math.max(maxCalibrated, Math.abs(v - forecast.calibratedMatrix[h][a])); }));
  pipeline.matrix.forEach((r, h) => r.forEach((v, a) => { maxDecision = Math.max(maxDecision, Math.abs(v - forecast.decisionMatrix[h][a])); }));
  const actual = restoreJointHeadSpread(forecast.decisionMatrix);
  groupMasses(actual).forEach((v, i) => { maxRestored = Math.max(maxRestored, Math.abs(v - expected.finalUnder[i])); });
}
assert.equal(rows.length, 448);
assert(maxRaw <= 1e-12 && maxMass <= 1e-12 && maxRestored <= 1e-12 && maxCalibrated <= 1e-12 && maxDecision <= 1e-12);
console.log(JSON.stringify({ rows: rows.length, maxRaw, maxMass, maxCalibrated, maxDecision, maxRestored }));
