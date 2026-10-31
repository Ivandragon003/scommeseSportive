const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { previewRecommendations, main, FINANCIAL_QUERIES } = require('../scripts/preview-recommendations');
const { EXPECTED_HOST } = require('../scripts/probe-research-ml-runtime');
const started = new Date('2026-10-30T10:00:00Z');
const windowEnd = new Date('2026-10-31T02:07:00Z');
const env = () => ({ TURSO_DATABASE_URL: `libsql://${EXPECTED_HOST}`, TURSO_AUTH_TOKEN: 'private-rw-sentinel',
  ODDS_API_KEY: 'private-odds-sentinel', RESEARCH_NIGHTLY_MINUTE: '7', RESEARCH_T15_SCHEDULER_ENABLED: 'false' });
function fixture(options = {}) {
  const calls = { prepared: [], queries: [], closed: 0, created: [], cohort: [] };
  const fixtures = options.fixtures ?? Array.from({ length: 5 }, (_, index) => ({ match_id: `real-match-${index}`,
    competition: 'Serie A', date: `2026-10-30T1${index + 1}:00:00Z`, home_goals: null, away_goals: null }));
  const origins = fixtures.map((row) => ({ id: `stored-job-${row.match_id}`, matchId: row.match_id, runId: 'stored-run',
    inputId: `stored-input-${row.match_id}` }));
  const tables = { research_bets: [], research_ledger: [{ id: 'ledger-opening-A', available_delta_cents: 100000 }],
    research_settlements: [], ...(options.executionSchema ? { research_execution_jobs: [], research_execution_inputs: [], research_execution_decisions: [] } : {}) };
  const db = {
    research: new Proxy({ listPortfolios: async () => [
      { id: 'shadow_A', family: 'A', equityCents: 100000, availableCents: 100000, committedCents: 0 },
      { id: 'shadow_C', family: 'C', equityCents: 100000, availableCents: 100000, committedCents: 0 },
    ], listJobs: async () => origins,
    listDecisions: async ({ jobId }) => {
      const origin = origins.find((row) => row.id === jobId);
      if (options.missingOrigins) return [];
      return ['A', 'C'].map((family) => ({ id: `stored-${family}-${jobId}`, family, inputId: origin.inputId }));
    } }, { get(target, key) { if (!(key in target)) throw Error(`forbidden finance API ${String(key)}`); return target[key]; } }),
    getUpcomingMatches: async (query) => { calls.calendar = query; return fixtures; },
    execute: async (sql) => {
      calls.queries.push(sql); assert.match(sql, /^SELECT\s/); assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/);
      if (/sqlite_master/.test(sql)) return { rows: Object.keys(tables).map((name) => ({ name })) };
      if (/FROM smart_odds_budgets/.test(sql)) return { rows: [{ measured_used: 295, measured_remaining: 205 }] };
      if (/FROM smart_odds_requests/.test(sql)) return { rows: [{ requests: calls.prepared.length, charged: 0, measured: 0 }] };
      const table = /FROM\s+([a-z_]+)/.exec(sql)?.[1]; assert.ok(table in tables, `unexpected table ${table}`);
      return { rows: tables[table] };
    }, close: async () => { calls.closed++; },
  };
  Object.defineProperty(db, 'recommendations', { get() { throw Error('execution API forbidden'); } });
  const createDatabase = async (settings) => { calls.created.push(settings); return db; };
  const createRuntime = (database, settings) => {
    assert.equal(database, db);
    calls.runtimeSettings = settings;
    return { beginCohort: (id) => calls.cohort.push(id), prepare: async (job) => {
      calls.prepared.push(job);
      assert.ok(origins.some((origin) => origin.id === job.id && origin.inputId === job.originInputId));
      assert.equal(job.preview, true);
      if (options.failure) { console.error('private-log-sentinel'); throw Error('libsql://secret/?auth=private-rw-sentinel'); }
      if (options.mutateMoney) tables.research_ledger.push({ id: 'illegal-stake', available_delta_cents: -1000 });
      if (options.mutateExecution) tables.research_execution_jobs.push({ id: 'illegal-execution' });
      const quote = { odds: 2, bookmaker: 'Real Book', source: 'odds_api', priceType: 'prematch', capturedAt: started.toISOString(), updatedAt: started.toISOString() };
      return { jobId: job.id, originInputId: job.originInputId, inputSnapshot: { observedAt: started.toISOString(),
        forecasts: { A: { model: { source: 'PredictionService', codeHash: '1'.repeat(64), configHash: '2'.repeat(64), stateHash: '3'.repeat(64) } },
          C: { decision: { validated: !settings?.deploymentC?.resolutionUnavailable }, recommendation: {} } } }, decisions: ['A', 'C'].map((family) => ({
        family, action: family === 'C' && settings?.deploymentC?.resolutionUnavailable ? 'ABSTAIN' : 'BET',
        ...(family === 'C' && settings?.deploymentC?.resolutionUnavailable ? { reason: 'adoption_state_unavailable' } : {}),
        recommended: !(family === 'C' && settings?.deploymentC?.resolutionUnavailable), validated: true, probability: .6, ev: options.invalidEv ? 0 : .2,
        modelVersion: family === 'A' ? `APP-A-${'a'.repeat(20)}` : 'C-906371b0b3a1e2c8',
        suggestedStakePercent: family === 'A' ? 2.34 : 4, confidence: 'MEDIUM', quote,
      })) };
    } };
  };
  return { calls, tables, db, options: { env: env(), clock: () => started, nextBoundary: (date, hour, minute) => {
    assert.equal(date, started); assert.equal(hour, 3); assert.equal(minute, 7); return windowEnd;
  }, createDatabase, createRuntime } };
}

test('preview snapshots the approved C deployment once without reviewing, adopting or changing finances', async () => {
  const f = fixture(); let reads = 0;
  const deployment = { deployment: { modelVersion: 'C-approved-test', baselineVersion: 'A-80cb25df5552621e',
    selectorPolicy: 'payout-aware-v1', probabilityConfigurationHash: 'a'.repeat(64), artifactHash: 'b'.repeat(64) },
  revision: 'approved-revision', source: 'adopted' };
  f.db.challengerAdoption = { getState: async () => { reads++; return deployment; },
    reviewCandidates: async () => assert.fail('Preview must not mutate adoption state') };
  const report = await previewRecommendations(f.options);
  assert.equal(reads, 1); assert.deepEqual(f.calls.runtimeSettings, { deploymentC: deployment });
  assert.equal(report.financialUnchanged, true); assert.equal(report.registeredBets, 0);
});

test('preview passes an explicit unavailable C state after a registry read failure and preserves A preparation', async () => {
  const f = fixture();
  f.db.challengerAdoption = { getState: async () => { throw Error('Private registry failure'); },
    reviewCandidates: async () => assert.fail('Preview must never review') };
  const report = await previewRecommendations(f.options);
  assert.equal(f.calls.runtimeSettings.deploymentC.resolutionUnavailable, true);
  assert.ok(report.records.filter((row) => row.family === 'A').every((row) => row.recommended));
  assert.ok(report.records.filter((row) => row.family === 'C').every((row) => !row.recommended && row.reason === 'adoption_state_unavailable'));
  assert.equal(report.financialUnchanged, true); assert.equal(report.registeredBets, 0);
});

test('preview before migration023 prepares actual-origin A/C packets and leaves all financial state identical', async () => {
  const f = fixture(); const report = await previewRecommendations(f.options);
  assert.deepEqual(f.calls.created, [{ skipSchemaBootstrap: true }]); assert.equal(f.calls.closed, 1);
  assert.equal(report.checkedMatches, 5); assert.equal(report.records.length, 10);
  assert.deepEqual(report.inference, { A: 5, C: 5 }); assert.equal(report.registeredBets, 0);
  assert.equal(report.financialUnchanged, true); assert.deepEqual(report.financialBefore, report.financialAfter);
  assert.equal(report.financialBefore.research_execution_jobs.present, false);
  assert.ok(report.records.every((row) => row.recommended && row.fresh && row.real && row.originVerified));
  assert.ok(report.records.filter((row) => row.family === 'A').every((row) => row.stakePercent === 2.34 && row.intendedCents === 2340));
  assert.ok(report.records.filter((row) => row.family === 'C').every((row) => row.stakePercent === 1 && row.intendedCents === 1000));
  assert.doesNotMatch(JSON.stringify(report), /private-|bookmaker|"quote"|stateHash|user_id|session_id|libsql:/);
  assert.equal(f.calls.prepared.length, 5);
});

test('preview enforces the future Top5 window and ten-fixture cap before model/API preparation', async () => {
  const fixtures = Array.from({ length: 20 }, (_, index) => ({ match_id: `future-${String(index).padStart(2, '0')}`, competition: 'Serie A', date: '2026-10-30T19:00:00Z' }));
  fixtures.unshift({ match_id: 'already-started', competition: 'Serie A', date: '2026-10-30T09:00:00Z' },
    { match_id: 'already-settled', competition: 'Serie A', date: '2026-10-30T19:00:00Z', home_goals: 1 },
    { match_id: 'after-window', competition: 'Serie A', date: '2026-10-31T02:08:00Z' },
    { match_id: 'other-league', competition: 'Serie B', date: '2026-10-30T19:00:00Z' });
  const f = fixture({ fixtures }); const report = await previewRecommendations(f.options);
  assert.equal(f.calls.prepared.length, 10); assert.equal(report.records.length, 20);
  assert.ok(f.calls.prepared.every((job) => job.matchId.startsWith('future-')));
  assert.equal(report.windowEndAt, windowEnd.toISOString());
});

test('missing immutable origins are skipped without manufacturing IDs or instantiating a runtime', async () => {
  const f = fixture({ missingOrigins: true });
  f.options.createRuntime = () => { throw Error('must not instantiate'); };
  const report = await previewRecommendations(f.options);
  assert.equal(report.checkedMatches, 0); assert.equal(report.skipped.length, 5);
  assert.ok(report.skipped.every((row) => row.reason === 'origin_records_missing'));
  assert.equal(f.calls.prepared.length, 0); assert.equal(report.financialUnchanged, true);
});

test('financial changes and execution records are detected rather than restored or silently accepted', async () => {
  for (const settings of [{ mutateMoney: true }, { executionSchema: true, mutateExecution: true }]) {
    const f = fixture(settings);
    await assert.rejects(previewRecommendations(f.options), { code: 'preview_financial_state_changed' });
    assert.equal(f.calls.closed, 1);
  }
});

test('invalid positive recommendation semantics fail closed and preserve financial evidence', async () => {
  const f = fixture({ invalidEv: true });
  await assert.rejects(previewRecommendations(f.options), { code: 'preview_recommendation_invalid' });
  assert.equal(f.calls.closed, 1);
});

test('preview checks the fixed target and required write/odds secrets before any database access', async () => {
  for (const patch of [{ TURSO_DATABASE_URL: 'libsql://old-source.invalid' }, { TURSO_AUTH_TOKEN: '' },
    { ODDS_API_KEY: '' }, { RESEARCH_T15_SCHEDULER_ENABLED: 'true' }, { RESEARCH_NIGHTLY_MINUTE: '0' }]) {
    const f = fixture(); f.options.env = { ...env(), ...patch };
    await assert.rejects(previewRecommendations(f.options), { code: 'preview_configuration_invalid' });
    assert.equal(f.calls.created.length, 0);
  }
});

test('CLI redacts service logs and raw errors, closes the database and restores console methods', async () => {
  const f = fixture({ failure: true }), output = [], errors = [], original = console.error;
  const code = await main({ ...f.options, log: (value) => output.push(value), error: (value) => errors.push(value) });
  assert.equal(code, 1); assert.equal(f.calls.closed, 1); assert.equal(console.error, original);
  assert.equal(output.length, 0); assert.equal(JSON.parse(errors[0]).code, 'preview_preparation_failed');
  assert.doesNotMatch(errors.join(''), /private-|libsql|stack|quote/);
});

test('manual workflow defaults to isolated RO verification and exposes RW/odds secrets only to the selected preview job', () => {
  const workflow = readFileSync(join(__dirname, '../../.github/workflows/research-runtime-verification.yml'), 'utf8');
  assert.match(workflow, /default: registered-c/); assert.match(workflow, /type: choice/);
  const ro = workflow.slice(workflow.indexOf('  verify-runtime:'), workflow.indexOf('  preview-recommendations:'));
  const preview = workflow.slice(workflow.indexOf('  preview-recommendations:'));
  assert.match(ro, /inputs\.mode == 'registered-c'/); assert.match(ro, /secrets\.TURSO_WATCHDOG_READONLY_TOKEN/);
  assert.doesNotMatch(ro, /TURSO_AUTH_TOKEN|ODDS_API_KEY|preview-recommendations\.js/);
  assert.match(preview, /if:.*inputs\.mode == 'recommendations-preview'/);
  assert.match(preview, /secrets\.TURSO_AUTH_TOKEN/); assert.match(preview, /secrets\.ODDS_API_KEY/);
  assert.doesNotMatch(preview, /TURSO_WATCHDOG_READONLY_TOKEN/);
  assert.match(preview, /RESEARCH_NIGHTLY_MINUTE: '7'/); assert.match(preview, /RESEARCH_T15_SCHEDULER_ENABLED: 'false'/);
  assert.match(preview, /run: node scripts\/preview-recommendations\.js/);
  assert.doesNotMatch(workflow, /schedule:|push:|workflow_run:|upload-artifact|research-nightly\.js|pip install/);
  assert.ok(Object.values(FINANCIAL_QUERIES).every((sql) => /^SELECT\s/.test(sql)));
});
