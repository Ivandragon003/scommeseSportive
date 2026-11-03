'use strict';
// Offline only: fit the existing coherent calibration on this fold's labels.
const fs = require('node:fs');
const path = require('node:path');
const research = path.resolve(__dirname, '../../../dist/research');
const { fitCoherentCalibration, applyCoherentProbabilityPipeline } = require(path.join(research, 'CoherentProbabilityPipeline'));
const { goalCalibrationObservation } = require(path.join(research, 'ResearchProbabilityPipeline'));
const { scoreMatrixMarkets } = require(path.join(research, 'GoalSettlement'));
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const observations = input.calibration.map(({ row, matrix }) => goalCalibrationObservation(
  row.matchId, row.availableAt, scoreMatrixMarkets(matrix), row.homeGoals, row.awayGoals));
const profile = fitCoherentCalibration(observations, input.cutoff);
const predictions = input.test.map(({ row, matrix }) => {
  const result = applyCoherentProbabilityPipeline({ matrix, profile, mode: 'isotonic_1x2', quotes: [], forecastAt: row.forecastAt });
  return ['homeWin', 'draw', 'awayWin'].map(key => result.decision[key]);
});
fs.writeFileSync(process.argv[3], JSON.stringify({ predictions, fittedThrough: profile.fittedThrough, matches: profile.matches }));
