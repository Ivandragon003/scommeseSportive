const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPromotedTeamPrior,
  destinationCompetitionIdFor,
  effectiveCoverageWithPromotedPrior,
  sourceCompetitionIdFor,
} = require('../dist/services/PromotedTeamPriorService.js');

const lowerSeason = (sourceSeason, overrides = {}) => ({
  source_season: sourceSeason,
  source_competition_id: 'serie_b',
  coverage_status: 'complete',
  transition_mode: null,
  lower_matches: 38,
  completed_top_flight_matches: 0,
  goals_for_per_match: 1.6,
  goals_against_per_match: 1.0,
  shots_for_per_match: 12.5,
  shots_against_per_match: 10.2,
  shots_on_target_for_per_match: 4.2,
  shots_on_target_against_per_match: 3.4,
  fouls_for_per_match: 13.1,
  fouls_against_per_match: 12.4,
  corners_for_per_match: 5.2,
  corners_against_per_match: 4.7,
  yellow_cards_for_per_match: 2.1,
  yellow_cards_against_per_match: 2.3,
  ...overrides,
});

test('maps each top division to its factual lower-division source', () => {
  assert.equal(destinationCompetitionIdFor('Serie A'), 'serie_a');
  assert.equal(sourceCompetitionIdFor('Serie A'), 'serie_b');
  assert.equal(sourceCompetitionIdFor('Premier League'), 'championship');
  assert.equal(sourceCompetitionIdFor('Champions League'), null);
});

test('accepts a factual previous lower season even without a direct-promotion row', () => {
  const inferred = buildPromotedTeamPrior([lowerSeason('2025/2026')], '2026/2027');
  const direct = buildPromotedTeamPrior([lowerSeason('2025/2026', { transition_mode: 'direct_2' })], '2026/2027');
  assert.equal(inferred.transitionEvidence, 'previous_lower_tier');
  assert.equal(direct.transitionEvidence, 'direct');
  assert.deepEqual(inferred.sourceSeasons, ['2025/2026']);
  assert.equal(inferred.teamProfile.shotsForPerMatch, 12.5);
  assert.equal(inferred.teamProfile.foulsForPerMatch, 13.1);
});

test('uses contiguous team history only and weights the newest season more heavily', () => {
  const profile = buildPromotedTeamPrior([
    lowerSeason('2025/2026', { goals_for_per_match: 1.8 }),
    lowerSeason('2024/2025', { goals_for_per_match: 1.2 }),
    lowerSeason('2022/2023', { goals_for_per_match: 4.0 }),
  ], '2026/2027');

  assert.deepEqual(profile.sourceSeasons, ['2025/2026', '2024/2025']);
  assert.equal(profile.lowerDivisionMatches, 76);
  assert.equal(profile.teamProfile.goalsForPerMatch, 1.6);
});

test('fails closed for partial and too-small immediate lower-division histories', () => {
  assert.equal(buildPromotedTeamPrior([lowerSeason('2025/2026', { coverage_status: 'partial' })], '2026/2027'), null);
  assert.equal(buildPromotedTeamPrior([lowerSeason('2025/2026', { lower_matches: 19 })], '2026/2027'), null);
  assert.equal(buildPromotedTeamPrior([lowerSeason('2024/2025')], '2026/2027'), null);
});

test('promotion evidence can reduce a missing-history penalty but never marks history complete', () => {
  const prior = buildPromotedTeamPrior([lowerSeason('2025/2026')], '2026/2027');
  assert.equal(effectiveCoverageWithPromotedPrior(0, prior), 40);
  assert.equal(effectiveCoverageWithPromotedPrior(80, prior), 60);
  assert.equal(effectiveCoverageWithPromotedPrior(80, null), 80);
});
