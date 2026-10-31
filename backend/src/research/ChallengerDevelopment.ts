import { HISTORICAL_RESULT_DELAY_MS } from '../services/ChronologicalForecastService';
import { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, ForecastInput, TrainingRow } from './ForecastCore';
import { HybridArtifact, predictHybrid } from './CatBoostModel';
import { applyCoherentProbabilityPipeline, coherentProbabilityPipelineHash, CoherentCalibrationMode } from './CoherentProbabilityPipeline';
import { forecastTimestamp, nightlyDecisionTimeReason, NightlyDecisionSchedule, NIGHTLY_DECISION_TIME_PROTOCOL } from './ForecastDecisionTime';
import { normalizeScoreMatrix, scoreMatrixMarkets, settleGoalQuote } from './GoalSettlement';
import type { ResearchQuote } from './ResearchEvaluation';
import { buildChallengerRecommendation, ChallengerSelectionPolicy } from './ChallengerRecommendation';
import { buildProbabilityConfiguration } from './ProbabilityConfiguration';
import { COHERENT_PROBABILITY_PROTOCOL } from './CoherentProbabilityPipeline';
import type { T15Decision } from './T15Scheduler';
import { ORIGINAL_HOLDOUT_POLICY } from './ResearchHoldoutPolicy';
import { recommendationQuoteReason } from './ResearchRecommendationPolicy';
import { researchHash } from './ResearchStore';

export type DevelopmentPhase = 'development' | 'independent_period' | 'protected_exposed' | 'outside_declared_periods';
export type ChallengerDevelopmentPlan = {
  asOf: string; developmentFrom?: string; developmentUntil: string; independentFrom: string;
  schedule?: NightlyDecisionSchedule; recordedDecisionTimes?: Record<string, string>;
  allowedMarkets: string[]; initialBankrollCents?: number; bootstrapSamples?: number; seed?: number;
};
export type ChallengerDevelopmentVariant = {
  id: string; role: 'current' | 'candidate' | 'ablation' | 'no_ml';
  /** Only development reconstructions may be created after the historical forecast. Never prospective evidence. */
  availability?: 'recorded_available' | 'retrospective_development';
  artifact?: HybridArtifact;
  folds?: Array<{ artifact: HybridArtifact; from: string; until: string }>;
  selectionPolicy?: ChallengerSelectionPolicy;
  /** Explicit out-of-sample forecast interval for an artifact from a predeclared chronological fold. */
  from?: string; until?: string;
};
export type DevelopmentInputRow = TrainingRow & { challengerFeatureMetadata?: { maxHistoryAvailableAt?: string | null } };
type Prediction = { probabilities: number[]; matrixHash: string; selected: null | {
  quote: ResearchQuote; probability: number; expectedValue: number; confidence?: string | null;
}; exclusions: Record<string, number>; retrospective: boolean };
type EvaluationRecord = { matchId: string; competition: string; season?: string; kickoffAt: string; forecastAt: string;
  availableAt: string; homeGoals: number; awayGoals: number; phase: DevelopmentPhase; admissibleQuoteCount: number;
  quoteExclusions: Record<string, number>; predictions: Record<string, Prediction>; predictionExclusions: Record<string, string>; exclusion?: string };
const mean = (values: number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const resultKeys = ['homeWin', 'draw', 'awayWin'];
const phases = ['development', 'independent_period'] as const;
const periodKey = (at: string): string => {
  const date = new Date(at); date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
};

export function classifyChallengerDevelopmentRow(row: Pick<TrainingRow, 'matchId' | 'forecastAt'>,
  plan: ChallengerDevelopmentPlan): DevelopmentPhase {
  if (ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds.includes(row.matchId)) return 'protected_exposed';
  const at = forecastTimestamp(row.forecastAt);
  if (at >= forecastTimestamp(plan.developmentFrom ?? '1900-01-01T00:00:00Z') && at < forecastTimestamp(plan.developmentUntil)) return 'development';
  if (at >= forecastTimestamp(plan.independentFrom)) return 'independent_period';
  return 'outside_declared_periods';
}

function validatePlan(plan: ChallengerDevelopmentPlan): void {
  const from = forecastTimestamp(plan.developmentFrom ?? '1900-01-01T00:00:00Z');
  const end = forecastTimestamp(plan.developmentUntil), independent = forecastTimestamp(plan.independentFrom);
  if (![from, end, independent, forecastTimestamp(plan.asOf)].every(Number.isFinite) || from >= end || end > independent
    || independent <= forecastTimestamp(ORIGINAL_HOLDOUT_POLICY.newIndependentForecastsAfter)
    || !Array.isArray(plan.allowedMarkets) || !plan.allowedMarkets.length || new Set(plan.allowedMarkets).size !== plan.allowedMarkets.length
    || plan.allowedMarkets.some((market) => !['1x2', 'totals', 'asian_handicap'].includes(market))
    || !Number.isSafeInteger(plan.initialBankrollCents ?? 100000) || (plan.initialBankrollCents ?? 100000) <= 0
    || !Number.isSafeInteger(plan.bootstrapSamples ?? 200) || (plan.bootstrapSamples ?? 200) < 0 || (plan.bootstrapSamples ?? 200) > 2000
    || !Number.isSafeInteger(plan.seed ?? 1729)) throw new Error('invalid_challenger_development_plan');
}

function rowReason(row: DevelopmentInputRow, plan: ChallengerDevelopmentPlan): string | null {
  const timing = nightlyDecisionTimeReason(row, plan.schedule, plan.recordedDecisionTimes?.[row.matchId]);
  if (timing) return timing;
  const forecast = forecastTimestamp(row.forecastAt), available = forecastTimestamp(row.availableAt);
  if (!Number.isSafeInteger(row.homeGoals) || !Number.isSafeInteger(row.awayGoals) || row.homeGoals < 0 || row.awayGoals < 0) return 'result_unavailable';
  if (!Number.isFinite(available) || available < forecastTimestamp(row.kickoffAt) + HISTORICAL_RESULT_DELAY_MS
    || available > forecastTimestamp(plan.asOf)) return 'outcome_not_available_asof';
  if (!Number.isFinite(forecastTimestamp(row.modelFitAt)) || forecastTimestamp(row.modelFitAt) > forecast
    || !Number.isSafeInteger(row.trainingCount) || row.trainingCount < 30
    || row.maxTrainingAvailableAt !== null && (!Number.isFinite(forecastTimestamp(row.maxTrainingAvailableAt))
      || forecastTimestamp(row.maxTrainingAvailableAt) > forecast)) return 'future_or_unknown_baseline_information';
  const extra = row.challengerFeatureMetadata?.maxHistoryAvailableAt;
  if (extra && (!Number.isFinite(forecastTimestamp(extra)) || forecastTimestamp(extra) > forecast)) return 'future_challenger_feature_information';
  return null;
}

/** Strict live-entry semantics: observed-only historical snapshots and closing quotes cannot become Nightly prices. */
export function admissibleNightlyDevelopmentQuotes(quotes: ResearchQuote[], forecastAt: string, allowedMarkets: string[]) {
  const exclusions: Record<string, number> = {}, accepted: ResearchQuote[] = [];
  for (const quote of quotes) {
    const synthetic = (quote as any)?.usedSyntheticOdds === true || (quote as any)?.used_synthetic_odds === 1;
    const reason = synthetic ? 'synthetic_quote' : !allowedMarkets.includes(quote?.market) ? 'market_not_allowed'
      : recommendationQuoteReason(quote, new Date(forecastAt), 'C');
    if (reason) exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    else accepted.push(quote);
  }
  return { quotes: accepted, exclusions };
}

function variantInput(row: DevelopmentInputRow, artifact: HybridArtifact): ForecastInput {
  const names = artifact.featureNames;
  const indexes = names.map((name) => row.featureNames.indexOf(name));
  if (indexes.some((index) => index < 0)) throw new Error('variant_feature_not_available');
  return { ...row, featureSchema: artifact.featureSchema, featureNames: [...names], features: indexes.map((index) => row.features[index]) };
}

function predict(row: DevelopmentInputRow, variant: ChallengerDevelopmentVariant, quotes: ResearchQuote[], phase: DevelopmentPhase): Prediction {
  const forecast = forecastTimestamp(row.forecastAt);
  if (variant.from && forecast < forecastTimestamp(variant.from) || variant.until && forecast >= forecastTimestamp(variant.until)) throw new Error('outside_variant_out_of_sample_interval');
  let matrix = normalizeScoreMatrix(row.baselineMatrix), raw = scoreMatrixMarkets(matrix), retrospective = false;
  const matchingFolds = variant.folds?.filter((fold) => forecast >= forecastTimestamp(fold.from) && forecast < forecastTimestamp(fold.until));
  if (variant.folds && matchingFolds?.length !== 1) throw new Error('variant_fold_not_uniquely_available');
  const artifact = variant.artifact ?? matchingFolds?.[0]?.artifact;
  if (artifact) {
    const protection = artifact.holdoutProtection as { protectedRowsUsed?: number } | undefined;
    const calibration = artifact.calibrationPredictions as Array<{ matchId?: string }> | undefined;
    if (protection?.protectedRowsUsed !== undefined && protection.protectedRowsUsed !== 0
      || calibration?.some((sample) => ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds.includes(sample.matchId ?? ''))) {
      throw new Error('protected_targets_used_in_variant_training_or_calibration');
    }
    if (!Number.isFinite(forecastTimestamp(artifact.trainedThrough)) || !Number.isFinite(forecastTimestamp(artifact.validationThrough))
      || forecastTimestamp(artifact.trainedThrough) >= forecast || forecastTimestamp(artifact.validationThrough) >= forecast) throw new Error('model_training_or_validation_not_available');
    if (!Number.isFinite(forecastTimestamp(artifact.createdAt))) throw new Error('model_availability_time_missing');
    if (forecastTimestamp(artifact.createdAt) > forecast) {
      if (variant.role === 'current' || phase !== 'development' || variant.availability !== 'retrospective_development') throw new Error('model_not_available_at_forecast');
      retrospective = true;
    }
    if (variant.role === 'current' && (artifact.probabilityProtocol !== COHERENT_PROBABILITY_PROTOCOL
      || artifact.pipelineHashV2 !== coherentProbabilityPipelineHash())) throw new Error('current_probability_configuration_unavailable');
    const predicted = predictHybrid(variantInput(row, artifact), artifact); matrix = predicted.matrix; raw = predicted.probabilities;
  }
  const mode = (artifact?.probabilityCalibrationMode ?? (variant.role === 'current' ? 'isotonic_1x2' : 'identity')) as CoherentCalibrationMode;
  const profile = (artifact?.calibrationProfilesV2 as any)?.C;
  const pipeline = applyCoherentProbabilityPipeline({ matrix, rawProbabilities: raw, quotes, forecastAt: row.forecastAt,
    mode, profile, temperature: artifact?.probabilityTemperature as number | undefined });
  const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion: row.baselineVersion,
    pipelineHashV2: coherentProbabilityPipelineHash(), mode, profile, temperature: artifact?.probabilityTemperature as number | undefined });
  const modelVersion = artifact?.version ?? 'C-statistical-no-ml-comparator';
  const feature = (name: string): number | null => {
    const index = row.featureNames.indexOf(name), value = index < 0 ? undefined : row.features[index];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  // This ephemeral technical context reuses the real selector. It is never stored or presented as a historical frozen decision.
  const context: T15Decision = { family: 'C', modelVersion, validated: true, action: 'ABSTAIN', score: 0,
    probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, calibrationPipelineHash: coherentProbabilityPipelineHash(),
    probabilityConfiguration: configuration.descriptor, probabilityConfigurationHash: configuration.hash,
    calibrationAvailableAt: artifact?.validationThrough ?? row.modelFitAt,
    prospectiveMatrix: pipeline.matrix, probabilityStages: { raw: pipeline.raw, calibrated: pipeline.calibrated, decision: pipeline.decision },
    challengerQuality: { modelFitAt: row.modelFitAt, historyAvailableThrough: row.maxTrainingAvailableAt,
      homeHistorySample: feature('home_sample'), awayHistorySample: feature('away_sample'),
      homeXgCoverage: feature('home_xg_coverage'), awayXgCoverage: feature('away_xg_coverage') } };
  const selected = buildChallengerRecommendation({ decision: context, quotes, observedAt: row.forecastAt,
    competition: row.competition, allowedMarkets: quotes.map((quote) => quote.market),
    selectionPolicy: variant.selectionPolicy ?? 'legacy-c906',
    expectedIdentity: { modelVersion, baselineVersion: row.baselineVersion, probabilityConfigurationHash: configuration.hash } });
  const choice = selected.selected;
  const chosenQuote = choice && ('quote' in choice ? choice.quote : quotes.find((quote) => quote.selection === choice.selection
    && quote.odds === choice.bookmakerOdds));
  return { probabilities: resultKeys.map((key) => pipeline.decision[key]), matrixHash: researchHash(pipeline.matrix),
    selected: choice && chosenQuote ? { quote: chosenQuote, probability: choice.ourProbability / 100,
      expectedValue: choice.expectedValue / 100, confidence: choice.confidence } : null, exclusions: selected.exclusions, retrospective };
}

function observations(records: EvaluationRecord[], variant: string) {
  return records.filter((record) => !!record.predictions[variant]).map((record) => {
    const probabilities = record.predictions[variant].probabilities;
    const outcome = record.homeGoals > record.awayGoals ? 0 : record.homeGoals === record.awayGoals ? 1 : 2;
    const confidence = Math.max(...probabilities), predicted = probabilities.indexOf(confidence);
    return { record, logLoss: -Math.log(Math.max(1e-15, probabilities[outcome])),
      brier: probabilities.reduce((sum, probability, index) => sum + (probability - Number(index === outcome)) ** 2, 0),
      confidence, correct: Number(predicted === outcome) };
  });
}
function metrics(records: EvaluationRecord[], variant: string) {
  const rows = observations(records, variant), n = rows.length;
  const calibration = Array.from({ length: 10 }, (_, index) => {
    const bucket = rows.filter((row) => Math.min(9, Math.floor(row.confidence * 10)) === index);
    return { lower: index / 10, upper: (index + 1) / 10, n: bucket.length,
      predicted: mean(bucket.map((row) => row.confidence)), observed: mean(bucket.map((row) => row.correct)) };
  });
  return { n, logLoss: mean(rows.map((row) => row.logLoss)), brier: mean(rows.map((row) => row.brier)),
    ece: n ? calibration.reduce((sum, bin) => sum + (bin.n ? bin.n / n * Math.abs(bin.predicted! - bin.observed!) : 0), 0) : null,
    calibration, leagues: [...new Set(rows.map(({ record }) => record.competition))].sort(),
    periods: [...new Set(rows.map(({ record }) => periodKey(record.forecastAt)))].sort() };
}

function economics(records: EvaluationRecord[], variant: string, initial: number) {
  const evaluated = records.filter((row) => row.predictions[variant]);
  const eligibleQuoteMatches = evaluated.filter((row) => row.admissibleQuoteCount > 0).length;
  const exclusions: Record<string, number> = {}, bets: Row[] = [];
  let cash = initial, committed = 0, peak = initial, maxDrawdown = 0, totalStaked = 0, profit = 0;
  const pending: Array<{ availableAt: number; stake: number; returned: number }> = [];
  const settle = (now: number) => {
    pending.sort((a, b) => a.availableAt - b.availableAt);
    while (pending.length && pending[0].availableAt <= now) {
      const outcome = pending.shift()!; committed -= outcome.stake; cash += outcome.returned;
      peak = Math.max(peak, cash + committed); maxDrawdown = Math.max(maxDrawdown, (peak - cash - committed) / peak);
    }
  };
  const ordered = [...evaluated].sort((a, b) => forecastTimestamp(a.forecastAt) - forecastTimestamp(b.forecastAt)
    || (b.predictions[variant].selected?.expectedValue ?? -Infinity) - (a.predictions[variant].selected?.expectedValue ?? -Infinity)
    || a.matchId.localeCompare(b.matchId));
  let currentForecast = NaN, basis = initial;
  for (const row of ordered) {
    const at = forecastTimestamp(row.forecastAt);
    if (at !== currentForecast) { settle(at); basis = cash + committed; currentForecast = at; }
    const selected = row.predictions[variant].selected;
    if (!selected) continue;
    const stake = Math.floor(basis / 100);
    const reason = stake <= 0 || stake > cash ? 'insufficient_capital' : committed + stake > Math.floor((cash + committed) * .05) ? 'max_exposure' : null;
    if (reason) { exclusions[reason] = (exclusions[reason] ?? 0) + 1; continue; }
    const outcome = settleGoalQuote(selected.quote, row.homeGoals, row.awayGoals);
    if (outcome.returnMultiplier === null) { exclusions.unresolved_outcome = (exclusions.unresolved_outcome ?? 0) + 1; continue; }
    const returned = Math.round(stake * outcome.returnMultiplier);
    cash -= stake; committed += stake; totalStaked += stake; profit += returned - stake;
    pending.push({ availableAt: forecastTimestamp(row.availableAt), stake, returned });
    bets.push({ matchId: row.matchId, forecastAt: row.forecastAt, quote: selected.quote, stakeCents: stake,
      returnCents: returned, status: outcome.status, profitCents: returned - stake });
  }
  settle(Infinity);
  return { available: eligibleQuoteMatches > 0, reason: eligibleQuoteMatches ? null : 'no_admissible_real_nightly_quotes',
    evaluatedMatches: evaluated.length, eligibleQuoteMatches, modelNoBetMatches: evaluated.filter((row) => !row.predictions[variant].selected).length,
    betCount: bets.length, totalStakedCents: totalStaked, profitCents: bets.length ? profit : null,
    roi: totalStaked ? profit / totalStaked : null, maxDrawdownFraction: bets.length ? maxDrawdown : null,
    finalEquityCents: bets.length ? cash + committed : null, exclusions, bets };
}
type Row = Record<string, any>;

function pairedInterval(records: EvaluationRecord[], left: string, right: string, samples: number, seed: number) {
  const a = observations(records, left), b = new Map(observations(records, right).map((row) => [row.record.matchId, row]));
  const groups = new Map<string, Array<{ loss: number; brier: number }>>();
  for (const row of a) { const paired = b.get(row.record.matchId); if (!paired) continue;
    const key = periodKey(row.record.forecastAt), bucket = groups.get(key) ?? [];
    bucket.push({ loss: paired.logLoss - row.logLoss, brier: paired.brier - row.brier }); groups.set(key, bucket); }
  const blocks = [...groups.values()];
  if (blocks.length < 2 || !samples) return { method: 'paired_week_block_bootstrap', samples, blocks: blocks.length, logLoss95: null, brier95: null };
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const loss: number[] = [], brier: number[] = [];
  for (let iteration = 0; iteration < samples; iteration++) {
    const draw = Array.from({ length: blocks.length }, () => blocks[Math.floor(random() * blocks.length)]).flat();
    loss.push(mean(draw.map((row) => row.loss))!); brier.push(mean(draw.map((row) => row.brier))!);
  }
  const interval = (values: number[]) => { values.sort((a, b) => a - b);
    return [values[Math.floor((values.length - 1) * .025)], values[Math.ceil((values.length - 1) * .975)]]; };
  return { method: 'paired_week_block_bootstrap', samples, blocks: blocks.length, logLoss95: interval(loss), brier95: interval(brier) };
}

export function evaluateChallengerDevelopment(input: { rows: DevelopmentInputRow[]; variants: ChallengerDevelopmentVariant[];
  quotesByMatch?: Record<string, ResearchQuote[]>; plan: ChallengerDevelopmentPlan; provenance?: Record<string, unknown> }) {
  const { plan, variants } = input; validatePlan(plan);
  if (variants.length < 2 || variants.length > 12 || variants.some((variant) => !/^[a-zA-Z0-9_-]{1,80}$/.test(variant.id)
    || !['current', 'candidate', 'ablation', 'no_ml'].includes(variant.role)
    || Number(!!variant.artifact) + Number(!!variant.folds) > 1
    || variant.role !== 'no_ml' && !variant.artifact && !variant.folds
    || variant.role === 'no_ml' && [variant.artifact, ...(variant.folds ?? []).map((fold) => fold.artifact)]
      .filter((artifact) => !!artifact).some((artifact) => artifact!.candidateKind !== 'no_ml')
    || variant.selectionPolicy !== undefined && !['legacy-c906', 'payout-aware-v1'].includes(variant.selectionPolicy)
    || variant.folds && (!variant.folds.length || variant.folds.some((fold) => !fold.artifact || !Number.isFinite(forecastTimestamp(fold.from))
      || !Number.isFinite(forecastTimestamp(fold.until)) || forecastTimestamp(fold.from) >= forecastTimestamp(fold.until)))
    || variant.from !== undefined && !Number.isFinite(forecastTimestamp(variant.from))
    || variant.until !== undefined && !Number.isFinite(forecastTimestamp(variant.until))
    || variant.from && variant.until && forecastTimestamp(variant.from) >= forecastTimestamp(variant.until))
    || new Set(variants.map((variant) => variant.id)).size !== variants.length) throw new Error('invalid_challenger_development_variants');
  const ids = new Set<string>(), records: EvaluationRecord[] = [];
  for (const row of [...input.rows].sort((a, b) => forecastTimestamp(a.forecastAt) - forecastTimestamp(b.forecastAt) || a.matchId.localeCompare(b.matchId))) {
    if (!row.matchId || ids.has(row.matchId)) throw new Error('duplicate_challenger_development_match'); ids.add(row.matchId);
    const phase = classifyChallengerDevelopmentRow(row, plan), reason = rowReason(row, plan);
    const quotes = admissibleNightlyDevelopmentQuotes(input.quotesByMatch?.[row.matchId] ?? [], row.forecastAt, plan.allowedMarkets);
    const record: EvaluationRecord = { matchId: row.matchId, competition: row.competition, season: row.season,
      kickoffAt: row.kickoffAt, forecastAt: row.forecastAt, availableAt: row.availableAt, homeGoals: row.homeGoals, awayGoals: row.awayGoals,
      phase, admissibleQuoteCount: quotes.quotes.length, quoteExclusions: quotes.exclusions, predictions: {}, predictionExclusions: {},
      ...(reason ? { exclusion: reason } : {}) };
    records.push(record);
    if (reason || phase === 'protected_exposed' || phase === 'outside_declared_periods') continue;
    for (const variant of variants) {
      try { record.predictions[variant.id] = predict(row, variant, quotes.quotes, phase); }
      catch (error) { record.predictionExclusions[variant.id] = error instanceof Error ? error.message : 'prediction_unavailable'; }
    }
  }
  const results = Object.fromEntries(variants.map((variant) => [variant.id, {
    role: variant.role, selectionPolicy: variant.selectionPolicy ?? 'legacy-c906',
    pipelineSource: variant.artifact || variant.folds ? 'artifact_calibration_and_same_coherent_pipeline' : 'bare_identity_statistical_baseline',
    foldArtifacts: variant.folds?.map((fold) => ({ version: fold.artifact.version, hash: researchHash(fold.artifact), from: fold.from, until: fold.until })) ?? [],
    artifactVersion: variant.artifact?.version ?? (variant.folds ? 'chronological_fold_artifacts' : 'statistical_no_ml'),
    artifactHash: variant.artifact ? researchHash(variant.artifact) : variant.folds ? researchHash(variant.folds) : null,
    featureSchema: (variant.artifact ?? variant.folds?.[0]?.artifact)?.featureSchema ?? FEATURE_SCHEMA_VERSION,
    featureNames: (variant.artifact ?? variant.folds?.[0]?.artifact)?.featureNames ?? FEATURE_NAMES,
    availability: variant.availability ?? 'recorded_available', byPhase: Object.fromEntries(phases.map((phase) => {
      const cohort = records.filter((row) => row.phase === phase);
      return [phase, { metrics: metrics(cohort, variant.id), economics: economics(cohort, variant.id, plan.initialBankrollCents ?? 100000) }];
    })),
  }]));
  const comparisons: Row[] = [];
  for (let index = 0; index < variants.length; index++) for (const right of variants.slice(index + 1)) {
    const left = variants[index];
    comparisons.push({ left: left.id, right: right.id, deltaDirection: 'right_minus_left', byPhase: Object.fromEntries(phases.map((phase) => {
      const paired = records.filter((row) => row.phase === phase && row.predictions[left.id] && row.predictions[right.id]);
      const a = metrics(paired, left.id), b = metrics(paired, right.id);
      return [phase, { pairedMatchIdsHash: researchHash(paired.map((row) => [row.matchId, row.forecastAt])), n: paired.length,
        left: a, right: b, deltaLogLoss: paired.length ? b.logLoss! - a.logLoss! : null,
        deltaBrier: paired.length ? b.brier! - a.brier! : null,
        uncertainty: pairedInterval(paired, left.id, right.id, plan.bootstrapSamples ?? 200, plan.seed ?? 1729),
        economics: { left: economics(paired, left.id, plan.initialBankrollCents ?? 100000), right: economics(paired, right.id, plan.initialBankrollCents ?? 100000) },
        byLeague: Object.fromEntries([...new Set(paired.map((row) => row.competition))].sort().map((league) => [league, {
          left: metrics(paired.filter((row) => row.competition === league), left.id), right: metrics(paired.filter((row) => row.competition === league), right.id),
        }])),
      }];
    })) });
  }
  const implementationHash = researchHash(Object.fromEntries(['./ChallengerDevelopment', './ForecastDecisionTime',
    './ChallengerRecommendation', './ChallengerSelection', './CatBoostModel'].map((name) =>
    [name, researchHash(readFileSync(require.resolve(name), 'utf8').replace(/\r\n/g, '\n'))])));
  return { protocol: 'challenger-nightly-development-v1', plan, planHash: researchHash(plan), inputHash: researchHash(input.rows), implementationHash,
    quotesHash: researchHash(input.quotesByMatch ?? {}), probabilityPipelineHash: coherentProbabilityPipelineHash(), provenance: input.provenance ?? {},
    timing: { protocol: NIGHTLY_DECISION_TIME_PROTOCOL, timezone: 'Europe/Rome', schedule: { hour: plan.schedule?.hour ?? 3, minute: plan.schedule?.minute ?? 7 },
      semantics: plan.recordedDecisionTimes ? 'explicit_recorded_times_with_nominal_fallback_for_unrecorded_rows' : 'nominal_schedule_proxy_not_observed_execution',
      recordedMatches: records.filter((row) => plan.recordedDecisionTimes?.[row.matchId] !== undefined).length,
      resultDelayMs: HISTORICAL_RESULT_DELAY_MS },
    holdout: { policyVersion: ORIGINAL_HOLDOUT_POLICY.version, protectedOriginalCount: ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds.length,
      protectedRowsExcluded: records.filter((row) => row.phase === 'protected_exposed').length,
      independentBoundary: ORIGINAL_HOLDOUT_POLICY.newIndependentForecastsAfter,
      certificationEligible: false, reason: 'offline_reconstruction_is_not_frozen_prospective_adoption_evidence' },
    coverage: { inputMatches: records.length, phases: Object.fromEntries([...phases, 'protected_exposed', 'outside_declared_periods']
      .map((phase) => [phase, records.filter((row) => row.phase === phase).length])), invalidRows: records.filter((row) => row.exclusion).length },
    metricDefinitions: { primary: '1x2_multiclass_all_valid_matches_including_no_bet', brier: 'sum_of_three_squared_errors', eceBins: 10,
      simulatedStake: 'one_percent_same_forecast_equity_with_five_percent_exposure_cap', quotation: 'real_prematch_provider_update_no_future_max_age_300_seconds' },
    variants: results, comparisons, records,
    conclusion: 'development_evidence_only_no_automatic_promotion',
    limitations: ['The statistical no-ML comparator is the frozen Research baseline, not the whole operational APP-A engine.',
      'Nominal Nightly times do not prove actual historical run or source availability.',
      'AvailableAt is only as reliable as the export; missing observed times use the conservative two-hour result delay.',
      'Sparse or absent fresh real Nightly prices cannot establish ROI, CLV or bookmaker profit.',
      'The previously exposed 745 final matches cannot be reused for optimization or certification.',
      'Training exclusion depends on the artifact training manifest; trees alone cannot prove which historical rows were used.',
      'Independent-period offline replay cannot replace immutable pre-result prospective forecasts.'] };
}

export function challengerDevelopmentMarkdown(report: ReturnType<typeof evaluateChallengerDevelopment>, commands: string[][] = []): string {
  const rows = ['# Confronto controllato C — orario Nightly', '',
    `Protocollo: ${report.protocol}. Fuso Europe/Rome, ${String(report.timing.schedule.hour).padStart(2, '0')}:${String(report.timing.schedule.minute).padStart(2, '0')}.`,
    'Le metriche includono anche NO_BET. I confronti appaiati usano gli stessi incontri e gli stessi istanti.', '',
    '| Variante | Periodo | Partite | Log loss | Brier | ECE | Puntate | ROI |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  const number = (value: number | null) => value === null ? 'n/d' : value.toFixed(6);
  for (const [id, variant] of Object.entries(report.variants)) for (const [phase, result] of Object.entries(variant.byPhase)) {
    rows.push(`| ${id} | ${phase} | ${result.metrics.n} | ${number(result.metrics.logLoss)} | ${number(result.metrics.brier)} | ${number(result.metrics.ece)} | ${result.economics.betCount} | ${number(result.economics.roi)} |`);
  }
  rows.push('', 'Gli eventuali rendimenti sono simulazioni con quote realmente ammissibili. Senza quote fresche il ROI resta n/d.',
    'Questo report non certifica né adotta un modello. I 745 incontri finali già esposti sono esclusi.', '', '## Riproducibilità', '',
    `- Piano: \`${report.planHash}\``, `- Dataset: \`${report.inputHash}\``, `- Quote: \`${report.quotesHash}\``,
    `- Implementazione: \`${report.implementationHash}\``,
    `- Pipeline: \`${report.probabilityPipelineHash}\``, '', ...commands.map((command) => `\`${command.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ')}\``),
    '', '## Limiti', '', ...report.limitations.map((limit) => `- ${limit}`), '');
  return rows.join('\n');
}
import { readFileSync } from 'node:fs';
