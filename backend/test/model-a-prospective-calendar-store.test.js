'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { ModelAResearchCalendarStore, calendarMappingHash } = require('../dist/research/ModelAResearchCalendarStore');
const { FOOTBALL_DATA_COMPETITIONS } = require('../dist/services/modelAResearchCalendar');
const names = { SA: 'Serie A', PL: 'Premier League', PD: 'La Liga', BL1: 'Bundesliga', FL1: 'Ligue 1' };

async function setup() {
  const client = createClient({ url: 'file::memory:' });
  await client.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
  await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,home_team_id TEXT,away_team_id TEXT,competition TEXT,season TEXT,date TEXT,source TEXT,source_match_id INTEGER)');
  await client.execute({ sql: "INSERT INTO model_a_collection_protocols(protocol_id,scope_json,created_at) VALUES('p','{}','2026-11-05T00:00:00.000Z')" });
  const mapping = {}, counts = {};
  for (const [index, [code, name]] of Object.entries(names).entries()) {
    mapping[name] = { '1': `${code}-a`, '2': `${code}-b` }; counts[name] = 2;
    for (const [n,h,a] of [[12, 'a', 'b'], [21, 'b', 'a']]) await client.execute({ sql: 'INSERT INTO matches VALUES(?,?,?,?,?,?,?,?)', args: [`understat_${index * 100 + n}`, `${code}-${h}`, `${code}-${a}`, name, '2026/27', '2026-01-01T00:00:00Z', 'understat', index * 100 + n] });
  }
  const scope = { protocolId: 'p', manifestSha256: 'a'.repeat(64), seasons: ['2026/27'], from: '2026-11-01T00:00:00Z', to: '2027-08-01T00:00:00Z', calendar: { source: 'football-data.org', mappingSha256: calendarMappingHash(mapping), expectedTeamCounts: counts, maxAgeSeconds: 3600 } };
  return { client, mapping, scope };
}
function fetchPayload({competition}) {
  return Promise.resolve({ acquiredAt: 'ignored', payload: { competition: { id: FOOTBALL_DATA_COMPETITIONS[competition] }, season: { startDate: '2026-08-01' }, matches: [[12, 1, 2], [21, 2, 1]].map(([id,h,a]) => ({ id, utcDate: '2026-11-06T10:00:00Z', lastUpdated: '2026-11-05T09:00:00Z', status: 'TIMED', homeTeam: { id: h }, awayTeam: { id: a } })) } });
}

test('five calls produce atomic evidence and preserve operational matches', async () => {
  const x = await setup(); let calls = 0; let now = Date.parse('2026-11-05T10:00:00Z');
  try {
    const store = new ModelAResearchCalendarStore(x.client, { mapping: x.mapping, apiKey: 'private', clock: () => new Date(now), fetch: async args => { calls++; return fetchPayload(args); } });
    const result = await store.refresh(x.scope);
    assert.equal(calls, 5); assert.equal(result.fixtures.length, 10);
    const item = result.fixtures[0];
    assert.deepEqual(await store.current(item.matchId, item.evidence.observationId, item.evidence.attemptId), item.evidence);
    assert.equal((await x.client.execute('SELECT COUNT(*) AS n FROM model_a_calendar_fixtures')).rows[0].n, 10);
    assert.equal((await x.client.execute("SELECT COUNT(*) AS n FROM matches WHERE date='2026-01-01T00:00:00Z'")).rows[0].n, 10);
    assert.equal(item.evidence.publicationAt, null);
    now += 3600001;
    assert.equal(await store.current(item.matchId, item.evidence.observationId, item.evidence.attemptId), null);
  } finally { x.client.close(); }
});

test('failed latest acquisition invalidates previous proof and persists only redacted errors', async () => {
  const x = await setup(); let now = Date.parse('2026-11-05T10:00:00Z'); let failure = false;
  try {
    const store = new ModelAResearchCalendarStore(x.client, { mapping: x.mapping, apiKey: 'private-token', clock: () => new Date(now), fetch: async args => { if (failure && args.competition === 'SA') throw new Error('private-token'); return fetchPayload(args); } });
    const first = await store.refresh(x.scope); now += 1000; failure = true;
    await store.refresh(x.scope);
    assert.equal(await store.current(first.fixtures[0].matchId, first.fixtures[0].evidence.observationId, first.fixtures[0].evidence.attemptId), null);
    const failed = (await x.client.execute("SELECT coverage_json FROM model_a_calendar_attempts WHERE status='failed'" )).rows;
    assert.equal(failed.length, 1); assert(!String(failed[0].coverage_json).includes('private-token'));
  } finally { x.client.close(); }
});

test('mapping hash mismatch blocks all calls; incomplete feed is preserved but never projected', async () => {
  const x = await setup(); let calls = 0;
  try {
    const store = new ModelAResearchCalendarStore(x.client, { mapping: x.mapping, apiKey: 'x', clock: () => new Date('2026-11-05T10:00:00Z'), fetch: async args => { calls++; const response = await fetchPayload(args); if (args.competition === 'PL') response.payload.matches.pop(); return response; } });
    await assert.rejects(store.refresh({ ...x.scope, calendar: { ...x.scope.calendar, mappingSha256: '0'.repeat(64) } }), /calendar_scope_invalid/);
    assert.equal(calls, 0);
    const out = await store.refresh(x.scope);
    assert.equal(out.fixtures.length, 8);
    const row = (await x.client.execute("SELECT coverage_json FROM model_a_calendar_attempts WHERE competition='Premier League'" )).rows[0];
    assert.equal(JSON.parse(String(row.coverage_json)).complete, false);
    assert.equal(JSON.parse(String(row.coverage_json)).providerFixtures, 1);
  } finally { x.client.close(); }
});

test('a newer revision or indistinguishable acquisition time invalidates claimed evidence', async () => {
  const x = await setup(); let now = Date.parse('2026-11-05T10:00:00Z'); let revision = false;
  try {
    const store = new ModelAResearchCalendarStore(x.client, { mapping: x.mapping, apiKey: 'x', clock: () => new Date(now), fetch: async args => {
      const response = await fetchPayload(args);
      if (revision) response.payload.matches[0].utcDate = '2026-11-07T10:00:00Z';
      return response;
    } });
    const first = await store.refresh(x.scope); now += 1000; revision = true;
    const second = await store.refresh(x.scope);
    assert.equal(await store.current(first.fixtures[0].matchId, first.fixtures[0].evidence.observationId, first.fixtures[0].evidence.attemptId), null);
    assert.equal((await store.current(second.fixtures[0].matchId, second.fixtures[0].evidence.observationId, second.fixtures[0].evidence.attemptId)).kickoffAt, '2026-11-07T10:00:00.000Z');
    await store.refresh(x.scope);
    assert.equal(await store.current(second.fixtures[0].matchId, second.fixtures[0].evidence.observationId, second.fixtures[0].evidence.attemptId), null);
  } finally { x.client.close(); }
});

test('identical snapshots reuse rows but new acquisition is the only current evidence', async () => {
  const x = await setup(); let now = Date.parse('2026-11-05T10:00:00Z'); let revision = false;
  try {
    const store = new ModelAResearchCalendarStore(x.client, { mapping: x.mapping, apiKey: 'x', clock: () => new Date(now), fetch: async args => {
      const response = await fetchPayload(args); if (revision && args.competition === 'SA') response.payload.matches[0].lastUpdated = '2026-11-05T09:30:00Z'; return response;
    } });
    const first = await store.refresh(x.scope); now += 1000;
    const second = await store.refresh(x.scope);
    assert.equal((await x.client.execute('SELECT COUNT(*) AS n FROM model_a_calendar_fixtures')).rows[0].n, 10);
    assert.equal(second.fixtures[0].evidence.observationId, first.fixtures[0].evidence.observationId);
    assert.notEqual(second.fixtures[0].evidence.attemptId, first.fixtures[0].evidence.attemptId);
    assert.equal(await store.current(first.fixtures[0].matchId, first.fixtures[0].evidence.observationId, first.fixtures[0].evidence.attemptId), null);
    assert.deepEqual(await store.current(second.fixtures[0].matchId, second.fixtures[0].evidence.observationId, second.fixtures[0].evidence.attemptId), second.fixtures[0].evidence);
    now += 1000; revision = true; await store.refresh(x.scope);
    assert.equal((await x.client.execute('SELECT COUNT(*) AS n FROM model_a_calendar_fixtures')).rows[0].n, 12);
  } finally { x.client.close(); }
});

test('unchanged incomplete feeds reuse observations but remain ineligible', async () => {
  const x = await setup(); let now = Date.parse('2026-11-05T10:00:00Z');
  try {
    const store = new ModelAResearchCalendarStore(x.client, { mapping: x.mapping, apiKey: 'x', clock: () => new Date(now), fetch: async args => {
      const response = await fetchPayload(args); if (args.competition === 'PL') response.payload.matches.pop(); return response;
    } });
    const first = await store.refresh(x.scope); now += 1000;
    const second = await store.refresh(x.scope);
    assert.equal(first.fixtures.length, 8); assert.equal(second.fixtures.length, 8);
    assert.equal((await x.client.execute('SELECT COUNT(*) AS n FROM model_a_calendar_fixtures')).rows[0].n, 9);
    const attempts = (await x.client.execute("SELECT fixture_attempt_id,coverage_json FROM model_a_calendar_attempts WHERE competition='Premier League'")).rows;
    assert.equal(attempts.length, 2); assert.equal(attempts[0].fixture_attempt_id, attempts[1].fixture_attempt_id);
    assert(attempts.every(row => JSON.parse(String(row.coverage_json)).complete === false));
  } finally { x.client.close(); }
});


test('changing an unmapped provider team invalidates incomplete snapshot reuse', async () => {
  const x = await setup(); let now = Date.parse('2026-11-05T10:00:00Z'); let providerTeamId = 3;
  try {
    const store = new ModelAResearchCalendarStore(x.client, { mapping: x.mapping, apiKey: 'x', clock: () => new Date(now), fetch: async args => {
      const response = await fetchPayload(args);
      if (args.competition === 'PL') { response.payload.matches.pop(); response.payload.matches[0].homeTeam.id = providerTeamId; }
      return response;
    } });
    await store.refresh(x.scope); now += 1000; await store.refresh(x.scope);
    let attempts = (await x.client.execute("SELECT fixture_attempt_id,coverage_json FROM model_a_calendar_attempts WHERE competition='Premier League' ORDER BY acquired_at")).rows;
    assert.equal(attempts[0].fixture_attempt_id, attempts[1].fixture_attempt_id);
    now += 1000; providerTeamId = 4; await store.refresh(x.scope);
    attempts = (await x.client.execute("SELECT fixture_attempt_id,coverage_json FROM model_a_calendar_attempts WHERE competition='Premier League' ORDER BY acquired_at")).rows;
    assert.notEqual(attempts[1].fixture_attempt_id, attempts[2].fixture_attempt_id);
    assert.notEqual(JSON.parse(String(attempts[1].coverage_json)).snapshotHash, JSON.parse(String(attempts[2].coverage_json)).snapshotHash);
    assert(attempts.every(row => JSON.parse(String(row.coverage_json)).complete === false));
  } finally { x.client.close(); }
});
