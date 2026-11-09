import { BetOpportunity, MarketCategory, MarketOddsGroup, ValueAnalysisContext, ValueBettingEngine } from '../models/value/ValueBettingEngine';
import { isVisibleCanonicalTeamBet } from '../services/CanonicalBetRecommendation';
import { appRecommendationQuote, RecommendationQuote } from './AppRecommendationQuotes';
import { challengerTechnicalReason } from './ChallengerRecommendation';
import { CHALLENGER_TEAM_MARKET_POLICY } from './ChallengerMarketCoverage';
import { evaluateChallengerPayout } from './ChallengerSelection';
import { ResearchQuote } from './ResearchEvaluation';
import { recommendationQuoteReason } from './ResearchRecommendationPolicy';
import { researchHash } from './ResearchStore';
import type { ChallengerTeamInput, TeamOpportunity } from './ChallengerTeamRecommendation';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { T15Decision } from './T15Scheduler';

export const C_OPPORTUNITY_GUARD_POLICY = 'c-resolved-engine-ranking-v1';
export const C_OPPORTUNITY_GUARD_PROTOCOL = 'c-opportunity-value-guard-v1';
export function usesOpportunityGuardDecision(decision: T15Decision, expected?: { modelVersion: string; selectorPolicy?: string }): boolean {
  return expected?.selectorPolicy === C_OPPORTUNITY_GUARD_POLICY || decision.opportunityGuard !== undefined
    || (decision.probabilityConfiguration as { version?: unknown } | undefined)?.version === 'c-joint-head-probability-configuration-v1';
}
export function opportunityGuardImplementationHash(): string {
  const extension = __filename.endsWith('.ts') ? '.ts' : '.js';
  return researchHash(['COpportunityGuardRecommendation', 'ChallengerTeamRecommendation', 'ChallengerSelection',
    'ChallengerMarketCoverage', 'ResearchRecommendationPolicy', 'ChallengerRecommendation', 'T15Scheduler',
    'AppRecommendationQuotes', 'GoalSettlement', '../services/CanonicalBetRecommendation'].map(name => ({ name,
    sha256: createHash('sha256').update(readFileSync(join(__dirname, name + extension), 'utf8').replace(/\r\n/g, '\n')).digest('hex') })));
}
type Confidence = BetOpportunity['confidence'];
type Family = '1x2' | 'totals' | 'asian_handicap';
type ReliabilityFamily = { n: number; available: boolean; uncertainty: number; confidence: Confidence };
type ProfileTime = { protocol: string; frozenPlanSha256: string; modelVersion?: string; testFrom: string; maxCalibrationAvailableAt: string };
type GuardFamily = { available: boolean; G: number; Sxx: number; b: number; SE: number; support: { minX: number; maxX: number } };
export type COpportunityGuardState = {
  protocol: typeof C_OPPORTUNITY_GUARD_PROTOCOL; planSha256: string; profilesSha256: string;
  profile: ProfileTime & { modelVersion: string; families: Record<'1x2' | 'totals', GuardFamily> };
  reliabilityProfile: ProfileTime & { families: Record<Family, ReliabilityFamily> };
};
type RankingInput = { ev: number; edgeRaw: number; edgeNoVig: number; kelly: number; confidence: Confidence; odds: number;
  category: MarketCategory; uncertaintyFactor: number; riskPenalty: number; contextStrength: number; logGrowth: number;
  adaptiveRankMultiplier: number; selectionFamily?: string; competition?: string };
/** Adapt only a new C instance; the shared A engine and its prototype are never mutated. */
type NativeEngine = {
  getComplementRequirement(selection: string, category: MarketCategory): { required: number; structural: boolean };
  computeUncertaintyFactor(category: MarketCategory, odds: number, context?: ValueAnalysisContext): number;
  computeRankingScore(input: RankingInput): number;
};
export type GuardOpportunity = TeamOpportunity & { engineStakeConfidence: Confidence; engineStakeConfidenceEvidence: string;
  empiricalConfidence: Confidence; reliabilityEvidence: ReliabilityFamily; nativeRankingScore?: number; finalRankingInput: RankingInput };
type GuardRecommendationPacket = {
  policyVersion: string; selected: TeamOpportunity | null; ranked: TeamOpportunity[]; decisionStatus: 'RECOMMENDED' | 'NO_BET';
  opportunities: TeamOpportunity[]; exclusions: Record<string, number>; marketPolicyVersion: string;
  probabilityConfiguration: Record<string, unknown>; probabilityConfigurationHash: string; opportunityGuardEvidence?: Record<string, unknown>;
};

const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const stableKey = (q: RecommendationQuote) => JSON.stringify([q.market, q.side, q.line ?? null, q.team ?? null,
  q.selection, q.bookmaker, q.source, q.capturedAt]);
const economicKey = (q: RecommendationQuote) => JSON.stringify([q.market, q.side, q.line ?? null, q.team ?? null]);
const sheetKey = (q: RecommendationQuote) => JSON.stringify([q.market, q.bookmaker, q.source, q.capturedAt, q.updatedAt ?? null,
  q.market === 'asian_handicap' && q.side === 'away' ? -q.line! : q.line ?? null]);
const sidesFor = (market: string) => market === '1x2' ? ['home', 'draw', 'away'] : market === 'asian_handicap' ? ['home', 'away'] : ['over', 'under'];
const scope = (q: RecommendationQuote) => q.market === '1x2' ? '1x2' : q.market === 'totals' && q.line === 2.5 ? 'totals' : null;
const stamp = (value: unknown) => typeof value === 'string' && /(?:z|[+-]\d\d:\d\d)$/i.test(value) ? Date.parse(value) : NaN;
const hashValid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

export function selectOpportunityGuardRecommendation<T extends TeamOpportunity>(opportunities: readonly T[]) {
  const unique = new Map<string, T>();
  for (const row of [...opportunities].filter(isVisibleCanonicalTeamBet).sort((a, b) => b.bookmakerOdds - a.bookmakerOdds
    || lexical(stableKey(a.quote), stableKey(b.quote)))) {
    const key = economicKey(row.quote);
    if (!unique.has(key)) unique.set(key, row);
  }
  const ranked = [...unique.values()].filter(row => Number.isFinite(row.rankingScore))
    .sort((a, b) => b.rankingScore! - a.rankingScore! || lexical(stableKey(a.quote), stableKey(b.quote))).slice(0, 3);
  return { policyVersion: C_OPPORTUNITY_GUARD_POLICY, selected: ranked[0] ?? null, ranked,
    decisionStatus: ranked.length ? 'RECOMMENDED' as const : 'NO_BET' as const };
}

export function opportunityGuardQuality(value: unknown, observedAt: string): ValueAnalysisContext {
  const q = value as { evidenceSource?: string; evidenceAsOf?: string; hasXg?: boolean; hasPlayerData?: boolean;
    hasRefereeData?: boolean; teamSampleSize?: { home?: number; away?: number } } | undefined;
  if (!q || typeof q.evidenceSource !== 'string' || !q.evidenceSource.trim()
    || !Number.isFinite(stamp(q.evidenceAsOf)) || stamp(q.evidenceAsOf) > stamp(observedAt)
    || !Number.isSafeInteger(q.teamSampleSize?.home) || q.teamSampleSize!.home! < 0
    || !Number.isSafeInteger(q.teamSampleSize?.away) || q.teamSampleSize!.away! < 0
    || typeof q.hasXg !== 'boolean' || q.hasPlayerData !== false || q.hasRefereeData !== false) {
    throw new Error('invalid_or_future_quality_evidence');
  }
  return { hasXg: q.hasXg, hasPlayerData: false, hasRefereeData: false,
    teamSampleSize: { home: q.teamSampleSize!.home!, away: q.teamSampleSize!.away! } };
}

function availableProfile(profile: ProfileTime, protocol: string, observedAt: string) {
  return profile?.protocol === protocol && hashValid(profile.frozenPlanSha256)
    && [profile.testFrom, profile.maxCalibrationAvailableAt, observedAt].every(value => Number.isFinite(stamp(value)))
    && stamp(profile.maxCalibrationAvailableAt) < stamp(profile.testFrom)
    && stamp(profile.maxCalibrationAvailableAt) < stamp(observedAt) && stamp(profile.testFrom) <= stamp(observedAt);
}

export function opportunityGuardReliability(state: COpportunityGuardState, observedAt: string) {
  if (state?.protocol !== C_OPPORTUNITY_GUARD_PROTOCOL || !hashValid(state.planSha256) || !hashValid(state.profilesSha256)
    || !availableProfile(state.profile, 'c-opportunity-gap-guard-v1', observedAt)
    || state.profile.frozenPlanSha256 !== state.planSha256
    || !availableProfile(state.reliabilityProfile, 'c-prequential-payout-reliability-v1', observedAt)) {
    throw new Error('invalid_or_future_reliability_profile');
  }
  for (const family of ['1x2', 'totals', 'asian_handicap'] as const) {
    const item = state.reliabilityProfile.families?.[family];
    if (!item || !Number.isSafeInteger(item.n) || item.n < 0 || typeof item.available !== 'boolean'
      || !Number.isFinite(item.uncertainty) || item.uncertainty < 0 || item.uncertainty > 1
      || !['LOW', 'MEDIUM', 'HIGH'].includes(item.confidence)
      || (item.n < 30 && (item.available || item.uncertainty !== 1 || item.confidence !== 'LOW'))
      || (item.n >= 30 && (!item.available || item.confidence !== (item.uncertainty <= .05 ? 'HIGH' : item.uncertainty <= .1 ? 'MEDIUM' : 'LOW')))) {
      throw new Error('invalid_reliability_family');
    }
  }
  return state.reliabilityProfile.families;
}

function makeEngine(family: Family, reliability: ReliabilityFamily) {
  const engine = new ValueBettingEngine(), native = engine as unknown as NativeEngine;
  const complement = native.getComplementRequirement.bind(engine);
  if (family === 'asian_handicap') native.getComplementRequirement = (selection, category) =>
    selection.toLowerCase().startsWith('ahcp_') ? { required: 1, structural: true } : complement(selection, category);
  const uncertainty = native.computeUncertaintyFactor.bind(engine);
  native.computeUncertaintyFactor = (...args) => Math.max(0, Math.min(1, 1 - (1 - uncertainty(...args)) * (1 - reliability.uncertainty)));
  const ranking = native.computeRankingScore.bind(engine);
  native.computeRankingScore = input => ranking({ ...input, confidence: reliability.confidence });
  return engine;
}

function completeSheets(quotes: RecommendationQuote[]) {
  const grouped = new Map<string, RecommendationQuote[]>();
  for (const quote of quotes) { const key = sheetKey(quote); grouped.set(key, [...(grouped.get(key) ?? []), quote]); }
  const complete: RecommendationQuote[][] = [];
  for (const sheet of grouped.values()) {
    const expected = sidesFor(sheet[0].market), distinct = new Map<string, RecommendationQuote>();
    let conflict = false;
    for (const quote of sheet) {
      const prior = distinct.get(quote.side);
      if (!expected.includes(quote.side) || prior && (prior.odds !== quote.odds || prior.selection !== quote.selection)) conflict = true;
      else distinct.set(quote.side, quote);
    }
    if (!conflict && expected.every(side => distinct.has(side))) complete.push(expected.map(side => distinct.get(side)!));
  }
  return complete;
}

export function evaluateOpportunityGuard(opportunity: TeamOpportunity, matrix: number[][], quotes: RecommendationQuote[], state: COpportunityGuardState) {
  const family = scope(opportunity.quote);
  if (!family) return { accepted: true, reason: 'outside_binary_scope' };
  const f = state.profile.families?.[family];
  if (!f?.available || f.G < 30 || !(f.Sxx > 1e-12) || !Number.isFinite(f.b) || !Number.isFinite(f.SE) || f.SE < 0
    || !Number.isFinite(f.support?.minX) || !Number.isFinite(f.support?.maxX)) return { accepted: false, reason: 'profile_unavailable' };
  const observations: { p: number; q: number; x: number }[] = [];
  for (const sheet of completeSheets(quotes.filter(quote => scope(quote)))) {
    const inverseSum = sheet.reduce((sum, quote) => sum + 1 / quote.odds, 0);
    for (const quote of sheet) if (stableKey(quote) === stableKey(opportunity.quote) && quote.odds === opportunity.quote.odds) {
      const payout = evaluateChallengerPayout(matrix, quote as ResearchQuote);
      if (Math.abs(payout.activeStake - 1) > 1e-10) return { accepted: false, reason: 'invalid_binary_data' };
      const p = payout.outcomes.find(outcome => outcome.status === 'WON')!.probability;
      const q = (1 / quote.odds) / inverseSum;
      observations.push({ p, q, x: (p - q) / .1 });
    }
  }
  if (observations.length !== 1) return { accepted: false, reason: 'missing_or_ambiguous_sheet' };
  const { p, q, x } = observations[0];
  if (x < f.support.minX - 1e-12 || x > f.support.maxX + 1e-12) return { accepted: false, reason: 'outside_training_support', p, q, gap: p - q, x };
  const biasUpper = Math.max(0, f.b * x + 1.96 * Math.abs(x) * f.SE), lowerP = Math.max(0, p - biasUpper);
  const conservativeEV = opportunity.quote.odds * lowerP - 1;
  return { accepted: Number.isFinite(conservativeEV) && conservativeEV > 0,
    reason: conservativeEV > 0 ? 'positive_conservative_ev' : 'nonpositive_conservative_ev', p, q, gap: p - q, x,
    b: f.b, SE: f.SE, biasUpper, lowerP, conservativeEV };
}

export function buildCOpportunityGuardRecommendation(input: ChallengerTeamInput): GuardRecommendationPacket {
  const state = input.decision.opportunityGuard as COpportunityGuardState;
  const probabilityConfiguration: Record<string, unknown> = { version: 'c-opportunity-guard-probability-configuration-v1', family: 'C',
    marketPolicyVersion: CHALLENGER_TEAM_MARKET_POLICY, goalConfiguration: input.decision.probabilityConfiguration,
    goalConfigurationHash: input.decision.probabilityConfigurationHash,
    opportunityGuard: { protocol: state?.protocol, planSha256: state?.planSha256, profilesSha256: state?.profilesSha256 } };
  const exclusions: Record<string, number> = {}, opportunities: TeamOpportunity[] = [];
  const rejected: Array<Record<string, unknown>> = [];
  const result = () => ({ ...selectOpportunityGuardRecommendation(opportunities), opportunities, exclusions,
    marketPolicyVersion: CHALLENGER_TEAM_MARKET_POLICY, probabilityConfiguration,
    probabilityConfigurationHash: researchHash(probabilityConfiguration), opportunityGuardEvidence: {
      protocol: C_OPPORTUNITY_GUARD_PROTOCOL, planSha256: state?.planSha256, profilesSha256: state?.profilesSha256,
      profileModelVersion: state?.profile?.modelVersion, rejected } });
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const failure = challengerTechnicalReason(input.decision, input.observedAt, input.expectedIdentity);
  if (failure) { exclude(failure); return result(); }
  let evidence: Record<Family, ReliabilityFamily>, quality: ValueAnalysisContext;
  try { evidence = opportunityGuardReliability(state, input.observedAt); quality = opportunityGuardQuality(input.decision.opportunityGuardQuality, input.observedAt); }
  catch (error) { exclude(error instanceof Error ? error.message : 'opportunity_guard_configuration_invalid'); return result(); }
  const usable: RecommendationQuote[] = [];
  for (const quote of input.quotes) {
    const invalid = recommendationQuoteReason(quote, new Date(input.observedAt), 'C', CHALLENGER_TEAM_MARKET_POLICY);
    if (invalid) { exclude(invalid); continue; }
    if (!['1x2', 'totals', 'asian_handicap'].includes(quote.market) || quote.market === 'totals' && quote.line !== 2.5
      || !input.allowedMarkets.includes(quote.market)) { exclude('market_not_supported_by_opportunity_guard'); continue; }
    const parsed = appRecommendationQuote(quote.selection, quote);
    if (!parsed || parsed.market !== quote.market || parsed.side !== quote.side || parsed.line !== quote.line || parsed.team !== quote.team
      || (quote as RecommendationQuote & { usedSyntheticOdds?: boolean }).usedSyntheticOdds === true
      || stamp(quote.updatedAt) > stamp(quote.capturedAt)) { exclude('invalid_quote_provenance'); continue; }
    usable.push(quote);
  }
  const matrix = input.decision.prospectiveMatrix as number[][];
  for (const rows of completeSheets(usable)) {
    const family = rows[0].market as Family, engine = makeEngine(family, evidence[family]);
    const engineGroups = engine.buildMarketGroups(Object.fromEntries(rows.map(quote => [quote.selection, quote.odds])));
    const groups: Record<string, MarketOddsGroup> = {}, probabilities: Record<string, number> = {}, names: Record<string, string> = {};
    const payouts = new Map<string, ReturnType<typeof evaluateChallengerPayout>>();
    for (const quote of rows) {
      try {
        const payout = evaluateChallengerPayout(matrix, quote as ResearchQuote);
        if (!(payout.probability > 0 && payout.probability < 1 && payout.expectedValue > 0 && payout.activeStake > 0)) { exclude('non_positive_payout_ev'); continue; }
        probabilities[quote.selection] = payout.probability; payouts.set(quote.selection, payout); names[quote.selection] = quote.selection;
        groups[quote.selection] = { ...engineGroups[quote.selection], selection: quote.selection, odds: quote.odds,
          companions: rows.filter(other => other !== quote).map(other => other.odds) };
      } catch { exclude('invalid_quote_probability'); }
    }
    const evaluated = engine.analyzeMarketsWithVigRemoval(probabilities, groups, names, { competition: input.competition, ...quality,
      enableMarketCalibration: false, enableMarketBlending: false });
    for (const op of evaluated) {
      const quote = rows.find(row => row.selection === op.selection)!, payout = payouts.get(op.selection)!;
      if (!Number.isFinite(op.dynamicEvThreshold) || payout.expectedValue * 100 < op.dynamicEvThreshold!) { exclude('payout_ev_below_threshold'); continue; }
      const payoutStake = engine.computeSuggestedStakeWithUncertainty(payout.probability, quote.odds, payout.expectedValue, op.uncertaintyFactor);
      const confidenceOrder: Confidence[] = ['LOW', 'MEDIUM', 'HIGH'];
      const engineStakeConfidence = confidenceOrder[Math.min(confidenceOrder.indexOf(op.confidence), confidenceOrder.indexOf(payoutStake.confidence))];
      const engineSuggestedStakePercent = Math.min(op.suggestedStakePercent, payoutStake.stakePercent);
      const fraction = engineSuggestedStakePercent / 100;
      const logGrowth = payout.outcomes.reduce((sum, outcome) => sum + outcome.probability * Math.log1p(fraction * (outcome.returnMultiplier - 1)), 0);
      if (!Number.isFinite(logGrowth) || logGrowth <= 0) { exclude('non_positive_expected_log_growth'); continue; }
      const confidence = evidence[family].confidence;
      const rankingInput: RankingInput = { ev: payout.expectedValue, edgeRaw: op.edge / 100, edgeNoVig: op.edgeNoVig / 100,
        kelly: op.kellyFraction / 100, confidence, odds: op.bookmakerOdds, category: op.marketCategory,
        uncertaintyFactor: op.uncertaintyFactor!, riskPenalty: op.riskPenalty!, contextStrength: op.contextStrength!, logGrowth,
        adaptiveRankMultiplier: op.adaptiveRankMultiplier!, selectionFamily: op.selectionFamily, competition: input.competition };
      const numeric: Array<keyof RankingInput> = ['ev', 'edgeRaw', 'edgeNoVig', 'kelly', 'odds', 'uncertaintyFactor', 'riskPenalty', 'contextStrength', 'logGrowth', 'adaptiveRankMultiplier'];
      if (numeric.some(key => !Number.isFinite(rankingInput[key]))) { exclude('invalid_native_ranking_input'); continue; }
      const row: GuardOpportunity = { ...op, expectedValue: payout.expectedValue * 100, confidence, logGrowth,
        ...(family === 'asian_handicap' ? { marketTier: 'SECONDARY' as const } : {}), engineSuggestedStakePercent, suggestedStakePercent: 1, quote, payout,
        engineStakeConfidence, engineStakeConfidenceEvidence: 'engine_opportunity_confidence_after_market_and_complement_caps',
        empiricalConfidence: confidence, reliabilityEvidence: { ...evidence[family] }, nativeRankingScore: op.rankingScore,
        finalRankingInput: rankingInput, rankingScore: (new ValueBettingEngine() as unknown as NativeEngine).computeRankingScore(rankingInput),
        qualificationEvidence: { source: 'C_goal', modelVersion: input.decision.modelVersion,
          probabilityConfigurationHash: input.decision.probabilityConfigurationHash, opportunityGuardProtocol: state.protocol,
          opportunityGuardPlanSha256: state.planSha256, opportunityGuardProfilesSha256: state.profilesSha256 } };
      const proof = evaluateOpportunityGuard(row, matrix, usable, state);
      if (proof.accepted) opportunities.push(row);
      else { exclude(proof.reason); rejected.push({ quote, ...proof }); }
    }
  }
  return result();
}
