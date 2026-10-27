import originalPolicy from './original-holdout-policy.json';

export type ResearchEvaluationPolicy = {
  version: string;
  newIndependentForecastsAfter: string;
  protectedOriginalFinalMatchIds: string[];
};

export const ORIGINAL_HOLDOUT_POLICY: ResearchEvaluationPolicy = Object.freeze({
  version: originalPolicy.version,
  newIndependentForecastsAfter: originalPolicy.newIndependentForecastsAfter,
  protectedOriginalFinalMatchIds: [...originalPolicy.protectedOriginalFinalMatchIds],
});

/** Consultation is irreversible: an already observed holdout cannot become new evidence. */
export function assessResearchHoldout(predictions: Array<{ matchId: string; forecastAt: string }>,
  policy: ResearchEvaluationPolicy = ORIGINAL_HOLDOUT_POLICY) {
  const cutoff = Date.parse(policy.newIndependentForecastsAfter);
  if (!Number.isFinite(cutoff) || !policy.version || !Array.isArray(policy.protectedOriginalFinalMatchIds)) {
    throw new Error('Invalid research evaluation policy');
  }
  const protectedIds = new Set(policy.protectedOriginalFinalMatchIds);
  const protectedMatches = predictions.filter((row) => protectedIds.has(row.matchId)).map((row) => row.matchId);
  const beforeBoundary = predictions.filter((row) => !Number.isFinite(Date.parse(row.forecastAt))
    || Date.parse(row.forecastAt) <= cutoff).map((row) => row.matchId);
  const reasons = [];
  if (protectedMatches.length) reasons.push('protected_original_final_reused');
  if (beforeBoundary.length || !predictions.length) reasons.push('new_independent_future_holdout_required');
  return { passed: reasons.length === 0, reasons, policyVersion: policy.version,
    futureAfter: policy.newIndependentForecastsAfter, protectedMatches, beforeBoundary,
    observations: predictions.length };
}
