const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, mkdtempSync, rmSync, rmdirSync } = require('node:fs');
const { join, resolve, basename, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const compiled = process.env.RESEARCH_TEST_DIST || '../dist';
const moduleOf = file => require(resolve(__dirname, compiled, 'research', file));
const { ChallengerAdoptionStore, buildChallengerAdoptionReport, INITIAL_CHALLENGER_DEPLOYMENT } = moduleOf('ChallengerAdoption');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = moduleOf('ForecastCore');
const { COHERENT_PROBABILITY_PROTOCOL, coherentProbabilityPipelineHash } = moduleOf('CoherentProbabilityPipeline');
const { researchHash } = moduleOf('ResearchStore');
const { prospectivePartition } = moduleOf('ResearchProspectiveEvidence');
const { ORIGINAL_HOLDOUT_POLICY } = moduleOf('ResearchHoldoutPolicy');
const { scoreMatrixMarkets } = moduleOf('GoalSettlement');
const constant = value => ({ features_info: { float_features: [] }, oblivious_trees: [], scale_and_bias: [1, [value]] });
const artifact = version => ({ family: 'C', version, baselineVersion: baselineManifest().version,
  featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION, datasetHash: 'development-dataset',
  trainedThrough: '2026-10-27T11:00:00.000Z', validationThrough: '2026-10-28T10:00:00.000Z',
  createdAt: '2026-10-28T11:00:00.000Z', candidateKind: 'intensity_correction', weight: .5, temperature: 1,
  models: { home: constant(.1), away: constant(-.1) }, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
  pipelineHashV2: coherentProbabilityPipelineHash(), probabilityCalibrationMode: 'identity' });

function temporaryClient() {
  const directory = mkdtempSync(join(process.env.CHALLENGER_ADOPTION_TEST_DIRECTORY || tmpdir(), 'challenger-adoption-'));
  const path = join(directory, 'test.db'), client = createClient({ url: `file:${path}` });
  return { client, close: async () => {
    client.close();
    if (process.env.CHALLENGER_ADOPTION_TEST_DIRECTORY) return;
    for (let attempt = 0; ; attempt++) {
      try {
        for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true });
        rmdirSync(directory); return;
      } catch (error) {
        if (attempt >= 5) throw error;
        await new Promise(done => setTimeout(done, 50 * (attempt + 1)));
      }
    }
  } };
}
async function setup() {
  const { client, close } = temporaryClient();
  for (const migration of ['015_research_platform.sql', '025_challenger_adoption.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
  }
  await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,competition TEXT,home_goals INTEGER,away_goals INTEGER,source TEXT)');
  await client.execute('CREATE TABLE scheduler_runs(scheduler_name TEXT,started_at TEXT,success INTEGER,summary_json TEXT)');
  let now = new Date('2026-11-01T02:07:00.000Z');
  const initial = { ...INITIAL_CHALLENGER_DEPLOYMENT, modelVersion: 'C-reference', baselineVersion: baselineManifest().version };
  const store = new ChallengerAdoptionStore(client, async () => {}, { clock: () => now, fallback: initial });
  for (const version of ['C-reference', 'C-candidate']) {
    const value = artifact(version);
    await client.execute({ sql: 'INSERT INTO research_models(family,version,artifact_json,artifact_hash,created_at) VALUES (?,?,?,?,?)',
      args: ['C', version, JSON.stringify(value), researchHash(value), '2026-10-28T11:00:00.000Z'] });
  }
  const dossier = await store.registerCandidate({ modelVersion: 'C-candidate', selectorPolicy: 'payout-aware-v1',
    trainingEvidence: { datasetHash: 'development-dataset', matchIds: ['development-1', 'development-2'] } });
  const input = { matchId: 'future-match', competition: 'Serie A', kickoffAt: '2026-11-01T19:00:00.000Z',
    forecastAt: now.toISOString(), featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
    features: FEATURE_NAMES.map(() => 0), baselineMatrix: [[.2, .2], [.4, .2]],
    baselineProbabilities: scoreMatrixMarkets([[.2, .2], [.4, .2]]), baselineVersion: baselineManifest().version,
    lambdaHome: 1.4, lambdaAway: 1, trainingCount: 50, modelFitAt: '2026-10-31T02:00:00.000Z', maxTrainingAvailableAt: '2026-10-31T01:00:00.000Z' };
  await client.execute({ sql: 'INSERT INTO matches(match_id,date,competition,source) VALUES (?,?,?,?)',
    args: [input.matchId, input.kickoffAt, input.competition, 'understat'] });
  return { client, close, store, dossier, input, initial, setTime: value => { now = new Date(value); } };
}

// The Windows native driver can retain statement handles until process exit.
// Keep fixture cleanup in the owning parent after all child handles are gone.
if (process.platform === 'win32' && !process.env.CHALLENGER_ADOPTION_TEST_DIRECTORY) {
  test('C adoption: six isolated SQLite cases and deterministic cleanup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'challenger-adoption-suite-'));
    try {
      const environment = { ...process.env, CHALLENGER_ADOPTION_TEST_DIRECTORY: directory };
      delete environment.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', __filename], { cwd: process.cwd(), encoding: 'utf8',
        env: environment, timeout: 120000 });
      process.stdout.write(child.stdout || '');
      process.stderr.write(child.stderr || '');
      assert.equal(child.status, 0, child.error?.message || 'SQLite child cases failed');
      assert.match(child.stdout, /# tests 6\b/);
      assert.match(child.stdout, /# fail 0\b/);
    } finally {
      const target = resolve(directory), root = resolve(tmpdir());
      assert.ok(target.startsWith(`${root}${sep}`) && basename(target).startsWith('challenger-adoption-suite-'));
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
} else {
test('old schemas keep C906 binary fallback and cannot collect or adopt', async () => {
  const { client, close } = temporaryClient();
  try {
    const store = new ChallengerAdoptionStore(client);
    assert.deepEqual((await store.getState()).deployment, INITIAL_CHALLENGER_DEPLOYMENT);
    assert.deepEqual(await store.listCollectingCandidates(), []);
    assert.equal((await store.recordPairedChallengerForecast({})).recorded, false);
    assert.equal((await store.assessAndAdopt({ candidateId: 'none' })).adopted, false);
  } finally { await close(); }
});

test('C dossier pins artifact, probability configuration, selector and incumbent without changing A or champion', async () => {
  const f = await setup();
  try {
    assert.equal(f.dossier.candidate.selectorPolicy, 'payout-aware-v1');
    assert.equal(f.dossier.reference.selectorPolicy, 'canonical-binary-v1');
    assert.match(f.dossier.candidate.probabilityConfigurationHash, /^[a-f0-9]{64}$/);
    assert.equal((await f.store.getState()).deployment.modelVersion, 'C-reference');
    assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM research_champions')).rows[0].n, 0);
    assert.equal((await f.client.execute("SELECT COUNT(*) AS n FROM research_models WHERE family='A'")).rows[0].n, 0);
    await assert.rejects(f.client.execute("UPDATE challenger_candidates SET registered_at='2099-01-01'"), /immutable/);
    await assert.rejects(f.store.registerCandidate({ modelVersion: 'C-candidate', selectorPolicy: 'payout-aware-v1',
      trainingEvidence: { datasetHash: 'development-dataset', matchIds: [ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds[0]] } }), /independent_training/);
    const changedReference = { probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2: coherentProbabilityPipelineHash(),
      probabilityCalibrationMode: 'temperature', probabilityTemperature: .8 };
    await f.client.execute({ sql: `INSERT INTO research_benchmarks(id,family,model_version,report_json,report_hash,validated,created_at)
      VALUES (?,'C',?,?,?,?,?)`, args: ['reference-drift', 'C-reference', JSON.stringify(changedReference), researchHash(changedReference), 0, '2026-11-01T02:07:00.000Z'] });
    await assert.rejects(f.store.listCollectingCandidates(), /reference_configuration_drift/);
    await assert.rejects(f.store.recordPairedChallengerForecast({ candidateId: f.dossier.id, input: f.input, quotes: [] }), /reference_configuration_drift/);
    assert.equal((await f.store.getState()).deployment.modelVersion, 'C-reference');
  } finally { await f.close(); }
});

test('paired forecasts are actually frozen pre-kickoff, preserve both C matrices and reject backfills or repeat captures', async () => {
  const f = await setup();
  try {
    const request = { candidateId: f.dossier.id, input: f.input, quotes: [] };
    assert.equal((await f.store.recordPairedChallengerForecast(request)).recorded, true);
    assert.equal((await f.store.recordPairedChallengerForecast(request)).reason, 'already_frozen');
    const row = (await f.client.execute('SELECT * FROM challenger_paired_forecasts')).rows[0];
    const snapshot = JSON.parse(row.snapshot_json);
    assert.equal(row.frozen_at, f.input.forecastAt);
    assert.ok(snapshot.candidateMatrix.length); assert.ok(snapshot.referenceMatrix.length);
    assert.equal(row.partition, prospectivePartition(f.input.matchId));
    f.setTime('2026-11-01T20:00:00.000Z');
    assert.equal((await f.store.recordPairedChallengerForecast(request)).reason, 'forecast_not_genuinely_preoutcome');
    await assert.rejects(f.client.execute('DELETE FROM challenger_paired_forecasts'), /immutable/);
    assert.equal((await f.store.assessAndAdopt({ candidateId: f.dossier.id })).adopted, false);
  } finally { await f.close(); }
});

test('protected finals and already observed outcomes cannot be registered as new prospective forecasts', async () => {
  const f = await setup();
  try {
    const protectedInput = { ...f.input, matchId: ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds[0] };
    assert.equal((await f.store.recordPairedChallengerForecast({ candidateId: f.dossier.id, input: protectedInput, quotes: [] })).reason, 'protected_or_unsupported_fixture');
    await f.client.execute("UPDATE matches SET home_goals=1,away_goals=0");
    assert.equal((await f.store.recordPairedChallengerForecast({ candidateId: f.dossier.id, input: f.input, quotes: [] })).reason, 'fixture_not_future');
  } finally { await f.close(); }
});

const futureEvidence = (dossier, count = 500) => {
  const candidateMatrix = [[.01, .01], [.97, .01]], referenceMatrix = [[.05, .8], [.1, .05]];
  const identities = [];
  for (let index = 0; identities.length < count; index++) if (prospectivePartition(`independent-${index}`) === 'FUTURE_TEST') identities.push(`independent-${index}`);
  return identities.map((matchId, index) => {
    const forecastAt = new Date(Date.UTC(2026, 10, index + 2, 2, 7)).toISOString();
    const kickoffAt = new Date(Date.parse(forecastAt) + 12 * 3600000).toISOString();
    return { matchId, competition: ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'][index % 5],
      forecastAt, frozenAt: forecastAt, kickoffAt, partition: 'FUTURE_TEST',
      snapshot: { candidate: dossier.candidate, reference: dossier.reference, candidateMatrix, referenceMatrix,
        candidateProbabilities: scoreMatrixMarkets(candidateMatrix), referenceProbabilities: scoreMatrixMarkets(referenceMatrix) },
      result: { homeGoals: 1, awayGoals: 0, availableAt: new Date(Date.parse(kickoffAt) + 2 * 3600000).toISOString(), source: 'understat' } };
  });
};
test('adoption report requires sufficient genuinely future paired improvement and cannot score calibration or protected fixtures', async () => {
  const f = await setup();
  try {
    const at = new Date('2029-01-01T00:00:00Z'), evidence = futureEvidence(f.dossier);
    const valid = buildChallengerAdoptionReport(f.dossier, evidence, at);
    assert.equal(valid.validation.passed, true); assert.equal(valid.validation.nPaired, 500);
    assert.ok(valid.metrics.paired.weekLogLossCI[1] < 0);
    assert.equal(buildChallengerAdoptionReport(f.dossier, evidence.slice(0, 20), at).validation.passed, false);
    const calibration = evidence.map(row => ({ ...row, partition: 'CALIBRATION' }));
    assert.equal(buildChallengerAdoptionReport(f.dossier, calibration, at).validation.nPaired, 0);
    const contaminated = [{ ...evidence[0], matchId: ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds[0] }, ...evidence.slice(1)];
    assert.equal(buildChallengerAdoptionReport(f.dossier, contaminated, at).validation.passed, false);
    const retrospective = evidence.map(row => ({ ...row, frozenAt: row.result.availableAt }));
    assert.equal(buildChallengerAdoptionReport(f.dossier, retrospective, at).validation.passed, false);
    const tooShort = evidence.map((row, index) => {
      const forecastAt = new Date(Date.UTC(2026, 10, 2, 2, 7 + index)).toISOString();
      const kickoffAt = new Date(Date.parse(forecastAt) + 12 * 3600000).toISOString();
      return { ...row, forecastAt, kickoffAt, frozenAt: forecastAt,
        result: { ...row.result, availableAt: new Date(Date.parse(kickoffAt) + 2 * 3600000).toISOString() } };
    });
    const shortReport = buildChallengerAdoptionReport(f.dossier, tooShort, at);
    assert.equal(shortReport.validation.monthCount, 1);
    assert.equal(shortReport.validation.passed, false);
  } finally { await f.close(); }
});

test('a successful C-only adoption is revisioned, idempotent and can roll back to the initial unpromoted deployment', async () => {
  const f = await setup();
  try {
    const evidence = futureEvidence(f.dossier);
    const statements = evidence.flatMap((row, index) => [
      { sql: 'INSERT INTO matches(match_id,date,competition,home_goals,away_goals,source) VALUES (?,?,?,?,?,?)',
        args: [row.matchId, row.kickoffAt, row.competition, 1, 0, 'understat'] },
      { sql: `INSERT INTO challenger_paired_forecasts(id,candidate_id,match_id,competition,forecast_at,kickoff_at,frozen_at,partition,snapshot_json,snapshot_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, args: [`frozen-${index}`, f.dossier.id, row.matchId, row.competition, row.forecastAt,
        row.kickoffAt, row.frozenAt, row.partition, JSON.stringify(row.snapshot), researchHash(row.snapshot)] },
    ]);
    await f.client.batch(statements, 'write');
    f.setTime('2029-01-01T00:00:00.000Z');
    const adopted = await f.store.assessAndAdopt({ candidateId: f.dossier.id, expectedRevision: 'initial' });
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.state.deployment.modelVersion, 'C-candidate');
    assert.equal(adopted.state.deployment.selectorPolicy, 'payout-aware-v1');
    assert.equal((await f.store.assessAndAdopt({ candidateId: f.dossier.id, expectedRevision: 'initial' })).reason, 'incumbent_changed');
    assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM challenger_adoption_events')).rows[0].n, 1);
    const deployment = adopted.state.deployment;
    // Generic execution wrappers have no mathematical checks and cannot hide
    // the underlying failed model probe for the same fixture and snapshot.
    for (let index = 0; index < 3; index++) {
      await f.client.execute({ sql: 'INSERT INTO scheduler_runs(scheduler_name,started_at,success,summary_json) VALUES (?,?,?,?)',
        args: ['research_model_check', `2029-01-02T00:0${index}:30.000Z`, 0, JSON.stringify({ family: 'C',
          modelVersion: deployment.modelVersion, selectorPolicy: deployment.selectorPolicy,
          probabilityConfigurationHash: deployment.probabilityConfigurationHash, matchId: `health-${index}`, snapshotHash: `snapshot-${index}`,
          checks: { inference: true } })] });
    }
    f.setTime('2029-01-02T00:04:00.000Z');
    assert.equal((await f.store.rollbackUnhealthy()).rolledBack, false);
    for (let index = 0; index < 3; index++) {
      await f.client.execute({ sql: 'INSERT INTO scheduler_runs(scheduler_name,started_at,success,summary_json) VALUES (?,?,?,?)',
        args: ['research_model_check', `2029-01-02T00:0${index}:00.000Z`, 0, JSON.stringify({ family: 'C',
          modelVersion: deployment.modelVersion, selectorPolicy: deployment.selectorPolicy,
          probabilityConfigurationHash: deployment.probabilityConfigurationHash, matchId: `health-${index}`, snapshotHash: `snapshot-${index}`,
          checks: { inference: false, calibrationCompatible: false, finiteProbabilities: false, coherentProbabilities: false } })] });
    }
    f.setTime('2029-01-02T00:04:00.000Z');
    const rollback = await f.store.rollbackUnhealthy();
    assert.equal(rollback.rolledBack, true);
    assert.deepEqual(rollback.state.deployment, f.dossier.reference);
    assert.equal((await f.store.rollbackUnhealthy()).rolledBack, false);
    assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM research_champions')).rows[0].n, 0);
    assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM research_bets')).rows[0].n, 0);
    assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM research_ledger')).rows[0].n, 0);
  } finally { await f.close(); }
});
}
