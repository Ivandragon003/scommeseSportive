const test = require('node:test');
const assert = require('node:assert/strict');
const { effectiveRecommendationDecisions, readEffectiveResearchDecisions, projectAutomaticRecommendationA } = require('../dist/research/ResearchRecommendationView');
const { buildResearchOverview } = require('../dist/research/ResearchOverview');
const { buildResearchComparison } = require('../dist/research/ResearchComparison');
const { ResearchRecommendationRuntime } = require('../dist/research/ResearchRecommendationRuntime');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchStore } = require('../dist/research/ResearchStore');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');

const NOW = new Date('2026-10-30T12:00:00Z');
function fixture() {
  const legacy = [], execution = [], jobs = [], bets = [], ledger = [], portfolios = [];
  for (const family of ['A', 'C']) {
    const portfolioId = `shadow_${family}`, stake = family === 'A' ? 500 : 1000;
    portfolios.push({ id: portfolioId, family, equityCents: 100000, availableCents: 100000 - stake * 5, committedCents: stake * 5 });
    ledger.push({ id: `open-${family}`, portfolioId, event: 'OPEN', availableDeltaCents: 100000, committedDeltaCents: 0, createdAt: '2026-10-28T10:00:00Z' });
    for (let i = 0; i < 5; i++) {
      const matchId = `match-${i}`, jobId = `old-job-${i}`, at = '2026-10-30T10:00:00Z';
      const old = { id: `old-${family}-${i}`, jobId, matchId, inputId: `old-input-${i}`, family, modelVersion: `${family}-historical`,
        portfolioId, action: 'ABSTAIN', createdAt: '2026-10-30T09:00:00Z', snapshot: {} };
      legacy.push(old);
      jobs.push({ id: jobId, matchId });
      const quote = { odds: 2, market: '1x2', selection: 'homeWin', side: 'home', bookmaker: 'Fixture bookmaker',
        source: 'odds_api', capturedAt: at, updatedAt: at, priceType: 'prematch' };
      const row = { id: `new-${family}-${i}`, inputId: `new-input-${i}`, originDecisionId: old.id, matchId, family, portfolioId,
        modelVersion: family === 'A' ? 'APP-A-fixture' : 'C906-fixture', market: '1x2', selection: 'homeWin', action: 'BET',
        policyHash: 'a'.repeat(64), policyVersion: 'virtual-recommendation-v1', createdAt: at,
        betId: `bet-${family}-${i}`, betStakeCents: stake, betPlacedAt: at, betStatus: 'PENDING',
        snapshot: { quote, probability: .6, ev: .2, confidence: 'MEDIUM', stakePercent: family === 'A' ? .5 : 1, stakeCents: stake },
        recommendationPacket: { policyVersion: 'match-page-recommendation-v1', selected: { selection: 'homeWin', bookmakerOdds: 2,
          ourProbability: 60, confidence: 'MEDIUM', suggestedStakePercent: .5 }, ranked: [], decisionStatus: 'RECOMMENDED',
          asOf: at, model: { source: 'PredictionService', version: 'APP-A-fixture' }, odds: { source: 'odds_api', capturedAt: at },
          probabilities: { raw: { homeWin: .6 }, decision: { homeWin: .6 } } } };
      execution.push(row);
      bets.push({ id: row.betId, matchId, decisionId: old.id, originDecisionId: old.id, effectiveExecutionDecisionId: row.id,
        portfolioId, family, modelVersion: row.modelVersion, market: '1x2', selection: 'homeWin', stakeCents: stake, odds: 2,
        status: 'PENDING', placedAt: at, snapshot: row.snapshot });
      ledger.push({ id: `stake-${row.betId}`, portfolioId, betId: row.betId, event: 'STAKE', availableDeltaCents: -stake,
        committedDeltaCents: stake, createdAt: at });
    }
  }
  const research = { listLegacyDecisionViews: async () => legacy, listDecisions: () => { throw new Error('Full decision blobs must not be loaded'); },
    listPortfolios: async () => portfolios, listBets: async () => bets, listLedger: async () => ledger, listJobs: async () => jobs,
    listMarkets: async () => [], getOverviewModels: async () => [{ family: 'A', version: 'A80-historical', artifact: { metrics: { n: 8000 } } },
      { family: 'C', version: 'C906-fixture', artifact: {} }], getLatestBenchmark: async () => null,
    listModelEvents: async () => [], getLatestValidationSummary: async () => null };
  const recommendations = { listDecisionViews: async () => execution };
  const db = { research, recommendations, researchMonitoring: { read: async () => ({ notifications: [], incidents: [] }) },
    researchExperiments: { list: async () => [] }, listRecentSchedulerRuns: async () => [], listRecentSchedulerRunsByName: async () => [] };
  return { legacy, execution, jobs, bets, ledger, portfolios, research, recommendations, db };
}

test('five preserved paired abstentions plus five paired executions expose ten effective decisions, never twenty', async () => {
  const f = fixture(), before = JSON.stringify(f.legacy);
  const view = await readEffectiveResearchDecisions(f.research, f.recommendations);
  assert.equal(view.effective.length, 10);
  assert.equal(view.historical.length, 20);
  assert.ok(view.effective.every((row) => row.action === 'BET' && row.authority === 'execution'));
  assert.ok(view.historical.filter((row) => row.authority === 'legacy').every((row) => row.supersededBy && !row.effective));
  assert.equal(JSON.stringify(f.legacy), before);
});

test('comparison and overview use the effective policy without creating duplicate bets, balances or historical model metrics', async () => {
  const f = fixture(), before = JSON.stringify([f.bets, f.ledger, f.portfolios]);
  const comparison = await buildResearchComparison(f.research, { period: 'all' }, NOW, f.recommendations);
  assert.equal(comparison.decisionDifferences.comparedCount, 5);
  assert.equal(comparison.bets.total, 10);
  assert.equal(comparison.portfolios[0].stakeCents, 2500);
  assert.equal(comparison.portfolios[1].stakeCents, 5000);
  assert.equal(comparison.portfolios[0].currentEquityCents, 100000);
  assert.equal(comparison.portfolios[1].currentEquityCents, 100000);
  const overview = await buildResearchOverview(f.db, { now: NOW, nightlyEnabled: false });
  assert.equal(overview.decisions.length, 10);
  assert.equal(overview.decisionHistory.superseded.length, 10);
  assert.equal(overview.operationalModels.A.version, 'APP-A-fixture');
  assert.equal(overview.operationalModels.A.metrics, null);
  assert.equal(overview.operationalModels.C.version, 'C906-fixture');
  assert.equal(overview.operationalModels.C.role, 'CHALLENGER');
  assert.equal(JSON.stringify([f.bets, f.ledger, f.portfolios]), before);
});

test('the match page projects the exact frozen A packet, actual euros, and archived odds metadata', () => {
  const f = fixture(), view = effectiveRecommendationDecisions(f.legacy, f.execution);
  const recorded = view.effective.find((row) => row.family === 'A');
  recorded.betStakeCents = 507;
  const live = { canonicalRecommendation: { selected: { selection: 'awayWin' } }, probabilities: { untouched: .5 } };
  const output = projectAutomaticRecommendationA(live, recorded);
  assert.equal(output.automaticRecommendation.actualStakeAmount, 5.07);
  assert.deepEqual(output.automaticRecommendation.selected, recorded.recommendationPacket.selected);
  assert.equal(output.automaticRecommendation.status, 'PENDING');
  assert.equal(output.automaticRecommendation.placedAt, recorded.betPlacedAt);
  assert.equal(output.automaticRecommendation.quoteStatus, 'ARCHIVED');
  assert.equal(output.canonicalRecommendation, output.automaticRecommendation);
  assert.equal(output.probabilities, live.probabilities);
  assert.equal(live.canonicalRecommendation.selected.selection, 'awayWin');
});

test('a recorded abstention including an exposure veto cannot fall back to a contradictory live recommendation', () => {
  const f = fixture(), row = { ...f.execution[0], betId: null, betStatus: null, action: 'ABSTAIN', authority: 'execution',
    reason: 'virtual_exposure_limit', recommendationPacket: { ...f.execution[0].recommendationPacket, selected: null, decisionStatus: 'NO_BET' } };
  const output = projectAutomaticRecommendationA({ canonicalRecommendation: { selected: { selection: 'awayWin' } } }, row);
  assert.equal(output.automaticRecommendation.selected, null);
  assert.equal(output.automaticRecommendation.actualStakeAmount, 0);
  assert.equal(output.automaticRecommendation.status, 'ABSTAIN');
  assert.equal(output.automaticRecommendation.reason, 'virtual_exposure_limit');
});

test('the decision authorizing an existing bet outranks a later policy abstention', () => {
  const f = fixture(), prior = f.execution[0];
  const later = { ...prior, id: 'later', createdAt: '2026-10-30T11:00:00Z', action: 'ABSTAIN', betId: null,
    existingBetExecutionDecisionId: prior.id };
  const view = effectiveRecommendationDecisions([f.legacy[0]], [prior, later]);
  assert.equal(view.effective[0].id, prior.id);
  assert.equal(view.historical.find((row) => row.id === later.id).supersededBy, prior.id);
});

test('pre-migration empty execution readers preserve legacy view and scoped requests stay bounded', async () => {
  const f = fixture(), calls = [];
  const research = { listDecisions: f.research.listDecisions, listLegacyDecisionViews: async (options) => { calls.push(options); return f.legacy; } };
  const recommendations = { listDecisionViews: async (options) => { calls.push(options); return []; } };
  const view = await readEffectiveResearchDecisions(research, recommendations, { matchId: 'match-0', family: 'A', limit: 20, includeForecasts: true });
  assert.equal(view.effective.length, 10);
  assert.ok(view.effective.every((row) => row.authority === 'legacy'));
  assert.ok(calls.every((options) => options.matchId === 'match-0' && options.limit === 20 && options.includeForecasts === true));
  const live = { canonicalRecommendation: { selected: null } };
  assert.equal(projectAutomaticRecommendationA(live, null), live);
  assert.throws(() => projectAutomaticRecommendationA(live, { family: 'A', authority: 'execution' }), /Recorded recommendation packet unavailable/);
});

test('actual runtime technical abstentions with a null A forecast remain readable without a fabricated model or price', async () => {
  for (const reason of ['real_fresh_quotes_unavailable', 'app_prediction_unavailable']) {
    const kickoffAt = '2026-10-30T19:00:00Z';
    const job = { id: 'job', matchId: 'match-technical', kickoffAt, leaseToken: 'fixture-only',
      windowStartAt: '2026-10-30T00:00:00Z', windowEndAt: '2026-10-31T00:00:00Z', originDecisionIds: { A: 'old-A', C: 'old-C' } };
    const quotes = reason === 'real_fresh_quotes_unavailable' ? [] : [{ odds: 2, selection: 'homeWin', market: '1x2', side: 'home',
      bookmaker: 'Fixture bookmaker', source: 'odds_api', priceType: 'prematch', capturedAt: NOW.toISOString(), updatedAt: NOW.toISOString() }];
    const runtime = new ResearchRecommendationRuntime({ getMatchById: async () => ({ match_id: job.matchId,
      home_team_id: 'h', away_team_id: 'a', date: kickoffAt, home_goals: null, away_goals: null, competition: 'Serie A' }),
    research: { listMarkets: async () => [] }, saveSchedulerRun: async () => {} }, {
      clock: () => NOW, researchRuntime: { prepareNightly: async () => ({ job, kickoffAt, status: 'upcoming', quotes,
        decisions: [], inputSnapshot: {} }) }, predictionService: { predict: async () => { throw new Error('fixture private provider detail'); } },
      appOdds: { getQuotaStatus: () => null, load: async () => ({ quotes, sharedOdds: {
        odds: Object.fromEntries(quotes.map((quote) => [quote.selection, quote.odds])),
        bookmakerBySelection: Object.fromEntries(quotes.map((quote) => [quote.selection, quote.bookmaker])),
        source: 'odds_api', capturedAt: NOW.toISOString() }, metadata: {} }) },
    });
    const prepared = await runtime.prepare(job);
    assert.equal(prepared.inputSnapshot.forecasts.A, null);
    assert.equal(prepared.decisions[0].reason, reason);
    const view = effectiveRecommendationDecisions([], [{ id: 'recorded-A', ...prepared.decisions[0], matchId: job.matchId,
      portfolioId: 'shadow_A', createdAt: NOW.toISOString(), forecastAt: prepared.inputSnapshot.observedAt,
      recommendationPacket: prepared.inputSnapshot.forecasts.A }]);
    const projected = projectAutomaticRecommendationA({ canonicalRecommendation: fixture().execution[0].recommendationPacket }, view.effective[0]);
    const advice = projected.automaticRecommendation;
    assert.equal(advice.projectionKind, 'technical_abstention');
    assert.equal(advice.reason, reason); assert.equal(advice.asOf, NOW.toISOString());
    assert.equal(advice.selected, null); assert.equal(advice.source, null); assert.equal(advice.model, null);
    assert.equal(advice.probabilities, null); assert.equal(advice.odds, null); assert.equal(advice.quoteArchived, false);
    assert.equal(advice.actualStakeAmount, 0); assert.equal(advice.placedAt, null);
    assert.equal(JSON.stringify(projected).includes('private provider detail'), false);
  }
});

test('comparison counts all 300 A/C pairs before limiting visible metadata, including with pre-023 schema', async (t) => {
  const path = join(tmpdir(), `recommendation-read-cardinality-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  t.after(() => { client.close(); rmSync(path, { force: true }); });
  await client.executeMultiple(readFileSync(join(__dirname, '../migrations/015_research_platform.sql'), 'utf8'));
  const research = new ResearchStore(client);
  const recommendations = new ResearchRecommendationStore(client, async () => {}, { research });
  await research.initializePortfolios();
  const records = [];
  const appendMatch = (i) => {
    const at = '2026-10-30T10:00:00Z';
    records.push({ sql: `INSERT INTO research_jobs (id,match_id,kickoff_at,target_at,status,created_at,updated_at)
      VALUES (?,?,?,?,'COMPLETED',?,?)`, args: [`j${i}`, `m${i}`, '2026-10-30T19:00:00Z', at, at, at] });
    records.push({ sql: 'INSERT INTO research_inputs VALUES (?,?,?,?,?,?)', args: [`i${i}`, `j${i}`, 'fixture-hash', '{}', at, '2026-10-30T19:00:00Z'] });
    for (const family of ['A', 'C']) records.push({ sql: `INSERT INTO research_decisions
      (id,job_id,input_id,family,model_version,market,selection,portfolio_id,action,reason,snapshot_json,created_at)
      VALUES (?,?,?,?,?,'1x2',?,?,?,NULL,?,?)`, args: [`d${family}${i}`, `j${i}`, `i${i}`, family, `${family}-isolated-cardinality-fixture`,
      'homeWin', `shadow_${family}`, family === 'A' ? 'BET' : 'ABSTAIN', JSON.stringify({ quote: {
        odds: 2, bookmaker: 'Fixture bookmaker', source: 'odds_api', selection: 'homeWin', market: '1x2',
      }, unused: i === 0 ? 'x'.repeat(100000) : null }), at] });
  };
  for (let i = 0; i < 300; i++) appendMatch(i);
  // These isolated historical decision rows exercise read cardinality, not financial admission or performance.
  for (let i = 0; i < records.length; i += 100) await client.batch(records.slice(i, i + 100), 'write');
  const compared = await buildResearchComparison(research, { period: 'all' }, NOW, recommendations);
  assert.equal(compared.decisionDifferences.comparedCount, 300);
  assert.equal(compared.decisionDifferences.differentCount, 300);
  assert.equal(compared.decisionDifferences.total, 300);
  assert.equal(compared.decisionDifferences.rows.length, 300);
  assert.equal(compared.decisionDifferences.truncated, false);
  assert.equal(compared.bets.total, 0);
  const period = await buildResearchComparison(research, { period: 'custom', from: '2026-10-30', to: '2026-10-30' }, NOW, recommendations);
  assert.equal(period.decisionDifferences.comparedCount, 300);
  assert.equal(period.decisionDifferences.total, 300);
  const next = records.length;
  for (let i = 300; i < 600; i++) appendMatch(i);
  for (let i = next; i < records.length; i += 100) await client.batch(records.slice(i, i + 100), 'write');
  const larger = await buildResearchComparison(research, { period: 'all' }, NOW, recommendations);
  assert.equal(larger.decisionDifferences.comparedCount, 600);
  assert.equal(larger.decisionDifferences.total, 600);
  assert.equal(larger.decisionDifferences.rows.length, 500);
  assert.equal(larger.decisionDifferences.truncated, true);
});
