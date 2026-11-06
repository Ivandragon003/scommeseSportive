const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
require('ts-node/register/transpile-only');
const { loadNightlyFixtureReadiness } = require('../src/research/NightlyFixtureReadiness');

test('adapter binds source fixture, persisted teams and fit, and fails closed on missing profile', async () => {
  const asOf = '2026-11-06T12:00:00Z';
  const row = { match_id: 'understat_1', competition: 'Ligue 1', season: '2026/2027', home_team_id: 'home', away_team_id: 'away',
    date: '2026-11-07T12:00:00Z', home_goals: null, away_goals: null };
  const mapping = { version: 'reviewed-source-mapping-v1', reference: 'review', reviewedAt: asOf, teams: { 'Ligue 1': { '1': 'home', '2': 'away' } } };
  const descriptor = { version: mapping.version, reference: mapping.reference, reviewedAt: mapping.reviewedAt,
    competition: 'FL1', season: 2026, teams: mapping.teams['Ligue 1'] };
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  const mappingSha256 = createHash('sha256').update(JSON.stringify(canonical(descriptor))).digest('hex');
  const feed = { source: 'football-data.org', status: 'blocked', mappingSha256, payloadSha256: 'b'.repeat(64),
    attemptedAt: asOf, acquiredAt: asOf, reason: null, fixtures: [ { providerMatchId: '10', localMatchId: row.match_id, action: 'NO_CHANGE', reason: null,
      providerStatus: 'TIMED', homeTeamId: 'home', awayTeamId: 'away', kickoffUtc: row.date } ] };
  const db = { getMatchById: async () => row, getMatches: async () => [], getTeamsByIds: async () => [
    { team_id: 'home', avg_home_xg: 1.5 }, { team_id: 'away', avg_away_xg: 1.1 } ],
  getLatestModelParams: async () => ({ fitted_at: '2026-11-05T12:00:00Z', training_matches: 20,
    params: { attackParams: { home: 0, away: 0 }, defenceParams: { home: 0, away: 0 }, homeAdvantage: 0.2, rho: -0.1, tau: 0.01,
      poissonXg: { leagueXG: 1.3, homeAdv: 1.1, levelScale: 1, attackRate: { home: 1, away: 1 }, defRate: { home: 1, away: 1 } } } }),
  getHistoricalOddsDetailMap: async () => ({}), getCalibrationProfileCache: async () => null, research: {} };
  const manifest = { competitions: [{ competition: 'FL1', local: 'Ligue 1', feed }] };
  const state = { available: true, status: 'available', latestAttempt: { status: 'success', requestedAt: asOf, payloadSha256: feed.payloadSha256 },
    snapshot: { acquiredAt: asOf, payloadSha256: feed.payloadSha256, fixtures: [{ providerMatchId: '10', status: 'TIMED', kickoffUtc: row.date,
      providerHomeTeamId: '1', providerAwayTeamId: '2' }] } };
  const sourceStore = { read: async () => state };
  const options = { sourceStore, mapping };
  const result = await loadNightlyFixtureReadiness(db, manifest, row.match_id, asOf, null, options);
  assert.equal(result.admission.common.eligible, true);
  assert.equal(result.admission.families.A.eligible, false);
  assert.equal(result.admission.families.C.eligible, false);
  assert.equal(result.admission.markets.goal.quote.eligible, false);
  feed.fixtures[0].action = 'BLOCK'; feed.fixtures[0].reason = 'local_fixture_ambiguous';
  const blocked = await loadNightlyFixtureReadiness(db, manifest, row.match_id, asOf, null, options);
  assert.equal(blocked.admission.common.eligible, false);
  assert.ok(blocked.admission.common.reasons.includes('local_fixture_ambiguous'));
  feed.fixtures[0].action = 'NO_CHANGE'; feed.fixtures[0].reason = null;
  mapping.teams['Ligue 1']['1'] = 'other';
  const wrongMapping = await loadNightlyFixtureReadiness(db, manifest, row.match_id, asOf, null, options);
  assert.equal(wrongMapping.admission.common.eligible, false);
  mapping.teams['Ligue 1']['1'] = 'home';
  state.available = false; state.status = 'failure'; state.reason = 'calendar_network_error'; state.latestAttempt.status = 'failure';
  const failed = await loadNightlyFixtureReadiness(db, manifest, row.match_id, asOf, null, options);
  assert.equal(failed.admission.common.eligible, false);
  assert.ok(failed.admission.common.reasons.includes('calendar_network_error'));
});
