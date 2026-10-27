#!/usr/bin/env node
// Runs outside Hostless and never bootstraps DatabaseService or migrations.
const { createClient } = require('@libsql/client');
const { SmartOddsRequestStore } = require('../dist/services/odds-provider/SmartOddsRequestStore');
const { quoteFreshnessReason, T15_EXECUTION_TOLERANCE_MS } = require('../dist/research/T15Scheduler');

const safeCode = (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(value) ? value : value ? 'unclassified_error' : null;
const ageSeconds = (value, now) => value && Number.isFinite(Date.parse(value)) ? (now.getTime() - Date.parse(value)) / 1000 : null;
const parse = (value) => { try { return JSON.parse(String(value)); } catch { return null; } };

async function inspectWorker(client, options = {}) {
  const now = options.now ?? new Date();
  const maxHeartbeatSeconds = options.maxHeartbeatSeconds ?? 45;
  const maxTickSeconds = options.maxTickSeconds ?? 90;
  const maxQuoteAbsenceSeconds = options.maxQuoteAbsenceSeconds ?? 900;
  const expectEnabled = options.expectEnabled ?? false;
  const cutoff = new Date(now.getTime() - 3600_000).toISOString();
  const components = ['research_t15', 'research_provider', 'research_settlement', 'research_model_check'];
  const [state, jobs, decisions, failures, settlements, pending, missed, inputs, quoteFailures] = await Promise.all([
    client.execute("SELECT enabled,lease_expires_at,heartbeat_at,last_tick_at,last_tick_json,last_error FROM research_worker_state WHERE scheduler='research_t15'"),
    client.execute('SELECT status,reason,COUNT(*) AS count,MAX(updated_at) AS last_at FROM research_jobs GROUP BY status,reason'),
    client.execute(`SELECT d.created_at,d.family,d.action,d.reason,j.target_at FROM research_decisions d
      JOIN research_jobs j ON j.id=d.job_id ORDER BY d.created_at DESC LIMIT 2`),
    Promise.all(components.map((name) => client.execute({ sql: `SELECT scheduler_name,started_at,ended_at,success,error,summary_json FROM scheduler_runs
      WHERE scheduler_name=? AND julianday(ended_at)>=julianday(?) AND julianday(ended_at)<=julianday(?)
      ORDER BY julianday(ended_at) DESC LIMIT 100`, args: [name, cutoff, now.toISOString()] }))),
    client.execute('SELECT MAX(settled_at) AS last_at,COUNT(*) AS count FROM research_settlements'),
    client.execute(`SELECT COUNT(*) AS count FROM research_bets b LEFT JOIN research_settlements s ON s.bet_id=b.id
      JOIN matches m ON m.match_id=b.match_id WHERE s.bet_id IS NULL AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL`),
    client.execute({ sql: `SELECT status,COUNT(*) AS count FROM research_jobs
      WHERE status IN ('MISSED','PENDING','CLAIMED') AND julianday(target_at)>=julianday(?)
      AND julianday(target_at)<julianday(?) GROUP BY status`,
    args: [cutoff, new Date(now.getTime() - T15_EXECUTION_TOLERANCE_MS).toISOString()] }),
    client.execute({ sql: `SELECT captured_at,snapshot_json FROM research_inputs
      WHERE julianday(captured_at)>=julianday(?) AND julianday(captured_at)<=julianday(?)
      ORDER BY julianday(captured_at) DESC LIMIT 100`, args: [cutoff, now.toISOString()] }),
    client.execute({ sql: `SELECT updated_at AS at,reason FROM research_jobs
      WHERE reason IN ('fixture_unknown','quote_stale','real_quote_missing','quote_timestamp_missing','quote_timestamp_future')
      AND julianday(updated_at)>=julianday(?) AND julianday(updated_at)<=julianday(?)
      ORDER BY julianday(updated_at) DESC LIMIT 100`, args: [cutoff, now.toISOString()] }),
  ]);
  // overview() is explicitly read-only; do not call execute(), which admits network requests.
  const odds = await new SmartOddsRequestStore(client, async () => {}, { clock: () => now,
    monthlyLimit: options.monthlyLimit, reserveCredits: options.reserveCredits }).overview();
  const row = state.rows[0];
  const heartbeatAgeSeconds = ageSeconds(row?.heartbeat_at, now);
  const tickAgeSeconds = ageSeconds(row?.last_tick_at, now);
  const enabled = Boolean(Number(row?.enabled));
  const issues = [];
  if (expectEnabled && !enabled) issues.push(row ? 'worker_disabled' : 'worker_never_observed');
  if (enabled) {
    if (heartbeatAgeSeconds === null || heartbeatAgeSeconds < -5 || heartbeatAgeSeconds > maxHeartbeatSeconds) issues.push('worker_heartbeat_stale');
    if (tickAgeSeconds === null || tickAgeSeconds < -5 || tickAgeSeconds > maxTickSeconds) issues.push('worker_tick_stalled');
    const leaseUntil = Date.parse(row.lease_expires_at ?? '');
    if (!Number.isFinite(leaseUntil) || leaseUntil <= now.getTime()) issues.push('worker_lease_expired');
    if (row.last_error) issues.push('worker_error');
  }
  const observedRuns = failures.flatMap((result) => result.rows).sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at));
  const recentRuns = observedRuns.map((run) => ({ scheduler: run.scheduler_name, startedAt: run.started_at,
    endedAt: run.ended_at, success: Boolean(Number(run.success)), error: safeCode(run.error) }));
  const persistentErrors = ['research_t15', 'research_provider', 'research_settlement'].filter((name) => {
    const latest = recentRuns.filter((run) => run.scheduler === name).slice(0, 3);
    return latest.length === 3 && latest.every((run) => !run.success);
  });
  if (persistentErrors.some((name) => name === 'research_settlement' || enabled || expectEnabled)) issues.push('persistent_scheduler_errors');
  const modelGroups = new Map();
  for (const run of observedRuns.filter((entry) => entry.scheduler_name === 'research_model_check')) {
    const summary = parse(run.summary_json);
    if (!['A', 'C'].includes(summary?.family) || typeof summary.modelVersion !== 'string') continue;
    const key = JSON.stringify([summary.family, summary.modelVersion]);
    const group = modelGroups.get(key) ?? [];
    group.push(run); modelGroups.set(key, group);
  }
  const modelFailures = [...modelGroups.values()].filter((group) => group.length >= 3
    && group.slice(0, 3).every((run) => !Number(run.success)))
    .map((group) => ({ family: parse(group[0].summary_json).family, failures: 3 }));
  const missedDecisions = missed.rows.reduce((sum, entry) => sum + Number(entry.count), 0);
  const quoteObservations = inputs.rows.map((input) => {
    const snapshot = parse(input.snapshot_json);
    return { at: String(input.captured_at), usable: Array.isArray(snapshot?.quotes)
      && snapshot.quotes.some((quote) => !quoteFreshnessReason(quote, Date.parse(String(input.captured_at)))) };
  });
  const lastUsableAt = quoteObservations.find((entry) => entry.usable)?.at ?? null;
  const unavailableAt = [...quoteObservations.filter((entry) => !entry.usable).map((entry) => entry.at),
    ...quoteFailures.rows.map((entry) => String(entry.at)),
    ...observedRuns.filter((run) => run.scheduler_name === 'research_provider'
      && (!Number(run.success) || parse(run.summary_json)?.eventCount === 0)).map((run) => String(run.ended_at))]
    .filter((at) => !lastUsableAt || Date.parse(at) > Date.parse(lastUsableAt))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  // A quiet match calendar or an old cache alone never proves an odds outage.
  const quoteAbsenceSeconds = unavailableAt.length > 1
    ? (Date.parse(unavailableAt.at(-1)) - Date.parse(unavailableAt[0])) / 1000 : 0;
  if (enabled || expectEnabled) {
    if (odds.providers.some((provider) => provider.availableCredits <= 0)) issues.push('odds_credits_exhausted');
    if (missedDecisions) issues.push('scheduler_missed_decisions');
    if (quoteAbsenceSeconds >= maxQuoteAbsenceSeconds) issues.push('odds_unavailable_prolonged');
    if (modelFailures.length) issues.push('persistent_model_errors');
  }
  const settlementBacklog = Number(pending.rows[0]?.count ?? 0);
  const lastSettlementRun = recentRuns.find((run) => run.scheduler === 'research_settlement');
  if (settlementBacklog && (!lastSettlementRun || !lastSettlementRun.success
    || ageSeconds(lastSettlementRun.endedAt, now) > 180)) issues.push('settlement_backlog');
  return { checkedAt: now.toISOString(), ok: issues.length === 0, issues,
    worker: { state: enabled ? issues.some((issue) => /^worker_/.test(issue)) ? 'DEGRADED' : 'RUNNING'
      : row ? 'DISABLED' : 'UNOBSERVED', expectedEnabled: expectEnabled, heartbeatAt: row?.heartbeat_at ?? null,
      heartbeatAgeSeconds, leaseExpiresAt: row?.lease_expires_at ?? null, lastTickAt: row?.last_tick_at ?? null,
      tickAgeSeconds, lastTick: parse(row?.last_tick_json), lastError: safeCode(row?.last_error) },
    latestDecisions: decisions.rows.map((decision) => ({ family: decision.family, action: decision.action,
      at: decision.created_at, targetAt: decision.target_at, lagSeconds: (Date.parse(decision.created_at) - Date.parse(decision.target_at)) / 1000,
      reason: safeCode(decision.reason) })),
    jobs: jobs.rows.map((job) => ({ status: job.status, reason: safeCode(job.reason), count: Number(job.count), lastAt: job.last_at })),
    persistentErrors, modelFailures, recentRuns, odds,
    missedDecisions: { recentHour: missedDecisions, byStatus: missed.rows.map((entry) => ({ status: entry.status, count: Number(entry.count) })) },
    quoteAvailability: { lastUsableAt, failedObservations: unavailableAt.length, absenceSeconds: quoteAbsenceSeconds,
      alertAfterSeconds: maxQuoteAbsenceSeconds, windowSeconds: 3600 },
    settlements: { count: Number(settlements.rows[0]?.count ?? 0), lastAt: settlements.rows[0]?.last_at ?? null,
      completedMatchesAwaitingSettlement: settlementBacklog, lastRun: lastSettlementRun ?? null } };
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (!url) throw new Error('database_configuration_missing');
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  let timer;
  try {
    const result = await Promise.race([inspectWorker(client, {
      expectEnabled: process.env.RESEARCH_WATCHDOG_EXPECT_ENABLED === 'true',
    }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('watchdog_timeout')), 15_000); })]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } finally { clearTimeout(timer); client.close(); }
}

if (require.main === module) main().catch((error) => {
  // Database errors can contain credentials/URLs. Report only classified local errors.
  process.stderr.write(`${JSON.stringify({ ok: false, issues: [safeCode(error?.message) ?? 'watchdog_database_unavailable'] })}\n`);
  process.exitCode = 1;
});

module.exports = { inspectWorker };
