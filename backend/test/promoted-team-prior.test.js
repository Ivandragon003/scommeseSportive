const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyPromotedTeamPriors,
  buildPromotedTeamPrior,
  destinationCompetitionIdFor,
  effectiveCoverageWithPromotedPrior,
} = require('../dist/services/PromotedTeamPriorService.js');

const completePromotion = (overrides = {}) => ({
  transition_type: 'promoted',
  coverage_status: 'complete',
  source_quality: 'estimated',
  transition_mode: 'direct_1',
  source_season: '2025/2026',
  source_competition_id: 'serie_b',
  lower_matches: 38,
  goals_for_per_match: 1.8,
  goals_against_per_match: 0.9,
  league_goals_for_per_match: 1.2,
  completed_top_flight_matches: 0,
  ...overrides,
});

test('uses only a complete, deterministic direct promotion and maps target leagues', () => {
  const prior = buildPromotedTeamPrior(completePromotion());
  assert.ok(prior);
  assert.equal(prior.sourceCompetitionId, 'serie_b');
  assert.equal(prior.lowerDivisionMatches, 38);
  assert.equal(prior.weight, 0.3);
  assert.equal(prior.attackIndex, 1.45);
  assert.equal(prior.concessionIndex, 0.75);
  assert.equal(destinationCompetitionIdFor('Serie A'), 'serie_a');
  assert.equal(destinationCompetitionIdFor('Champions League'), null);
});

test('fails closed for partial, playoff, or too-small lower-division histories', () => {
  assert.equal(buildPromotedTeamPrior(completePromotion({ coverage_status: 'partial' })), null);
  assert.equal(buildPromotedTeamPrior(completePromotion({ transition_mode: 'playoff' })), null);
  assert.equal(buildPromotedTeamPrior(completePromotion({ lower_matches: 19 })), null);
  assert.equal(buildPromotedTeamPrior(completePromotion({ transition_type: 'relegated' })), null);
});

test('applies a bounded goal-rate nudge and fades out after actual top-flight matches', () => {
  const prior = buildPromotedTeamPrior(completePromotion());
  const applied = applyPromotedTeamPriors({
    homeXG: 1.4,
    awayXG: 1.1,
    homePrior: prior,
    awayPrior: null,
  });
  assert.equal(applied.homeXG, 1.589);
  assert.equal(applied.awayXG, 1.0175);

  const faded = buildPromotedTeamPrior(completePromotion({ completed_top_flight_matches: 8 }));
  assert.equal(faded, null);
});

test('promotion evidence can reduce a missing-history penalty but never marks history complete', () => {
  const prior = buildPromotedTeamPrior(completePromotion());
  assert.equal(effectiveCoverageWithPromotedPrior(0, prior), 40);
  assert.equal(effectiveCoverageWithPromotedPrior(80, prior), 60);
  assert.equal(effectiveCoverageWithPromotedPrior(80, null), 80);
});
