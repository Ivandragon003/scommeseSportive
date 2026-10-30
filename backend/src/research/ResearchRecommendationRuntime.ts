import { DatabaseService } from '../db/DatabaseService';
import { ValueBettingEngine, MarketOddsGroup, BetOpportunity } from '../models/value/ValueBettingEngine';
import { PredictionService } from '../services/PredictionService';
import { OddsApiService } from '../services/OddsApiService';
import { getConfiguredOddsApiKey } from '../services/odds-provider/providerRuntimeConfig';
import { CanonicalRecommendationPacket, pickCanonicalBetRecommendation,
  SharedPredictionOdds, CANONICAL_RECOMMENDATION_POLICY } from '../services/CanonicalBetRecommendation';
import { ResearchRuntime, matchingResearchEvent, researchQuotesFromEvent } from './ResearchRuntime';
import { ResearchQuote, quoteForecast } from './ResearchEvaluation';
import { normalizeScoreMatrix, scoreMatrixMarkets } from './GoalSettlement';
import { COHERENT_PROBABILITY_PROTOCOL, coherentProbabilityPipelineHash } from './CoherentProbabilityPipeline';
import { researchHash } from './ResearchStore';
import type { RecommendationJob, RecommendationCommit, RecommendationDecision } from './ResearchRecommendationStore';
import { recommendationQuoteReason, RECOMMENDATION_BASELINE_C, RECOMMENDATION_MODEL_C,
  VIRTUAL_RECOMMENDATION_POLICY } from './ResearchRecommendationPolicy';
import { PreparedT15Job, T15Decision, safeOddsFailureCode } from './T15Scheduler';

type ResearchPreparation = Pick<ResearchRuntime, 'prepareNightly' | 'beginNightlyCohort' | 'getQuotaStatus'>;
type AppPrediction = Pick<PredictionService, 'predict'>;
type OddsFeed = Pick<OddsApiService, 'getOdds' | 'getQuotaStatus'>;
const finiteProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
const hashValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const keyOf = (quote: ResearchQuote): string => [quote.market, quote.bookmaker, quote.source, quote.capturedAt,
  quote.market === 'asian_handicap' && quote.side === 'away' ? -quote.line! : quote.line ?? '', quote.team ?? ''].join('|');

export function challengerTechnicalReason(decision: T15Decision | undefined, observedAt: string): string | null {
  if (!decision?.validated) return 'challenger_technical_validation_failed';
  if (decision.modelVersion !== RECOMMENDATION_MODEL_C) return 'challenger_model_version_mismatch';
  if (decision.probabilityProtocol !== COHERENT_PROBABILITY_PROTOCOL
    || decision.calibrationPipelineHash !== coherentProbabilityPipelineHash()) return 'challenger_pipeline_mismatch';
  const configuration = object(decision.probabilityConfiguration);
  if (configuration.family !== 'C' || configuration.baselineVersion !== RECOMMENDATION_BASELINE_C
    || researchHash(configuration) !== decision.probabilityConfigurationHash) return 'challenger_configuration_mismatch';
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
export function buildChallengerRecommendation(input: { decision: T15Decision; quotes: ResearchQuote[];
  observedAt: string; competition?: string; allowedMarkets: string[] }) {
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const technicalFailure = challengerTechnicalReason(input.decision, input.observedAt);
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

/** Prepares immutable packets only. Claiming, registry initialization and money admission belong to the orchestrator/store. */
export class ResearchRecommendationRuntime {
  private readonly clock: () => Date;
  private readonly researchRuntime: ResearchPreparation;
  private readonly predictionService: AppPrediction;
  private fallbackOdds: OddsFeed | undefined;
  constructor(private readonly db: DatabaseService, options: { clock?: () => Date; researchRuntime?: ResearchPreparation;
    predictionService?: AppPrediction; odds?: OddsFeed } = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.researchRuntime = options.researchRuntime ?? new ResearchRuntime(db, { clock: this.clock, odds: options.odds,
      nightly: { quoteMaxAgeMs: VIRTUAL_RECOMMENDATION_POLICY.quoteMaxAgeMs, minEv: .04, minPrudentialEv: .01 },
      candidateVersionC: RECOMMENDATION_MODEL_C });
    this.predictionService = options.predictionService ?? new PredictionService(db);
    this.fallbackOdds = options.odds;
  }
  beginCohort(runId: string): void { this.researchRuntime.beginNightlyCohort(runId); }
  getQuotaStatus(): unknown { return this.fallbackOdds?.getQuotaStatus() ?? this.researchRuntime.getQuotaStatus(); }

  async prepare(job: RecommendationJob): Promise<RecommendationCommit> {
    const row = await this.db.getMatchById(job.matchId);
    const at = this.clock().toISOString();
    if (!row || row.home_goals != null || row.away_goals != null || Date.parse(row.date) !== Date.parse(job.kickoffAt)
      || Date.parse(at) >= Date.parse(row.date) || Date.parse(at) < Date.parse(job.windowStartAt)
      || Date.parse(at) >= Date.parse(job.windowEndAt)) throw new Error('recommendation_fixture_not_eligible');
    let prepared: PreparedT15Job | undefined;
    let preparationFailure: string | null = null;
    try { prepared = await this.researchRuntime.prepareNightly({ ...job, targetAt: job.windowStartAt }); }
    catch (error) {
      if (safeOddsFailureCode(error)) throw error;
      preparationFailure = 'research_forecast_unavailable';
    }
    let quotes = (prepared?.quotes ?? []) as ResearchQuote[];
    let metadata = prepared?.inputSnapshot as Record<string, any> | undefined;
    if (!prepared) {
      // C's technical failure must not veto app A. An earlier successful fetch is reused through the same persistent cache.
      this.fallbackOdds ??= new OddsApiService(getConfiguredOddsApiKey(), { store: this.db.oddsRequests,
        operation: 'nightly', priority: 'essential', cacheMaxAgeMs: VIRTUAL_RECOMMENDATION_POLICY.quoteMaxAgeMs });
      const events = await this.fallbackOdds.getOdds(row.competition, ['h2h', 'totals', 'spreads']);
      const event = matchingResearchEvent(row, events);
      if (event && !event.live && !event.completed && Date.parse(event.commenceTime) === Date.parse(row.date)) {
        quotes = researchQuotesFromEvent(event, event.capturedAt ?? at).map((quote) => ({ ...quote, priceType: 'prematch' }));
        metadata = { providerEventId: event.matchId, providerKickoffAt: event.commenceTime };
      }
    }
    if (prepared && (prepared.status !== 'upcoming' || Date.parse(prepared.kickoffAt) !== Date.parse(job.kickoffAt))) {
      throw new Error('recommendation_fixture_changed');
    }
    const observedAt = this.clock().toISOString();
    if (Date.parse(observedAt) >= Date.parse(job.kickoffAt) || Date.parse(observedAt) >= Date.parse(job.windowEndAt)) {
      throw new Error('recommendation_fixture_not_eligible');
    }
    const usableQuotes = quotes.filter((quote) => !recommendationQuoteReason(quote, new Date(observedAt)));
    const sharedOdds: SharedPredictionOdds = { odds: Object.fromEntries(usableQuotes.map((quote) => [quote.selection, quote.odds])),
      bookmakerBySelection: Object.fromEntries(usableQuotes.map((quote) => [quote.selection, quote.bookmaker])),
      source: 'odds_api', capturedAt: usableQuotes.length
        ? new Date(Math.min(...usableQuotes.map((quote) => Date.parse(quote.capturedAt)))).toISOString() : observedAt };
    let packetA: CanonicalRecommendationPacket | null = null;
    let appFailure: string | null = usableQuotes.length ? null : 'real_fresh_quotes_unavailable';
    if (!appFailure) {
      try {
        const prediction = await this.predictionService.predict({ homeTeamId: row.home_team_id, awayTeamId: row.away_team_id,
          matchId: job.matchId, competition: row.competition, season: row.season },
        { asOf: observedAt, recordAudit: false, sharedOdds });
        packetA = prediction.canonicalRecommendation;
      } catch { appFailure = 'app_prediction_unavailable'; }
    }
    const decisions: RecommendationDecision[] = [];
    const abstain = (family: 'A' | 'C', modelVersion: string, reason: string): RecommendationDecision => ({
      family, modelVersion, originDecisionId: job.originDecisionIds[family], action: 'ABSTAIN', reason, recommended: false, validated: false,
    });
    const selectedA = packetA?.selected;
    const modelA = packetA?.model;
    if (!appFailure && (!packetA || packetA.policyVersion !== CANONICAL_RECOMMENDATION_POLICY
      || packetA.asOf !== observedAt || modelA?.source !== 'PredictionService' || !/^APP-A-[a-f0-9]+$/.test(modelA.version)
      || ![modelA.codeHash, modelA.configHash, modelA.stateHash].every(hashValid))) appFailure = 'invalid_app_recommendation_packet';
    const rawAppProbabilities = packetA?.probabilities?.raw ?? {};
    const decisionAppProbabilities = packetA?.probabilities?.decision ?? {};
    const appChecks = {
      inference: !!packetA,
      policy: packetA?.policyVersion === CANONICAL_RECOMMENDATION_POLICY,
      source: modelA?.source === 'PredictionService',
      modelIdentity: !!modelA && /^APP-A-[a-f0-9]+$/.test(modelA.version)
        && [modelA.codeHash, modelA.configHash, modelA.stateHash].every(hashValid),
      forecastTime: packetA?.asOf === observedAt && Date.parse(observedAt) < Date.parse(job.kickoffAt),
      sharedSnapshot: packetA?.odds?.source === 'odds_api' && packetA.odds.capturedAt === sharedOdds.capturedAt
        && Object.entries(sharedOdds.bookmakerBySelection).every(([selection, bookmaker]) => packetA.odds.bookmakerBySelection?.[selection] === bookmaker),
      finiteProbabilities: !!packetA && Object.keys(rawAppProbabilities).length > 0
        && [...Object.values(rawAppProbabilities), ...Object.values(decisionAppProbabilities)]
          .every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
      selectionProbability: !selectedA || finiteProbability(Number(selectedA.ourProbability) / 100),
      selectionProvenance: !selectedA || usableQuotes.some((quote) => quote.selection === selectedA.selection
        && quote.odds === Number(selectedA.bookmakerOdds) && packetA?.odds?.bookmakerBySelection?.[quote.selection] === quote.bookmaker),
    };
    if (!appFailure && !Object.values(appChecks).every(Boolean)) appFailure = 'invalid_app_recommendation_packet';
    if (!appFailure && selectedA) {
      const quote = usableQuotes.find((value) => value.selection === selectedA.selection
        && value.odds === Number(selectedA.bookmakerOdds) && packetA?.odds?.bookmakerBySelection?.[value.selection] === value.bookmaker);
      const probability = Number(selectedA.ourProbability) / 100;
      if (!quote || packetA?.odds?.source !== 'odds_api') appFailure = 'app_recommendation_quote_mismatch';
      else if (!finiteProbability(probability) || !Number.isFinite(Number(selectedA.expectedValue)) || Number(selectedA.expectedValue) <= 0
        || !Number.isFinite(Number(selectedA.suggestedStakePercent)) || Number(selectedA.suggestedStakePercent) <= 0) appFailure = 'invalid_app_recommendation_value';
      else {
        const configuration = { version: 'app-probability-configuration-v1', family: 'A', source: modelA!.source,
          modelVersion: modelA!.version, codeHash: modelA!.codeHash, configHash: modelA!.configHash };
        decisions.push({ family: 'A', modelVersion: modelA!.version, originDecisionId: job.originDecisionIds.A,
          action: 'BET', market: quote.market, selection: quote.selection, quote, probability,
          ev: Number(selectedA.expectedValue) / 100, suggestedStakePercent: Number(selectedA.suggestedStakePercent),
          confidence: selectedA.confidence, recommended: true, validated: true,
          probabilityConfiguration: configuration, probabilityConfigurationHash: researchHash(configuration) });
      }
    }
    if (!decisions.length) decisions.push(abstain('A', modelA?.version ?? 'APP-A-unavailable', appFailure ?? 'app_no_recommendation'));
    const decisionC = prepared?.decisions.find((decision) => decision.family === 'C');
    const failureC = preparationFailure ?? challengerTechnicalReason(decisionC, observedAt);
    let packetC: ReturnType<typeof buildChallengerRecommendation> | null = null;
    if (!failureC && decisionC) {
      const markets = await this.db.research.listMarkets({ family: 'C', modelVersion: decisionC.modelVersion });
      packetC = buildChallengerRecommendation({ decision: decisionC, quotes: usableQuotes, observedAt, competition: row.competition,
        allowedMarkets: markets.filter((market) => ['EXPERIMENTAL', 'SHADOW', 'ACTIVE'].includes(market.state)).map((market) => market.market) });
      const selected = packetC.selected;
      const quote = selected && usableQuotes.find((value) => value.selection === selected.selection && value.odds === selected.bookmakerOdds);
      if (selected && quote && finiteProbability(selected.ourProbability / 100) && selected.expectedValue > 0) {
        decisions.push({ family: 'C', modelVersion: decisionC.modelVersion, originDecisionId: job.originDecisionIds.C,
          action: 'BET', market: quote.market, selection: quote.selection, quote,
          probability: selected.ourProbability / 100, ev: selected.expectedValue / 100,
          suggestedStakePercent: 1, confidence: selected.confidence, recommended: true, validated: true,
          probabilityConfiguration: object(decisionC.probabilityConfiguration),
          probabilityConfigurationHash: String(decisionC.probabilityConfigurationHash) });
      }
    }
    if (decisions.length === 1) decisions.push(abstain('C', decisionC?.modelVersion ?? 'C-unavailable', failureC
      ?? (packetC?.exclusions.non_binary_payout_not_supported_by_canonical_engine ? 'non_binary_payout_not_supported_by_canonical_engine' : 'challenger_no_recommendation')));
    const modelDescriptorA = modelA ? { source: modelA.source, version: modelA.version,
      codeHash: modelA.codeHash, configHash: modelA.configHash } : null;
    if (!appFailure && modelDescriptorA) {
      await this.db.research.saveModel({ family: 'A', version: modelDescriptorA.version, artifact: modelDescriptorA });
      const existing = await this.db.research.listMarkets({ family: 'A', modelVersion: modelDescriptorA.version });
      for (const market of [...new Set(usableQuotes.map((quote) => quote.market))]) {
        if (!existing.some((entry) => entry.market === market)) await this.db.research.setMarketState({
          family: 'A', modelVersion: modelDescriptorA.version, market, state: 'EXPERIMENTAL',
          reason: 'App recommendation virtual execution; no economic promotion',
        });
      }
    }
    const appHealthy = Object.values(appChecks).every(Boolean);
    await this.db.saveSchedulerRun({ schedulerName: 'research_model_check', trigger: 'remote', startedAt: observedAt,
      endedAt: this.clock().toISOString(), success: appHealthy,
      summary: { family: 'A', source: 'PredictionService', modelVersion: modelA?.version ?? 'APP-A-unavailable',
        executionContext: job.preview === true ? 'recommendations-preview' : 'virtual-recommendation',
        jobId: job.id, runId: job.runId, matchId: job.matchId, checks: appChecks,
        snapshotHash: researchHash({ observedAt, model: modelA ?? null, quotes: usableQuotes }),
        ...(!appHealthy ? { errorCode: appFailure ?? 'invalid_app_recommendation_packet' } : {}) } });
    const finalObservedAt = this.clock().toISOString();
    if (Date.parse(finalObservedAt) >= Date.parse(job.kickoffAt) || Date.parse(finalObservedAt) >= Date.parse(job.windowEndAt)) {
      throw new Error('recommendation_fixture_not_eligible');
    }
    for (let index = 0; index < decisions.length; index++) {
      const decision = decisions[index];
      if (decision.action !== 'BET') continue;
      const invalid = recommendationQuoteReason(decision.quote as ResearchQuote, new Date(finalObservedAt));
      if (invalid) decisions[index] = abstain(decision.family, decision.modelVersion, invalid);
    }
    return { jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
      inputSnapshot: { observedAt: finalObservedAt, quotes, match: metadata?.match ?? { matchId: job.matchId,
        competition: row.competition, kickoffAt: row.date, homeTeamName: row.home_team_name, awayTeamName: row.away_team_name },
      metadata: { ...metadata, policy: VIRTUAL_RECOMMENDATION_POLICY,
        originInputId: job.originInputId, diagnosticResearchA: true },
      modelDescriptorA,
      forecasts: { A: packetA, C: { decision: decisionC ?? null, recommendation: packetC } } }, decisions };
  }
}
