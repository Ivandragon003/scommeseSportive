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

test('overview reads the separate worker from shared state independently of the web enable flag', async () => {
  const previous = process.env.RESEARCH_T15_SCHEDULER_ENABLED;
  process.env.RESEARCH_T15_SCHEDULER_ENABLED = 'false';
  const worker = { enabled: true, active: true, heartbeatFresh: true,
    heartbeatAt: '2026-10-27T12:00:00Z', lastTickAt: '2026-10-27T11:59:55Z' };
  try {
    const active = await buildResearchOverview(overviewDb(worker));
    assert.equal(active.status.schedulerEnabled, true);
    assert.equal(active.status.schedulerState, 'ACTIVE');
    assert.equal(active.status.heartbeatAt, worker.heartbeatAt);
    assert.equal(active.status.lastSchedulerJobAt, worker.lastTickAt);
    assert.ok(!active.status.blockers.some((blocker) => /Scheduler.*disabilitato/.test(blocker)));

    process.env.RESEARCH_T15_SCHEDULER_ENABLED = 'true';
    const stopped = await buildResearchOverview(overviewDb({ ...worker, enabled: false, active: false }));
    assert.equal(stopped.status.schedulerEnabled, false);
    assert.equal(stopped.status.schedulerState, 'STOPPED');
    const stale = await buildResearchOverview(overviewDb({ ...worker, active: false, heartbeatFresh: false }));
    assert.equal(stale.status.schedulerEnabled, false);
    assert.equal(stale.status.schedulerState, 'STALE');
    assert.ok(stale.status.blockers.some((blocker) => /lease o heartbeat/.test(blocker)));
    const invalidHeartbeat = await buildResearchOverview(overviewDb({ ...worker, heartbeatFresh: false }));
    assert.equal(invalidHeartbeat.status.schedulerEnabled, false);
    assert.equal(invalidHeartbeat.status.schedulerState, 'STALE');
  } finally {
    if (previous === undefined) delete process.env.RESEARCH_T15_SCHEDULER_ENABLED;
    else process.env.RESEARCH_T15_SCHEDULER_ENABLED = previous;
  }
});

test('an old scheduler run or web flag never replaces a missing worker observation', async () => {
  const previous = process.env.RESEARCH_T15_SCHEDULER_ENABLED;
  process.env.RESEARCH_T15_SCHEDULER_ENABLED = 'true';
  try {
    const overview = await buildResearchOverview(overviewDb(undefined, [{ schedulerName: 'research_t15',
      success: true, endedAt: new Date().toISOString() }]));
    assert.equal(overview.status.schedulerEnabled, null);
    assert.equal(overview.status.schedulerState, 'UNKNOWN');
    assert.equal(overview.status.heartbeatAt, null);
    assert.equal(overview.status.lastSchedulerJobAt, null);
  } finally {
    if (previous === undefined) delete process.env.RESEARCH_T15_SCHEDULER_ENABLED;
    else process.env.RESEARCH_T15_SCHEDULER_ENABLED = previous;
  }
});
