const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { CURRENT_CHALLENGER_RELEASE } = require('../dist/research/CurrentChallengerRelease');
const { loadNightlyFixtureReadiness } = require('../dist/research/NightlyFixtureReadiness');

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
  const db = { getMatchById: async () => row, getMatches: async (filters) => {
    // The remote transport rejects the full provider payload; normalized columns remain available.
    assert.notEqual(filters?.includeRawJson, true, 'readiness must not download provider payloads');
    return [];
  }, getTeamsByIds: async () => [
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

async function reviewedIdentityReadiness(options = {}) {
  const asOf = options.asOf ?? '2026-11-06T12:00:00Z', kickoff = new Date(Date.parse(asOf) + 86400000).toISOString();
  const competition = options.competition ?? 'FL1', localCompetition = competition === 'FL1' ? 'Ligue 1' : 'Premier League';
  const season = options.season ?? 2026, localId = options.localId ?? 'understat_team_172';
  const providerId = options.providerId ?? '531';
  const row = { match_id: 'understat_1', competition: localCompetition, season: `${season}/${season + 1}`,
    home_team_id: localId, away_team_id: 'away', home_team_name: options.matchName ?? 'Troyes', away_team_name: 'Away',
    date: kickoff, home_goals: null, away_goals: null };
  const mapping = { version: 'reviewed-source-mapping-v1', reference: 'old coherent mapping', reviewedAt: asOf,
    teams: { [localCompetition]: { [providerId]: localId, '2': 'away' } } };
  const descriptor = { version: mapping.version, reference: mapping.reference, reviewedAt: mapping.reviewedAt,
    competition, season, teams: mapping.teams[localCompetition] };
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  const mappingSha256 = createHash('sha256').update(JSON.stringify(canonical(descriptor))).digest('hex');
  const feed = { source: 'football-data.org', status: 'ready', mappingSha256, payloadSha256: 'b'.repeat(64),
    attemptedAt: asOf, acquiredAt: asOf, reason: null, fixtures: [{ providerMatchId: '10', localMatchId: row.match_id,
      action: 'NO_CHANGE', reason: null, providerStatus: 'TIMED', homeTeamId: localId, awayTeamId: 'away', kickoffUtc: kickoff }] };
  const state = { available: true, status: 'available', latestAttempt: { status: 'success', requestedAt: asOf, payloadSha256: feed.payloadSha256 },
    snapshot: { acquiredAt: asOf, payloadSha256: feed.payloadSha256, fixtures: [{ providerMatchId: '10', status: 'TIMED', kickoffUtc: kickoff,
      providerHomeTeamId: providerId, providerAwayTeamId: '2', homeTeamName: options.providerName ?? 'ES Troyes AC', awayTeamName: 'Away' }] } };
  const db = { getMatchById: async () => row, getMatches: async () => options.history ?? [], getTeamsByIds: async () => [
    { team_id: localId, name: options.teamName ?? 'Troyes', avg_home_xg: 1.5 }, { team_id: 'away', name: 'Away', avg_away_xg: 1.1 } ],
    getLatestModelParams: async () => null, getHistoricalOddsDetailMap: async () => ({}), getCalibrationProfileCache: async () => null, research: options.research ?? {} };
  const result = await loadNightlyFixtureReadiness(db, { competitions: [{ competition, local: localCompetition, feed }] }, row.match_id,
    asOf, options.deployment ?? null, { mapping, sourceStore: { read: async () => state } });
  assert.equal(result.evidence.calendar.action, 'NO_CHANGE');
  assert.ok(!result.admission.common.reasons.includes('calendar_mapping_mismatch'), 'the mapping hash and ID links are coherent');
  assert.ok(!result.admission.common.reasons.includes('calendar_current_source_mismatch'), 'the source is current');
  return result;
}

for (const options of [
  { providerId: '533', providerName: 'Le Havre AC' },
  { providerId: '533', providerName: 'Le Havre AC', matchName: 'Le Havre', teamName: 'Le Havre' },
  { matchName: 'Le Havre' }, { teamName: 'Le Havre' }, { providerName: 'Le Havre AC' },
]) test(`fresh NO_CHANGE cannot attest a mismatched reviewed identity: ${JSON.stringify(options)}`, async () => {
  const result = await reviewedIdentityReadiness(options);
  assert.equal(result.admission.common.eligible, false);
  assert.ok(result.admission.common.reasons.includes('source_import_team_identity_mismatch'));
});

for (const options of [
  {}, { providerName: 'Estac Troyes', matchName: 'Estac Troyes', teamName: 'Troyes' },
  { localId: 'le_havre', providerId: '533', providerName: 'Le Havre AC', matchName: 'Le Havre', teamName: 'Havre AC' },
  { localId: 'understat_team_295', providerId: '535', providerName: 'Le Mans FC', matchName: 'Le Mans', teamName: 'Le Mans' },
  { localId: 'unreviewed', providerId: '531', providerName: 'Unknown alias', matchName: 'Other alias', teamName: 'Another alias' },
  { competition: 'PL', providerId: '533', providerName: 'Le Havre AC' },
  { season: 2025, providerId: '533', providerName: 'Le Havre AC' },
]) test(`fresh NO_CHANGE respects the resolved identities and bounded scope: ${JSON.stringify(options)}`, async () => {
  assert.equal((await reviewedIdentityReadiness(options)).admission.common.eligible, true);
});

test('fixture admission accepts the deployed joint-head configuration and rejects a different hash', async () => {
  const artifact = require('../current-models/challenger.json');
  const asOf = new Date(Date.parse(artifact.createdAt) + 86400000).toISOString();
  const deployment = { source: 'adopted', revision: 'test', deployment: { ...CURRENT_CHALLENGER_RELEASE } };
  const history = Array.from({ length: 64 }, (_, index) => ({
    match_id: 'history-' + index, competition: 'Ligue 1', season: '2026/2027', source: 'understat',
    home_team_id: 'understat_team_172', away_team_id: 'away', home_team_name: 'Troyes', away_team_name: 'Away',
    date: new Date(Date.parse(asOf) - (index + 2) * 86400000).toISOString(),
    home_goals: [2, 1, 0, 3][index % 4], away_goals: [0, 1, 2, 1][index % 4],
    home_xg: 1.7, away_xg: 1.1, home_shots: 14, away_shots: 10,
  }));
  const research = { getModelByVersion: async () => ({ version: artifact.version, artifact, createdAt: artifact.createdAt }) };
  const evaluate = () => reviewedIdentityReadiness({ asOf, deployment, history, research });
  const ready = await evaluate();
  assert.equal(ready.evidence.cReason, null);
  assert.equal(ready.admission.families.C.eligible, true, JSON.stringify(ready.admission.families.C.reasons));
  deployment.deployment.probabilityConfigurationHash = 'a'.repeat(64);
  const blocked = await evaluate();
  assert.equal(blocked.evidence.cReason, 'c_calibration_configuration_mismatch');
  assert.equal(blocked.admission.families.C.eligible, false);
});
