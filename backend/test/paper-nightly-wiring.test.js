const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseService } = require('../dist/db/DatabaseService');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');
const { PAPER_RECOMMENDATION_POLICY, VIRTUAL_RECOMMENDATION_POLICY } = require('../dist/research/ResearchRecommendationPolicy');

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

test('paper claims inspect every fixture beyond the old 10000 validation cap without bypassing origin checks', async t => {
  const fixtures = Array.from({ length: 10001 }, (_, index) => ({ matchId: `fixture-${index}`, kickoffAt: '2026-11-07T18:00:00.000Z' }));
  const client = createClient({ url: 'file::memory:?cache=shared' });
  t.after(() => client.close());
  for (const name of ['015_research_platform.sql', '020_research_nightly.sql', '023_research_recommendation_execution.sql', '028_paper_model_bets.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
  }
  const store = new ResearchRecommendationStore(client, async () => {}, { now: () => new Date('2026-11-07T12:00:00.000Z') });
  const claim = policyHash => store.claimBatch({ fixtures, runId: 'large-paper-fixture', policyHash,
    windowStartAt: '2026-11-07T12:00:00.000Z', windowEndAt: '2026-11-08T12:00:00.000Z' });
  const paper = await store.registerPolicy(PAPER_RECOMMENDATION_POLICY);
  const result = await claim(paper.hash);
  assert.deepEqual(result.skipped.map(row => row.matchId), fixtures.map(row => row.matchId));
  assert.ok(result.skipped.every(row => row.reason === 'origin_input_missing'));
  assert.deepEqual(result.jobs, []);
  assert.equal((await client.execute('SELECT COUNT(*) AS n FROM research_execution_jobs')).rows[0].n, 0);
  const legacy = await store.registerPolicy(VIRTUAL_RECOMMENDATION_POLICY);
  await assert.rejects(claim(legacy.hash), /Invalid execution claim/);
});
