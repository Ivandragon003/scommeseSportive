const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join, resolve, basename, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const compiled = process.env.RESEARCH_TEST_DIST || '../dist';
const moduleOf = file => require(resolve(__dirname, compiled, 'research', file));
const { ResearchStore, researchHash } = moduleOf('ResearchStore');
const { prospectivePartition, settleProspectiveEvidence } = moduleOf('ResearchProspectiveEvidence');

const KICKOFF = '2026-10-30T18:00:00.000Z';
const CONFLICTING_KICKOFF = '2026-10-30T16:15:00.000Z';
const OBSERVED = '2026-10-30T17:35:04.172Z';
const RESULT_AT = '2026-10-31T02:00:00.000Z';
const quote = { market: '1x2', side: 'home', selection: 'homeWin', odds: 2, bookmaker: 'Synthetic test bookmaker',
  source: 'odds_api', capturedAt: OBSERVED, updatedAt: OBSERVED };

async function fixture(options = {}) {
  const directory = mkdtempSync(join(process.env.CHALLENGER_KICKOFF_TEST_DIRECTORY || tmpdir(), 'challenger-kickoff-'));
  const path = join(directory, 'test.db'), client = createClient({ url: `file:${path}` });
  for (const file of ['015_research_platform.sql', '021_research_prospective.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', file), 'utf8'));
  }
  await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,home_goals INTEGER,away_goals INTEGER,source TEXT)');
  const family = options.family ?? 'C', modelVersion = `${family}-synthetic-fixture`, configurationHash = researchHash({ family });
  const matchId = Array.from({ length: 100 }, (_, index) => `challenger-kickoff-fixture-${index}`)
    .find(id => prospectivePartition(id) === 'CALIBRATION');
  const currentKickoff = options.currentKickoff ?? KICKOFF;
  const observation = { kickoffAt: options.kickoffAt ?? KICKOFF, observedAt: options.observedAt ?? OBSERVED,
    frozenAt: options.frozenAt ?? OBSERVED };
  await client.execute({ sql: 'INSERT INTO research_models(family,version,artifact_json,artifact_hash,created_at) VALUES (?,?,?,?,?)',
    args: [family, modelVersion, '{}', researchHash({}), OBSERVED] });
  await client.execute({ sql: `INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,status,created_at,updated_at)
    VALUES ('job',?,?,?,'COMPLETED',?,?)`, args: [matchId, KICKOFF, OBSERVED, OBSERVED, OBSERVED] });
  await client.execute({ sql: `INSERT INTO research_inputs(id,job_id,input_hash,snapshot_json,captured_at,kickoff_at)
    VALUES ('input','job',?,'{}',?,?)`, args: [researchHash({}), OBSERVED, KICKOFF] });
  await client.execute({ sql: `INSERT INTO research_prospective_observations(id,job_id,input_id,match_id,family,model_version,
    model_artifact_hash,configuration_hash,market,bucket,partition,protocol,probability,expected_value,odds,observed_at,frozen_at,kickoff_at,snapshot_json)
    VALUES ('observation','job','input',?,?,?,?,?,'1x2',3,'CALIBRATION','prospective-residual-v1',.6,.2,2,?,?,?,?)`,
  args: [matchId, family, modelVersion, researchHash({}), configurationHash, observation.observedAt,
    observation.frozenAt, observation.kickoffAt, JSON.stringify({ quote })] });
  await client.execute({ sql: 'INSERT INTO matches(match_id,date,home_goals,away_goals,source) VALUES (?,?,1,0,?)',
    args: [matchId, currentKickoff, 'understat'] });
  await client.execute({ sql: 'INSERT INTO research_portfolios(id,family,created_at) VALUES (?,?,?)', args: [`shadow_${family}`, family, OBSERVED] });
  await client.execute({ sql: `INSERT INTO research_ledger(id,portfolio_id,event,available_delta_cents,committed_delta_cents,created_at)
    VALUES ('opening',?,'OPEN',100000,0,?)`, args: [`shadow_${family}`, OBSERVED] });
  const official = (kickoff = currentKickoff) => ({ homeGoals: 1, awayGoals: 0, source: 'understat', resultKickoffAt: kickoff });
  if (options.legacyResult) {
    const evidence = { matchId, ...official(), status: 'WON' };
    await client.execute({ sql: `INSERT INTO research_prospective_results(observation_id,return_multiplier,evidence_hash,evidence_json,available_at)
      VALUES ('observation',2,?,?,?)`, args: [researchHash(evidence), JSON.stringify(evidence), RESULT_AT] });
  }
  const store = new ResearchStore(client, async () => {}, { now: () => new Date(RESULT_AT) });
  const samples = () => store.listProspectiveCalibrationSamples({ family, modelVersion, probabilityConfigurationHash: configurationHash, asOf: RESULT_AT });
  const originals = async () => JSON.stringify({ observations: (await client.execute('SELECT * FROM research_prospective_observations')).rows,
    results: (await client.execute('SELECT * FROM research_prospective_results')).rows,
    bets: (await client.execute('SELECT * FROM research_bets')).rows, ledger: (await client.execute('SELECT * FROM research_ledger')).rows });
  const close = () => {
    client.close();
    if (process.env.CHALLENGER_KICKOFF_TEST_DIRECTORY) return;
    const target = resolve(directory), root = resolve(tmpdir());
    assert.ok(target.startsWith(`${root}${sep}`) && basename(target).startsWith('challenger-kickoff-'));
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { client, store, samples, originals, close, official, matchId };
}

if (process.platform === 'win32' && !process.env.CHALLENGER_KICKOFF_TEST_DIRECTORY) {
  test('six C kickoff cases run with native SQLite handles isolated until process exit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'challenger-kickoff-suite-'));
    try {
      const environment = { ...process.env, CHALLENGER_KICKOFF_TEST_DIRECTORY: directory };
      delete environment.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', __filename], {
        cwd: process.cwd(), encoding: 'utf8', env: environment, timeout: 120000 });
      process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
      assert.equal(child.status, 0, child.error?.message || 'C kickoff cases failed');
      assert.match(child.stdout, /# tests 6\b/); assert.match(child.stdout, /# fail 0\b/);
    } finally {
      const target = resolve(directory), root = resolve(tmpdir());
      assert.ok(target.startsWith(`${root}${sep}`) && basename(target).startsWith('challenger-kickoff-suite-'));
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
} else {
test('C refuses a conflicting kickoff before first settlement and quarantines pending evidence without choosing a true source', async () => {
  const f = await fixture({ currentKickoff: CONFLICTING_KICKOFF });
  try {
    const before = await f.originals();
    await assert.rejects(f.store.settleProspectiveObservation('observation', 2, f.official()), /c_prospective_kickoff_conflict/);
    assert.deepEqual(await f.store.reconcileProspectiveEvidence(), { checked: 1, invalidated: 1 });
    const invalidation = (await f.client.execute('SELECT reason FROM research_prospective_invalidations')).rows[0];
    assert.equal(invalidation.reason, 'c_prospective_kickoff_conflict');
    assert.deepEqual(await f.store.listPendingProspectiveObservations(), []);
    assert.deepEqual(await settleProspectiveEvidence({ research: f.store, getMatchById: async () => assert.fail('Quarantined C must not reach settlement') }),
      { checked: 0, settled: 0, unresolved: 0 });
    assert.equal(await f.originals(), before);
    await f.client.execute({ sql: 'UPDATE matches SET date=?', args: [KICKOFF] });
    await assert.rejects(f.store.settleProspectiveObservation('observation', 2, f.official(KICKOFF)), /c_prospective_evidence_quarantined/);
  } finally { f.close(); }
});

test('C excludes an old label whose first official result already contained the conflicting kickoff', async () => {
  const f = await fixture({ currentKickoff: CONFLICTING_KICKOFF, legacyResult: true });
  try {
    const before = await f.originals();
    assert.deepEqual(await f.samples(), []);
    assert.equal(await f.originals(), before);
    assert.equal((await f.client.execute('SELECT reason FROM research_prospective_invalidations')).rows[0].reason, 'c_prospective_kickoff_conflict');
    assert.deepEqual(await f.store.reconcileProspectiveEvidence(), { checked: 0, invalidated: 0 });
  } finally { f.close(); }
});

test('C refuses invalid or timezone-less frozen forecast timestamps before inserting any result', async () => {
  for (const values of [{ observedAt: 'invalid' }, { frozenAt: '2026-10-30T17:35:00' }, { kickoffAt: 'unknown' }]) {
    const f = await fixture(values);
    try {
      const before = await f.originals();
      await assert.rejects(f.store.settleProspectiveObservation('observation', 2, f.official()), /c_prospective_timestamp_invalid/);
      assert.equal((await f.store.reconcileProspectiveEvidence()).invalidated, 1);
      assert.equal(await f.originals(), before);
    } finally { f.close(); }
  }
});

test('C observations and captures must both precede a consistent recorded kickoff strictly', async () => {
  for (const values of [{ observedAt: KICKOFF, frozenAt: KICKOFF }, { frozenAt: KICKOFF }]) {
    const f = await fixture(values);
    try {
      await assert.rejects(f.store.settleProspectiveObservation('observation', 2, f.official()), /c_prospective_not_before_recorded_kickoff/);
      assert.equal((await f.store.reconcileProspectiveEvidence()).invalidated, 1);
      assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM research_prospective_results')).rows[0].n, 0);
    } finally { f.close(); }
  }
});

test('valid C evidence remains usable and a later kickoff conflict is quarantined append-only', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.store.reconcileProspectiveEvidence(), { checked: 0, invalidated: 0 });
    assert.equal((await f.store.settleProspectiveObservation('observation', 2, f.official())).settled, true);
    assert.equal((await f.samples()).length, 1);
    const original = await f.originals();
    await f.client.execute({ sql: 'UPDATE matches SET date=?', args: [CONFLICTING_KICKOFF] });
    assert.deepEqual(await f.samples(), []);
    assert.equal(await f.originals(), original);
    assert.equal((await f.client.execute('SELECT reason FROM research_prospective_invalidations')).rows[0].reason, 'c_prospective_kickoff_conflict');
  } finally { f.close(); }
});

test('the pre-existing A settlement and residual path is unchanged by the C-only guard', async () => {
  const f = await fixture({ family: 'A', currentKickoff: CONFLICTING_KICKOFF });
  try {
    assert.equal((await f.store.settleProspectiveObservation('observation', 2, f.official())).settled, true);
    assert.equal((await f.samples()).length, 1);
    assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM research_prospective_invalidations')).rows[0].n, 0);
    assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM research_bets')).rows[0].n, 0);
    assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM research_ledger')).rows[0].n, 1);
  } finally { f.close(); }
});
}
