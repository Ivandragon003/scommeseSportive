export type ConfidenceStakeCandidate = {
  key: string;
  confidence?: unknown;
  ev?: number;
};

export type ConfidenceStakeAllocation = {
  key: string;
  stakeCents: number;
  stakePercent: number | null;
  baseAvailableCents: number;
  reason: string | null;
};

export function confidenceStakePercent(confidence: unknown): number | null {
  if (typeof confidence !== 'string') return null;
  switch (confidence.trim().toUpperCase()) {
    case 'LOW': return 1;
    case 'MEDIUM': return 3;
    case 'HIGH': return 5;
    default: return null;
  }
}

const compareKeys = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** Fund whole stakes from the same opening balance, without changing selection eligibility. */
export function allocateConfidenceStakes(
  candidates: readonly ConfidenceStakeCandidate[],
  availableCents: number,
): ConfidenceStakeAllocation[] {
  if (!Number.isSafeInteger(availableCents) || availableCents < 0) {
    throw new Error('available_cents_must_be_nonnegative_safe_integer');
  }
  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.key !== 'string' || !candidate.key.trim()) {
      throw new Error('confidence_stake_candidate_key_required');
    }
    if (keys.has(candidate.key)) throw new Error('confidence_stake_candidate_key_duplicate');
    keys.add(candidate.key);
  }
  const ranked = candidates.map((candidate) => ({
    ...candidate,
    stakePercent: confidenceStakePercent(candidate.confidence),
    priorityEv: typeof candidate.ev === 'number' && Number.isFinite(candidate.ev)
      ? candidate.ev : Number.NEGATIVE_INFINITY,
  })).sort((left, right) => (right.stakePercent ?? 0) - (left.stakePercent ?? 0)
    || (left.priorityEv > right.priorityEv ? -1 : left.priorityEv < right.priorityEv ? 1 : 0)
    || compareKeys(left.key, right.key));

  let remainingCents = availableCents;
  const allocations = ranked.map(({ key, stakePercent }): ConfidenceStakeAllocation => {
    // Split before multiplication so even MAX_SAFE_INTEGER balances stay exact.
    const desiredCents = stakePercent === null ? 0
      : Math.floor(availableCents / 100) * stakePercent
        + Math.floor((availableCents % 100) * stakePercent / 100);
    const reason = stakePercent === null ? 'unknown_confidence'
      : desiredCents === 0 ? 'zero_stake_amount'
        : desiredCents > remainingCents ? 'insufficient_available_balance' : null;
    const stakeCents = reason === null ? desiredCents : 0;
    remainingCents -= stakeCents;
    return { key, stakeCents, stakePercent, baseAvailableCents: availableCents, reason };
  });
  return allocations.sort((left, right) => compareKeys(left.key, right.key));
}
