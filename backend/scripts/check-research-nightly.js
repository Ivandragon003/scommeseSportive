#!/usr/bin/env node
// Independent nightly monitor. No application bootstrap, provider calls or writes.
const safeCode = (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(value) ? value : null;
const parse = (value) => { try { return JSON.parse(String(value)); } catch { return null; } };
const GRACE_SECONDS = 4 * 3600;
const romeDay = (at) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const romeHour = (at) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(at);

const atThree = (day) => [1, 2].map((hour) => new Date(`${day}T0${hour}:00:00Z`))
  .find((at) => romeDay(at) === day && romeHour(at) === '03');
const cronOnRomeDate = (at) => `0 ${atThree(romeDay(at)).getUTCHours()} * * *`;

function expectedSchedule(now) {
  const today = atThree(romeDay(now));
  const expected = now >= today ? today : atThree(new Date(Date.parse(`${romeDay(now)}T12:00:00Z`) - 86400000).toISOString().slice(0, 10));
  return { expectedAt: expected.toISOString(), cron: `0 ${expected.getUTCHours()} * * *`, graceSeconds: GRACE_SECONDS };
}

async function inspectGithub({ now = new Date(), token, repository, expectScheduled = false, fetchImpl = fetch }) {
  if (!token || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(repository || '')) throw new Error('github_configuration_missing');
  const schedule = expectedSchedule(now);
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/nightly-sync.yml/runs?per_page=30&branch=main`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('github_nightly_unavailable');
  const payload = await response.json();
  if (!Array.isArray(payload.workflow_runs)) throw new Error('github_nightly_response_invalid');
  const valid = payload.workflow_runs.filter((run) => Number.isFinite(Date.parse(run.created_at)) && Date.parse(run.created_at) <= now.getTime())
    // Validate historical runs against 03:00 on their own Rome date, including
    // transition-day runs created before 03:00. The expected run is separate.
    .filter((run) => run.event === 'workflow_dispatch' || run.event === 'schedule'
      && run.display_title === `Nightly Sync (${cronOnRomeDate(new Date(run.created_at))})`)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const current = valid.find((run) => Date.parse(run.created_at) >= Date.parse(schedule.expectedAt)
    && (run.event === 'workflow_dispatch' || run.display_title === `Nightly Sync (${schedule.cron})`));
  const latest = current ?? valid[0] ?? null;
  const overdue = expectScheduled && now.getTime() > Date.parse(schedule.expectedAt) + GRACE_SECONDS * 1000;
  const issues = [];
  if (overdue && !current) issues.push('github_nightly_missing');
  const stalled = valid.find((run) => run.status !== 'completed'
    && now.getTime() - Date.parse(run.created_at) > GRACE_SECONDS * 1000
    && now.getTime() - Date.parse(run.created_at) <= 36 * 3600000);
  if (stalled) issues.push('github_nightly_stalled');
  if (latest && Date.parse(latest.created_at) >= now.getTime() - 36 * 3600000
    && latest.status === 'completed' && latest.conclusion !== 'success') issues.push('github_nightly_failed');
  return { checkedAt: now.toISOString(), ...schedule, expectedScheduled: expectScheduled, ok: issues.length === 0, issues,
    stalledRun: stalled ? { id: stalled.id, createdAt: stalled.created_at, status: stalled.status, url: stalled.html_url } : null,
    lastRun: latest ? { id: latest.id, event: latest.event, createdAt: latest.created_at, status: latest.status,
      conclusion: latest.conclusion, url: latest.html_url } : null,
    limitation: 'A successful GitHub job proves workflow completion; database decisions require the optional read-only database check.' };
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
    expectScheduled: process.env.RESEARCH_NIGHTLY_MONITOR_ENABLED === 'true' });
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
