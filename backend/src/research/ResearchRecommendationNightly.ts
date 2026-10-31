import { TOP5_COMPETITIONS } from './ForecastCore';
import type { DatabaseService } from '../db/DatabaseService';
import { loadNightlyPolicy, nextNightlyBoundary, NightlyPolicy, NightlySummary, runResearchNightly } from './ResearchNightly';
import { ResearchRuntime } from './ResearchRuntime';
import { ResearchRecommendationRuntime } from './ResearchRecommendationRuntime';
import { VIRTUAL_RECOMMENDATION_POLICY, ChallengerExecutionState, challengerExecutionPolicy, fallbackChallengerState, unavailableChallengerState } from './ResearchRecommendationPolicy';
import type { RecommendationCommit, RecommendationJob, RecommendationPolicyDescriptor } from './ResearchRecommendationStore';
import { TECHNICAL_RECOVERY_PROTOCOL, TECHNICAL_RECOVERY_REASONS, TechnicalRecoveryPlan } from './ResearchRecommendationRecovery';
import { researchHash } from './ResearchStore';
import { safeOddsFailureCode } from './T15Scheduler';
import { reconcileResearchMonitoring } from './ResearchMonitoring';

type DiagnosticOptions = Parameters<typeof runResearchNightly>[1];
type RecommendationDb = DatabaseService;
type RecommendationPreparer = Pick<ResearchRecommendationRuntime, 'beginCohort' | 'prepare' | 'getQuotaStatus'>;
export type RecommendationNightlySummary = NightlySummary & {
  protocol: string; policyHash: string; diagnosticRunId: string | null; decisionCount: number;
  challengerAdoptionErrors?: number; challengerCollectionErrors?: number; deploymentC?: ChallengerExecutionState;
  retryableMatches?: number;
  recoveryOf?: string; recoveryTargetCount?: number;
};
const RETRYABLE_ODDS_REASONS = new Set(['odds_credit_budget_exhausted', 'odds_cache_only', 'odds_reset_unconfirmed']);
const technicalQuotePair = (decisions: RecommendationCommit['decisions']): boolean => decisions.length === 2
  && decisions.map((decision) => decision.family).sort().join(',') === 'A,C'
  && decisions.every((decision) => decision.action === 'ABSTAIN' && RETRYABLE_ODDS_REASONS.has(decision.reason ?? ''));
type Options = {
  policy?: NightlyPolicy; clock?: () => Date; runId?: string; leaseMs?: number; dataGatesPassed?: boolean;
  diagnosticPreparer?: DiagnosticOptions['preparer']; researchRuntime?: ResearchRuntime; runtime?: RecommendationPreparer;
  technicalRecovery?: TechnicalRecoveryPlan;
};

function validateTechnicalRecovery(plan: TechnicalRecoveryPlan, base: RecommendationPolicyDescriptor,
  now: Date, normalEndAt: string, boundary: Date): void {
  const timestamp = (value: unknown) => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
  const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const validId = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  const fail = () => { throw new Error('technical_recovery_plan_invalid'); };
  if (!plan || plan.protocol !== TECHNICAL_RECOVERY_PROTOCOL || plan.parentPolicyHash !== researchHash(base)
    || !plan.policy || !plan.policyHash || plan.policyHash === plan.parentPolicyHash
    || !validHash(plan.policyHash) || researchHash(plan.policy) !== plan.policyHash) fail();
  const { recovery, ...unchanged } = plan.policy!;
  if (!recovery || researchHash(unchanged) !== researchHash(base) || recovery.protocol !== TECHNICAL_RECOVERY_PROTOCOL
    || recovery.reason !== 'retry_technical_failure' || recovery.parentPolicyHash !== plan.parentPolicyHash
    || recovery.retrospective !== false || recovery.maxDepth !== 1
    || researchHash(recovery.allowedReasons) !== researchHash(TECHNICAL_RECOVERY_REASONS)
    || researchHash(recovery.sources) !== researchHash(plan.sources)) fail();
  const planned = timestamp(plan.plannedAt), end = timestamp(plan.windowEndAt), at = now.getTime();
  if (![planned, end, at, timestamp(normalEndAt)].every(Number.isFinite) || planned > at || at >= end
    || end > timestamp(normalEndAt) || end > boundary.getTime() || !Array.isArray(plan.sources)
    || !plan.sources.length || plan.sources.length > 100 || !Array.isArray(plan.fixtures)
    || plan.fixtures.length !== plan.sources.length) fail();
  const identities: string[] = [], matchIds: string[] = [], decisionIds: string[] = [];
  for (let index = 0; index < plan.sources.length; index++) {
    const source = plan.sources[index], fixture = plan.fixtures[index];
    if (!source || !fixture || !validId(source.matchId) || fixture.matchId !== source.matchId
      || timestamp(fixture.kickoffAt) !== timestamp(source.kickoffAt) || !Number.isFinite(timestamp(source.kickoffAt))
      || timestamp(source.kickoffAt) <= at || timestamp(source.kickoffAt) > end || timestamp(source.windowEndAt) !== end
      || ![source.sourceInputHash, source.sourcePreparedDecisionsHash, source.sourceDecisionSnapshotsHash].every(validHash)
      || !Array.isArray(source.sourceDecisionIds) || source.sourceDecisionIds.length !== 2
      || !source.originDecisionIds || Object.keys(source.originDecisionIds).sort().join(',') !== 'A,C'
      || !source.reasons || Object.keys(source.reasons).sort().join(',') !== 'A,C'
      || !Object.values(source.reasons).every((code) => RETRYABLE_ODDS_REASONS.has(code))) fail();
    const ids = [source.sourceJobId, source.sourceRunId, source.sourceInputId, source.originInputId,
      ...source.sourceDecisionIds, source.originDecisionIds.A, source.originDecisionIds.C];
    if (!ids.every(validId)) fail();
    identities.push(source.sourceJobId, source.sourceInputId, source.originInputId,
      ...source.sourceDecisionIds, source.originDecisionIds.A, source.originDecisionIds.C);
    matchIds.push(source.matchId); decisionIds.push(...source.sourceDecisionIds);
  }
  if (new Set(matchIds).size !== matchIds.length || new Set(identities).size !== identities.length
    || researchHash(recovery.matchIds) !== researchHash(matchIds)
    || researchHash(recovery.sourceDecisionIds) !== researchHash(decisionIds.sort())) fail();
}

/** Diagnostic origins remain immutable; only the separately versioned policy can allocate virtual funds. */
export async function runRecommendationNightly(db: RecommendationDb, options: Options = {}): Promise<RecommendationNightlySummary> {
  const policy = options.policy ?? loadNightlyPolicy(), clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const windowEndAt = policy.windowHours ? new Date(Date.parse(startedAt) + policy.windowHours * 3600000).toISOString()
    : nextNightlyBoundary(new Date(startedAt), policy.hour, policy.minute).toISOString();
  const runId = options.runId ?? `nightly:${nextNightlyBoundary(new Date(startedAt), policy.hour, policy.minute).toISOString()}`;
  const summary: RecommendationNightlySummary = { mode: 'NIGHTLY', enabled: policy.enabled, runId, startedAt,
    endedAt: null, windowEndAt, analyzedMatches: 0, registeredBets: 0, skippedMatches: 0, missedMatches: 0,
    errors: 0, apiErrors: 0, settlement: { checked: 0, settled: 0, unresolved: 0 }, quota: null, reasonCounts: {},
    protocol: VIRTUAL_RECOMMENDATION_POLICY.version, policyHash: researchHash(VIRTUAL_RECOMMENDATION_POLICY),
    diagnosticRunId: null, decisionCount: 0 };
  const reason = (code: string) => { summary.reasonCounts[code] = (summary.reasonCounts[code] ?? 0) + 1; };
  if (!policy.enabled) { reason('nightly_disabled'); summary.endedAt = clock().toISOString(); return summary; }
  if (process.env.RESEARCH_T15_SCHEDULER_ENABLED === 'true') throw new Error('Conflicting automatic research schedulers');
  let deploymentC = fallbackChallengerState();
  let executionPolicy: RecommendationPolicyDescriptor = challengerExecutionPolicy(deploymentC);
  let sharedRuntime = options.researchRuntime;
  const diagnosticPreparer = options.diagnosticPreparer ?? {
    prepareNightly: (job: Parameters<ResearchRuntime['prepareNightly']>[0]) => {
      sharedRuntime ??= new ResearchRuntime(db, { clock, nightly: policy,
        candidateVersionC: deploymentC.deployment.modelVersion, deploymentC: deploymentC.deployment });
      return sharedRuntime.prepareNightly(job);
    },
    getQuotaStatus: () => sharedRuntime?.getQuotaStatus() ?? null,
  };
  let runtime = options.runtime, renewal: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let leaseLost = false;
  const outstanding = new Map<string, RecommendationJob>();
  const finish = async (job: RecommendationJob, status: 'SKIPPED' | 'ERROR', code: string) => {
    await db.recommendations.finishJob(job.id, job.leaseToken, { status, reason: code });
    outstanding.delete(job.id);
  };
  const renew = async () => {
    if (!outstanding.size) return;
    if (!await db.recommendations.renewLeases([...outstanding.values()], options.leaseMs)) leaseLost = true;
  };
  try {
    if (db.challengerAdoption && options.dataGatesPassed !== false) {
      try {
        await db.challengerAdoption.reviewCandidates();
      } catch {
        summary.errors++; summary.challengerAdoptionErrors = 1; reason('challenger_adoption_review_failed');
        try {
          await db.saveSchedulerRun({ schedulerName: 'research_challenger_adoption', trigger: 'github_actions',
            startedAt, endedAt: clock().toISOString(), success: false, error: 'challenger_adoption_review_failed' });
        } catch { reason('challenger_adoption_error_recording_failed'); }
      }
      try {
        const state = await db.challengerAdoption.getState();
        deploymentC = Object.freeze({ ...state, deployment: Object.freeze({ ...state.deployment }) });
      } catch {
        deploymentC = unavailableChallengerState();
        summary.errors++; summary.challengerAdoptionErrors = (summary.challengerAdoptionErrors ?? 0) + 1;
        reason('adoption_state_unavailable');
      }
    }
    executionPolicy = challengerExecutionPolicy(deploymentC);
    if (options.technicalRecovery) {
      validateTechnicalRecovery(options.technicalRecovery, executionPolicy, clock(), windowEndAt,
        nextNightlyBoundary(clock(), policy.hour, policy.minute));
      summary.recoveryOf = options.technicalRecovery.parentPolicyHash;
      summary.recoveryTargetCount = options.technicalRecovery.fixtures.length;
      executionPolicy = options.technicalRecovery.policy!;
    }
    summary.protocol = executionPolicy.version; summary.policyHash = researchHash(executionPolicy);
    if (deploymentC.source !== 'fallback') summary.deploymentC = deploymentC;
    sharedRuntime?.pinChallengerDeployment(deploymentC.deployment);
    const diagnostic = await runResearchNightly(db, { policy, clock, runId, leaseMs: options.leaseMs,
      dataGatesPassed: options.dataGatesPassed, preparer: diagnosticPreparer, diagnosticOnly: true });
    summary.diagnosticRunId = diagnostic.runId;
    summary.windowEndAt = diagnostic.windowEndAt;
    if (options.technicalRecovery) {
      if (Date.parse(options.technicalRecovery.windowEndAt!) > Date.parse(diagnostic.windowEndAt)) throw new Error('technical_recovery_window_widened');
      summary.windowEndAt = options.technicalRecovery.windowEndAt!;
    }
    summary.settlement = diagnostic.settlement;
    summary.prospectiveEvidence = diagnostic.prospectiveEvidence;
    summary.missedMatches = diagnostic.missedMatches;
    summary.quota = diagnostic.quota;
    summary.apiErrors = diagnostic.apiErrors;
    summary.diagnosticPreparationErrors = diagnostic.diagnosticPreparationErrors ?? 0;
    summary.errors += diagnostic.errors;
    if (summary.diagnosticPreparationErrors) summary.reasonCounts.diagnostic_preparation_failed = summary.diagnosticPreparationErrors;
    // Failed research inference must not veto A. Only failures with safely stored
    // unavailable diagnostic origins can continue to the independent model engines.
    if (options.dataGatesPassed === false || diagnostic.errors > summary.diagnosticPreparationErrors
      || diagnostic.reasonCounts.nightly_run_busy || diagnostic.reasonCounts.nightly_execution_failed
      || diagnostic.reasonCounts.nightly_lease_lost) {
      reason(options.dataGatesPassed === false ? 'required_data_gates_failed' : 'diagnostic_stage_failed');
      throw new Error('recommendation_diagnostic_failed');
    }
    const registered = await db.recommendations.registerPolicy(executionPolicy);
    if (registered.hash !== summary.policyHash) throw new Error('recommendation_policy_identity_invalid');
    const now = clock().toISOString();
    let fixtures = (await db.getUpcomingMatches({ nowIso: now, untilIso: summary.windowEndAt, limit: 10000 }))
      .filter((row) => TOP5_COMPETITIONS.includes(row.competition) && row.home_goals == null && row.away_goals == null
        && Date.parse(row.date) > Date.parse(now) && Date.parse(row.date) <= Date.parse(summary.windowEndAt));
    if (options.technicalRecovery) {
      const allowed = new Map(options.technicalRecovery.fixtures.map((fixture) => [fixture.matchId, fixture]));
      fixtures = fixtures.filter((row) => allowed.has(row.match_id) && Date.parse(row.date) === Date.parse(allowed.get(row.match_id)!.kickoffAt));
      for (const requested of options.technicalRecovery.fixtures) if (!fixtures.some((row) => row.match_id === requested.matchId)) {
        summary.skippedMatches++; reason('recovery_fixture_no_longer_eligible');
      }
    }
    const claim = await db.recommendations.claimBatch({ policyHash: summary.policyHash, runId,
      windowStartAt: startedAt, windowEndAt: summary.windowEndAt, leaseMs: options.leaseMs,
      fixtures: fixtures.map((row) => ({ matchId: row.match_id, kickoffAt: row.date })) });
    for (const skipped of claim.skipped) { summary.skippedMatches++; reason(skipped.reason); }
    for (const job of claim.jobs) outstanding.set(job.id, job);
    if (options.technicalRecovery) for (const job of claim.jobs) {
      const source = options.technicalRecovery.sources.find((entry) => entry.matchId === job.matchId);
      if (!source || job.originInputId !== source.originInputId || researchHash(job.originDecisionIds) !== researchHash(source.originDecisionIds)) {
        throw new Error('technical_recovery_origin_mismatch');
      }
    }
    if (claim.busy || claim.skipped.some((item) => item.reason === 'execution_lease_active')) throw new Error('recommendation_execution_busy');
    if (claim.jobs.length) {
      if (!runtime) {
        sharedRuntime ??= new ResearchRuntime(db, { clock, nightly: policy,
          candidateVersionC: deploymentC.deployment.modelVersion, deploymentC: deploymentC.deployment });
        runtime = new ResearchRecommendationRuntime(db, { clock, researchRuntime: sharedRuntime, deploymentC });
      }
      runtime.beginCohort(runId, deploymentC);
      timer = setInterval(() => {
        if (renewal) return;
        renewal = renew().catch(() => { leaseLost = true; }).finally(() => { renewal = undefined; });
      }, Math.min(45000, Math.max(250, (options.leaseMs ?? 180000) / 3)));
    }
    const prepared: RecommendationCommit[] = [];
    for (const job of claim.jobs) {
      if (leaseLost) throw new Error('recommendation_lease_lost');
      if (clock().getTime() >= Date.parse(job.kickoffAt)) {
        summary.missedMatches++; reason('match_started'); await finish(job, 'SKIPPED', 'match_started'); continue;
      }
      try {
        const item = await runtime!.prepare(job);
        if (item.jobId !== job.id || item.leaseToken !== job.leaseToken || item.originInputId !== job.originInputId) {
          throw new Error('recommendation_job_identity_invalid');
        }
        if (options.technicalRecovery) item.inputSnapshot = { ...item.inputSnapshot,
          metadata: { ...item.inputSnapshot.metadata, policy: executionPolicy, technicalRecovery: {
            protocol: TECHNICAL_RECOVERY_PROTOCOL, parentPolicyHash: options.technicalRecovery.parentPolicyHash,
            source: options.technicalRecovery.sources.find((entry) => entry.matchId === job.matchId),
          } } };
        if (deploymentC.resolutionUnavailable) item.decisions = item.decisions.map((decision) => decision.family === 'C'
          ? { ...decision, modelVersion: 'C-unavailable', action: 'ABSTAIN', reason: 'adoption_state_unavailable',
            recommended: false, validated: false } : decision);
        const failures = item.inputSnapshot.metadata?.challengerCollection?.failures;
        if (Array.isArray(failures) && failures.length) {
          summary.errors += failures.length;
          summary.challengerCollectionErrors = (summary.challengerCollectionErrors ?? 0) + failures.length;
          summary.reasonCounts.challenger_collection_failed = (summary.reasonCounts.challenger_collection_failed ?? 0) + failures.length;
        }
        const challengerErrors = item.inputSnapshot.metadata?.challengerErrors;
        if (Array.isArray(challengerErrors) && challengerErrors.length) {
          summary.errors += challengerErrors.length; reason('challenger_health_recording_failed');
        }
        if (technicalQuotePair(item.decisions)) {
          const codes = [...new Set(item.decisions.map((decision) => decision.reason!))];
          summary.errors++; summary.skippedMatches++;
          summary.retryableMatches = (summary.retryableMatches ?? 0) + 1;
          codes.forEach(reason);
          await finish(job, 'ERROR', codes[0]);
          continue;
        }
        prepared.push(item);
      } catch (error) {
        const code = safeOddsFailureCode(error);
        const retryable = code !== null && RETRYABLE_ODDS_REASONS.has(code);
        summary.skippedMatches++; reason(code ?? 'recommendation_preparation_failed');
        summary.errors++;
        if (retryable) summary.retryableMatches = (summary.retryableMatches ?? 0) + 1;
        else summary.apiErrors += code ? 1 : 0;
        await finish(job, 'ERROR', code ?? 'recommendation_preparation_failed');
      }
    }
    if (timer) clearInterval(timer);
    await renewal;
    await renew();
    if (leaseLost) throw new Error('recommendation_lease_lost');
    // The store checks actual time, fresh shared prices, kickoff and exposure again in the transaction.
    await db.recommendations.commitBatch(prepared, clock());
    outstanding.clear();
    summary.quota = runtime?.getQuotaStatus() ?? summary.quota;
  } catch {
    summary.errors++; reason('recommendation_execution_failed');
  } finally {
    if (timer) clearInterval(timer);
    await renewal;
    for (const job of outstanding.values()) {
      try { await finish(job, 'ERROR', 'recommendation_execution_failed'); } catch { /* Expired or replaced leases cannot be released by this owner. */ }
    }
    const totals = await db.recommendations.getRunMetrics(runId, summary.policyHash);
    summary.analyzedMatches = totals.analyzedMatches;
    summary.registeredBets = totals.registeredBets;
    summary.decisionCount = totals.decisionCount;
    summary.skippedMatches = Math.max(summary.skippedMatches, totals.abstainedMatches);
    Object.assign(summary.reasonCounts, totals.reasonCounts);
    summary.endedAt = clock().toISOString();
    await db.saveSchedulerRun({ schedulerName: 'research_nightly', trigger: 'github_actions', startedAt,
      endedAt: summary.endedAt, success: summary.errors === 0, summary,
      ...(summary.errors ? { error: 'research_recommendation_nightly_failed' } : {}) });
    if (db.researchMonitoring && db.listRecentSchedulerRuns) {
      await reconcileResearchMonitoring({ research: db.research, researchMonitoring: db.researchMonitoring,
        listRecentSchedulerRuns: db.listRecentSchedulerRuns.bind(db),
        listRecentSchedulerRunsByName: db.listRecentSchedulerRunsByName?.bind(db) }, clock(), { schedulerEnabled: true });
    }
  }
  return summary;
}
