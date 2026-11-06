const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseService } = require('../dist/db/DatabaseService');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');
const { PAPER_RECOMMENDATION_POLICY, VIRTUAL_RECOMMENDATION_POLICY } = require('../dist/research/ResearchRecommendationPolicy');
const { researchHash } = require('../dist/research/ResearchStore');

test('paper fixture intake has no implicit 380/1000 cap while existing UI pagination is preserved', async () => {
  const rows = Array.from({ length: 1205 }, (_, index) => ({ match_id: `fixture-${index}`,
    date: '2026-11-07T18:00:00.000Z', home_goals: null, away_goals: null }));
  const queries = [], receiver = { all: async (sql, args) => { queries.push({ sql, args }); return rows; } };
  const filters = { nowIso: '2026-11-07T12:00:00.000Z', untilIso: '2026-11-08T12:00:00.000Z' };
  assert.equal((await DatabaseService.prototype.getUpcomingMatches.call(receiver, { ...filters, unbounded: true })).length, 1205);
  assert.doesNotMatch(queries[0].sql, /\bLIMIT\b/);
  assert.equal((await DatabaseService.prototype.getUpcomingMatches.call(receiver, { ...filters, limit: 50 })).length, 50);
  assert.match(queries[1].sql, /LIMIT \?/);
});

test('paper claims inspect every fixture beyond the old 10000 validation cap without bypassing origin checks', async () => {
  const fixtures = Array.from({ length: 10001 }, (_, index) => ({ matchId: `fixture-${index}`, kickoffAt: '2026-11-07T18:00:00.000Z' }));
  let descriptor = PAPER_RECOMMENDATION_POLICY, originChecks = 0;
  const tx = { execute: async (statement) => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    assert.match(sql, /^SELECT\b/); // No schema, provider or application writes in this guard test.
    if (sql.includes('FROM research_execution_policies')) return { rows: [{ descriptor_json: JSON.stringify(descriptor) }] };
    if (sql.includes('FROM research_inputs')) originChecks++;
    return { rows: [] };
  } };
  const research = { runResearchTransaction: async (work) => work(tx) };
  const store = new ResearchRecommendationStore({}, async () => {}, { research, now: () => new Date('2026-11-07T12:00:00.000Z') });
  store.ensureGuards = async () => {};
  const claim = () => store.claimBatch({ fixtures, runId: 'large-paper-fixture', policyHash: researchHash(descriptor),
    windowStartAt: '2026-11-07T12:00:00.000Z', windowEndAt: '2026-11-08T12:00:00.000Z' });
  const result = await claim();
  assert.equal(originChecks, 10001); assert.equal(result.skipped.length, 10001);
  assert.ok(result.skipped.every(row => row.reason === 'origin_input_missing'));
  descriptor = VIRTUAL_RECOMMENDATION_POLICY;
  await assert.rejects(claim(), /Invalid execution claim/);
});
