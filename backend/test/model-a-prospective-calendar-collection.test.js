'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { ModelAProspectiveCollection, collectionScopeManifest } = require('../dist/research/ModelAProspectiveCollection');

test('research calendar date drives claim and frozen forecast without rewriting operational matches; changed evidence skips', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
    await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,home_team_id TEXT,away_team_id TEXT,competition TEXT,season TEXT,date TEXT,home_goals INTEGER,away_goals INTEGER,raw_json TEXT)');
    const now = Date.parse('2026-11-05T12:00:00Z'), kickoff = '2026-11-05T18:00:00.000Z', old = '2026-10-20T18:00:00.000Z';
    for (const id of ['understat_1', 'understat_2']) await client.execute({ sql: 'INSERT INTO matches VALUES(?,?,?,?,?,?,?,?,?)', args: [id, 'h', 'a', 'Serie A', '2026/27', old, null, null, '{}'] });
    const calendar = { source:'football-data.org', mappingSha256:'a'.repeat(64), maxAgeSeconds:3600, expectedTeamCounts:{'Serie A':20,'Premier League':20,'La Liga':20,Bundesliga:18,'Ligue 1':18} };
    const scope = { protocolId:'alt', seasons:['2026/27'], from:'2026-11-05T00:00:00Z', to:'2026-11-06T00:00:00Z', calendar };
    scope.manifestSha256 = collectionScopeManifest(scope).sha256;
    const fixtures = ['understat_1','understat_2'].map((matchId, index) => {
      const evidence = { source:'football-data.org', observationId:`observation-${index}`, providerMatchId:String(index+1), matchId, homeTeamId:'h', awayTeamId:'a', competition:'Serie A', season:'2026/27', kickoffAt:kickoff, acquiredAt:'2026-11-05T11:59:00.000Z', providerLastUpdated:null, publicationAt:null, mappingSha256:calendar.mappingSha256, maxAgeSeconds:3600 };
      return { matchId, homeTeamId:'h', awayTeamId:'a', competition:'Serie A', season:'2026/27', date:kickoff, status:'TIMED', evidence };
    });
    let unavailableCompetitions = ['Premier League'];
    const store = { async refresh() { return { fixtures, invalidKickoffCount:0, unavailableCompetitions }; }, async current(id) { const f = fixtures.find(x => x.matchId === id); return id === 'understat_2' ? { ...f.evidence, kickoffAt:'2026-11-06T18:00:00.000Z' } : f.evidence; } };
    let calls = 0;
    const predictor = { async predict(request, options) {
      calls++; assert.equal(request.bookmakerOdds, undefined); assert.equal(options.researchFixtureSnapshot.kickoffAt, kickoff);
      const payload = { origin:'prospective_a', competition:request.competition, season:request.season, collection:options.prospectiveCollection, researchCalendar:options.researchFixtureSnapshot };
      await client.execute({ sql:'INSERT INTO model_a_prospective_forecasts VALUES(?,?,?,?,?)', args:['f1',request.matchId,new Date(now).toISOString(),kickoff,JSON.stringify(payload)] });
      options.onProspectiveRecord({ status:'pending', id:'f1', completion:Promise.resolve({status:'stored',id:'f1'}) });
    } };
    const collector = new ModelAProspectiveCollection(client,predictor,scope,()=>new Date(now),undefined,undefined,undefined,store);
    const result = await collector.run(); assert.equal(result.claimed, 2); assert.equal(calls,1); assert.deepEqual(result.calendarAlert.unavailableCompetitions, ['Premier League']);
    const firstRun = (await client.execute('SELECT status,error_code FROM model_a_collection_runs')).rows[0];
    assert.equal(firstRun.status, 'partial'); assert.equal(firstRun.error_code, 'calendar_feed_unavailable');
    const rows = (await client.execute('SELECT match_id,state,reason FROM model_a_collection_ledger ORDER BY match_id')).rows;
    assert.equal(rows[0].state,'stored'); assert.equal(rows[1].reason,'fixture_changed_or_window_closed');
    assert.deepEqual((await client.execute('SELECT DISTINCT date FROM matches')).rows.map(r=>r.date),[old]);
    await collector.run(); assert.equal(calls,1);
    fixtures[0].date = '2026-11-07T18:00:00.000Z';
    fixtures[0].evidence.kickoffAt = fixtures[0].date;
    await collector.run();
    assert.equal((await client.execute("SELECT reason FROM model_a_collection_ledger WHERE match_id='understat_1'")).rows[0].reason, 'kickoff_changed');
    assert.equal(calls, 1);
    fixtures.length = 0; unavailableCompetitions = ['Serie A','Premier League','La Liga','Bundesliga','Ligue 1'];
    const failure = await collector.run();
    assert.equal(failure.claimed, 0); assert.equal(calls, 1); assert.equal(failure.calendarAlert.unavailableCompetitions.length, 5);
    assert.equal((await client.execute("SELECT reason FROM model_a_collection_ledger WHERE match_id='understat_1'")).rows[0].reason, 'kickoff_changed');
  } finally { client.close(); }
});
