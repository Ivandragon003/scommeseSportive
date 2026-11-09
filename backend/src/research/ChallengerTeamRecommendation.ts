import { BetOpportunity, MarketOddsGroup, ValueBettingEngine } from '../models/value/ValueBettingEngine';
import { CanonicalRecommendationPacket, isVisibleCanonicalTeamBet, pickCanonicalBetRecommendation, rankCanonicalOpportunity } from '../services/CanonicalBetRecommendation';
import { appRecommendationQuote, RecommendationQuote } from './AppRecommendationQuotes';
import { ChallengerRecommendationInput, challengerTechnicalReason } from './ChallengerRecommendation';
import { CHALLENGER_TEAM_MARKET_POLICY, CHALLENGER_TEAM_MARKETS, isChallengerStatMarket } from './ChallengerMarketCoverage';
import { evaluateChallengerPayout } from './ChallengerSelection';
import { ResearchQuote } from './ResearchEvaluation';
import { researchHash } from './ResearchStore';
import { recommendationQuoteReason } from './ResearchRecommendationPolicy';
import { T15Decision } from './T15Scheduler';
import { buildCOpportunityGuardRecommendation, COpportunityGuardState, selectOpportunityGuardRecommendation, usesOpportunityGuardDecision } from './COpportunityGuardRecommendation';

type Specialist = { packet: CanonicalRecommendationPacket<any>; opportunities: BetOpportunity[]; matchId: string };
export type TeamOpportunity = BetOpportunity & { quote: RecommendationQuote; engineSuggestedStakePercent: number; qualificationEvidence: Record<string, unknown>; payout?: ReturnType<typeof evaluateChallengerPayout> };
type Input = Omit<ChallengerRecommendationInput, 'quotes'> & { quotes: RecommendationQuote[]; specialist?: Specialist };
export type ChallengerTeamInput = Input;

/** Identity describes the composition, while the particular A state remains in the evidence. */
export function buildChallengerTeamConfiguration(decision: T15Decision, packet?: CanonicalRecommendationPacket<any>) {
  if (usesOpportunityGuardDecision(decision)) {
    const state = decision.opportunityGuard as COpportunityGuardState;
    return { version: 'c-opportunity-guard-probability-configuration-v1', family: 'C', marketPolicyVersion: CHALLENGER_TEAM_MARKET_POLICY,
      goalConfiguration: decision.probabilityConfiguration, goalConfigurationHash: decision.probabilityConfigurationHash,
      opportunityGuard: { protocol: state?.protocol, planSha256: state?.planSha256, profilesSha256: state?.profilesSha256 } };
  }
  const model = packet?.model;
  return { version: 'c-team-probability-configuration-v1', family: 'C', marketPolicyVersion: CHALLENGER_TEAM_MARKET_POLICY,
    goalConfiguration: decision?.probabilityConfiguration, goalConfigurationHash: decision?.probabilityConfigurationHash,
    sharedSpecialistModel: model ? { source: model.source, version: model.version, codeHash: model.codeHash, configHash: model.configHash } : null };
}

const sheetKey = (q: RecommendationQuote) => JSON.stringify([q.market, q.bookmaker, q.source, q.capturedAt, q.updatedAt,
  q.market === 'asian_handicap' && q.side === 'away' ? -q.line! : q.line ?? null, q.team ?? null]);
const sidesFor = (market: string) => market === '1x2' || market === 'european_handicap' ? ['home', 'draw', 'away']
  : market === 'double_chance' ? ['1x', 'x2', '12'] : market === 'dnb' || market === 'asian_handicap' ? ['home', 'away']
    : market === 'btts' ? ['yes', 'no'] : ['over', 'under'];
const hashValid = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s);
const validModel = (p: CanonicalRecommendationPacket<any>, asOf: string) => p?.policyVersion === 'match-page-recommendation-v1'
  && p.asOf === asOf && p.model?.source === 'PredictionService' && /^APP-A-/.test(p.model.version)
  && hashValid(p.model.codeHash) && hashValid(p.model.configHash) && hashValid(p.model.stateHash) && p.odds?.source === 'odds_api';

export function buildChallengerTeamRecommendation(input: Input) {
  if (usesOpportunityGuardDecision(input.decision, input.expectedIdentity)) return buildCOpportunityGuardRecommendation(input);
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const probabilityConfiguration = buildChallengerTeamConfiguration(input.decision, input.specialist?.packet);
  const probabilityConfigurationHash = researchHash(probabilityConfiguration);
  const result = (opportunities: TeamOpportunity[]) => {
    // The canonical picker deduplicates by selection before ranking; order books by the same ranking first.
    const rankedInput = [...opportunities].sort((a, b) => Number(['HIGH', 'MEDIUM'].includes(b.confidence))
      - Number(['HIGH', 'MEDIUM'].includes(a.confidence)) || rankCanonicalOpportunity(b) - rankCanonicalOpportunity(a));
    const recommendation = pickCanonicalBetRecommendation({ valueOpportunities: rankedInput });
    return { ...recommendation, opportunities, exclusions, marketPolicyVersion: CHALLENGER_TEAM_MARKET_POLICY,
      probabilityConfiguration, probabilityConfigurationHash };
  };
  const failure = challengerTechnicalReason(input.decision, input.observedAt, input.expectedIdentity);
  if (failure) { exclude(failure); return result([]); }
  const usable: RecommendationQuote[] = [];
  for (const q of input.quotes) {
    const invalid = recommendationQuoteReason(q, new Date(input.observedAt), isChallengerStatMarket(q.market) ? 'A' : 'C');
    if (invalid) { exclude(invalid); continue; }
    if (!CHALLENGER_TEAM_MARKETS.includes(q.market as typeof CHALLENGER_TEAM_MARKETS[number])) { exclude('market_not_supported'); continue; }
    if (!input.allowedMarkets.includes(q.market)) { exclude('market_not_allowed'); continue; }
    if ((q as RecommendationQuote & { usedSyntheticOdds?: boolean }).usedSyntheticOdds || Date.parse(q.updatedAt!) > Date.parse(q.capturedAt)) { exclude('invalid_quote_provenance'); continue; }
    const parsed = appRecommendationQuote(q.selection, q);
    if (!parsed || parsed.market !== q.market || parsed.side !== q.side || parsed.line !== q.line || parsed.team !== q.team) { exclude('quote_selection_mismatch'); continue; }
    usable.push(q);
  }
  const opportunities: TeamOpportunity[] = [];
  const engine = new ValueBettingEngine();
  const sheets = new Map<string, RecommendationQuote[]>();
  for (const q of usable.filter(q => !isChallengerStatMarket(q.market))) {
    const key = sheetKey(q); sheets.set(key, [...(sheets.get(key) ?? []), q]);
  }
  for (const sheet of sheets.values()) {
    const sides = sidesFor(sheet[0].market);
    const distinct = new Map<string, RecommendationQuote>();
    let conflict = false;
    for (const q of sheet) {
      const prior = distinct.get(q.side);
      if (!sides.includes(q.side) || (prior && prior.odds !== q.odds)) conflict = true;
      else distinct.set(q.side, q);
    }
    if (conflict || sides.some(side => !distinct.has(side))) { exclude('complete_bookmaker_market_required'); continue; }
    const rows = sides.map(side => distinct.get(side)!);
    const odds = Object.fromEntries(rows.map(q => [q.selection, q.odds]));
    const engineGroups = engine.buildMarketGroups(odds);
    const groups: Record<string, MarketOddsGroup> = {};
    const probabilities: Record<string, number> = {}, names: Record<string, string> = {};
    const payouts = new Map<string, ReturnType<typeof evaluateChallengerPayout>>();
    for (const q of rows) {
      try {
        const payout = evaluateChallengerPayout(input.decision.prospectiveMatrix as number[][], q as ResearchQuote);
        if (!(payout.probability > 0 && payout.probability < 1 && payout.expectedValue > 0 && payout.activeStake > 0)) { exclude('non_positive_payout_ev'); continue; }
        probabilities[q.selection] = payout.probability; payouts.set(q.selection, payout); names[q.selection] = q.selection;
        // Double chance outcomes overlap. Never normalize their three inverse prices as an exhaustive partition.
        groups[q.selection] = q.market === 'double_chance' ? { selection: q.selection, odds: q.odds, companions: [] }
          : { ...engineGroups[q.selection], selection: q.selection, odds: q.odds,
            companions: rows.filter(other => other !== q).map(other => other.odds) };
      } catch { exclude('invalid_quote_probability'); }
    }
    const evaluated = engine.analyzeMarketsWithVigRemoval(probabilities, groups, names, { competition: input.competition,
      enableMarketCalibration: false, enableMarketBlending: false });
    for (const op of evaluated) {
      const quote = rows.find(q => q.selection === op.selection)!;
      const payout = payouts.get(op.selection)!;
      if (!Number.isFinite(op.dynamicEvThreshold) || payout.expectedValue * 100 < op.dynamicEvThreshold!) {
        exclude('payout_ev_below_threshold'); continue;
      }
      const payoutStake = engine.computeSuggestedStakeWithUncertainty(payout.probability, quote.odds,
        payout.expectedValue, op.uncertaintyFactor);
      const confidenceOrder = ['LOW', 'MEDIUM', 'HIGH'];
      const confidence = confidenceOrder[Math.min(confidenceOrder.indexOf(op.confidence), confidenceOrder.indexOf(payoutStake.confidence))] as BetOpportunity['confidence'];
      const suggestedStakePercent = Math.min(op.suggestedStakePercent, payoutStake.stakePercent);
      const fraction = suggestedStakePercent / 100;
      const logGrowth = payout.outcomes.reduce((sum, outcome) => sum + outcome.probability * Math.log1p(fraction * (outcome.returnMultiplier - 1)), 0);
      if (!Number.isFinite(logGrowth) || logGrowth <= 0) { exclude('non_positive_expected_log_growth'); continue; }
      opportunities.push({ ...op, expectedValue: payout.expectedValue * 100, confidence, logGrowth,
        engineSuggestedStakePercent: suggestedStakePercent, suggestedStakePercent: 1, quote, payout,
        qualificationEvidence: { source: 'C_goal', modelVersion: input.decision.modelVersion,
          probabilityConfigurationHash: input.decision.probabilityConfigurationHash } });
    }
  }
  const specialist = input.specialist;
  if (specialist) {
    const packet = specialist.packet;
    if (!validModel(packet, input.observedAt)) exclude('invalid_specialist_packet');
    else for (const op of specialist.opportunities) {
      const matches = usable.filter(q => isChallengerStatMarket(q.market) && q.selection === op.selection
        && packet.odds.capturedAt === q.capturedAt && packet.odds.bookmakerBySelection[q.selection] === q.bookmaker
        && Number(op.bookmakerOdds) === q.odds);
      if (matches.length !== 1) { exclude('specialist_quote_mismatch'); continue; }
      const quote = matches[0];
      const statSheet = usable.filter(q => sheetKey(q) === sheetKey(quote));
      const bySide = new Map<string, RecommendationQuote>();
      let conflict = false;
      for (const q of statSheet) {
        const prior = bySide.get(q.side);
        if (!['over', 'under'].includes(q.side) || (prior && prior.odds !== q.odds)) conflict = true;
        else bySide.set(q.side, q);
      }
      if (conflict || !bySide.has('over') || !bySide.has('under')) { exclude('complete_bookmaker_market_required'); continue; }
      const expectedCategory = quote.market === 'shots_on_target' ? 'shots_ot' : quote.market === 'cards_total' ? 'yellow_cards' : quote.market;
      if (op.marketCategory !== expectedCategory) { exclude('specialist_market_mismatch'); continue; }
      if (!Number.isFinite(quote.line) || !Number.isInteger(quote.line! - .5)) { exclude('specialist_integer_line_unsupported'); continue; }
      const probability = packet.probabilities?.decision?.[op.selection];
      if (!isVisibleCanonicalTeamBet(op) || op.isValueBet !== true || op.evReason !== 'computed'
        || !Number.isFinite(probability) || probability <= 0 || probability >= 1
        || Math.abs(probability - op.ourProbability / 100) > 1e-8 || !(op.expectedValue > 0)
        || !(op.edgeNoVig > 0) || !(op.suggestedStakePercent > 0)
        || (op.matchId && op.matchId !== specialist.matchId)) { exclude('specialist_not_qualified'); continue; }
      opportunities.push({ ...op, quote, engineSuggestedStakePercent: op.suggestedStakePercent, suggestedStakePercent: 1,
        qualificationEvidence: { source: 'shared_A_specialist', asOf: packet.asOf, model: { ...packet.model },
          calibrationStatus: op.categoryCalibrationStatus, calibrationSampleSize: op.calibrationSampleSize,
          calibrationReliability: op.calibrationReliability, sampleSize: op.sampleSize, dataQuality: op.dataQuality,
          dataWarnings: op.dataWarnings } });
    }
  }
  return result(opportunities);
}

/** The same global ordering is used by Nightly and the match preview. */
export function selectChallengerTeamRecommendation(decision: T15Decision, opportunities: readonly TeamOpportunity[], expected?: { modelVersion: string; selectorPolicy?: string }) {
  if (usesOpportunityGuardDecision(decision, expected)) return selectOpportunityGuardRecommendation(opportunities);
  const ordered = [...opportunities].sort((a, b) => Number(['HIGH', 'MEDIUM'].includes(b.confidence))
    - Number(['HIGH', 'MEDIUM'].includes(a.confidence)) || rankCanonicalOpportunity(b) - rankCanonicalOpportunity(a));
  return pickCanonicalBetRecommendation({ valueOpportunities: ordered });
}
