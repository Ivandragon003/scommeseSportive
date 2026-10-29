const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { buildFrozenProspectiveObservations, prospectivePartition } = require('../dist/research/ResearchProspectiveEvidence');
const { ORIGINAL_HOLDOUT_POLICY } = require('../dist/research/ResearchHoldoutPolicy');

const START = '2026-10-29T02:12:00.000Z', KICKOFF = '2026-10-29T19:45:00.000Z', END = '2026-10-30T02:00:00.000Z';
const RESULT_AT = '2026-10-29T22:05:00.000Z';
const MATRIX = [[.2, .1], [.6, .1]], PROBABILITIES = { homeWin: .6, draw: .3, awayWin: .1 };
const config = (family) => ({ version: 'probability-configuration-v1', family, baselineVersion: 'A-fixture',
  probabilityProtocol: 'joint-goal-coherent-v2', pipelineHashV2: '1'.repeat(64), calibratorHash: '2'.repeat(64), mode: 'identity', temperature: 1 });
const quote = () => ({ market: '1x2', selection: 'homeWin', side: 'home', odds: 2, bookmaker: 'Fixture Book',
  source: 'odds_api', capturedAt: START, updatedAt: START, priceType: 'prematch' });
const matchIn = (partition) => Array.from({ length: 100 }, (_, i) => `prospective-match-${i}`).find((id) => prospectivePartition(id) === partition);

async function setup(options = {}) {
  const path = join(tmpdir(), `prospective-store-${randomUUID()}.db`), client = createClient({ url: `file:${path}` });
  for (const name of ['015_research_platform.sql', '020_research_nightly.sql', ...(options.withoutProspective ? [] : ['021_research_prospective.sql'])]) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
  }
  let now = Date.parse(START);
  const clock = () => new Date(now), store = new ResearchStore(client, async () => {}, { now: clock });
  await store.initializePortfolios();
  for (const family of ['A', 'C']) {
    await store.saveModel({ family, version: `${family}-fixture`, artifact: { family, fixture: true } });
    await store.setMarketState({ family, modelVersion: `${family}-fixture`, market: '1x2', state: 'EXPERIMENTAL' });
  }
  return { path, client, store, clock, setTime: (at) => { now = Date.parse(at); }, close() {
    client.close(); for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(path + suffix, { force: true }); } catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
    }
  } };
}
async function prepared(f, matchId = matchIn('CALIBRATION')) {
  const claim = await f.store.claimNightlyBatch({ startedAt: START, windowEndAt: END, fixtures: [{ matchId, kickoffAt: KICKOFF }] });
  const job = claim.jobs[0], quotes = [quote()];
  const decisions = ['A', 'C'].map((family) => ({ family, modelVersion: `${family}-fixture`, validated: true,
    action: 'ABSTAIN', reason: 'insufficient_validation_calibration', market: '', probabilityConfiguration: config(family),
    probabilityConfigurationHash: researchHash(config(family)), calibrationPipelineHash: '1'.repeat(64), calibrationAvailableAt: START,
    prospectiveMatrix: MATRIX, probabilityStages: { decision: PROBABILITIES } }));
  const observations = decisions.flatMap((decision) => buildFrozenProspectiveObservations({ matchId, family: decision.family,
    modelVersion: decision.modelVersion, probabilityConfigurationHash: decision.probabilityConfigurationHash,
    matrix: MATRIX, probabilities: PROBABILITIES, quotes, allowedMarkets: ['1x2'], forecastAt: START, kickoffAt: KICKOFF, quoteMaxAgeMs: 300000 }));
  return { jobId: job.id, leaseToken: job.leaseToken, decisions, observations,
    inputSnapshot: { mode: 'NIGHTLY', runId: claim.run.id, windowStartAt: START, observedAt: START,
      forecast: { baselineVersion: 'A-fixture' }, quotes, prospectiveObservations: observations } };
}
const official = (changes = {}) => ({ homeGoals: 1, awayGoals: 0, source: 'understat', resultKickoffAt: KICKOFF, ...changes });
const samples = (f, family = 'A', overrides = {}) => f.store.listProspectiveCalibrationSamples({ family,
  modelVersion: `${family}-fixture`, probabilityConfigurationHash: researchHash(config(family)), asOf: f.clock(), ...overrides });

test('ABSTAIN forecasts freeze independent prospective evidence atomically without bets or money changes', async () => {
  const f = await setup();
  try {
    const input = await prepared(f), before = await f.store.listLedger();
    const committed = await f.store.commitDecisions(input);
    assert.equal(committed.decisions.length, 2); assert.equal(committed.observations.length, 2); assert.equal(committed.bets.length, 0);
    const pending = await f.store.listPendingProspectiveObservations();
    assert.equal(pending.length, 2); assert.equal(new Set(pending.map((row) => row.inputId)).size, 1);
    assert.ok(pending.every((row) => row.snapshot.inputHash === researchHash(input.inputSnapshot) && row.frozenAt === START));
    assert.ok(pending.every((row) => row.partition === 'CALIBRATION' && /^[a-f0-9]{64}$/.test(row.modelArtifactHash)));
    assert.deepEqual(await f.store.listLedger(), before); assert.equal((await f.store.listBets()).length, 0);
    assert.deepEqual((await f.store.listPortfolios()).map((row) => row.equityCents), [100000, 100000]);
  } finally { f.close(); }
});

test('official results append payouts at the effective availability clock and repeat settlement never rewrites it', async () => {
  const f = await setup();
  try {
    await f.store.commitDecisions(await prepared(f));
    const row = (await f.store.listPendingProspectiveObservations())[0];
    await assert.rejects(f.store.settleProspectiveObservation(row.id, 2, official()), /unavailable/);
    f.setTime(RESULT_AT);
    const first = await f.store.settleProspectiveObservation(row.id, 2, official({ availableAt: KICKOFF }));
    assert.equal(first.availableAt, RESULT_AT); assert.equal(first.settled, true);
    assert.equal((await samples(f)).length, 1);
    assert.equal((await samples(f))[0].outcomeAvailableAt, RESULT_AT);
    assert.equal((await samples(f, 'A', { asOf: new Date(Date.parse(RESULT_AT) - 1) })).length, 0);
    f.setTime('2026-10-30T00:00:00.000Z');
    const repeated = await f.store.settleProspectiveObservation(row.id, 2, official());
    assert.equal(repeated.settled, false); assert.equal(repeated.availableAt, RESULT_AT);
    assert.equal((await f.store.listBets()).length, 0); assert.equal((await f.store.listLedger()).length, 2);
  } finally { f.close(); }
});

test('future-test reservation and exact model/configuration identity cannot enter residual calibration', async () => {
  for (const partition of ['CALIBRATION', 'FUTURE_TEST']) {
    const f = await setup();
    try {
      await f.store.commitDecisions(await prepared(f, matchIn(partition)));
      const rows = await f.store.listPendingProspectiveObservations();
      f.setTime(RESULT_AT);
      for (const row of rows) await f.store.settleProspectiveObservation(row.id, 2, official());
      assert.equal((await samples(f)).length, partition === 'CALIBRATION' ? 1 : 0);
      assert.equal((await samples(f, 'A', { modelVersion: 'A-another-version' })).length, 0);
      assert.equal((await samples(f, 'A', { probabilityConfigurationHash: 'f'.repeat(64) })).length, 0);
      await assert.rejects(samples(f, 'A', { asOf: '2026-10-30T00:00:00.000Z' }), /future/);
    } finally { f.close(); }
  }
});

test('lost responses retry the immutable input without duplicate observations, decisions or settlement evidence', async () => {
  const f = await setup();
  const second = createClient({ url: `file:${f.path}` });
  try {
    const input = await prepared(f), otherStore = new ResearchStore(second, async () => {}, { now: f.clock });
    await f.store.commitDecisions(input); await otherStore.commitDecisions(input);
    assert.equal((await f.store.listPendingProspectiveObservations()).length, 2);
    assert.equal((await f.store.listDecisions()).length, 2);
    const changed = { ...input, observations: structuredClone(input.observations), inputSnapshot: structuredClone(input.inputSnapshot) };
    changed.observations[0].expectedValue += .01;
    await assert.rejects(otherStore.commitDecisions(changed), /frozen in the shared input/);
    changed.inputSnapshot.prospectiveObservations = changed.observations;
    await assert.rejects(otherStore.commitDecisions(changed), /immutable/);
  } finally { second.close(); f.close(); }
});

test('invalid or post-hoc observation changes roll back inputs, decisions and observations as one transaction', async () => {
  for (const change of [
    (input) => { input.observations[0].probability = .7; },
    (input) => { input.observations[0].expectedValue = .9; },
    (input) => { input.observations[0].quote.odds = 3; },
    (input) => { input.observations[0].partition = 'FUTURE_TEST'; },
    (input) => { input.observations.push(input.observations[0]); },
    (input) => { delete input.decisions[0].prospectiveMatrix; },
  ]) {
    const f = await setup();
    try {
      const input = await prepared(f); change(input);
      input.inputSnapshot.prospectiveObservations = input.observations;
      await assert.rejects(f.store.commitDecisions(input));
      assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM research_inputs')).rows[0].n, 0);
      assert.equal((await f.store.listPendingProspectiveObservations()).length, 0);
      assert.equal((await f.store.listDecisions()).length, 0); assert.equal((await f.store.listLedger()).length, 2);
    } finally { f.close(); }
  }
});

test('expired leases and crossing kickoff during freeze cannot leave orphan evidence', async () => {
  const f = await setup();
  try {
    const input = await prepared(f); f.setTime(KICKOFF);
    await assert.rejects(f.store.commitDecisions(input), /lease lost|window closed/);
    assert.equal((await f.store.listPendingProspectiveObservations()).length, 0);
  } finally { f.close(); }
  const g = await setup();
  try {
    const input = await prepared(g), originalTransaction = g.client.transaction.bind(g.client);
    g.client.transaction = async (...args) => {
      const transaction = await originalTransaction(...args);
      const originalExecute = transaction.execute.bind(transaction);
      transaction.execute = async (statement) => {
        const result = await originalExecute(statement);
        if (/INSERT INTO research_prospective_observations/.test(statement.sql ?? statement)) g.setTime(KICKOFF);
        return result;
      };
      return transaction;
    };
    await assert.rejects(g.store.commitDecisions(input), /lease lost|window closed/);
    assert.equal((await g.store.listPendingProspectiveObservations()).length, 0);
    assert.equal((await g.store.listDecisions()).length, 0); assert.equal((await g.store.listLedger()).length, 2);
  } finally { g.close(); }
});

test('protected historical identities, future quote timestamps and mismatched pipeline configs are rejected', async () => {
  for (const variant of ['protected', 'future-quote', 'different-config']) {
    const f = await setup();
    try {
      const input = await prepared(f, variant === 'protected' ? ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds[0] : undefined);
      if (variant === 'protected') {
        input.observations = [{ protocol: 'prospective-residual-v1', partition: prospectivePartition(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds[0]),
          family: 'A', modelVersion: 'A-fixture', probabilityConfigurationHash: researchHash(config('A')), market: '1x2', bucket: 3,
          selection: 'homeWin', quote: quote(), probability: .6, expectedValue: .2 }];
      } else if (variant === 'future-quote') input.observations[0].quote.updatedAt = '2026-10-29T02:13:00.000Z';
      else input.decisions[0].probabilityConfigurationHash = 'f'.repeat(64);
      input.inputSnapshot.prospectiveObservations = input.observations;
      await assert.rejects(f.store.commitDecisions(input));
      assert.equal((await f.store.listPendingProspectiveObservations()).length, 0);
    } finally { f.close(); }
  }
});

test('observations and outcomes are append-only and cannot accept a payout unrelated to the frozen quote', async () => {
  const f = await setup();
  try {
    await f.store.commitDecisions(await prepared(f));
    const row = (await f.store.listPendingProspectiveObservations())[0];
    f.setTime(RESULT_AT);
    await assert.rejects(f.store.settleProspectiveObservation(row.id, 0, official()), /frozen quote/);
    await f.store.settleProspectiveObservation(row.id, 2, official());
    await assert.rejects(f.store.settleProspectiveObservation(row.id, 0, official({ homeGoals: 0, awayGoals: 1 })), /immutable/);
    for (const table of ['research_prospective_observations', 'research_prospective_results']) {
      await assert.rejects(f.client.execute(`DELETE FROM ${table}`), /immutable/);
      await assert.rejects(f.client.execute(`UPDATE ${table} SET ${table.endsWith('results') ? 'available_at' : 'observed_at'}='2026-01-01T00:00:00.000Z'`), /immutable/);
    }
  } finally { f.close(); }
});

test('old schemas stay readable and explicit observations require additive migration 021', async () => {
  const f = await setup({ withoutProspective: true });
  try {
    assert.deepEqual(await f.store.listPendingProspectiveObservations(), []); assert.deepEqual(await samples(f), []);
    assert.equal(await f.store.countNightlyProspectiveObservations('unknown'), 0);
    await assert.rejects(f.store.commitDecisions(await prepared(f)), /migration 021/);
    assert.equal((await f.store.listDecisions()).length, 0);
  } finally { f.close(); }
});

test('a fresh reporting store counts persisted nightly observations with read-only SQL, including lost-response retries', async () => {
  const f = await setup();
  try {
    const input = await prepared(f); await f.store.commitDecisions(input); await f.store.commitDecisions(input);
    const statements = [];
    const client = new Proxy(f.client, { get(target, key) {
      if (key === 'execute') return (statement) => { statements.push(typeof statement === 'string' ? statement : statement.sql); return target.execute(statement); };
      if (key === 'executeMultiple' || key === 'transaction') return () => { throw new Error('reporting must not write'); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const fresh = new ResearchStore(client, async () => {}, { now: f.clock });
    assert.equal(await fresh.countNightlyProspectiveObservations(input.inputSnapshot.runId), 2);
    assert.equal(await fresh.countNightlyProspectiveObservations('unknown'), 0);
    assert.equal(statements.length, 3); assert.ok(statements.every((sql) => /^SELECT/i.test(sql.trim())));
  } finally { f.close(); }
});

test('official settlement rechecks persisted fixture goals and provenance without accepting caller-supplied outcomes', async () => {
  const f = await setup();
  try {
    const matchId = matchIn('CALIBRATION');
    await f.client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,home_goals INTEGER,away_goals INTEGER,source TEXT)');
    await f.client.execute({ sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL,?)', args: [matchId, KICKOFF, 'understat'] });
    await f.store.commitDecisions(await prepared(f, matchId));
    const row = (await f.store.listPendingProspectiveObservations())[0]; f.setTime(RESULT_AT);
    await assert.rejects(f.store.settleProspectiveObservation(row.id, 2, official()), /stored fixture/);
    await f.client.execute('UPDATE matches SET home_goals=1,away_goals=0');
    await assert.rejects(f.store.settleProspectiveObservation(row.id, 2, official({ source: 'unverified' })), /stored fixture/);
    assert.equal((await f.store.settleProspectiveObservation(row.id, 2, official())).settled, true);
    assert.equal((await samples(f)).length, 1); assert.equal((await f.store.listLedger()).length, 2);
  } finally { f.close(); }
});

test('official corrections append quarantine evidence while historical as-of reads preserve the original known label', async () => {
  for (const correction of ['score', 'kickoff']) {
    const f = await setup();
    try {
      const matchId = matchIn('CALIBRATION');
      await f.client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,home_goals INTEGER,away_goals INTEGER,source TEXT)');
      await f.client.execute({ sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL,?)', args: [matchId, KICKOFF, 'understat'] });
      await f.store.commitDecisions(await prepared(f, matchId));
      const row = (await f.store.listPendingProspectiveObservations())[0];
      f.setTime(RESULT_AT); await f.client.execute('UPDATE matches SET home_goals=1,away_goals=0');
      await f.store.settleProspectiveObservation(row.id, 2, official());
      assert.equal((await samples(f)).length, 1);
      const original = (await f.client.execute({ sql: `SELECT o.snapshot_json,r.* FROM research_prospective_observations o
        JOIN research_prospective_results r ON r.observation_id=o.id WHERE o.id=?`, args: [row.id] })).rows[0];
      const ledger = await f.store.listLedger();
      f.setTime('2026-10-29T22:10:00.000Z');
      await f.client.execute(correction === 'score' ? 'UPDATE matches SET home_goals=0,away_goals=1'
        : "UPDATE matches SET date='2026-10-29T20:45:00.000Z'");
      // Direct current lookup must fail closed even without a preceding orchestration call.
      assert.deepEqual(await samples(f), []);
      const quarantine = (await f.client.execute('SELECT * FROM research_prospective_invalidations')).rows;
      assert.equal(quarantine.length, 1); assert.equal(quarantine[0].detected_at, '2026-10-29T22:10:00.000Z');
      assert.equal(quarantine[0].reason, correction === 'score' ? 'official_result_corrected' : 'official_kickoff_changed');
      const past = await samples(f, 'A', { asOf: '2026-10-29T22:09:59.999Z' });
      assert.equal(past.length, 1); assert.equal(past[0].returnMultiplier, 2); assert.equal(past[0].outcomeAvailableAt, RESULT_AT);
      assert.deepEqual(await f.store.reconcileProspectiveEvidence(), { checked: 0, invalidated: 0 });
      const after = (await f.client.execute({ sql: `SELECT o.snapshot_json,r.* FROM research_prospective_observations o
        JOIN research_prospective_results r ON r.observation_id=o.id WHERE o.id=?`, args: [row.id] })).rows[0];
      assert.deepEqual(after, original); assert.deepEqual(await f.store.listLedger(), ledger);
      await assert.rejects(f.client.execute('DELETE FROM research_prospective_invalidations'), /immutable/);
      await assert.rejects(f.client.execute("UPDATE research_prospective_invalidations SET detected_at='2026-01-01T00:00:00.000Z'"), /immutable/);
      if (correction === 'score') await assert.rejects(f.store.settleProspectiveObservation(row.id, 0,
        official({ homeGoals: 0, awayGoals: 1 })), /immutable/);
    } finally { f.close(); }
  }
});

test('prospective refund and quarter-line payouts reuse settlement rules without virtual stake movements', async () => {
  for (const [market, line, multiplier] of [['dnb', undefined, 1], ['asian_handicap', .25, 1.5], ['asian_handicap', -.25, .5]]) {
    const f = await setup();
    try {
      const input = await prepared(f), matchId = matchIn('CALIBRATION');
      const selectedQuote = { ...quote(), market, side: 'home', selection: `${market}:${line ?? ''}`, ...(line === undefined ? {} : { line }) };
      for (const family of ['A', 'C']) await f.store.setMarketState({ family, modelVersion: `${family}-fixture`, market, state: 'EXPERIMENTAL' });
      input.inputSnapshot.quotes = [selectedQuote];
      input.observations = input.decisions.flatMap((decision) => buildFrozenProspectiveObservations({ matchId,
        family: decision.family, modelVersion: decision.modelVersion, probabilityConfigurationHash: decision.probabilityConfigurationHash,
        matrix: MATRIX, probabilities: PROBABILITIES, quotes: [selectedQuote], allowedMarkets: [market], forecastAt: START, kickoffAt: KICKOFF, quoteMaxAgeMs: 300000 }));
      input.inputSnapshot.prospectiveObservations = input.observations;
      assert.equal(input.observations.length, 2);
      await f.store.commitDecisions(input); f.setTime(RESULT_AT);
      for (const row of await f.store.listPendingProspectiveObservations()) {
        assert.equal((await f.store.settleProspectiveObservation(row.id, multiplier, official({ homeGoals: 0, awayGoals: 0 }))).settled, true);
      }
      assert.equal((await samples(f))[0].returnMultiplier, multiplier);
      assert.equal((await f.store.listBets()).length, 0); assert.equal((await f.store.listLedger()).length, 2);
    } finally { f.close(); }
  }
});

test('migration 021 repeats without replacing evidence or touching existing ledgers', async () => {
  const f = await setup();
  try {
    await f.store.commitDecisions(await prepared(f));
    const before = await f.store.listPendingProspectiveObservations(), ledger = await f.store.listLedger();
    await f.client.executeMultiple(readFileSync(join(__dirname, '../migrations/021_research_prospective.sql'), 'utf8'));
    assert.deepEqual(await f.store.listPendingProspectiveObservations(), before); assert.deepEqual(await f.store.listLedger(), ledger);
  } finally { f.close(); }
});
