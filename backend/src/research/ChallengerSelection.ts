import { evaluateGoalQuote, GoalSettlement, normalizeScoreMatrix } from './GoalSettlement';
import type { ResearchQuote } from './ResearchEvaluation';
import { recommendationQuoteReason } from './ResearchRecommendationPolicy';

export const CHALLENGER_PAYOUT_SELECTION_POLICY = 'challenger-payout-selection-v1';
export const CHALLENGER_STAKE_FRACTION = .01;
const EXECUTION_MARKETS = new Set(['1x2', 'totals', 'asian_handicap']);
const EPSILON = 1e-12;

export type ChallengerQualityEvidence = {
  technicalValidation: boolean;
  calibrationAvailableAt: string | null;
  prospectiveResidualSamples: number | null;
  parameterUncertainty: null;
  uncertaintyReason: 'parameter_uncertainty_not_supplied';
  homeHistorySample?: number | null;
  awayHistorySample?: number | null;
  homeXgCoverage?: number | null;
  awayXgCoverage?: number | null;
  historyAvailableThrough?: string | null;
  modelFitAt?: string | null;
  dataQualityMissingFields?: string[];
  uncertaintyAdjustment?: 'not_applied_parameter_uncertainty_unavailable';
};
type PayoutStatus = Exclude<GoalSettlement['status'], 'UNRESOLVED'>;
export type ChallengerPayoutOutcome = { status: PayoutStatus; probability: number; returnMultiplier: number };
export type ChallengerPayoutEvaluation = {
  probability: number;
  expectedValue: number;
  expectedReturn: number;
  payoutVariance: number;
  payoutStandardDeviation: number;
  downsideSecondMoment: number;
  expectedLogGrowth: number;
  activeStake: number;
  outcomes: ChallengerPayoutOutcome[];
};
export type ChallengerPayoutOpportunity = {
  selection: string; marketName: string; marketCategory: string; marketType: string;
  bookmakerOdds: number; ourProbability: number; expectedValue: number;
  impliedProbability: number; edge: number; edgeNoVig: number;
  suggestedStakePercent: number; confidence: null; isValueBet: true;
  evReason: 'computed'; rankingScore: number;
  quote: ResearchQuote; payout: ChallengerPayoutEvaluation; quality: ChallengerQualityEvidence;
};
export type ChallengerQuoteRejection = { selection: string; market: string; bookmaker: string; reason: string };
export type ChallengerPayoutRecommendation = {
  policyVersion: typeof CHALLENGER_PAYOUT_SELECTION_POLICY;
  selected: ChallengerPayoutOpportunity | null; ranked: ChallengerPayoutOpportunity[];
  opportunities: ChallengerPayoutOpportunity[]; decisionStatus: 'RECOMMENDED' | 'NO_BET';
  exclusions: Record<string, number>; rejections: ChallengerQuoteRejection[];
  abstentionReason: string | null;
};

/** Evaluate net wealth outcomes directly; refunds and split stakes never become binary wagers. */
export function evaluateChallengerPayout(matrix: number[][], quote: ResearchQuote): ChallengerPayoutEvaluation {
  const evaluated = evaluateGoalQuote(matrix, quote);
  const outcomes: ChallengerPayoutOutcome[] = [
    { status: 'WON', probability: evaluated.win, returnMultiplier: quote.odds },
    { status: 'LOST', probability: evaluated.loss, returnMultiplier: 0 },
    { status: 'VOID', probability: evaluated.push, returnMultiplier: 1 },
    { status: 'HALF_WON', probability: evaluated.halfWin, returnMultiplier: (quote.odds + 1) / 2 },
    { status: 'HALF_LOST', probability: evaluated.halfLoss, returnMultiplier: .5 },
  ];
  const expectedReturn = outcomes.reduce((sum, outcome) => sum + outcome.probability * outcome.returnMultiplier, 0);
  const payoutVariance = outcomes.reduce((sum, outcome) => sum
    + outcome.probability * (outcome.returnMultiplier - expectedReturn) ** 2, 0);
  const downsideSecondMoment = outcomes.reduce((sum, outcome) => sum
    + outcome.probability * Math.min(0, outcome.returnMultiplier - 1) ** 2, 0);
  const expectedLogGrowth = outcomes.reduce((sum, outcome) => sum
    + outcome.probability * Math.log1p(CHALLENGER_STAKE_FRACTION * (outcome.returnMultiplier - 1)), 0);
  const activeStake = evaluated.win + evaluated.loss + (evaluated.halfWin + evaluated.halfLoss) / 2;
  const values = [evaluated.probability, expectedReturn, payoutVariance, downsideSecondMoment, expectedLogGrowth, activeStake];
  if (values.some((value) => !Number.isFinite(value))
    || Math.abs(outcomes.reduce((sum, outcome) => sum + outcome.probability, 0) - 1) > 1e-8) {
    throw new Error('invalid_challenger_payout_distribution');
  }
  return { probability: evaluated.probability, expectedValue: expectedReturn - 1, expectedReturn,
    payoutVariance, payoutStandardDeviation: Math.sqrt(Math.max(0, payoutVariance)), downsideSecondMoment,
    expectedLogGrowth, activeStake, outcomes };
}

const sheetKey = (quote: ResearchQuote): string => JSON.stringify([quote.market, quote.bookmaker, quote.source,
  quote.capturedAt, quote.updatedAt, quote.market === 'asian_handicap' && quote.side === 'away' ? -quote.line! : quote.line ?? null,
  quote.team ?? null]);
const stableKey = (quote: ResearchQuote): string => JSON.stringify([quote.market, quote.selection, quote.side,
  quote.line ?? null, quote.bookmaker, quote.source, quote.capturedAt, quote.updatedAt]);
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const DATA_QUALITY_FIELDS = ['homeHistorySample', 'awayHistorySample', 'homeXgCoverage', 'awayXgCoverage',
  'historyAvailableThrough', 'modelFitAt'] as const;

function qualityReason(quality: ChallengerQualityEvidence, observedAt: string): string | null {
  for (const field of ['homeHistorySample', 'awayHistorySample', 'prospectiveResidualSamples'] as const) {
    const value = quality[field];
    if (value != null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
      return 'invalid_challenger_sample_evidence';
    }
  }
  for (const field of ['homeXgCoverage', 'awayXgCoverage'] as const) {
    const value = quality[field];
    if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) {
      return 'invalid_challenger_xg_coverage';
    }
  }
  for (const field of ['historyAvailableThrough', 'modelFitAt', 'calibrationAvailableAt'] as const) {
    const value = quality[field];
    if (value == null) continue;
    if (typeof value !== 'string' || !/(?:z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
      return 'invalid_challenger_quality_timestamp';
    }
    if (Date.parse(value) > Date.parse(observedAt)) return 'future_challenger_quality_evidence';
  }
  return null;
}

function observedQuality(quality: ChallengerQualityEvidence): ChallengerQualityEvidence {
  return { ...quality,
    ...Object.fromEntries(DATA_QUALITY_FIELDS.map((field) => [field, quality[field] ?? null])),
    dataQualityMissingFields: DATA_QUALITY_FIELDS.filter((field) => quality[field] == null),
    uncertaintyAdjustment: 'not_applied_parameter_uncertainty_unavailable' };
}

function completeSheet(quote: ResearchQuote, quotes: ResearchQuote[]): ResearchQuote[] | null {
  const expectedSides = quote.market === '1x2' ? ['home', 'draw', 'away']
    : quote.market === 'asian_handicap' ? ['home', 'away'] : ['over', 'under'];
  const sides = new Map<string, ResearchQuote>();
  for (const candidate of quotes.filter((other) => sheetKey(other) === sheetKey(quote))) {
    if (!expectedSides.includes(candidate.side)) return null;
    const previous = sides.get(candidate.side);
    if (previous && (previous.odds !== candidate.odds || previous.selection !== candidate.selection)) return null;
    sides.set(candidate.side, candidate);
  }
  return expectedSides.every((side) => sides.has(side)) ? expectedSides.map((side) => sides.get(side)!) : null;
}

/** Standalone opt-in policy for C. Epistemic uncertainty is unavailable, not a fabricated confidence class. */
export function selectChallengerPayoutRecommendation(input: {
  matrix: number[][]; quotes: ResearchQuote[]; observedAt: string; allowedMarkets: string[];
  quality: ChallengerQualityEvidence;
}): ChallengerPayoutRecommendation {
  const exclusions: Record<string, number> = {}, rejections: ChallengerQuoteRejection[] = [];
  const reject = (quote: ResearchQuote | undefined, reason: string) => {
    exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    rejections.push({ selection: quote?.selection ?? '', market: quote?.market ?? '', bookmaker: quote?.bookmaker ?? '', reason });
  };
  const result = (opportunities: ChallengerPayoutOpportunity[], abstentionReason: string | null): ChallengerPayoutRecommendation => ({
    policyVersion: CHALLENGER_PAYOUT_SELECTION_POLICY, selected: opportunities[0] ?? null, ranked: opportunities.slice(0, 3),
    opportunities, decisionStatus: opportunities.length ? 'RECOMMENDED' : 'NO_BET', exclusions, rejections, abstentionReason,
  });
  let matrix: number[][];
  try {
    matrix = normalizeScoreMatrix(input.matrix);
    if (Math.abs(input.matrix.flat().reduce((sum, value) => sum + value, 0) - 1) > 1e-8) throw new Error();
  } catch { reject(undefined, 'invalid_challenger_matrix'); return result([], 'invalid_challenger_matrix'); }
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    reject(undefined, 'invalid_challenger_forecast_time'); return result([], 'invalid_challenger_forecast_time');
  }
  if (input.quality?.technicalValidation !== true) {
    reject(undefined, 'challenger_technical_validation_failed'); return result([], 'challenger_technical_validation_failed');
  }
  const invalidQuality = qualityReason(input.quality, input.observedAt);
  if (invalidQuality) { reject(undefined, invalidQuality); return result([], invalidQuality); }
  const quality = observedQuality(input.quality);
  if (!input.quotes.length) return result([], 'real_fresh_quotes_unavailable');
  const usable: ResearchQuote[] = [];
  for (const quote of input.quotes) {
    const invalid = recommendationQuoteReason(quote, new Date(input.observedAt), 'C');
    if (invalid) { reject(quote, invalid); continue; }
    if ((quote as ResearchQuote & { usedSyntheticOdds?: boolean }).usedSyntheticOdds === true) {
      reject(quote, 'real_prematch_quote_required'); continue;
    }
    if (!EXECUTION_MARKETS.has(quote.market)) { reject(quote, 'market_not_supported_by_challenger_selector'); continue; }
    if (!input.allowedMarkets.includes(quote.market)) { reject(quote, 'market_not_allowed'); continue; }
    if (Date.parse(quote.updatedAt!) > Date.parse(quote.capturedAt)) { reject(quote, 'quote_update_after_capture'); continue; }
    usable.push(quote);
  }
  const opportunities: ChallengerPayoutOpportunity[] = [], seen = new Set<string>();
  for (const quote of usable) {
    const identity = stableKey(quote);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const sheet = completeSheet(quote, usable);
    if (!sheet) { reject(quote, 'complete_bookmaker_market_required'); continue; }
    let payout: ChallengerPayoutEvaluation;
    try { payout = evaluateChallengerPayout(matrix, quote); }
    catch { reject(quote, 'invalid_challenger_payout_distribution'); continue; }
    if (!(payout.activeStake > EPSILON)) { reject(quote, 'all_stakes_refunded'); continue; }
    // The execution ledger requires a strictly interior conditional probability.
    if (!(payout.probability > 0 && payout.probability < 1)) { reject(quote, 'degenerate_challenger_probability'); continue; }
    if (!(payout.expectedValue > EPSILON)) { reject(quote, 'non_positive_payout_ev'); continue; }
    if (!(payout.expectedLogGrowth > EPSILON)) { reject(quote, 'non_positive_expected_log_growth'); continue; }
    const implied = 1 / quote.odds;
    const noVig = implied / sheet.reduce((sum, value) => sum + 1 / value.odds, 0);
    opportunities.push({ selection: quote.selection, marketName: quote.selection,
      marketCategory: quote.market, marketType: quote.market, bookmakerOdds: quote.odds,
      ourProbability: payout.probability * 100, expectedValue: payout.expectedValue * 100,
      impliedProbability: implied * 100, edge: (payout.probability - implied) * 100,
      edgeNoVig: (payout.probability - noVig) * 100, suggestedStakePercent: CHALLENGER_STAKE_FRACTION * 100,
      confidence: null, isValueBet: true, evReason: 'computed', rankingScore: payout.expectedLogGrowth,
      quote, payout, quality });
  }
  opportunities.sort((left, right) => right.payout.expectedLogGrowth - left.payout.expectedLogGrowth
    || right.payout.expectedValue - left.payout.expectedValue || left.payout.payoutVariance - right.payout.payoutVariance
    || compareText(stableKey(left.quote), stableKey(right.quote)));
  if (opportunities.length) return result(opportunities, null);
  const reasons = Object.keys(exclusions);
  return result([], reasons.length === 1 ? reasons[0] : 'no_eligible_challenger_payout');
}
