const test = require('node:test');
const assert = require('node:assert/strict');
const { ResearchRuntime } = require('../dist/research/ResearchRuntime');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = require('../dist/research/ForecastCore');
const { COHERENT_PROBABILITY_PROTOCOL, coherentProbabilityPipelineHash } = require('../dist/research/CoherentProbabilityPipeline');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');
const { researchHash } = require('../dist/research/ResearchStore');

const AT = '2026-10-31T12:00:00.000Z';
const KICKOFF = '2026-10-31T19:00:00.000Z';
const policy = { quoteMaxAgeMs: 300000, minEv: .04, minPrudentialEv: .01 };

function model() {
  return { family: 'C', version: 'C-preview-fixture', featureNames: FEATURE_NAMES,
    featureSchema: FEATURE_SCHEMA_VERSION, baselineVersion: baselineManifest().version,
    candidateKind: 'no_ml', weight: 0, temperature: 1, models: {},
    trainedThrough: '2026-08-01T00:00:00Z', validationThrough: '2026-10-01T00:00:00Z', createdAt: '2026-10-02T00:00:00Z',
    probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2: coherentProbabilityPipelineHash(),
    probabilityCalibrationMode: 'identity' };
}

function harness(options = {}) {
  const artifact = model();
  if (options.invalidArtifact) artifact.featureSchema = 'not-a-supported-schema';
  if (options.artifactCreatedAt) artifact.createdAt = options.artifactCreatedAt;
  const writes = [], reads = [], providerCalls = [];
  let now = Date.parse(AT), matchReads = 0;
  const mutation = (name) => async (...args) => {
    writes.push({ name, args });
    if (!options.allowWrites) throw new Error(`Forbidden preview write: ${name}`);
    return [];
  };
  const row = { match_id: 'preview-fixture', home_team_id: 'h', away_team_id: 'a',
    home_team_name: 'Home', away_team_name: 'Away', competition: 'Serie A', season: '2026/27',
    date: KICKOFF, home_goals: null, away_goals: null, ...options.row };
  const history = Array.from({ length: 45 }, (_, index) => ({ ...row, match_id: `history-${index}`,
    date: new Date(Date.parse(AT) - (index + 2) * 86400000).toISOString(),
    home_goals: index % 3, away_goals: index % 2, home_xg: 1.4, away_xg: 1.1 }));
  const research = new Proxy({
    getPreviewModelC: async (version) => research.getModelByVersion('C', version),
    getLatestPreviewBenchmarkC: async (version) => research.getLatestBenchmark('C', version),
    getModelByVersion: async (family, version) => {
      reads.push(['model', family, version]);
      return version === artifact.version ? { version, artifact, artifactHash: researchHash(artifact),
        ...(!options.registryMetadataMissing ? { createdAt: options.registryCreatedAt ?? '2026-10-03T00:00:00Z' } : {}) } : null;
    },
    getLatestBenchmark: async (family, version) => {
      reads.push(['benchmark', family, version]);
      return options.withBenchmark && family === 'C'
        ? { createdAt: '2026-10-10T00:00:00Z', modelVersion: version, report: model() } : null;
    },
    listMarkets: async ({ family, modelVersion }) => {
      reads.push(['markets', family, modelVersion]);
      return [{ family, market: '1x2', state: 'EXPERIMENTAL' }];
    },
    listProspectiveCalibrationSamples: async (query) => {
      reads.push(['samples', query.family, query.modelVersion]);
      if (options.startDuringSamples) now = Date.parse(KICKOFF);
      return [];
    },
  }, { get: (target, key) => key in target ? target[key] : mutation(`research.${String(key)}`) });
  const db = new Proxy({ research,
    challengerAdoption: new Proxy({}, { get: (_target, key) => mutation(`adoption.${String(key)}`) }),
    getMatchById: async () => {
      matchReads++;
      if (matchReads > 1 && options.changedAtFinalRead) return { ...row, date: '2026-10-31T20:00:00Z' };
      return row;
    },
    getMatches: async () => history,
  }, { get: (target, key) => key in target ? target[key] : mutation(`db.${String(key)}`) });
  const event = { matchId: 'provider-fixture', homeTeam: 'Home', awayTeam: 'Away', commenceTime: row.date,
    capturedAt: AT, bookmakers: [{ bookmakerKey: 'fixture', bookmakerName: 'Fixture Book', updatedAt: AT,
      markets: [{ marketKey: 'h2h', outcomes: [{ name: 'Home', price: 2 }, { name: 'Draw', price: 4 }, { name: 'Away', price: 4 }] }] }],
    ...options.event };
  const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
    pipelineHashV2: artifact.pipelineHashV2, mode: 'identity' });
  const deployment = { modelVersion: artifact.version, baselineVersion: artifact.baselineVersion,
    selectorPolicy: 'canonical-binary-v1', artifactHash: researchHash(artifact),
    probabilityConfigurationHash: options.legacyConfiguration ? null : configuration.hash };
  const runtime = new ResearchRuntime(db, { clock: () => new Date(now), nightly: policy,
    deploymentC: deployment, odds: { getOdds: async (...args) => {
      providerCalls.push(args);
      if (options.providerFailure) throw Object.assign(new Error('private authenticated transport URL'), { code: 'odds_credit_budget_exhausted' });
      return [event];
    } } });
  const job = { id: 'job', runId: 'cohort', matchId: row.match_id, kickoffAt: row.date, targetAt: AT, leaseToken: 'lease' };
  return { runtime, db, row, artifact, history, writes, reads, providerCalls, job };
}

for (const method of ['getPreviewModelC', 'getLatestPreviewBenchmarkC']) {
  test(`C preview retries only an interrupted ${method} read and preserves the forecast`, async (t) => {
    const expectedFixture = harness({ legacyConfiguration: true, withBenchmark: true });
    const expected = await expectedFixture.runtime.preparePreviewC(expectedFixture.job);
    const f = harness({ legacyConfiguration: true, withBenchmark: true });
    const read = f.db.research[method]; let attempts = 0;
    f.db.research[method] = async (...args) => {
      if (++attempts === 1) throw Object.assign(new Error('private transport URL must not be logged'), {
        cause: { cause: { code: 'UND_ERR_SOCKET' } },
      });
      return read(...args);
    };
    const logs = []; t.mock.method(console, 'warn', (value) => logs.push(value));
    const actual = await f.runtime.preparePreviewC(f.job);
    assert.equal(attempts, 2);
    assert.deepEqual(actual.decisions, expected.decisions);
    assert.deepEqual(actual.quotes, expected.quotes);
    assert.deepEqual(actual.inputSnapshot.forecast, expected.inputSnapshot.forecast);
    assert.equal(f.providerCalls.length, expectedFixture.providerCalls.length);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(logs.map(JSON.parse), [{ event: 'challenger_preview_read_retry',
      stage: method === 'getPreviewModelC' ? 'model' : 'benchmark', code: 'UND_ERR_SOCKET', attempt: 2 }]);
    assert.ok(!logs.join('').includes('private'));
  });
}

for (const failure of [Object.assign(new Error('private schema failure'), { code: 'SQLITE_ERROR' }),
  new Error('preview_model_identity_unavailable')]) {
  test(`C preview does not retry logical/model failures (${failure.code || 'identity guard'})`, async () => {
    const f = harness(); let attempts = 0;
    f.db.research.getPreviewModelC = async () => { attempts++; throw failure; };
    await assert.rejects(f.runtime.preparePreviewC(f.job), (error) => error === failure);
    assert.equal(attempts, 1); assert.ok(f.providerCalls.length <= 1); assert.deepEqual(f.writes, []);
  });
}

test('C preview transport retries stop after two read attempts without restarting preparation', async (t) => {
  const f = harness(); let attempts = 0;
  const failure = Object.assign(new Error('private transport URL'), { cause: { code: 'ECONNRESET' } });
  f.db.research.getPreviewModelC = async () => { attempts++; throw failure; };
  const logs = []; t.mock.method(console, 'warn', (value) => logs.push(value));
  await assert.rejects(f.runtime.preparePreviewC(f.job), (error) => error === failure);
  assert.equal(attempts, 2); assert.equal(logs.length, 1);
  assert.ok(f.providerCalls.length <= 1); assert.deepEqual(f.writes, []);
});

test('preview C exactly preserves the nightly C decision on identical inputs without any business writes', async () => {
  const preview = harness(), nightly = harness({ allowWrites: true });
  const before = JSON.stringify({ row: preview.row, model: preview.artifact });
  const actual = await preview.runtime.preparePreviewC(preview.job);
  const expected = await nightly.runtime.prepareNightly(nightly.job);
  assert.equal(actual.status, 'upcoming');
  assert.deepEqual(actual.decisions.map((decision) => decision.family), ['C']);
  assert.equal(actual.decisions[0].validated, true);
  assert.deepEqual(actual.decisions[0], expected.decisions.find((decision) => decision.family === 'C'));
  assert.deepEqual(actual.quotes, expected.quotes);
  assert.deepEqual(actual.inputSnapshot.forecast, expected.inputSnapshot.forecast);
  assert.equal(actual.inputSnapshot.mode, 'C_PREVIEW');
  assert.equal(actual.prospectiveObservations, undefined);
  assert.ok(expected.prospectiveObservations.length > 0);
  assert.deepEqual(preview.writes, []);
  assert.ok(preview.reads.every(([, family]) => family === 'C'));
  assert.equal(before, JSON.stringify({ row: preview.row, model: preview.artifact }));
  assert.ok(nightly.writes.some((write) => write.name === 'db.saveSchedulerRun'));
  assert.ok(nightly.writes.some((write) => write.name === 'adoption.listCollectingCandidates'));
});

test('preview requires an explicit pinned deployment and the nightly probability policy', async () => {
  const h = harness();
  const runtime = new ResearchRuntime(h.db, { odds: { getOdds: async () => [] } });
  await assert.rejects(runtime.preparePreviewC(h.job), /pinned deployment/);
  assert.deepEqual(h.writes, []);
});

test('C906-style configuration reads only the C benchmark and does not review or collect candidates', async () => {
  const h = harness({ legacyConfiguration: true });
  const result = await h.runtime.preparePreviewC(h.job);
  assert.equal(result.decisions[0].validated, true);
  assert.deepEqual(h.reads.filter(([kind]) => kind === 'benchmark').map(([, family]) => family), ['C']);
  assert.deepEqual(h.writes, []);
});

test('an invalid C artifact cannot trigger champion rollback, model health records or paired collection', async () => {
  const h = harness({ invalidArtifact: true, legacyConfiguration: true });
  const result = await h.runtime.preparePreviewC(h.job);
  assert.equal(result.decisions[0].validated, false);
  assert.equal(result.decisions[0].reason, 'hybrid_model_unavailable_or_incompatible');
  assert.deepEqual(h.writes, []);
});

test('a provider kickoff change is returned without updating fixtures or rescheduling jobs', async () => {
  const changedKickoff = '2026-10-31T20:00:00.000Z';
  const h = harness({ event: { commenceTime: changedKickoff } });
  const result = await h.runtime.preparePreviewC(h.job);
  assert.equal(result.kickoffAt, changedKickoff);
  assert.deepEqual(result.decisions, []);
  assert.equal(h.row.date, KICKOFF);
  assert.deepEqual(h.writes, []);
});

test('a fixture already started is rejected before requesting odds or historical inputs', async () => {
  const h = harness({ row: { date: AT } });
  const result = await h.runtime.preparePreviewC(h.job);
  assert.equal(result.status, 'started');
  assert.deepEqual(h.providerCalls, []);
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.writes, []);
});

test('preview rechecks the clock after inference and never returns a post-kickoff decision', async () => {
  const h = harness({ startDuringSamples: true });
  const result = await h.runtime.preparePreviewC(h.job);
  assert.equal(result.status, 'started');
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(h.writes, []);
});

test('a fixture changed during inference invalidates the preview without persisting the new kickoff', async () => {
  const h = harness({ changedAtFinalRead: true });
  const result = await h.runtime.preparePreviewC(h.job);
  assert.equal(result.kickoffAt, '2026-10-31T20:00:00Z');
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(h.writes, []);
});

test('provider errors remain errors and do not create health or retry records in the preview', async () => {
  const h = harness({ providerFailure: true });
  await assert.rejects(h.runtime.preparePreviewC(h.job), { code: 'odds_credit_budget_exhausted' });
  assert.deepEqual(h.writes, []);
});

test('preview and nightly provider caches remain segregated on a shared runtime instance', async () => {
  const h = harness({ allowWrites: true });
  await h.runtime.preparePreviewC(h.job);
  assert.equal(h.writes.length, 0);
  await h.runtime.prepareNightly(h.job);
  assert.equal(h.providerCalls.length, 2);
  assert.equal(h.writes.filter((write) => write.name === 'db.saveSchedulerRun').length, 3);
});

test('a valid old benchmark cannot make a future C artifact available to the preview', async () => {
  const h = harness({ legacyConfiguration: true, withBenchmark: true, artifactCreatedAt: '2026-11-01T00:00:00Z' });
  assert.ok(Date.parse(h.artifact.validationThrough) < Date.parse(AT));
  const result = await h.runtime.preparePreviewC(h.job);
  assert.equal(result.decisions[0].validated, false);
  assert.equal(result.decisions[0].reason, 'challenger_artifact_not_available_at_forecast');
  assert.deepEqual(h.writes, []);
});

for (const [name, options] of [
  ['future registration', { registryCreatedAt: '2026-11-01T00:00:00Z' }],
  ['missing registry creation metadata', { registryMetadataMissing: true }],
  ['registry creation timestamp without timezone', { registryCreatedAt: '2026-10-03T00:00:00' }],
]) test(`preview rejects ${name} even when calibration was already available`, async () => {
  const h = harness({ legacyConfiguration: true, withBenchmark: true, ...options });
  const result = await h.runtime.preparePreviewC(h.job);
  assert.equal(result.decisions[0].validated, false);
  assert.equal(result.decisions[0].reason, 'challenger_registration_not_available_at_forecast');
  assert.deepEqual(h.writes, []);
});

test('preview does not accept an artifact timestamp without an explicit timezone', async () => {
  const h = harness({ legacyConfiguration: true, withBenchmark: true, artifactCreatedAt: '2026-10-02T00:00:00' });
  const result = await h.runtime.preparePreviewC(h.job);
  assert.equal(result.decisions[0].validated, false);
  assert.equal(result.decisions[0].reason, 'challenger_artifact_not_available_at_forecast');
  assert.deepEqual(h.writes, []);
});

test('the new artifact and registration availability guard leaves the frozen nightly path unchanged', async () => {
  const h = harness({ allowWrites: true, legacyConfiguration: true, withBenchmark: true,
    artifactCreatedAt: '2026-11-01T00:00:00Z', registryCreatedAt: '2026-11-01T00:00:00Z' });
  const result = await h.runtime.prepareNightly(h.job);
  assert.equal(result.decisions.find((decision) => decision.family === 'C').validated, true);
});

test('projected C calibration exactly matches full benchmark decisions on identical history and as-of in every league', async () => {
  const { createClient } = require('@libsql/client');
  const { readFileSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const { randomUUID } = require('node:crypto');
  const { ResearchStore } = require('../dist/research/ResearchStore');
  // Store writes use their own connection; an anonymous memory DB would be lost after commit.
  const databasePath = join(tmpdir(), `c-preview-parity-${process.pid}-${randomUUID()}.db`);
  const client = createClient({ url: `file:${databasePath}` });
  const close = () => {
    client.close();
    try { rmSync(databasePath, { force: true }); }
    catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
  };
  try {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations/015_research_platform.sql'), 'utf8'));
    const store = new ResearchStore(client, async () => {}, { now: () => new Date(AT) });
    const profile = { protocol: 'existing-isotonic-v1', targetProtocol: 'joint_1x2_normalized-v2',
      nObservations: 600, matches: 200, fittedThrough: '2026-09-20T00:00:00Z',
      calibrationPoints: [{ x: 0, y: 0 }, { x: .5, y: .45 }, { x: 1, y: 1 }], byFamily: {}, learnedBlendWeights: {} };
    const report = { ...model(), probabilityCalibrationMode: 'isotonic_1x2', calibrationProfilesV2: { C: profile },
      diagnosticOnly: false, runtimeCompatible: true, predictions: Array(100).fill({ development: true }) };
    await store.saveBenchmark({ family: 'C', modelVersion: model().version, report });
    const leagues = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];
    for (const competition of leagues) {
      const projected = harness({ legacyConfiguration: true, row: { competition } });
      const full = harness({ legacyConfiguration: true, row: { competition } });
      const supplementary = leagues.filter((league) => league !== competition).flatMap((league, leagueIndex) =>
        projected.history.slice(0, 6).map((row, index) => ({ ...row, match_id: `${league}-${index}`, competition: league,
          home_team_id: `other-home-${leagueIndex}`, away_team_id: `other-away-${leagueIndex}` })));
      projected.history.push(...supplementary); full.history.push(...supplementary);
      projected.db.research.getLatestPreviewBenchmarkC = (version) => store.getLatestPreviewBenchmarkC(version);
      full.db.research.getLatestPreviewBenchmarkC = (version) => store.getLatestBenchmark('C', version);
      const actual = await projected.runtime.preparePreviewC(projected.job);
      const expected = await full.runtime.preparePreviewC(full.job);
      assert.equal(actual.decisions[0].validated, true, competition);
      assert.deepEqual(actual.decisions, expected.decisions, competition);
      assert.deepEqual(actual.inputSnapshot.forecast, expected.inputSnapshot.forecast, competition);
      assert.deepEqual(projected.writes, []); assert.deepEqual(full.writes, []);
    }
  } finally { close(); }
});
