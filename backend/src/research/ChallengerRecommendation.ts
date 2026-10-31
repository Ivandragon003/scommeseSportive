import { ValueBettingEngine, MarketOddsGroup, BetOpportunity } from '../models/value/ValueBettingEngine';
import { pickCanonicalBetRecommendation } from '../services/CanonicalBetRecommendation';
import { ResearchQuote, quoteForecast } from './ResearchEvaluation';
import { normalizeScoreMatrix, scoreMatrixMarkets } from './GoalSettlement';
import { COHERENT_PROBABILITY_PROTOCOL, coherentProbabilityPipelineHash } from './CoherentProbabilityPipeline';
import { researchHash } from './ResearchStore';
import { recommendationQuoteReason, RECOMMENDATION_BASELINE_C, RECOMMENDATION_MODEL_C } from './ResearchRecommendationPolicy';
import { T15Decision } from './T15Scheduler';
import { ChallengerQualityEvidence, selectChallengerPayoutRecommendation } from './ChallengerSelection';

export type ChallengerSelectionPolicy = 'legacy-c906' | 'payout-aware-v1';
export type ChallengerExpectedIdentity = { modelVersion: string; baselineVersion: string; probabilityConfigurationHash?: string | null };
export type ChallengerRecommendationInput = { decision: T15Decision; quotes: ResearchQuote[];
  observedAt: string; competition?: string; allowedMarkets: string[]; selectionPolicy?: ChallengerSelectionPolicy;
  expectedIdentity?: ChallengerExpectedIdentity };

const finiteProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const keyOf = (quote: ResearchQuote): string => [quote.market, quote.bookmaker, quote.source, quote.capturedAt,
  quote.market === 'asian_handicap' && quote.side === 'away' ? -quote.line! : quote.line ?? '', quote.team ?? ''].join('|');

export function challengerTechnicalReason(decision: T15Decision | undefined, observedAt: string,
  expectedIdentity?: ChallengerExpectedIdentity): string | null {
  const expected = expectedIdentity ?? { modelVersion: RECOMMENDATION_MODEL_C, baselineVersion: RECOMMENDATION_BASELINE_C };
  if (!decision?.validated) return 'challenger_technical_validation_failed';
  if (decision.modelVersion !== expected.modelVersion) return 'challenger_model_version_mismatch';
  if (decision.probabilityProtocol !== COHERENT_PROBABILITY_PROTOCOL
    || decision.calibrationPipelineHash !== coherentProbabilityPipelineHash()) return 'challenger_pipeline_mismatch';
  const configuration = object(decision.probabilityConfiguration);
  if (configuration.family !== 'C' || configuration.baselineVersion !== expected.baselineVersion
    || researchHash(configuration) !== decision.probabilityConfigurationHash) return 'challenger_configuration_mismatch';
  if (expected.probabilityConfigurationHash != null
    && decision.probabilityConfigurationHash !== expected.probabilityConfigurationHash) return 'challenger_configuration_mismatch';
  if (!Number.isFinite(Date.parse(String(decision.calibrationAvailableAt)))
    || Date.parse(String(decision.calibrationAvailableAt)) > Date.parse(observedAt)) return 'challenger_configuration_unavailable';
  try {
    const matrix = decision.prospectiveMatrix as number[][];
    const normalized = normalizeScoreMatrix(matrix);
    if (Math.abs(matrix.flat().reduce((sum, value) => sum + value, 0) - 1) > 1e-8) return 'challenger_incoherent_probabilities';
    const probabilities = object(object(decision.probabilityStages).decision);
    if (Object.values(probabilities).some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
      || Object.entries(scoreMatrixMarkets(normalized)).some(([key, value]) => typeof probabilities[key] !== 'number'
        || !Number.isFinite(probabilities[key]) || Math.abs(Number(probabilities[key]) - value) > 1e-8)) return 'challenger_incoherent_probabilities';
  } catch { return 'challenger_incoherent_probabilities'; }
  return null;
}

/** Already calibrated C probabilities enter the ordinary engine exactly once, without a second calibration/blend. */
function buildLegacyChallengerRecommendation(input: ChallengerRecommendationInput) {
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const technicalFailure = challengerTechnicalReason(input.decision, input.observedAt, input.expectedIdentity);
  if (technicalFailure) return { ...pickCanonicalBetRecommendation({ valueOpportunities: [] as BetOpportunity[] }),
    opportunities: [] as BetOpportunity[], exclusions: { [technicalFailure]: 1 } };
  const probabilities: Record<string, number> = {}, groups: Record<string, MarketOddsGroup> = {}, names: Record<string, string> = {};
  const matrix = input.decision.prospectiveMatrix as number[][];
  for (const quote of input.quotes) {
    const invalid = recommendationQuoteReason(quote, new Date(input.observedAt));
    if (invalid) { exclude(invalid); continue; }
    if (!input.allowedMarkets.includes(quote.market)) { exclude('market_not_allowed'); continue; }
    let forecast: ReturnType<typeof quoteForecast>;
    try { forecast = quoteForecast(matrix, quote, object(object(input.decision.probabilityStages).decision) as Record<string, number>); }
    catch { exclude('invalid_quote_probability'); continue; }
    // The app engine has binary confidence/Kelly semantics. Do not invent a confidence for a refunded or split stake.
    if (Math.abs(forecast.activeStake - 1) > 1e-8) { exclude('non_binary_payout_not_supported_by_canonical_engine'); continue; }
    if (!finiteProbability(forecast.probability)) { exclude('invalid_quote_probability'); continue; }
    const companions = input.quotes.filter((other) => other.selection !== quote.selection && keyOf(other) === keyOf(quote)
      && !recommendationQuoteReason(other, new Date(input.observedAt)));
    const required = quote.market === '1x2' ? 2 : 1;
    if (companions.length !== required) { exclude('complete_bookmaker_market_required'); continue; }
    probabilities[quote.selection] = forecast.probability;
    groups[quote.selection] = { selection: quote.selection, odds: quote.odds, companions: companions.map((other) => other.odds) };
    names[quote.selection] = quote.selection;
  }
  const engine = new ValueBettingEngine();
  const opportunities = engine.analyzeMarketsWithVigRemoval(probabilities, groups, names, {
    competition: input.competition, enableMarketCalibration: false, enableMarketBlending: false,
  });
  const recommendation = pickCanonicalBetRecommendation({ valueOpportunities: opportunities });
  const policyStake = (opportunity: BetOpportunity) => ({ ...opportunity,
    engineSuggestedStakePercent: opportunity.suggestedStakePercent, suggestedStakePercent: 1 });
  // Selection/confidence/ranking are already final. Only the displayed execution stake follows C's fixed policy.
  const ranked = recommendation.ranked.map(policyStake);
  return { ...recommendation, selected: ranked[0] ?? null, ranked, opportunities: opportunities.map(policyStake), exclusions };
}

/** The frozen C906 policy stays the default until an independent adoption explicitly selects the new policy. */
export function buildChallengerRecommendation(input: ChallengerRecommendationInput) {
  if (input.selectionPolicy !== 'payout-aware-v1') return buildLegacyChallengerRecommendation(input);
  const technicalFailure = challengerTechnicalReason(input.decision, input.observedAt, input.expectedIdentity);
  const samples = input.decision?.prudentialSamplesAvailable;
  const observed = object(input.decision?.challengerQuality) as Partial<ChallengerQualityEvidence>;
  const recommendation = selectChallengerPayoutRecommendation({ matrix: input.decision?.prospectiveMatrix as number[][],
    quotes: input.quotes, observedAt: input.observedAt, allowedMarkets: input.allowedMarkets,
    quality: { technicalValidation: !technicalFailure,
      calibrationAvailableAt: typeof input.decision?.calibrationAvailableAt === 'string' ? input.decision.calibrationAvailableAt : null,
      prospectiveResidualSamples: samples == null ? null : samples as number,
      homeHistorySample: observed.homeHistorySample ?? null, awayHistorySample: observed.awayHistorySample ?? null,
      homeXgCoverage: observed.homeXgCoverage ?? null, awayXgCoverage: observed.awayXgCoverage ?? null,
      historyAvailableThrough: observed.historyAvailableThrough ?? null, modelFitAt: observed.modelFitAt ?? null,
      parameterUncertainty: null, uncertaintyReason: 'parameter_uncertainty_not_supplied' } });
  if (!technicalFailure) return recommendation;
  return { ...recommendation, selected: null, ranked: [], opportunities: [], decisionStatus: 'NO_BET' as const,
    abstentionReason: technicalFailure, exclusions: { [technicalFailure]: 1 },
    rejections: [{ selection: '', market: '', bookmaker: '', reason: technicalFailure }] };
}
