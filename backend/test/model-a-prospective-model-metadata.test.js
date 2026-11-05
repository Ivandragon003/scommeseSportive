const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { PredictionService } = require('../dist/services/PredictionService');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
const { modelAInputSnapshotHash } = require('../dist/research/ModelAProspectiveInputs');
const { stopModelAProspectiveRecovery, drainModelAProspective } = require('../dist/research/ModelAProspectiveRecorder');

const previous = { ...process.env };
const keys = ['MODEL_A_PROSPECTIVE_ENABLED', 'MODEL_A_PROSPECTIVE_STORAGE', 'PLAYER_DATA_ENABLED', 'PLAYER_AVAILABILITY_ENABLED'];
process.env.MODEL_A_PROSPECTIVE_STORAGE = 'database';
process.env.PLAYER_DATA_ENABLED = 'false'; process.env.PLAYER_AVAILABILITY_ENABLED = 'false';
after(async () => {
  stopModelAProspectiveRecovery(); await drainModelAProspective(2000);
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});

function setup(saved) {
  const records = [], reads = { model: 0 };
  const now = Date.now();
  const match = { match_id: 'metadata-test', home_team_id: 'home', away_team_id: 'away', competition: 'Test', season: '2026/27',
    date: new Date(now + 6 * 3600000).toISOString(), home_goals: null, away_goals: null };
  const db = {
    getLatestModelParams: async () => { reads.model++; return saved; },
    getTeamsByIds: async ids => ids.map(team_id => ({ team_id, name: team_id, competition: 'Test' })),
    getMatchById: async () => match, getTeamHistoricalCoverageBatch: async () => ({}), getTeamScheduleInsightsBatch: async () => ({}),
    appendModelAProspectiveForecast: async record => { records.push(JSON.parse(record.payload)); },
  };
  const service = new PredictionService(db, { getMatchDetails: async () => assert.fail('unexpected provider request') });
  service.applyAdaptiveTuning = async () => null;
  service.getCalibrationProfile = async () => ({ calibrationPoints: [], nObservations: 0, byFamily: {}, learnedBlendWeights: {} });
  const request = { homeTeamId: 'home', awayTeamId: 'away', matchId: match.match_id, competition: 'Test', season: '2026/27' };
  async function predict(asOf = new Date(now - 2000).toISOString()) {
    let receipt;
    const output = await service.predict(request, { asOf, recordAudit: false, onProspectiveRecord: value => { receipt = value; } });
    if (receipt) assert.equal((await receipt.completion).status, 'stored');
    return output;
  }
  return { service, db, reads, records, predict, now };
}

function savedModel(fittedAt) {
  const params = { ...new DixonColesModel().getParams(), attackParams: { home: 0.4, away: -0.4 }, defenceParams: { home: 0, away: 0 },
    poissonXg: { leagueXG: 1.2, homeAdv: 1.1, levelScale: 1, attackRate: { home: 1.1, away: 0.9 }, defRate: { home: 1, away: 1 } } };
  return { id: 42, fitted_at: fittedAt, params };
}

test('prediction preserves loaded model metadata across caches with no extra reads or changed outputs', async t => {
  const random = Math.random; Math.random = () => 0.5; t.after(() => { Math.random = random; });
  const fittedAt = new Date(Date.now() - 1000).toISOString();
  const saved = savedModel(fittedAt);
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true';
  const observed = setup(saved), before = JSON.stringify(saved);
  const asOf = new Date(observed.now - 2000).toISOString();
  const first = await observed.predict(asOf);
  const second = await observed.predict(asOf);
  assert.equal(observed.reads.model, 1);
  assert.equal(JSON.stringify(saved), before);
  for (const payload of observed.records) {
    const snapshot = payload.provenance.snapshot;
    assert.equal(snapshot.values.contextual.dcModelSource.id, 42);
    assert.equal(snapshot.values.contextual.dcModelSource.sourceParametersHash, modelAInputSnapshotHash(saved.params));
    assert.equal(snapshot.values.ensemble.poissonModelSource.id, 42);
    assert.ok(snapshot.sourceEvidence.contextual.dcModelSource.flags.includes('fitted_after_input_as_of'));
    assert.equal(payload.provenance.inputAvailableThrough, null);
    assert.equal(payload.provenance.rigorousEligible, false);
  }
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'false';
  const unobserved = setup(saved), off = await unobserved.predict(asOf);
  assert.deepEqual(first.probabilities, off.probabilities);
  assert.deepEqual(second.canonicalRecommendation, off.canonicalRecommendation);
  assert.deepEqual(first.bestBetDecision, off.bestBetDecision);
});

test('enabling observation after load leaves source metadata unknown without rereading the database', async () => {
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'false';
  const fixture = setup(savedModel('2026-01-01 00:00:00'));
  const model = await fixture.service.getModel('Test');
  assert.equal(fixture.service.modelParameterSources.has(model), false);
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true';
  await fixture.predict();
  assert.equal(fixture.reads.model, 1);
  const values = fixture.records[0].provenance.snapshot.values;
  assert.equal(values.contextual.dcModelSource.origin, 'not_observed');
  assert.equal(values.contextual.dcModelSource.id, null);
  assert.equal(values.contextual.dcModelSource.fitted_at, null);
  assert.equal(values.ensemble.poissonModelSource.sourceParametersHash, null);
});

test('independently loaded Poisson parameters retain only the record actually read', async () => {
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true';
  const saved = savedModel('2026-01-01 00:00:00'), fixture = setup(saved);
  const poisson = await fixture.service.ensurePoissonModel('Test');
  assert.equal(await fixture.service.ensurePoissonModel('Test'), poisson);
  assert.equal(fixture.reads.model, 1);
  const metadata = fixture.service.modelParameterSources.get(poisson);
  assert.equal(metadata.origin, 'database_record');
  assert.equal(metadata.id, saved.id);
  assert.equal(metadata.sourceParametersHash, modelAInputSnapshotHash(saved.params));
});

test('default coefficients are explicitly distinct from a loaded fit record', async () => {
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true';
  const fixture = setup(null), model = await fixture.service.getModel('Test');
  const metadata = fixture.service.modelParameterSources.get(model);
  assert.equal(metadata.origin, 'default_parameters');
  assert.equal(metadata.id, null); assert.equal(metadata.fitted_at, null);
  assert.equal(metadata.sourceParametersHash, null);
  assert.equal(await fixture.service.ensurePoissonModel('Test'), null);
  assert.equal(fixture.reads.model, 1);
});

test('in-process fit metadata fingerprints actual training arguments without changing the fit', async t => {
  const OriginalDate = Date, fixedNow = Date.now();
  global.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  t.after(() => { global.Date = OriginalDate; });
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true';
  const fixture = setup(null);
  const matches = Array.from({ length: 20 }, (_, i) => ({ match_id: `fit-${i}`, home_team_id: i % 2 ? 'away' : 'home',
    away_team_id: i % 2 ? 'home' : 'away', date: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
    home_goals: i % 3, away_goals: i % 2, home_xg: 1.2, away_xg: 1, competition: 'Test', season: '2026/27' }));
  matches[0].date = new Date(fixedNow + 86400000).toISOString();
  const initialRows = JSON.stringify(matches);
  let persisted;
  fixture.db.getMatches = async () => matches;
  fixture.db.updateTeamModelStrengthsBatch = async () => {};
  fixture.db.saveModelParams = async (_competition, _season, parameters) => { persisted = parameters; };
  await fixture.service.fitModelForCompetition('Test', '2026/27', undefined, undefined, { recomputeTeamAverages: false });
  const model = await fixture.service.getModel('Test');
  const metadata = fixture.service.modelParameterSources.get(model);
  assert.equal(metadata.origin, 'in_memory_fit');
  assert.equal(metadata.sourceParametersHash, modelAInputSnapshotHash(persisted));
  assert.equal(metadata.id, null); assert.equal(metadata.fitted_at, null);
  assert.ok(Number.isFinite(Date.parse(metadata.localFitCompletedAt)));
  const actualArguments = matches.map(row => ({ matchId: row.match_id, homeTeamId: row.home_team_id, awayTeamId: row.away_team_id,
    date: new Date(row.date), homeGoals: row.home_goals, awayGoals: row.away_goals, homeXG: row.home_xg, awayXG: row.away_xg,
    competition: row.competition, season: row.season }));
  assert.equal(metadata.trainingInputs.inputHash, modelAInputSnapshotHash(actualArguments));
  assert.equal(metadata.trainingInputs.inputCount, 20);
  assert.equal(metadata.trainingInputs.futureKickoffCount, 1);
  assert.equal(metadata.trainingInputs.maximumKickoffAt, matches[0].date);
  assert.equal(JSON.stringify(matches), initialRows);
  assert.equal(fixture.service.modelParameterSources.get(await fixture.service.ensurePoissonModel('Test')), metadata);
  assert.equal(fixture.reads.model, 0);
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'false';
  const baseline = setup(null);
  let baselineParameters;
  baseline.db.getMatches = async () => matches;
  baseline.db.updateTeamModelStrengthsBatch = async () => {};
  baseline.db.saveModelParams = async (_competition, _season, parameters) => { baselineParameters = parameters; };
  await baseline.service.fitModelForCompetition('Test', '2026/27', undefined, undefined, { recomputeTeamAverages: false });
  assert.deepEqual(persisted, baselineParameters);
  assert.equal(baseline.service.modelParameterSources.has(await baseline.service.getModel('Test')), false);
});
