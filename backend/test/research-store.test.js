const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ResearchStore, researchHash } = require(join(process.env.RESEARCH_STORE_TEST_DIST || join(__dirname, '../dist'), 'research/ResearchStore.js'));

const START = '2026-10-27T12:00:00.000Z';
const KICKOFF = '2026-10-27T12:15:00.000Z';
// Synthetic descriptors only exercise admission, never production model validation.
const configuration = (family = 'C', overrides = {}) => ({ version: 'probability-configuration-v1', family,
  baselineVersion: 'fixture-baseline', probabilityProtocol: 'joint-goal-coherent-v2', pipelineHashV2: '1'.repeat(64),
  mode: 'identity', temperature: 1, calibratorHash: '2'.repeat(64), ...overrides });
const configurationEvidence = (family = 'C') => ({ probabilityConfiguration: configuration(family),
  approvedProbabilityConfigurationHash: researchHash(configuration(family)) });
const marketEvidence = { dataCoverage: true, quoteCoverage: true, settlementVerified: true, probabilisticSamples: 220,
  calibrationPassed: true, leagueCount: 5, periodCount: 4, independentEvaluationPassed: true, rule: 'research-market-eligibility-v1',
  ...configurationEvidence() };
async function setup() {
  const path = join(tmpdir(), `research-${process.pid}-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  const close = client.close.bind(client);
  client.close = () => {
    close();
    try { rmSync(path, { force: true }); }
    catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
  };
  const sql = readFileSync(join(__dirname, '../migrations/015_research_platform.sql'), 'utf8');
  await client.executeMultiple(sql);
  let time = Date.parse(START);
  const store = new ResearchStore(client, async () => {}, { now: () => new Date(time) });
  await store.initializePortfolios();
  for (const family of ['A', 'C']) {
    await store.saveModel({ family, version: 'v1', artifact: { weights: [1, 2], family } });
    const benchmark = await store.saveBenchmark({ family, modelVersion: 'v1', report: { ...validReport(family),
      marketValidation: { '1X2': { ...marketEvidence, ...configurationEvidence(family), family, modelVersion: 'v1' } } } });
    await store.setMarketState({ family, modelVersion: 'v1', market: '1X2', state: 'SHADOW', evidence: { benchmarkId: benchmark.id } });
  }
  return { path, client, store, now: () => new Date(time), setTime: (value) => { time = Date.parse(value); } };
}
const makeDecisions = (overrides = {}) => ['A', 'C'].map((family) => ({ family, modelVersion: 'v1', market: '1X2', selection: 'homeWin',
  probabilityConfiguration: configuration(family), probabilityConfigurationHash: researchHash(configuration(family)),
  quote: { odds: 1.9, source: 'odds_api', bookmaker: 'Real bookmaker', capturedAt: START, updatedAt: START },
  probability: .6, ev: .14, prudentialEv: .07, score: 1, action: 'BET', ...overrides }));
async function prepare(store, matchId = 'fixture-1', score = 1) {
  await store.syncJobs([{ matchId, kickoffAt: KICKOFF, score }]);
  return (await store.claimDueJobs(START)).find((job) => job.matchId === matchId);
}
const input = (job, decisions = makeDecisions()) => ({ jobId: job.id, leaseToken: job.leaseToken, now: START,
  inputSnapshot: { fixture: job.matchId, observedAt: START, source: 'odds_api', quotes: decisions.flatMap((d) => d.quote ? [d.quote] : []) }, decisions });
const validReport = (family = 'C') => ({ validation: { passed: true, finalHoldout: true, pairedCI: true, minSamplesSatisfied: true,
  probabilityConfigurationHash: researchHash(configuration(family)),
  nPaired: 600, leagueCount: 5, periodCount: 4, deltaLogLossCI: [-.02, -.001], deltaBrierCI: [-.01, -.001],
  comparisonReference: 'model_A', referenceModelVersion: 'a-reference', operationalChecksPassed: true,
  preRegisteredRule: 'research-promotion-v1', dataHash: 'data', baselineHash: 'baseline', featureSchema: ['xg'] } });

test('independent virtual portfolios start at EUR 1000, stake 1%, settle 10 at 1.9 and reconstruct ledger', async () => {
  const { client, store } = await setup();
  try {
    const job = await prepare(store);
    const result = await store.commitDecisions(input(job));
    assert.equal(result.bets.length, 2);
    assert.equal(result.bets[0].stakeCents, 1000);
    const a = result.bets.find((bet) => bet.family === 'A');
    await store.settleBet(a.id, 1.9, { score: '2-0', source: 'understat' });
    const balances = await store.listPortfolios();
    assert.deepEqual(balances.map((p) => [p.id, p.availableCents, p.committedCents, p.equityCents]),
      [['shadow_A', 100900, 0, 100900], ['shadow_C', 99000, 1000, 100000]]);
    const ledger = await store.listLedger('shadow_A');
    assert.equal(ledger.reduce((sum, entry) => sum + entry.availableDeltaCents, 0), 100900);
    const retry = await store.settleBet(a.id, 1.9, { score: '2-0', source: 'understat' });
    assert.equal(retry.settled, false);
    assert.equal((await store.listLedger('shadow_A')).length, 3);
    await store.initializePortfolios();
    assert.equal((await store.listPortfolios())[0].equityCents, 100900);
    assert.equal((await client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('bets','budgets')")).rows[0].n, 0);
  } finally { client.close(); }
});

test('retry and concurrent job claims cannot duplicate virtual bets or stake events', async () => {
  const { client, store } = await setup();
  try {
    await store.syncJobs([{ matchId: 'fixture-1', kickoffAt: KICKOFF }]);
    const claims = await Promise.all([store.claimDueJobs(START), store.claimDueJobs(START)]);
    assert.equal(claims.flat().length, 1);
    const job = claims.flat()[0];
    const attempts = await Promise.all([store.commitDecisions(input(job)), store.commitDecisions(input(job))]);
    assert.equal(attempts[0].bets.length, 2);
    assert.equal(attempts[1].bets.length, 2);
    assert.equal((await store.listBets()).length, 2);
    assert.equal((await store.listLedger()).filter((entry) => entry.event === 'STAKE').length, 2);
    await assert.rejects(store.commitDecisions({ ...input(job), inputSnapshot: { changed: true } }), /immutable/);
  } finally { client.close(); }
});

test('clock is checked at commit even when caller supplies an earlier timestamp', async () => {
  const { client, store, setTime } = await setup();
  try {
    const job = await prepare(store);
    setTime('2026-10-27T12:01:00.001Z');
    await assert.rejects(store.commitDecisions(input(job)), /window closed|lease lost/);
    assert.equal((await store.listBets()).length, 0);
    assert.equal((await store.listDecisions()).length, 0);
    assert.equal((await client.execute('SELECT COUNT(*) AS n FROM research_inputs')).rows[0].n, 0);
  } finally { client.close(); }
});

test('stale provider timestamp, experimental market and absent C produce no unsafe bet', async () => {
  const { client, store } = await setup();
  try {
    const job = await prepare(store);
    await assert.rejects(store.commitDecisions(input(job, [makeDecisions()[0]])), /both A and C/);
    await store.setMarketState({ family: 'C', modelVersion: 'v1', market: '1X2', state: 'EXPERIMENTAL' });
    const decisions = makeDecisions();
    decisions[0].quote.updatedAt = '2026-10-27T11:54:59.000Z';
    const result = await store.commitDecisions(input(job, decisions));
    assert.equal(result.bets.length, 0);
    assert.equal(result.decisions.length, 2);
    assert.ok(result.decisions.every((decision) => decision.action === 'ABSTAIN'));
    assert.equal((await store.listPortfolios())[0].equityCents, 100000);
  } finally { client.close(); }
});

test('batch allocation is deterministic and caps committed exposure at five percent', async () => {
  const { client, store } = await setup();
  try {
    await store.syncJobs(Array.from({ length: 6 }, (_unused, index) => ({ matchId: `m-${index}`, kickoffAt: KICKOFF, score: index })));
    const jobs = await store.claimDueJobs(START);
    const result = await store.commitBatch([...jobs].reverse().map((job) => input(job, makeDecisions({ score: job.score }))), START);
    assert.equal(result.bets.length, 10);
    assert.deepEqual(result.bets.filter((bet) => bet.family === 'A').map((bet) => bet.matchId), ['m-5', 'm-4', 'm-3', 'm-2', 'm-1']);
    for (const p of await store.listPortfolios()) assert.equal(p.committedCents, 5000);
    assert.equal(result.decisions.filter((decision) => decision.reason === 'virtual_exposure_limit').length, 2);
  } finally { client.close(); }
});

test('model artifacts, ledger and evidence cannot be rewritten; rollback changes only champion', async () => {
  const { client, store } = await setup();
  try {
    await assert.rejects(store.saveModel({ family: 'C', version: 'v1', artifact: { weights: [999] } }), /immutable/);
    const invalid = await store.saveBenchmark({ family: 'C', modelVersion: 'v1', report: { validation: {} }, validated: true });
    assert.equal(invalid.validated, 0);
    await assert.rejects(store.promoteModel({ family: 'C', version: 'v1', benchmarkId: invalid.id, reason: 'test' }), /validated benchmark/);
    const benchmark1 = await store.saveBenchmark({ family: 'C', modelVersion: 'v1', report: validReport() });
    await store.promoteModel({ family: 'C', version: 'v1', benchmarkId: benchmark1.id, reason: 'validated holdout' });
    await store.saveModel({ family: 'C', version: 'v2', artifact: { weights: [3, 4] } });
    const report2 = validReport();
    report2.validation.comparisonReference = 'incumbent';
    report2.validation.referenceModelVersion = 'v1';
    const benchmark2 = await store.saveBenchmark({ family: 'PAIR', modelVersion: 'v2', report: report2 });
    await store.promoteModel({ family: 'C', version: 'v2', benchmarkId: benchmark2.id, reason: 'new validated holdout' });
    await store.rollbackModel({ family: 'C', version: 'v1', reason: 'operational regression' });
    assert.equal((await store.getChampion('C')).version, 'v1');
    assert.equal((await store.getModels('C')).length, 2);
    await assert.rejects(client.execute("UPDATE research_models SET artifact_json='{}' WHERE family='C'"), /immutable/);
    await assert.rejects(client.execute('DELETE FROM research_ledger'), /immutable/);
    assert.equal((await client.execute('SELECT COUNT(*) AS n FROM research_model_events')).rows[0].n, 3);
  } finally { client.close(); }
});

test('kickoff changes reschedule only uncommitted future decisions; missed windows never catch up', async () => {
  const { client, store, setTime } = await setup();
  try {
    await store.syncJobs([{ matchId: 'future', kickoffAt: KICKOFF }]);
    await store.syncJobs([{ matchId: 'future', kickoffAt: '2026-10-27T13:15:00.000Z' }]);
    assert.equal((await store.listJobs())[0].targetAt, '2026-10-27T13:00:00.000Z');
    await store.syncJobs([{ matchId: 'past', kickoffAt: KICKOFF }]);
    setTime('2026-10-27T12:02:00.000Z');
    const claimed = await store.claimDueJobs('2026-10-27T12:02:00.000Z');
    const missed = claimed.find((job) => job.matchId === 'past');
    assert.equal(missed.status, 'MISSED');
    await assert.rejects(store.commitDecisions(input(missed)), /lease lost/);
    assert.equal((await store.listBets()).length, 0);
  } finally { client.close(); }
});

test('quarter settlement multipliers preserve integer cents and reject conflicting retries', async () => {
  const { client, store } = await setup();
  try {
    const job = await prepare(store);
    const result = await store.commitDecisions(input(job));
    const [a, c] = result.bets;
    const halfWin = await store.settleBet(a.id, (1.9 + 1) / 2, { result: 'half_win' });
    const halfLoss = await store.settleBet(c.id, .5, { result: 'half_loss' });
    assert.equal(halfWin.returnCents, 1450);
    assert.equal(halfLoss.returnCents, 500);
    await assert.rejects(store.settleBet(a.id, 0, { result: 'loss' }), /immutable/);
    await assert.rejects(client.execute("UPDATE research_bets SET odds=3"), /immutable/);
  } finally { client.close(); }
});

test('a forged future caller timestamp cannot claim or commit before T15', async () => {
  const { client, store, setTime } = await setup();
  try {
    await store.syncJobs([{ matchId: 'future', kickoffAt: KICKOFF }]);
    setTime('2026-10-27T11:59:59.000Z');
    assert.deepEqual(await store.claimDueJobs(START), []);
    setTime(START);
    const [job] = await store.claimDueJobs(START);
    setTime('2026-10-27T11:59:59.000Z');
    await assert.rejects(store.commitDecisions(input(job)), /window closed/);
    assert.equal((await store.listBets()).length, 0);
  } finally { client.close(); }
});

test('an earlier kickoff invalidates the old lease and records missed instead of placing late', async () => {
  const { client, store } = await setup();
  try {
    const job = await prepare(store);
    await store.syncJobs([{ matchId: 'fixture-1', kickoffAt: '2026-10-27T12:10:00.000Z' }]);
    assert.equal((await store.listJobs())[0].status, 'MISSED');
    await assert.rejects(store.commitDecisions(input(job)), /lease lost/);
  } finally { client.close(); }
});

test('database lease tokens reject competitors, and repeated migration preserves research evidence', async () => {
  const { client, store } = await setup();
  try {
    const job = await prepare(store);
    await assert.rejects(store.commitDecisions({ ...input(job), leaseToken: 'other-worker' }), /lease lost/);
    await store.commitDecisions(input(job));
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations/015_research_platform.sql'), 'utf8'));
    assert.equal((await store.listBets()).length, 2);
    assert.equal((await store.listDecisions()).length, 2);
  } finally { client.close(); }
});

test('main remains empty until both model and market have independent prospective approval', async () => {
  const { client, store } = await setup();
  try {
    await store.initializePortfolios({ includeMain: true });
    const job = await prepare(store);
    const result = await store.commitDecisions(input(job, [...makeDecisions(), { ...makeDecisions()[0], portfolioId: 'main' }]));
    assert.equal(result.bets.length, 2);
    assert.equal(result.decisions.find((d) => d.portfolioId === 'main').action, 'ABSTAIN');
    const main = (await store.listPortfolios()).find((p) => p.id === 'main');
    assert.equal(main.availableCents, 100000);
    assert.equal(main.committedCents, 0);
    const benchmark = await store.getLatestBenchmark('A', 'v1');
    await assert.rejects(store.setMarketState({ family: 'A', modelVersion: 'v1', market: '1X2', state: 'ACTIVE', evidence: { benchmarkId: benchmark.id } }), /Prospective/);
  } finally { client.close(); }
});

test('a failure after the first allocation rolls back inputs, decisions, bets and ledger together', async () => {
  const { client, store } = await setup();
  try {
    const job = await prepare(store);
    const decisions = makeDecisions();
    decisions[1].modelVersion = undefined;
    await assert.rejects(store.commitDecisions(input(job, decisions)));
    assert.equal((await store.listBets()).length, 0);
    assert.equal((await store.listDecisions()).length, 0);
    assert.equal((await store.listLedger()).length, 2);
    assert.equal((await client.execute('SELECT COUNT(*) AS n FROM research_inputs')).rows[0].n, 0);
    assert.equal((await store.listJobs())[0].status, 'CLAIMED');
    assert.equal((await store.listPortfolios())[0].availableCents, 100000);
  } finally { client.close(); }
});

test('loss and refund preserve the required 1000 euro accounting examples', async () => {
  const { client, store } = await setup();
  try {
    const result = await store.commitDecisions(input(await prepare(store)));
    await store.settleBet(result.bets.find((b) => b.family === 'A').id, 0, { result: 'loss' });
    await store.settleBet(result.bets.find((b) => b.family === 'C').id, 1, { result: 'refund' });
    assert.deepEqual((await store.listPortfolios()).map((p) => [p.equityCents, p.availableCents, p.committedCents]),
      [[99000, 99000, 0], [100000, 100000, 0]]);
  } finally { client.close(); }
});

test('a crashed worker releases its cohort in time for a different database client to recover', async () => {
  const h = await setup();
  const otherClient = createClient({ url: `file:${h.path}` });
  const other = new ResearchStore(otherClient, async () => {}, { now: h.now });
  try {
    const first = await prepare(h.store);
    assert.deepEqual(await other.claimDueJobs(START), []);
    h.setTime('2026-10-27T12:00:30.000Z');
    const [recovered] = await other.claimDueJobs(START);
    assert.notEqual(recovered.leaseToken, first.leaseToken);
    await assert.rejects(h.store.commitDecisions(input(first)), /lease lost/);
    const attempts = await Promise.allSettled([other.commitDecisions(input(recovered)), h.store.commitDecisions(input(recovered))]);
    assert.ok(attempts.some((r) => r.status === 'fulfilled'));
    assert.equal((await h.store.listBets()).length, 2);
    assert.equal((await h.store.listLedger()).filter((row) => row.event === 'STAKE').length, 2);
  } finally { otherClient.close(); h.client.close(); }
});

test('job renewal preserves ownership during live preparation and never revives an expired token', async () => {
  const h = await setup();
  try {
    const job = await prepare(h.store);
    h.setTime('2026-10-27T12:00:20.000Z');
    await h.store.renewJobLeases([job]);
    assert.equal((await h.store.listJobs())[0].leaseExpiresAt, '2026-10-27T12:00:50.000Z');
    h.setTime('2026-10-27T12:00:35.000Z');
    assert.equal((await h.store.commitDecisions(input(job))).bets.length, 2);
    const second = await prepare(h.store, 'fixture-2');
    h.setTime('2026-10-27T12:01:01.000Z');
    await h.store.renewJobLeases([second]);
    await assert.rejects(h.store.commitDecisions(input(second)), /lease lost|window closed/);
    assert.equal((await h.store.listBets()).length, 2);
  } finally { h.client.close(); }
});

test('admission atomically rejects a nightly kickoff or result update after the shared input was prepared', async () => {
  const h = await setup();
  try {
    await h.client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,home_goals INTEGER,away_goals INTEGER)');
    const job = await prepare(h.store);
    const prepared = input(job);
    await h.client.execute({ sql: 'INSERT INTO matches(match_id,date) VALUES (?,?)', args: [job.matchId, '2026-10-27T13:00:00.000Z'] });
    await assert.rejects(h.store.commitDecisions(prepared), /fixture changed/);
    await h.client.execute({ sql: 'UPDATE matches SET date=?,home_goals=1 WHERE match_id=?', args: [KICKOFF, job.matchId] });
    await assert.rejects(h.store.commitDecisions(prepared), /fixture changed/);
    assert.equal((await h.store.listBets()).length, 0);
    assert.equal((await h.client.execute('SELECT COUNT(*) AS n FROM research_inputs')).rows[0].n, 0);
    await h.client.execute({ sql: 'UPDATE matches SET home_goals=NULL WHERE match_id=?', args: [job.matchId] });
    assert.equal((await h.store.commitDecisions(prepared)).bets.length, 2);
  } finally { h.client.close(); }
});

test('different quotes cannot be injected outside the common frozen snapshot', async () => {
  const { client, store } = await setup();
  try {
    const job = await prepare(store);
    const payload = input(job);
    payload.inputSnapshot = JSON.parse(JSON.stringify(payload.inputSnapshot));
    payload.decisions[1].quote.odds = 5;
    const result = await store.commitDecisions(payload);
    assert.equal(result.bets.length, 1);
    assert.equal(result.bets[0].family, 'A');
    assert.equal(result.decisions.find((d) => d.family === 'C').reason, 'quote_not_in_shared_snapshot');
  } finally { client.close(); }
});

test('explicit timezone, predecision snapshot and minimum EV are persistent admission gates', async () => {
  const { client, store } = await setup();
  try {
    await assert.rejects(store.syncJobs([{ matchId: 'ambiguous', kickoffAt: '2026-10-27T12:15:00' }]), /timezone/);
    const job = await prepare(store);
    await assert.rejects(store.commitDecisions({ ...input(job), inputSnapshot: { observedAt: KICKOFF, quotes: [] } }), /before decision/);
    const decisions = makeDecisions();
    decisions[0].ev = .039;
    decisions[1].prudentialEv = .009;
    const result = await store.commitDecisions(input(job, decisions));
    assert.equal(result.bets.length, 0);
    assert.ok(result.decisions.every((d) => d.reason === 'prudential_value_threshold_required'));
  } finally { client.close(); }
});

test('fixture suspension invalidates leases and reschedules only once its official status returns upcoming', async () => {
  const { client, store } = await setup();
  try {
    const job = await prepare(store);
    await store.syncJobs([{ matchId: 'fixture-1', kickoffAt: KICKOFF, status: 'postponed' }]);
    await assert.rejects(store.commitDecisions(input(job)), /lease lost/);
    assert.deepEqual(await store.claimDueJobs(START), []);
    await store.syncJobs([{ matchId: 'fixture-1', kickoffAt: '2026-10-27T13:15:00.000Z', status: 'upcoming' }]);
    const [rescheduled] = await store.listJobs();
    assert.equal(rescheduled.status, 'PENDING');
    assert.equal(rescheduled.targetAt, '2026-10-27T13:00:00.000Z');
    assert.equal((await store.listBets()).length, 0);
  } finally { client.close(); }
});

test('shadow transitions ignore caller assertions and require version-bound persisted holdout evidence', async () => {
  const { client, store } = await setup();
  try {
    await store.saveModel({ family: 'C', version: 'unvalidated', artifact: { candidate: true } });
    await assert.rejects(store.setMarketState({ family: 'C', modelVersion: 'unvalidated', market: '1X2', state: 'SHADOW',
      evidence: { ...marketEvidence, prospectivePassed: true } }), /Persisted independent/);
    const unrelated = await store.getLatestBenchmark('C', 'v1');
    await assert.rejects(store.setMarketState({ family: 'C', modelVersion: 'unvalidated', market: '1X2', state: 'SHADOW',
      evidence: { benchmarkId: unrelated.id } }), /Persisted independent/);
    const unsafe = await store.saveBenchmark({ family: 'C', modelVersion: 'unvalidated', report: { ...validReport(),
      warnings: [{ invalidating: true, reason: 'training_overlap' }], marketValidation: { '1X2': { ...marketEvidence, family: 'C', modelVersion: 'unvalidated' } } } });
    await assert.rejects(store.setMarketState({ family: 'C', modelVersion: 'unvalidated', market: '1X2', state: 'SHADOW',
      evidence: { benchmarkId: unsafe.id } }), /Persisted independent/);
    assert.equal((await store.listMarkets({ family: 'C', modelVersion: 'unvalidated' })).length, 0);
  } finally { client.close(); }
});

test('A bootstrap cannot validate against itself and requires independent no-vig bookmaker evidence', async () => {
  const { client, store } = await setup();
  try {
    const self = await store.saveBenchmark({ family: 'A', modelVersion: 'v1', report: validReport() });
    assert.equal(self.validated, 0);
    await assert.rejects(store.promoteModel({ family: 'A', version: 'v1', benchmarkId: self.id, reason: 'self comparison' }), /validated benchmark/);
    const report = validReport();
    report.validation.comparisonReference = 'bookmaker_no_vig';
    const independent = await store.saveBenchmark({ family: 'A', modelVersion: 'v1', report });
    assert.equal(independent.validated, 1);
    await store.promoteModel({ family: 'A', version: 'v1', benchmarkId: independent.id, reason: 'independent bookmaker comparison' });
    assert.equal((await store.getChampion('A')).version, 'v1');
  } finally { client.close(); }
});

test('ACTIVE separates market evidence from model approval and requires the current champion', async () => {
  const { client, store } = await setup();
  try {
    const modelBenchmark = await store.saveBenchmark({ family: 'C', modelVersion: 'v1', report: validReport() });
    const marketReport = { ...validReport(), validation: { ...validReport().validation, passed: false },
      marketValidation: { '1X2': { ...marketEvidence, family: 'C', modelVersion: 'v1', prospectiveSamples: 220, prospectivePassed: true } } };
    const marketBenchmark = await store.saveBenchmark({ family: 'C', modelVersion: 'v1', report: marketReport });
    assert.equal(marketBenchmark.validated, 0);
    const transition = { family: 'C', modelVersion: 'v1', market: '1X2', state: 'ACTIVE',
      evidence: { benchmarkId: marketBenchmark.id, modelBenchmarkId: modelBenchmark.id } };
    await assert.rejects(store.setMarketState(transition), /current approved champion/);
    await store.promoteModel({ family: 'C', version: 'v1', benchmarkId: modelBenchmark.id, reason: 'fixture model validation' });
    await store.setMarketState(transition);
    const active = (await store.listMarkets({ family: 'C', modelVersion: 'v1' }))[0];
    assert.equal(active.state, 'ACTIVE');
    assert.equal(active.evidence.modelBenchmarkId, modelBenchmark.id);
    assert.equal(active.evidence.benchmarkId, marketBenchmark.id);
  } finally { client.close(); }
});

test('changing A calibration under the same raw model version requires a new market approval and preserves frozen bets', async () => {
  const { client, store } = await setup();
  try {
    const original = await store.commitDecisions(input(await prepare(store, 'original-configuration')));
    assert.equal(original.bets.length, 2);
    const originalBet = original.bets.find((bet) => bet.family === 'A');
    const before = JSON.stringify((await store.listBets()).find((bet) => bet.id === originalBet.id));
    const changed = configuration('A', { mode: 'temperature', temperature: 1.2 });
    const changedDecision = { ...makeDecisions()[0], probabilityConfiguration: changed, probabilityConfigurationHash: researchHash(changed) };
    const result = await store.commitDecisions(input(await prepare(store, 'changed-configuration'), [changedDecision, makeDecisions()[1]]));
    assert.equal(result.bets.filter((bet) => bet.family === 'A').length, 0);
    assert.equal(result.decisions.find((decision) => decision.family === 'A').reason, 'probability_configuration_not_validated');
    assert.equal(JSON.stringify((await store.listBets()).find((bet) => bet.id === originalBet.id)), before);
    assert.equal((await store.listMarkets({ family: 'A', modelVersion: 'v1' }))[0].evidence.approvedProbabilityConfigurationHash,
      researchHash(configuration('A')));
    for (const [index, overrides] of [
      { probabilityConfiguration: undefined },
      { probabilityConfigurationHash: undefined },
      { probabilityConfiguration: changed, probabilityConfigurationHash: researchHash(configuration('A')) },
    ].entries()) {
      const rejected = await store.commitDecisions(input(await prepare(store, `invalid-configuration-${index}`), [{ ...makeDecisions()[0], ...overrides }, makeDecisions()[1]]));
      assert.equal(rejected.bets.filter((bet) => bet.family === 'A').length, 0);
      assert.equal(rejected.decisions.find((decision) => decision.family === 'A').reason, 'probability_configuration_not_validated');
    }
  } finally { client.close(); }
});

test('persisted market eligibility requires the descriptor hash and report hash to agree, regardless of caller flags', async () => {
  const { client, store } = await setup();
  try {
    for (const alter of [
      (report) => { delete report.marketValidation['1X2'].approvedProbabilityConfigurationHash; },
      (report) => { report.marketValidation['1X2'].probabilityConfiguration = configuration('C', { temperature: 1.5 }); },
      (report) => { report.validation.probabilityConfigurationHash = 'f'.repeat(64); },
    ]) {
      const report = { ...validReport(), marketValidation: { '1X2': { ...marketEvidence, family: 'C', modelVersion: 'v1' } } };
      alter(report);
      const benchmark = await store.saveBenchmark({ family: 'C', modelVersion: 'v1', report });
      await assert.rejects(store.setMarketState({ family: 'C', modelVersion: 'v1', market: '1X2', state: 'SHADOW',
        evidence: { benchmarkId: benchmark.id, ...configurationEvidence(), independentEvaluationPassed: true } }), /Persisted independent/);
    }
  } finally { client.close(); }
});

test('immutable-guard initialization retries temporary startup locks without exposing unguarded records', async () => {
  const h = await setup();
  try {
    let attempts = 0;
    const guardedClient = new Proxy(h.client, { get(target, property) {
      if (property === 'executeMultiple') return async (...args) => {
        if (++attempts < 3) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        return target.executeMultiple(...args);
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const store = new ResearchStore(guardedClient, async () => {}, { now: h.now });
    const reads = await Promise.all([store.listPortfolios(), store.getModels()]);
    assert.equal(attempts, 3);
    assert.equal(reads[0].length, 2);
    await assert.rejects(h.client.execute("DELETE FROM research_portfolios WHERE id='shadow_A'"), /immutable/);
  } finally { h.client.close(); }
});

test('exhausted guard initialization resets its promise so the next poll can recover', async () => {
  const h = await setup();
  try {
    let attempts = 0, locked = true;
    const guardedClient = new Proxy(h.client, { get(target, property) {
      if (property === 'executeMultiple') return async (...args) => {
        attempts++;
        if (locked) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        return target.executeMultiple(...args);
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const store = new ResearchStore(guardedClient, async () => {}, { now: h.now });
    await assert.rejects(store.listPortfolios(), /locked/);
    assert.equal(attempts, 7);
    locked = false;
    assert.equal((await store.listPortfolios()).length, 2);
    assert.equal(attempts, 8);
    assert.equal((await h.store.listLedger()).filter((entry) => entry.event === 'OPEN').length, 2);
  } finally { h.client.close(); }
});

test('a real contended WAL initialization recovers before creating guards and opening balances', async () => {
  const path = join(tmpdir(), `research-wal-startup-${randomUUID()}.db`);
  const owner = createClient({ url: `file:${path}` });
  const contender = createClient({ url: `file:${path}` });
  let blocker, busyFailures = 0;
  try {
    await owner.executeMultiple(readFileSync(join(__dirname, '../migrations/015_research_platform.sql'), 'utf8'));
    blocker = await owner.transaction('read');
    await blocker.execute('SELECT * FROM research_portfolios');
    const observed = new Proxy(contender, { get(target, property) {
      if (property === 'execute') return async (...args) => {
        try { return await target.execute(...args); }
        catch (error) {
          assert.equal(args[0], 'PRAGMA journal_mode=WAL');
          assert.match(String(error.code), /SQLITE_BUSY/);
          busyFailures++;
          await blocker.rollback(); blocker.close(); blocker = undefined;
          throw error;
        }
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const store = new ResearchStore(observed);
    assert.equal((await store.initializePortfolios()).length, 2);
    assert.equal(busyFailures, 1);
    assert.equal(contender.closed, false);
    assert.equal((await owner.execute('PRAGMA journal_mode')).rows[0].journal_mode, 'wal');
    assert.equal((await store.listLedger()).filter((entry) => entry.event === 'OPEN').length, 2);
    await assert.rejects(owner.execute("DELETE FROM research_portfolios WHERE id='shadow_A'"), /immutable/);
  } finally {
    if (blocker) { await blocker.rollback(); blocker.close(); }
    contender.close(); owner.close();
    if (process.platform !== 'win32') rmSync(path, { force: true });
  }
});

test('a real failed native BEGIN releases its connection before retrying without replaying writes', async () => {
  const h = await setup();
  const contender = createClient({ url: `file:${h.path}` });
  let blocker, reader, busyFailures = 0, workWrites = 0;
  try {
    const observed = new Proxy(contender, { get(target, property) {
      if (property === 'transaction') return async (...args) => {
        try {
          const transaction = await target.transaction(...args);
          if (args[0] !== 'write') return transaction;
          return new Proxy(transaction, { get(tx, method) {
            if (method === 'execute') return (...parameters) => { workWrites++; return tx.execute(...parameters); };
            const value = tx[method]; return typeof value === 'function' ? value.bind(tx) : value;
          } });
        }
        catch (error) {
          // The error comes from the real file driver, not an injected exception.
          assert.equal(args[0], 'write');
          assert.match(String(error.code), /SQLITE_BUSY/);
          busyFailures++;
          await blocker.rollback(); blocker.close(); blocker = undefined;
          throw error;
        }
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const store = new ResearchStore(observed);
    await store.getModels(); // Install guards before deliberately holding the write lock.
    reader = await contender.transaction('read');
    await reader.execute('SELECT * FROM research_ledger');
    blocker = await h.client.transaction('write');
    const portfolios = await store.initializePortfolios();
    assert.equal(busyFailures, 1);
    assert.equal(workWrites, 4);
    assert.equal(contender.closed, false);
    assert.equal(reader.closed, false);
    assert.equal((await reader.execute("SELECT COUNT(*) AS n FROM research_ledger WHERE event='OPEN'")).rows[0].n, 2);
    assert.equal(portfolios.length, 2);
    assert.ok(portfolios.every((portfolio) => portfolio.equityCents === 100000));
    assert.equal((await store.listLedger()).filter((entry) => entry.event === 'OPEN').length, 2);
    await assert.rejects(contender.execute("DELETE FROM research_portfolios WHERE id='shadow_A'"), /immutable/);
  } finally {
    if (blocker) { await blocker.rollback(); blocker.close(); }
    if (reader) { await reader.rollback(); reader.close(); }
    contender.close(); h.client.close();
  }
});

test('remote BEGIN contention never rotates the client connection', async () => {
  const h = await setup();
  const modes = [];
  try {
    const remote = new Proxy(h.client, { get(target, property) {
      if (property === 'protocol') return 'https';
      if (property === 'transaction') return async (mode) => {
        modes.push(mode);
        if (modes.length === 1) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        return target.transaction(mode);
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.equal((await new ResearchStore(remote).initializePortfolios()).length, 2);
    assert.deepEqual(modes, ['write', 'write']);
    assert.equal(h.client.closed, false);
    assert.equal((await h.store.listLedger()).filter((entry) => entry.event === 'OPEN').length, 2);
  } finally { h.client.close(); }
});

test('two independent processes initialize research guards and opening ledger exactly once', async () => {
  const path = join(tmpdir(), `research-guard-startup-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  try {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations/015_research_platform.sql'), 'utf8'));
    const modulePath = join(process.env.RESEARCH_STORE_TEST_DIST || join(__dirname, '../dist'), 'research/ResearchStore.js');
    const run = `
      const { createClient } = require('@libsql/client');
      const { ResearchStore } = require(process.argv[1]);
      const client = createClient({ url: 'file:' + process.argv[2] });
      const store = new ResearchStore(client);
      store.initializePortfolios().then((rows) => {
        console.log(JSON.stringify({ portfolios: rows.length })); client.close();
      }).catch((error) => {
        console.error(error);
        client.close(); process.exitCode = 1;
      });
    `;
    const outcomes = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath,
      ['-e', run, modulePath, path], { cwd: join(__dirname, '..'), timeout: 15000 })));
    assert.ok(outcomes.every(({ stdout }) => JSON.parse(stdout).portfolios === 2));
    assert.equal((await client.execute("SELECT COUNT(*) AS n FROM research_ledger WHERE event='OPEN'")).rows[0].n, 2);
    const store = new ResearchStore(client);
    await assert.rejects(client.execute("DELETE FROM research_portfolios WHERE id='shadow_A'"), /immutable/);
    assert.equal((await store.listPortfolios()).length, 2);
  } finally {
    client.close();
    if (process.platform !== 'win32') rmSync(path, { force: true });
  }
});
