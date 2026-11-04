const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { refreshModelAProspectiveResults, createModelAProspectiveResultRefreshSink } = require('../dist/research/ModelAProspectiveResultRefresh');

const enabled = { MODEL_A_PROSPECTIVE_ENABLED: 'true', MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED: 'true' };
async function fixture(t, ids = [42]) {
  const client = createClient({ url: 'file::memory:' }); t.after(() => client.close());
  await client.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
  await client.executeMultiple(`CREATE TABLE matches(match_id TEXT PRIMARY KEY,source TEXT,source_match_id INTEGER,date TEXT,home_team_id TEXT,away_team_id TEXT,home_goals INTEGER,away_goals INTEGER);
    CREATE TABLE teams(team_id TEXT PRIMARY KEY,source_team_id INTEGER); INSERT INTO teams VALUES ('h',1),('a',2);`);
  const now = Math.floor(Date.now() / 1000) * 1000 - 10000, kickoff = new Date(now - 3 * 3600000).toISOString();
  const payload = JSON.stringify({ origin: 'direct_a', homeTeamId: 'h', awayTeamId: 'a', competition: 'Serie A', season: '2026/27' });
  for (const id of ids) {
    await client.execute({ sql: 'INSERT INTO matches VALUES (?,?,?,?,?,?,?,?)', args: [`understat_${id}`, 'understat', id, kickoff, 'h', 'a', null, null] });
    await client.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)', args: [`f${id}`, `understat_${id}`, new Date(now - 9 * 3600000).toISOString(), kickoff, payload] });
  }
  let time = now;
  const options = { env: enabled, clock: () => new Date(time) };
  const feed = (id = 42, homeGoals = 2, rawChanges = {}) => {
    const raw = { id: String(id), datetime: kickoff.slice(0, 19).replace('T', ' '), isResult: true, h: { id: '1' }, a: { id: '2' }, goals: { h: String(homeGoals), a: '1' }, ...rawChanges };
    return { matchId: `understat_${id}`, sourceMatchId: id, date: raw.datetime, homeTeamId: '1', awayTeamId: '2', competition: 'Serie A', season: '2026/27',
      homeGoals, awayGoals: 1, rawJson: JSON.stringify(raw) };
  };
  const count = async table => Number((await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  return { client, now, kickoff, options, feed, count, sink: createModelAProspectiveResultRefreshSink(client), advance: () => { time += 1000; } };
}

test('refresh is disabled unless both explicit flags are true, with no database/provider work', async () => {
  const sink = { getModelAProspectiveResultRefreshCandidates: () => { throw new Error('must not query'); } };
  const source = { scrapeSeason: () => { throw new Error('must not fetch'); } };
  for (const env of [{}, { MODEL_A_PROSPECTIVE_ENABLED: 'true' }, { MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED: 'true' }, { ...enabled, MODEL_A_PROSPECTIVE_ENABLED: 'TRUE' }]) {
    assert.equal((await refreshModelAProspectiveResults(sink, { env, source })).status, 'disabled');
  }
});

test('provider refresh appends 2 -> 3 -> 2 corrections and repeated evidence is idempotent without operational mutations', async t => {
  const f = await fixture(t);
  const beforeMatches = (await f.client.execute('SELECT * FROM matches')).rows;
  const beforeForecasts = (await f.client.execute('SELECT * FROM model_a_prospective_forecasts')).rows;
  let home = 2, calls = 0;
  const source = { scrapeSeason: async (competition, season, opts) => { calls++; assert.equal(competition, 'Serie A'); assert.equal(season, '2026/27'); assert.deepEqual(opts, { includeDetails: false }); return [f.feed(42, home)]; } };
  assert.equal((await refreshModelAProspectiveResults(f.sink, { ...f.options, source })).recorded, 1);
  assert.equal((await refreshModelAProspectiveResults(f.sink, { ...f.options, source })).duplicate, 1);
  home = 3; f.advance(); await refreshModelAProspectiveResults(f.sink, { ...f.options, source });
  home = 2; f.advance(); await refreshModelAProspectiveResults(f.sink, { ...f.options, source });
  assert.equal(calls, 4); assert.equal(await f.count('model_a_prospective_results'), 3); assert.equal(await f.count('model_a_prospective_result_observations'), 3);
  const results = (await f.client.execute('SELECT * FROM model_a_prospective_results ORDER BY observed_at')).rows;
  assert.deepEqual(results.map(r => r.home_goals), [2, 3, 2]);
  assert.equal(JSON.parse(results[0].evidence_json).source, 'understat');
  const lifecycle = (await f.client.execute('SELECT * FROM model_a_prospective_result_observations ORDER BY observed_at')).rows;
  assert.equal(JSON.parse(lifecycle[0].evidence_json).providerPublishedAt, null);
  assert.equal(lifecycle[0].observed_at, new Date(f.now).toISOString());
  assert.deepEqual((await f.client.execute('SELECT * FROM matches')).rows, beforeMatches);
  assert.deepEqual((await f.client.execute('SELECT * FROM model_a_prospective_forecasts')).rows, beforeForecasts);
  await assert.rejects(f.client.execute('UPDATE model_a_prospective_result_observations SET status=\'final\''), /append-only/);
  await assert.rejects(f.client.execute('DELETE FROM model_a_prospective_result_observations'), /append-only/);
});

test('timestamp is actual fetch completion, never a provider publication time', async t => {
  const f = await fixture(t);
  const source = { scrapeSeason: async () => { f.advance(); return [f.feed()]; } };
  await refreshModelAProspectiveResults(f.sink, { ...f.options, source });
  const row = (await f.client.execute('SELECT * FROM model_a_prospective_results')).rows[0];
  assert.equal(row.observed_at, new Date(f.now + 1000).toISOString());
});

test('postponed, canceled, changed kickoff, missing, conflicting and unverified responses never create false finals', async t => {
  const f = await fixture(t);
  const cases = [
    { feed: () => [f.feed(42, 2, { status: 'postponed', datetime: '2099-01-01 00:00:00' })], status: 'postponed', reason: 'provider_postponed' },
    { feed: () => [f.feed(42, 2, { status: 'canceled' })], status: 'canceled', reason: 'provider_canceled' },
    { feed: () => [f.feed(42, 2, { datetime: '2099-01-01 00:00:00' })], status: 'conflict', reason: 'kickoff_changed' },
    { feed: () => [], status: 'missing', reason: 'provider_match_missing' },
    { feed: () => [f.feed(), f.feed()], status: 'conflict', reason: 'provider_duplicate_match' },
    { feed: () => [f.feed(42, 2, { h: { id: '99' } })], status: 'conflict', reason: 'provider_identity_mismatch' },
    { feed: () => [f.feed(42, 2, { isResult: false })], status: 'not_final', reason: 'provider_not_final' },
    { feed: () => [f.feed(42, 2, { isResult: undefined })], status: 'unverified', reason: 'provider_final_unverified' },
    { feed: () => [f.feed(42, 2, { goals: { h: '9', a: '1' } })], status: 'unverified', reason: 'provider_score_invalid' },
    { feed: () => [{ ...f.feed(), rawJson: '{}' }], status: 'conflict', reason: 'provider_identity_mismatch' },
    { feed: () => { throw new Error('private credentials must not be recorded'); }, status: 'provider_error', reason: 'provider_fetch_failed' }
  ];
  for (const value of cases) {
    f.advance();
    const summary = await refreshModelAProspectiveResults(f.sink, { ...f.options, source: { scrapeSeason: async () => value.feed() } });
    assert.equal(summary.reasonCounts[value.reason], 1, value.reason);
    const last = (await f.client.execute('SELECT * FROM model_a_prospective_result_observations ORDER BY observed_at DESC LIMIT 1')).rows[0];
    assert.equal(last.status, value.status); assert.ok(!last.evidence_json.includes('private credentials'));
  }
  assert.equal(await f.count('model_a_prospective_results'), 0);
});

test('bounded rotating pages include already finalized fixtures and do not starve later matches', async t => {
  const f = await fixture(t, [10, 11, 12, 13, 14]);
  const source = { scrapeSeason: async () => [f.feed(14)] };
  const summaries = [];
  for (let i = 0; i < 3; i++) summaries.push(await refreshModelAProspectiveResults(f.sink, { ...f.options, pageSize: 2, source }));
  assert.deepEqual(summaries.map(s => s.scanned), [2, 2, 1]);
  assert.equal(summaries[2].recorded, 1); assert.equal(summaries[2].cycleComplete, true);
  // Restarting the scan includes the final fixture again, to detect corrections.
  f.advance();
  for (let i = 0; i < 3; i++) await refreshModelAProspectiveResults(f.sink, { ...f.options, pageSize: 2, source: { scrapeSeason: async () => [f.feed(14, 3)] } });
  assert.equal(await f.count('model_a_prospective_results'), 2);
});

test('overlapping refreshes on one sink share the same provider request and scan', async t => {
  const f = await fixture(t);
  let release, calls = 0;
  const source = { scrapeSeason: async () => { calls++; await new Promise(resolve => { release = resolve; }); return [f.feed()]; } };
  const first = refreshModelAProspectiveResults(f.sink, { ...f.options, source });
  const second = refreshModelAProspectiveResults(f.sink, { ...f.options, source });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.deepEqual(a, b); assert.equal(await f.count('model_a_prospective_results'), 1);
});

test('persisted final evidence recovers an interrupted result write after reconstructing the sink', async t => {
  const f = await fixture(t);
  let fail = true;
  const wrapped = { ...f.sink, appendModelAProspectiveResult: async event => { if (fail) { fail = false; throw new Error('DB temporary failure'); } return f.sink.appendModelAProspectiveResult(event); } };
  const first = await refreshModelAProspectiveResults(wrapped, { ...f.options, source: { scrapeSeason: async () => [f.feed()] } });
  assert.equal(first.failed, 1); assert.equal(await f.count('model_a_prospective_results'), 0); assert.equal(await f.count('model_a_prospective_result_observations'), 1);
  f.advance();
  const restarted = createModelAProspectiveResultRefreshSink(f.client);
  const recovered = await refreshModelAProspectiveResults(restarted, { ...f.options, source: { scrapeSeason: async () => { throw new Error('provider offline'); } } });
  assert.equal(recovered.recovered, 1); assert.equal(await f.count('model_a_prospective_results'), 1);
  assert.equal((await f.client.execute('SELECT observed_at FROM model_a_prospective_results')).rows[0].observed_at, new Date(f.now).toISOString());
  assert.equal((await restarted.getModelAProspectivePendingFinalObservations({ limit: 20 })).length, 0);
});

test('paired analysis respects lifecycle changes and the preregistered cutoff', async t => {
  const f = await fixture(t);
  const options = { env: enabled, clock: () => new Date() };
  await refreshModelAProspectiveResults(f.sink, { ...options, source: { scrapeSeason: async () => [f.feed()] } });
  const frozen = new Date().toISOString();
  const sql = fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/technical-paired-results.sql'), 'utf8');
  const paired = cutoff => f.client.execute({ sql, args: { cutoff, origin: 'direct_a', protocol_id: null } });
  assert.equal((await paired(frozen)).rows[0].home_goals, 2);
  await new Promise(resolve => setTimeout(resolve, 5));
  await refreshModelAProspectiveResults(f.sink, { ...options, source: { scrapeSeason: async () => [f.feed(42, 2, { status: 'cancelled' })] } });
  assert.equal((await paired(new Date().toISOString())).rows[0].home_goals, null);
  assert.equal((await paired(frozen)).rows[0].home_goals, 2);
  assert.equal(await f.count('model_a_prospective_results'), 1);
});

test('correction scan has an explicit bounded horizon and detects calendar kickoff changes', async t => {
  const f = await fixture(t);
  const old = new Date(f.now - 31 * 86400000).toISOString();
  await f.client.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)', args: ['old', 'understat_999', new Date(f.now - 32 * 86400000).toISOString(), old, '{}'] });
  let calls = 0;
  await f.client.execute({ sql: 'UPDATE matches SET date=?', args: [new Date(f.now + 86400000).toISOString()] });
  const summary = await refreshModelAProspectiveResults(f.sink, { ...f.options, source: { scrapeSeason: async () => { calls++; return [f.feed()]; } } });
  assert.equal(summary.scanned, 1); assert.equal(calls, 1); assert.equal(summary.reasonCounts.kickoff_changed, 1); assert.equal(await f.count('model_a_prospective_results'), 0);
  assert.equal(Date.parse(summary.to) - Date.parse(summary.from), 30 * 86400000);
});

test('composite cursor covers multiple frozen kickoffs for the same match without silently reassociating them', async t => {
  const f = await fixture(t);
  const row = (await f.client.execute('SELECT * FROM model_a_prospective_forecasts')).rows[0];
  await f.client.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)',
    args: ['changed-kickoff', row.match_id, row.forecast_at, new Date(f.now - 2 * 3600000).toISOString(), row.payload_json] });
  const source = { scrapeSeason: async () => [f.feed()] };
  const first = await refreshModelAProspectiveResults(f.sink, { ...f.options, pageSize: 1, source });
  const second = await refreshModelAProspectiveResults(f.sink, { ...f.options, pageSize: 1, source });
  const third = await refreshModelAProspectiveResults(f.sink, { ...f.options, pageSize: 1, source });
  assert.equal(first.recorded, 1); assert.equal(second.reasonCounts.kickoff_changed, 1); assert.equal(third.scanned, 0);
  assert.equal(await f.count('model_a_prospective_result_observations'), 2); assert.equal(await f.count('model_a_prospective_results'), 1);
});

test('lifecycle identifiers reject conflicting payloads instead of replacing evidence', async t => {
  const f = await fixture(t);
  await refreshModelAProspectiveResults(f.sink, { ...f.options, source: { scrapeSeason: async () => [f.feed()] } });
  const row = (await f.client.execute('SELECT * FROM model_a_prospective_result_observations')).rows[0];
  const event = { evidenceId: row.evidence_id, matchId: row.match_id, source: row.source, kickoffAt: row.kickoff_at,
    observedAt: row.observed_at, recordedAt: new Date().toISOString(), status: row.status, reason: row.reason, evidence: row.evidence_json };
  assert.equal(await f.sink.appendModelAProspectiveResultObservation(event), false);
  await assert.rejects(f.sink.appendModelAProspectiveResultObservation({ ...event, status: 'canceled' }), /conflicting prospective result identifier/);
  assert.equal(await f.count('model_a_prospective_result_observations'), 1);
});

test('a new process sink resumes after the first 20 fixtures instead of restarting the same monthly page', async t => {
  const ids = Array.from({ length: 25 }, (_, index) => index + 100);
  const f = await fixture(t, ids);
  const source = { scrapeSeason: async () => ids.map(value => f.feed(value)) };
  const first = await refreshModelAProspectiveResults(f.sink, { ...f.options, source });
  assert.equal(first.scanned, 20); assert.equal(first.cycleComplete, false);
  const metadata = (await f.client.execute('SELECT * FROM model_a_prospective_result_refresh_state')).rows[0];
  assert.equal(metadata.after_match_id, 'understat_119'); assert.equal(metadata.after_kickoff_at, f.kickoff);
  const restarted = createModelAProspectiveResultRefreshSink(f.client);
  const second = await refreshModelAProspectiveResults(restarted, { ...f.options, source });
  assert.equal(second.scanned, 5); assert.equal(second.recorded, 5); assert.equal(second.cycleComplete, true);
  assert.equal(await f.count('model_a_prospective_results'), 25);
  const completed = (await f.client.execute('SELECT * FROM model_a_prospective_result_refresh_state')).rows[0];
  assert.equal(completed.after_match_id, null); assert.equal(completed.lease_owner, null); assert.equal(completed.last_status, 'completed');
});

test('lease also prevents overlapping refreshes from independent process sinks', async t => {
  const f = await fixture(t);
  let release, calls = 0;
  const source = { scrapeSeason: async () => { calls++; await new Promise(resolve => { release = resolve; }); return [f.feed()]; } };
  const first = refreshModelAProspectiveResults(f.sink, { ...f.options, source });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const other = await refreshModelAProspectiveResults(createModelAProspectiveResultRefreshSink(f.client), { ...f.options, source });
  assert.equal(other.status, 'busy'); assert.equal(calls, 1);
  release(); assert.equal((await first).recorded, 1);
});

test('last successful refresh is persisted even with zero candidates, without inventing observations', async t => {
  const f = await fixture(t, []);
  const summary = await refreshModelAProspectiveResults(f.sink, { ...f.options, source: { scrapeSeason: () => { throw new Error('must not fetch'); } } });
  assert.equal(summary.scanned, 0); assert.equal(summary.status, 'completed');
  const row = (await f.client.execute('SELECT * FROM model_a_prospective_result_refresh_state')).rows[0];
  assert.equal(row.last_started_at, new Date(f.now).toISOString()); assert.equal(row.last_success_at, new Date(f.now).toISOString());
  assert.equal(JSON.parse(row.last_summary_json).scanned, 0); assert.equal(await f.count('model_a_prospective_result_observations'), 0);
});
