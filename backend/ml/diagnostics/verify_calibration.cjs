/* Numeric parity bridge for the diagnostic Python mirror and the actual TS API. */
const fs = require('node:fs');
const path = require('node:path');
const modulePath = process.env.RESEARCH_COHERENT_MODULE || path.resolve(__dirname, '../../artifacts/coherent-probability-test/research/CoherentProbabilityPipeline.js');
const { fitCoherentCalibration, applyCoherentProbabilityPipeline } = require(modulePath);
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const profile = fitCoherentCalibration(input.observations, input.asOf);
const output = applyCoherentProbabilityPipeline({ matrix: input.matrix, profile, quotes: [], forecastAt: input.asOf, mode: 'isotonic_1x2' });
process.stdout.write(JSON.stringify({ profile, matrix: output.matrix, probabilities: ['homeWin', 'draw', 'awayWin'].map((key) => output.calibrated[key]) }));
