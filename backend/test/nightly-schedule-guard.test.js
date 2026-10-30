const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { guardNightly, romeTime, primarySchedule, NIGHTLY_CRONS, romeDay } = require('../scripts/nightly-schedule-guard');

const NOW = new Date('2026-10-30T06:00:00Z');
const current = (extra = {}) => ({ id: 500, event: 'schedule', head_branch: 'main', path: '.github/workflows/nightly-sync.yml',
  created_at: '2026-10-30T02:07:00Z', display_title: 'Nightly Sync (7 3 * * *)', status: 'in_progress', conclusion: null, ...extra });
const enabledSteps = () => [step(), step({ name: 'Confirm enabled A/C completion' })];
const step = (extra = {}) => ({ name: 'Run nightly sync', status: 'completed', conclusion: 'success',
  started_at: '2026-10-30T02:10:00Z', completed_at: '2026-10-30T02:50:00Z', ...extra });

function fixture({ run = current(), other = [], jobs = {}, activeRuns, ...options } = {}) {
  const calls = [];
  const inspect = () => guardNightly({ now: NOW, token: 'fixture-token', repository: 'fixture/repo', runId: run.id,
    eventName: run.event, scheduleCron: run.display_title?.match(/\((.*)\)/)?.[1],
    fetchImpl: async (url, request) => {
      calls.push(url); assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
      assert.equal(request.headers.Authorization, 'Bearer fixture-token'); assert.equal(url.includes('fixture-token'), false);
      const id = /\/runs\/(\d+)\/jobs/.exec(url)?.[1];
      if (id) { const rows = jobs[id] ?? []; return new Response(JSON.stringify({ total_count: rows.length, jobs: rows })); }
      if (url.includes('/workflows/')) {
        const runs = url.includes('status=in_progress') ? activeRuns ?? [run, ...other].filter((item) => item.status === 'in_progress') : [run, ...other];
        return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
      }
      return new Response(JSON.stringify(run));
    }, ...options });
  return { inspect, calls };
}

test('three timezone-aware opportunities share the same Rome date across both DST changes', async () => {
  for (const [day, utc] of [['2026-03-29', 1], ['2026-10-25', 2]]) {
    assert.equal(romeTime(day, 3, 7).toISOString(), `${day}T0${utc}:07:00.000Z`);
    for (const cron of NIGHTLY_CRONS) {
      const run = current({ display_title: `Nightly Sync (${cron})`, created_at: `${day}T0${utc}:07:00Z` });
      const result = await fixture({ run, now: new Date(`${day}T07:00:00Z`) }).inspect();
      assert.equal(result.run, true); assert.equal(result.day, day);
    }
  }
  assert.equal(primarySchedule(new Date('2026-10-25T00:30:00Z')).expectedAt, '2026-10-24T01:07:00.000Z');
});

test('a full sync success prevents backup writes, while a successful guard or inactive legacy trigger does not', async () => {
  const done = current({ id: 400, status: 'completed', conclusion: 'success' });
  const actual = await fixture({ other: [done], jobs: { 400: [{ steps: enabledSteps() }] } }).inspect();
  assert.equal(actual.run, false); assert.equal(actual.reason, 'daily_sync_already_succeeded');
  assert.equal(actual.existingRunId, '400');
  assert.equal((await fixture({ other: [done], jobs: { 400: [{ steps: [step()] }] } }).inspect()).run, true);
  for (const conclusion of ['skipped', 'failure']) {
    assert.equal((await fixture({ other: [done], jobs: { 400: [{ steps: [step(),
      step({ name: 'Confirm enabled A/C completion', conclusion })] }] } }).inspect()).run, true);
  }
  const skipped = [{ steps: [step({ name: 'Check daily execution before installation or database access' }), step({ conclusion: 'skipped' })] }];
  assert.equal((await fixture({ other: [done], jobs: { 400: skipped } }).inspect()).run, true);
  const inactive = { ...done, display_title: 'Nightly Sync (0 1 * * *)' };
  assert.equal((await fixture({ other: [inactive], jobs: { 400: [{ steps: enabledSteps() }] } }).inspect()).run, true);
  // Upload failures cannot justify repeating a successfully completed sync step.
  assert.equal((await fixture({ other: [{ ...done, conclusion: 'failure' }], jobs: { 400: [{ steps: enabledSteps() }] } }).inspect()).run, false);
});

test('manual recovery follows a real failure, but rerunning an already successful attempt cannot repeat it', async () => {
  const failed = current({ id: 400, status: 'completed', conclusion: 'failure' });
  const run = current({ event: 'workflow_dispatch', display_title: 'Nightly Sync (manual)' });
  assert.equal((await fixture({ run, other: [failed], jobs: { 400: [{ steps: [step({ conclusion: 'failure' })] }] } }).inspect()).run, true);
  const rerun = await fixture({ run, jobs: { 500: [{ steps: enabledSteps() }] } }).inspect();
  assert.equal(rerun.run, false); assert.equal(rerun.reason, 'daily_sync_already_succeeded');
});

test('a real in-progress execution stops admission; another queued run or stale zero-job orphan does not lock the day', async () => {
  const active = current({ id: 400 });
  const stopped = await fixture({ other: [active], jobs: { 400: [{ status: 'in_progress', steps: [] }] } }).inspect();
  assert.equal(stopped.reason, 'daily_sync_in_progress');
  assert.equal((await fixture({ other: [{ ...active, status: 'queued' }] }).inspect()).run, true);
  const orphan = { ...active, status: 'queued', created_at: '2026-10-29T18:00:00Z', event: 'workflow_dispatch' };
  const old = fixture({ other: [orphan] }); assert.equal((await old.inspect()).run, true);
  assert.equal(old.calls.some((url) => url.includes('/runs/400/jobs')), false);
});

test('stale creation dates and pre-primary manual calls cannot consume a later daily run', async () => {
  const old = fixture({ run: current({ created_at: '2026-10-29T18:00:00Z' }) });
  assert.equal((await old.inspect()).reason, 'stale_created_day'); assert.equal(old.calls.length, 1);
  const early = fixture({ run: current({ created_at: '2026-10-30T00:00:00Z', event: 'workflow_dispatch' }), now: new Date('2026-10-30T00:30:00Z') });
  assert.equal((await early.inspect()).reason, 'before_primary_schedule'); assert.equal(early.calls.length, 1);
  await assert.rejects(fixture({ run: current({ created_at: '2026-10-31T02:07:00Z' }) }).inspect(), /github_run_identity_invalid/);
  await assert.rejects(fixture({ run: current({ display_title: 'Nightly Sync (0 2 * * *)' }) }).inspect(), /nightly_trigger_invalid/);
});

test('API failures and incomplete pagination fail closed without database or provider calls', async () => {
  await assert.rejects(fixture({ fetchImpl: async () => new Response('', { status: 403 }) }).inspect(), /github_nightly_unavailable/);
  const run = current();
  await assert.rejects(fixture({ fetchImpl: async (url) => new Response(JSON.stringify(url.includes('/workflows/')
    ? { total_count: 101, workflow_runs: [run] } : run)) }).inspect(), /github_nightly_history_incomplete/);
  await assert.rejects(fixture({ fetchImpl: async () => { throw new Error('fixture transport'); } }).inspect(), /fixture transport/);
  const done = current({ id: 400, status: 'completed', conclusion: 'success' });
  await assert.rejects(fixture({ other: [done] }).inspect(), /github_nightly_history_incomplete/);
  await assert.rejects(fixture({ other: [done], jobs: { 400: [{ steps: [step({ completed_at: '2026-10-31T02:50:00Z' })] }] } })
    .inspect(), /github_nightly_response_invalid/);
});

test('a present successful A/C marker with inconsistent time or job evidence fails closed instead of admitting a duplicate', async () => {
  const done = current({ id: 400, status: 'completed', conclusion: 'success' });
  for (const completed_at of ['invalid', '2026-10-30T07:00:00Z', '2026-10-29T22:00:00Z', '2026-10-30T02:49:59Z']) {
    await assert.rejects(fixture({ other: [done], jobs: { 400: [{ steps: [step(),
      step({ name: 'Confirm enabled A/C completion', completed_at })] }] } }).inspect(), /github_nightly_response_invalid/);
  }
  const marker = step({ name: 'Confirm enabled A/C completion' });
  for (const jobs of [[{ steps: [marker] }], [{ steps: [step(), { ...marker, status: 'in_progress' }] }],
    [{ steps: [step()] }, { steps: [marker] }],
    [{ steps: [step({ conclusion: 'failure' }), marker] }]]) {
    await assert.rejects(fixture({ other: [done], jobs: { 400: jobs } }).inspect(), /github_nightly_response_invalid/);
  }
  assert.equal((await fixture({ other: [done], jobs: { 400: [{ steps: [step()] }] } }).inspect()).run, true);
  assert.equal((await fixture({ other: [done], jobs: { 400: [{ steps: [step(), { ...marker, conclusion: 'skipped' }] }] } }).inspect()).run, true);
});

const manual = () => current({ event: 'workflow_dispatch', display_title: 'Nightly Sync (manual)' });
const completedRun = () => current({ id: 400, status: 'completed', conclusion: 'success' });
const completedJob = () => ({ status: 'completed', conclusion: 'success', steps: enabledSteps() });

test('explicit manual fixture recovery requires a different completed enabled success today and reports its ID', async () => {
  for (const recoverMissingFixtures of [true, 'true']) {
    const check = fixture({ run: manual(), other: [completedRun()], jobs: { 400: [completedJob()] }, recoverMissingFixtures });
    assert.deepEqual(await check.inspect(), { run: true, reason: 'manual_missing_fixtures_recovery', day: '2026-10-30',
      currentRunId: '500', existingRunId: '400' });
    assert.ok(check.calls.some((url) => url.includes('status=in_progress')));
  }
  for (const recoverMissingFixtures of [false, 'false', undefined]) {
    const result = await fixture({ run: manual(), other: [completedRun()], jobs: { 400: [completedJob()] }, recoverMissingFixtures }).inspect();
    assert.equal(result.run, false); assert.equal(result.reason, 'daily_sync_already_succeeded');
  }
});

test('manual recovery cannot turn absent, disabled, incomplete or failed maintenance into enabled completion', async () => {
  const done = completedRun();
  for (const [other, jobs] of [
    [[], {}],
    [[done], { 400: [{ ...completedJob(), steps: [step()] }] }],
    [[done], { 400: [{ ...completedJob(), steps: [step(), step({ name: 'Confirm enabled A/C completion', conclusion: 'skipped' })] }] }],
    [[done], { 400: [{ ...completedJob(), steps: [step(), step({ name: 'Confirm enabled A/C completion', conclusion: 'failure' })] }] }],
    [[{ ...done, conclusion: 'failure' }], { 400: [completedJob()] }],
    [[done], { 400: [{ steps: enabledSteps() }] }],
    [[{ ...done, created_at: '2026-10-29T02:07:00Z' }], { 400: [completedJob()] }],
  ]) {
    const check = fixture({ run: manual(), other, jobs, recoverMissingFixtures: true });
    const result = await check.inspect();
    assert.equal(result.run, false); assert.equal(result.reason, 'manual_recovery_requires_daily_success');
    assert.equal(check.calls.some((url) => url.includes('status=in_progress')), false);
  }
});

test('rerunning a completed recovery ID skips maintenance even with a valid earlier daily success', async () => {
  const check = fixture({ run: manual(), other: [completedRun()], jobs: { 500: [completedJob()], 400: [completedJob()] },
    recoverMissingFixtures: true });
  const result = await check.inspect();
  assert.equal(result.run, false); assert.equal(result.reason, 'daily_sync_already_succeeded');
  assert.equal(result.existingRunId, '500');
  assert.equal(check.calls.some((url) => url.includes('status=in_progress')), false);
});

test('recovery flags are strict and scheduled or other nonmanual recoveries fail before any metadata call', async () => {
  for (const recoverMissingFixtures of ['', null, 'TRUE', 'False', '1', 'yes', 1, 0, {}, []]) {
    const check = fixture({ run: manual(), recoverMissingFixtures });
    await assert.rejects(check.inspect(), /nightly_recovery_flag_invalid/);
    assert.equal(check.calls.length, 0);
  }
  for (const event of ['schedule', 'push']) {
    const check = fixture({ run: current({ event }), recoverMissingFixtures: true });
    await assert.rejects(check.inspect(), /nightly_recovery_requires_manual/);
    assert.equal(check.calls.length, 0);
  }
});

test('recovery denies every other active execution even after finding success or across Rome day boundaries', async () => {
  for (const created_at of ['2026-10-30T02:07:00Z', '2026-10-29T18:00:00Z']) {
    const active = current({ id: 401, created_at, event: 'workflow_dispatch' });
    const result = await fixture({ run: manual(), other: [completedRun(), active], jobs: { 400: [completedJob()] },
      recoverMissingFixtures: true }).inspect();
    assert.equal(result.run, false); assert.equal(result.reason, 'daily_sync_in_progress'); assert.equal(result.existingRunId, '401');
  }
  const pendingWithJob = current({ id: 401, status: 'queued' });
  const result = await fixture({ run: manual(), other: [completedRun(), pendingWithJob],
    jobs: { 400: [completedJob()], 401: [{ status: 'in_progress', steps: [] }] }, recoverMissingFixtures: true }).inspect();
  assert.equal(result.reason, 'daily_sync_in_progress');
});

test('recovery preserves stale-day, pre-primary, identity and bounded-history admission gates', async () => {
  const stale = fixture({ run: { ...manual(), created_at: '2026-10-29T18:00:00Z' }, recoverMissingFixtures: true });
  assert.equal((await stale.inspect()).reason, 'stale_created_day'); assert.equal(stale.calls.length, 1);
  const early = fixture({ run: { ...manual(), created_at: '2026-10-30T00:00:00Z' },
    now: new Date('2026-10-30T00:30:00Z'), recoverMissingFixtures: true });
  assert.equal((await early.inspect()).reason, 'before_primary_schedule'); assert.equal(early.calls.length, 1);
  await assert.rejects(fixture({ run: { ...manual(), head_branch: 'other' }, recoverMissingFixtures: true }).inspect(), /github_run_identity_invalid/);
  await assert.rejects(fixture({ run: manual(), other: Array.from({ length: 12 }, (_, index) => current({ id: index + 600 })),
    recoverMissingFixtures: true }).inspect(), /github_nightly_history_incomplete/);
});

test('recovery fails closed on uncertain active-run metadata without a provider or database module', async () => {
  for (const item of [current({ id: 401, head_branch: 'other' }), current({ id: 401, created_at: 'future' }),
    current({ id: 401, path: '.github/workflows/other.yml' }), current({ id: 401, status: 'completed' })]) {
    await assert.rejects(fixture({ run: manual(), other: [completedRun()], jobs: { 400: [completedJob()] },
      activeRuns: [manual(), item], recoverMissingFixtures: true }).inspect(), /github_run_identity_invalid/);
  }
  const run = manual(), done = completedRun();
  await assert.rejects(fixture({ run, recoverMissingFixtures: true, fetchImpl: async (url) => {
    if (url.includes('status=in_progress')) return new Response('', { status: 403 });
    if (url.includes('/workflows/')) return new Response(JSON.stringify({ total_count: 2, workflow_runs: [run, done] }));
    if (url.includes('/jobs')) return new Response(JSON.stringify({ total_count: url.includes('/400/') ? 1 : 0,
      jobs: url.includes('/400/') ? [completedJob()] : [] }));
    return new Response(JSON.stringify(run));
  } }).inspect(), /github_nightly_unavailable/);
  const source = readFileSync(join(__dirname, '../scripts/nightly-schedule-guard.js'), 'utf8');
  assert.doesNotMatch(source, /DatabaseService|ResearchStore|OddsApiService|TURSO|ODDS_API_KEY/);
});

test('workflow gates every maintenance step before npm/build and the shell accepts all three guarded cron strings', (t) => {
  const root = join(__dirname, '../..');
  const workflow = readFileSync(join(root, '.github/workflows/nightly-sync.yml'), 'utf8');
  assert.equal((workflow.match(/timezone: Europe\/Rome/g) ?? []).length, 3);
  assert.match(workflow, /recover_missing_fixtures:\s+description:[^\r\n]+\s+type: boolean\s+required: false\s+default: false/);
  assert.match(workflow, /RECOVER_MISSING_FIXTURES: \$\{\{ inputs.recover_missing_fixtures \|\| 'false' \}\}/);
  assert.match(workflow, /name: Confirm enabled A\/C completion\r?\n {8}if: success\(\) && steps.nightly_guard.outputs.run == 'true' && vars.RESEARCH_NIGHTLY_ENABLED == 'true'/);
  assert.ok(workflow.indexOf('name: Confirm enabled A/C completion') > workflow.indexOf('run: bash scripts/ci/nightly-sync.sh'));
  assert.match(workflow, /actions: read/); assert.match(workflow, /cancel-in-progress: false/);
  assert.ok(workflow.indexOf('nightly-schedule-guard.js') < workflow.indexOf('run: npm ci'));
  for (const name of ['Install backend dependencies', 'Build backend', 'Run nightly sync']) {
    assert.match(workflow, new RegExp(`name: ${name}\\r?\\n        if: steps.nightly_guard.outputs.run == 'true'`));
  }
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (!existsSync(bash)) return t.skip('Bash unavailable; guard and workflow assertions executed.');
  for (const cron of NIGHTLY_CRONS) {
    const result = spawnSync(bash, ['scripts/ci/nightly-sync.sh'], { cwd: root, encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: 'schedule', SCHEDULE_CRON: cron, NIGHTLY_GUARD_PASSED: 'true',
        NIGHTLY_GUARD_DAY: romeDay(new Date()), TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '' } });
    assert.equal(result.status, 1); assert.match(result.stdout, /Missing required environment variable: TURSO_DATABASE_URL/);
    assert.doesNotMatch(result.stdout, /Starting backend|Unsupported nightly trigger/);
  }
  const denied = spawnSync(bash, ['scripts/ci/nightly-sync.sh'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'schedule', SCHEDULE_CRON: NIGHTLY_CRONS[0], NIGHTLY_GUARD_PASSED: 'false' } });
  assert.match(denied.stdout, /requires admission/); assert.doesNotMatch(denied.stdout, /Starting backend/);
});
