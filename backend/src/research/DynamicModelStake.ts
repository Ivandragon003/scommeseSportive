import { confidenceStakePercent } from './ConfidenceStake';

export type DynamicStakeCandidate = { key: string; confidence?: unknown; ev?: number; suggestedStakePercent?: unknown };
export type DynamicStakeAllocation = { key: string; stakeCents: number; stakePercent: number | null;
  stakeBasisPoints: number | null; baseEquityCents: number; reason: string | null };

/** Use the engine's percentage and opening equity, reserving complete stakes against available funds. */
export function allocateDynamicStakes(candidates: readonly DynamicStakeCandidate[], availableCents: number,
  equityCents: number): DynamicStakeAllocation[] {
  if (![availableCents, equityCents].every(n => Number.isSafeInteger(n) && n >= 0) || availableCents > equityCents) {
    throw new Error('invalid_dynamic_stake_balance');
  }
  const keys = new Set<string>();
  const ranked = candidates.map(candidate => {
    if (!candidate || typeof candidate.key !== 'string' || !candidate.key.trim() || keys.has(candidate.key)) throw new Error('invalid_dynamic_stake_key');
    keys.add(candidate.key);
    const percent = candidate.suggestedStakePercent, bps = typeof percent === 'number' ? Math.round(percent * 100) : NaN;
    const valid = typeof percent === 'number' && Number.isFinite(percent) && percent > 0 && percent <= 5
      && Math.abs(percent * 100 - bps) <= 1e-7;
    return { ...candidate, stakePercent: valid ? percent as number : null, stakeBasisPoints: valid ? bps : null,
      priority: confidenceStakePercent(candidate.confidence) ?? 0,
      priorityEv: typeof candidate.ev === 'number' && Number.isFinite(candidate.ev) ? candidate.ev : Number.NEGATIVE_INFINITY };
  }).sort((a, b) => b.priority - a.priority || (a.priorityEv > b.priorityEv ? -1 : a.priorityEv < b.priorityEv ? 1 : 0)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let remaining = availableCents;
  return ranked.map(item => {
    const bps = item.stakeBasisPoints;
    const desired = bps === null ? 0 : Math.floor(equityCents / 10000) * bps + Math.floor((equityCents % 10000) * bps / 10000);
    const reason = bps === null ? 'invalid_suggested_stake_percent' : desired === 0 ? 'zero_stake_amount'
      : desired > remaining ? 'insufficient_available_balance' : null;
    const stakeCents = reason === null ? desired : 0; remaining -= stakeCents;
    return { key: item.key, stakeCents, stakePercent: item.stakePercent, stakeBasisPoints: bps, baseEquityCents: equityCents, reason };
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
