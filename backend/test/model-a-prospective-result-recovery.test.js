const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { createModelAProspectiveResultRefreshSink, refreshModelAProspectiveResults, planModelAProspectiveResultRefresh,
  validateModelAProspectiveResultRefreshScope, modelAProspectiveResultRefreshScopeIdentity } = require('../dist/research/ModelAProspectiveResultRefresh');
const { main } = require('../scripts/model-a-prospective-results-recover');
const DAY = 86400000;
const enabled = { MODEL_A_PROSPECTIVE_ENABLED: 'true', MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED: 'true' };
async function fixture(t, ids = [42, 43]) {
  const client = createClient({ url: 'file::memory:' }); t.after(() => client.close());
  await client.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
  await client.executeMultiple(`CREATE TABLE matches(match_id TEXT PRIMARY KEY,source TEXT,source_match_id INTEGER,date TEXT,home_team_id TEXT,away_team_id TEXT,home_goals INTEGER,away_goals INTEGER);
    CREATE TABLE teams(team_id TEXT PRIMARY KEY,source_team_id INTEGER); INSERT INTO teams VALUES ('h',1),('a',2);`);
  const now = Math.floor(Date.now() / 1000) * 1000 - 30000;
  const kickoff = new Date(now - 45 * DAY).toISOString();
  const scope = { from: new Date(now - 46 * DAY).toISOString(), to: new Date(now - 44 * DAY).toISOString() };
  const payload = JSON.stringify({ origin: 'direct_a', homeTeamId: 'h', awayTeamId: 'a', competition: 'Serie A', season: '2026/27' });
  for (const id of ids) {
    await client.execute({ sql: 'INSERT INTO matches VALUES (?,?,?,?,?,?,?,?)', args: [`understat_${id}`, 'understat', id, kickoff, 'h', 'a', null, null] });
    await client.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)', args: [`forecast-${id}`, `understat_${id}`, new Date(Date.parse(kickoff) - 5 * 3600000).toISOString(), kickoff, payload] });
  }
  let time = now, homeGoals = 2, providerCalls = 0;
  const source = { scrapeSeason: async () => { providerCalls++; return ids.map(id => ({ matchId: `understat_${id}`, sourceMatchId: id,
    date: kickoff, homeTeamId: '1', awayTeamId: '2', competition: 'Serie A', season: '2026/27', homeGoals, awayGoals: 1,
    rawJson: JSON.stringify({ id: String(id), datetime: kickoff, isResult: true, h: { id: '1' }, a: { id: '2' }, goals: { h: String(homeGoals), a: '1' } }) })); } };
  const clock = () => new Date(time);
  const options = { env: enabled, source, clock, authorizeExplicitScope: true };
  const count = async table => Number((await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  const args = ['--from', scope.from, '--to', scope.to];
  return { client, scope, now, kickoff, source, clock, options, count, args, providerCalls: () => providerCalls,
    advance: (goals = homeGoals) => { time += 1000; homeGoals = goals; } };
}

test('explicit scopes reject local/invalid/future/unbounded dates and malformed identifiers', () => {
  const valid = { from: '2025-01-01T00:00:00Z', to: '2025-01-03T00:00:00Z' };
  for (const scope of [
    { ...valid, from: '2025-01-01T00:00:00' }, { ...valid, from: '2025-02-30T00:00:00Z' },
    { ...valid, to: '2099-01-01T00:00:00Z' }, { ...valid, from: valid.to },
    { ...valid, to: '2026-02-01T00:00:00Z' }, { ...valid, matchIds: [] },
    { ...valid, matchIds: ['football_data_42'] }, { ...valid, matchIds: ['understat_0'] }
  ]) assert.throws(() => validateModelAProspectiveResultRefreshScope(scope), /result_refresh_scope_/);
  const a = { ...valid, matchIds: ['understat_43', 'understat_42', 'understat_42'] };
  const b = { from: '2025-01-01T01:00:00+01:00', to: valid.to, matchIds: ['understat_42', 'understat_43'] };
  assert.equal(modelAProspectiveResultRefreshScopeIdentity(a), modelAProspectiveResultRefreshScopeIdentity(b));
});

test('default CLI plan only SELECTs existing forecast candidates, without provider, lease or evidence writes', async t => {
  const f = await fixture(t);
  const queries = [], output = [];
  const client = { execute: statement => { queries.push(statement.sql); assert.match(statement.sql, /^\s*(SELECT|WITH)\b/i); return f.client.execute(statement); } };
  const plan = await main(enabled, f.args, { client, clock: f.clock, source: { scrapeSeason: () => { throw new Error('must not fetch'); } }, output: value => output.push(value) });
  assert.equal(plan.mode, 'plan'); assert.equal(plan.scanned, 2); assert.equal(plan.cycleComplete, true); assert.deepEqual(plan.scope, f.scope);
  assert.deepEqual(plan.pendingFinalObservations, []);
  assert.match(plan.scopeId, /^understat-results-explicit-v1:[a-f0-9]{64}$/); assert.equal(output.length, 1); assert.ok(queries.length >= 2);
  assert.equal(await f.count('model_a_prospective_result_refresh_state'), 0); assert.equal(await f.count('model_a_prospective_results'), 0);
  assert.equal(await f.count('model_a_prospective_result_observations'), 0);
});

test('historical execution requires both explicit arguments, both flags and an explicitly scoped sink', async t => {
  const f = await fixture(t);
  let queries = 0;
  const client = { execute: () => { queries++; throw new Error('must not query'); } };
  for (const args of [[...f.args, '--execute'], [...f.args, '--authorize-results-writes']])
    await assert.rejects(main(enabled, args, { client, output: () => {} }), /result_recovery_execution_not_authorized/);
  await assert.rejects(main({}, [...f.args, '--execute', '--authorize-results-writes'], { client, output: () => {} }), /result_recovery_feature_disabled/);
  assert.equal(queries, 0);
  const sink = createModelAProspectiveResultRefreshSink(f.client, f.scope);
  await assert.rejects(refreshModelAProspectiveResults(sink, { ...f.options, authorizeExplicitScope: false }), /explicit_scope_not_authorized/);
  await assert.rejects(refreshModelAProspectiveResults(createModelAProspectiveResultRefreshSink(f.client), { ...f.options, scope: f.scope }), /scoped_sink_required/);
  assert.equal(await f.count('model_a_prospective_result_refresh_state'), 0);
});

test('controlled recovery appends old corrections without mutating matches, forecasts or ordinary cursor', async t => {
  const f = await fixture(t);
  const ordinary = createModelAProspectiveResultRefreshSink(f.client);
  assert.equal((await refreshModelAProspectiveResults(ordinary, f.options)).scanned, 0);
  const original = (await f.client.execute("SELECT * FROM model_a_prospective_result_refresh_state WHERE refresh_id='understat-results-v1'")).rows[0];
  const beforeMatches = (await f.client.execute('SELECT * FROM matches')).rows;
  const beforeForecasts = (await f.client.execute('SELECT * FROM model_a_prospective_forecasts')).rows;
  const args = [...f.args, '--match-id', 'understat_42', '--execute', '--authorize-results-writes'];
  const dependencies = { client: f.client, source: f.source, clock: f.clock, output: () => {} };
  assert.equal((await main(enabled, args, dependencies)).recorded, 1);
  f.advance(3); assert.equal((await main(enabled, args, dependencies)).recorded, 1);
  f.advance(2); assert.equal((await main(enabled, args, dependencies)).recorded, 1);
  assert.deepEqual((await f.client.execute('SELECT home_goals FROM model_a_prospective_results ORDER BY observed_at')).rows.map(row => row.home_goals), [2, 3, 2]);
  assert.equal((await f.client.execute('SELECT observed_at FROM model_a_prospective_results ORDER BY observed_at LIMIT 1')).rows[0].observed_at, new Date(f.now).toISOString());
  assert.deepEqual((await f.client.execute('SELECT * FROM matches')).rows, beforeMatches);
  assert.deepEqual((await f.client.execute('SELECT * FROM model_a_prospective_forecasts')).rows, beforeForecasts);
  assert.deepEqual((await f.client.execute("SELECT * FROM model_a_prospective_result_refresh_state WHERE refresh_id='understat-results-v1'")).rows[0], original);
  assert.equal((await f.client.execute('SELECT DISTINCT match_id FROM model_a_prospective_results')).rows[0].match_id, 'understat_42');
});

test('historical pagination resumes across new sinks, with independent cursors for different finite scopes', async t => {
  const f = await fixture(t, Array.from({ length: 25 }, (_, index) => index + 100));
  const first = await refreshModelAProspectiveResults(createModelAProspectiveResultRefreshSink(f.client, f.scope), f.options);
  const second = await refreshModelAProspectiveResults(createModelAProspectiveResultRefreshSink(f.client, f.scope), f.options);
  assert.equal(first.scanned, 20); assert.equal(first.cycleComplete, false); assert.equal(second.scanned, 5); assert.equal(second.cycleComplete, true);
  assert.equal(await f.count('model_a_prospective_results'), 25);
  const narrow = { ...f.scope, matchIds: ['understat_100'] };
  const otherPlan = await planModelAProspectiveResultRefresh(createModelAProspectiveResultRefreshSink(f.client, narrow));
  assert.equal(otherPlan.scanned, 1); assert.notEqual(otherPlan.scopeId, first.scopeId);
  assert.equal(f.providerCalls(), 2);
});

test('scoped recovery never replays another match pending result and never selects fixtures without forecasts', async t => {
  const f = await fixture(t);
  const outside = createModelAProspectiveResultRefreshSink(f.client, { ...f.scope, matchIds: ['understat_43'] });
  const failed = { ...outside, appendModelAProspectiveResult: async () => { throw new Error('private target'); } };
  assert.equal((await refreshModelAProspectiveResults(failed, f.options)).failed, 1);
  await f.client.execute({ sql: 'INSERT INTO matches VALUES (?,?,?,?,?,?,?,?)', args: ['understat_44', 'understat', 44, f.kickoff, 'h', 'a', null, null] });
  const inside = createModelAProspectiveResultRefreshSink(f.client, { ...f.scope, matchIds: ['understat_42', 'understat_44'] });
  const plan = await planModelAProspectiveResultRefresh(inside);
  assert.deepEqual(plan.candidates.map(row => row.matchId), ['understat_42']);
  assert.equal(plan.pendingFinalObservations.length, 0);
  f.advance();
  const summary = await refreshModelAProspectiveResults(inside, f.options);
  assert.equal(summary.recovered, 0); assert.equal(summary.recorded, 1);
  assert.deepEqual((await f.client.execute('SELECT match_id FROM model_a_prospective_results')).rows.map(row => row.match_id), ['understat_42']);
  assert.equal((await outside.getModelAProspectivePendingFinalObservations({ limit: 20 })).length, 1);
});

test('CLI failures redact driver/credential details and missing local files are never created', async t => {
  const f = await fixture(t);
  const secret = 'libsql://private-host.example token=sk-private';
  await assert.rejects(main({}, f.args, { client: { execute: async () => { throw new Error(secret); } }, output: () => {} }), error => error.message === 'result_recovery_failed');
  const missing = path.join(require('node:os').tmpdir(), `model-a-nonexistent-${process.pid}-${Date.now()}.db`);
  assert.equal(fs.existsSync(missing), false);
  await assert.rejects(main({ TURSO_DATABASE_URL: `file:${missing}` }, f.args, { output: () => {} }), /result_recovery_database_file_missing/);
  assert.equal(fs.existsSync(missing), false);
});
