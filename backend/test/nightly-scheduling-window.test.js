const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { nextNightlyBoundary } = require('../dist/research/ResearchNightly');
const { ResearchStore } = require('../dist/research/ResearchStore');
const { guardNightly, romeTime, NIGHTLY_CRONS } = require('../scripts/nightly-schedule-guard');

test('03:07 boundary is strictly future and follows Rome summer, winter and both DST transitions', () => {
  for (const [day, expected, hours] of [
    ['2026-02-10', '2026-02-11T02:07:00.000Z', 24],
    ['2026-07-10', '2026-07-11T01:07:00.000Z', 24],
    ['2026-03-28', '2026-03-29T01:07:00.000Z', 23],
    ['2026-10-24', '2026-10-25T02:07:00.000Z', 25],
  ]) {
    const at = romeTime(day, 3, 7);
    assert.equal(nextNightlyBoundary(new Date(at.getTime() - 1), 3, 7).toISOString(), at.toISOString());
    assert.equal(nextNightlyBoundary(at, 3, 7).toISOString(), expected);
    assert.equal((Date.parse(expected) - at.getTime()) / 3600000, hours);
  }
});

test('a pre-primary snapshot has a short remaining window while all delayed same-day opportunities end tomorrow', () => {
  assert.equal(nextNightlyBoundary(new Date('2026-11-06T00:25:28.394Z'), 3, 7).toISOString(), '2026-11-06T02:07:00.000Z');
  for (const hour of [3, 4, 5, 22]) {
    assert.equal(nextNightlyBoundary(romeTime('2026-11-06', hour, 27), 3, 7).toISOString(), '2026-11-07T02:07:00.000Z');
  }
});

test('manual admission stops before 03:07 and opens exactly at the boundary in summer, winter and DST days', async () => {
  for (const day of ['2026-02-10', '2026-07-10', '2026-03-29', '2026-10-25']) {
    const boundary = romeTime(day, 3, 7);
    for (const delta of [-1, 0, 1]) {
      const now = new Date(boundary.getTime() + delta), calls = [];
      const current = { id: 500, event: 'workflow_dispatch', head_branch: 'main',
        path: '.github/workflows/nightly-sync.yml', created_at: new Date(boundary.getTime() - 60000).toISOString(),
        display_title: 'Nightly Sync (manual)', status: 'in_progress', conclusion: null };
      const result = await guardNightly({ now, token: 'fixture-token', repository: 'fixture/repo',
        runId: 500, eventName: 'workflow_dispatch', fetchImpl: async (url, request) => {
          calls.push(url); assert.equal(request.method, 'GET');
          const payload = url.includes('/jobs') ? { total_count: 0, jobs: [] }
            : url.includes('/workflows/') ? { total_count: 1, workflow_runs: [current] } : current;
          return new Response(JSON.stringify(payload));
        } });
      assert.equal(result.run, delta >= 0);
      assert.equal(result.reason, delta < 0 ? 'before_primary_schedule' : 'daily_sync_admitted');
      if (delta < 0) assert.equal(calls.length, 1);
    }
    for (const [index, hour, minute] of [[0, 3, 7], [1, 4, 17], [2, 5, 27]]) {
      assert.equal(NIGHTLY_CRONS[index], `${minute} ${hour} * * *`);
      assert.equal(romeTime(day, hour, minute).getTime() > boundary.getTime(), index > 0);
    }
  }
});

test('persistent allocation includes exact cutoff, excludes a later millisecond and refuses a closed retry window', async (t) => {
  const path = join(tmpdir(), `nightly-scheduling-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  t.after(() => {
    client.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(path + suffix, { force: true }); }
      catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
    }
  });
  for (const name of ['015_research_platform.sql', '020_research_nightly.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
  }
  let now = new Date('2026-11-06T02:08:00.000Z');
  const store = new ResearchStore(client, async () => {}, { now: () => now });
  const startedAt = now.toISOString(), windowEndAt = nextNightlyBoundary(now, 3, 7).toISOString();
  const fixtures = [
    { matchId: 'started', kickoffAt: startedAt },
    { matchId: 'cutoff', kickoffAt: windowEndAt },
    { matchId: 'later', kickoffAt: new Date(Date.parse(windowEndAt) + 1).toISOString() },
  ];
  const batch = await store.claimNightlyBatch({ runId: 'scheduling-boundary-fixture', startedAt, windowEndAt, fixtures });
  assert.deepEqual(batch.jobs.map(job => job.matchId), ['cutoff']);
  assert.deepEqual(batch.skipped.map(({ matchId, reason }) => [matchId, reason]),
    [['started', 'match_started'], ['later', 'outside_nightly_window']]);
  await store.finishNightlyRun(batch.run.id, batch.run.leaseToken, { status: 'ERROR', summary: { errors: 1 } });
  now = new Date(windowEndAt);
  await assert.rejects(store.claimNightlyBatch({ runId: batch.run.id, startedAt, windowEndAt, fixtures }), /window closed/);
  assert.equal((await store.getNightlyRun(batch.run.id)).windowEndAt, windowEndAt);
});
