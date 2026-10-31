import { researchHash, researchJson } from './ResearchStore';
import { VIRTUAL_RECOMMENDATION_POLICY } from './ResearchRecommendationPolicy';
import type { RecommendationPolicyDescriptor } from './ResearchRecommendationStore';

export const TECHNICAL_RECOVERY_REASONS = [
  'odds_credit_budget_exhausted', 'odds_cache_only', 'odds_reset_unconfirmed',
] as const;
export const TECHNICAL_RECOVERY_PROTOCOL = 'virtual-recommendation-technical-recovery-v1';

type Family = 'A' | 'C';
type OriginDecision = { id: string; inputId: string; family: Family; portfolioId: string };
type ExecutionDecision = OriginDecision & {
  originDecisionId: string; modelVersion: string; action: string; reason: string | null;
  snapshot: Record<string, any>;
};
export type ExistingTechnicalRecovery = {
  jobId: string; status: string; inputId: string | null;
  sourceJobId: string; sourceInputId: string; parentPolicyHash: string;
  leaseExpiresAt?: string | null;
};
export type TechnicalRecoveryRecord = {
  match: { matchId: string; kickoffAt: string; homeGoals: number | null; awayGoals: number | null };
  policy: { hash: string; descriptor: RecommendationPolicyDescriptor };
  job: { id: string; matchId: string; policyHash: string; runId: string; status: string;
    kickoffAt: string; windowStartAt: string; windowEndAt: string; claimedAt: string };
  input: { id: string; jobId: string; originInputId: string; inputHash: string; decisionsHash: string;
    capturedAt: string; kickoffAt: string; snapshot: Record<string, any> };
  decisions: ExecutionDecision[];
  originJob: { id: string; matchId: string };
  originInput: { id: string; jobId: string };
  originDecisions: OriginDecision[];
  /** Required explicit result of the current per-match A/C bet lookup. */
  existingBets: Array<{ id: string; portfolioId: string }>;
  /** All recovery children of this source, regardless of child policy hash or outcome. */
  existingRecoveries: ExistingTechnicalRecovery[];
};
export type TechnicalRecoverySource = {
  matchId: string; kickoffAt: string; windowEndAt: string; sourceJobId: string; sourceRunId: string;
  sourceInputId: string; sourceInputHash: string; sourcePreparedDecisionsHash: string;
  sourceDecisionIds: string[]; sourceDecisionSnapshotsHash: string;
  originInputId: string; originDecisionIds: { A: string; C: string };
  reasons: { A: string; C: string };
};
export type TechnicalRecoveryPlan = {
  protocol: typeof TECHNICAL_RECOVERY_PROTOCOL; plannedAt: string; parentPolicyHash: string;
  policy: RecommendationPolicyDescriptor | null; policyHash: string | null; windowEndAt: string | null;
  fixtures: Array<{ matchId: string; kickoffAt: string }>;
  sources: TechnicalRecoverySource[]; excluded: Array<{ matchId: string; reason: string }>;
};

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): number => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
  ? Date.parse(value) : NaN;
const copy = <T>(value: T): T => JSON.parse(researchJson(value));

function currentPolicyReason(policy: RecommendationPolicyDescriptor): string | null {
  if (!object(policy) || !['virtual-recommendation-v2', 'virtual-recommendation-v3'].includes(policy.version)) return 'unsupported_parent_policy';
  // Recovery is one bounded append-only attempt, never a recursively expanded policy.
  if (Object.prototype.hasOwnProperty.call(policy, 'recovery')) return 'recovery_ancestry_not_supported';
  const core = { ...policy, version: VIRTUAL_RECOMMENDATION_POLICY.version, familyC: VIRTUAL_RECOMMENDATION_POLICY.familyC };
  if (researchHash(core) !== researchHash(VIRTUAL_RECOMMENDATION_POLICY)) return 'parent_execution_configuration_changed';
  if (!object(policy.familyC) || policy.familyC.source !== VIRTUAL_RECOMMENDATION_POLICY.familyC.source
    || policy.familyC.stakeMode !== VIRTUAL_RECOMMENDATION_POLICY.familyC.stakeMode
    || policy.familyC.marketCalibration !== false || policy.familyC.marketBlending !== false) return 'parent_execution_configuration_changed';
  if (policy.version === 'virtual-recommendation-v2'
    && researchHash(policy.familyC) !== researchHash(VIRTUAL_RECOMMENDATION_POLICY.familyC)) return 'parent_execution_configuration_changed';
  return null;
}

function priorRecoveryReason(record: TechnicalRecoveryRecord, parentPolicyHash: string, now: number): string | null {
  if (!Array.isArray(record.existingRecoveries)) return 'existing_recovery_evidence_missing';
  if (record.existingRecoveries.length > 100) return 'existing_recovery_evidence_invalid';
  const jobs = new Set<string>();
  let preserved = false, active = false;
  for (const recovery of record.existingRecoveries) {
    if (!object(recovery) || !id(recovery.jobId) || recovery.jobId === record.job.id || jobs.has(recovery.jobId)
      || !['CLAIMED', 'COMPLETED', 'SKIPPED', 'ERROR'].includes(recovery.status)
      || !(recovery.inputId === null || id(recovery.inputId)) || recovery.inputId === record.input.id
      || recovery.leaseExpiresAt != null && !Number.isFinite(time(recovery.leaseExpiresAt))) return 'existing_recovery_evidence_invalid';
    jobs.add(recovery.jobId);
    if (recovery.sourceJobId !== record.job.id || recovery.sourceInputId !== record.input.id
      || recovery.parentPolicyHash !== parentPolicyHash) return 'existing_recovery_origin_mismatch';
    if (['COMPLETED', 'SKIPPED'].includes(recovery.status) || recovery.inputId !== null) preserved = true;
    else if (recovery.status === 'CLAIMED') {
      const expiry = time(recovery.leaseExpiresAt);
      if (!Number.isFinite(expiry)) return 'existing_recovery_evidence_invalid';
      if (expiry > now) active = true;
    }
  }
  return preserved ? 'prior_recovery_preserved' : active ? 'prior_recovery_in_progress' : null;
}

function sourceReason(record: TechnicalRecoveryRecord, parentPolicyHash: string, now: number): string | null {
  if (!object(record) || !object(record.match) || !object(record.job) || !object(record.policy)
    || !object(record.input) || !object(record.originInput) || !object(record.originJob)) return 'invalid_recovery_record';
  const { match, job, policy, input, decisions, originInput, originJob, originDecisions } = record;
  if (!id(match.matchId) || !id(job.id) || !id(job.runId) || !id(input.id) || !id(originInput.id) || !id(originJob.id)) return 'invalid_record_identity';
  if (job.status !== 'COMPLETED') return 'source_job_not_completed';
  if (!object(policy.descriptor) || !hash(policy.hash) || researchHash(policy.descriptor) !== policy.hash
    || policy.hash !== job.policyHash) return 'source_policy_identity_mismatch';
  if (Object.prototype.hasOwnProperty.call(policy.descriptor, 'recovery')) return 'recovery_ancestry_not_supported';
  if (policy.hash !== parentPolicyHash) return 'source_policy_not_current';
  if (match.matchId !== job.matchId || originJob.matchId !== job.matchId || originInput.jobId !== originJob.id
    || input.jobId !== job.id || input.originInputId !== originInput.id) return 'source_origin_identity_mismatch';
  if (!Object.prototype.hasOwnProperty.call(match, 'homeGoals') || !Object.prototype.hasOwnProperty.call(match, 'awayGoals')) return 'fixture_result_state_missing';
  if (match.homeGoals !== null || match.awayGoals !== null) return 'fixture_already_completed';
  const kickoff = time(match.kickoffAt), start = time(job.windowStartAt), end = time(job.windowEndAt);
  if (![kickoff, start, end, time(job.kickoffAt), time(input.kickoffAt)].every(Number.isFinite)
    || kickoff !== time(job.kickoffAt) || kickoff !== time(input.kickoffAt) || start >= end || kickoff > end) return 'fixture_or_window_mismatch';
  if (kickoff <= now) return 'fixture_already_started';
  if (now < start || now >= end) return 'recovery_window_expired';
  if (!Array.isArray(record.existingBets)) return 'existing_bet_evidence_missing';
  if (!Array.isArray(record.existingRecoveries)) return 'existing_recovery_evidence_missing';
  if (record.existingBets.length) return 'existing_bet_preserved';
  const recoveryReason = priorRecoveryReason(record, parentPolicyHash, now);
  if (recoveryReason) return recoveryReason;
  if (!object(input.snapshot) || !hash(input.inputHash) || researchHash(input.snapshot) !== input.inputHash
    || !hash(input.decisionsHash)) return 'source_input_hash_mismatch';
  const snapshot = input.snapshot, observed = time(snapshot.observedAt), captured = time(input.capturedAt), claimed = time(job.claimedAt);
  if (![observed, captured, claimed].every(Number.isFinite) || claimed < start || observed < claimed
    || captured < observed || captured > now || captured >= kickoff) return 'source_snapshot_time_mismatch';
  if (snapshot.match?.matchId !== match.matchId || time(snapshot.match?.kickoffAt) !== kickoff
    || snapshot.metadata?.originInputId !== originInput.id || !object(snapshot.metadata?.policy)
    || researchHash(snapshot.metadata.policy) !== parentPolicyHash) return 'source_input_provenance_mismatch';
  if (!Array.isArray(decisions) || decisions.length !== 2 || !Array.isArray(originDecisions) || originDecisions.length !== 2) return 'paired_source_decisions_required';
  const ordered = [...decisions].sort((a, b) => String(a?.family).localeCompare(String(b?.family)));
  const origins = [...originDecisions].sort((a, b) => String(a?.family).localeCompare(String(b?.family)));
  if (ordered.map(d => d?.family).join(',') !== 'A,C' || origins.map(d => d?.family).join(',') !== 'A,C'
    || new Set(ordered.map(d => d.id)).size !== 2 || new Set(origins.map(d => d.id)).size !== 2) return 'paired_source_decisions_required';
  for (let index = 0; index < 2; index++) {
    const decision = ordered[index], origin = origins[index], evidence = decision.snapshot;
    if (!id(decision.id) || !id(origin.id) || !id(decision.modelVersion)
      || decision.inputId !== input.id || origin.inputId !== originInput.id
      || decision.originDecisionId !== origin.id || decision.portfolioId !== `shadow_${decision.family}`
      || origin.portfolioId !== decision.portfolioId) return 'source_decision_origin_mismatch';
    if (decision.action !== 'ABSTAIN' || !(TECHNICAL_RECOVERY_REASONS as readonly string[]).includes(decision.reason)) return 'nontechnical_decision_preserved';
    if (!object(evidence) || evidence.action !== decision.action || evidence.reason !== decision.reason
      || evidence.family !== decision.family || evidence.modelVersion !== decision.modelVersion
      || evidence.portfolioId !== decision.portfolioId || evidence.matchId !== match.matchId
      || evidence.runId !== job.runId || evidence.originDecisionId !== origin.id
      || evidence.originInputId !== originInput.id || evidence.effectiveExecutionDecisionId !== decision.id
      || evidence.inputId !== input.id || evidence.inputHash !== input.inputHash || evidence.policyHash !== parentPolicyHash
      || time(evidence.kickoffAt) !== kickoff || evidence.stakeCents !== 0
      || evidence.recommended !== false || evidence.validated !== false) return 'source_decision_snapshot_mismatch';
  }
  return null;
}

/** Pure preview: no database bootstrap, providers, policy registration or financial writes. */
export function buildRecoveryPlan(records: TechnicalRecoveryRecord[], currentPolicy: RecommendationPolicyDescriptor,
  now: string | Date): TechnicalRecoveryPlan {
  const at = now instanceof Date ? now.getTime() : time(now);
  if (!Number.isFinite(at)) throw new Error('recovery_time_requires_timezone');
  if (!Array.isArray(records) || records.length > 100) throw new Error('recovery_record_limit_exceeded');
  const policyReason = currentPolicyReason(currentPolicy);
  if (policyReason) throw new Error(policyReason);
  const parentPolicyHash = researchHash(currentPolicy), excluded: TechnicalRecoveryPlan['excluded'] = [];
  const sources: TechnicalRecoverySource[] = [];
  const matchCounts = new Map<string, number>();
  for (const record of records) {
    const matchId = record?.match?.matchId;
    if (id(matchId)) matchCounts.set(matchId, (matchCounts.get(matchId) ?? 0) + 1);
  }
  for (const record of records) {
    const matchId = record?.match?.matchId ?? record?.job?.matchId ?? '<invalid>';
    const reason = (matchCounts.get(matchId) ?? 0) > 1 ? 'duplicate_match_record' : sourceReason(record, parentPolicyHash, at);
    if (reason) { excluded.push({ matchId, reason }); continue; }
    const ordered = [...record.decisions].sort((a, b) => a.family.localeCompare(b.family));
    sources.push({ matchId, kickoffAt: new Date(time(record.match.kickoffAt)).toISOString(),
      windowEndAt: new Date(time(record.job.windowEndAt)).toISOString(), sourceJobId: record.job.id, sourceRunId: record.job.runId,
      sourceInputId: record.input.id, sourceInputHash: record.input.inputHash, sourcePreparedDecisionsHash: record.input.decisionsHash,
      sourceDecisionIds: ordered.map(d => d.id).sort(),
      sourceDecisionSnapshotsHash: researchHash(ordered.map(d => ({ id: d.id, snapshot: d.snapshot }))),
      originInputId: record.originInput.id,
      originDecisionIds: { A: ordered[0].originDecisionId, C: ordered[1].originDecisionId },
      reasons: { A: ordered[0].reason!, C: ordered[1].reason! } });
  }
  sources.sort((a, b) => a.matchId.localeCompare(b.matchId));
  excluded.sort((a, b) => a.matchId.localeCompare(b.matchId) || a.reason.localeCompare(b.reason));
  if (new Set(sources.map(source => source.windowEndAt)).size > 1) throw new Error('recovery_window_mismatch');
  const identities = sources.flatMap(source => [source.sourceJobId, source.sourceInputId, source.originInputId,
    ...source.sourceDecisionIds, ...Object.values(source.originDecisionIds)]);
  if (new Set(identities).size !== identities.length) throw new Error('recovery_source_identity_reused');
  const policy = sources.length ? copy({ ...currentPolicy, recovery: {
    protocol: TECHNICAL_RECOVERY_PROTOCOL, reason: 'retry_technical_failure', parentPolicyHash,
    retrospective: false, maxDepth: 1, allowedReasons: [...TECHNICAL_RECOVERY_REASONS],
    matchIds: sources.map(source => source.matchId), sourceDecisionIds: sources.flatMap(source => source.sourceDecisionIds).sort(),
    sources,
  } }) : null;
  return { protocol: TECHNICAL_RECOVERY_PROTOCOL, plannedAt: new Date(at).toISOString(), parentPolicyHash,
    policy, policyHash: policy ? researchHash(policy) : null, windowEndAt: sources[0]?.windowEndAt ?? null,
    fixtures: sources.map(({ matchId, kickoffAt }) => ({ matchId, kickoffAt })), sources: copy(sources), excluded };
}
