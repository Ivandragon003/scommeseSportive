const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createClient } = require('@libsql/client');
const { refreshModelAProspectiveResults, createModelAProspectiveResultRefreshSink } = require('../dist/research/ModelAProspectiveResultRefresh');

async function fixture(t, changes = {}) {
  const client = createClient({ url: 'file::memory:' }); t.after(() => client.close());
  await client.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
  await client.executeMultiple(`CREATE TABLE matches(match_id TEXT PRIMARY KEY,source TEXT,source_match_id INTEGER,date TEXT,home_team_id TEXT,away_team_id TEXT,home_goals INTEGER,away_goals INTEGER);
    CREATE TABLE teams(team_id TEXT PRIMARY KEY,source_team_id INTEGER); INSERT INTO teams VALUES ('h',1),('a',2);`);
  const now = Math.floor(Date.now() / 1000) * 1000 - 10000;
  const kickoff = new Date(now - 3 * 3600000).toISOString(), acquiredAt = new Date(now - 9 * 3600000).toISOString();
  const forecastAt = new Date(now - 8 * 3600000).toISOString(), operationalDate = new Date(now - 24 * 3600000).toISOString();
  const snapshot = { protocolId: 'protocol', calendar: { source: 'football-data.org', mappingSha256: 'a'.repeat(64), maxAgeSeconds: 7200 } };
  const manifestSha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const calendar = { source: 'football-data.org', providerMatchId: 77, matchId: 'understat_42', kickoffAt: kickoff,
    homeTeamId: 'h', awayTeamId: 'a', competition: 'Serie A', season: '2026/27', acquiredAt,
    providerLastUpdated: null, publicationAt: null, mappingSha256: 'a'.repeat(64), observationId: 'observation', attemptId: 'attempt', maxAgeSeconds: 7200 };
  if (changes.dedup) { calendar.attemptId = 'later-attempt'; calendar.acquiredAt = new Date(now - 8.5 * 3600000).toISOString(); }
  Object.assign(calendar, changes.calendar);
  await client.execute({ sql: 'INSERT INTO model_a_collection_protocols VALUES (?,?,?)', args: ['protocol', JSON.stringify({ snapshot, sha256: manifestSha256 }), acquiredAt] });
  await client.execute({ sql: 'INSERT INTO model_a_calendar_attempts VALUES (?,?,?,?,?,?,?,?)', args: ['attempt', 'protocol', 'Serie A', '2026/27', acquiredAt, 'success', JSON.stringify({complete:true, providerFixtures:380, unmapped:0, conflicts:0, duplicates:0}), 'attempt'] });
  if (changes.dedup) await client.execute({ sql: 'INSERT INTO model_a_calendar_attempts VALUES (?,?,?,?,?,?,?,?)', args: ['later-attempt', 'protocol', 'Serie A', '2026/27', new Date(now - 8.5 * 3600000).toISOString(), 'success', JSON.stringify({complete:true, providerFixtures:380, unmapped:0, conflicts:0, duplicates:0}), 'attempt'] });
  if (!changes.missingProof) await client.execute({ sql: 'INSERT INTO model_a_calendar_fixtures VALUES (?,?,?,?,?,?,?,?,?,?)', args: ['observation', 'attempt', '77', 'understat_42', kickoff, 'TIMED', null, null, 'h', 'a'] });
  await client.execute({ sql: 'INSERT INTO matches VALUES (?,?,?,?,?,?,?,?)', args: ['understat_42', 'understat', 42, operationalDate, 'h', 'a', null, null] });
  const payload = { origin:'prospective_a', homeTeamId:'h', awayTeamId:'a', competition:'Serie A', season:'2026/27', collection:{protocolId:'protocol', manifestSha256}, researchCalendar:calendar };
  await client.execute({ sql:'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)', args:['forecast','understat_42',forecastAt,kickoff,JSON.stringify(payload)] });
  const providerDate = changes.providerDate || kickoff;
  const raw = { id:'42', datetime:providerDate.slice(0, 19).replace('T',' '), isResult:true, h:{id:'1'}, a:{id:'2'}, goals:{h:'2',a:'1'} };
  const source = { scrapeSeason: async () => [{ matchId:'understat_42', sourceMatchId:42, date:raw.datetime, homeTeamId:'1', awayTeamId:'2', competition:'Serie A', season:'2026/27', homeGoals:2, awayGoals:1, rawJson:JSON.stringify(raw) }] };
  const summary = await refreshModelAProspectiveResults(createModelAProspectiveResultRefreshSink(client), { env:{ MODEL_A_PROSPECTIVE_ENABLED:'true', MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED:'true' }, clock:() => new Date(now), source });
  const results = (await client.execute('SELECT * FROM model_a_prospective_results')).rows;
  const observations = (await client.execute('SELECT * FROM model_a_prospective_result_observations')).rows;
  return { summary, results, observations, kickoff, operationalDate };
}

test('frozen research calendar allows stale operational date only when Understat confirms the exact kickoff', async t => {
  const f = await fixture(t);
  assert.equal(f.summary.recorded, 1); assert.equal(f.results[0].kickoff_at, f.kickoff);
  const evidence = JSON.parse(f.observations[0].evidence_json);
  assert.equal(evidence.currentKickoffAt, f.operationalDate); assert.equal(evidence.researchCalendar.observationId, 'observation');
});
test('changed actual kickoff never associates a research forecast', async t => {
  const f = await fixture(t, {providerDate:'2026-01-01T10:00:00.000Z'});
  assert.equal(f.summary.reasonCounts.kickoff_changed, 1); assert.equal(f.results.length, 0);
});
test('missing or inconsistent frozen calendar evidence fails closed', async t => {
  for (const changes of [{missingProof:true}, {calendar:{homeTeamId:'other'}}, {calendar:{mappingSha256:'b'.repeat(64)}}]) {
    const f = await fixture(t, changes);
    assert.equal(f.summary.reasonCounts.candidate_calendar_evidence_invalid, 1); assert.equal(f.results.length, 0);
  }
});

test('deduplicated observation uses the later successful acquisition while preserving the original fixture evidence', async t => {
  const f = await fixture(t, {dedup:true});
  assert.equal(f.summary.recorded, 1); assert.equal(JSON.parse(f.observations[0].evidence_json).researchCalendar.attemptId, 'later-attempt');
});
