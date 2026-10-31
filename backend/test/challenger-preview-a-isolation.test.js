const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { scenarios, runScenario } = require('./fixtures/operational-a/scenarios');
const expected = require('./fixtures/operational-a/expected.json');
const { ResearchRuntime } = require('../dist/research/ResearchRuntime');
const { baselineManifest, FEATURE_NAMES, FEATURE_SCHEMA_VERSION } = require('../dist/research/ForecastCore');
const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../dist/research/CoherentProbabilityPipeline');
const { buildChallengerRecommendation } = require('../dist/research/ChallengerRecommendation');
const { predictionConfig } = require('../dist/config/predictionConfig');
const { predictionEngineConfig } = require('../dist/config/PredictionEngineConfig');

function previewFixture() {
  const at = '2026-10-31T10:00:00.000Z';
  const version = 'C-process-isolation-test-only';
  const fixture = { match_id: 'process-isolation-test-only', home_team_id: 'home', away_team_id: 'away',
    home_team_name: 'Home', away_team_name: 'Away', competition: 'Serie A', season: '2026',
    date: '2026-11-01T17:00:00.000Z', home_goals: null, away_goals: null };
  const history = Array.from({ length: 45 }, (_, index) => ({ ...fixture,
    match_id: `history-test-only-${index}`, date: new Date(Date.UTC(2026, 7, 1 + index)).toISOString(),
    home_goals: index % 4, away_goals: (index + 1) % 3, home_xg: 1.4 + (index % 3) * .1, away_xg: 1.05,
    home_shots: 12, away_shots: 10, home_shots_on_target: 4, away_shots_on_target: 3 }));
  // A synthetic numeric tree exercises inference; it is not the operational C906 artifact.
  const tree = { oblivious_trees: [{ splits: [], leaf_values: [.04] }], scale_and_bias: [1, [0]] };
  const artifact = { family: 'C', version, featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
    candidateKind: 'intensity_correction', weight: .4, temperature: 1, models: { home: tree, away: tree },
    trainedThrough: '2026-09-01T00:00:00Z', validationThrough: '2026-09-20T00:00:00Z', createdAt: '2026-09-21T00:00:00Z',
    baselineVersion: baselineManifest().version };
  const profile = { protocol: 'existing-isotonic-v1', targetProtocol: 'joint_1x2_normalized-v2',
    nObservations: 600, matches: 200, fittedThrough: '2026-09-20T00:00:00Z',
    calibrationPoints: [{ x: 0, y: 0 }, { x: .5, y: .45 }, { x: 1, y: 1 }], byFamily: {}, learnedBlendWeights: {} };
  const deny = (name) => async () => assert.fail(`Unexpected write, external call or A read: ${name}`);
  const research = new Proxy({
    getPreviewModelC: async (selectedVersion) => {
      assert.equal(selectedVersion, version); return research.getModelByVersion('C');
    },
    getLatestPreviewBenchmarkC: async (selectedVersion) => {
      assert.equal(selectedVersion, version); return research.getLatestBenchmark('C');
    },
    getModelByVersion: async (family) => {
      assert.equal(family, 'C'); return { version, artifact, createdAt: artifact.createdAt };
    },
    getLatestBenchmark: async (family) => {
      assert.equal(family, 'C'); return { createdAt: artifact.createdAt, report: {
        probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2: coherentProbabilityPipelineHash(),
        baselineVersion: baselineManifest().version, probabilityCalibrationMode: 'isotonic_1x2', calibrationProfilesV2: { C: profile },
      } };
    },
    listMarkets: async ({ family }) => {
      assert.equal(family, 'C'); return [{ market: '1x2', state: 'EXPERIMENTAL' }, { market: 'totals', state: 'EXPERIMENTAL' }];
    },
    listProspectiveCalibrationSamples: async ({ family }) => { assert.equal(family, 'C'); return []; },
  }, { get(target, key) { return key in target ? target[key] : deny(`research.${String(key)}`); } });
  const db = { research, getMatchById: async () => fixture, getMatches: async () => history,
    saveSchedulerRun: deny('scheduler'), updateMatchKickoff: deny('kickoff'), getUpcomingMatches: deny('upcoming') };
  const odds = { getOdds: async () => [{ matchId: 'provider-test-only', homeTeam: 'Home', awayTeam: 'Away',
    commenceTime: fixture.date, provider: 'odds_api', capturedAt: at, bookmakers: [{ bookmakerKey: 'qa',
      bookmakerName: 'TEST ONLY', updatedAt: at, markets: [{ marketKey: 'h2h', updatedAt: at,
        outcomes: [{ name: 'Home', price: 2.5 }, { name: 'Draw', price: 3.3 }, { name: 'Away', price: 3.4 }] }],
    }] }] };
  return { at, version, fixture, db, odds };
}

function restoreRecord(target, original) {
  for (const key of Object.keys(target)) if (!(key in original)) delete target[key];
  Object.assign(target, original);
}

const environmentHash = (env) => createHash('sha256')
  .update(JSON.stringify(Object.entries(env).sort())).digest('hex');

test('operational A keeps all six frozen outputs and process state after real C-only preview inference', async () => {
  const original = { date: global.Date, random: Math.random, env: { ...process.env },
    config: JSON.stringify(predictionConfig), engine: JSON.stringify(predictionEngineConfig) };
  try {
    const before = [];
    for (const scenario of scenarios) {
      const output = await runScenario(scenario);
      assert.deepEqual(output, expected.scenarios.find((row) => row.scenario === scenario.id));
      before.push(output);
    }
    const { at, version, fixture, db, odds } = previewFixture();
    let randomCalls = 0;
    Math.random = () => { randomCalls++; return .5; };
    try {
      const runtime = new ResearchRuntime(db, { clock: () => new Date(at), odds,
        nightly: { quoteMaxAgeMs: 300000, minEv: .04, minPrudentialEv: .01 },
        deploymentC: { modelVersion: version, baselineVersion: baselineManifest().version,
          selectorPolicy: 'canonical-binary-v1', probabilityConfigurationHash: null, artifactHash: null } });
      const prepared = await runtime.preparePreviewC({ id: 'preview:test-only', matchId: fixture.match_id,
        kickoffAt: fixture.date, targetAt: at, leaseToken: '' });
      assert.equal(prepared.status, 'upcoming'); assert.equal(prepared.decisions.length, 1);
      assert.equal(prepared.decisions[0].family, 'C');
      assert.equal(prepared.decisions[0].validated, true, prepared.decisions[0].reason);
      for (const selectionPolicy of ['legacy-c906', 'payout-aware-v1']) {
        buildChallengerRecommendation({ decision: prepared.decisions[0], quotes: prepared.quotes,
          observedAt: at, competition: 'Serie A', allowedMarkets: ['1x2', 'totals'], selectionPolicy,
          expectedIdentity: { modelVersion: version, baselineVersion: baselineManifest().version } });
      }
    } finally { Math.random = original.random; }
    assert.equal(randomCalls, 0, 'C must not advance the global random stream used by A bootstrap');
    assert.equal(JSON.stringify(predictionConfig), original.config);
    assert.equal(JSON.stringify(predictionEngineConfig), original.engine);
    assert.equal(environmentHash(process.env), environmentHash(original.env), 'C must not mutate process environment');
    assert.equal(global.Date, original.date);
    for (let index = 0; index < scenarios.length; index++) {
      assert.deepEqual(await runScenario(scenarios[index]), before[index]);
    }
  } finally {
    global.Date = original.date; Math.random = original.random;
    restoreRecord(process.env, original.env);
    restoreRecord(predictionConfig, JSON.parse(original.config));
    restoreRecord(predictionEngineConfig, JSON.parse(original.engine));
  }
});
