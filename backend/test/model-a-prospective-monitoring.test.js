const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { main } = require('../scripts/check-model-a-prospective');
const { evaluate } = require('../scripts/model-a-prospective-alerts');

const childSource = String.raw`
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { createClient } = require('@libsql/client');
const { readModelAProspectiveMonitoring } = require('./dist/research/ModelAProspectiveMonitoring');
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const client = createClient({ url: input.url });
  const kickoff = '2026-11-04T18:00:00.000Z', cutoff = '2026-11-04T19:00:00.000Z';
  const snapshot = { protocolId: 'monitor-test', seasons: ['2026/27'], from: '2026-11-04T00:00:00.000Z', to: '2026-11-07T00:00:00.000Z',
    competitions: ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'], origin: 'prospective_a', window: 'T-24h..T-60min inclusive' };
  const sha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  try {
    await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,competition TEXT,season TEXT,date TEXT)');
    if (input.scenario !== 'absent') {
      await client.executeMultiple(fs.readFileSync('experiments/model-a-prospective/schema.sql','utf8'));
      await client.execute({ sql:'INSERT INTO model_a_collection_protocols VALUES(?,?,?)', args:['monitor-test',JSON.stringify({snapshot,sha256}),'2026-11-04T10:00:00Z'] });
      await client.execute({sql:'INSERT INTO model_a_prospective_result_refresh_state(refresh_id,last_started_at,last_completed_at,last_success_at,last_status) VALUES(?,?,?,?,?)',args:['understat-results-v1','2026-11-04T18:00:00Z','2026-11-04T18:01:00Z','2026-11-04T18:01:00Z','completed']});
      await client.execute({ sql:'INSERT INTO model_a_collection_runs(run_id,protocol_id,started_at,completed_at,status) VALUES(?,?,?,?,?)',args:['run','monitor-test','2026-11-04T18:00:00Z','2026-11-04T18:01:00Z',input.scenario === 'failed' ? 'failed' : 'success'] });
    }
    if (!['absent','empty'].includes(input.scenario)) {
      for (const id of (input.scenario === 'technical-healthy' ? ['stored'] : ['stored','pending','missing'])) await client.execute({sql:'INSERT INTO matches VALUES(?,?,?,?)',args:[id,'Serie A','2026/27',kickoff]});
      if (input.scenario !== 'technical-healthy') await client.execute({sql:'INSERT INTO matches VALUES(?,?,?,?)',args:['invalid','Serie A','2026/27','timezone-unknown']});
      await client.execute({sql:'INSERT INTO matches VALUES(?,?,?,?)',args:['other','Other','2026/27',kickoff]});
      const payload = {schema:'model-a-operational-prospective-v1',family:'A',id:'stored',matchId:'stored',forecastAt:'2026-11-04T12:00:00Z',kickoffAt:kickoff,origin:'prospective_a',competition:'Serie A',season:'2026/27',collection:{protocolId:'monitor-test',manifestSha256:sha256,claimId:'stored-claim'},provenance:{classification:'technical_only',rigorousEligible:false}};
      await client.execute({sql:'INSERT INTO model_a_prospective_forecasts VALUES(?,?,?,?,?)',args:[payload.id,payload.matchId,payload.forecastAt,payload.kickoffAt,JSON.stringify(payload)]});
      for (const [id,state,reason] of [['stored','stored','forecast_confirmed'],['pending','unconfirmed','delivery_unconfirmed']]) {
        await client.execute({sql:'INSERT INTO model_a_collection_ledger(protocol_id,match_id,kickoff_at,competition,season,state,reason,claim_at,forecast_id,updated_at,claim_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',args:['monitor-test',id,kickoff,'Serie A','2026/27',state,reason,'2026-11-04T12:00:00Z',id === 'stored' ? 'stored' : null,'2026-11-04T18:00:00Z',id+'-claim']});
      }
      await client.execute({sql:'INSERT INTO model_a_prospective_result_observations VALUES(?,?,?,?,?,?,?,?,?)',args:['obs','stored','understat',kickoff,'2026-11-04T18:30:00Z','2026-11-04T18:31:00Z',['linked','canceled','technical-healthy'].includes(input.scenario) ? 'final' : input.scenario === 'not-final' ? 'not_final' : 'unverified','kickoff_changed',['linked','canceled','technical-healthy'].includes(input.scenario) ? JSON.stringify({resultRow:{home_goals:1,away_goals:0}}) : '{}']});
      if (['linked','canceled','technical-healthy'].includes(input.scenario)) await client.execute({sql:'INSERT INTO model_a_prospective_results VALUES(?,?,?,?,?,?,?,?,?)',args:['result','stored','understat','2026-11-04T19:00:00+01:00','2026-11-04T18:30:00Z','2026-11-04T18:31:00Z',1,0,'{}']});
    }
    if (input.scenario === 'canceled') await client.execute({sql:'INSERT INTO model_a_prospective_result_observations VALUES(?,?,?,?,?,?,?,?,?)',args:['canceled','stored','understat',kickoff,'2026-11-04T18:40:00Z','2026-11-04T18:41:00Z','canceled','provider_canceled','{}']});
    if (['missing-pk','wrong-pk'].includes(input.scenario)) {
      await client.execute('ALTER TABLE model_a_collection_ledger RENAME TO old_ledger');
      await client.execute('CREATE TABLE model_a_collection_ledger(protocol_id TEXT,match_id TEXT,kickoff_at TEXT,competition TEXT,season TEXT,state TEXT,reason TEXT,claim_at TEXT,forecast_id TEXT,updated_at TEXT,claim_id TEXT' + (input.scenario === 'wrong-pk' ? ',PRIMARY KEY(protocol_id,match_id)' : '') + ')');
      await client.execute('INSERT INTO model_a_collection_ledger(protocol_id,match_id,kickoff_at,competition,season,state,reason,claim_at,forecast_id,updated_at,claim_id) SELECT protocol_id,match_id,kickoff_at,competition,season,state,reason,claim_at,forecast_id,updated_at,claim_id FROM old_ledger');
      await client.execute('DROP TABLE old_ledger');
    }
    const before = fs.readFileSync(input.filename);
    const statements = [];
    const reader = { execute(statement) { if(!/^SELECT\s/i.test(statement.sql)) throw Error('write_attempt'); statements.push(statement.sql); return client.execute(statement); } };
    const result = await readModelAProspectiveMonitoring(reader, {protocolId:'monitor-test',manifestSha256:input.scenario === 'wrong-manifest' ? '0'.repeat(64) : sha256,cutoff,resultGraceHours:0.5});
    const unchanged = before.equals(fs.readFileSync(input.filename));
    console.log(JSON.stringify({...result,unchanged,onlySelect:statements.every(sql=>/^SELECT\s/i.test(sql)),projectionsOnly:!statements.some(sql=>/^SELECT\s+(?:\*|payload_json\s*[,F]|raw_json\s*[,F])/i.test(sql))}));
  } finally { client.close(); }
})().catch(error => { console.error(error.stack); process.exitCode=1; });
`;

function fixture(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-a-monitor-')), filename = path.join(dir, 'test.db');
  try {
    const child = spawnSync(process.execPath, ['-e', childSource], { cwd: path.join(__dirname, '..'), encoding: 'utf8',
      input: JSON.stringify({ scenario, filename, url: pathToFileURL(filename).href }), env: { ...process.env, MODEL_A_PROSPECTIVE_ENABLED: 'false' } });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  } finally {
    assert.ok(path.resolve(dir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}model-a-monitor-`));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('configured monitor is disabled before reading remote credentials or compiled modules', async () => {
  const output = [];
  assert.equal(await main(['--configured-database'], {}, value => output.push(value)), 0);
  assert.deepEqual(output, [{ enabled: false, status: 'disabled', alerts: [] }]);
});

test('configured monitor rejects URI arguments and redacts failures before any network client is created', async () => {
  const output = [];
  assert.equal(await main(['--configured-database', '--db-url', 'libsql://secret@example.com'], { MODEL_A_PROSPECTIVE_MONITORING_ENABLED: 'true' }, value => output.push(value)), 1);
  assert.equal(output[0].error, 'invalid_arguments');
  assert.equal(JSON.stringify(output).includes('secret'), false);
});

test('Node 20 compatible libSQL monitor performs only SELECT and aggregates a frozen scope', () => {
  const result = fixture('pending');
  assert.equal(result.unchanged, true); assert.equal(result.onlySelect, true); assert.equal(result.projectionsOnly, true);
  assert.equal(result.report.schema.compatible, true, JSON.stringify(result.report.schema.issues));
  assert.equal(result.report.coverage.fixtureMatches, 3);
  assert.equal(result.report.coverage.invalidFixtureTimesInCompetitionSeason, 1);
  assert.equal(result.report.coverage.recordedMatchesInWindow, 1);
  assert.equal(result.report.coverage.overdueMissing, 2);
  assert.equal(result.report.collector.analyzedFixtures, 2);
  assert.equal(result.report.collector.pendingFixtures, 1);
  assert.equal(result.report.collector.ledgerMissingFixtures, 1);
  assert.deepEqual(result.report.coverage.temporalClassificationCounts, { technical_only: 1 });
  assert.deepEqual(result.report.results.lifecycle, { unverified: 1 });
  assert.equal(result.report.results.lifecycleReasons.kickoff_changed, 1);
  assert.equal(result.report.results.pendingForecasts, 1);
  assert.equal(result.monitoring.status, 'critical');
  for (const code of ['missing_forecast_windows','unanalyzed_fixtures','forecast_delivery_unconfirmed','results_pending_within_horizon','result_unverified']) assert.ok(result.monitoring.alerts.some(alert => alert.code === code), code);
  assert.equal(JSON.stringify(result.report).includes('payload_json'), false);
  assert.ok(result.monitoring.notices.some(item => item.code === 'temporal_provenance_unknown'));
});

test('schema absent, valid empty calendar and mismatched manifest cannot produce a green monitor', () => {
  for (const scenario of ['absent','empty','wrong-manifest']) {
    const result = fixture(scenario);
    assert.equal(result.monitoring.status, 'critical', scenario);
    assert.ok(result.monitoring.alerts.some(alert => alert.code === 'calendar_unverifiable'), scenario);
    if (scenario !== 'empty') assert.equal(result.report.collector.registeredScopeMatches, false, scenario);
    if (scenario === 'absent') assert.equal(result.report.results.pendingForecasts, null);
  }
});

test('configured monitor links equivalent UTC kickoffs and reports the latest failed run', () => {
  const linked = fixture('linked');
  assert.equal(linked.report.results.linkedForecasts, 1);
  assert.equal(linked.report.results.pendingForecasts, 0);
  const failed = fixture('failed');
  assert.equal(failed.report.collector.latestRunStatus, 'failed');
  assert.equal(failed.report.collector.failedRuns, 1);
  assert.ok(failed.monitoring.alerts.some(alert => alert.code === 'collector_run_failed'));
});

test('technical-only collection can be operationally healthy while the strict scientific gate remains blocked', () => {
  const technical = fixture('technical-healthy');
  assert.equal(technical.monitoring.status, 'ok');
  assert.equal(technical.monitoring.scientificStatus, 'unverified');
  assert.equal(technical.monitoring.rigorousEligible, false);
  assert.equal(technical.report.coverage.nonEvaluableProvenance, 1);
  assert.ok(technical.monitoring.notices.some(item => item.code === 'temporal_provenance_unknown'));
  assert.equal(evaluate(technical.report, { requireRigorousInputs: true }).status, 'critical');
  assert.throws(() => evaluate(technical.report, { requireRigorousInputs: '1' }), /invalid_rigorous_requirement/);
});

test('new cancellation invalidates pairing without deleting the preserved final or the calendar fixture', () => {
  const canceled = fixture('canceled');
  assert.equal(canceled.report.coverage.fixtureMatches, 3);
  assert.equal(canceled.report.coverage.eligibleFixtureMatches, 2);
  assert.equal(canceled.report.results.preservedFinalEvidence, 1);
  assert.equal(canceled.report.results.currentlyPairableForecasts, 0);
  assert.equal(canceled.report.results.pendingForecasts, 0);
  assert.equal(canceled.report.results.invalidatedStoredFinals, 1);
  assert.ok(canceled.monitoring.notices.some(item => item.code === 'result_lifecycle_exclusion'));
  const notFinal = fixture('not-final');
  assert.equal(notFinal.report.results.pendingForecasts, 1);
  assert.equal(evaluate(notFinal.report, { resultGraceHours: 6 }).alerts.some(alert => alert.code === 'results_pending_within_horizon'), false);
});

test('configured preflight rejects a readable ledger with no primary key', () => {
  const result = fixture('missing-pk');
  assert.equal(result.report.schema.tables.model_a_collection_ledger.readable, true);
  assert.equal(result.report.schema.compatible, false);
  assert.ok(result.report.schema.issues.includes('missing_or_incompatible_primary_key:model_a_collection_ledger'));
  assert.ok(result.monitoring.alerts.some(alert => alert.code === 'schema_unverified'));
  assert.equal(result.onlySelect, true); assert.equal(result.unchanged, true);
});

test('configured preflight rejects an incomplete composite ledger primary key', () => {
  const result = fixture('wrong-pk');
  assert.equal(result.report.schema.tables.model_a_collection_ledger.readable, true);
  assert.equal(result.report.schema.compatible, false);
  assert.ok(result.report.schema.issues.includes('missing_or_incompatible_primary_key:model_a_collection_ledger'));
  assert.ok(result.monitoring.alerts.some(alert => alert.code === 'schema_unverified'));
  assert.equal(result.onlySelect, true); assert.equal(result.unchanged, true);
});
