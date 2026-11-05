'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { join, resolve, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { readFileSync, rmSync } = require('node:fs');
const { DatabaseService } = require('../dist/db/DatabaseService');
const { UnderstatScraper } = require('../dist/services/UnderstatScraper');
const { syncFootballData, createLibsqlFootballDataDb } = require('../dist/services/FootballDataService');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
const { PredictionService } = require('../dist/services/PredictionService');
const { OddsApiProvider } = require('../dist/services/odds-provider/OddsApiProvider');
const { AppPredictionOddsService } = require('../dist/services/AppPredictionOddsService');
const { predictHybrid } = require('../dist/research/CatBoostModel');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = require('../dist/research/ForecastCore');
const { ResearchRuntime, settleResearchBets } = require('../dist/research/ResearchRuntime');
const { ResearchRecommendationRuntime } = require('../dist/research/ResearchRecommendationRuntime');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');
const { challengerExecutionPolicy } = require('../dist/research/ResearchRecommendationPolicy');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { OddsApiService } = require('../dist/services/OddsApiService');
const { SmartOddsRequestStore } = require('../dist/services/odds-provider/SmartOddsRequestStore');
const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../dist/research/CoherentProbabilityPipeline');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');

const AT = '2026-10-27T12:00:00.000Z', KICKOFF = '2026-10-27T19:00:00.000Z';
const csv = ['Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,HST,AST,HY,AY,HR,AR', 'I1,01/08/2026,Alpha,Beta,1,0,10,8,5,3,2,1,0,0'].join('\n');
const prior = { id: '100', datetime: '2026-08-01 20:00:00', h: { id: '10', title: 'Alpha' }, a: { id: '20', title: 'Beta' }, goals: { h: '1', a: '0' }, xG: { h: '1.5', a: '0.7' } };
const upcoming = { ...prior, id: '101', datetime: '2026-10-27 19:00:00', goals: { h: null, a: null }, xG: { h: null, a: null } };

test('isolated pipeline with synthetic transport and selectable C artifact', async (t) => {
  const previous = { TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL, TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN, PLAYER_DATA_ENABLED: process.env.PLAYER_DATA_ENABLED };
  const dbPath = join(tmpdir(), `automatic-pipeline-${randomUUID()}.db`);
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`; process.env.TURSO_AUTH_TOKEN = 'synthetic-local-only'; process.env.PLAYER_DATA_ENABLED = 'false';
  const db = new DatabaseService();
  try {
    await db.getMatches();
    await db.upsertTeam({ teamId: '10', name: 'Alpha', competition: 'Serie A' });
    await db.upsertTeam({ teamId: '20', name: 'Beta', competition: 'Serie A' });
    const history = Array.from({ length: 45 }, (_, i) => ({ ...prior, id: String(200 + i), datetime: new Date(Date.parse('2026-10-20T20:00:00Z') - i * 86400000).toISOString().slice(0, 19).replace('T', ' '), goals: { h: '2', a: '0' }, xG: { h: '2.4', a: '0.5' } }));
    const scraper = new UnderstatScraper();
    scraper.client.get = async path => { assert.equal(path, '/getLeagueData/serie_a/2026'); return { data: { dates: [prior, upcoming, ...history] } }; };
    const acquired = await scraper.scrapeSeason('Serie A', '2026/2027');
    assert.equal(acquired.length, 47); await db.upsertMatches(acquired.map(match => scraper.toDbFormat(match)));
    assert.equal((await db.getMatchById('understat_100')).home_shots, null);
    const imported = await syncFootballData(createLibsqlFootballDataDb(db.db), { competitions: ['Serie A'], seasonStartYears: [2026], fetcher: async () => csv, now: new Date(AT) });
    assert.equal(imported.updated, 1); assert.equal((await db.getMatchById('understat_100')).home_shots, 10);
    assert.equal((await syncFootballData(createLibsqlFootballDataDb(db.db), { competitions: ['Serie A'], seasonStartYears: [2026], fetcher: async () => csv, now: new Date(AT) })).updated, 0);
    await db.recomputeTeamAveragesBatch(['10', '20']);
    assert.equal((await db.getTeam('10')).avg_home_shots, 10);
    const params = new DixonColesModel().getParams(); params.attackParams = { '10': .4, '20': -.4 }; params.defenceParams = { '10': 0, '20': 0 };
    await db.saveModelParams('Serie A', '2026/2027', params, 0);
    const payload = [{ id: 'synthetic-event', home_team: 'Alpha', away_team: 'Beta', commence_time: KICKOFF, bookmakers: [{ key: 'fixture-only', title: 'Synthetic fixture bookmaker', last_update: AT, markets: [{ key: 'h2h', last_update: AT, outcomes: [{ name: 'Alpha', price: 3.6 }, { name: 'Draw', price: 3.9 }, { name: 'Beta', price: 2.1 }] }] }] }];
    let http = 0, charged = 0;
    const managed = new SmartOddsRequestStore(db.db, async () => {}, { clock: () => new Date(AT), monthlyLimit: 20, reserveCredits: 0 });
    // Only the HTTP callback is synthetic; budget, cache and reservations are real.
    const store = { execute: async request => managed.execute(request, async () => {
      http++; charged += request.expectedCredits;
      assert.ok(request.endpoint.includes('/odds'));
      return { data: payload, headers: { 'x-requests-used': String(charged), 'x-requests-remaining': String(20 - charged), 'x-requests-last': String(request.expectedCredits) } };
    }) };
    const provider = new OddsApiProvider('fixture-only-token', { store, allowNetwork: true });
    const appOdds = new AppPredictionOddsService(db, { provider, clock: () => new Date(AT) });
    const fixture = await db.getMatchById('understat_101');
    const odds = await appOdds.load(fixture);
    assert.ok(http >= 1); assert.ok(odds.quotes.some(q => q.selection === 'homeWin' && q.bookmaker === 'Synthetic fixture bookmaker'));
    const sent = http, beforeQuota = await managed.overview();
    await appOdds.load(fixture);
    assert.equal(http, sent, 'identical request must reuse persistent cache');
    assert.equal((await managed.overview()).providers[0].chargedCredits, beforeQuota.providers[0].chargedCredits);
    await assert.rejects(managed.execute({ provider: 'odds_api', accountScope: 'fixture-hard-budget', endpoint: '/oversized', operation: 'fixture', markets: ['h2h'], regions: ['eu'], requestKey: 'oversized-request', expectedCredits: 21, priority: 'essential', cacheMaxAgeMs: 0, allowNetwork: true }, async () => { throw Error('must not dispatch'); }), { code: 'odds_credit_budget_exhausted' });
    assert.equal(http, sent);
    const predictor = new PredictionService(db, { getMatchDetails: async () => { throw Error('unexpected external read'); } });
    // No fitting or cache writes: explicitly injected fixed synthetic identity calibration.
    predictor.applyAdaptiveTuning = async () => null;
    predictor.getCalibrationProfile = async () => ({ calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }], nObservations: 0, byFamily: {}, learnedBlendWeights: {} });
    const prediction = await predictor.predict({ homeTeamId: '10', awayTeamId: '20', matchId: 'understat_101', competition: 'Serie A', season: '2026/2027' }, { asOf: AT, recordAudit: false, sharedOdds: odds.sharedOdds });
    assert.ok(prediction.canonicalRecommendation.probabilities.raw.homeWin > 0);
    assert.equal(prediction.canonicalRecommendation.odds.source, 'odds_api');
    assert.equal(prediction.canonicalRecommendation.odds.bookmakerBySelection.homeWin, 'Synthetic fixture bookmaker');
    assert.ok(!Object.keys(prediction.canonicalRecommendation.probabilities.raw).some(key => /^shots/i.test(key)), 'one observed match must not qualify count markets');
    const baseline = { featureSchema: FEATURE_SCHEMA_VERSION, featureNames: FEATURE_NAMES, features: FEATURE_NAMES.map(() => 0), baselineMatrix: [[.2,.1,.05],[.15,.15,.05],[.15,.1,.05]], baselineVersion: baselineManifest().version, lambdaHome: 1.3, lambdaAway: .8, forecastAt: AT };
    const fixed = value => ({ features_info: { float_features: [] }, oblivious_trees: [], scale_and_bias: [1, [value]] });
    const syntheticArtifact = { family: 'C', version: 'C-synthetic-only', featureSchema: FEATURE_SCHEMA_VERSION, featureNames: FEATURE_NAMES, baselineVersion: baseline.baselineVersion, trainedThrough: '2026-01-01T00:00:00Z', validationThrough: '2026-01-02T00:00:00Z', createdAt: '2026-01-03T00:00:00Z', candidateKind: 'intensity_correction', weight: .5, temperature: 1, models: { home: fixed(.3), away: fixed(-.2) } };
    let artifact = syntheticArtifact;
    if (process.env.FP_REAL_C_ARTIFACT) {
      artifact = JSON.parse(readFileSync(process.env.FP_REAL_C_ARTIFACT, 'utf8'));
      assert.equal(artifact.version, 'C-906371b0b3a1e2c8');
      assert.equal(researchHash(artifact), '3f18e05ee228d1c6fdbe92865b3b19635cdf68f3ecbd50ff53d83914b52993b3');
    } else {
      artifact.probabilityProtocol = COHERENT_PROBABILITY_PROTOCOL;
      artifact.pipelineHashV2 = coherentProbabilityPipelineHash();
      artifact.probabilityCalibrationMode = 'identity';
    }
    const c = predictHybrid(baseline, artifact);
    assert.ok(Math.abs(c.matrix.flat().reduce((a,b) => a+b,0) - 1) < 1e-12); assert.ok(c.probabilities.homeWin > 0);
    // Normal ResearchRuntime computes frozen baseline in RAM on synthetic past matches; it does not train C.
    const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion, pipelineHashV2: artifact.pipelineHashV2, mode: artifact.probabilityCalibrationMode, profile: artifact.calibrationProfilesV2?.C });
    const deployment = { modelVersion: artifact.version, baselineVersion: artifact.baselineVersion, selectorPolicy: 'payout-aware-v1', artifactHash: researchHash(artifact), probabilityConfigurationHash: configuration.hash };
    let now = Date.parse(AT);
    db.research = new ResearchStore(db.db, async () => {}, { now: () => new Date(now) });
    await db.research.saveModel({ family: 'C', version: artifact.version, artifact });
    await db.research.setMarketState({ family: 'C', modelVersion: artifact.version, market: '1x2', state: 'EXPERIMENTAL' });
    const api = new OddsApiService('fixture-only-token', { store });
    const runtime = new ResearchRuntime(db, { clock: () => new Date(AT), odds: api, nightly: { quoteMaxAgeMs: 300000, minEv: .04, minPrudentialEv: .01 }, deploymentC: deployment });
    // The result is synthetic and deliberately after AT. It must not enter the
    // as-of forecast history, even if already present in the temporary DB.
    const futureHistory = { ...prior, id: '999', datetime: '2026-10-27 13:00:00', goals: { h: '8', a: '0' }, xG: { h: '8', a: '0' } };
    scraper.client.get = async () => ({ data: { dates: [futureHistory] } });
    const [future] = await scraper.scrapeSeason('Serie A', '2026/2027');
    await db.upsertMatch(scraper.toDbFormat(future));
    const prepared = await runtime.prepareNightly({ id: 'fixture-job', runId: 'fixture-run', matchId: 'understat_101', kickoffAt: KICKOFF, targetAt: AT, leaseToken: 'fixture' });
    assert.equal(prepared.status, 'upcoming');
    const cDecision = prepared.decisions.find(d => d.family === 'C');
    assert.equal(cDecision.modelVersion, artifact.version); assert.equal(cDecision.validated, true);
    assert.equal(prepared.inputSnapshot.forecast.trainingCount, 46);
    assert.ok(Date.parse(prepared.inputSnapshot.forecast.maxTrainingAvailableAt) <= Date.parse(AT));
    const state = { deployment, source: 'adopted', revision: 'synthetic-fixture' };
    const execution = new ResearchRecommendationStore(db.db, async () => {}, { now: () => new Date(now), research: db.research });
    await db.research.initializePortfolios();
    const policy = await execution.registerPolicy(challengerExecutionPolicy(state));
    await db.research.saveModel({ family: 'A', version: baseline.baselineVersion, artifact: baselineManifest() });
    await db.db.execute({ sql: `INSERT INTO research_jobs (id,match_id,kickoff_at,target_at,status,created_at,updated_at) VALUES (?,?,?,?,'COMPLETED',?,?)`, args: ['origin-job', 'understat_101', KICKOFF, AT, AT, AT] });
    const origin = { synthetic: true, fixture: 'understat_101' };
    await db.db.execute({ sql: 'INSERT INTO research_inputs VALUES(?,?,?,?,?,?)', args: ['origin-input', 'origin-job', researchHash(origin), JSON.stringify(origin), AT, KICKOFF] });
    for (const family of ['A', 'C']) await db.db.execute({ sql: `INSERT INTO research_decisions (id,job_id,input_id,family,model_version,market,selection,portfolio_id,action,reason,snapshot_json,created_at) VALUES (?,?,?,?,?,'',NULL,?,'ABSTAIN','fixture_only','{}',?)`, args: [`origin-${family}`, 'origin-job', 'origin-input', family, family === 'A' ? baseline.baselineVersion : artifact.version, `shadow_${family}`, AT] });
    const claimArgs = { policyHash: policy.hash, runId: 'synthetic-run', windowStartAt: AT, windowEndAt: '2026-10-28T02:00:00.000Z', fixtures: [{ matchId: 'understat_101', kickoffAt: KICKOFF }] };
    const claim = await execution.claimBatch(claimArgs); assert.equal(claim.jobs.length, 1);
    const recommendation = new ResearchRecommendationRuntime(db, { clock: () => new Date(AT), researchRuntime: runtime, predictionService: predictor, appOdds, deploymentC: state });
    const packet = await recommendation.prepare(claim.jobs[0]);
    assert.ok(packet.inputSnapshot.forecasts.A.model.version.startsWith('APP-A-'));
    assert.equal(packet.inputSnapshot.forecasts.C.decision.modelVersion, artifact.version);
    if (process.env.FP_REAL_C_ARTIFACT) assert.deepEqual(packet.decisions.map(d => [d.family, d.action]), [['A', 'BET'], ['C', 'BET']]);
    const acceptedQuote = packet.decisions.find(d => d.action === 'BET')?.quote;
    assert.ok(acceptedQuote, 'a real selector must produce an admissible test quote');
    assert.equal(execution.quoteReason(acceptedQuote, now, now, Date.parse(KICKOFF), 'A'), null);
    assert.equal(execution.quoteReason({ ...acceptedQuote, usedSyntheticOdds: true }, now, now, Date.parse(KICKOFF), 'A'), 'real_fresh_quote_required');
    assert.equal(execution.quoteReason({ ...acceptedQuote, capturedAt: '2026-10-27T12:01:00.000Z' }, now, now, Date.parse(KICKOFF), 'A'), 'real_fresh_quote_required');
    assert.equal(execution.quoteReason({ ...acceptedQuote, updatedAt: '2026-10-27T11:54:59.000Z' }, now, now, Date.parse(KICKOFF), 'A'), 'real_fresh_quote_required');
    const committed = await execution.commitBatch([packet]);
    assert.equal(committed.decisions.length, 2);
    assert.ok(committed.bets.length > 0, JSON.stringify(committed.decisions.map(d => [d.family,d.reason])));
    const repeat = await execution.claimBatch(claimArgs); assert.equal(repeat.jobs.length, 0);
    now = Date.parse(KICKOFF) + 1000;
    const late = await execution.claimBatch({ ...claimArgs, fixtures: [{ matchId: 'late-fixture', kickoffAt: KICKOFF }] });
    assert.equal(late.skipped[0].reason, 'outside_execution_window');
    const bets = await db.research.listBets();
    t.diagnostic(`fixture ${process.env.FP_REAL_C_ARTIFACT ? 'real C-906 artifact' : 'synthetic C artifact'}: decisions ${committed.decisions.map(d => `${d.family}=${d.action}`).join(', ')}, bets ${bets.length}`);
    assert.equal(bets.length, committed.bets.length);
    assert.ok(bets.every(bet => bet.stakeCents > 0 && bet.stakeCents <= 5000));
    await db.upsertMatch({ ...scraper.toDbFormat(acquired.find(m => m.matchId === 'understat_101')), homeGoals: 2, awayGoals: 0 });
    const settled = await settleResearchBets(db); assert.equal(settled.settled, bets.length);
    const retried = await settleResearchBets(db); assert.equal(retried.settled, 0);
    for (const wallet of await db.research.listPortfolios()) {
      const ledger = await db.research.listLedger(wallet.id);
      assert.equal(ledger.reduce((sum, entry) => sum + entry.availableDeltaCents, 0), wallet.availableCents);
      assert.equal(ledger.reduce((sum, entry) => sum + entry.committedDeltaCents, 0), wallet.committedCents);
    }

    // Reuse the real computed C decision only as an admission fixture for six
    // independent synthetic fixtures; no additional model forecasts are claimed.
    const cBet = packet.decisions.find(d => d.family === 'C' && d.action === 'BET');
    assert.ok(cBet);
    const futureKickoff = '2026-10-28T19:00:00.000Z', nowIso = new Date(now).toISOString();
    for (let index = 0; index < 6; index++) {
      const matchId = `exposure-${index}`, originJob = `origin-job-${index}`, inputId = `origin-input-${index}`;
      await db.upsertMatch({ ...scraper.toDbFormat(acquired.find(m => m.matchId === 'understat_101')), matchId, date: new Date(futureKickoff) });
      await db.db.execute({ sql: `INSERT INTO research_jobs (id,match_id,kickoff_at,target_at,status,created_at,updated_at) VALUES (?,?,?,?,'COMPLETED',?,?)`, args: [originJob, matchId, futureKickoff, nowIso, nowIso, nowIso] });
      const source = { synthetic: true, fixture: matchId };
      await db.db.execute({ sql: 'INSERT INTO research_inputs VALUES(?,?,?,?,?,?)', args: [inputId, originJob, researchHash(source), JSON.stringify(source), nowIso, futureKickoff] });
      for (const family of ['A', 'C']) await db.db.execute({ sql: `INSERT INTO research_decisions (id,job_id,input_id,family,model_version,market,selection,portfolio_id,action,reason,snapshot_json,created_at) VALUES (?,?,?,?,?,'',NULL,?,'ABSTAIN','fixture_only','{}',?)`, args: [`origin-${family}-${index}`, originJob, inputId, family, family === 'A' ? baseline.baselineVersion : artifact.version, `shadow_${family}`, nowIso] });
      const next = await execution.claimBatch({ policyHash: policy.hash, runId: 'exposure-fixture', windowStartAt: nowIso, windowEndAt: '2026-10-29T02:00:00.000Z', fixtures: [{ matchId, kickoffAt: futureKickoff }] });
      assert.equal(next.jobs.length, 1);
      const job = next.jobs[0], quote = { ...cBet.quote, capturedAt: nowIso, updatedAt: nowIso };
      const item = { jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
        inputSnapshot: { observedAt: nowIso, match: { matchId, kickoffAt: futureKickoff }, quotes: [quote], metadata: { policy: challengerExecutionPolicy(state), originInputId: job.originInputId } },
        decisions: [{ family: 'A', modelVersion: prediction.canonicalRecommendation.model.version, originDecisionId: job.originDecisionIds.A, action: 'ABSTAIN', reason: 'fixture_only', recommended: false, validated: false },
          { ...cBet, originDecisionId: job.originDecisionIds.C, quote }] };
      const result = await execution.commitBatch([item]);
      const decision = result.decisions.find(d => d.family === 'C');
      assert.equal(decision.action, index < 5 ? 'BET' : 'ABSTAIN');
      if (index === 5) assert.equal(decision.reason, 'virtual_exposure_limit');
    }
    if (process.env.FP_REAL_C_ARTIFACT) assert.equal(researchHash(JSON.parse(readFileSync(process.env.FP_REAL_C_ARTIFACT, 'utf8'))), '3f18e05ee228d1c6fdbe92865b3b19635cdf68f3ecbd50ff53d83914b52993b3');
    const cWallet = (await db.research.listPortfolios()).find(wallet => wallet.id === 'shadow_C');
    assert.ok(cWallet.committedCents > 0 && cWallet.committedCents <= Math.floor(cWallet.equityCents * .05));


  } finally {
    await db.close();
    const expectedPrefix = `${resolve(tmpdir())}${sep}automatic-pipeline-`;
    assert.ok(resolve(dbPath).startsWith(expectedPrefix));
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(`${dbPath}${suffix}`, { force: true }); }
      catch (error) {
        assert.ok(['EPERM', 'EBUSY'].includes(error.code), 'unexpected temporary fixture cleanup failure');
        t.diagnostic(`temporary fixture cleanup deferred: ${error.code}`);
      }
    }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
