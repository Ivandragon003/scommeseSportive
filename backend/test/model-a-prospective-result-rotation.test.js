const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { recordModelAVerifiedResult, reconcileModelAProspectiveResults } = require('../dist/research/ModelAProspectiveResults');
const { DatabaseService } = require('../dist/db/DatabaseService');
const schema = fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8');
const pairedSql = fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/technical-paired-results.sql'), 'utf8');
const kickoff = '2026-01-10T15:00:00.000Z';
const observedAt = '2026-01-10T17:00:00.000Z';

function fixture(id = 42, extra = {}) {
  return { match_id: `understat_${id}`, source: 'understat', source_match_id: String(id), date: kickoff,
    home_team_id: 'understat_team_10', away_team_id: 'understat_team_20', competition: 'Serie A', season: '2025/26',
    home_goals: 2, away_goals: 1, raw_json: JSON.stringify({ id: String(id), isResult: true,
      datetime: '2026-01-10 15:00:00', h: { id: '10' }, a: { id: '20' }, goals: { h: '2', a: '1' },
      resultObservation: { source: 'understat', observedAt } }), ...extra };
}
async function context(t) {
  const db = createClient({ url: 'file::memory:' });
  t.after(() => db.close());
  await db.executeMultiple(schema);
  await db.executeMultiple(`CREATE TABLE teams(team_id TEXT PRIMARY KEY, source_team_id INTEGER);
    CREATE TABLE matches(match_id TEXT PRIMARY KEY, source TEXT, source_match_id TEXT, date TEXT,
      home_team_id TEXT, away_team_id TEXT, competition TEXT, season TEXT, home_goals INTEGER, away_goals INTEGER, raw_json TEXT);`);
  const wrapper = { execute: (sql, args) => db.execute({ sql, args }),
    all: async (sql, args) => (await db.execute({ sql, args })).rows,
    get: async (sql, args) => (await db.execute({ sql, args })).rows[0] };
  const pages = [];
  const sink = {
    getModelAProspectiveResultCandidates: async options => {
      const rows = await DatabaseService.prototype.getModelAProspectiveResultCandidates.call(wrapper, options);
      pages.push(rows.map(row => row.match_id)); return rows;
    },
    appendModelAProspectiveResult: event => DatabaseService.prototype.appendModelAProspectiveResult.call(wrapper, event)
  };
  async function add(row, id = row.match_id) {
    await db.execute({ sql: 'INSERT INTO matches VALUES (?,?,?,?,?,?,?,?,?,?,?)', args: Object.values(row) });
    await db.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)',
      args: [id, row.match_id, new Date(Date.parse(row.date) - 5 * 3600000).toISOString(), row.date, JSON.stringify({ origin: 'direct_a', homeTeamId: row.home_team_id,
        awayTeamId: row.away_team_id, competition: row.competition, season: row.season })] });
  }
  return { db, sink, pages, add };
}

test('keyset rotation reaches valid evidence after 205 older unverified rows, bounded without overlap', async t => {
  const { db, sink, pages, add } = await context(t);
  for (let i = 1000; i < 1205; i++) await add(fixture(i, { date: '2026-01-09T15:00:00Z', raw_json: '{}' }));
  await add(fixture(9999));
  const beforeMatches = (await db.execute('SELECT * FROM matches ORDER BY match_id')).rows;
  const beforeForecasts = (await db.execute('SELECT * FROM model_a_prospective_forecasts ORDER BY id')).rows;
  const first = await reconcileModelAProspectiveResults(sink);
  assert.deepEqual(first, { scanned: 200, recorded: 0, duplicate: 0, unverified: 200, excluded: 0, failed: 0, cycleComplete: false });
  const second = await reconcileModelAProspectiveResults(sink);
  assert.equal(second.scanned, 6); assert.equal(second.recorded, 1); assert.equal(second.cycleComplete, true);
  assert.equal(new Set(pages.flat()).size, 206);
  assert.equal((await db.execute('SELECT match_id FROM model_a_prospective_results')).rows[0].match_id, 'understat_9999');
  await reconcileModelAProspectiveResults(sink);
  assert.deepEqual(pages[2], pages[0]);
  assert.deepEqual((await db.execute('SELECT * FROM matches ORDER BY match_id')).rows, beforeMatches);
  assert.deepEqual((await db.execute('SELECT * FROM model_a_prospective_forecasts ORDER BY id')).rows, beforeForecasts);
});

test('kickoff changes and persisted team changes cannot silently attach a forecast', async t => {
  const { db, sink, add } = await context(t);
  await add(fixture());
  await db.execute("UPDATE matches SET date='2026-01-11T15:00:00Z'");
  assert.equal((await reconcileModelAProspectiveResults(sink)).scanned, 0);
  await db.execute({ sql: 'UPDATE matches SET date=?,home_team_id=?', args: [kickoff, 'understat_team_30'] });
  assert.equal((await reconcileModelAProspectiveResults(sink)).scanned, 0);
  assert.equal((await db.execute('SELECT count(*) n FROM model_a_prospective_results')).rows[0].n, 0);
  const moved = fixture(42, { date: '2026-01-11T15:00:00Z' });
  const raw = JSON.parse(moved.raw_json); raw.datetime = '2026-01-11 15:00:00';
  raw.resultObservation.observedAt = '2026-01-11T17:00:00Z'; moved.raw_json = JSON.stringify(raw);
  await recordModelAVerifiedResult(sink, moved);
  const paired = await db.execute({ sql: pairedSql, args: { cutoff: '2026-02-01T00:00:00Z', origin: 'direct_a', protocol_id: null } });
  assert.equal(paired.rows.length, 1); assert.equal(paired.rows[0].evidence_id, null);
});

test('raw source identity, team mapping, kickoff and timestamp checks reject contradictory evidence', async t => {
  const { db, sink } = await context(t);
  const row = fixture();
  const cases = [
    { source_match_id: '43' },
    { raw: { id: '43' } },
    { raw: { h: { id: '20' }, a: { id: '10' } } },
    { raw: { datetime: '2026-01-10 16:00:00' } },
    { raw: { datetime: '2026-02-30 15:00:00' } },
    { date: '2026-01-10T15:00:00' },
    { raw: { resultObservation: { source: 'understat', observedAt: '2026-01-10T17:00:00' } } },
    { raw: { resultObservation: { source: 'understat', observedAt: kickoff } } },
    { raw: { resultObservation: { source: 'understat', observedAt: '2099-01-10T17:00:00Z' } } },
    { home_source_team_id: 30 }
  ];
  for (const item of cases) {
    const { raw, ...changes } = item;
    const candidate = { ...row, ...changes, raw_json: JSON.stringify({ ...JSON.parse(row.raw_json), ...raw }) };
    assert.equal((await recordModelAVerifiedResult(sink, candidate)).status, 'unverified', JSON.stringify(item));
  }
  for (const status of ['postponed', 'suspended', 'cancelled', 'abandoned']) {
    const candidate = { ...row, raw_json: JSON.stringify({ ...JSON.parse(row.raw_json), status }) };
    assert.equal((await recordModelAVerifiedResult(sink, candidate)).status, status);
  }
  const aliasRow = { ...row, home_team_id: 'home-alias', home_source_team_id: 10 };
  assert.equal((await recordModelAVerifiedResult(sink, aliasRow)).status, 'recorded');
  const evidence = JSON.parse((await db.execute('SELECT evidence_json FROM model_a_prospective_results')).rows[0].evidence_json);
  assert.equal(evidence.sourceHomeTeamId, '10'); assert.equal(evidence.sourceKickoffAt, kickoff);
});

test('equivalent UTC instants deduplicate, later same score and correction reversal append immutable observations', async t => {
  const { db, sink, add } = await context(t);
  const row = fixture(); await add(row);
  await reconcileModelAProspectiveResults(sink);
  const equivalentRaw = JSON.parse(row.raw_json);
  equivalentRaw.resultObservation.observedAt = '2026-01-10T18:00:00+01:00';
  assert.equal((await recordModelAVerifiedResult(sink, { ...row, date: '2026-01-10T16:00:00+01:00', raw_json: JSON.stringify(equivalentRaw) })).status, 'duplicate');
  async function update(homeGoals, time) {
    const raw = JSON.parse(row.raw_json); raw.goals.h = String(homeGoals); raw.resultObservation.observedAt = time;
    await db.execute({ sql: 'UPDATE matches SET home_goals=?,raw_json=?', args: [homeGoals, JSON.stringify(raw)] });
    return reconcileModelAProspectiveResults(sink);
  }
  assert.equal((await update(2, '2026-01-10T17:10:00Z')).recorded, 1);
  assert.equal((await update(3, '2026-01-10T17:20:00Z')).recorded, 1);
  assert.equal((await update(2, '2026-01-10T17:30:00Z')).recorded, 1);
  assert.equal((await reconcileModelAProspectiveResults(sink)).duplicate, 1);
  assert.equal((await db.execute('SELECT count(*) n FROM model_a_prospective_results')).rows[0].n, 4);
  for (const [cutoff, expectedGoals] of [['2026-01-10T17:25:00Z', 3], ['2026-01-10T17:35:00Z', 2]]) {
    // Historical observation order is separate from the real delivery cutoff.
    const latest = await db.execute({ sql: 'SELECT home_goals FROM model_a_prospective_results WHERE observed_at<=? ORDER BY observed_at DESC LIMIT 1', args: [cutoff] });
    assert.equal(latest.rows[0].home_goals, expectedGoals);
  }
  const paired = await db.execute({ sql: pairedSql, args: { cutoff: new Date(Date.now() + 1000).toISOString(), origin: 'direct_a', protocol_id: null } });
  assert.equal(paired.rows.length, 1); assert.equal(paired.rows[0].home_goals, 2);
  await assert.rejects(db.execute('DELETE FROM model_a_prospective_results'), /append-only/);
  const first = (await db.execute('SELECT * FROM model_a_prospective_results LIMIT 1')).rows[0];
  await assert.rejects(sink.appendModelAProspectiveResult({ evidenceId: first.evidence_id, matchId: first.match_id,
    source: first.source, kickoffAt: first.kickoff_at, observedAt: first.observed_at, recordedAt: first.recorded_at,
    homeGoals: 9, awayGoals: first.away_goals, evidence: first.evidence_json }), /conflicting/);
});

test('concurrent reconciliation shares a page and a failed write does not starve other fixtures', async t => {
  const { db, sink, add, pages } = await context(t);
  await add(fixture(42)); await add(fixture(43));
  const original = sink.appendModelAProspectiveResult;
  let fail = true;
  sink.appendModelAProspectiveResult = async event => {
    if (event.matchId === 'understat_42' && fail) throw new Error('simulated storage failure');
    return original(event);
  };
  const [first, concurrent] = await Promise.all([reconcileModelAProspectiveResults(sink), reconcileModelAProspectiveResults(sink)]);
  assert.deepEqual(concurrent, first); assert.equal(pages.length, 1);
  assert.equal(first.failed, 1); assert.equal(first.recorded, 1);
  fail = false;
  const retry = await reconcileModelAProspectiveResults(sink);
  assert.equal(retry.recorded, 1); assert.equal(retry.duplicate, 1);
  assert.equal((await db.execute('SELECT count(*) n FROM model_a_prospective_results')).rows[0].n, 2);
});

test('analysis freeze selects one latest observation across equivalent kickoff offsets', async t => {
  const { db, add } = await context(t);
  await add(fixture());
  const rows = [
    ['one', '2026-01-10T16:00:00+01:00', '2026-01-10T17:00:00Z', '2026-01-10T17:01:00Z', 2],
    ['two', kickoff, '2026-01-10T18:00:00Z', '2026-01-10T18:01:00Z', 3],
    ['late-delivery', kickoff, '2026-01-10T18:10:00Z', '2026-01-11T00:00:00Z', 4]
  ];
  for (const [id, date, observed, recorded, goals] of rows) {
    await db.execute({ sql: 'INSERT INTO model_a_prospective_results VALUES (?,?,?,?,?,?,?,?,?)',
      args: [id, 'understat_42', 'understat', date, observed, recorded, goals, 1, '{}'] });
  }
  for (const [cutoff, goals] of [['2026-01-10T17:30:00Z', 2], ['2026-01-10T18:30:00Z', 3]]) {
    const result = await db.execute({ sql: pairedSql, args: { cutoff, origin: 'direct_a', protocol_id: null } });
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].home_goals, goals);
  }
});
