const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createClient } = require('@libsql/client');
const { normalizeFootballDataOrgFeed } = require('../dist/services/FootballDataOrgFeed');
const { SourceFeedStore } = require('../dist/services/SourceFeedStore');
const { FOOTBALL_DATA_COMPETITIONS } = require('../dist/services/modelAResearchCalendar');
const { planSourceFeedImport, applySourceFeedImport, runSourceFeedImport } = require('../dist/services/SourceFeedImport');

const acquiredAt = '2026-11-05T12:00:00.000Z';
const asOf = '2026-11-05T12:01:00.000Z';
const mapping = () => ({ version: 'review-1', competition: 'PL', season: 2026,
  reviewedAt: '2026-11-05T10:00:00.000Z', reference: 'explicit synthetic reviewed mapping', teams: { 1: 'home', 2: 'away' } });
function canonicalHash(value) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function rehash(plan) {
  const { planHash: _old, ...content } = plan;
  plan.planHash = canonicalHash(content);
  return plan;
}
function sourcePayload(competition = 'PL', year = 2026) {
  const season = { id: 1001, startDate: `${year}-08-01` };
  const teamCount = competition === 'BL1' || (competition === 'FL1' && year >= 2023) ? 18 : 20;
  const matches = [];
  for (let home = 1; home <= teamCount; home++) for (let away = 1; away <= teamCount; away++) if (home !== away) {
    matches.push({ id: matches.length + 1, competition: { id: FOOTBALL_DATA_COMPETITIONS[competition], code: competition }, season,
      utcDate: `${year}-08-02T12:00:00Z`, status: 'FINISHED', lastUpdated: `${year}-08-02T15:00:00Z`,
      homeTeam: { id: home, name: `Team ${home}` }, awayTeam: { id: away, name: `Team ${away}` }, score: { fullTime: { home: 0, away: 0 } } });
  }
  return { competition: { id: FOOTBALL_DATA_COMPETITIONS[competition], code: competition }, season, matches };
}

async function fixture(t, mutateSource = () => {}, targetRows, scope = {}) {
  const competition = scope.competition ?? 'PL', year = scope.season ?? 2026;
  const localCompetition = { PL: 'Premier League', FL1: 'Ligue 1', SA: 'Serie A', BL1: 'Bundesliga', PD: 'La Liga' }[competition];
  const reviewedMapping = { ...mapping(), competition, season: year };
  const target = createClient({ url: 'file::memory:' });
  // The native client's transaction() detaches its connection; reopening a
  // private :memory: DB loses it. Keep the real SQLite transaction on this
  // isolated connection while retaining the same injected client contract.
  const client = { execute: (statement) => target.execute(statement), close: () => target.close(),
    transaction: async (mode) => {
      assert.equal(mode, 'write'); await target.execute('BEGIN IMMEDIATE'); let completed = false;
      return { execute: (statement) => target.execute(statement),
        commit: async () => { await target.execute('COMMIT'); completed = true; },
        rollback: async () => { if (!completed) { await target.execute('ROLLBACK'); completed = true; } },
        close: () => {} };
    } };
  const cacheClient = createClient({ url: 'file::memory:' });
  t.after(() => { client.close(); cacheClient.close(); });
  await client.execute('CREATE TABLE teams(team_id TEXT PRIMARY KEY,name TEXT)');
  await client.execute("INSERT INTO teams VALUES ('home','Canonical Home'),('away','Canonical Away')");
  await client.execute(`CREATE TABLE matches(match_id TEXT PRIMARY KEY,home_team_id TEXT,away_team_id TEXT,
    home_team_name TEXT,away_team_name TEXT,competition TEXT,season TEXT,date TEXT,home_goals INTEGER,away_goals INTEGER,source TEXT,source_match_id INTEGER,raw_json TEXT,
    home_xg REAL DEFAULT 5,away_xg REAL DEFAULT 5,custom TEXT,home_shots INTEGER DEFAULT 999,away_yellow_cards INTEGER DEFAULT 999)`);
  const raw = JSON.stringify({ details: { rosters: { preserved: true } }, unknown: { nested: 'keep' } });
  const defaults = [
    { match_id: 'understat_71', home_team_id: 'home', away_team_id: 'away', raw_json: raw },
    { match_id: 'understat_72', home_team_id: 'away', away_team_id: 'home', raw_json: raw },
  ];
  for (const entry of targetRows ?? defaults) {
    const row = { competition: localCompetition, season: `${year}/${year + 1}`, date: `${year}-08-02T18:00:00.000Z`,
      home_team_name: entry.home_team_id === 'home' ? 'Canonical Home' : 'Canonical Away',
      away_team_name: entry.away_team_id === 'away' ? 'Canonical Away' : 'Canonical Home',
      home_goals: null, away_goals: null, source: 'understat', source_match_id: 71, raw_json: raw, home_xg: 1.25, away_xg: 0.7, custom: 'untouched', ...entry };
    const columns = Object.keys(row);
    await client.execute({ sql: `INSERT INTO matches(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, args: columns.map((column) => row[column]) });
  }
  const store = new SourceFeedStore(cacheClient); await store.initialize({ allowCreate: true });
  const payload = sourcePayload(competition, year); mutateSource(payload);
  const snapshot = normalizeFootballDataOrgFeed({ payload, competition, season: year, acquiredAt });
  const attempt = await store.beginAttempt(competition, year, acquiredAt); await store.succeed(attempt, snapshot, acquiredAt);
  const feed = await store.read(competition, year, asOf);
  return { client, store, feed, snapshot, mapping: reviewedMapping, asOf, competition, season: year,
    rows: async () => (await client.execute('SELECT * FROM matches ORDER BY match_id')).rows,
    plan: async (overrides = {}) => planSourceFeedImport({ client, feed, mapping: reviewedMapping, asOf, ...overrides }) };
}

test('planning is read-only, deterministic and explicitly skips every unmapped fixture', async (t) => {
  const f = await fixture(t), before = await f.rows();
  const first = await f.plan(), second = await f.plan();
  assert.equal(first.status, 'ready'); assert.equal(first.planHash, second.planHash);
  assert.deepEqual(first.counts, { fixtures: 380, updates: 2, creates: 0, skipped: 378, blocked: 0, unchanged: 0 });
  assert.ok(first.entries.filter((entry) => entry.action === 'SKIP').every((entry) => entry.reason === 'unmapped_provider_team'));
  const run = await runSourceFeedImport(f);
  assert.equal(run.result, null);
  assert.deepEqual(await f.rows(), before);
});

test('explicit apply fills real zeros, preserves source identity/xG/raw records and is idempotent', async (t) => {
  const f = await fixture(t), before = await f.rows(), plan = await f.plan();
  const result = await applySourceFeedImport({ ...f, plan });
  assert.equal(result.applied, 2); assert.equal(result.fieldsFilled, 4); assert.equal(result.kickoffUpdates, 0);
  const after = await f.rows();
  for (let index = 0; index < after.length; index++) {
    const row = after[index], previous = before[index];
    for (const field of ['match_id', 'source', 'source_match_id', 'home_team_id', 'away_team_id', 'date', 'home_xg', 'away_xg', 'custom']) assert.equal(row[field], previous[field], field);
    assert.equal(row.home_goals, 0); assert.equal(row.away_goals, 0);
    const raw = JSON.parse(row.raw_json);
    assert.deepEqual(raw.details, JSON.parse(previous.raw_json).details); assert.deepEqual(raw.unknown, { nested: 'keep' });
    assert.deepEqual(Object.keys(raw.fieldProvenance).sort(), ['away_goals', 'home_goals']);
    assert.equal(raw.fieldProvenance.home_goals.source, 'football_data_org');
    assert.equal(raw.resultObservation.source, 'football_data_org');
    assert.equal(raw.resultObservation.observedAt, acquiredAt);
    assert.equal(raw.resultObservation.snapshotSha256, f.snapshot.contentSha256);
    assert.equal(raw.resultObservation.payloadSha256, f.snapshot.payloadSha256);
  }
  const changedBefore = (await f.client.execute('SELECT total_changes() AS n')).rows[0].n;
  const replay = await applySourceFeedImport({ ...f, plan });
  assert.equal(replay.applied, 0); assert.equal(replay.alreadyApplied, 2);
  assert.equal((await f.client.execute('SELECT total_changes() AS n')).rows[0].n, changedBefore);
  assert.deepEqual(await f.rows(), after);
  assert.equal((await f.plan()).counts.updates, 0);
});

test('a matching known side remains untouched and provenance describes only the filled side', async (t) => {
  const raw = { fieldProvenance: { home_goals: { source: 'understat' }, home_xg: { source: 'understat' } }, keep: true };
  const f = await fixture(t, undefined, [{ match_id: 'one', home_team_id: 'home', away_team_id: 'away', home_goals: 0, raw_json: JSON.stringify(raw) }]);
  const plan = await f.plan(); assert.deepEqual(plan.updates[0].fields, ['away_goals']);
  await applySourceFeedImport({ ...f, plan });
  const after = JSON.parse((await f.rows())[0].raw_json);
  assert.deepEqual(after.fieldProvenance.home_goals, raw.fieldProvenance.home_goals);
  assert.deepEqual(after.fieldProvenance.home_xg, raw.fieldProvenance.home_xg);
  assert.equal(after.fieldProvenance.away_goals.source, 'football_data_org');
  assert.deepEqual(after.resultObservation.fields, ['away_goals']);
});

test('any known-result conflict blocks the complete plan without writing even its valid entries', async (t) => {
  const f = await fixture(t); await f.client.execute("UPDATE matches SET home_goals=2 WHERE match_id='understat_71'");
  const before = await f.rows(), plan = await f.plan();
  assert.equal(plan.status, 'blocked'); assert.equal(plan.entries[0].reason, 'existing_result_conflict');
  await assert.rejects(applySourceFeedImport({ ...f, plan }), { message: 'source_import_plan_not_ready' });
  assert.deepEqual(await f.rows(), before);
});

test('missing finished score never fills a missing local result with zero', async (t) => {
  const f = await fixture(t, (payload) => { payload.matches[0].score.fullTime.home = null; });
  const plan = await f.plan(); assert.equal(plan.entries[0].reason, 'finished_score_unavailable');
  assert.equal(plan.updates.length, 1);
  await applySourceFeedImport({ ...f, plan });
  const row = (await f.rows()).find((entry) => entry.match_id === 'understat_71');
  assert.equal(row.home_goals, null); assert.equal(row.away_goals, null);
});

test('finished date mismatch requires review, while the original time on the same UTC date is preserved', async (t) => {
  const f = await fixture(t); await f.client.execute("UPDATE matches SET date='2026-08-03T00:00:00Z' WHERE match_id='understat_71'");
  const plan = await f.plan(); assert.equal(plan.status, 'blocked');
  assert.equal(plan.entries[0].reason, 'finished_fixture_date_requires_review');
});

test('only explicit TIMED future mismatches with two null local goals may update kickoff', async (t) => {
  const f = await fixture(t, (payload) => { payload.matches[0].status = 'TIMED'; payload.matches[0].utcDate = '2026-11-06T12:00:00Z'; }, [
    { match_id: 'future', home_team_id: 'home', away_team_id: 'away', date: '2026-11-06T13:00:00Z' },
  ]);
  const plan = await f.plan();
  assert.equal(plan.updates.length, 1); assert.equal(plan.entries[0].action, 'UPDATE_KICKOFF');
  assert.equal(plan.entries[0].reason, 'explicit_future_kickoff_mismatch');
  await applySourceFeedImport({ ...f, plan });
  const [row] = await f.rows();
  assert.equal(row.date, '2026-11-06T12:00:00.000Z'); assert.equal(row.home_goals, null); assert.equal(row.away_goals, null);
  assert.deepEqual(Object.keys(JSON.parse(row.raw_json).fieldProvenance), ['date']);
  assert.equal(JSON.parse(row.raw_json).resultObservation, undefined);
});

test('future kickoff changes cannot overwrite a local result or move a local past fixture', async (t) => {
  const f = await fixture(t, (payload) => { payload.matches[0].status = 'TIMED'; payload.matches[0].utcDate = '2026-11-06T12:00:00Z'; }, [
    { match_id: 'future', home_team_id: 'home', away_team_id: 'away', date: '2026-11-06T13:00:00Z', home_goals: 0 },
  ]);
  assert.equal((await f.plan()).status, 'blocked');
  await f.client.execute("UPDATE matches SET home_goals=NULL,date='2026-11-04T13:00:00Z'");
  const past = await f.plan(); assert.equal(past.updates.length, 0); assert.equal(past.entries[0].reason, 'fixture_not_eligible_for_update');
});

test('unknown local teams and ambiguous same-season pairs are blocked without creating records', async (t) => {
  const f = await fixture(t), unknown = mapping(); unknown.teams['2'] = 'not-present';
  const missingTeam = await f.plan({ mapping: unknown });
  assert.equal(missingTeam.status, 'blocked'); assert.equal(missingTeam.entries[0].reason, 'mapped_local_team_missing');
  await f.client.execute(`INSERT INTO matches(match_id,home_team_id,away_team_id,competition,season,date,home_goals,away_goals,source,source_match_id,raw_json)
    SELECT 'duplicate',home_team_id,away_team_id,competition,'2026-2027',date,home_goals,away_goals,source,source_match_id,raw_json
    FROM matches WHERE match_id='understat_71'`);
  const ambiguous = await f.plan(); assert.equal(ambiguous.status, 'blocked'); assert.equal(ambiguous.entries[0].reason, 'local_fixture_ambiguous');
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM teams')).rows[0].n, 2);
});

test('unmapped or missing local fixtures are explicitly skipped, never created', async (t) => {
  const f = await fixture(t, undefined, []), plan = await f.plan();
  assert.equal(plan.status, 'ready'); assert.equal(plan.updates.length, 0);
  assert.equal(plan.entries[0].reason, 'local_fixture_missing');
  await applySourceFeedImport({ ...f, plan });
  assert.deepEqual(await f.rows(), []);
});

test('retained failed, stale or hash-invalid snapshots cannot even query the target', async (t) => {
  const f = await fixture(t), forbidden = { execute: async () => assert.fail('unavailable source must not read target') };
  for (const [feed, asOfTime, expected] of [
    [{ ...f.feed, available: false, status: 'failure' }, asOf, 'source_import_latest_source_unavailable'],
    [f.feed, '2026-11-05T12:15:00Z', 'source_import_source_stale'],
    [{ ...f.feed, snapshot: { ...f.snapshot, fixtures: [] } }, asOf, 'source_import_source_hash_mismatch'],
  ]) {
    const plan = await planSourceFeedImport({ client: forbidden, feed, mapping: mapping(), asOf: asOfTime });
    assert.equal(plan.status, 'unavailable'); assert.equal(plan.reason, expected); assert.equal(plan.updates.length, 0);
  }
});

test('unreviewed, non-unique or wrong-scope mappings are rejected', async (t) => {
  const f = await fixture(t);
  for (const overrides of [{ reference: '' }, { reviewedAt: '2026-11-06T00:00:00Z' }, { teams: { 1: 'home', 2: 'home' } }]) {
    await assert.rejects(f.plan({ mapping: { ...mapping(), ...overrides } }));
  }
  await assert.rejects(runSourceFeedImport({ ...f, competition: 'SA', season: 2026 }), { message: 'source_import_mapping_scope_mismatch' });
});

test('invalid or non-object raw JSON is preserved and blocks rather than discarded', async (t) => {
  const f = await fixture(t); await f.client.execute("UPDATE matches SET raw_json='[1,2,3]' WHERE match_id='understat_71'");
  const plan = await f.plan(); assert.equal(plan.status, 'blocked'); assert.equal(plan.entries[0].reason, 'local_raw_json_requires_review');
  assert.equal((await f.rows())[0].raw_json, '[1,2,3]');
});

test('target concurrency in identity, values or raw JSON aborts the entire apply', async (t) => {
  const f = await fixture(t), plan = await f.plan();
  await f.client.execute("UPDATE matches SET raw_json='{\"external\":true}' WHERE match_id='understat_72'");
  const before = await f.rows();
  await assert.rejects(applySourceFeedImport({ ...f, plan }), { message: 'source_import_target_changed' });
  assert.deepEqual(await f.rows(), before);
});

test('a write failure after the first mutation rolls back all changes', async (t) => {
  const f = await fixture(t), plan = await f.plan(), before = await f.rows();
  const wrapper = { execute: f.client.execute.bind(f.client), transaction: async () => {
    const transaction = await f.client.transaction('write'); let updates = 0;
    return { execute: async (statement) => {
      if (/^UPDATE /.test(statement.sql) && ++updates === 2) throw Error('synthetic_write_failure');
      return transaction.execute(statement);
    }, commit: () => transaction.commit(), rollback: () => transaction.rollback(), close: () => transaction.close() };
  } };
  await assert.rejects(applySourceFeedImport({ ...f, client: wrapper, plan }), { message: 'synthetic_write_failure' });
  assert.deepEqual(await f.rows(), before);
});

test('latest source failure or cache error after planning cannot use the retained success', async (t) => {
  const f = await fixture(t), plan = await f.plan(), before = await f.rows();
  const later = '2026-11-05T12:16:00.000Z';
  const failed = await f.store.beginAttempt('PL', 2026, later); await f.store.fail(failed, 'calendar_network_error', later);
  await assert.rejects(applySourceFeedImport({ ...f, plan, asOf: later }), { message: 'source_import_latest_source_unavailable' });
  await assert.rejects(applySourceFeedImport({ ...f, plan, store: { read: async () => { throw Error('synthetic_cache_error'); } } }), { message: 'synthetic_cache_error' });
  assert.deepEqual(await f.rows(), before);
});

test('editing a reviewed plan invalidates its hash and never mutates the target', async (t) => {
  const f = await fixture(t), plan = await f.plan(), before = await f.rows();
  plan.updates[0].after.home_goals = 99;
  await assert.rejects(applySourceFeedImport({ ...f, plan }), { message: 'source_import_plan_hash_mismatch' });
  assert.deepEqual(await f.rows(), before);
});

test('provenance stamping preserves large numeric lexemes, duplicate keys and unrelated nested JSON', async (t) => {
  const legacy = '{"large":900719925474099312345,"dup":1,"dup":2,"unknown":{"scientific":1.2300e+05},"resultObservation":{"legacy":90071992547409935555}}';
  const f = await fixture(t, undefined, [{ match_id: 'legacy', home_team_id: 'home', away_team_id: 'away', raw_json: legacy }]);
  const plan = await f.plan(); await applySourceFeedImport({ ...f, plan });
  const raw = (await f.rows())[0].raw_json;
  assert.ok(raw.includes('"large":900719925474099312345'));
  assert.equal(raw.match(/"dup":/g).length, 2);
  assert.ok(raw.includes('"unknown":{"scientific":1.2300e+05}'));
  assert.ok(raw.includes('"legacy":90071992547409935555'));
  assert.equal(JSON.parse(raw).resultObservation.source, 'football_data_org');
});

test('future fixture creation requires explicit opt-in and uses real provider identity, canonical local names and null stats', async (t) => {
  const f = await fixture(t, (payload) => {
    payload.matches[0].status = 'SCHEDULED'; payload.matches[0].utcDate = '2026-11-06T12:00:00Z';
    payload.matches[0].homeTeam.name = 'Unreviewed provider spelling';
  }, []);
  const disabled = await f.plan(); assert.equal(disabled.creates.length, 0);
  const plan = await f.plan({ allowCreateFixtures: true });
  assert.equal(plan.status, 'ready'); assert.equal(plan.creates.length, 1);
  assert.equal(plan.entries[0].action, 'CREATE_FIXTURE');
  const created = await applySourceFeedImport({ ...f, plan });
  assert.equal(created.created, 1); assert.equal(created.applied, 1);
  const [row] = await f.rows();
  assert.equal(row.match_id, 'football_data_org_1'); assert.equal(row.source, 'football_data_org'); assert.equal(row.source_match_id, 1);
  assert.equal(row.home_team_name, 'Canonical Home'); assert.equal(row.away_team_name, 'Canonical Away');
  for (const field of ['home_goals', 'away_goals', 'home_xg', 'away_xg', 'home_shots', 'away_yellow_cards']) assert.equal(row[field], null, field);
  assert.equal(JSON.parse(row.raw_json).fieldProvenance.date.source, 'football_data_org');
  assert.equal(JSON.parse(row.raw_json).resultObservation, undefined);
  const replay = await applySourceFeedImport({ ...f, plan });
  assert.equal(replay.created, 0); assert.equal(replay.applied, 0); assert.equal(replay.alreadyApplied, 1);
  const repeated = await f.plan({ allowCreateFixtures: true }); assert.equal(repeated.creates.length, 0); assert.equal(repeated.updates.length, 0);
});

test('completed, in-play and missing-kickoff source fixtures are never created', async (t) => {
  const f = await fixture(t, (payload) => {
    payload.matches[0].status = 'IN_PLAY';
    payload.matches[19].status = 'SCHEDULED'; payload.matches[19].utcDate = null;
  }, []);
  const plan = await f.plan({ allowCreateFixtures: true });
  assert.equal(plan.creates.length, 0); assert.equal(plan.updates.length, 0);
  assert.equal(plan.entries[0].reason, 'new_fixture_not_future');
  await applySourceFeedImport({ ...f, plan }); assert.deepEqual(await f.rows(), []);
});

test('a race inserting a future pair after planning aborts creation instead of duplicating or adopting it', async (t) => {
  const f = await fixture(t, (payload) => { payload.matches[0].status = 'TIMED'; payload.matches[0].utcDate = '2026-11-06T12:00:00Z'; }, []);
  const plan = await f.plan({ allowCreateFixtures: true });
  await f.client.execute("INSERT INTO matches(match_id,home_team_id,away_team_id,competition,season,date,source) VALUES ('other','home','away','Premier League','2026/2027','2026-11-06T12:00:00Z','manual')");
  const before = await f.rows();
  await assert.rejects(applySourceFeedImport({ ...f, plan }), { message: 'source_import_target_changed' });
  assert.deepEqual(await f.rows(), before);
});

test('verified subset approval requires the exact caller-approved hash and never changes blocked plan status', async (t) => {
  const f = await fixture(t); await f.client.execute("UPDATE matches SET home_goals=2 WHERE match_id='understat_71'");
  const plan = await f.plan(), before = await f.rows();
  await assert.rejects(applySourceFeedImport({ ...f, plan, allowVerifiedSubset: true, expectedPlanHash: '0'.repeat(64) }), { message: 'source_import_subset_approval_mismatch' });
  await assert.rejects(applySourceFeedImport({ ...f, plan, allowVerifiedSubset: true }), { message: 'source_import_subset_approval_mismatch' });
  assert.equal(plan.status, 'blocked'); assert.deepEqual(await f.rows(), before);
});

test('an approved exact subset fills only the verified result, retains three blocked fixtures and replays idempotently', async (t) => {
  const f = await fixture(t);
  await f.client.execute("UPDATE matches SET home_goals=2 WHERE match_id='understat_71'");
  await f.client.execute("INSERT INTO teams VALUES ('third','Canonical Third'),('fourth','Canonical Fourth')");
  await f.client.execute(`INSERT INTO matches(match_id,home_team_id,away_team_id,competition,season,date,home_goals,source)
    VALUES ('blocked-second','home','third','Premier League','2026/2027','2026-08-02T12:00:00Z',2,'manual'),
    ('blocked-third','third','home','Premier League','2026/2027','2026-08-02T12:00:00Z',2,'manual')`);
  const reviewed = mapping(); reviewed.teams['3'] = 'third'; reviewed.teams['4'] = 'fourth';
  const plan = await f.plan({ mapping: reviewed }), before = await f.rows();
  assert.equal(plan.status, 'blocked'); assert.equal(plan.counts.blocked, 3); assert.equal(plan.updates.length, 1);
  const options = { ...f, plan, allowVerifiedSubset: true, expectedPlanHash: plan.planHash };
  const applied = await applySourceFeedImport(options);
  assert.equal(applied.partial, true); assert.equal(applied.planStatus, 'blocked');
  assert.equal(applied.blockedSkipped, 3); assert.equal(applied.applied, 1);
  const after = await f.rows();
  assert.deepEqual(after.filter((row) => row.match_id !== 'understat_72'), before.filter((row) => row.match_id !== 'understat_72'));
  assert.equal(after.find((row) => row.match_id === 'understat_72').home_goals, 0);
  assert.equal(plan.status, 'blocked');
  const changeCount = (await f.client.execute('SELECT total_changes() AS n')).rows[0].n;
  const replay = await applySourceFeedImport(options);
  assert.equal(replay.applied, 0); assert.equal(replay.alreadyApplied, 1); assert.equal(replay.blockedSkipped, 3); assert.equal(replay.partial, true);
  assert.equal((await f.client.execute('SELECT total_changes() AS n')).rows[0].n, changeCount);
});

for (const collision of ['blocked local ID', 'duplicate allowed entry']) test(`subset rejects ${collision} even with a matching approved plan hash`, async (t) => {
  const f = await fixture(t); await f.client.execute("UPDATE matches SET home_goals=2 WHERE match_id='understat_71'");
  const plan = await f.plan(), before = await f.rows();
  if (collision === 'blocked local ID') plan.entries.find((entry) => entry.action === 'BLOCK').localMatchId = plan.updates[0].before.match_id;
  else plan.entries.push({ ...plan.entries.find((entry) => entry.action === 'FILL_RESULTS') });
  rehash(plan);
  await assert.rejects(applySourceFeedImport({ ...f, plan, allowVerifiedSubset: true, expectedPlanHash: plan.planHash }), { message: 'source_import_subset_binding_invalid' });
  assert.deepEqual(await f.rows(), before);
});

test('subset creation can add an approved future fixture while leaving a blocked completed fixture untouched', async (t) => {
  const f = await fixture(t, (payload) => { payload.matches[0].status = 'TIMED'; payload.matches[0].utcDate = '2026-11-06T12:00:00Z'; }, [
    { match_id: 'blocked', home_team_id: 'away', away_team_id: 'home', home_goals: 2 },
  ]);
  const plan = await f.plan({ allowCreateFixtures: true }), before = await f.rows();
  assert.equal(plan.status, 'blocked'); assert.equal(plan.creates.length, 1);
  const result = await applySourceFeedImport({ ...f, plan, allowVerifiedSubset: true, expectedPlanHash: plan.planHash });
  assert.equal(result.created, 1); assert.equal(result.partial, true); assert.equal(result.blockedSkipped, 1);
  assert.deepEqual((await f.rows()).filter((row) => row.match_id === 'blocked'), before);
});

test('a source failure detected immediately before commit rolls back an approved subset', async (t) => {
  const f = await fixture(t); await f.client.execute("UPDATE matches SET home_goals=2 WHERE match_id='understat_71'");
  const plan = await f.plan(), before = await f.rows(); let reads = 0;
  const store = { read: async () => ++reads === 1 ? f.feed : { ...f.feed, available: false, status: 'failure', reason: 'calendar_timeout' } };
  await assert.rejects(applySourceFeedImport({ ...f, store, plan, allowVerifiedSubset: true, expectedPlanHash: plan.planHash }), { message: 'source_import_latest_source_unavailable' });
  assert.equal(reads, 2); assert.deepEqual(await f.rows(), before);
});

test('the subset override is not applicable to a ready plan', async (t) => {
  const f = await fixture(t), plan = await f.plan();
  await assert.rejects(applySourceFeedImport({ ...f, plan, allowVerifiedSubset: true, expectedPlanHash: plan.planHash }), { message: 'source_import_subset_not_applicable' });
});

async function identityFixture(t, options = {}) {
  const localId = options.localId ?? 'understat_team_172', localName = options.localName ?? 'Troyes';
  const f = await fixture(t, (payload) => {
    for (const match of payload.matches) for (const side of ['homeTeam', 'awayTeam']) {
      if (match[side].id === 1) { match[side].id = options.providerId ?? 531; match[side].name = options.providerName ?? 'Troyes'; }
    }
    if (options.future) { payload.matches[0].status = 'TIMED'; payload.matches[0].utcDate = '2026-11-06T12:00:00Z'; }
  }, options.empty ? [] : undefined, { competition: options.competition ?? 'FL1', season: options.season ?? 2026 });
  await f.client.execute({ sql: "UPDATE teams SET team_id=?,name=? WHERE team_id='home'", args: [localId, localName] });
  await f.client.execute({ sql: `UPDATE matches SET
    home_team_name=CASE WHEN home_team_id='home' THEN ? ELSE home_team_name END,
    away_team_name=CASE WHEN away_team_id='home' THEN ? ELSE away_team_name END,
    home_team_id=CASE WHEN home_team_id='home' THEN ? ELSE home_team_id END,
    away_team_id=CASE WHEN away_team_id='home' THEN ? ELSE away_team_id END`, args: [localName, localName, localId, localId] });
  f.mapping.teams = { [options.providerId ?? 531]: localId, 2: 'away' };
  return f;
}

for (const options of [
  {}, { localName: 'Estac Troyes', providerName: 'Troyes' }, { localName: 'Troyes', providerName: 'Estac Troyes' },
  { localName: 'Troyes', providerName: 'ES Troyes AC' },
  { localId: 'le_havre', localName: 'Havre AC', providerId: 533, providerName: 'Le Havre' },
  { localId: 'le_havre', localName: 'Le Havre', providerId: 533, providerName: 'Havre AC' },
  { localId: 'le_havre', localName: 'Le Havre', providerId: 533, providerName: 'Le Havre AC' },
  { localId: 'understat_team_295', localName: 'Le Mans', providerId: 535, providerName: 'Le Mans FC' },
]) test(`resolved identities and reviewed aliases import without renaming: ${JSON.stringify(options)}`, async (t) => {
  const f = await identityFixture(t, options), before = await f.rows(), plan = await f.plan();
  assert.equal(plan.status, 'ready'); assert.equal(plan.updates.length, 2);
  assert.equal((await applySourceFeedImport({ ...f, plan })).applied, 2);
  for (const row of await f.rows()) {
    const original = before.find((item) => item.match_id === row.match_id);
    assert.equal(row.home_team_id, original.home_team_id); assert.equal(row.away_team_id, original.away_team_id);
    assert.equal(row.home_team_name, original.home_team_name); assert.equal(row.away_team_name, original.away_team_name);
  }
});

for (const options of [
  { providerName: 'Le Havre' },
  { localName: 'Le Havre', providerName: 'Le Havre' },
  { localName: 'Le Havre', providerName: 'Troyes' },
  { providerId: 533, providerName: 'Troyes' },
  { localId: 'le_havre', localName: 'Havre AC', providerName: 'Le Havre' },
  { localId: 'understat_team_295', localName: 'Le Mans', providerName: 'Le Mans FC' },
]) test(`incorrect reviewed identity still blocks all affected fixtures: ${JSON.stringify(options)}`, async (t) => {
  const f = await identityFixture(t, options), before = await f.rows(), plan = await f.plan({ allowCreateFixtures: true });
  assert.equal(plan.status, 'blocked'); assert.equal(plan.updates.length, 0); assert.equal(plan.creates.length, 0);
  const providerId = String(options.providerId ?? 531);
  const involved = new Set(f.snapshot.fixtures.filter((row) => row.providerHomeTeamId === providerId || row.providerAwayTeamId === providerId).map((row) => row.providerMatchId));
  assert.equal(involved.size, 34);
  for (const entry of plan.entries.filter((row) => involved.has(row.providerMatchId))) {
    assert.equal(entry.action, 'BLOCK'); assert.equal(entry.reason, 'source_import_team_identity_mismatch'); assert.deepEqual(entry.fields, []);
  }
  assert.deepEqual(plan.entries[0].relatedLocalMatchIds, ['understat_71']);
  assert.deepEqual(await f.rows(), before);
});

test('a verified future Troyes fixture can be created with its existing identity and null statistics', async (t) => {
  const f = await identityFixture(t, { future: true, empty: true }), plan = await f.plan({ allowCreateFixtures: true });
  assert.equal(plan.status, 'ready'); assert.equal(plan.creates.length, 1);
  const result = await applySourceFeedImport({ ...f, plan });
  assert.equal(result.created, 1);
  const [row] = await f.rows();
  assert.equal(row.home_team_id, 'understat_team_172'); assert.equal(row.home_team_name, 'Troyes');
  assert.equal(row.home_xg, null); assert.equal(row.home_shots, null);
});

test('a mismatched future association cannot create a fixture even with explicit opt-in', async (t) => {
  const f = await identityFixture(t, { future: true, empty: true, providerName: 'Le Havre' }), plan = await f.plan({ allowCreateFixtures: true });
  assert.equal(plan.entries[0].action, 'BLOCK'); assert.equal(plan.creates.length, 0);
  const result = await applySourceFeedImport({ ...f, plan, allowVerifiedSubset: true, expectedPlanHash: plan.planHash });
  assert.equal(result.applied, 0); assert.equal(result.partial, true); assert.equal(result.blockedSkipped, 34);
  assert.deepEqual(await f.rows(), []);
});

for (const options of [
  { localId: 'understat_team_1720', localName: 'Unreviewed alias', providerName: 'Unreviewed provider spelling' },
  { competition: 'PL', localName: 'Le Havre', providerName: 'Troyes' },
  { season: 2025, localName: 'Le Havre', providerName: 'Troyes' },
]) test(`the bounded review leaves unrelated aliases and scopes unchanged: ${JSON.stringify(options)}`, async (t) => {
  const f = await identityFixture(t, options), plan = await f.plan();
  assert.equal(plan.status, 'ready'); assert.equal(plan.counts.blocked, 0); assert.equal(plan.updates.length, 2);
  assert.equal((await applySourceFeedImport({ ...f, plan })).applied, 2);
});

test('an approved subset imports unrelated results while mismatched identities remain blocked', async (t) => {
  const f = await identityFixture(t, { providerName: 'Le Havre' });
  f.mapping.teams['3'] = 'third'; await f.client.execute("INSERT INTO teams VALUES ('third','Canonical Third')");
  await f.client.execute(`INSERT INTO matches(match_id,home_team_id,away_team_id,competition,season,date,source,raw_json)
    VALUES ('unrelated','away','third','Ligue 1','2026/2027','2026-08-02T18:00:00Z','manual','{"keep":true}')`);
  const plan = await f.plan(), before = await f.rows();
  assert.equal(plan.status, 'blocked'); assert.equal(plan.updates.length, 1); assert.equal(plan.updates[0].before.match_id, 'unrelated');
  const result = await applySourceFeedImport({ ...f, plan, allowVerifiedSubset: true, expectedPlanHash: plan.planHash });
  assert.equal(result.applied, 1); assert.equal(result.partial, true); assert.equal(result.blockedSkipped, 34);
  assert.deepEqual((await f.rows()).filter((row) => row.match_id !== 'unrelated'), before.filter((row) => row.match_id !== 'unrelated'));
});

for (const create of [false, true]) for (const subset of [false, true]) {
  test(`apply revalidates a prepared incorrect ${create ? 'creation' : 'result'} plan, subset=${subset}`, async (t) => {
    // An old plan with an unknown local ID did not have the bounded review.
    // Rehashing it and changing the target coherently cannot authorize a bad association.
    const f = await identityFixture(t, { localId: 'legacy_local', localName: 'Troyes', providerName: 'Le Havre', future: create, empty: create });
    const plan = await f.plan({ allowCreateFixtures: create });
    assert.equal(plan.status, 'ready');
    plan.mapping.teams['531'] = 'understat_team_172';
    plan.mappingSha256 = canonicalHash(plan.mapping);
    const replaceId = (row) => {
      for (const side of ['home_team_id', 'away_team_id']) if (row[side] === 'legacy_local') row[side] = 'understat_team_172';
    };
    for (const update of plan.updates) { replaceId(update.before); replaceId(update.after); }
    for (const entry of plan.creates) replaceId(entry.after);
    await f.client.execute("UPDATE teams SET team_id='understat_team_172' WHERE team_id='legacy_local'");
    await f.client.execute(`UPDATE matches SET home_team_id=CASE WHEN home_team_id='legacy_local' THEN 'understat_team_172' ELSE home_team_id END,
      away_team_id=CASE WHEN away_team_id='legacy_local' THEN 'understat_team_172' ELSE away_team_id END`);
    if (subset) {
      const unrelated = plan.entries.find((entry) => entry.action === 'SKIP' && entry.providerMatchId !== '1');
      unrelated.action = 'BLOCK'; unrelated.reason = 'existing_result_conflict';
      plan.status = 'blocked'; plan.reason = 'source_import_review_required'; plan.counts.blocked++;
    }
    rehash(plan); const before = await f.rows();
    await assert.rejects(applySourceFeedImport({ ...f, plan, allowVerifiedSubset: subset,
      expectedPlanHash: subset ? plan.planHash : undefined }), { message: 'source_import_team_identity_mismatch' });
    assert.deepEqual(await f.rows(), before);
  });
}

for (const create of [false, true]) test(`a cosmetic rename after planning aborts ${create ? 'creation' : 'updates'}`, async (t) => {
  const f = await identityFixture(t, { future: create, empty: create }), plan = await f.plan({ allowCreateFixtures: create });
  assert.equal(plan.status, 'ready');
  await f.client.execute("UPDATE teams SET name='Le Havre' WHERE team_id='understat_team_172'");
  const before = await f.rows();
  await assert.rejects(applySourceFeedImport({ ...f, plan }), { message: 'source_import_team_identity_mismatch' });
  assert.deepEqual(await f.rows(), before);
});
