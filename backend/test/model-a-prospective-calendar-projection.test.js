const { test } = require('node:test');
const assert = require('node:assert/strict');
const { researchFixtureProjection } = require('../dist/services/PredictionService');

function fixture() {
  const now = Date.now(), kickoffAt = new Date(now + 2 * 3600000).toISOString();
  const request = { matchId:'understat_42', homeTeamId:'h', awayTeamId:'a', competition:'Serie A', season:'2026/27' };
  const match = { match_id:'understat_42', source:'understat', source_match_id:42, home_team_id:'h', away_team_id:'a', competition:'Serie A', season:'2026/27', date:new Date(now - 86400000).toISOString(), home_goals:null, away_goals:null };
  const snapshot = { source:'football-data.org', providerMatchId:77, matchId:request.matchId, kickoffAt, homeTeamId:'h', awayTeamId:'a', competition:'Serie A', season:'2026/27', acquiredAt:new Date(now - 60000).toISOString(), providerLastUpdated:null, publicationAt:null, mappingSha256:'a'.repeat(64), observationId:'a1b2c3d4-1234-4234-8234-123456789abc', attemptId:'c1b2c3d4-1234-4234-8234-123456789abc', maxAgeSeconds:3600 };
  const options = { prospectiveOrigin:'prospective_a', prospectiveCollection:{protocolId:'p', manifestSha256:'b'.repeat(64), claimId:'b1b2c3d4-1234-4234-8234-123456789abc'}, recordAudit:false, researchFixtureSnapshot:snapshot };
  return { now, request, match, snapshot, options, asOf:new Date(now).toISOString() };
}
test('projection isolates the frozen research date and preserves the original row', () => {
  const f = fixture(), before = {...f.match};
  const result = researchFixtureProjection(f.request, f.options, f.match, f.asOf, f.now);
  assert.notEqual(result, f.match); assert.deepEqual(f.match, before);
  assert.deepEqual(result, {...before, date:f.snapshot.kickoffAt});
  assert.equal(researchFixtureProjection(f.request, {}, f.match, f.asOf, f.now), f.match);
});
test('research projection rejects unrelated calls, identity conflicts and stale evidence', () => {
  const tests = [
    f => { f.options.prospectiveOrigin = 'direct_a'; },
    f => { delete f.options.prospectiveCollection; },
    f => { f.options.prospectiveCollection.claimId = 'invalid'; },
    f => { f.options.recordAudit = true; },
    f => { f.snapshot.homeTeamId = 'other'; },
    f => { f.match.season = '2025/26'; },
    f => { f.match.home_goals = 1; },
    f => { f.snapshot.acquiredAt = new Date(f.now - 7200000).toISOString(); },
    f => { f.snapshot.acquiredAt = new Date(f.now + 1000).toISOString(); },
    f => { f.snapshot.kickoffAt = new Date(f.now - 1000).toISOString(); },
    f => { f.snapshot.publicationAt = f.asOf; },
    f => { f.snapshot.mappingSha256 = 'bad'; },
  ];
  for (const change of tests) { const f = fixture(); change(f); assert.throws(() => researchFixtureProjection(f.request, f.options, f.match, f.asOf, f.now), /research_fixture_snapshot_invalid/); }
});
