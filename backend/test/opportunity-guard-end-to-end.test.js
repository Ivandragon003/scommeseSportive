const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { ResearchRuntime } = require('../dist/research/ResearchRuntime');
const { ResearchRecommendationRuntime } = require('../dist/research/ResearchRecommendationRuntime');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');
const { buildChallengerTeamRecommendation } = require('../dist/research/ChallengerTeamRecommendation');
const { challengerTechnicalReason } = require('../dist/research/ChallengerRecommendation');
const { appRecommendationQuote } = require('../dist/research/AppRecommendationQuotes');
const { paperSelectionKey } = require('../dist/research/PaperBetSelections');
const { baselineManifest } = require('../dist/research/ForecastCore');
const { predictHybrid } = require('../dist/research/CatBoostModel');
const { CURRENT_CHALLENGER_RELEASE } = require('../dist/research/CurrentChallengerRelease');
const { dynamicFundedExecutionPolicy } = require('../dist/research/ResearchRecommendationPolicy');
const { CHALLENGER_TEAM_MARKET_POLICY } = require('../dist/research/ChallengerMarketCoverage');
const { CANONICAL_RECOMMENDATION_POLICY } = require('../dist/services/CanonicalBetRecommendation');

// CI uses the packaged release, never the ignored research/operations directories.
const artifact = JSON.parse(readFileSync(join(__dirname, '../current-models/challenger.json'), 'utf8'));
const AT = new Date(Date.parse(artifact.createdAt) + 86400000).toISOString();
const KICKOFF = new Date(Date.parse(AT) + 7 * 3600000).toISOString();
const END = new Date(Date.parse(AT) + 16 * 3600000).toISOString();
const BOOK = 'Isolated end-to-end fixture bookmaker';
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);

function handicapQuotes() {
  const evidence = { odds: 2, bookmaker: BOOK, source: 'odds_api', priceType: 'prematch', capturedAt: AT, updatedAt: AT };
  // Complete opposite prices at several distinct lines give the real selector
  // more than one admissible choice and a different primary on the second run.
  return [.5, 1.5, 2.5, 3.5].flatMap(line => [
    appRecommendationQuote(`ahcp_${-line}`, evidence), appRecommendationQuote(`ahcp_away_${-line}`, evidence),
  ]);
}

async function setup({ staleBook = false } = {}) {
  const path = join(tmpdir(), `opportunity-guard-e2e-${process.pid}-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  for (const name of ['015_research_platform.sql', '020_research_nightly.sql', '023_research_recommendation_execution.sql',
    '028_paper_model_bets.sql', '029_funded_model_bets.sql', '030_dynamic_model_bets.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
  }
  await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT NOT NULL,home_goals INTEGER,away_goals INTEGER)');
  const row = { match_id: 'isolated-guard-e2e', home_team_id: 'fixture-home', away_team_id: 'fixture-away',
    home_team_name: 'Fixture Home', away_team_name: 'Fixture Away', competition: 'Premier League', season: '2026/2027',
    date: KICKOFF, home_goals: null, away_goals: null };
  await client.execute({ sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL)', args: [row.match_id, KICKOFF] });
  const history = Array.from({ length: 64 }, (_, index) => ({ ...row, match_id: `isolated-history-${index}`,
    date: new Date(Date.parse(AT) - (index + 2) * 86400000).toISOString(),
    home_goals: [2, 1, 0, 3][index % 4], away_goals: [0, 1, 2, 1][index % 4], home_xg: 1.7, away_xg: 1.1,
    home_shots: 14, away_shots: 10, home_shots_on_target: 5, away_shots_on_target: 3,
    home_yellow_cards: 2, away_yellow_cards: 2, home_red_cards: 0, away_red_cards: 0 }));
  const clock = () => new Date(AT), research = new ResearchStore(client, async () => {}, { now: clock });
  await research.initializePortfolios();
  await research.saveModel({ family: 'C', version: artifact.version, artifact });
  await research.saveModel({ family: 'A', version: artifact.baselineVersion, artifact: baselineManifest() });
  await client.execute({ sql: `INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,status,created_at,updated_at)
    VALUES('origin-job',?,?,?,'COMPLETED',?,?)`, args: [row.match_id, KICKOFF, AT, AT, AT] });
  await client.execute({ sql: 'INSERT INTO research_inputs VALUES(?,?,?,?,?,?)',
    args: ['origin-input', 'origin-job', researchHash({ fixture: row.match_id }), json({ fixture: row.match_id }), AT, KICKOFF] });
  for (const family of ['A', 'C']) await client.execute({ sql: `INSERT INTO research_decisions
    (id,job_id,input_id,family,model_version,market,portfolio_id,action,snapshot_json,created_at)
    VALUES(?,'origin-job','origin-input',?,?,'1x2',?,'ABSTAIN','{}',?)`,
    args: [`origin-${family}`, family, family === 'C' ? artifact.version : artifact.baselineVersion, `shadow_${family}`, AT] });
  const modelChecks = [], db = { research, getMatchById: async id => id === row.match_id ? row : null,
    getMatches: async () => history, saveSchedulerRun: async value => { modelChecks.push(value); } };
  const deployment = { deployment: { ...CURRENT_CHALLENGER_RELEASE }, source: 'adopted', revision: 'isolated-e2e-first' };
  const bookmakers = [{ bookmakerKey: 'fixture', bookmakerName: BOOK, updatedAt: AT, markets: [{ marketKey: 'h2h',
    outcomes: [{ name: row.home_team_name, price: 2 }, { name: 'Draw', price: 4 }, { name: row.away_team_name, price: 4 }] }] }];
  if (staleBook) bookmakers.push({ bookmakerKey: 'stale-fixture', bookmakerName: 'Expired fixture bookmaker',
    updatedAt: new Date(Date.parse(AT) - 10 * 60000).toISOString(), markets: [{ marketKey: 'h2h', outcomes: [
      { name: row.home_team_name, price: 10 }, { name: 'Draw', price: 1.5 }, { name: row.away_team_name, price: 6 },
    ] }] });
  const odds = { getQuotaStatus: () => null, getOdds: async () => [{ matchId: 'fixture-provider-event',
    homeTeam: row.home_team_name, awayTeam: row.away_team_name, commenceTime: KICKOFF, capturedAt: AT,
    bookmakers }] };
  const forecast = new ResearchRuntime(db, { clock, odds, paperMode: true, deploymentC: deployment.deployment,
    nightly: { quoteMaxAgeMs: 300000, minEv: .04, minPrudentialEv: .01 } });
  const observed = [], prepareNightly = forecast.prepareNightly.bind(forecast);
  forecast.prepareNightly = async job => { const value = await prepareNightly(job); observed.push(value); return value; };
  let quotes = handicapQuotes();
  const appOdds = { getQuotaStatus: () => null, load: async () => ({ quotes,
    sharedOdds: { odds: Object.fromEntries(quotes.map(quote => [quote.selection, quote.odds])),
      bookmakerBySelection: Object.fromEntries(quotes.map(quote => [quote.selection, quote.bookmaker])), source: 'odds_api', capturedAt: AT } }) };
  const modelA = { source: 'PredictionService', version: `APP-A-${'a'.repeat(20)}`,
    codeHash: '1'.repeat(64), configHash: '2'.repeat(64), stateHash: '3'.repeat(64) };
  // Only A's app transport is stubbed. C uses its real baseline fit, classifier,
  // coherent calibration, frozen profiles, native engine and persisted ledger.
  const predictionService = { predict: async (_request, settings) => {
    const opportunities = quotes.filter(quote => quote.side === 'home').slice(0, 2).map(quote => ({
      selection: quote.selection, marketName: quote.selection, marketCategory: 'handicap', marketTier: 'SECONDARY',
      bookmakerOdds: quote.odds, confidence: 'MEDIUM', ourProbability: 60, expectedValue: 20,
      edge: 10, edgeNoVig: 10, kellyFraction: 5, suggestedStakePercent: 1.23, isValueBet: true }));
    return { valueOpportunities: opportunities, canonicalRecommendation: { policyVersion: CANONICAL_RECOMMENDATION_POLICY,
      selected: opportunities[0], ranked: opportunities, decisionStatus: 'RECOMMENDED', asOf: settings.asOf, model: modelA,
      odds: { ...settings.sharedOdds }, probabilities: { raw: { homeWin: .6 }, decision: { homeWin: .6 } } } };
  } };
  const runtime = new ResearchRecommendationRuntime(db, { clock, researchRuntime: forecast, predictionService,
    appOdds, deploymentC: deployment, dynamicMode: true });
  const store = new ResearchRecommendationStore(client, async () => {}, { now: clock, research });
  return { client, research, runtime, store, deployment, observed, row, modelChecks, get quotes() { return quotes; },
    removePair(quote) { const line = quote.side === 'home' ? quote.line : -quote.line;
      quotes = quotes.filter(item => (item.side === 'home' ? item.line : -item.line) !== line); },
    async claim(state = deployment) {
      const policy = await store.registerPolicy(dynamicFundedExecutionPolicy(state));
      const result = await store.claimBatch({ policyHash: policy.hash, runId: state.revision, windowStartAt: AT,
        windowEndAt: END, fixtures: [{ matchId: row.match_id, kickoffAt: KICKOFF }] });
      assert.equal(result.jobs.length, 1); return result.jobs[0];
    },
    async close() { client.close();
      if (process.platform === 'win32') return;
      for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    },
  };
}

test('packaged C classifier flows through real forecast, guard, dynamic runtime and store without changing A opportunities', async () => {
  assert.equal(artifact.candidateKind, 'joint_head_v1', 'the packaged current release must contain the joint classifier');
  assert.equal(artifact.version, CURRENT_CHALLENGER_RELEASE.modelVersion);
  assert.equal(artifact.baselineVersion, baselineManifest().version);
  assert.equal(researchHash(artifact), CURRENT_CHALLENGER_RELEASE.artifactHash);
  const f = await setup(); try {
    const commit = await f.runtime.prepare(await f.claim());
    const source = f.observed[0], decision = source.decisions.find(value => value.family === 'C');
    assert.equal(decision.validated, true, json(decision));
    assert.equal(challengerTechnicalReason(decision, AT, f.deployment.deployment), null);
    assert.equal(decision.probabilityConfiguration.version, 'c-joint-head-probability-configuration-v1');
    assert.equal(decision.probabilityConfiguration.classifierHash, researchHash(artifact.models.jointHead));
    assert.equal(decision.probabilityConfiguration.baselineVersion, artifact.baselineVersion);
    assert.equal(decision.probabilityConfigurationHash, CURRENT_CHALLENGER_RELEASE.probabilityConfigurationHash);
    assert.equal(researchHash(decision.probabilityConfiguration), decision.probabilityConfigurationHash);
    const modelForecast = predictHybrid(source.inputSnapshot.challengerForecast, artifact);
    assert.deepEqual(decision.probabilityStages.raw, modelForecast.probabilities);
    assert.notDeepEqual(modelForecast.matrix, source.inputSnapshot.challengerForecast.baselineMatrix,
      'the packaged classifier must change the baseline score distribution');
    assert.deepEqual(decision.opportunityGuard, artifact.opportunityGuard);
    assert.deepEqual(decision.opportunityGuard.reliabilityProfile, artifact.opportunityGuard.reliabilityProfile);
    assert.equal(decision.dataQualityBaselineClean, true);
    assert.equal(decision.opportunityGuardQuality.hasXg, true);
    assert.ok(decision.opportunityGuardQuality.teamSampleSize.home >= 30);
    assert.ok(decision.opportunityGuardQuality.teamSampleSize.away >= 30);
    assert.ok(Date.parse(source.inputSnapshot.forecast.maxTrainingAvailableAt) < Date.parse(AT));
    const direct = buildChallengerTeamRecommendation({ decision, quotes: f.quotes, observedAt: AT,
      competition: f.row.competition, allowedMarkets: ['asian_handicap'], expectedIdentity: f.deployment.deployment });
    assert.ok(direct.opportunities.length >= 2, json(direct.exclusions));
    assert.ok(direct.selected, json(direct.exclusions));
    const packet = commit.inputSnapshot.forecasts.C.recommendation, principal = packet.selected;
    assert.ok(principal, json(packet.exclusions));
    assert.equal(principal.selection, direct.selected.selection);
    assert.equal(principal.marketCategory, direct.selected.marketCategory);
    assert.equal(packet.marketPolicyVersion, CHALLENGER_TEAM_MARKET_POLICY);
    assert.equal(packet.probabilityConfiguration.goalConfigurationHash, decision.probabilityConfigurationHash);
    assert.deepEqual(packet.probabilityConfiguration.goalConfiguration, decision.probabilityConfiguration);
    assert.deepEqual(principal.reliabilityEvidence, artifact.opportunityGuard.reliabilityProfile.families.asian_handicap);
    assert.equal(principal.qualificationEvidence.opportunityGuardProfilesSha256, artifact.opportunityGuard.profilesSha256);
    assert.ok(Number.isFinite(principal.rankingScore));
    assert.ok(Number.isFinite(principal.engineSuggestedStakePercent) && principal.engineSuggestedStakePercent > 0);
    const c = commit.decisions.find(value => value.family === 'C'), a = commit.decisions.find(value => value.family === 'A');
    assert.equal(c.action, 'BET', c.reason); assert.equal(c.selections.length, 1);
    assert.equal(c.selections[0].selectionKey, paperSelectionKey(principal.quote));
    assert.equal(c.suggestedStakePercent, principal.engineSuggestedStakePercent);
    assert.equal(c.selections[0].suggestedStakePercent, principal.engineSuggestedStakePercent);
    assert.equal(a.selections.length, 2); assert.ok(a.selections.every(value => value.suggestedStakePercent === 1.23));
    const result = await f.store.commitBatch([commit]), cBets = result.bets.filter(value => value.family === 'C');
    assert.equal(cBets.length, 1); assert.equal(result.bets.filter(value => value.family === 'A').length, 2);
    assert.equal(cBets[0].selectionKey, paperSelectionKey(principal.quote));
    assert.equal(cBets[0].snapshot.stakePercent, principal.engineSuggestedStakePercent);
    assert.equal(cBets[0].stakeCents, 10 * Math.round(principal.engineSuggestedStakePercent * 100));
    assert.ok(f.modelChecks.some(value => value.summary.family === 'C' && value.success));
    const previousC = json((await f.client.execute("SELECT * FROM dynamic_model_bets WHERE family='C'")).rows);
    f.removePair(principal.quote);
    const nextState = { ...f.deployment, revision: 'isolated-e2e-second' };
    f.runtime.beginCohort(nextState.revision, nextState);
    const next = await f.runtime.prepare(await f.claim(nextState)), nextC = next.decisions.find(value => value.family === 'C');
    assert.equal(nextC.action, 'BET', json(next.inputSnapshot.forecasts.C.recommendation?.exclusions));
    assert.notEqual(nextC.selection, principal.selection, 'the real next selector must choose a different primary');
    const repeated = await f.store.commitBatch([next]);
    assert.equal(repeated.bets.filter(value => value.family === 'C').length, 0);
    assert.equal(repeated.decisions.find(value => value.family === 'C').reason, 'challenger_match_already_recorded');
    assert.equal(json((await f.client.execute("SELECT * FROM dynamic_model_bets WHERE family='C'")).rows), previousC);
  } finally { await f.close(); }
});

test('a stale complete 1X2 sheet cannot influence the packaged C calibrated matrix or final primary', async () => {
  const fresh = await setup(), stale = await setup({ staleBook: true });
  try {
    const clean = await fresh.runtime.prepare(await fresh.claim()), expired = await stale.runtime.prepare(await stale.claim());
    const first = clean.inputSnapshot.forecasts.C.decision, second = expired.inputSnapshot.forecasts.C.decision;
    assert.equal(first.validated, true); assert.equal(second.validated, true);
    assert.ok(stale.observed[0].paperQuotes.some(quote => quote.bookmaker === 'Expired fixture bookmaker'),
      'the old complete sheet must actually reach ResearchRuntime before freshness admission');
    assert.deepEqual(second.probabilityStages.raw, first.probabilityStages.raw);
    assert.deepEqual(second.probabilityStages.calibrated, first.probabilityStages.calibrated);
    assert.deepEqual(second.probabilityStages.decision, first.probabilityStages.decision);
    assert.deepEqual(second.prospectiveMatrix, first.prospectiveMatrix);
    assert.equal(second.probabilityConfigurationHash, first.probabilityConfigurationHash);
    assert.deepEqual(expired.inputSnapshot.forecasts.C.recommendation.selected, clean.inputSnapshot.forecasts.C.recommendation.selected);
    assert.equal(expired.decisions.find(value => value.family === 'C').action, 'BET');
  } finally { await fresh.close(); await stale.close(); }
});
