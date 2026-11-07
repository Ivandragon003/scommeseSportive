import { CANONICAL_RECOMMENDATION_POLICY } from '../services/CanonicalBetRecommendation';
import { settleGoalQuote } from './GoalSettlement';
import { appQuoteSettlementSupported, RecommendationQuote } from './AppRecommendationQuotes';
import type { ResearchQuote } from './ResearchEvaluation';
import { quoteFreshnessReason } from './T15Scheduler';
import { CURRENT_CHALLENGER_RELEASE } from './CurrentChallengerRelease';

export const RECOMMENDATION_MODEL_C = CURRENT_CHALLENGER_RELEASE.modelVersion;
export const RECOMMENDATION_BASELINE_C = CURRENT_CHALLENGER_RELEASE.baselineVersion;

export type ChallengerExecutionDeployment = {
  modelVersion: string; baselineVersion: string; selectorPolicy: 'canonical-binary-v1' | 'payout-aware-v1';
  probabilityConfigurationHash: string | null; artifactHash: string | null;
};
export type ChallengerExecutionState = {
  deployment: ChallengerExecutionDeployment; revision: string; source: 'fallback' | 'adopted' | 'rollback' | 'suspended';
  resolutionUnavailable?: boolean;
};
export const FALLBACK_CHALLENGER_DEPLOYMENT: ChallengerExecutionDeployment = {
  ...CURRENT_CHALLENGER_RELEASE,
};
export const fallbackChallengerState = (): ChallengerExecutionState => ({
  deployment: { ...FALLBACK_CHALLENGER_DEPLOYMENT }, revision: 'fallback', source: 'fallback',
});
export const unavailableChallengerState = (): ChallengerExecutionState => ({
  ...fallbackChallengerState(), source: 'suspended', revision: 'adoption-state-unavailable', resolutionUnavailable: true,
});

/** A new virtual execution policy; historical research decisions keep their original meaning. */
export const VIRTUAL_RECOMMENDATION_POLICY = {
  version: 'virtual-recommendation-v2', virtualOnly: true,
  familyA: { source: 'PredictionService', recommendationPolicy: CANONICAL_RECOMMENDATION_POLICY,
    stakeMode: 'RECOMMENDED_PERCENT', marketCoverage: 'existing-supported-team-markets', playerProps: false },
  // Historical policy bytes remain readable; current executions bind the release below.
  familyC: { source: 'ResearchRuntime', modelVersion: 'C-906371b0b3a1e2c8', baselineVersion: 'A-80cb25df5552621e',
    stakeMode: 'FIXED_ONE_PERCENT', marketCalibration: false, marketBlending: false },
  stakeModeA: 'RECOMMENDED_PERCENT', stakeModeC: 'FIXED_ONE_PERCENT',
  maxExposureFraction: .05, maxBetsPerMatchPerFamily: 1, quoteMaxAgeMs: 300_000,
  independentCalibrationRequired: false,
};

/** The original fallback descriptor must retain its immutable policy identity. */
export function challengerExecutionPolicy(state: ChallengerExecutionState) {
  if (state.source === 'fallback' && !state.resolutionUnavailable
    && state.deployment.modelVersion === VIRTUAL_RECOMMENDATION_POLICY.familyC.modelVersion
    && state.deployment.baselineVersion === VIRTUAL_RECOMMENDATION_POLICY.familyC.baselineVersion) return VIRTUAL_RECOMMENDATION_POLICY;
  return { ...VIRTUAL_RECOMMENDATION_POLICY, version: 'virtual-recommendation-v3',
    familyC: { ...VIRTUAL_RECOMMENDATION_POLICY.familyC, ...state.deployment,
      deploymentRevision: state.revision, deploymentSource: state.source,
      ...(state.resolutionUnavailable ? { resolutionUnavailable: true } : {}) } };
}

const { maxExposureFraction: _paperExposure, maxBetsPerMatchPerFamily: _paperBets, ...paperBase } = VIRTUAL_RECOMMENDATION_POLICY;
export const PAPER_RECOMMENDATION_POLICY = {
  ...paperBase,
  version: 'paper-fixed-unit-v1',
  familyA: { ...VIRTUAL_RECOMMENDATION_POLICY.familyA, stakeMode: 'PAPER_FIXED_UNIT' },
  familyC: { ...VIRTUAL_RECOMMENDATION_POLICY.familyC, stakeMode: 'PAPER_FIXED_UNIT' },
  stakeModeA: 'PAPER_FIXED_UNIT', stakeModeC: 'PAPER_FIXED_UNIT', fixedStakeUnits: 1,
};
// Exposure and bet-count caps belong to the older wallet policy, not paper execution.
export function paperExecutionPolicy(state: ChallengerExecutionState) {
  const base = PAPER_RECOMMENDATION_POLICY;
  return { ...base, familyC: { ...base.familyC, ...state.deployment,
    deploymentRevision: state.revision, deploymentSource: state.source,
    ...(state.resolutionUnavailable ? { resolutionUnavailable: true } : {}) } };
}

export const FUNDED_POLICY_VERSION = 'funded-confidence-v1';
export const FUNDED_ACCOUNTING_MODE = 'CONFIDENCE_PERCENT_AVAILABLE';
export function fundedExecutionPolicy(state: ChallengerExecutionState) {
  const { fixedStakeUnits: _fixedStakeUnits, ...base } = paperExecutionPolicy(state);
  return { ...base, version: FUNDED_POLICY_VERSION,
    familyA: { ...PAPER_RECOMMENDATION_POLICY.familyA, stakeMode: FUNDED_ACCOUNTING_MODE },
    familyC: { ...paperExecutionPolicy(state).familyC, stakeMode: FUNDED_ACCOUNTING_MODE },
    stakeModeA: FUNDED_ACCOUNTING_MODE, stakeModeC: FUNDED_ACCOUNTING_MODE,
    stakePercentByConfidence: { LOW: 1, MEDIUM: 3, HIGH: 5 },
    budgetBase: 'AVAILABLE_AT_BATCH_START' };
}

export function isFundedPolicy(policy: any): boolean {
  return policy?.version === FUNDED_POLICY_VERSION && policy.virtualOnly === true
    && policy.stakeModeA === FUNDED_ACCOUNTING_MODE && policy.stakeModeC === FUNDED_ACCOUNTING_MODE
    && policy.familyA?.stakeMode === FUNDED_ACCOUNTING_MODE && policy.familyC?.stakeMode === FUNDED_ACCOUNTING_MODE
    && policy.budgetBase === 'AVAILABLE_AT_BATCH_START' && policy.stakePercentByConfidence?.LOW === 1
    && policy.stakePercentByConfidence?.MEDIUM === 3 && policy.stakePercentByConfidence?.HIGH === 5
    && Object.keys(policy.stakePercentByConfidence).length === 3 && policy.fixedStakeUnits === undefined
    && policy.maxExposureFraction === undefined && policy.maxBetsPerMatchPerFamily === undefined
    && policy.quoteMaxAgeMs === 300000 && policy.independentCalibrationRequired === false
    && policy.familyA?.source === 'PredictionService' && policy.familyC?.source === 'ResearchRuntime'
    && typeof policy.familyC?.modelVersion === 'string' && !!policy.familyC.modelVersion.trim();
}

export const DYNAMIC_FUNDED_POLICY_VERSION = 'funded-dynamic-stake-v1';
export const DYNAMIC_STAKE_MODE = 'MODEL_RECOMMENDED_PERCENT';
export function dynamicFundedPolicyFromParent(parent: ReturnType<typeof paperExecutionPolicy> | any) {
  const { fixedStakeUnits: _fixed, stakePercentByConfidence: _percent, ...base } = parent;
  return { ...base, version: DYNAMIC_FUNDED_POLICY_VERSION,
    familyA: { ...parent.familyA, stakeMode: DYNAMIC_STAKE_MODE },
    familyC: { ...parent.familyC, stakeMode: DYNAMIC_STAKE_MODE },
    stakeModeA: DYNAMIC_STAKE_MODE, stakeModeC: DYNAMIC_STAKE_MODE, budgetBase: 'EQUITY_AT_BATCH_START' };
}
export function dynamicFundedExecutionPolicy(state: ChallengerExecutionState) {
  return dynamicFundedPolicyFromParent(paperExecutionPolicy(state));
}
export function isDynamicFundedPolicy(policy: any): boolean {
  return policy?.version === DYNAMIC_FUNDED_POLICY_VERSION && policy.virtualOnly === true
    && policy.stakeModeA === DYNAMIC_STAKE_MODE && policy.stakeModeC === DYNAMIC_STAKE_MODE
    && policy.familyA?.stakeMode === DYNAMIC_STAKE_MODE && policy.familyC?.stakeMode === DYNAMIC_STAKE_MODE
    && policy.budgetBase === 'EQUITY_AT_BATCH_START' && policy.fixedStakeUnits === undefined
    && policy.stakePercentByConfidence === undefined && policy.maxExposureFraction === undefined
    && policy.maxBetsPerMatchPerFamily === undefined && policy.quoteMaxAgeMs === 300000
    && policy.independentCalibrationRequired === false && policy.familyA?.source === 'PredictionService'
    && policy.familyC?.source === 'ResearchRuntime' && typeof policy.familyC?.modelVersion === 'string'
    && !!policy.familyC.modelVersion.trim();
}

export function recommendationQuoteReason(quote: RecommendationQuote, now: Date, family: 'A' | 'C' = 'C'): string | null {
  if (!quote || quote.source !== 'odds_api' || quote.priceType !== 'prematch'
    || quote.timestampEvidence === 'observed_snapshot') return 'real_prematch_quote_required';
  const freshness = quoteFreshnessReason({ ...quote, updatedAt: quote.updatedAt ?? '' }, now.getTime());
  if (freshness) return freshness;
  if (family === 'A' ? !appQuoteSettlementSupported(quote)
    : settleGoalQuote(quote as ResearchQuote, 0, 0).status === 'UNRESOLVED') return 'unsupported_quote_settlement';
  return null;
}
