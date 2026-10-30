#!/usr/bin/env node
// GitHub metadata only: never import application/database/provider modules.
const { appendFileSync } = require('node:fs');

const NIGHTLY_CRONS = ['7 3 * * *', '17 4 * * *', '27 5 * * *'];
const SYNC_STEP = 'Run nightly sync';
const AC_COMPLETION_STEP = 'Confirm enabled A/C completion';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const romeDay = (at) => dayFormat.format(new Date(at));
const validTime = (value) => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
  && Number.isFinite(Date.parse(value));
const previousDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);

function romeTime(day, hour, minute = 0) {
  const local = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const at = [1, 2].map((offset) => new Date(Date.parse(`${day}T00:00:00Z`) + (hour * 60 + minute - offset * 60) * 60000))
    .find((candidate) => romeDay(candidate) === day && timeFormat.format(candidate) === local);
  if (!at) throw new Error('nightly_schedule_unavailable');
  return at;
}

function primarySchedule(now) {
  const today = romeTime(romeDay(now), 3, 7);
  const day = now >= today ? romeDay(now) : previousDay(romeDay(now));
  return { expectedAt: romeTime(day, 3, 7).toISOString(), day, timezone: 'Europe/Rome',
    cron: NIGHTLY_CRONS[0], backupCrons: NIGHTLY_CRONS.slice(1) };
}

function supportedRun(run, now) {
  if (!validTime(run.created_at) || Date.parse(run.created_at) > now.getTime()) return false;
  if (run.event === 'workflow_dispatch') return true;
  if (run.event !== 'schedule') return false;
  const cron = /^Nightly Sync \((.*)\)$/.exec(run.display_title ?? '')?.[1];
  if (NIGHTLY_CRONS.includes(cron)) return true;
  // Keep pre-cutover history, excluding the deliberately inactive UTC trigger.
  return cron === `0 ${romeTime(romeDay(run.created_at), 3).getUTCHours()} * * *`;
}

function successfulSync(jobs, day, now) {
  const completed = (step, name) => step.name === name && step.status === 'completed' && step.conclusion === 'success'
    && validTime(step.completed_at) && Date.parse(step.completed_at) <= now.getTime() && romeDay(step.completed_at) === day;
  return jobs.some((job) => {
    const sync = (job.steps ?? []).find((step) => completed(step, SYNC_STEP));
    const marker = (job.steps ?? []).find((step) => completed(step, AC_COMPLETION_STEP));
    return sync && marker && Date.parse(marker.completed_at) >= Date.parse(sync.completed_at);
  });
}

function githubReader({ token, repository, fetchImpl = fetch }) {
  if (!token || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(repository ?? '')) throw new Error('github_configuration_missing');
  const base = `https://api.github.com/repos/${repository}/actions`;
  const get = async (path) => {
    const response = await fetchImpl(`${base}/${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', 'Cache-Control': 'no-cache' } });
    if (!response.ok) throw new Error('github_nightly_unavailable');
    try { return await response.json(); } catch { throw new Error('github_nightly_response_invalid'); }
  };
  const completeList = (payload, key) => {
    if (!Array.isArray(payload[key]) || !Number.isInteger(payload.total_count)
      || payload.total_count !== payload[key].length || payload.total_count > 100) throw new Error('github_nightly_history_incomplete');
    return payload[key];
  };
  const id = (value) => {
    if (!/^\d{1,30}$/.test(String(value ?? ''))) throw new Error('github_run_identity_invalid');
    return String(value);
  };
  return {
    run: (runId) => get(`runs/${id(runId)}`),
    runs: async (since) => completeList(await get(`workflows/nightly-sync.yml/runs?per_page=100&branch=main&created=${encodeURIComponent(`>=${since}`)}`), 'workflow_runs'),
    activeRuns: async () => completeList(await get('workflows/nightly-sync.yml/runs?per_page=100&branch=main&status=in_progress'), 'workflow_runs'),
    jobs: async (runId) => completeList(await get(`runs/${id(runId)}/jobs?filter=all&per_page=100`), 'jobs'),
  };
}

async function guardNightly({ now = new Date(), token, repository, runId, eventName, scheduleCron,
  recoverMissingFixtures = false, fetchImpl = fetch }) {
  if (![true, false, 'true', 'false'].includes(recoverMissingFixtures)) throw new Error('nightly_recovery_flag_invalid');
  const recovery = recoverMissingFixtures === true || recoverMissingFixtures === 'true';
  if (recovery && eventName !== 'workflow_dispatch') throw new Error('nightly_recovery_requires_manual');
  const api = githubReader({ token, repository, fetchImpl });
  const current = await api.run(runId);
  if (String(current.id) !== String(runId) || current.head_branch !== 'main' || current.event !== eventName
    || current.path?.split('@')[0] !== '.github/workflows/nightly-sync.yml' || !validTime(current.created_at)
    || Date.parse(current.created_at) > now.getTime()) throw new Error('github_run_identity_invalid');
  const day = romeDay(current.created_at);
  const result = (run, reason, existingRunId = null) => ({ run, reason, day, currentRunId: String(runId), existingRunId });
  if (day !== romeDay(now)) return result(false, 'stale_created_day');
  if (!['schedule', 'workflow_dispatch'].includes(eventName)) throw new Error('nightly_trigger_invalid');
  if (eventName === 'schedule' && (!NIGHTLY_CRONS.includes(scheduleCron)
    || current.display_title !== `Nightly Sync (${scheduleCron})`)) throw new Error('nightly_trigger_invalid');
  // A pre-03:07 manual run would otherwise consume today's single execution
  // while the model window still ends at today's configured boundary.
  if (now < romeTime(day, 3, 7)) return result(false, 'before_primary_schedule');
  const runs = await api.runs(romeTime(day, 0).toISOString());
  const candidates = runs.filter((run) => supportedRun(run, now) && romeDay(run.created_at) === day);
  if (candidates.length > 12) throw new Error('github_nightly_history_incomplete');
  let completedSuccessId = null;
  // Check the current ID too: a rerun must see successful steps of older attempts.
  for (const run of [current, ...candidates.filter((run) => String(run.id) !== String(runId))]) {
    const jobs = await api.jobs(run.id);
    if (run.status === 'completed' && run.conclusion === 'success'
      && (!jobs.length || jobs.some((job) => !Array.isArray(job.steps)))) throw new Error('github_nightly_history_incomplete');
    const successSteps = jobs.flatMap((job) => job.steps ?? []).filter((step) => step.name === SYNC_STEP
      && step.status === 'completed' && step.conclusion === 'success');
    if (successSteps.some((step) => !validTime(step.completed_at) || Date.parse(step.completed_at) > now.getTime()
      || romeDay(step.completed_at) !== day)) throw new Error('github_nightly_response_invalid');
    for (const job of jobs) for (const marker of (job.steps ?? []).filter((step) => step.name === AC_COMPLETION_STEP
      && step.conclusion === 'success')) {
      if (marker.status !== 'completed' || !validTime(marker.completed_at) || Date.parse(marker.completed_at) > now.getTime()
        || romeDay(marker.completed_at) !== day || !(job.steps ?? []).some((step) => step.name === SYNC_STEP
          && step.status === 'completed' && step.conclusion === 'success' && validTime(step.completed_at)
          && Date.parse(step.completed_at) <= Date.parse(marker.completed_at))) throw new Error('github_nightly_response_invalid');
    }
    if (successfulSync(jobs, day, now)) {
      // Rerunning the same successful ID cannot discover new jobs in its completed DB batch.
      if (!recovery || String(run.id) === String(runId)) return result(false, 'daily_sync_already_succeeded', String(run.id));
      if (String(run.id) !== String(runId) && run.status === 'completed' && run.conclusion === 'success'
        && successfulSync(jobs.filter((job) => job.status === 'completed' && job.conclusion === 'success'), day, now)) {
        completedSuccessId ??= String(run.id);
      }
    }
    if (recovery && String(run.id) !== String(runId)
      && (run.status === 'in_progress' || jobs.some((job) => job.status === 'in_progress'))) {
      return result(false, 'daily_sync_in_progress', String(run.id));
    }
    if (String(run.id) !== String(runId) && run.status === 'in_progress'
      && jobs.some((job) => job.status === 'in_progress')) return result(false, 'daily_sync_in_progress', String(run.id));
  }
  if (recovery) {
    if (!completedSuccessId) return result(false, 'manual_recovery_requires_daily_success');
    // Include active runs created on earlier days, without trusting the daily history filter.
    const active = await api.activeRuns();
    if (active.length > 12) throw new Error('github_nightly_history_incomplete');
    for (const run of active) {
      if (String(run.id) === String(runId)) continue;
      if (run.head_branch !== 'main' || run.path?.split('@')[0] !== '.github/workflows/nightly-sync.yml'
        || run.status !== 'in_progress' || !validTime(run.created_at) || Date.parse(run.created_at) > now.getTime()
        || !/^\d{1,30}$/.test(String(run.id))) throw new Error('github_run_identity_invalid');
      return result(false, 'daily_sync_in_progress', String(run.id));
    }
    return result(true, 'manual_missing_fixtures_recovery', completedSuccessId);
  }
  return result(true, 'daily_sync_admitted');
}

async function main() {
  const result = await guardNightly({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID, eventName: process.env.GITHUB_EVENT_NAME, scheduleCron: process.env.SCHEDULE_CRON,
    recoverMissingFixtures: process.env.RECOVER_MISSING_FIXTURES });
  if (!process.env.GITHUB_OUTPUT) throw new Error('github_output_missing');
  appendFileSync(process.env.GITHUB_OUTPUT, `run=${result.run}\nday=${result.day}\nreason=${result.reason}\n`);
  console.log(JSON.stringify(result));
}

module.exports = { NIGHTLY_CRONS, SYNC_STEP, AC_COMPLETION_STEP, romeDay, romeTime, validTime, primarySchedule, supportedRun, successfulSync, githubReader, guardNightly };
if (require.main === module) main().catch(() => { console.error('nightly_schedule_guard_unavailable'); process.exitCode = 1; });
