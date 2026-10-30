const test = require('node:test');
const assert = require('node:assert/strict');
const { ResearchRuntime } = require('../dist/research/ResearchRuntime');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = require('../dist/research/ForecastCore');
const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../dist/research/CoherentProbabilityPipeline');

const AT = '2026-10-29T19:30:00.000Z', KICKOFF = '2026-10-29T19:45:00.000Z';
const policy = { quoteMaxAgeMs: 300000, minEv: .04, minPrudentialEv: .01 };

function harness(options = {}) {
  const baselineVersion = baselineManifest().version;
  const tree = { oblivious_trees: [{ leaf_values: [.1] }], scale_and_bias: [1, [0]] };
  const artifact = { family: 'C', version: options.modelVersion ?? 'C-cohort-fixture', featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
    baselineVersion, candidateKind: 'intensity_correction', weight: .5, temperature: 1,
    trainedThrough: '2026-09-01T00:00:00Z', validationThrough: '2026-10-01T00:00:00Z', createdAt: '2026-10-02T00:00:00Z',
    models: { home: tree, away: tree }, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
    pipelineHashV2: coherentProbabilityPipelineHash(), probabilityCalibrationMode: 'identity' };
  // Favorable synthetic fixture evidence exercises the unchanged decision path,
  // never predictive quality or the production calibration register.
  const samples = Array.from({ length: 500 }, (_, index) => ({ matchId: `independent-fixture-${index}`, market: '1x2',
    probability: .1 + (index % 5) * .2, odds: 10, expectedValue: 0, returnMultiplier: 10,
    outcomeAvailableAt: '2026-10-28T00:00:00Z', phase: 'validation' }));
  const state = { model: { version: artifact.version, artifact }, market: 'EXPERIMENTAL',
    modelFailures: options.modelFailures ?? 0, reportFailures: options.reportFailures ?? 0 };
  const counts = { champions: 0, models: 0, reports: { A: 0, C: 0 }, markets: 0, samples: 0 };
  const rows = [0, 1].map((index) => ({ match_id: `cohort-fixture-${index}`, home_team_id: 'h', away_team_id: 'a',
    home_team_name: `Home ${index}`, away_team_name: `Away ${index}`, date: KICKOFF,
    competition: 'Serie A', season: '2026/27', home_goals: null, away_goals: null }));
  const history = Array.from({ length: 45 }, (_, index) => ({ ...rows[0], match_id: `past-${index}`,
    date: new Date(Date.parse(AT) - (index + 2) * 86400000).toISOString(), home_goals: index % 3, away_goals: index % 2,
    home_xg: 1.4, away_xg: 1.1 }));
  const job = (index, runId = 'cohort-one') => ({ id: `job-${index}`, matchId: rows[index].match_id, kickoffAt: KICKOFF,
    targetAt: AT, leaseToken: `lease-${index}`, runId });
  const commits = [];
  let claimed = false;
  const exactReads = [];
  const research = {
    getChampion: async () => { counts.champions++; return options.champion ? state.model : null; },
    getModels: async () => { counts.models++; if (state.modelFailures-- > 0) throw new Error('fixture_models_transient'); return state.models ?? [state.model]; },
    getModelByVersion: async (family, version) => {
      counts.models++; exactReads.push({ family, version });
      return (state.models ?? [state.model]).find((model) => model.version === version) ?? null;
    },
    getLatestBenchmark: async (family, version) => {
      counts.reports[family]++;
      if (family === 'C' && state.reportFailures-- > 0) throw new Error('fixture_report_transient');
      const model = (state.models ?? [state.model]).find((entry) => entry.version === version) ?? state.model;
      return family === 'A' ? null : { modelVersion: version, createdAt: '2026-10-28T00:00:00Z',
        report: { ...model.artifact, calibrationSamples: { A: samples, C: samples } } };
    },
    listMarkets: async ({ family }) => { counts.markets++; return [{ family, market: '1x2', state: state.market, evidence: {} }]; },
    listProspectiveCalibrationSamples: async () => { counts.samples++; return samples; },
    syncJobs: async () => [], claimDueJobs: async () => claimed ? [] : (claimed = true, [job(0), job(1)]),
    commitBatch: async (batch) => { commits.push(batch); return {}; }, finishJob: async () => {}, listBets: async () => [],
  };
  const db = { research, getMatchById: async (id) => rows.find((row) => row.match_id === id),
    getUpcomingMatches: async () => rows, getMatches: async () => history, updateMatchKickoff: async () => {}, saveSchedulerRun: async () => {} };
  const odds = { getOdds: async () => rows.map((row, index) => ({ matchId: `provider-${index}`, homeTeam: row.home_team_name,
    awayTeam: row.away_team_name, commenceTime: row.date, capturedAt: AT, bookmakers: [{ bookmakerKey: 'fixture', bookmakerName: 'Fixture Book',
      updatedAt: AT, markets: [{ marketKey: 'h2h', outcomes: [{ name: row.home_team_name, price: 10 }, { name: 'Draw', price: 10 },
        { name: row.away_team_name, price: 10 }] }] }] })) };
  const runtime = new ResearchRuntime(db, { clock: () => new Date(AT), odds, candidateVersionC: options.candidateVersionC,
    ...(options.legacy ? {} : { nightly: policy }) });
  return { runtime, state, counts, job, commits, exactReads };
}

test('an explicit C pin reads only its exact artifact and ignores later weekly candidates and champion selection', async () => {
  const version = 'C-906371b0b3a1e2c8';
  const h = harness({ modelVersion: version, candidateVersionC: version, champion: true });
  const fixed = h.state.model;
  const weekly = { version: 'C-weekly-next', artifact: { ...fixed.artifact, version: 'C-weekly-next' } };
  h.state.models = [fixed, weekly]; h.state.model = weekly;
  const first = await h.runtime.prepareNightly(h.job(0));
  const second = await h.runtime.prepareNightly(h.job(1));
  for (const result of [first, second]) {
    const c = result.decisions.find((decision) => decision.family === 'C');
    assert.equal(c.modelVersion, version); assert.equal(c.validated, true);
    assert.ok(c.probabilityStages.decision);
  }
  assert.deepEqual(h.exactReads, [{ family: 'C', version }]);
  assert.equal(h.counts.models, 1); assert.equal(h.counts.champions, 0); assert.equal(h.counts.reports.C, 1);
});

test('missing pinned C is an explicit technical abstention and never falls back to a newer registry candidate', async () => {
  const h = harness({ candidateVersionC: 'C-906371b0b3a1e2c8' });
  const result = await h.runtime.prepareNightly(h.job(0));
  const c = result.decisions.find((decision) => decision.family === 'C');
  assert.equal(c.modelVersion, 'C-unavailable'); assert.equal(c.action, 'ABSTAIN'); assert.equal(c.validated, false);
  assert.equal(c.reason, 'hybrid_model_unavailable_or_incompatible');
  assert.equal(h.counts.champions, 0); assert.equal(h.exactReads.length, 1);
});

test('two nightly fixtures share one model/report snapshot, retain identical decisions and still read every safety market', async () => {
  const h = harness();
  const first = await h.runtime.prepareNightly(h.job(0));
  const second = await h.runtime.prepareNightly(h.job(1));
  assert.deepEqual(h.counts, { champions: 1, models: 1, reports: { A: 1, C: 1 }, markets: 4, samples: 2 });
  assert.deepEqual(second.decisions, first.decisions);
  assert.ok(first.decisions.every((decision) => decision.action === 'BET'));
  assert.deepEqual(first.decisions, (await harness().runtime.prepareNightly(h.job(0))).decisions);
});

test('a new cohort reloads registry/report context and explicit same-run reset also reloads residual evidence', async () => {
  const h = harness();
  await h.runtime.prepareNightly(h.job(0));
  await h.runtime.prepareNightly(h.job(1, 'cohort-two'));
  assert.equal(h.counts.models, 2); assert.deepEqual(h.counts.reports, { A: 2, C: 2 }); assert.equal(h.counts.samples, 4);
  h.runtime.beginNightlyCohort('cohort-two');
  await h.runtime.prepareNightly(h.job(0, 'cohort-two'));
  assert.equal(h.counts.models, 3); assert.deepEqual(h.counts.reports, { A: 3, C: 3 }); assert.equal(h.counts.samples, 6);
});

test('registry/report rotation cannot replace the frozen model context halfway through a nightly cohort', async () => {
  const h = harness();
  const first = await h.runtime.prepareNightly(h.job(0));
  h.state.model = { version: 'C-next-cohort', artifact: { ...h.state.model.artifact, version: 'C-next-cohort' } };
  const second = await h.runtime.prepareNightly(h.job(1));
  assert.deepEqual(second.decisions, first.decisions);
  const next = await h.runtime.prepareNightly(h.job(0, 'cohort-two'));
  assert.equal(next.decisions.find((decision) => decision.family === 'C').modelVersion, 'C-next-cohort');
  assert.equal(h.counts.models, 2); assert.deepEqual(h.counts.reports, { A: 2, C: 2 });
});

test('a rejected model or report read is evicted so the same cohort can retry without a poisoned promise', async () => {
  for (const failure of ['modelFailures', 'reportFailures']) {
    const h = harness({ [failure]: 1 });
    await assert.rejects(h.runtime.prepareNightly(h.job(0)), /fixture_.*_transient/);
    const recovered = await h.runtime.prepareNightly(h.job(0));
    assert.ok(recovered.decisions.every((decision) => decision.action === 'BET'));
    assert.equal(h.counts.models, 2);
    assert.equal(h.counts.reports.C, failure === 'reportFailures' ? 2 : 1);
    await h.runtime.prepareNightly(h.job(1));
    assert.equal(h.counts.models, 2);
  }
});

test('the existing champion fallback survives an optional candidate-list failure without caching a degraded context', async () => {
  const h = harness({ champion: true, modelFailures: 1 });
  const first = await h.runtime.prepareNightly(h.job(0));
  const second = await h.runtime.prepareNightly(h.job(1));
  assert.deepEqual(second.decisions, first.decisions);
  assert.equal(h.counts.models, 2); assert.deepEqual(h.counts.reports, { A: 2, C: 2 });
});

test('a suspended market remains a live admission check despite the nightly context cache', async () => {
  const h = harness();
  await h.runtime.prepareNightly(h.job(0));
  h.state.market = 'SUSPENDED';
  const second = await h.runtime.prepareNightly(h.job(1));
  assert.ok(second.decisions.every((decision) => decision.action === 'ABSTAIN'));
  assert.deepEqual(second.prospectiveObservations, []);
  assert.equal(h.counts.models, 1); assert.equal(h.counts.reports.C, 1); assert.equal(h.counts.markets, 4);
});

test('legacy T15 retains a model/report lookup per fixture and cannot enter a nightly cohort', async () => {
  const h = harness({ legacy: true });
  assert.equal((await h.runtime.tick()).completed, 2);
  assert.equal(h.counts.models, 2); assert.deepEqual(h.counts.reports, { A: 2, C: 2 });
  assert.equal(h.counts.samples, 0);
  assert.throws(() => h.runtime.beginNightlyCohort('legacy'), /nightly cohort/);
});
