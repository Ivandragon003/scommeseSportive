const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const axios = require('axios');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { rmSync } = require('node:fs');
const { once } = require('node:events');
const { DatabaseService } = require('../dist/db/DatabaseService');
const { ResearchStore } = require('../dist/research/ResearchStore');
const { ResearchRuntime } = require('../dist/research/ResearchRuntime');
const { SmartOddsRequestStore } = require('../dist/services/odds-provider/SmartOddsRequestStore');
const { baselineManifest, FEATURE_NAMES, FEATURE_SCHEMA_VERSION } = require('../dist/research/ForecastCore');
const { fitCoherentCalibration, COHERENT_PROBABILITY_PROTOCOL, coherentProbabilityPipelineHash } = require('../dist/research/CoherentProbabilityPipeline');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');
const { createApiRouter } = require('../dist/api/routes');

// All sports, quote and validation values below are explicit synthetic fixtures.
// This verifies integration/ledger invariants, never football quality or profitability.
const NIGHTLY = '2026-10-27T02:00:00.000Z'; // 03:00 Europe/Rome.
const TARGET = '2026-10-27T19:30:00.000Z'; // 20:30 Europe/Rome.
const KICKOFF = '2026-10-27T19:45:00.000Z'; // 20:45 Europe/Rome.
const BEFORE = '2026-09-01T00:00:00.000Z';

function syntheticArtifact(version = 'C-e2e-fixture-v2') {
  const model = (value) => ({ oblivious_trees: [{ splits: [], leaf_values: [value] }], scale_and_bias: [1, [0]] });
  return { version, family: 'C', featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
    baselineVersion: baselineManifest().version, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2: coherentProbabilityPipelineHash(), probabilityCalibrationMode: 'identity', trainedThrough: BEFORE, validationThrough: BEFORE, createdAt: BEFORE,
    candidateKind: 'calibrated_ensemble', weight: .5, temperature: 1,
    models: { home: model(Math.log(4)), away: model(Math.log(.2)) },
    fixtureOnly: true };
}

function syntheticEvidence(family, modelVersion) {
  const samples = Array.from({ length: 500 }, (_, index) => ({ matchId: `synthetic-calibration-${index}`,
    market: '1x2', probability: (.1 + (index % 5) * .2), odds: 1.9, expectedValue: 0,
    returnMultiplier: 1.9, outcomeAvailableAt: BEFORE, phase: 'validation' }));
  const profiles = { A: fitCoherentCalibration([], BEFORE), C: fitCoherentCalibration([], BEFORE) };
  const configuration = buildProbabilityConfiguration({ family, baselineVersion: baselineManifest().version,
    pipelineHashV2: coherentProbabilityPipelineHash(), mode: 'identity', profile: profiles[family] });
  return { fixtureOnly: true, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, pipelineHashV2: coherentProbabilityPipelineHash(), probabilityCalibrationMode: 'identity',
    validation: { passed: false, finalHoldout: true, operationalChecksPassed: true,
      probabilityConfigurationHash: configuration.hash,
      dataHash: 'synthetic-e2e-dataset', baselineHash: baselineManifest().fingerprint, featureSchema: FEATURE_NAMES },
    marketValidation: { '1x2': { family, modelVersion, rule: 'research-market-eligibility-v1',
      probabilityConfiguration: configuration.descriptor, approvedProbabilityConfigurationHash: configuration.hash,
      independentEvaluationPassed: true, dataCoverage: true, quoteCoverage: true, settlementVerified: true,
      probabilisticSamples: 500, leagueCount: 5, periodCount: 4, calibrationPassed: true } },
    calibrationProfilesV2: profiles, calibrationSamples: { A: samples, C: samples } };
}

test('synthetic end-to-end: nightly abstains, T-15 freezes A/C, atomic bets settle and API agrees with ledger', async () => {
  const path = join(tmpdir(), `research-e2e-${process.pid}-${randomUUID()}.db`);
  const keys = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'AUTO_BET_ENABLED', 'AUTO_BET_DRY_RUN', 'ODDS_API_KEY'];
  keys.push('ODDS_API_T15_KEY');
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.TURSO_DATABASE_URL = `file:${path}`;
  process.env.TURSO_AUTH_TOKEN = 'synthetic-local-test-token';
  process.env.AUTO_BET_ENABLED = 'true';
  process.env.AUTO_BET_DRY_RUN = 'false';
  process.env.ODDS_API_KEY = 'test-key';
  delete process.env.ODDS_API_T15_KEY;
  const previousGet = axios.get;
  let now = Date.parse(NIGHTLY);
  const db = new DatabaseService();
  let server;
  try {
    await db.getMatches(); // Run the actual additive schema and migrations locally.
    db.research = new ResearchStore(db.db, async () => {}, { now: () => new Date(now) });
    await db.research.initializePortfolios();
    await db.upsertTeam({ teamId: 'e2e-home', name: 'Synthetic Home', competition: 'Serie A' });
    await db.upsertTeam({ teamId: 'e2e-away', name: 'Synthetic Away', competition: 'Serie A' });
    const fixture = { matchId: 'synthetic-e2e-match', homeTeamId: 'e2e-home', awayTeamId: 'e2e-away',
      homeTeamName: 'Synthetic Home', awayTeamName: 'Synthetic Away', competition: 'Serie A',
      season: '2026/2027', date: KICKOFF, source: 'understat', rawJson: JSON.stringify({ syntheticTestFixture: true }) };
    await db.upsertMatches(Array.from({ length: 45 }, (_, index) => ({ ...fixture,
      matchId: `synthetic-e2e-history-${index}`, date: new Date(Date.parse(TARGET) - (index + 2) * 86400000).toISOString(),
      homeGoals: 3 + index % 2, awayGoals: 0, homeXG: 3.2, awayXG: .2 })));
    await db.upsertMatch(fixture);
    const artifact = syntheticArtifact();
    for (const family of ['A', 'C']) {
      const version = family === 'A' ? baselineManifest().version : artifact.version;
      await db.research.saveModel({ family, version, artifact: family === 'A' ? baselineManifest() : artifact });
      const benchmark = await db.research.saveBenchmark({ family, modelVersion: version, report: syntheticEvidence(family, version) });
      await db.research.setMarketState({ family, modelVersion: version, market: '1x2', state: 'SHADOW',
        evidence: { benchmarkId: benchmark.id }, reason: 'Synthetic integration fixture only.' });
    }
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({ db, svc: { syncPendingBets: async () => [] } }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const retired = await fetch(`${base}/automation/place-valid-bets`, { method: 'POST' });
    assert.equal(retired.status, 410);
    assert.equal((await db.research.listBets()).length, 0);

    let oddsRequests = 0;
    db.oddsRequests = new SmartOddsRequestStore(db.db, async () => {}, { clock: () => new Date(now) });
    axios.get = async (url) => {
      oddsRequests++;
      assert.match(url, /^https:\/\/api\.the-odds-api\.com\/v4\/sports\/soccer_italy_serie_a\/odds$/);
      return { headers: { 'x-requests-used': '3', 'x-requests-remaining': '497', 'x-requests-last': '3' }, data: [
        { id: 'synthetic-provider-event', home_team: fixture.homeTeamName, away_team: fixture.awayTeamName,
          commence_time: KICKOFF, bookmakers: [{ key: 'synthetic-test-bookmaker', title: 'Synthetic test bookmaker',
            last_update: TARGET, markets: [{ key: 'h2h', last_update: TARGET,
              outcomes: [{ name: fixture.homeTeamName, price: 1.9 }, { name: 'Draw', price: 10 }, { name: fixture.awayTeamName, price: 10 }] }] }] },
      ] };
    };
    const runtime = new ResearchRuntime(db, { clock: () => new Date(now) });
    const nightly = await runtime.tick();
    assert.equal(nightly.claimed, 0);
    assert.equal(oddsRequests, 0);
    assert.equal((await db.research.listBets()).length, 0);

    now = Date.parse(TARGET);
    const decisionRun = await runtime.tick();
    assert.equal(decisionRun.completed, 1);
    const decisions = (await db.research.listDecisions()).sort((a, b) => a.family.localeCompare(b.family));
    assert.deepEqual(decisions.map((entry) => [entry.family, entry.action]), [['A', 'BET'], ['C', 'BET']]);
    const bets = await db.research.listBets();
    assert.equal(bets.length, 2);
    assert.ok(bets.every((bet) => bet.stakeCents === 1000 && bet.odds === 1.9 && bet.selection === 'homeWin'));
    assert.equal(oddsRequests, 1);
    const quota = await db.oddsRequests.overview();
    assert.equal(quota.providers[0].requests, 1);
    assert.equal(quota.providers[0].chargedCredits, 3);
    assert.equal(quota.usage[0].operation, 't15');
    assert.equal(new Set(decisions.map((entry) => entry.snapshot.inputHash)).size, 1);
    assert.ok(decisions.every((entry) => entry.createdAt === TARGET && entry.snapshot.probabilityStages.raw.homeWin > 0));
    assert.notEqual(decisions[0].snapshot.probabilityStages.raw.homeWin, decisions[1].snapshot.probabilityStages.raw.homeWin);
    assert.deepEqual((await db.research.listPortfolios()).map((p) => [p.availableCents, p.committedCents, p.equityCents]),
      [[99000, 1000, 100000], [99000, 1000, 100000]]);
    await runtime.tick();
    assert.equal((await db.research.listBets()).length, 2);

    const frozenBets = JSON.stringify(await db.research.listBets());
    await db.research.saveModel({ family: 'C', version: 'C-e2e-fixture-v2', artifact: syntheticArtifact('C-e2e-fixture-v2') });
    assert.equal(JSON.stringify(await db.research.listBets()), frozenBets);
    await db.upsertMatch({ ...fixture, homeGoals: 2, awayGoals: 0 });
    const settlement = await fetch(`${base}/research/settle`, { method: 'POST' });
    assert.equal(settlement.status, 200);
    assert.equal((await settlement.json()).data.settled, 2);
    const retry = await fetch(`${base}/research/settle`, { method: 'POST' });
    assert.equal((await retry.json()).data.settled, 0);
    const overviewResponse = await fetch(`${base}/research/overview`);
    assert.equal(overviewResponse.status, 200);
    const overview = (await overviewResponse.json()).data;
    assert.equal(overview.status.nightlyCreatesBets, false);
    assert.equal(overview.status.legacyAutomationDisabled, true);
    assert.deepEqual(overview.portfolios.map((p) => [p.id, p.initialCents, p.availableCents, p.committedCents, p.equityCents, p.profitCents]),
      [['shadow_A', 100000, 100900, 0, 100900, 900], ['shadow_C', 100000, 100900, 0, 100900, 900]]);
    assert.ok(overview.bets.every((bet) => bet.status === 'WON' && bet.quote.bookmaker === 'Synthetic test bookmaker'));
    assert.equal(overview.decisions.length, 2);
    for (const portfolio of overview.portfolios) {
      const ledger = await db.research.listLedger(portfolio.id);
      assert.equal(ledger.reduce((sum, row) => sum + row.availableDeltaCents, 0), portfolio.availableCents);
      assert.equal(ledger.reduce((sum, row) => sum + row.committedDeltaCents, 0), portfolio.committedCents);
    }

    // An expired target is persisted as MISSED without requesting odds or backdating.
    await db.research.syncJobs([{ matchId: 'synthetic-late', kickoffAt: KICKOFF }]);
    now = Date.parse(TARGET) + 61000;
    const missed = await runtime.tick();
    assert.equal(missed.missed, 1);
    assert.equal((await db.research.listJobs()).find((job) => job.matchId === 'synthetic-late').status, 'MISSED');
    assert.equal((await db.research.listBets()).length, 2);
  } finally {
    axios.get = previousGet;
    if (server) await new Promise((resolve) => server.close(resolve));
    db.db.close();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    // Windows libSQL can retain native WAL handles beyond client.close().
    // Leave this synthetic temp DB to OS cleanup rather than unlinking live handles.
    for (const suffix of process.platform === 'win32' ? [] : ['', '-wal', '-shm']) {
      try { rmSync(`${path}${suffix}`, { force: true }); }
      catch (error) { assert.ok(['EBUSY', 'EPERM'].includes(error.code), `Unexpected temporary DB cleanup error: ${error.code}`); }
    }
  }
});
