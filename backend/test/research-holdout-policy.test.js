const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const compiled = process.env.RESEARCH_TEST_DIST || '../dist';
const { assessResearchHoldout, ORIGINAL_HOLDOUT_POLICY } = require(resolve(__dirname, compiled, 'research/ResearchHoldoutPolicy'));

test('the original 745 consulted match identities remain protected even if their dates are forged into the future', () => {
  assert.equal(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds.length, 745);
  const report = assessResearchHoldout([{ matchId: ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds[0], forecastAt: '2030-01-01T00:00:00Z' }]);
  assert.equal(report.passed, false);
  assert.ok(report.reasons.includes('protected_original_final_reused'));
});

test('newly named matches before the frozen boundary are not new independent evaluation', () => {
  const report = assessResearchHoldout([{ matchId: 'renamed-consulted-match', forecastAt: '2026-10-26T20:00:00Z' }]);
  assert.equal(report.passed, false);
  assert.ok(report.reasons.includes('new_independent_future_holdout_required'));
  assert.equal(assessResearchHoldout([]).passed, false);
});

test('later unseen observations pass only the boundary check, which is not model promotion', () => {
  const result = assessResearchHoldout([{ matchId: 'future-unseen-fixture', forecastAt: '2026-11-01T19:30:00Z' }]);
  assert.equal(result.passed, true);
  assert.equal(result.observations, 1);
  assert.equal(result.modelApproved, undefined);
  assert.throws(() => assessResearchHoldout([], { version: 'bad', newIndependentForecastsAfter: 'invalid', protectedOriginalFinalMatchIds: [] }), /Invalid/);
});
