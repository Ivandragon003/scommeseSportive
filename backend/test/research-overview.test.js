const test = require('node:test');
const assert = require('node:assert/strict');
const { benchmarkOverview, buildResearchOverview } = require('../dist/research/ResearchOverview');

function overviewDb(worker, runs = []) {
  const db = { research: Object.fromEntries(['getModels', 'listPortfolios', 'listBets', 'listMarkets', 'listJobs', 'listLedger',
    'listDecisions', 'listModelEvents', 'listBenchmarks'].map((name) => [name, async () => []])),
    researchMonitoring: { read: async () => ({ notifications: [], incidents: [] }) },
    researchExperiments: { list: async () => [] }, listRecentSchedulerRuns: async () => runs,
    listRecentSchedulerRunsByName: async (name) => runs.filter((row) => row.schedulerName === name) };
  db.research.getLatestBenchmark = async () => null;
  // Any attempted initialization or worker mutation must fail this read-only GET.
  db.research.initializePortfolios = () => { throw new Error('Overview must not initialize portfolios'); };
  if (worker !== undefined) db.researchWorker = new Proxy({ status: async () => worker }, {
    get: (target, key) => key === 'status' ? target.status : () => { throw new Error('Overview must not mutate worker state'); },
  });
  return db;
}

test('a probability-only benchmark never presents an unmeasured zero-bet simulation as economic evidence', () => {
  const output = benchmarkOverview({ id: 'fixture', report: {
    type: 'historical_probability_walk_forward_after_shared_isotonic',
    A: { n: 10, logLoss: 1 }, C: { n: 10, logLoss: .99 },
    bookmakerBenchmark: { n: 0, bookmaker: { n: 0, logLoss: null } },
    economics: { onePercent: { A: { bets: 0, netProfit: 0, initialBankroll: 1000, finalBankroll: 1000 } } },
    conclusion: 'inconclusive', limitations: ['No historical bookmaker prices loaded into this probability-only report; market blending is a no-op.'],
  } });
  assert.equal(output.economic, undefined);
  assert.match(output.conclusion, /non è statisticamente conclusivo/);
  assert.ok(output.warnings.some((warning) => /non misura il rendimento/.test(warning)));
  assert.equal(output.probabilistic.bookmaker.logLoss, null);
});

test('economic evidence preserves independent portfolios and missing metrics stay missing', () => {
  const output = benchmarkOverview({ report: { A: { n: 100 }, C: { n: 100 },
    economics: { onePercent: { A: { initialBankroll: 1000, finalBankroll: 1009, netProfit: 9, bets: 1, roi: .9 },
      C: { initialBankroll: 1000, finalBankroll: 990, netProfit: -10, bets: 1, roi: -1 } } } } });
  assert.equal(output.economic.A.finalCents, 100900);
  assert.equal(output.economic.C.finalCents, 99000);
  assert.equal(output.economic.A.clv, undefined);
  assert.equal(output.economic.totalCents, undefined);
  assert.equal(benchmarkOverview(null), null);
});

test('overview distinguishes a complete nightly from an import and never invents API consumption', async () => {
  const imports = [{ schedulerName: 'understat', success: true, endedAt: '2026-10-27T03:00:00Z' }];
  const db = { research: Object.fromEntries(['getModels', 'listPortfolios', 'listBets', 'listMarkets', 'listJobs', 'listLedger',
    'listDecisions', 'listModelEvents', 'listBenchmarks'].map((name) => [name, async () => []])),
    researchMonitoring: { read: async () => ({ notifications: [], incidents: [] }) },
    researchExperiments: { list: async () => [] }, listRecentSchedulerRuns: async () => imports,
    listRecentSchedulerRunsByName: async (name) => imports.filter((row) => row.schedulerName === name) };
  db.research.getLatestBenchmark = async () => null;
  const overview = await buildResearchOverview(db);
  assert.equal(overview.status.lastNightlyAt, null);
  assert.equal(overview.status.lastDataUpdateAt, '2026-10-27T03:00:00Z');
  assert.equal(overview.status.apiQuota, null);
  assert.equal(overview.status.automationScope, 'local_code');
  assert.equal(overview.status.remoteVerification, 'not_verified_from_backend');
  imports.push({ schedulerName: 'nightly', success: true, endedAt: '2026-10-27T03:30:00Z' });
  imports.push({ schedulerName: 'research_provider', success: true, endedAt: '2026-10-27T12:00:00Z',
    summary: { quota: { remaining: 0, used: 500, lastCost: 3, observedAt: '2026-10-27T12:00:00Z' } } });
  const measured = await buildResearchOverview(db);
  assert.equal(measured.status.lastNightlyAt, '2026-10-27T03:30:00Z');
  assert.equal(measured.status.apiQuota.remaining, 0);
});

test('overview reports nightly configuration and outcomes without reading retired worker state', async () => {
  const db = overviewDb({ enabled: true, active: true });
  db.researchWorker.status = async () => { throw new Error('Retired heartbeat must not be read'); };
  const now = '2026-10-27T12:00:00Z';
  const disabled = await buildResearchOverview(db, { now, nightlyEnabled: false });
  assert.equal(disabled.status.mode, 'NIGHTLY_PRE_MATCH');
  assert.equal(disabled.status.schedulerState, 'DISABLED');
  assert.equal(disabled.status.schedulerEnabled, false);
  assert.equal(disabled.status.heartbeatAt, null);
  assert.equal(disabled.status.nightly.metrics.analyzedMatches, null);
  assert.ok(!disabled.status.blockers.some((value) => /worker|heartbeat|T−15/.test(value)));
  const missed = await buildResearchOverview(db, { now, nightlyEnabled: true });
  assert.equal(missed.status.schedulerState, 'MISSED');
  const runs = [{ schedulerName: 'research_nightly', startedAt: '2026-10-27T02:20:00Z', endedAt: '2026-10-27T03:30:00Z',
    success: true, summary: { enabled: true, analyzedMatches: 7, registeredBets: 2, skippedMatches: 5 } }];
  const measured = await buildResearchOverview(overviewDb(undefined, runs), { now, nightlyEnabled: true });
  assert.equal(measured.status.schedulerState, 'SUCCESS');
  assert.equal(measured.status.nightly.metrics.registeredBets, 2);
  assert.equal(measured.status.lastNightlyAt, null, 'decision run does not prove complete data maintenance');
  assert.equal(measured.status.lastSchedulerJobAt, runs[0].endedAt);
});
