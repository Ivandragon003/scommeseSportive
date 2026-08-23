export type AutomatedBetOpportunity = {
  matchId?: string;
  marketName?: string;
  selection?: string;
  confidence?: string;
  bestBetStatus?: string;
  marketTier?: string;
  bookmakerOdds?: number;
  suggestedStakePercent?: number;
  ourProbability?: number;
  expectedValue?: number;
  rankingScore?: number;
  riskAdjustedBestScore?: number;
  score?: number;
  [key: string]: unknown;
};

export type AutomatedBetPlanDecision = {
  opportunity: AutomatedBetOpportunity;
  rankingPosition: number;
  action: 'operational' | 'saved_only';
  reason: string | null;
  operationalSlot: number | null;
};

const sqliteAsciiLower = (value: unknown): string =>
  String(value ?? '')
    .replace(/^ +| +$/g, '')
    .replace(/[A-Z]/g, (character) => character.toLowerCase());

/** Matches SQLite's built-in lower(trim(...)) without requiring the ICU extension. */
export const automatedBetOpportunityKey = (marketName: unknown, selection: unknown): string =>
  `${sqliteAsciiLower(marketName)}\u001f${sqliteAsciiLower(selection)}`;

const opportunityScore = (opportunity: AutomatedBetOpportunity): number => {
  const candidates = [
    opportunity.riskAdjustedBestScore,
    opportunity.rankingScore,
    opportunity.score,
    opportunity.expectedValue,
  ];
  const firstFinite = candidates.map(Number).find(Number.isFinite);
  return firstFinite ?? Number.NEGATIVE_INFINITY;
};

/**
 * Ranks every opportunity inside its own match and makes at most the configured
 * number of HIGH/MEDIUM opportunities operational. Every other opportunity is
 * returned as saved-only so the caller can persist a complete audit trail.
 */
export function planAutomatedBetOpportunities(
  opportunities: AutomatedBetOpportunity[],
  maxOperationalBetsPerMatch = 3,
): AutomatedBetPlanDecision[] {
  const safeLimit = Number.isFinite(Number(maxOperationalBetsPerMatch))
    ? Math.max(1, Math.min(Math.trunc(Number(maxOperationalBetsPerMatch)), 3))
    : 3;
  const byMatch = new Map<string, AutomatedBetOpportunity[]>();

  for (const opportunity of opportunities ?? []) {
    const matchId = String(opportunity?.matchId ?? '').trim();
    const group = byMatch.get(matchId) ?? [];
    group.push(opportunity);
    byMatch.set(matchId, group);
  }

  const decisions: AutomatedBetPlanDecision[] = [];
  for (const group of byMatch.values()) {
    const ranked = [...group].sort((left, right) => opportunityScore(right) - opportunityScore(left));
    let operationalCount = 0;

    ranked.forEach((opportunity, index) => {
      const confidence = String(opportunity.confidence ?? '').trim().toUpperCase();
      const betStatus = String(opportunity.bestBetStatus ?? 'VALUE').trim().toUpperCase();
      const marketTier = String(opportunity.marketTier ?? '').trim().toUpperCase();
      let action: AutomatedBetPlanDecision['action'] = 'saved_only';
      let reason: string | null;
      let operationalSlot: number | null = null;

      if (betStatus === 'SPECULATIVE' || marketTier === 'SPECULATIVE') {
        reason = 'speculative_saved_only';
      } else if (confidence === 'LOW') {
        reason = 'low_confidence_saved_only';
      } else if (confidence !== 'HIGH' && confidence !== 'MEDIUM') {
        reason = 'unsupported_confidence_saved_only';
      } else if (operationalCount >= safeLimit) {
        reason = 'per_match_limit_reached';
      } else {
        action = 'operational';
        reason = null;
        operationalCount += 1;
        operationalSlot = operationalCount;
      }

      decisions.push({
        opportunity,
        rankingPosition: index + 1,
        action,
        reason,
        operationalSlot,
      });
    });
  }

  return decisions;
}
