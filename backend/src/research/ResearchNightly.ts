import { ResearchRuntime, settleResearchBets } from './ResearchRuntime';
import { baselineManifest, TOP5_COMPETITIONS } from './ForecastCore';
import { PreparedT15Job, safeOddsFailureCode } from './T15Scheduler';
import { reconcileResearchMonitoring } from './ResearchMonitoring';
import { settleProspectiveEvidence } from './ResearchProspectiveEvidence';

export type NightlyPolicy = {
  enabled: boolean; hour: number; minute: number; windowHours: number | null;
  quoteMaxAgeMs: number; minEv: number; minPrudentialEv: number;
};
const integer = (value: string | undefined, fallback: number, min: number, max: number, name: string): number => {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
};
const threshold = (value: string | undefined, fallback: number, name: string): number => {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`Invalid ${name}`);
  return n;
};
export function loadNightlyPolicy(env: NodeJS.ProcessEnv = process.env): NightlyPolicy {
  if (env.RESEARCH_NIGHTLY_ENABLED && !['true', 'false'].includes(env.RESEARCH_NIGHTLY_ENABLED)) throw new Error('Invalid RESEARCH_NIGHTLY_ENABLED');
  return { enabled: env.RESEARCH_NIGHTLY_ENABLED === 'true',
    hour: integer(env.RESEARCH_NIGHTLY_HOUR, 3, 0, 23, 'RESEARCH_NIGHTLY_HOUR'),
    minute: integer(env.RESEARCH_NIGHTLY_MINUTE, 0, 0, 59, 'RESEARCH_NIGHTLY_MINUTE'),
    windowHours: env.RESEARCH_NIGHTLY_WINDOW_HOURS ? integer(env.RESEARCH_NIGHTLY_WINDOW_HOURS, 24, 1, 48, 'RESEARCH_NIGHTLY_WINDOW_HOURS') : null,
    quoteMaxAgeMs: integer(env.RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS, 300, 1, 3600, 'RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS') * 1000,
    minEv: threshold(env.RESEARCH_NIGHTLY_MIN_EV, .04, 'RESEARCH_NIGHTLY_MIN_EV'),
    minPrudentialEv: threshold(env.RESEARCH_NIGHTLY_MIN_PRUDENTIAL_EV, .01, 'RESEARCH_NIGHTLY_MIN_PRUDENTIAL_EV') };
}

const rome = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const romeParts = (date: Date) => Object.fromEntries(rome.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));

/** Search real instants, so Rome's skipped/repeated DST hour cannot create a fictitious timestamp. */
export function nextNightlyBoundary(now: Date, hour = 3, minute = 0): Date {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(hour) || hour < 0 || hour > 23
    || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Invalid nightly boundary');
  const start = Math.floor(now.getTime() / 60000) * 60000 + 60000;
  for (let at = start; at <= start + 49 * 3600000; at += 60000) {
    const parts = romeParts(new Date(at));
    if (parts.hour === hour && parts.minute === minute) return new Date(at);
  }
  throw new Error('Nightly boundary unavailable');
}

function previousNightlyBoundary(now: Date, hour: number, minute: number): Date {
  const start = Math.floor(now.getTime() / 60000) * 60000;
  for (let at = start; at >= start - 49 * 3600000; at -= 60000) {
    const parts = romeParts(new Date(at));
    if (parts.hour === hour && parts.minute === minute) return new Date(at);
  }
  throw new Error('Previous nightly boundary unavailable');
}

export function nightlyQuoteReason(quote: any, now: number, maxAgeMs: number): string | null {
  if (!quote || quote.source !== 'odds_api' || !String(quote.bookmaker ?? '').trim() || quote.usedSyntheticOdds === true
    || !Number.isFinite(quote.odds) || quote.odds <= 1) return 'real_quote_required';
  for (const value of [quote.capturedAt, quote.updatedAt]) {
    const at = typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(at)) return 'quote_timestamp_missing';
    if (at > now) return 'quote_timestamp_future';
    if (now - at > maxAgeMs) return 'quote_stale';
  }
  return null;
}

type RuntimeDb = ConstructorParameters<typeof ResearchRuntime>[0];
type NightlyPreparer = Pick<ResearchRuntime, 'prepareNightly' | 'getQuotaStatus'>;
export type NightlySummary = {
  mode: 'NIGHTLY'; enabled: boolean; runId: string | null; startedAt: string; endedAt: string | null; windowEndAt: string;
  analyzedMatches: number; registeredBets: number; skippedMatches: number; missedMatches: number; errors: number; apiErrors: number;
  settlement: { checked: number; settled: number; unresolved: number }; quota: unknown; reasonCounts: Record<string, number>;
  prospectiveEvidence?: { checked: number; settled: number; unresolved: number; frozen: number };
};

/** A finite job on the CI runner. No timer-driven betting and no legacy HTTP placement route. */
export async function runResearchNightly(db: RuntimeDb, options: { policy?: NightlyPolicy; clock?: () => Date;
  preparer?: NightlyPreparer; runId?: string; leaseMs?: number; dataGatesPassed?: boolean } = {}): Promise<NightlySummary> {
  const policy = options.policy ?? loadNightlyPolicy(), clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const windowEndAt = policy.windowHours ? new Date(Date.parse(startedAt) + policy.windowHours * 3600000).toISOString()
    : nextNightlyBoundary(new Date(startedAt), policy.hour, policy.minute).toISOString();
  const summary: NightlySummary = { mode: 'NIGHTLY', enabled: policy.enabled, runId: null, startedAt, endedAt: null, windowEndAt,
    analyzedMatches: 0, registeredBets: 0, skippedMatches: 0, missedMatches: 0, errors: 0, apiErrors: 0,
    settlement: { checked: 0, settled: 0, unresolved: 0 }, quota: null, reasonCounts: {} };
  const reason = (code: string) => { summary.reasonCounts[code] = (summary.reasonCounts[code] ?? 0) + 1; };
  if (!policy.enabled) { reason('nightly_disabled'); summary.endedAt = clock().toISOString(); return summary; }
  if (process.env.RESEARCH_T15_SCHEDULER_ENABLED === 'true') throw new Error('Conflicting automatic research schedulers');
  // GITHUB_RUN_ID survives run_attempt retries. Local invocations use the same
  // scheduled-day identity even when a custom duration changes the window end.
  const runId = options.runId ?? `nightly:${nextNightlyBoundary(new Date(startedAt), policy.hour, policy.minute).toISOString()}`;
  const existing = await db.research.getNightlyRun(runId);
  if (existing) { summary.startedAt = existing.startedAt; summary.windowEndAt = existing.windowEndAt; }
  const admissionPolicy = existing ? { quoteMaxAgeMs: existing.quoteMaxAgeMs, minEv: existing.minEv,
    minPrudentialEv: existing.minPrudentialEv } : policy;
  await db.research.initializePortfolios();
  const baseline = baselineManifest();
  await db.research.saveModel({ family: 'A', version: baseline.version, artifact: baseline });
  const fixtures = (options.dataGatesPassed === false ? [] : await db.getUpcomingMatches({ nowIso: startedAt, untilIso: summary.windowEndAt, limit: 10000 }))
    .filter((row) => TOP5_COMPETITIONS.includes(row.competition));
  const claim = await db.research.claimNightlyBatch({ startedAt: summary.startedAt, windowEndAt: summary.windowEndAt,
    runId, leaseMs: options.leaseMs,
    quoteMaxAgeMs: admissionPolicy.quoteMaxAgeMs, minEv: admissionPolicy.minEv, minPrudentialEv: admissionPolicy.minPrudentialEv,
    fixtures: fixtures.map((row) => ({ matchId: row.match_id, kickoffAt: row.date })) });
  summary.runId = claim.run?.id ?? null;
  if (claim.busy || claim.alreadyCompleted) {
    reason(claim.busy ? 'nightly_run_busy' : 'nightly_run_already_completed');
    summary.endedAt = clock().toISOString(); return summary;
  }
  const run = claim.run, jobs = claim.jobs;
  // Retry of an interrupted workflow keeps the original policy and time window.
  summary.startedAt = run.startedAt; summary.windowEndAt = run.windowEndAt;
  const effectivePolicy = { ...policy, quoteMaxAgeMs: run.quoteMaxAgeMs, minEv: run.minEv, minPrudentialEv: run.minPrudentialEv };
  let history: Promise<any[]> | undefined;
  const runtimeDb = Object.create(db) as RuntimeDb;
  runtimeDb.getMatches = (...args: Parameters<RuntimeDb['getMatches']>) => history ??= db.getMatches(...args);
  let preparer = options.preparer;
  let leaseLost = false;
  let renewal: Promise<void> | undefined;
  const renew = setInterval(() => {
    if (renewal) return;
    renewal = db.research.renewNightlyLease(run.id, run.leaseToken, options.leaseMs).then((owned) => { if (!owned) leaseLost = true; })
      .catch(() => { leaseLost = true; }).finally(() => { renewal = undefined; });
  }, Math.min(45000, Math.max(250, (options.leaseMs ?? 180000) / 3)));
  // The finite CLI job owns this handle until finally clears it. Unref would
  // allow Node to exit while preparation still awaits asynchronous work.
  try {
    if (options.dataGatesPassed === false) { reason('required_data_gates_failed'); throw new Error('required_data_gates_failed'); }
    summary.settlement = await settleResearchBets(db);
    summary.prospectiveEvidence = { ...await settleProspectiveEvidence(db, clock), frozen: 0 };
    for (const skipped of claim.skipped ?? []) {
      if (!['decision_already_recorded', 'bet_already_recorded'].includes(skipped.reason)) summary.skippedMatches++;
      reason(skipped.reason);
    }
    const previous = (await db.research.listNightlyRuns(30)).find((entry: any) => entry.id !== run.id && entry.status === 'COMPLETED');
    const missedFrom = previous?.windowEndAt ?? previousNightlyBoundary(new Date(startedAt), policy.hour, policy.minute).toISOString();
    if (Date.parse(missedFrom) < Date.parse(startedAt)) {
      const all = await runtimeDb.getMatches();
      // A retry can occur after a fixture already received its immutable BET or
      // ABSTAIN in the first attempt. Its elapsed kickoff is not a missed decision.
      const previousJobs = await db.research.listJobs();
      const decided = new Set(previousJobs.filter((job) => ['COMPLETED', 'SKIPPED'].includes(job.status)).map((job) => job.matchId));
      for (const job of previousJobs.filter((entry) => entry.mode === 'NIGHTLY' && entry.status === 'SKIPPED'
        && Date.parse(entry.kickoffAt) >= Date.parse(missedFrom) && Date.parse(entry.kickoffAt) < Date.parse(startedAt))) {
        summary.skippedMatches++; reason(job.reason ?? 'previously_skipped');
      }
      summary.missedMatches = all.filter((row) => TOP5_COMPETITIONS.includes(row.competition)
        && !decided.has(row.match_id) && Date.parse(row.date) >= Date.parse(missedFrom) && Date.parse(row.date) < Date.parse(startedAt)).length;
      if (summary.missedMatches) reason('missed_nightly_interval');
    }
    if (jobs.length) preparer ??= new ResearchRuntime(runtimeDb, { clock, nightly: effectivePolicy });
    const prepared: PreparedT15Job[] = [];
    for (const job of jobs) {
      if (leaseLost) throw new Error('nightly_lease_lost');
      if (clock().getTime() >= Date.parse(job.kickoffAt)) {
        summary.missedMatches++; reason('match_started');
        await db.research.finishJob(job.id, job.leaseToken, { status: 'MISSED', reason: 'match_started' }); continue;
      }
      summary.analyzedMatches++;
      try {
        const result = await preparer!.prepareNightly(job);
        if (result.job.id !== job.id || result.job.leaseToken !== job.leaseToken || result.job.matchId !== job.matchId) throw new Error('nightly_job_identity_mismatch');
        if (result.status !== 'upcoming' || Date.parse(result.kickoffAt) !== Date.parse(job.kickoffAt)) {
          const code = Date.parse(result.kickoffAt) !== Date.parse(job.kickoffAt) ? 'kickoff_changed' : `fixture_${result.status}`;
          summary.skippedMatches++; reason(code);
          await db.research.finishJob(job.id, job.leaseToken, { status: 'SKIPPED', reason: code }); continue;
        }
        result.inputSnapshot = { ...(result.inputSnapshot as object), mode: 'NIGHTLY', runId: run.id,
          windowStartAt: run.startedAt, windowEndAt: run.windowEndAt,
          prospectiveObservations: Array.isArray(result.prospectiveObservations) ? result.prospectiveObservations : [] };
        prepared.push(result);
      } catch (error) {
        const code = safeOddsFailureCode(error);
        const policySkip = code !== null && ['odds_credit_budget_exhausted', 'odds_cache_only', 'odds_reset_unconfirmed'].includes(code);
        summary.skippedMatches++; reason(code ?? 'preparation_failed');
        if (!policySkip) { summary.errors++; summary.apiErrors += code ? 1 : 0; }
        await db.research.finishJob(job.id, job.leaseToken, { status: policySkip ? 'SKIPPED' : 'RETRY', reason: code ?? 'preparation_failed' });
      }
    }
    const admissible: PreparedT15Job[] = [];
    for (const item of prepared) {
      if (clock().getTime() >= Date.parse(item.kickoffAt)) {
        summary.missedMatches++; reason('match_started');
        await db.research.finishJob(item.job.id, item.job.leaseToken, { status: 'MISSED', reason: 'match_started' }); continue;
      }
      item.decisions = item.decisions.map((decision) => {
        const invalid = decision.action === 'BET' ? nightlyQuoteReason(item.quotes[Number(decision.quoteIndex)], clock().getTime(), effectivePolicy.quoteMaxAgeMs) : null;
        return invalid ? { ...decision, action: 'ABSTAIN', reason: invalid } : decision;
      });
      admissible.push(item);
    }
    if (leaseLost) throw new Error('nightly_lease_lost');
    const committed = await db.research.commitBatch(admissible.map((item) => ({ jobId: item.job.id,
      leaseToken: item.job.leaseToken, inputSnapshot: item.inputSnapshot as Record<string, any>,
      observations: Array.isArray(item.prospectiveObservations) ? item.prospectiveObservations : [],
      decisions: item.decisions.map((decision) => ({ ...decision, market: String(decision.market ?? '') })) })), clock());
    summary.registeredBets = committed.bets.length;
    for (const item of admissible) {
      if (!committed.bets.some((bet: any) => bet.matchId === item.job.matchId)) summary.skippedMatches++;
    }
    for (const decision of committed.decisions) if (decision.action === 'ABSTAIN') reason(decision.reason ?? 'model_abstained');
    const totals = await db.research.getNightlyRunMetrics(run.id);
    summary.registeredBets = totals.registeredBets;
    summary.prospectiveEvidence.frozen = await db.research.countNightlyProspectiveObservations(run.id);
    summary.analyzedMatches = Math.max(summary.analyzedMatches, run.summary?.analyzedMatches ?? 0, totals.analyzedMatches);
    summary.skippedMatches = Math.max(summary.skippedMatches, totals.abstainedMatches);
    Object.assign(summary.reasonCounts, totals.reasonCounts);
    summary.quota = preparer?.getQuotaStatus() ?? null;
  } catch {
    summary.errors++; reason('nightly_execution_failed');
  } finally {
    clearInterval(renew); await renewal;
    if (leaseLost && !summary.errors) { summary.errors++; reason('nightly_lease_lost'); }
    summary.endedAt = clock().toISOString();
    await db.research.finishNightlyRun(run.id, run.leaseToken, { status: summary.errors ? 'ERROR' : 'COMPLETED', summary });
    await db.saveSchedulerRun({ schedulerName: 'research_nightly', trigger: 'github_actions', startedAt: summary.startedAt,
      endedAt: summary.endedAt, success: summary.errors === 0, summary,
      ...(summary.errors ? { error: 'research_nightly_failed' } : {}) });
    if (db.researchMonitoring && db.listRecentSchedulerRuns) {
      await reconcileResearchMonitoring({ research: db.research, researchMonitoring: db.researchMonitoring,
        listRecentSchedulerRuns: db.listRecentSchedulerRuns.bind(db),
        listRecentSchedulerRunsByName: db.listRecentSchedulerRunsByName?.bind(db) }, clock(), { schedulerEnabled: true });
    }
  }
  return summary;
}
