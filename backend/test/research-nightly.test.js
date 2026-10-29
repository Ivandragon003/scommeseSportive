const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@libsql/client');
const { ResearchStore } = require('../dist/research/ResearchStore');
const { ResearchRuntime, settleResearchBets } = require('../dist/research/ResearchRuntime');
const { runResearchNightly, loadNightlyPolicy, nextNightlyBoundary, nightlyQuoteReason } = require('../dist/research/ResearchNightly');
const { baselineManifest, FEATURE_NAMES, FEATURE_SCHEMA_VERSION } = require('../dist/research/ForecastCore');
const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../dist/research/CoherentProbabilityPipeline');
const { runNightly } = require('../scripts/research-nightly');
const { OddsApiService } = require('../dist/services/OddsApiService');
const { SmartOddsRequestStore } = require('../dist/services/odds-provider/SmartOddsRequestStore');
const axios = require('axios');
const { prospectivePartition } = require('../dist/research/ResearchProspectiveEvidence');

const START = '2026-10-29T02:12:00.000Z', KICKOFF = '2026-10-29T19:45:00.000Z';
const policy = () => loadNightlyPolicy({ RESEARCH_NIGHTLY_ENABLED: 'true' });

test('nightly defaults off, validates admission settings and resolves Rome DST using real instants', () => {
  assert.equal(loadNightlyPolicy({}).enabled, false);
  assert.equal(policy().minEv, .04); assert.equal(policy().minPrudentialEv, .01);
  assert.throws(() => loadNightlyPolicy({ RESEARCH_NIGHTLY_MIN_EV: '-1' }), /Invalid/);
  assert.throws(() => loadNightlyPolicy({ RESEARCH_NIGHTLY_ENABLED: 'yes' }), /Invalid/);
  assert.throws(() => loadNightlyPolicy({ RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS: 'Infinity' }), /Invalid/);
  assert.equal(nextNightlyBoundary(new Date('2026-03-28T02:00:00Z')).toISOString(), '2026-03-29T01:00:00.000Z');
  assert.equal(nextNightlyBoundary(new Date('2026-10-24T01:00:00Z')).toISOString(), '2026-10-25T02:00:00.000Z');
  assert.equal(nextNightlyBoundary(new Date(START)).toISOString(), '2026-10-30T02:00:00.000Z');
  assert.equal(nextNightlyBoundary(new Date(START), 4, 30).toISOString(), '2026-10-29T03:30:00.000Z');
  assert.equal(loadNightlyPolicy({ RESEARCH_NIGHTLY_WINDOW_HOURS: '12' }).windowHours, 12);
});

test('a late initial workflow reports already-started fixtures without requiring an API key or reconstructing bets', async () => {
  const f = await fixture({ matches: 1 });
  try {
    f.matches[0].date = '2026-10-29T02:05:00.000Z';
    const result = await runResearchNightly(f.db, { policy: policy(), clock: f.clock });
    assert.equal(result.errors, 0); assert.equal(result.analyzedMatches, 0);
    assert.equal(result.missedMatches, 1); assert.equal(result.reasonCounts.missed_nightly_interval, 1);
    assert.equal(f.requests(), 0); assert.equal((await f.store.listBets()).length, 0);
  } finally { f.close(); }
});

test('disabled nightly script opens no database, trains nothing and makes no provider request', async () => {
  const output = [];
  const result = await runNightly({ policy: loadNightlyPolicy({}), log: (record) => output.push(record),
    get db() { throw new Error('disabled script must not read a database'); } });
  assert.deepEqual(result, { mode: 'NIGHTLY', enabled: false, reason: 'nightly_disabled' });
  assert.equal(output.length, 1);
});

test('nightly freshness is relative to the decision and retains actual provider timestamp/provenance', () => {
  const quote = { odds: 2, source: 'odds_api', bookmaker: 'Fixture Book', capturedAt: START, updatedAt: START };
  assert.equal(nightlyQuoteReason(quote, Date.parse(START) + 300000, 300000), null);
  assert.equal(nightlyQuoteReason(quote, Date.parse(START) + 300001, 300000), 'quote_stale');
  assert.equal(nightlyQuoteReason({ ...quote, source: 'model_completion' }, Date.parse(START), 300000), 'real_quote_required');
  assert.equal(nightlyQuoteReason({ ...quote, updatedAt: '2026-10-29T02:13:00Z' }, Date.parse(START), 300000), 'quote_timestamp_future');
});

async function fixture(options = {}) {
  const path = join(tmpdir(), `nightly-runtime-${randomUUID()}.db`), client = createClient({ url: `file:${path}` });
  for (const migration of ['015_research_platform.sql', '018_smart_odds.sql', '020_research_nightly.sql', '021_research_prospective.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
  }
  let now = Date.parse(START), requests = 0, historyReads = 0, sampleReads = 0;
  const clock = () => new Date(now), store = new ResearchStore(client, async () => {}, { now: clock });
  const base = { match_id: 'fixture', home_team_id: 'h', away_team_id: 'a', home_team_name: 'Home', away_team_name: 'Away',
    date: KICKOFF, competition: 'Serie A', season: '2026/27', home_goals: null, away_goals: null };
  const matches = Array.from({ length: options.matches ?? 2 }, (_, index) => ({ ...base, match_id: `fixture-${index}`,
    home_team_name: `Home ${index}`, away_team_name: `Away ${index}` }));
  const history = Array.from({ length: 45 }, (_, index) => ({ ...base, match_id: `past-${index}`,
    date: new Date(now - (index + 2) * 86400000).toISOString(), home_goals: index % 3, away_goals: index % 2,
    home_xg: 1.4, away_xg: 1.1 }));
  // Deliberately favorable synthetic fixture prices/payouts test admission only;
  // these fixtures and tiny trees are never evidence of model quality or real odds.
  const samples = Array.from({ length: 500 }, (_, index) => ({ matchId: `cal-${index}`, market: '1x2',
    probability: .1 + (index % 5) * .2, odds: 10, expectedValue: 0, returnMultiplier: 10,
    outcomeAvailableAt: '2026-09-01T00:00:00Z', phase: 'validation' }));
  const tree = { oblivious_trees: [{ leaf_values: [.1] }], scale_and_bias: [1, [0]] };
  const artifact = { family: 'C', version: 'C-fixture', featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION,
    baselineVersion: baselineManifest().version, candidateKind: 'intensity_correction', weight: .5, temperature: 1,
    trainedThrough: '2026-09-01T00:00:00Z', validationThrough: '2026-10-01T00:00:00Z', createdAt: '2026-10-02T00:00:00Z',
    models: { home: tree, away: tree }, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
    pipelineHashV2: coherentProbabilityPipelineHash(), probabilityCalibrationMode: 'identity', calibrationSamples: { A: samples, C: samples } };
  // Earlier tests exercise betting admission with explicit independent evidence.
  // Cold-start tests below keep the real dedicated store empty instead.
  if (options.independentSamples !== false) store.listProspectiveCalibrationSamples = async () => { sampleReads++; return samples; };
  await store.saveModel({ family: 'C', version: artifact.version, artifact });
  await store.saveModel({ family: 'A', version: artifact.baselineVersion, artifact: baselineManifest() });
  for (const family of ['A', 'C']) await store.setMarketState({ family,
    modelVersion: family === 'A' ? artifact.baselineVersion : artifact.version, market: '1x2', state: 'EXPERIMENTAL' });
  const runs = [];
  const db = { research: store, getUpcomingMatches: async ({ nowIso, untilIso }) => matches.filter((row) => row.home_goals == null
    && Date.parse(row.date) > Date.parse(nowIso) && Date.parse(row.date) < Date.parse(untilIso)),
    getMatchById: async (id) => matches.find((row) => row.match_id === id),
    getMatches: async () => { historyReads++; return [...history, ...matches]; },
    updateMatchKickoff: async (id, date) => { matches.find((row) => row.match_id === id).date = date; },
    saveSchedulerRun: async (run) => { runs.push(run); return runs.length; } };
  const odds = { getQuotaStatus: () => ({ remaining: 497, source: 'provider_headers' }), getOdds: async () => {
    requests++;
    if (options.failure) throw Object.assign(new Error('secret URL must not be persisted'), { code: options.failure });
    return matches.map((match, index) => ({ matchId: `provider-${index}`, homeTeam: match.home_team_name, awayTeam: match.away_team_name,
      commenceTime: match.date, capturedAt: clock().toISOString(), bookmakers: [{ bookmakerKey: 'fixture', bookmakerName: 'Fixture Book',
        updatedAt: clock().toISOString(), markets: [{ marketKey: 'h2h', outcomes: [
          { name: match.home_team_name, price: 10 }, { name: 'Draw', price: 10 }, { name: match.away_team_name, price: 10 }] }] }] }));
  } };
  const preparer = new ResearchRuntime(db, { clock, odds, nightly: policy() });
  return { db, preparer, store, client, matches, runs, clock, requests: () => requests, historyReads: () => historyReads, sampleReads: () => sampleReads,
    advance: (ms) => { now += ms; }, close: () => { client.close(); for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(path + suffix, { force: true }); } catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
    } } };
}

test('finite nightly evaluates actual A/C engine on shared real-shaped snapshots, registers once and settles independent wallets', async () => {
  const f = await fixture();
  try {
    const summary = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer: f.preparer });
    assert.equal(summary.errors, 0); assert.equal(summary.analyzedMatches, 2); assert.equal(summary.registeredBets, 4);
    assert.equal(f.requests(), 1);
    assert.equal(f.sampleReads(), 2, 'one independent evidence lookup per model/configuration and nightly cohort');
    assert.equal(summary.windowEndAt, '2026-10-30T02:00:00.000Z');
    assert.equal(summary.quota.remaining, 497);
    const bets = await f.store.listBets(), decisions = await f.store.listDecisions();
    assert.equal(bets.length, 4); assert.ok(bets.every((bet) => bet.stakeCents === 1000));
    assert.ok(bets.every((bet) => bet.snapshot.quote.priceType === 'prematch' && bet.snapshot.experimental === true));
    for (const match of f.matches) assert.equal(new Set(decisions.filter((d) => d.snapshot.matchId === match.match_id).map((d) => d.snapshot.inputHash)).size, 1);
    assert.ok((await f.store.listMarkets()).every((market) => market.state === 'EXPERIMENTAL'));
    assert.equal(await f.store.getChampion('C'), null);
    const retried = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer: f.preparer });
    assert.equal(retried.reasonCounts.nightly_run_already_completed, 1); assert.equal(f.requests(), 1);
    assert.equal((await f.store.listBets()).length, 4);
    assert.equal((await f.store.listLedger()).filter((row) => row.event === 'STAKE').length, 4);
    f.matches.forEach((match) => { match.home_goals = 1; match.away_goals = 0; match.source = 'understat'; });
    assert.equal((await settleResearchBets(f.db)).settled, 4);
    assert.equal((await settleResearchBets(f.db)).settled, 0);
    const wallets = await f.store.listPortfolios();
    assert.deepEqual(wallets.map((wallet) => [wallet.id, wallet.committedCents]), [['shadow_A', 0], ['shadow_C', 0]]);
    assert.ok(wallets.every((wallet) => wallet.availableCents >= 0));
    assert.equal(f.runs.filter((row) => row.schedulerName === 'research_nightly').length, 1);
  } finally { f.close(); }
});

test('actual governed nightly feed refuses an unaffordable request before HTTP and before reserving virtual funds', async () => {
  const f = await fixture({ matches: 1 }), previous = axios.get; let httpCalls = 0;
  axios.get = async () => { httpCalls++; throw new Error('unexpected network edge'); };
  try {
    const manager = new SmartOddsRequestStore(f.client, async () => {}, { clock: f.clock, monthlyLimit: 2 });
    const odds = new OddsApiService('unit-test-only', { store: manager, operation: 'nightly', priority: 'essential', cacheMaxAgeMs: 300000 });
    const preparer = new ResearchRuntime(f.db, { clock: f.clock, odds, nightly: policy() });
    const result = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer });
    assert.equal(result.errors, 0); assert.equal(result.reasonCounts.odds_credit_budget_exhausted, 1);
    assert.equal(httpCalls, 0); assert.equal(result.registeredBets, 0);
    const overview = await manager.overview();
    assert.equal(overview.providers[0].chargedCredits, 0); assert.equal(overview.providers[0].reservedCredits, 0);
    assert.equal(overview.providers[0].monthlyLimit, 2);
    assert.equal((await f.store.listLedger()).filter((row) => row.event === 'STAKE').length, 0);
  } finally { axios.get = previous; f.close(); }
});

test('nightly skips a quota denial without repeated requests, invented quotes or leaking provider error text', async () => {
  const f = await fixture({ failure: 'odds_credit_budget_exhausted', matches: 1 });
  try {
    const result = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer: f.preparer });
    assert.equal(result.errors, 0); assert.equal(result.registeredBets, 0); assert.equal(result.skippedMatches, 1);
    assert.equal(result.reasonCounts.odds_credit_budget_exhausted, 1); assert.equal(f.requests(), 1);
    assert.equal((await f.store.listBets()).length, 0);
    assert.doesNotMatch(JSON.stringify(f.runs), /secret URL/);
  } finally { f.close(); }
});

test('transient failure leaves a retryable run and a repeated workflow recovers without duplicate ledger entries', async () => {
  const f = await fixture({ matches: 1 }); let failed = false;
  try {
    const flaky = { getQuotaStatus: () => null, prepareNightly: async (job) => {
      if (!failed) { failed = true; throw Object.assign(new Error('private request'), { code: 'odds_transport_failed' }); }
      return f.preparer.prepareNightly(job);
    } };
    const first = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer: flaky });
    assert.equal(first.errors, 1); assert.equal(first.apiErrors, 1);
    const recovered = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer: flaky });
    assert.equal(recovered.runId, first.runId); assert.equal(recovered.errors, 0); assert.equal(recovered.registeredBets, 2);
    assert.equal((await f.store.listLedger()).filter((row) => row.event === 'STAKE').length, 2);
    assert.equal((await f.store.listNightlyRuns())[0].status, 'COMPLETED');
  } finally { f.close(); }
});

test('a partial retry after kickoff does not report completed BET or ABSTAIN decisions as missed', async () => {
  for (const action of ['BET', 'ABSTAIN']) {
    const f = await fixture(); let failSecond = true;
    f.matches[0].date = '2026-10-29T02:13:00.000Z';
    const preparer = { getQuotaStatus: () => null, prepareNightly: async (job) => {
      if (job.matchId === 'fixture-1' && failSecond) throw Object.assign(new Error('private transport'), { code: 'odds_transport_failed' });
      const result = await f.preparer.prepareNightly(job);
      if (job.matchId === 'fixture-0' && action === 'ABSTAIN') result.decisions = result.decisions.map((decision) => ({
        ...decision, action: 'ABSTAIN', reason: 'fixture_abstained' }));
      return result;
    } };
    try {
      const first = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer });
      assert.equal(first.errors, 1); assert.equal(first.registeredBets, action === 'BET' ? 2 : 0);
      failSecond = false; f.advance(120000);
      const retry = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer });
      assert.equal(retry.errors, 0); assert.equal(retry.missedMatches, 0);
      assert.equal(retry.reasonCounts.missed_nightly_interval, undefined);
      assert.equal(retry.registeredBets, action === 'BET' ? 4 : 2);
      assert.equal((await f.store.listDecisions()).length, 4);
      assert.equal((await f.store.listLedger()).filter((row) => row.event === 'STAKE').length, action === 'BET' ? 4 : 2);
    } finally { f.close(); }
  }
});

test('custom-duration retries preserve the original persisted window before querying fixtures, with or without GitHub identity', async () => {
  const previousId = process.env.GITHUB_RUN_ID;
  try {
    for (const github of [false, true]) {
      if (github) process.env.GITHUB_RUN_ID = '991122'; else delete process.env.GITHUB_RUN_ID;
      const f = await fixture({ matches: 1 }); let failed = false;
      f.matches[0].date = '2026-10-29T08:00:00.000Z';
      const queries = [], originalUpcoming = f.db.getUpcomingMatches;
      f.db.getUpcomingMatches = async (query) => { queries.push(query); return originalUpcoming(query); };
      const custom = { ...policy(), windowHours: 12 };
      const preparer = { getQuotaStatus: () => null, prepareNightly: async (job) => {
        if (!failed) { failed = true; throw Object.assign(new Error('private transport'), { code: 'odds_transport_failed' }); }
        return f.preparer.prepareNightly(job);
      } };
      try {
        const invoke = () => github ? runNightly({ db: f.db, policy: custom, clock: f.clock, preparer, log: () => {} })
          : runResearchNightly(f.db, { policy: custom, clock: f.clock, preparer });
        const first = await invoke(); assert.equal(first.errors, 1);
        assert.equal(first.windowEndAt, '2026-10-29T14:12:00.000Z');
        if (github) assert.equal(first.runId, 'github-actions:991122');
        f.advance(600000);
        const retry = await invoke();
        assert.equal(retry.errors, 0); assert.equal(retry.registeredBets, 2);
        assert.equal(retry.runId, first.runId); assert.equal(retry.startedAt, START);
        assert.equal(retry.windowEndAt, first.windowEndAt);
        assert.equal(queries[1].nowIso, '2026-10-29T02:22:00.000Z');
        assert.equal(queries[1].untilIso, first.windowEndAt);
        assert.equal((await f.store.listNightlyRuns()).length, 1);
      } finally { f.close(); }
    }
  } finally {
    if (previousId === undefined) delete process.env.GITHUB_RUN_ID; else process.env.GITHUB_RUN_ID = previousId;
  }
});

test('a quota skip stays a recorded skip after a partial retry, while an undecided retry is genuinely missed', async () => {
  for (const skipped of [true, false]) {
    const f = await fixture(); let firstAttempt = true;
    f.matches[0].date = '2026-10-29T02:13:00.000Z';
    const preparer = { getQuotaStatus: () => null, prepareNightly: async (job) => {
      if (firstAttempt) throw Object.assign(new Error('private transport'), { code: job.matchId === 'fixture-0' && skipped
        ? 'odds_credit_budget_exhausted' : 'odds_transport_failed' });
      return f.preparer.prepareNightly(job);
    } };
    try {
      assert.equal((await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer })).errors, skipped ? 1 : 2);
      firstAttempt = false; f.advance(120000);
      const retry = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer });
      assert.equal(retry.errors, 0); assert.equal(retry.registeredBets, 2);
      assert.equal(retry.missedMatches, skipped ? 0 : 1);
      if (skipped) { assert.equal(retry.reasonCounts.odds_credit_budget_exhausted, 1); assert.equal(retry.skippedMatches, 1); }
      else assert.equal(retry.reasonCounts.missed_nightly_interval, 1);
      assert.equal((await f.store.listBets()).length, 2);
    } finally { f.close(); }
  }
});

test('data-gate failure is observable and prevents all model preparation and new placements', async () => {
  const f = await fixture({ matches: 1 });
  try {
    const result = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, dataGatesPassed: false,
      preparer: { getQuotaStatus: () => null, prepareNightly: () => { throw new Error('must not run'); } } });
    assert.equal(result.errors, 1); assert.equal(result.reasonCounts.required_data_gates_failed, 1);
    assert.equal(f.requests(), 0); assert.equal((await f.store.listBets()).length, 0);
    assert.equal(f.runs.at(-1).success, false);
  } finally { f.close(); }
});

test('if preparation crosses kickoff the nightly records a missed decision and never bets retroactively', async () => {
  const f = await fixture({ matches: 1 });
  try {
    const result = await runResearchNightly(f.db, { policy: policy(), clock: f.clock,
      preparer: { getQuotaStatus: () => null, prepareNightly: async (job) => {
        const prepared = await f.preparer.prepareNightly(job); f.advance(Date.parse(KICKOFF) - Date.parse(START)); return prepared;
      } } });
    assert.equal(result.registeredBets, 0); assert.equal(result.missedMatches, 1);
    assert.equal((await f.store.listBets()).length, 0);
  } finally { f.close(); }
});

test('quotes that age while another match is prepared are excluded without an automatic freshness relaxation', async () => {
  const f = await fixture({ matches: 1 });
  try {
    const result = await runResearchNightly(f.db, { policy: policy(), clock: f.clock,
      leaseMs: 900000, preparer: { getQuotaStatus: () => null, prepareNightly: async (job) => {
        const prepared = await f.preparer.prepareNightly(job); f.advance(300001); return prepared;
      } } });
    assert.equal(result.errors, 0); assert.equal(result.registeredBets, 0);
    assert.equal(result.reasonCounts.quote_stale, 2);
    assert.ok((await f.store.listDecisions()).every((decision) => decision.action === 'ABSTAIN'));
    assert.equal(f.requests(), 1);
  } finally { f.close(); }
});

test('nightly drains an in-flight lease renewal before finalizing the run or closing its database', async () => {
  const f = await fixture({ matches: 1 });
  let entered;
  const renewing = new Promise((resolve) => { entered = resolve; });
  const sequence = [], originalRenew = f.store.renewNightlyLease.bind(f.store), originalFinish = f.store.finishNightlyRun.bind(f.store);
  f.store.renewNightlyLease = async (...args) => {
    const owned = await originalRenew(...args); entered();
    await new Promise((resolve) => setTimeout(resolve, 40)); sequence.push('renewed'); return owned;
  };
  f.store.finishNightlyRun = async (...args) => { sequence.push('finished'); return originalFinish(...args); };
  try {
    const result = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, leaseMs: 1000,
      preparer: { getQuotaStatus: () => null, prepareNightly: async (job) => {
        const prepared = await f.preparer.prepareNightly(job); await renewing; return prepared;
      } } });
    assert.equal(result.errors, 0); assert.equal(result.registeredBets, 2);
    assert.deepEqual(sequence, ['renewed', 'finished']);
  } finally { f.close(); }
});

test('cold start freezes ABSTAIN without money, observes official results at the real clock and reuses only dedicated compatible residuals', async () => {
  const f = await fixture({ matches: 1, independentSamples: false });
  f.matches[0].match_id = Array.from({ length: 100 }, (_, index) => `new-independent-${index}`)
    .find((id) => prospectivePartition(id) === 'CALIBRATION');
  const originalRead = f.store.listProspectiveCalibrationSamples.bind(f.store), reads = [];
  f.store.listProspectiveCalibrationSamples = async (query) => {
    const result = await originalRead(query); reads.push({ ...query, count: result.length }); return result;
  };
  let inferences = 0;
  const preparer = { getQuotaStatus: () => null, prepareNightly: async (job) => { inferences++; return f.preparer.prepareNightly(job); } };
  try {
    const first = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer });
    assert.equal(first.errors, 0); assert.equal(first.registeredBets, 0);
    const initialDecisions = await f.store.listDecisions();
    assert.ok(initialDecisions.every((row) => row.action === 'ABSTAIN' && /insufficient_validation_calibration/.test(row.reason)));
    const frozen = await f.store.listPendingProspectiveObservations();
    assert.ok(frozen.length >= 2); assert.equal(first.prospectiveEvidence.frozen, frozen.length);
    assert.ok(frozen.every((row) => row.inputId && row.observedAt === START && row.snapshot.quote.bookmaker === 'Fixture Book'));
    assert.ok(reads.every((row) => row.count === 0), 'favorable artifact calibrationSamples must never substitute independent nightly evidence');
    assert.equal((await f.store.listBets()).length, 0);
    assert.ok((await f.store.listLedger()).every((row) => row.event === 'OPEN'));
    const originalMatch = f.matches[0]; originalMatch.home_goals = 2; originalMatch.away_goals = 1; originalMatch.source = 'understat';
    f.advance(86400000);
    f.matches.push({ ...originalMatch, match_id: 'next-independent-fixture', home_team_name: 'Next Home', away_team_name: 'Next Away',
      date: '2026-10-30T19:45:00.000Z', home_goals: null, away_goals: null });
    const second = await runResearchNightly(f.db, { policy: policy(), clock: f.clock, preparer });
    assert.equal(second.errors, 0); assert.equal(second.registeredBets, 0, 'one match cannot satisfy the unchanged 50-match uncertainty gate');
    assert.equal(second.prospectiveEvidence.settled, frozen.length);
    assert.equal(inferences, 2, 'only the new fixture is inferred; settling old evidence never replays a model');
    assert.ok(reads.slice(-2).every((row) => row.count > 0));
    for (const observation of frozen) {
      const query = { family: observation.family, modelVersion: observation.modelVersion,
        probabilityConfigurationHash: observation.configurationHash, asOf: f.clock().toISOString() };
      const samples = await originalRead(query);
      assert.ok(samples.length > 0);
      assert.ok(samples.every((row) => row.outcomeAvailableAt === f.clock().toISOString()));
      assert.deepEqual(await originalRead({ ...query, asOf: new Date(f.clock().getTime() - 1).toISOString() }), []);
      assert.deepEqual(await originalRead({ ...query, probabilityConfigurationHash: '0'.repeat(64) }), []);
      assert.deepEqual(await originalRead({ ...query, modelVersion: 'different-model' }), []);
    }
    assert.equal((await f.store.listBets()).length, 0);
    assert.ok((await f.store.listLedger()).every((row) => row.event === 'OPEN'));
  } finally { f.close(); }
});
