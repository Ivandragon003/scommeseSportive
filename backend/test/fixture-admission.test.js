const test = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');
const { evaluateFixtureAdmission } = require('../src/research/FixtureAdmission');
const { predictionConfig } = require('../src/config/predictionConfig');

const at = '2026-11-06T12:00:00Z';
const ok = () => ({ verified: true, checkedAt: at });
function fixture() {
  const sample = Math.max(predictionConfig.markets.minSampleSizePerTeam, Math.ceil(predictionConfig.markets.minCombinedSampleSize / 2));
  const samples = Object.fromEntries(['general', 'shots', 'shots_on_target', 'yellow_cards', 'red_cards'].map(k => [k, { home: sample, away: sample }]));
  const markets = ['goal', 'shots', 'shots_on_target', 'yellow_cards', 'booking_points', 'player_props'];
  return { asOf: at, fixture: { matchId: 'understat_1', competition: 'Ligue 1', season: 2026, homeTeamId: 'home', awayTeamId: 'away',
    kickoffAt: '2026-11-07T12:00:00Z', status: 'TIMED', homeGoals: null, awayGoals: null },
  calendar: { ...ok(), source: 'football-data.org', acquiredAt: at, matchId: 'understat_1', homeTeamId: 'home', awayTeamId: 'away',
    kickoffAt: '2026-11-07T12:00:00Z', mappingHash: 'a'.repeat(64) }, identity: ok(),
  modelA: { inputs: ok(), fittedState: ok(), calibration: ok() }, modelC: { inputs: ok(), fittedBaseline: ok(), artifact: ok(),
    calibration: ok(), cleanBaseline: ok() }, samples, playerProps: ok(),
  marketCalibration: Object.fromEntries(markets.map(k => [k, ok()])), quotes: Object.fromEntries(markets.map(k => [k, ok()]) ) };
}

test('independent model and market evidence and quotes are not conflated', () => {
  const input = fixture(); delete input.quotes.goal; delete input.modelA.calibration;
  const r = evaluateFixtureAdmission(input);
  assert.equal(r.families.A.eligible, false); assert.equal(r.families.C.eligible, true);
  assert.equal(r.markets.goal.C.eligible, true); assert.equal(r.markets.goal.quote.eligible, false);
  assert.equal(r.markets.shots.C.eligible, false);
});
test('a scheduled rough date is retained in the calendar but cannot authorize a timed prediction', () => {
  const input = fixture(); input.fixture.status = 'SCHEDULED';
  const r = evaluateFixtureAdmission(input);
  assert.ok(r.common.reasons.includes('kickoff_not_confirmed'));
  assert.equal(r.families.A.eligible, false); assert.equal(r.families.C.eligible, false);
});
test('statistics gates use actual fields and configured minimums', () => {
  const input = fixture(); input.samples.shots.home = predictionConfig.markets.minSampleSizePerTeam - 1;
  const r = evaluateFixtureAdmission(input);
  assert.equal(r.markets.goal.A.eligible, true); assert.equal(r.markets.shots.A.eligible, false);
  assert.equal(r.markets.shots_on_target.A.eligible, false); assert.equal(r.markets.booking_points.A.eligible, true);
  delete input.marketCalibration.goal;
  assert.equal(evaluateFixtureAdmission(input).markets.goal.A.eligible, false);
});
test('stale or mismatched fixture evidence and postponed fixture fail closed', () => {
  const input = fixture(); input.calendar.acquiredAt = '2026-11-06T11:44:59Z';
  assert.ok(evaluateFixtureAdmission(input).common.reasons.includes('calendar_stale_or_unavailable'));
  input.calendar.acquiredAt = at; input.calendar.homeTeamId = 'other'; input.fixture.status = 'POSTPONED';
  const reasons = evaluateFixtureAdmission(input).common.reasons;
  assert.ok(reasons.includes('calendar_fixture_mismatch')); assert.ok(reasons.includes('fixture_status_not_upcoming'));
});
test('resolved Troyes still requires actual identity attestation and a confirmed date', () => {
  const input = fixture(); input.fixture.homeTeamId = input.calendar.homeTeamId = 'understat_team_172';
  assert.equal(evaluateFixtureAdmission(input).common.eligible, true);
  input.identity.verified = false;
  assert.ok(evaluateFixtureAdmission(input).common.reasons.includes('fixture_identity_unverified'));
  input.identity = ok(); input.fixture.status = 'SCHEDULED';
  assert.ok(evaluateFixtureAdmission(input).common.reasons.includes('kickoff_not_confirmed'));
});
test('resolved source identity cannot remove the independent frozen C target quarantine', () => {
  const input = fixture();
  input.fixture.homeTeamId = input.calendar.homeTeamId = 'understat_team_172';
  input.fixture.matchId = input.calendar.matchId = 'understat_32010';
  const result = evaluateFixtureAdmission(input);
  assert.equal(result.common.eligible, true); assert.equal(result.families.A.eligible, true);
  assert.equal(result.families.C.eligible, false);
  assert.ok(result.families.C.reasons.includes('challenger_target_data_quality_quarantined'));
});
test('future checks cannot attest evidence at forecast time', () => {
  const input = fixture(); input.modelC.artifact.checkedAt = '2026-11-06T12:01:00Z';
  assert.ok(evaluateFixtureAdmission(input).families.C.reasons.includes('c_artifact_unverified'));
});

test('C team parity requires A evidence and each statistical sample without enabling player props', () => {
  const input = fixture(); input.modelC.teamMarketParity = true;
  let result = evaluateFixtureAdmission(input);
  assert.equal(result.markets.shots.C.eligible, true);
  assert.equal(result.markets.player_props.C.eligible, false);
  input.samples.red_cards.home = 0;
  result = evaluateFixtureAdmission(input);
  assert.equal(result.markets.booking_points.C.eligible, false);
  assert.equal(result.markets.shots.C.eligible, true);
  input.modelA.fittedState.verified = false;
  assert.equal(evaluateFixtureAdmission(input).markets.shots.C.eligible, false);
  assert.equal(evaluateFixtureAdmission(input).markets.goal.C.eligible, true);
});
