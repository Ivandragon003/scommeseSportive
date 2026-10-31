import { DatabaseService } from '../db/DatabaseService';
import { PredictionService } from '../services/PredictionService';
import { OddsApiService } from '../services/OddsApiService';
import { AppPredictionOddsService } from '../services/AppPredictionOddsService';
import { CanonicalRecommendationPacket,
  SharedPredictionOdds, CANONICAL_RECOMMENDATION_POLICY } from '../services/CanonicalBetRecommendation';
import { ResearchRuntime } from './ResearchRuntime';
import { RecommendationQuote } from './AppRecommendationQuotes';
import type { ResearchQuote } from './ResearchEvaluation';
import { buildChallengerRecommendation, challengerTechnicalReason } from './ChallengerRecommendation';
import { researchHash } from './ResearchStore';
import type { RecommendationJob, RecommendationCommit, RecommendationDecision } from './ResearchRecommendationStore';
import { recommendationQuoteReason,
  VIRTUAL_RECOMMENDATION_POLICY, ChallengerExecutionState, challengerExecutionPolicy, fallbackChallengerState } from './ResearchRecommendationPolicy';
import { PreparedT15Job, safeOddsFailureCode } from './T15Scheduler';
import { CHALLENGER_DATA_QUALITY_POLICY_HASH } from './ChallengerDataQuality';

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
  private deploymentC: ChallengerExecutionState;
  private executionPolicy: ReturnType<typeof challengerExecutionPolicy>;
  constructor(private readonly db: DatabaseService, options: { clock?: () => Date; researchRuntime?: ResearchPreparation;
    predictionService?: AppPrediction; odds?: OddsFeed; appOdds?: AppOddsFeed;
    deploymentC?: ChallengerExecutionState } = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.deploymentC = options.deploymentC ?? fallbackChallengerState();
    this.executionPolicy = challengerExecutionPolicy(this.deploymentC);
    this.researchRuntime = options.researchRuntime ?? new ResearchRuntime(db, { clock: this.clock, odds: options.odds,
      nightly: { quoteMaxAgeMs: VIRTUAL_RECOMMENDATION_POLICY.quoteMaxAgeMs, minEv: .04, minPrudentialEv: .01 },
      candidateVersionC: this.deploymentC.deployment.modelVersion, deploymentC: this.deploymentC.deployment });
    this.researchRuntime.pinChallengerDeployment?.(this.deploymentC.deployment);
    this.predictionService = options.predictionService ?? new PredictionService(db);
    this.appOdds = options.appOdds ?? new AppPredictionOddsService(db, { clock: this.clock });
  }
  beginCohort(runId: string, deploymentC?: ChallengerExecutionState): void {
    if (deploymentC) {
      this.deploymentC = deploymentC;
      this.executionPolicy = challengerExecutionPolicy(deploymentC);
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
    let prepared: PreparedT15Job | undefined;
    let preparationFailure: string | null = null;
    try {
      if (this.deploymentC.resolutionUnavailable) preparationFailure = 'adoption_state_unavailable';
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
    const quotes = (prepared?.quotes ?? []) as ResearchQuote[];
    const metadata = prepared?.inputSnapshot as Record<string, any> | undefined;
    // A loads the app's complete quote universe independently of C's goal-only inputs.
    let appInput: Awaited<ReturnType<AppOddsFeed['load']>> | undefined;
    let appFailure: string | null = null;
    try { appInput = await this.appOdds.load(row); }
    catch (error) { appFailure = safeOddsFailureCode(error) ?? 'app_odds_unavailable'; }
    const observedAt = this.clock().toISOString();
    if (Date.parse(observedAt) >= Date.parse(job.kickoffAt) || Date.parse(observedAt) >= Date.parse(job.windowEndAt)) {
      throw new Error('recommendation_fixture_not_eligible');
    }
    const usableQuotes = quotes.filter((quote) => !recommendationQuoteReason(quote, new Date(observedAt), 'C'));
    const usableAppQuotes = (appInput?.quotes ?? []).filter((quote) => !recommendationQuoteReason(quote, new Date(observedAt), 'A'));
    const sharedOdds: SharedPredictionOdds = appInput?.sharedOdds ?? {
      odds: {}, bookmakerBySelection: {}, source: 'odds_api', capturedAt: observedAt,
    };
    let packetA: CanonicalRecommendationPacket | null = null;
    if (!appFailure && !usableAppQuotes.length) appFailure = 'real_fresh_quotes_unavailable';
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
    const qualityHash = decisionC?.dataQualityPolicyHash;
    const dataQualityFailure = qualityHash === undefined ? null : qualityHash !== CHALLENGER_DATA_QUALITY_POLICY_HASH
      ? 'challenger_data_quality_policy_mismatch' : decisionC?.dataQualityBaselineClean !== true
        ? 'challenger_data_quality_baseline_not_clean' : null;
    const failureC = this.deploymentC.resolutionUnavailable ? 'adoption_state_unavailable'
      : this.deploymentC.source === 'suspended' ? 'challenger_deployment_suspended'
      : preparationFailure ?? dataQualityFailure ?? challengerTechnicalReason(decisionC, observedAt, this.deploymentC.deployment);
    let packetC: (ReturnType<typeof buildChallengerRecommendation> & { dataQuality?: {
      policyHash: string; baselineClean: true; evidence: unknown;
    } }) | null = null;
    if (!failureC && decisionC) {
      const markets = await this.db.research.listMarkets({ family: 'C', modelVersion: decisionC.modelVersion });
      packetC = buildChallengerRecommendation({ decision: decisionC, quotes: usableQuotes, observedAt, competition: row.competition,
        expectedIdentity: this.deploymentC.deployment,
        ...(this.deploymentC.deployment.selectorPolicy === 'payout-aware-v1' ? { selectionPolicy: 'payout-aware-v1' as const } : {}),
        allowedMarkets: markets.filter((market) => ['EXPERIMENTAL', 'SHADOW', 'ACTIVE'].includes(market.state)).map((market) => market.market) });
      if (qualityHash === CHALLENGER_DATA_QUALITY_POLICY_HASH) packetC.dataQuality = {
        policyHash: qualityHash, baselineClean: true, evidence: decisionC.dataQualityEvidence ?? null,
      };
      const selected = packetC.selected;
      const quote = selected && usableQuotes.find((value) => value.selection === selected.selection && value.odds === selected.bookmakerOdds);
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
          probabilityConfiguration: object(decisionC.probabilityConfiguration),
          probabilityConfigurationHash: String(decisionC.probabilityConfigurationHash) });
      }
    }
    if (decisions.length === 1) decisions.push(abstain('C', decisionC?.modelVersion ?? 'C-unavailable', failureC
      ?? (this.deploymentC.deployment.selectorPolicy === 'payout-aware-v1' && packetC && 'abstentionReason' in packetC
        ? packetC.abstentionReason : null)
      ?? (packetC?.exclusions.non_binary_payout_not_supported_by_canonical_engine ? 'non_binary_payout_not_supported_by_canonical_engine' : 'challenger_no_recommendation')));
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
        selectorPolicy: !!packetC && packetC.policyVersion === (this.deploymentC.deployment.selectorPolicy === 'payout-aware-v1'
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
      const invalid = recommendationQuoteReason(decision.quote as RecommendationQuote, new Date(finalObservedAt), decision.family);
      if (invalid) decisions[index] = abstain(decision.family, decision.modelVersion, invalid);
    }
    return { jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
      inputSnapshot: { observedAt: finalObservedAt, quotes: [...usableAppQuotes, ...quotes],
        quoteSnapshots: { A: usableAppQuotes, C: quotes }, match: metadata?.match ?? { matchId: job.matchId,
        competition: row.competition, kickoffAt: row.date, homeTeamName: row.home_team_name, awayTeamName: row.away_team_name },
      metadata: { ...metadata, policy: this.executionPolicy,
        ...(challengerErrors.length ? { challengerErrors } : {}),
        ...(this.deploymentC.source !== 'fallback' ? { deploymentC: this.deploymentC } : {}),
        originInputId: job.originInputId, diagnosticResearchA: true,
        appOdds: appInput?.metadata ?? null, independentModelInputs: true },
      modelDescriptorA,
      forecasts: { A: packetA, C: { decision: decisionC ?? null, recommendation: packetC } } }, decisions };
  }
}
