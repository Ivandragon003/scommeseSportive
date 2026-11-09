import { DatabaseService } from '../db/DatabaseService';
import { PredictionService } from '../services/PredictionService';
import { OddsApiService } from '../services/OddsApiService';
import { AppPredictionOddsService } from '../services/AppPredictionOddsService';
import { CanonicalRecommendationPacket,
  SharedPredictionOdds, CANONICAL_RECOMMENDATION_POLICY, isVisibleCanonicalTeamBet } from '../services/CanonicalBetRecommendation';
import { ResearchRuntime } from './ResearchRuntime';
import { RecommendationQuote } from './AppRecommendationQuotes';
import type { ResearchQuote } from './ResearchEvaluation';
import { buildChallengerRecommendation, challengerTechnicalReason } from './ChallengerRecommendation';
import { researchHash } from './ResearchStore';
import type { RecommendationJob, RecommendationCommit, RecommendationDecision } from './ResearchRecommendationStore';
import { recommendationQuoteReason,
  VIRTUAL_RECOMMENDATION_POLICY, ChallengerExecutionState, challengerExecutionPolicy, fallbackChallengerState, paperExecutionPolicy, fundedExecutionPolicy, dynamicFundedExecutionPolicy } from './ResearchRecommendationPolicy';
import { bestPaperSelections, paperSelectionKey } from './PaperBetSelections';
import { PreparedT15Job, safeOddsFailureCode } from './T15Scheduler';
import { CHALLENGER_DATA_QUALITY_POLICY_HASH } from './ChallengerDataQuality';
import { CHALLENGER_TEAM_MARKET_POLICY, challengerAllowedMarkets, isChallengerStatMarket, usesChallengerTeamMarkets } from './ChallengerMarketCoverage';
import { buildChallengerTeamRecommendation, buildChallengerTeamConfiguration, selectChallengerTeamRecommendation } from './ChallengerTeamRecommendation';
import { C_OPPORTUNITY_GUARD_POLICY, usesOpportunityGuardDecision } from './COpportunityGuardRecommendation';
import type { AdmissionMarket, FixtureAdmissionResult } from './FixtureAdmission';

export type FixtureAdmissionCheck = (matchId: string, asOf: string, deployment?: ChallengerExecutionState) => Promise<FixtureAdmissionResult>;
const admissionMarket = (market: string): AdmissionMarket => market === 'cards_total' ? 'booking_points'
  : ['shots', 'shots_on_target', 'yellow_cards'].includes(market) ? market as AdmissionMarket
    : market.startsWith('player_') ? 'player_props' : 'goal';

type ResearchPreparation = Pick<ResearchRuntime, 'prepareNightly' | 'beginNightlyCohort' | 'getQuotaStatus'>
  & Partial<Pick<ResearchRuntime, 'pinChallengerDeployment'>>;
type AppPrediction = Pick<PredictionService, 'predict'>;
type OddsFeed = Pick<OddsApiService, 'getOdds' | 'getQuotaStatus'>;
type AppOddsFeed = Pick<AppPredictionOddsService, 'load' | 'getQuotaStatus'>;
const finiteProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
const hashValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
/** Prepares immutable packets only. Claiming, registry initialization and money admission belong to the orchestrator/store. */
export class ResearchRecommendationRuntime {
  private readonly clock: () => Date;
  private readonly researchRuntime: ResearchPreparation;
  private readonly predictionService: AppPrediction;
  private readonly appOdds: AppOddsFeed;
  private readonly fixtureAdmission?: FixtureAdmissionCheck;
  private deploymentC: ChallengerExecutionState;
  private executionPolicy: ReturnType<typeof challengerExecutionPolicy> | ReturnType<typeof paperExecutionPolicy> | ReturnType<typeof fundedExecutionPolicy> | ReturnType<typeof dynamicFundedExecutionPolicy>;
  private readonly paperMode: boolean;
  private readonly fundedMode: boolean;
  private readonly dynamicMode: boolean;
  constructor(private readonly db: DatabaseService, options: { clock?: () => Date; researchRuntime?: ResearchPreparation;
    predictionService?: AppPrediction; odds?: OddsFeed; appOdds?: AppOddsFeed;
    deploymentC?: ChallengerExecutionState; fixtureAdmission?: FixtureAdmissionCheck;
    requireExistingCalibration?: boolean; allowChampionRollback?: boolean; collectChallengerForecasts?: boolean; paperMode?: boolean; fundedMode?: boolean; dynamicMode?: boolean } = {}) {
    this.clock = options.clock ?? (() => new Date());
    if ([options.paperMode, options.fundedMode, options.dynamicMode].filter(Boolean).length > 1) throw new Error('Conflicting recommendation accounting modes');
    this.fundedMode = options.fundedMode === true;
    this.dynamicMode = options.dynamicMode === true;
    this.paperMode = options.paperMode === true || this.fundedMode || this.dynamicMode;
    this.deploymentC = options.deploymentC ?? fallbackChallengerState();
    this.executionPolicy = this.dynamicMode ? dynamicFundedExecutionPolicy(this.deploymentC) : this.fundedMode ? fundedExecutionPolicy(this.deploymentC) : this.paperMode ? paperExecutionPolicy(this.deploymentC) : challengerExecutionPolicy(this.deploymentC);
    this.researchRuntime = options.researchRuntime ?? new ResearchRuntime(db, { clock: this.clock, odds: options.odds,
      nightly: { quoteMaxAgeMs: VIRTUAL_RECOMMENDATION_POLICY.quoteMaxAgeMs, minEv: .04, minPrudentialEv: .01 },
      paperMode: this.paperMode,
      candidateVersionC: this.deploymentC.deployment.modelVersion, deploymentC: this.deploymentC.deployment,
      allowChampionRollback: options.allowChampionRollback, collectChallengerForecasts: options.collectChallengerForecasts });
    this.researchRuntime.pinChallengerDeployment?.(this.deploymentC.deployment);
    this.fixtureAdmission = options.fixtureAdmission;
    this.predictionService = options.predictionService ?? new PredictionService(db, undefined,
      { allowCalibrationRebuild: options.requireExistingCalibration !== true });
    this.appOdds = options.appOdds ?? new AppPredictionOddsService(db, { clock: this.clock });
  }
  beginCohort(runId: string, deploymentC?: ChallengerExecutionState): void {
    if (deploymentC) {
      this.deploymentC = deploymentC;
      this.executionPolicy = this.dynamicMode ? dynamicFundedExecutionPolicy(deploymentC) : this.fundedMode ? fundedExecutionPolicy(deploymentC) : this.paperMode ? paperExecutionPolicy(deploymentC) : challengerExecutionPolicy(deploymentC);
      this.researchRuntime.pinChallengerDeployment?.(deploymentC.deployment);
    }
    this.researchRuntime.beginNightlyCohort(runId);
  }
  getQuotaStatus(): unknown { return this.appOdds.getQuotaStatus() ?? this.researchRuntime.getQuotaStatus(); }

  async prepare(job: RecommendationJob): Promise<RecommendationCommit> {
    const row = await this.db.getMatchById(job.matchId);
    const at = this.clock().toISOString();
    if (!row || row.home_goals != null || row.away_goals != null || Date.parse(row.date) !== Date.parse(job.kickoffAt)
      || Date.parse(at) >= Date.parse(row.date) || Date.parse(at) < Date.parse(job.windowStartAt)
      || Date.parse(at) >= Date.parse(job.windowEndAt)) throw new Error('recommendation_fixture_not_eligible');
    const admission = await this.fixtureAdmission?.(job.matchId, at, this.deploymentC);
    const opportunityGuardC = this.deploymentC.deployment.selectorPolicy === C_OPPORTUNITY_GUARD_POLICY;
    const teamMarketsC = opportunityGuardC || usesChallengerTeamMarkets(this.deploymentC.deployment);
    const deniedA = admission && (!admission.families.A.eligible
      || !Object.values(admission.markets).some(market => market.A.eligible));
    const deniedC = admission && !admission.markets.goal.C.eligible;
    const aReason = deniedA ? admission.families.A.reasons[0]
      ?? Object.values(admission.markets).flatMap(market => market.A.reasons)[0] ?? 'a_inputs_unavailable' : null;
    const cReason = deniedC ? admission.markets.goal.C.reasons[0] ?? 'c_inputs_unavailable' : null;
    let prepared: PreparedT15Job | undefined;
    let preparationFailure: string | null = null;
    try {
      if (deniedC) preparationFailure = cReason;
      else if (this.deploymentC.resolutionUnavailable) preparationFailure = 'adoption_state_unavailable';
      else prepared = await this.researchRuntime.prepareNightly({ ...job, targetAt: job.windowStartAt });
    }
    catch (error) {
      preparationFailure = safeOddsFailureCode(error) ?? 'research_forecast_unavailable';
    }
    if (prepared) {
      if (Date.parse(prepared.kickoffAt) !== Date.parse(job.kickoffAt)
        || !['upcoming', 'unknown'].includes(prepared.status)) throw new Error('recommendation_fixture_changed');
      if (prepared.status === 'unknown') {
        prepared = undefined;
        preparationFailure = 'research_forecast_unavailable';
      }
    }
    const quotes = (this.paperMode && Array.isArray(prepared?.paperQuotes) ? prepared.paperQuotes : prepared?.quotes ?? []) as ResearchQuote[];
    const metadata = prepared?.inputSnapshot as Record<string, any> | undefined;
    // A loads the app's complete quote universe independently of C's goal-only inputs.
    let appInput: Awaited<ReturnType<AppOddsFeed['load']>> | undefined;
    let appFailure: string | null = aReason;
    const preparedC = prepared?.decisions.find(decision => decision.family === 'C');
    const cNeedsQuotes = teamMarketsC && !deniedC && !!preparedC
      && !challengerTechnicalReason(preparedC, at, this.deploymentC.deployment);
    try { if (!deniedA || cNeedsQuotes) appInput = await this.appOdds.load(row); }
    catch (error) { appFailure = safeOddsFailureCode(error) ?? 'app_odds_unavailable'; }
    const observedAt = this.clock().toISOString();
    if (Date.parse(observedAt) >= Date.parse(job.kickoffAt) || Date.parse(observedAt) >= Date.parse(job.windowEndAt)) {
      throw new Error('recommendation_fixture_not_eligible');
    }
    const usableQuotes = quotes.filter((quote) => !recommendationQuoteReason(quote, new Date(observedAt), 'C'));
    const usableAppQuotes = (appInput?.quotes ?? []).filter((quote) => !recommendationQuoteReason(quote, new Date(observedAt), 'A')
      && (!admission || admission.markets[admissionMarket(quote.market)].A.eligible));
    const cSheets = appInput?.sheets ?? (appInput ? [{ quotes: appInput.quotes, sharedOdds: appInput.sharedOdds }] : []);
    const sheetQuotes = cSheets.flatMap(sheet => sheet.quotes);
    const cQuoteUniverse: RecommendationQuote[] = teamMarketsC && sheetQuotes.length ? sheetQuotes : usableQuotes;
    const usableCQuotes = cQuoteUniverse.filter(quote => !recommendationQuoteReason(quote, new Date(observedAt), 'C',
      teamMarketsC ? CHALLENGER_TEAM_MARKET_POLICY : undefined)
      && (!admission || admission.markets[admissionMarket(quote.market)].C.eligible));
    let sharedOdds: SharedPredictionOdds = appInput?.sharedOdds ?? {
      odds: {}, bookmakerBySelection: {}, source: 'odds_api', capturedAt: observedAt,
    };
    if (admission) {
      const selections = new Set(usableAppQuotes.map(quote => quote.selection));
      sharedOdds = { ...sharedOdds,
        odds: Object.fromEntries(Object.entries(sharedOdds.odds).filter(([selection]) => selections.has(selection))),
        bookmakerBySelection: Object.fromEntries(Object.entries(sharedOdds.bookmakerBySelection).filter(([selection]) => selections.has(selection))) };
    }
    let packetA: CanonicalRecommendationPacket | null = null;
    if (!appFailure && !usableAppQuotes.length) appFailure = 'real_fresh_quotes_unavailable';
    if (!appFailure) {
      try {
        const prediction = await this.predictionService.predict({ homeTeamId: row.home_team_id, awayTeamId: row.away_team_id,
          matchId: job.matchId, competition: row.competition, season: row.season },
        { asOf: observedAt, recordAudit: false, sharedOdds, prospectiveOrigin: 'shared_ac',
          ...(this.paperMode ? { suppressProspective: true } : {}) });
        packetA = prediction.canonicalRecommendation;
      } catch (error) { appFailure = error && typeof error === 'object' && 'code' in error
        && error.code === 'CALIBRATION_PROFILE_UNAVAILABLE' ? 'a_calibration_profile_unavailable' : 'app_prediction_unavailable'; }
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
      selectionProvenance: !selectedA || usableAppQuotes.some((quote) => quote.selection === selectedA.selection
        && quote.odds === Number(selectedA.bookmakerOdds) && packetA?.odds?.bookmakerBySelection?.[quote.selection] === quote.bookmaker),
    };
    if (!appFailure && !Object.values(appChecks).every(Boolean)) appFailure = 'invalid_app_recommendation_packet';
    if (!appFailure && selectedA) {
      const quote = usableAppQuotes.find((value) => value.selection === selectedA.selection
        && value.odds === Number(selectedA.bookmakerOdds) && packetA?.odds?.bookmakerBySelection?.[value.selection] === value.bookmaker);
      const probability = Number(selectedA.ourProbability) / 100;
      if (!quote || packetA?.odds?.source !== 'odds_api') appFailure = 'app_recommendation_quote_mismatch';
      else if (!finiteProbability(probability) || !Number.isFinite(Number(selectedA.expectedValue)) || Number(selectedA.expectedValue) <= 0
        || (!this.paperMode && (!Number.isFinite(Number(selectedA.suggestedStakePercent)) || Number(selectedA.suggestedStakePercent) <= 0))) appFailure = 'invalid_app_recommendation_value';
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
    const qualityHash = decisionC?.dataQualityPolicyHash;
    const dataQualityFailure = qualityHash === undefined ? null : qualityHash !== CHALLENGER_DATA_QUALITY_POLICY_HASH
      ? 'challenger_data_quality_policy_mismatch' : decisionC?.dataQualityBaselineClean !== true
        ? 'challenger_data_quality_baseline_not_clean' : null;
    const failureC = this.deploymentC.resolutionUnavailable ? 'adoption_state_unavailable'
      : this.deploymentC.source === 'suspended' ? 'challenger_deployment_suspended'
      : preparationFailure ?? dataQualityFailure ?? challengerTechnicalReason(decisionC, observedAt, this.deploymentC.deployment);
    let packetC: ((ReturnType<typeof buildChallengerRecommendation> | ReturnType<typeof buildChallengerTeamRecommendation>) & { dataQuality?: {
      policyHash: string; baselineClean: true; evidence: unknown;
    } }) | null = null;
    if (!failureC && decisionC) {
      const markets = teamMarketsC ? [] : await this.db.research.listMarkets({ family: 'C', modelVersion: decisionC.modelVersion });
      const allowedMarkets = challengerAllowedMarkets(this.deploymentC.deployment, markets);
      if (teamMarketsC) {
        const recommendations: ReturnType<typeof buildChallengerTeamRecommendation>[] = [];
        for (const sheet of cSheets) {
          const sheetC = sheet.quotes.filter(quote => !recommendationQuoteReason(quote, new Date(observedAt), 'C', CHALLENGER_TEAM_MARKET_POLICY)
            && (!admission || admission.markets[admissionMarket(quote.market)].C.eligible));
          if (!sheetC.length) continue;
          let specialist: Parameters<typeof buildChallengerTeamRecommendation>[0]['specialist'];
          if (!opportunityGuardC && !appFailure && packetA && modelA && sheetC.some(quote => isChallengerStatMarket(quote.market))) {
            const eligible = sheet.quotes.filter(quote => !recommendationQuoteReason(quote, new Date(observedAt), 'A')
              && (!admission || admission.markets[admissionMarket(quote.market)].A.eligible));
            const keys = new Set(eligible.map(quote => quote.selection));
            const shared = { ...sheet.sharedOdds,
              odds: Object.fromEntries(Object.entries(sheet.sharedOdds.odds).filter(([key]) => keys.has(key))),
              bookmakerBySelection: Object.fromEntries(Object.entries(sheet.sharedOdds.bookmakerBySelection).filter(([key]) => keys.has(key))) };
            if (Object.keys(shared.odds).length) try {
              const prediction = await this.predictionService.predict({ homeTeamId: row.home_team_id, awayTeamId: row.away_team_id,
                matchId: job.matchId, competition: row.competition, season: row.season },
              { asOf: observedAt, recordAudit: false, sharedOdds: shared, prospectiveOrigin: 'shared_ac', suppressProspective: true });
              const candidate = prediction.canonicalRecommendation;
              if (candidate?.policyVersion === CANONICAL_RECOMMENDATION_POLICY && candidate.asOf === observedAt
                && candidate.model?.source === 'PredictionService' && candidate.model.version === modelA.version
                && candidate.model.codeHash === modelA.codeHash && candidate.model.configHash === modelA.configHash
                && hashValid(candidate.model.stateHash) && candidate.odds?.source === 'odds_api'
                && candidate.odds.capturedAt === shared.capturedAt
                && Object.entries(shared.bookmakerBySelection).every(([key, bookmaker]) => candidate.odds.bookmakerBySelection?.[key] === bookmaker)) {
                specialist = { packet: candidate, opportunities: prediction.valueOpportunities ?? [], matchId: job.matchId };
              }
            } catch { /* The C goal forecast remains usable if specialist inference is unavailable. */ }
          }
          recommendations.push(buildChallengerTeamRecommendation({ decision: decisionC, quotes: sheetC, observedAt,
            competition: row.competition, expectedIdentity: this.deploymentC.deployment, allowedMarkets, specialist }));
        }
        if (!recommendations.length) recommendations.push(buildChallengerTeamRecommendation({ decision: decisionC, quotes: usableCQuotes,
          observedAt, competition: row.competition, expectedIdentity: this.deploymentC.deployment, allowedMarkets }));
        const opportunities = recommendations.flatMap(recommendation => recommendation.opportunities);
        const selected = selectChallengerTeamRecommendation(decisionC, opportunities, this.deploymentC.deployment);
        const probabilityConfiguration = buildChallengerTeamConfiguration(decisionC, !appFailure ? packetA ?? undefined : undefined);
        packetC = { ...selected, opportunities, exclusions: Object.assign({}, ...recommendations.map(value => value.exclusions)),
          marketPolicyVersion: CHALLENGER_TEAM_MARKET_POLICY, probabilityConfiguration,
          probabilityConfigurationHash: researchHash(probabilityConfiguration) };
      } else {
        packetC = buildChallengerRecommendation({ decision: decisionC, quotes: usableQuotes, observedAt, competition: row.competition,
          expectedIdentity: this.deploymentC.deployment,
          ...(this.deploymentC.deployment.selectorPolicy === 'payout-aware-v1' ? { selectionPolicy: 'payout-aware-v1' as const } : {}), allowedMarkets });
      }
      if (qualityHash === CHALLENGER_DATA_QUALITY_POLICY_HASH) packetC.dataQuality = {
        policyHash: qualityHash, baselineClean: true, evidence: decisionC.dataQualityEvidence ?? null,
      };
      const selected = packetC.selected;
      const quote = selected && (teamMarketsC && 'quote' in selected ? selected.quote
        : usableQuotes.find((value) => value.selection === selected.selection && value.odds === selected.bookmakerOdds));
      if (selected && quote && finiteProbability(selected.ourProbability / 100) && selected.expectedValue > 0) {
        decisions.push({ family: 'C', modelVersion: decisionC.modelVersion, originDecisionId: job.originDecisionIds.C,
          action: 'BET', market: quote.market, selection: quote.selection, quote,
          probability: selected.ourProbability / 100, ev: selected.expectedValue / 100,
          suggestedStakePercent: 1, ...(typeof selected.confidence === 'string' ? { confidence: selected.confidence } : {}),
          ...(this.deploymentC.deployment.selectorPolicy === 'payout-aware-v1' ? {
            selectorPolicy: 'payout-aware-v1', selectionPolicyVersion: packetC.policyVersion,
            payout: 'payout' in selected ? selected.payout : null, quality: 'quality' in selected ? selected.quality : null,
          } : {}), recommended: true, validated: true,
          ...(packetC.dataQuality ? { dataQualityPolicyHash: packetC.dataQuality.policyHash,
            dataQualityBaselineClean: true, dataQualityEvidence: packetC.dataQuality.evidence } : {}),
          ...('qualificationEvidence' in selected ? { qualificationEvidence: object(selected.qualificationEvidence) } : {}),
          probabilityConfiguration: 'probabilityConfiguration' in packetC ? packetC.probabilityConfiguration : object(decisionC.probabilityConfiguration),
          probabilityConfigurationHash: 'probabilityConfigurationHash' in packetC ? String(packetC.probabilityConfigurationHash) : String(decisionC.probabilityConfigurationHash) });
      }
    }
    if (decisions.length === 1) decisions.push(abstain('C', decisionC?.modelVersion ?? 'C-unavailable', failureC
      ?? (this.deploymentC.deployment.selectorPolicy === 'payout-aware-v1' && packetC && 'abstentionReason' in packetC
        ? packetC.abstentionReason : null)
      ?? (packetC?.exclusions.non_binary_payout_not_supported_by_canonical_engine ? 'non_binary_payout_not_supported_by_canonical_engine' : 'challenger_no_recommendation')));
    const paperQuotes: RecommendationQuote[] = [];
    if (this.paperMode) {
      type PaperCandidate = { market: string; selection: string; selectionKey: string; quote: RecommendationQuote;
        probability: number; ev: number; confidence?: string; suggestedStakePercent?: number; probabilityConfiguration: Record<string, unknown>;
        probabilityConfigurationHash: string; payout?: unknown; quality?: unknown; qualificationEvidence?: Record<string, unknown> };
      const appCandidates: PaperCandidate[] = [];
      const sheets = appInput?.sheets ?? (appInput ? [{ quotes: appInput.quotes, sharedOdds: appInput.sharedOdds }] : []);
      if (!appFailure && modelA) for (const sheet of sheets) {
        const eligible = sheet.quotes.filter((quote) => !recommendationQuoteReason(quote, new Date(observedAt), 'A')
          && (!admission || admission.markets[admissionMarket(quote.market)].A.eligible));
        paperQuotes.push(...eligible);
        const keys = new Set(eligible.map((quote) => quote.selection));
        const shared = { ...sheet.sharedOdds,
          odds: Object.fromEntries(Object.entries(sheet.sharedOdds.odds).filter(([key]) => keys.has(key))),
          bookmakerBySelection: Object.fromEntries(Object.entries(sheet.sharedOdds.bookmakerBySelection).filter(([key]) => keys.has(key))) };
        if (!Object.keys(shared.odds).length) continue;
        const result = await this.predictionService.predict({ homeTeamId: row.home_team_id, awayTeamId: row.away_team_id,
          matchId: job.matchId, competition: row.competition, season: row.season },
        { asOf: observedAt, recordAudit: false, sharedOdds: shared, prospectiveOrigin: 'shared_ac', suppressProspective: true });
        const packet = result.canonicalRecommendation;
        if (!packet || packet.asOf !== observedAt || packet.model.version !== modelA.version
          || packet.model.codeHash !== modelA.codeHash || packet.model.configHash !== modelA.configHash
          || packet.odds.source !== 'odds_api' || packet.odds.capturedAt !== shared.capturedAt) {
          throw new Error('paper_app_prediction_identity_invalid');
        }
        const configuration = { version: 'app-probability-configuration-v1', family: 'A', source: modelA.source,
          modelVersion: modelA.version, codeHash: modelA.codeHash, configHash: modelA.configHash };
        for (const opportunity of result.valueOpportunities ?? []) {
          if (!isVisibleCanonicalTeamBet({ ...opportunity, kellyFraction: 1, suggestedStakePercent: 1 })) continue;
          const quote = eligible.find((value) => value.selection === opportunity.selection
            && value.odds === Number(opportunity.bookmakerOdds)
            && packet.odds.bookmakerBySelection[value.selection] === value.bookmaker);
          const probability = Number(opportunity.ourProbability) / 100, ev = Number(opportunity.expectedValue) / 100;
          if (!quote || !finiteProbability(probability) || !Number.isFinite(ev) || ev <= 0) continue;
          appCandidates.push({ market: quote.market, selection: quote.selection, selectionKey: paperSelectionKey(quote), quote,
            probability, ev, confidence: opportunity.confidence, suggestedStakePercent: opportunity.suggestedStakePercent, probabilityConfiguration: configuration,
            probabilityConfigurationHash: researchHash(configuration), qualificationEvidence: {
              marketCategory: opportunity.marketCategory, marketTier: opportunity.marketTier,
              isValueBet: opportunity.isValueBet, calibrationSampleSize: opportunity.calibrationSampleSize ?? null,
              categoryCalibrationStatus: opportunity.categoryCalibrationStatus ?? null,
              calibrationReliability: opportunity.calibrationReliability ?? null,
              dataWarnings: opportunity.dataWarnings ?? [], edge: opportunity.edge, edgeNoVig: opportunity.edgeNoVig,
              dynamicEvThreshold: opportunity.dynamicEvThreshold ?? null, rankingScore: opportunity.rankingScore ?? null,
              evReason: opportunity.evReason ?? null, companionOddsAvailable: opportunity.companionOddsAvailable ?? null,
            } });
        }
      }
      // C executes the same principal recommendation archived in the forecast packet.
      // Admission failures below must abstain rather than promote a secondary opportunity.
      const challengerCandidates: PaperCandidate[] = [];
      const principal = packetC?.selected;
      if (!failureC && decisionC && packetC && principal) {
        const quote = 'quote' in principal ? principal.quote : usableQuotes.find(value =>
          value.selection === principal.selection && value.odds === Number(principal.bookmakerOdds));
        const probability = Number(principal.ourProbability) / 100, ev = Number(principal.expectedValue) / 100;
        if (quote && finiteProbability(probability) && Number.isFinite(ev) && ev > 0) {
          const configuration = 'probabilityConfiguration' in packetC
            ? packetC.probabilityConfiguration : object(decisionC.probabilityConfiguration);
          challengerCandidates.push({ market: quote.market, selection: quote.selection, selectionKey: paperSelectionKey(quote), quote,
            probability, ev, ...(typeof principal.confidence === 'string' ? { confidence: principal.confidence } : {}),
            ...('engineSuggestedStakePercent' in principal && typeof principal.engineSuggestedStakePercent === 'number'
              ? { suggestedStakePercent: principal.engineSuggestedStakePercent } : {}),
            ...('payout' in principal ? { payout: principal.payout, quality: 'quality' in principal ? principal.quality : undefined } : {}),
            ...('qualificationEvidence' in principal ? { qualificationEvidence: object(principal.qualificationEvidence) } : {}),
            probabilityConfiguration: configuration,
            probabilityConfigurationHash: 'probabilityConfigurationHash' in packetC ? String(packetC.probabilityConfigurationHash)
              : String(decisionC.probabilityConfigurationHash) });
        }
      }
      for (const [family, candidates] of [['A', appCandidates], ['C', challengerCandidates]] as const) {
        const index = decisions.findIndex((decision) => decision.family === family);
        const eligible = this.fundedMode || this.dynamicMode
          ? candidates.filter((candidate) => ['LOW', 'MEDIUM', 'HIGH'].includes(candidate.confidence ?? '')) : candidates;
        const selections = bestPaperSelections(this.dynamicMode ? eligible.filter((candidate) => {
          const value = candidate.suggestedStakePercent;
          return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 5
            && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
        }) : eligible);
        if (selections.length) decisions[index] = { ...decisions[index], ...selections[0], action: 'BET', reason: undefined,
          ...(family === 'C' && packetC?.dataQuality ? { dataQualityPolicyHash: packetC.dataQuality.policyHash,
            dataQualityBaselineClean: true, dataQualityEvidence: packetC.dataQuality.evidence } : {}),
          recommended: true, validated: true, selections };
        else decisions[index] = abstain(family, decisions[index].modelVersion,
          (this.dynamicMode && candidates.some(candidate => candidate.suggestedStakePercent == null) ? 'dynamic_stake_unavailable'
            : this.dynamicMode && eligible.length ? 'dynamic_stake_unavailable'
            : (this.fundedMode || this.dynamicMode) && candidates.length ? 'confidence_unavailable' : decisions[index].reason)
            ?? (family === 'A' ? 'app_no_recommendation' : 'challenger_no_recommendation'));
      }
    }
    const modelDescriptorA = modelA ? { source: modelA.source, version: modelA.version,
      codeHash: modelA.codeHash, configHash: modelA.configHash } : null;
    if (!appFailure && modelDescriptorA) {
      await this.db.research.saveModel({ family: 'A', version: modelDescriptorA.version, artifact: modelDescriptorA });
      const existing = await this.db.research.listMarkets({ family: 'A', modelVersion: modelDescriptorA.version });
      for (const market of [...new Set(usableAppQuotes.map((quote) => quote.market))]) {
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
        snapshotHash: researchHash({ observedAt, model: modelA ?? null, quotes: usableAppQuotes }),
        ...(!appHealthy ? { errorCode: appFailure ?? 'invalid_app_recommendation_packet' } : {}) } });
    const challengerErrors: string[] = [];
    if (this.deploymentC.source !== 'fallback') {
      const checks = { inference: !!decisionC, technicalValidation: !failureC,
        selectorPolicy: !!packetC && packetC.policyVersion === (decisionC && usesOpportunityGuardDecision(decisionC, this.deploymentC.deployment) ? C_OPPORTUNITY_GUARD_POLICY : this.deploymentC.deployment.selectorPolicy === 'payout-aware-v1'
          ? 'challenger-payout-selection-v1' : CANONICAL_RECOMMENDATION_POLICY),
        probabilityConfiguration: !!decisionC && (this.deploymentC.deployment.probabilityConfigurationHash === null
          || decisionC.probabilityConfigurationHash === this.deploymentC.deployment.probabilityConfigurationHash),
        preKickoff: Date.parse(this.clock().toISOString()) < Date.parse(job.kickoffAt) };
      try { await this.db.saveSchedulerRun({ schedulerName: 'research_model_check', trigger: 'remote', startedAt: observedAt,
        endedAt: this.clock().toISOString(), success: Object.values(checks).every(Boolean),
        summary: { family: 'C', source: 'ChallengerRecommendation', modelVersion: this.deploymentC.deployment.modelVersion,
          selectorPolicy: this.deploymentC.deployment.selectorPolicy,
          probabilityConfigurationHash: this.deploymentC.deployment.probabilityConfigurationHash ?? decisionC?.probabilityConfigurationHash ?? null,
          observedProbabilityConfigurationHash: decisionC?.probabilityConfigurationHash ?? null,
          expectedProbabilityConfigurationHash: this.deploymentC.deployment.probabilityConfigurationHash,
          artifactHash: this.deploymentC.deployment.artifactHash, deploymentRevision: this.deploymentC.revision,
          snapshotHash: researchHash({ observedAt, deployment: this.deploymentC, decision: decisionC ?? null, recommendation: packetC }),
          matchId: job.matchId, runId: job.runId, probeSource: 'recommendation_selector', checks,
          ...(!Object.values(checks).every(Boolean) ? { errorCode: failureC ?? 'challenger_selection_configuration_mismatch' } : {}) } }); }
      catch { challengerErrors.push('challenger_health_recording_failed'); }
    }
    const finalObservedAt = this.clock().toISOString();
    if (Date.parse(finalObservedAt) >= Date.parse(job.kickoffAt) || Date.parse(finalObservedAt) >= Date.parse(job.windowEndAt)) {
      throw new Error('recommendation_fixture_not_eligible');
    }
    for (let index = 0; index < decisions.length; index++) {
      const decision = decisions[index];
      if (decision.action !== 'BET') continue;
      if (this.paperMode) {
        const valid = (decision.selections ?? []).filter((item) =>
          !recommendationQuoteReason(item.quote, new Date(finalObservedAt), decision.family, decision.family === 'C' && teamMarketsC ? CHALLENGER_TEAM_MARKET_POLICY : undefined));
        if (!valid.length) decisions[index] = abstain(decision.family, decision.modelVersion, 'real_fresh_quotes_unavailable');
        else decisions[index] = { ...decision, ...valid[0], selections: valid };
        continue;
      }
      const invalid = recommendationQuoteReason(decision.quote as RecommendationQuote, new Date(finalObservedAt), decision.family, decision.family === 'C' && teamMarketsC ? CHALLENGER_TEAM_MARKET_POLICY : undefined);
      if (invalid) decisions[index] = abstain(decision.family, decision.modelVersion, invalid);
    }
    return { jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
      inputSnapshot: { observedAt: finalObservedAt, quotes: [...usableAppQuotes, ...usableCQuotes, ...paperQuotes, ...quotes],
        quoteSnapshots: { A: [...usableAppQuotes, ...paperQuotes], C: teamMarketsC ? [...usableCQuotes, ...paperQuotes] : quotes }, match: metadata?.match ?? { matchId: job.matchId,
        competition: row.competition, kickoffAt: row.date, homeTeamName: row.home_team_name, awayTeamName: row.away_team_name },
      metadata: { ...metadata, policy: this.executionPolicy,
        ...(admission ? { sourceAdmission: admission } : {}),
        ...(challengerErrors.length ? { challengerErrors } : {}),
        ...(this.deploymentC.source !== 'fallback' ? { deploymentC: this.deploymentC } : {}),
        originInputId: job.originInputId, diagnosticResearchA: true,
        appOdds: appInput?.metadata ?? null, independentModelInputs: true },
      modelDescriptorA,
      forecasts: { A: packetA, C: { decision: decisionC ?? null, recommendation: packetC } } }, decisions };
  }
}
