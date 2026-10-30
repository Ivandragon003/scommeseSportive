import { CANONICAL_RECOMMENDATION_POLICY } from '../services/CanonicalBetRecommendation';
import { settleGoalQuote } from './GoalSettlement';
import { appQuoteSettlementSupported, RecommendationQuote } from './AppRecommendationQuotes';
import type { ResearchQuote } from './ResearchEvaluation';
import { quoteFreshnessReason } from './T15Scheduler';

export const RECOMMENDATION_MODEL_C = 'C-906371b0b3a1e2c8';
export const RECOMMENDATION_BASELINE_C = 'A-80cb25df5552621e';

/** A new virtual execution policy; historical research decisions keep their original meaning. */
export const VIRTUAL_RECOMMENDATION_POLICY = {
  version: 'virtual-recommendation-v2', virtualOnly: true,
  familyA: { source: 'PredictionService', recommendationPolicy: CANONICAL_RECOMMENDATION_POLICY,
    stakeMode: 'RECOMMENDED_PERCENT', marketCoverage: 'existing-supported-team-markets', playerProps: false },
  familyC: { source: 'ResearchRuntime', modelVersion: RECOMMENDATION_MODEL_C, baselineVersion: RECOMMENDATION_BASELINE_C,
    stakeMode: 'FIXED_ONE_PERCENT', marketCalibration: false, marketBlending: false },
  stakeModeA: 'RECOMMENDED_PERCENT', stakeModeC: 'FIXED_ONE_PERCENT',
  maxExposureFraction: .05, maxBetsPerMatchPerFamily: 1, quoteMaxAgeMs: 300_000,
  independentCalibrationRequired: false,
};

export function recommendationQuoteReason(quote: RecommendationQuote, now: Date, family: 'A' | 'C' = 'C'): string | null {
  if (!quote || quote.source !== 'odds_api' || quote.priceType !== 'prematch'
    || quote.timestampEvidence === 'observed_snapshot') return 'real_prematch_quote_required';
  const freshness = quoteFreshnessReason({ ...quote, updatedAt: quote.updatedAt ?? '' }, now.getTime());
  if (freshness) return freshness;
  if (family === 'A' ? !appQuoteSettlementSupported(quote)
    : settleGoalQuote(quote as ResearchQuote, 0, 0).status === 'UNRESOLVED') return 'unsupported_quote_settlement';
  return null;
}
