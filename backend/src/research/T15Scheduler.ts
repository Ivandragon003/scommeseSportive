/** Remote, persistent-job orchestration. The store owns atomic admission and leases. */
export const T15_LEAD_TIME_MS = 15 * 60 * 1000;
export const T15_EXECUTION_TOLERANCE_MS = 60 * 1000;
export const T15_QUOTE_MAX_AGE_MS = 5 * 60 * 1000;
export const T15_POLL_INTERVAL_MS = 15 * 1000;

export type T15Job = {
  id: string;
  matchId: string;
  kickoffAt: string;
  targetAt: string;
  leaseToken: string;
  [key: string]: unknown;
};

export type T15QuoteEvidence = {
  odds: number;
  capturedAt: string;
  updatedAt: string;
  bookmaker: string;
  source: string;
  [key: string]: unknown;
};

export type T15Decision = {
  family: 'A' | 'C';
  modelVersion: string;
  validated: boolean;
  marketState?: 'EXPERIMENTAL' | 'SHADOW' | 'ACTIVE' | 'SUSPENDED';
  score: number;
  quoteIndex?: number;
  action: 'BET' | 'ABSTAIN';
  reason?: string;
  challengerQuality?: {
    homeHistorySample: number | null; awayHistorySample: number | null;
    homeXgCoverage: number | null; awayXgCoverage: number | null;
    historyAvailableThrough: string | null; modelFitAt: string | null;
  };
  [key: string]: unknown;
};

export type PreparedT15Job = {
  job: T15Job;
  kickoffAt: string;
  status: 'upcoming' | 'postponed' | 'cancelled' | 'started' | 'finished' | 'unknown';
  quotes: T15QuoteEvidence[];
  inputSnapshot: unknown;
  decisions: T15Decision[];
  [key: string]: unknown;
};

export type T15Allocation = {
  jobId: string;
  matchId: string;
  family: 'A' | 'C';
  decisionIndex: number;
  score: number;
};

export type T15JobOutcome = {
  status: 'MISSED' | 'SKIPPED' | 'RETRY' | 'ERROR' | 'COMPLETED';
  reason: string;
};

export type T15SchedulerDependencies = {
  clock?: () => Date;
  /** Refresh official fixture information and persist schedule changes before claims. */
  synchronize: (nowIso: string) => Promise<void>;
  /** Must use persistent leases and include expired unprocessed jobs for missed logging. */
  claimDueJobs: (nowIso: string) => Promise<T15Job[]>;
  /** Obtain one common immutable input/odds snapshot and both model decisions. */
  prepare: (job: T15Job, nowIso: string) => Promise<PreparedT15Job>;
  /** Must atomically recheck the clock, lease, uniqueness, exposure and market gates. */
  commitBatch: (jobs: PreparedT15Job[], nowIso: string, order: T15Allocation[]) => Promise<unknown>;
  finishJob: (job: T15Job, outcome: T15JobOutcome, nowIso: string) => Promise<void>;
  recordError?: (details: { operation: string; matchId?: string; message: string; at: string }) => Promise<void> | void;
};

export type T15TickSummary = {
  at: string;
  busy: boolean;
  claimed: number;
  completed: number;
  missed: number;
  skipped: number;
  retried: number;
  errors: number;
  allocationOrder: T15Allocation[];
};

const timestamp = (value: string): number => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
  ? Date.parse(value) : Number.NaN;

/** Persist only classified policy codes, never a request URL or credential. */
export function safeOddsFailureCode(error: unknown): string | null {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  return typeof code === 'string' && /^odds_[a-z_]{1,64}$/.test(code) ? code : null;
}

export function t15TargetAt(kickoffAt: string): string {
  const kickoff = timestamp(kickoffAt);
  if (!Number.isFinite(kickoff)) throw new Error('Invalid kickoff timestamp');
  return new Date(kickoff - T15_LEAD_TIME_MS).toISOString();
}

export function quoteFreshnessReason(quote: T15QuoteEvidence | undefined, now: number): string | null {
  if (!quote || !String(quote.bookmaker ?? '').trim() || !String(quote.source ?? '').trim()) return 'real_quote_missing';
  if (!Number.isFinite(Number(quote.odds)) || Number(quote.odds) <= 1) return 'invalid_decimal_odds';
  if (/synthetic|estimated|model_completion|aggregate|unknown|fallback/i.test(String(quote.source))) return 'real_quote_required';
  for (const value of [quote.capturedAt, quote.updatedAt]) {
    const observedAt = timestamp(value);
    if (!Number.isFinite(observedAt)) return 'quote_timestamp_missing';
    if (observedAt > now) return 'quote_timestamp_future';
    if (now - observedAt > T15_QUOTE_MAX_AGE_MS) return 'quote_stale';
  }
  return null;
}

function jobWindowReason(job: T15Job, now: number): string | null {
  const kickoff = timestamp(job.kickoffAt);
  const target = timestamp(job.targetAt);
  if (!Number.isFinite(kickoff) || !Number.isFinite(target) || kickoff - target !== T15_LEAD_TIME_MS) return 'invalid_target';
  if (now >= kickoff) return 'match_started';
  if (now < target) return 'not_due';
  if (now > target + T15_EXECUTION_TOLERANCE_MS) return 'decision_window_missed';
  return null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Each portfolio has its own order; A's preferred match cannot bias C's allocation. */
export function buildT15AllocationOrder(jobs: PreparedT15Job[]): T15Allocation[] {
  return jobs.flatMap(({ job, decisions }) => decisions.flatMap((decision, decisionIndex) =>
    decision.action === 'BET' ? [{
      jobId: job.id, matchId: job.matchId, family: decision.family,
      decisionIndex, score: Number(decision.score),
    }] : [],
  )).sort((left, right) => left.family.localeCompare(right.family)
    || right.score - left.score || left.matchId.localeCompare(right.matchId));
}

export class T15Scheduler {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly clock: () => Date;

  constructor(private readonly dependencies: T15SchedulerDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  start(intervalMs = T15_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error('Invalid scheduler interval');
    const run = () => { void this.tick(); };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<T15TickSummary> {
    const summary: T15TickSummary = {
      at: this.clock().toISOString(), busy: this.running, claimed: 0,
      completed: 0, missed: 0, skipped: 0, retried: 0, errors: 0, allocationOrder: [],
    };
    if (this.running) return summary;
    this.running = true;
    try {
      await this.dependencies.synchronize(summary.at);
      const jobs = await this.dependencies.claimDueJobs(this.clock().toISOString());
      summary.claimed = jobs.length;
      const groups = new Map<string, T15Job[]>();
      for (const job of jobs) {
        const reason = jobWindowReason(job, this.clock().getTime());
        if (reason) {
          await this.finish(job, reason === 'not_due' ? 'RETRY' : 'MISSED', reason, summary);
          continue;
        }
        const canonicalTarget = new Date(timestamp(job.targetAt)).toISOString();
        const group = groups.get(canonicalTarget) ?? [];
        group.push(job);
        groups.set(canonicalTarget, group);
      }
      for (const [, group] of [...groups].sort(([a], [b]) => timestamp(a) - timestamp(b))) {
        await this.runGroup(group.sort((a, b) => a.matchId.localeCompare(b.matchId)), summary);
      }
    } catch (error) {
      summary.errors++;
      await this.report('tick', error);
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async runGroup(group: T15Job[], summary: T15TickSummary): Promise<void> {
    const prepared: PreparedT15Job[] = [];
    // Preparation can run concurrently, but allocation waits for the whole cohort.
    await Promise.all(group.map(async (job) => {
      try {
        const result = await this.dependencies.prepare(job, this.clock().toISOString());
        if (result.job.id !== job.id || result.job.matchId !== job.matchId || result.job.leaseToken !== job.leaseToken) {
          await this.finish(job, 'SKIPPED', 'job_identity_mismatch', summary);
          return;
        }
        if (timestamp(result.kickoffAt) !== timestamp(job.kickoffAt)) {
          await this.finish(job, 'RETRY', 'kickoff_changed', summary);
          return;
        }
        if (result.status !== 'upcoming') {
          // A temporarily missing event is not an official cancellation. Retry
          // verification only inside the original admission window.
          await this.finish(job, result.status === 'unknown' ? 'RETRY' : 'SKIPPED', `fixture_${result.status}`, summary);
          return;
        }
        const reason = jobWindowReason(job, this.clock().getTime());
        if (reason) {
          await this.finish(job, reason === 'not_due' ? 'RETRY' : 'MISSED', reason, summary);
          return;
        }
        const uniqueDecisions = new Map<string, T15Decision>();
        for (const decision of result.decisions) {
          if (decision.family !== 'A' && decision.family !== 'C') throw new Error('Unknown prediction family');
          if (uniqueDecisions.has(decision.family)) {
            uniqueDecisions.set(decision.family, {
              ...uniqueDecisions.get(decision.family)!, action: 'ABSTAIN', reason: 'duplicate_family_decision',
            });
          } else uniqueDecisions.set(decision.family, decision);
        }
        const decisions = [...uniqueDecisions.values()].map((decision): T15Decision => {
          if (decision.action !== 'BET') return { ...decision };
          let invalid: string | null = null;
          if (!decision.validated || !String(decision.modelVersion ?? '').trim()) invalid = 'model_not_validated';
          else if (decision.marketState && !['SHADOW', 'ACTIVE'].includes(decision.marketState)) invalid = 'market_not_shadow_enabled';
          else if (!Number.isFinite(Number(decision.score))) invalid = 'invalid_ranking_score';
          else if (!Number.isInteger(decision.quoteIndex) || Number(decision.quoteIndex) < 0) invalid = 'real_quote_missing';
          else invalid = quoteFreshnessReason(result.quotes[Number(decision.quoteIndex)], this.clock().getTime());
          return invalid ? { ...decision, action: 'ABSTAIN', reason: invalid } : { ...decision };
        });
        prepared.push({ ...result, job: { ...job }, decisions });
      } catch (error) {
        const oddsCode = safeOddsFailureCode(error);
        const transientOdds = ['odds_request_inflight_timeout', 'odds_transport_failed', 'odds_lease_lost'].includes(oddsCode ?? '');
        const policySkip = oddsCode !== null && !transientOdds;
        if (!policySkip) {
          summary.errors++;
          await this.report('prepare', error, job.matchId);
        }
        const reason = jobWindowReason(job, this.clock().getTime());
        await this.finish(job, reason && reason !== 'not_due' ? 'MISSED' : policySkip ? 'SKIPPED' : 'RETRY',
          reason ?? oddsCode ?? 'preparation_failed', summary);
      }
    }));

    const admissible: PreparedT15Job[] = [];
    for (const result of prepared) {
      const now = this.clock().getTime();
      const reason = jobWindowReason(result.job, now);
      if (reason) {
        await this.finish(result.job, reason === 'not_due' ? 'RETRY' : 'MISSED', reason, summary);
        continue;
      }
      // A quote can expire while another model/match is being prepared.
      result.decisions = result.decisions.map((decision) => {
        const staleReason = decision.action === 'BET'
          ? quoteFreshnessReason(result.quotes[Number(decision.quoteIndex)], now) : null;
        return staleReason ? { ...decision, action: 'ABSTAIN', reason: staleReason } : decision;
      });
      admissible.push(result);
    }
    if (!admissible.length) return;
    admissible.sort((a, b) => a.job.matchId.localeCompare(b.job.matchId));
    const order = buildT15AllocationOrder(admissible);
    const commitAt = this.clock().toISOString();
    try {
      await this.dependencies.commitBatch(deepFreeze(admissible), commitAt, deepFreeze(order));
      summary.completed += admissible.length;
      summary.allocationOrder.push(...order);
    } catch (error) {
      summary.errors++;
      await this.report('commit', error);
      // The transaction may have committed despite a lost response. Store uniqueness
      // and lease ownership decide on retry; the scheduler never assumes success.
      for (const result of admissible) {
        const reason = jobWindowReason(result.job, this.clock().getTime());
        await this.finish(result.job, reason && reason !== 'not_due' ? 'MISSED' : 'RETRY', reason ?? 'commit_unconfirmed', summary);
      }
    }
  }

  private async finish(job: T15Job, status: T15JobOutcome['status'], reason: string, summary: T15TickSummary): Promise<void> {
    try {
      await this.dependencies.finishJob(job, { status, reason }, this.clock().toISOString());
      if (status === 'MISSED') summary.missed++;
      else if (status === 'RETRY') summary.retried++;
      else summary.skipped++;
    } catch (error) {
      summary.errors++;
      await this.report('finish', error, job.matchId);
    }
  }

  private async report(operation: string, error: unknown, matchId?: string): Promise<void> {
    try {
      await this.dependencies.recordError?.({
        operation, matchId, message: error instanceof Error ? error.message : String(error),
        at: this.clock().toISOString(),
      });
    } catch {
      // Observability must not turn one failed operation into an unhandled rejection.
    }
  }
}
