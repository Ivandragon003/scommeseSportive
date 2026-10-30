#!/usr/bin/env node
// Independent nightly monitor. No application bootstrap, provider calls or writes.
const safeCode = (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(value) ? value : null;
const parse = (value) => { try { return JSON.parse(String(value)); } catch { return null; } };
const { primarySchedule, supportedRun, successfulSync, githubReader, romeDay, validTime, SYNC_STEP } = require('./nightly-schedule-guard');
const GRACE_SECONDS = 4 * 3600;
const expectedSchedule = (now) => ({ ...primarySchedule(now), graceSeconds: GRACE_SECONDS });
const publicRun = (run) => ({ id: run.id, event: run.event, createdAt: run.created_at,
  status: run.status, conclusion: run.conclusion, url: run.html_url });

async function inspectGithub({ now = new Date(), token, repository, expectScheduled = false,
  acknowledgedOrphanRunIds = '', fetchImpl = fetch }) {
  const ids = String(acknowledgedOrphanRunIds).split(/[,\s]+/).filter(Boolean);
  if (ids.length > 10 || ids.some((id) => !/^\d{1,30}$/.test(id))) throw new Error('github_orphan_acknowledgement_invalid');
  const acknowledgedIds = new Set(ids);
  const api = githubReader({ token, repository, fetchImpl });
  const schedule = expectedSchedule(now);
  const runs = await api.runs(new Date(now.getTime() - 36 * 3600000).toISOString());
  // Explicit acknowledgements stay observable after the ordinary history window.
  // If an old orphan acquires jobs later, the next check must make it fatal again.
  for (const id of acknowledgedIds) if (!runs.some((run) => String(run.id) === id)) {
    const run = await api.run(id);
    if (String(run.id) !== id || run.head_branch !== 'main'
      || run.path?.split('@')[0] !== '.github/workflows/nightly-sync.yml') throw new Error('github_orphan_acknowledgement_invalid');
    runs.push(run);
  }
  const valid = runs.filter((run) => supportedRun(run, now)
    && (now.getTime() - Date.parse(run.created_at) <= 36 * 3600000 || acknowledgedIds.has(String(run.id))))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (valid.length > 30) throw new Error('github_nightly_history_incomplete');
  const observed = [], notExecutedRuns = [], acknowledgedOrphans = [], revivedOrphans = [];
  for (const run of valid) {
    const jobs = await api.jobs(run.id);
    if (acknowledgedIds.has(String(run.id)) && run.status === 'queued' && jobs.length === 0
      && romeDay(run.created_at) < romeDay(now)) {
      acknowledgedOrphans.push({ ...publicRun(run), reason: 'explicit_previous_day_zero_job_ack', cancelled: false });
      continue;
    }
    const syncSteps = jobs.flatMap((job) => job.steps ?? []).filter((step) => step.name === SYNC_STEP);
    const started = syncSteps.some((step) => step.conclusion !== 'skipped'
      && validTime(step.started_at) && Date.parse(step.started_at) <= now.getTime());
    const succeeded = successfulSync(jobs, romeDay(run.created_at), now);
    const completedLate = syncSteps.some((step) => step.status === 'completed' && step.conclusion === 'success'
      && validTime(step.completed_at) && Date.parse(step.completed_at) <= now.getTime());
    if (acknowledgedIds.has(String(run.id))) revivedOrphans.push({ ...publicRun(run),
      reason: 'acknowledged_orphan_state_changed', jobsObserved: jobs.length,
      executionObserved: started || completedLate });
    if (run.status === 'completed' && !started && !completedLate
      && ['success', 'cancelled', 'skipped'].includes(run.conclusion)) {
      notExecutedRuns.push({ ...publicRun(run), state: 'NOT_EXECUTED' });
      continue;
    }
    observed.push({ ...run, executionObserved: started || completedLate, syncSucceeded: succeeded });
  }
  const current = observed.filter((run) => romeDay(run.created_at) === schedule.day
    && Date.parse(run.created_at) >= Date.parse(schedule.expectedAt));
  const fullSuccess = current.some((run) => run.syncSucceeded);
  const latest = current[0] ?? observed[0] ?? null;
  const overdue = expectScheduled && now.getTime() > Date.parse(schedule.expectedAt) + GRACE_SECONDS * 1000;
  const issues = [];
  if (overdue && !fullSuccess) issues.push('github_nightly_missing');
  const stalled = observed.find((run) => run.status !== 'completed'
    && now.getTime() - Date.parse(run.created_at) > GRACE_SECONDS * 1000);
  if (stalled) issues.push('github_nightly_stalled');
  if (latest && now.getTime() - Date.parse(latest.created_at) <= 36 * 3600000
    && latest.status === 'completed' && latest.conclusion !== 'success') issues.push('github_nightly_failed');
  // Acknowledgement covers one observed queued/zero-job state, not future execution.
  // Keep this independent of created_at: a very old orphan can start much later.
  if (revivedOrphans.length) issues.push('github_acknowledged_orphan_revived');
  return { checkedAt: now.toISOString(), ...schedule, expectedScheduled: expectScheduled, ok: issues.length === 0, issues,
    syncCompleted: fullSuccess, acknowledgedOrphans, revivedOrphans, notExecutedRuns,
    stalledRun: stalled ? publicRun(stalled) : null,
    lastRun: latest ? { ...publicRun(latest), executionObserved: latest.executionObserved } : null,
    limitation: 'Only a successful Run nightly sync step proves full maintenance execution; database decisions require the read-only database check.' };
}

async function inspectDatabase(client, { now = new Date(), expectEnabled = false } = {}) {
  const { researchNightlyStatus } = require('../dist/research/ResearchMonitoring');
  const { SmartOddsRequestStore } = require('../dist/services/odds-provider/SmartOddsRequestStore');
  const before = await client.execute('SELECT COUNT(*) AS count,MAX(rowid) AS last FROM research_ledger');
  const [runs, pending, accounting, invalidMovements, odds] = await Promise.all([
    client.execute("SELECT scheduler_name,started_at,ended_at,success,error,summary_json FROM scheduler_runs WHERE scheduler_name='research_nightly' ORDER BY julianday(started_at) DESC LIMIT 10"),
    client.execute(`SELECT COUNT(*) AS count FROM research_bets b LEFT JOIN research_settlements s ON s.bet_id=b.id
      JOIN matches m ON m.match_id=b.match_id WHERE s.bet_id IS NULL AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL`),
    client.execute(`SELECT p.id,COALESCE(SUM(l.available_delta_cents),0) AS available,COALESCE(SUM(l.committed_delta_cents),0) AS committed,
      SUM(CASE WHEN l.event='OPEN' THEN 1 ELSE 0 END) AS openings,
      (SELECT COALESCE(SUM(b.stake_cents),0) FROM research_bets b LEFT JOIN research_settlements s ON s.bet_id=b.id
        WHERE b.portfolio_id=p.id AND s.bet_id IS NULL) AS open_stakes
      FROM research_portfolios p LEFT JOIN research_ledger l ON l.portfolio_id=p.id GROUP BY p.id`),
    client.execute(`SELECT COUNT(*) AS count FROM research_bets b LEFT JOIN research_settlements s ON s.bet_id=b.id WHERE
      (SELECT COUNT(*) FROM research_ledger l WHERE l.bet_id=b.id AND l.event='STAKE' AND l.portfolio_id=b.portfolio_id
       AND l.available_delta_cents=-b.stake_cents AND l.committed_delta_cents=b.stake_cents)!=1
      OR (s.bet_id IS NOT NULL AND (SELECT COUNT(*) FROM research_ledger l WHERE l.bet_id=b.id AND l.event='SETTLE'
       AND l.portfolio_id=b.portfolio_id AND l.available_delta_cents=s.return_cents AND l.committed_delta_cents=-b.stake_cents)!=1)
      OR (s.bet_id IS NULL AND EXISTS(SELECT 1 FROM research_ledger l WHERE l.bet_id=b.id AND l.event='SETTLE'))`),
    new SmartOddsRequestStore(client, async () => {}, { clock: () => now }).overview(),
  ]);
  const after = await client.execute('SELECT COUNT(*) AS count,MAX(rowid) AS last FROM research_ledger');
  const stableAccounting = JSON.stringify(before.rows) === JSON.stringify(after.rows);
  const nightly = researchNightlyStatus(runs.rows.map((run) => ({ schedulerName: run.scheduler_name, startedAt: run.started_at,
    endedAt: run.ended_at, success: Boolean(Number(run.success)), error: safeCode(run.error), summary: parse(run.summary_json) })), now, expectEnabled);
  const issues = [];
  if (nightly.overdue) issues.push('nightly_execution_missing');
  if (expectEnabled && nightly.lastRun && nightly.state === 'DISABLED') issues.push('nightly_registration_disabled');
  const recentCompleted = nightly.lastRun && Number.isFinite(Date.parse(nightly.lastRun.endedAt))
    && Date.parse(nightly.lastRun.endedAt) <= now.getTime()
    && now.getTime() - Date.parse(nightly.lastRun.startedAt) <= 36 * 3600000;
  if (recentCompleted && nightly.lastRun.success === false) issues.push('nightly_execution_failed');
  if (odds.providers.some((provider) => provider.availableCredits <= 0)) issues.push('nightly_odds_credits_exhausted');
  if (recentCompleted && Number(nightly.metrics.apiErrors) >= 3) issues.push('nightly_api_errors');
  const pendingSettlements = Number(pending.rows[0]?.count ?? 0);
  if (pendingSettlements && now.getTime() > Date.parse(nightly.expectedAt) + GRACE_SECONDS * 1000) issues.push('settlement_backlog');
  const accountingErrors = accounting.rows.filter((row) => Number(row.available) < 0 || Number(row.committed) < 0
    || Number(row.openings) !== 1 || Number(row.committed) !== Number(row.open_stakes)).length + Number(invalidMovements.rows[0]?.count ?? 0);
  if (stableAccounting && accountingErrors) issues.push('virtual_accounting_integrity');
  return { checkedAt: now.toISOString(), ok: issues.length === 0, issues, nightly,
    pendingSettlements, accounting: { stable: stableAccounting, checked: stableAccounting, errors: stableAccounting ? accountingErrors : null },
    odds, delivery: { externalConfigured: false, note: 'No external message was sent by this check.' } };
}

async function main() {
  const githubOnly = process.argv.includes('--github-only');
  const databaseOnly = process.argv.includes('--database-only');
  const output = {};
  if (!databaseOnly) output.github = await inspectGithub({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY,
    expectScheduled: process.env.RESEARCH_NIGHTLY_MONITOR_ENABLED === 'true',
    acknowledgedOrphanRunIds: process.env.RESEARCH_NIGHTLY_ACKNOWLEDGED_ORPHAN_RUN_IDS });
  if (!githubOnly && process.env.TURSO_WATCHDOG_READONLY_TOKEN && process.env.TURSO_DATABASE_URL) {
    const { createClient } = require('@libsql/client');
    const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_WATCHDOG_READONLY_TOKEN });
    try { output.database = await inspectDatabase(client, { expectEnabled: process.env.RESEARCH_NIGHTLY_EXPECT_ENABLED === 'true' }); }
    finally { client.close(); }
  } else if (databaseOnly) throw new Error('dedicated_readonly_database_token_missing');
  else output.database = { state: 'NOT_CHECKED', reason: 'Dedicated read-only database credentials are not configured or this is a GitHub-only check.' };
  console.log(JSON.stringify(output, null, 2));
  if (output.github?.ok === false || output.database?.ok === false) process.exitCode = 1;
}

module.exports = { expectedSchedule, inspectGithub, inspectDatabase };
if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, issues: [safeCode(error?.message) ?? 'nightly_watchdog_unavailable'] }));
  process.exitCode = 1;
});
