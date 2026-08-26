import { createHash } from 'node:crypto';

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
  edgeNoVig?: number;
  edge?: number;
  kellyFraction?: number;
  isValueBet?: boolean;
  realBookmakerOdds?: boolean;
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

export const automatedSavedDecisionId = (
  userId: unknown,
  matchId: unknown,
  marketName: unknown,
  selection: unknown,
): string => {
  const identity = `${String(userId ?? '').trim()}\u001f${String(matchId ?? '').trim()}\u001f${automatedBetOpportunityKey(marketName, selection)}`;
  return `saved_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
};

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

export const isExceptionalLowConfidenceOpportunity = (opportunity: AutomatedBetOpportunity): boolean => {
  const odds = Number(opportunity.bookmakerOdds);
  const ev = Number(opportunity.expectedValue);
  const edgeNoVig = Number(opportunity.edgeNoVig);
  const kelly = Number(opportunity.kellyFraction);
  const suggestedStake = Number(opportunity.suggestedStakePercent);
  return opportunity.realBookmakerOdds === true
    && opportunity.isValueBet !== false
    && Number.isFinite(odds) && odds > 1
    && Number.isFinite(ev) && ev > 0
    && Number.isFinite(edgeNoVig) && edgeNoVig > 0
    && Number.isFinite(kelly) && kelly > 0
    && Number.isFinite(suggestedStake) && suggestedStake > 0;
};

/**
 * Ranks every opportunity inside its own match and makes at most the configured
 * number of HIGH/MEDIUM opportunities operational. A LOW can fill a remaining
 * slot only when every real-value check passes. Every other opportunity is
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
    const ranked = [...group].sort((left, right) => {
      const confidencePriority = (opportunity: AutomatedBetOpportunity): number => {
        const confidence = String(opportunity.confidence ?? '').trim().toUpperCase();
        return confidence === 'HIGH' || confidence === 'MEDIUM' ? 2 : confidence === 'LOW' ? 1 : 0;
      };
      return confidencePriority(right) - confidencePriority(left)
        || opportunityScore(right) - opportunityScore(left);
    });
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
      } else if (confidence === 'LOW' && !isExceptionalLowConfidenceOpportunity(opportunity)) {
        reason = 'low_confidence_saved_only';
      } else if (
        confidence !== 'HIGH'
        && confidence !== 'MEDIUM'
        && !(confidence === 'LOW' && isExceptionalLowConfidenceOpportunity(opportunity))
      ) {
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
