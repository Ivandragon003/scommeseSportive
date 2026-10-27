// Synthetic integration inputs only. These are not sporting evidence or production models.
const { baselineManifest, FEATURE_NAMES, FEATURE_SCHEMA_VERSION } = require('../dist/research/ForecastCore');
const { fitCoherentCalibration, COHERENT_PROBABILITY_PROTOCOL, coherentProbabilityPipelineHash } = require('../dist/research/CoherentProbabilityPipeline');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');

const BEFORE = '2026-09-01T00:00:00.000Z';
const TARGET = '2026-10-27T19:30:00.000Z';
const KICKOFF = '2026-10-27T19:45:00.000Z';
const fixtures = Array.from({ length: 3 }, (_, index) => ({
  matchId: `synthetic-hostless-${index}`, homeTeamId: `synthetic-home-${index}`, awayTeamId: `synthetic-away-${index}`,
  homeTeamName: `Synthetic Home ${index}`, awayTeamName: `Synthetic Away ${index}`,
  competition: 'Serie A', season: '2026/2027', date: KICKOFF, source: 'understat',
  rawJson: JSON.stringify({ syntheticTestFixture: true }),
}));

function artifact() {
  const model = (value) => ({ oblivious_trees: [{ splits: [], leaf_values: [value] }], scale_and_bias: [1, [0]] });
  return { version: 'C-hostless-synthetic-v1', family: 'C', featureNames: FEATURE_NAMES,
    featureSchema: FEATURE_SCHEMA_VERSION, baselineVersion: baselineManifest().version,
    probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2: coherentProbabilityPipelineHash(),
    probabilityCalibrationMode: 'identity', trainedThrough: BEFORE, validationThrough: BEFORE, createdAt: BEFORE,
    candidateKind: 'calibrated_ensemble', weight: .5, temperature: 1,
    models: { home: model(Math.log(4)), away: model(Math.log(.2)) }, fixtureOnly: true };
}

function evidence(family, modelVersion) {
  const samples = Array.from({ length: 500 }, (_, index) => ({ matchId: `synthetic-calibration-${index}`,
    market: '1x2', probability: .1 + (index % 5) * .2, odds: 1.9, expectedValue: 0,
    returnMultiplier: 1.9, outcomeAvailableAt: BEFORE, phase: 'validation' }));
  const profiles = { A: fitCoherentCalibration([], BEFORE), C: fitCoherentCalibration([], BEFORE) };
  const configuration = buildProbabilityConfiguration({ family, baselineVersion: baselineManifest().version,
    pipelineHashV2: coherentProbabilityPipelineHash(), mode: 'identity', profile: profiles[family] });
  return { fixtureOnly: true, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
    pipelineHashV2: coherentProbabilityPipelineHash(), probabilityCalibrationMode: 'identity',
    validation: { passed: false, finalHoldout: true, operationalChecksPassed: true,
      probabilityConfigurationHash: configuration.hash, dataHash: 'synthetic-hostless-integration',
      baselineHash: baselineManifest().fingerprint, featureSchema: FEATURE_NAMES },
    marketValidation: { '1x2': { family, modelVersion, rule: 'research-market-eligibility-v1',
      probabilityConfiguration: configuration.descriptor, approvedProbabilityConfigurationHash: configuration.hash,
      independentEvaluationPassed: true, dataCoverage: true, quoteCoverage: true, settlementVerified: true,
      probabilisticSamples: 500, leagueCount: 5, periodCount: 4, calibrationPassed: true } },
    calibrationProfilesV2: profiles, calibrationSamples: { A: samples, C: samples } };
}

function providerEvents() {
  return fixtures.map((fixture) => ({ id: fixture.matchId, home_team: fixture.homeTeamName,
    away_team: fixture.awayTeamName, commence_time: KICKOFF,
    bookmakers: [{ key: 'synthetic-test-bookmaker', title: 'Synthetic test bookmaker',
      last_update: TARGET, markets: [{ key: 'h2h', last_update: TARGET,
        outcomes: [{ name: fixture.homeTeamName, price: 1.9 }, { name: 'Draw', price: 10 },
          { name: fixture.awayTeamName, price: 10 }] }] }] }));
}

module.exports = { BEFORE, TARGET, KICKOFF, fixtures, artifact, evidence, providerEvents };
