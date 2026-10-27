import { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } from './ForecastCore';
import { HybridArtifact, predictHybrid, validateArtifact } from './CatBoostModel';
import { scoreMatrixMarkets } from './GoalSettlement';
import { EvaluationRow, evaluateResearchBenchmark } from './ResearchEvaluation';
import { applyResearchProbabilityPipeline, fitResearchCalibration, goalCalibrationObservation, ResearchCalibrationProfile } from './ResearchProbabilityPipeline';
import { ResearchStore, researchHash } from './ResearchStore';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyCoherentProbabilityPipeline, fitCoherentCalibration, coherentProbabilityPipelineHash,
  COHERENT_PROBABILITY_PROTOCOL, CoherentCalibrationMode } from './CoherentProbabilityPipeline';
import { assessResearchHoldout, ResearchEvaluationPolicy } from './ResearchHoldoutPolicy';
import { buildProbabilityConfiguration } from './ProbabilityConfiguration';

export const LIFECYCLE_RULE = 'research-promotion-v1';
const WEEK_MS = 7 * 86400000;
const GOAL_MARKETS = ['1x2', 'double_chance', 'dnb', 'totals', 'team_totals', 'btts', 'european_handicap', 'asian_handicap'];
const SPECIALIST_MARKETS = ['shots', 'shots_on_target', 'cards_total', 'corners', 'fouls'];
type HealthRun = { schedulerName: string; success: boolean; startedAt: string; summary?: any };
type RegistryBenchmark = { modelVersion?: string; report?: any };
type Champion = { version: string; artifact: HybridArtifact };
export type LifecycleDatabase = {
  research: ResearchStore;
  listRecentSchedulerRuns(limit: number): Promise<HealthRun[]>;
  listRecentSchedulerRunsByName?(name: string, limit: number): Promise<HealthRun[]>;
  saveSchedulerRun(entry: { schedulerName: string; trigger: string; startedAt: string; endedAt: string;
    success: boolean; durationMs?: number; summary?: Record<string, any>; error?: string }): Promise<unknown>;
};
const timestamp = (value: string): number => Date.parse(value);
const ordered = (a: HealthRun, b: HealthRun): number => timestamp(b.startedAt) - timestamp(a.startedAt);
const ciPasses = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2
  && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) && value[0] <= value[1] && value[1] < 0;
export const researchPipelineHash = (): string => createHash('sha256')
  .update(readFileSync(require.resolve('./ResearchProbabilityPipeline'))).digest('hex');

/** Derive calibrators from the untouched calibration interval, never test labels. */
export function enrichLifecycleArtifact(input: HybridArtifact): HybridArtifact {
  validateArtifact(input);
  const artifact = JSON.parse(JSON.stringify(input)) as HybridArtifact;
  if (artifact.pipelineHash && artifact.pipelineHash !== researchPipelineHash()) throw new Error('calibration_pipeline_version_mismatch_retrain_required');
  artifact.pipelineHash = researchPipelineHash();
  const rows = artifact.calibrationPredictions;
  if (!Array.isArray(rows) || rows.length === 0) return artifact;
  const profiles: Record<string, unknown> = {};
  for (const family of ['A', 'C'] as const) {
    const observations = rows.map((row: any) => goalCalibrationObservation(row.matchId, row.availableAt,
      family === 'A' ? row.probabilitiesA : scoreMatrixMarkets(row.matrixC), row.homeGoals, row.awayGoals));
    profiles[family] = fitResearchCalibration(observations, artifact.validationThrough);
  }
  artifact.calibrationProfiles = profiles;
  // Payout residuals need an independent set of real prices. No fabricated sample is supplied.
  return artifact;
}

/** Explicit migration creates a new configuration identity; a V1 artifact is never rebound in place. */
export function enrichCoherentLifecycleArtifact(input: HybridArtifact, options: {
  mode: CoherentCalibrationMode; temperature?: number;
}): HybridArtifact {
  validateArtifact(input);
  if (!['identity', 'isotonic_1x2', 'temperature'].includes(options.mode)) throw new Error('Explicit coherent calibration mode required');
  if (options.mode === 'temperature' && (!Number.isFinite(options.temperature) || options.temperature! <= 0)) {
    throw new Error('Explicit positive coherent temperature required');
  }
  const hash = coherentProbabilityPipelineHash();
  if (input.probabilityProtocol === COHERENT_PROBABILITY_PROTOCOL
    && input.pipelineHashV2 === hash && input.probabilityCalibrationMode === options.mode
    && input.probabilityTemperature === options.temperature) return JSON.parse(JSON.stringify(input));
  const artifact = JSON.parse(JSON.stringify(input)) as HybridArtifact;
  const rows = Array.isArray(artifact.calibrationPredictions) ? artifact.calibrationPredictions : [];
  if (options.mode === 'isotonic_1x2' && rows.length === 0) throw new Error('Independent coherent calibration rows required');
  const profiles = Object.fromEntries((['A', 'C'] as const).map((family) => [family,
    fitCoherentCalibration(rows.map((row: any) => goalCalibrationObservation(row.matchId, row.availableAt,
      scoreMatrixMarkets(family === 'A' ? row.matrixA : row.matrixC), row.homeGoals, row.awayGoals)), artifact.validationThrough)]));
  const parentVersion = artifact.version;
  const identity = { parentVersion, pipelineHashV2: hash, probabilityCalibrationMode: options.mode,
    probabilityTemperature: options.temperature ?? null, calibrationProfilesV2: profiles };
  artifact.version = `C-${researchHash(identity).slice(0, 16)}`;
  artifact.parentVersion = parentVersion;
  artifact.probabilityProtocol = COHERENT_PROBABILITY_PROTOCOL;
  artifact.pipelineHashV2 = hash;
  artifact.probabilityCalibrationMode = options.mode;
  if (options.temperature !== undefined) artifact.probabilityTemperature = options.temperature;
  else delete artifact.probabilityTemperature;
  artifact.calibrationProfilesV2 = profiles;
  // Residuals fitted for another probability transform cannot validate V2 decisions.
  delete artifact.calibrationSamples;
  artifact.status = 'CANDIDATE';
  artifact.productionValidated = false;
  return artifact;
}

/** Clone-only adapter for a new V2 report; the original benchmark remains immutable. */
export function rebindCoherentTrainerReport(report: any, artifact: HybridArtifact): any {
  if (artifact.probabilityProtocol !== COHERENT_PROBABILITY_PROTOCOL || !artifact.parentVersion) throw new Error('Coherent child artifact required');
  const clone = JSON.parse(JSON.stringify(report));
  for (const row of clone.predictions ?? []) if (row.versionC === artifact.parentVersion) row.versionC = artifact.version;
  if (clone.finalHoldout?.version === artifact.parentVersion) clone.finalHoldout.version = artifact.version;
  for (const fold of clone.folds ?? []) if (fold.version === artifact.parentVersion) fold.version = artifact.version;
  clone.parentReportHash = researchHash(report);
  clone.probabilityProtocol = COHERENT_PROBABILITY_PROTOCOL;
  clone.pipelineHashV2 = artifact.pipelineHashV2;
  delete clone.calibrationSamples;
  clone.productionPromotion = false;
  return clone;
}

function operationalEvidence(runs: HealthRun[], artifact: HybridArtifact, now: Date) {
  let expectedConfigurationHash: string | null = null;
  try {
    expectedConfigurationHash = buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion!,
      pipelineHashV2: artifact.pipelineHashV2 as string, mode: artifact.probabilityCalibrationMode as CoherentCalibrationMode,
      temperature: artifact.probabilityTemperature as number,
      profile: (artifact.calibrationProfilesV2 as { C?: ResearchCalibrationProfile } | undefined)?.C }).hash;
  } catch { /* Invalid or legacy configurations cannot contribute operational approval. */ }
  const matching = runs.filter((run) => run.schedulerName === 'research_model_check'
    && run.summary?.family === 'C' && run.summary?.modelVersion === artifact.version
    && run.summary?.baselineVersion === artifact.baselineVersion
    && run.summary?.featureSchema === artifact.featureSchema
    && run.summary?.probabilityProtocol === COHERENT_PROBABILITY_PROTOCOL
    && run.summary?.pipelineHashV2 === artifact.pipelineHashV2
    && expectedConfigurationHash !== null && run.summary?.probabilityConfigurationHash === expectedConfigurationHash
    && timestamp(run.startedAt) <= now.getTime() && now.getTime() - timestamp(run.startedAt) <= WEEK_MS).sort(ordered);
  const checks = ['inference', 'finiteProbabilities', 'coherentProbabilities', 'preKickoff', 'sharedSnapshot', 'calibrationCompatible'];
  const matchIds = new Set<string>(), snapshotHashes = new Set<string>();
  const recent = matching.filter((run) => {
    const matchId = run.summary?.matchId, snapshotHash = run.summary?.snapshotHash;
    if (!matchId || !snapshotHash || matchIds.has(matchId) || snapshotHashes.has(snapshotHash)) return false;
    matchIds.add(matchId); snapshotHashes.add(snapshotHash); return true;
  }).slice(0, 3);
  return { passed: recent.length === 3 && recent.every((run) => run.success && checks.every((key) => run.summary?.checks?.[key] === true)),
    runTimes: recent.map((run) => run.startedAt), matchIds: recent.map((run) => run.summary.matchId),
    snapshotHashes: recent.map((run) => run.summary.snapshotHash), count: matching.length, expectedConfigurationHash };
}

/** Evaluate only the last, untouched fold. Earlier folds never enlarge the promotion sample. */
export function buildLifecycleReport(artifact: HybridArtifact, trainerReport: any, options: {
  now?: Date; operationalRuns?: HealthRun[]; priorBenchmarks?: RegistryBenchmark[]; incumbent?: Champion | null;
  datasetRows?: any[]; evaluationPolicy?: ResearchEvaluationPolicy;
} = {}) {
  validateArtifact(artifact);
  const now = options.now ?? new Date();
  const baseline = baselineManifest();
  const warnings: Array<{ code: string; invalidating: boolean }> = [];
  const warn = (code: string) => warnings.push({ code, invalidating: true });
  const final = trainerReport.finalHoldout;
  if (!final || final.version !== artifact.version) warn('artifact_is_not_final_holdout_candidate');
  if (!artifact.datasetHash || artifact.datasetHash !== trainerReport.datasetHash) warn('dataset_hash_mismatch');
  if (artifact.baselineVersion !== baseline.version || trainerReport.baselineManifest?.fingerprint !== baseline.fingerprint) warn('baseline_manifest_mismatch');
  if (artifact.featureSchema !== FEATURE_SCHEMA_VERSION || JSON.stringify(artifact.featureNames) !== JSON.stringify(FEATURE_NAMES)) warn('feature_schema_mismatch');
  const coherent = artifact.probabilityProtocol === COHERENT_PROBABILITY_PROTOCOL;
  if (!coherent) warn('legacy_probability_protocol_not_operational');
  if (coherent ? artifact.pipelineHashV2 !== coherentProbabilityPipelineHash() : artifact.pipelineHash !== researchPipelineHash()) {
    warn('calibration_pipeline_hash_mismatch');
  }
  const chronology = Number.isFinite(timestamp(final?.testFrom)) && Number.isFinite(timestamp(final?.testTo))
    && timestamp(artifact.trainedThrough) <= timestamp(artifact.validationThrough)
    && timestamp(artifact.validationThrough) < timestamp(final.testFrom) && timestamp(final.testTo) < now.getTime();
  if (!chronology) warn('final_holdout_chronology_failed');
  const profiles = (coherent ? artifact.calibrationProfilesV2 : artifact.calibrationProfiles) as {
    A?: ResearchCalibrationProfile; C?: ResearchCalibrationProfile;
  } | undefined;
  if (!profiles?.A || !profiles?.C) warn('calibration_profiles_missing');
  const predictions = (Array.isArray(trainerReport.predictions) ? trainerReport.predictions : [])
    .filter((row: any) => row.versionC === artifact.version);
  const ids = new Set(predictions.map((row: any) => row.matchId));
  const holdoutPolicy = assessResearchHoldout(predictions, options.evaluationPolicy);
  for (const reason of holdoutPolicy.reasons) warn(reason);
  if (ids.size !== predictions.length || predictions.some((row: any) => !row.matchId)) warn('invalid_or_duplicate_holdout_identity');
  if (!predictions.length || predictions.some((row: any) =>
    !Number.isFinite(timestamp(row.forecastAt)) || !Number.isFinite(timestamp(row.kickoffAt))
    || timestamp(row.forecastAt) < timestamp(final?.testFrom) || timestamp(row.forecastAt) > timestamp(final?.testTo)
    || timestamp(row.kickoffAt) - timestamp(row.forecastAt) !== 15 * 60000
    || timestamp(row.kickoffAt) + 2 * 3600000 > now.getTime())) warn('holdout_observation_chronology_failed');
  for (const prior of options.priorBenchmarks ?? []) {
    if (prior.modelVersion === artifact.version) continue;
    const previous = prior.report?.validation?.holdoutMatchIds;
    if (Array.isArray(previous) && previous.some((id: string) => ids.has(id))) { warn('holdout_reused_by_another_candidate'); break; }
  }
  const dataset = new Map((options.datasetRows ?? []).map((row) => [row.matchId, row]));
  const incumbent = options.incumbent;
  const evaluationRows: EvaluationRow[] = [];
  // Reject a consulted holdout before applying a new model or reading its outcomes.
  for (const row of holdoutPolicy.passed ? predictions : []) {
    try {
      let matrixA = row.matrixA;
      let matrixC = row.matrixC;
      const probabilitiesA = coherent ? applyCoherentProbabilityPipeline({ matrix: matrixA, rawProbabilities: row.probabilitiesA,
        profile: profiles?.A, quotes: [], forecastAt: row.forecastAt,
        mode: artifact.probabilityCalibrationMode as CoherentCalibrationMode, temperature: artifact.probabilityTemperature as number })
        : null;
      let flatA = coherent ? probabilitiesA!.decision : profiles?.A
        ? applyResearchProbabilityPipeline(row.probabilitiesA, profiles.A, [], row.forecastAt).calibrated : row.probabilitiesA;
      if (coherent) matrixA = probabilitiesA!.matrix;
      let referenceVersion = row.versionA;
      if (incumbent) {
        const input = dataset.get(row.matchId);
        const incumbentCoherent = incumbent.artifact.probabilityProtocol === COHERENT_PROBABILITY_PROTOCOL;
        const incumbentProfiles = (incumbentCoherent ? incumbent.artifact.calibrationProfilesV2 : incumbent.artifact.calibrationProfiles) as { C?: ResearchCalibrationProfile } | undefined;
        if (!input || !incumbentProfiles?.C) throw new Error('incumbent_comparison_inputs_missing');
        if (coherent && (!incumbentCoherent || incumbent.artifact.pipelineHashV2 !== coherentProbabilityPipelineHash())) {
          throw new Error('incumbent_coherent_probability_protocol_required');
        }
        const reference = predictHybrid(input, incumbent.artifact);
        matrixA = reference.matrix;
        if (coherent) {
          const pipeline = applyCoherentProbabilityPipeline({ matrix: matrixA, rawProbabilities: reference.probabilities,
            profile: incumbentProfiles.C, quotes: [], forecastAt: row.forecastAt,
            mode: incumbent.artifact.probabilityCalibrationMode as CoherentCalibrationMode,
            temperature: incumbent.artifact.probabilityTemperature as number });
          matrixA = pipeline.matrix; flatA = pipeline.decision;
        } else flatA = applyResearchProbabilityPipeline(reference.probabilities, incumbentProfiles.C,
          [], row.forecastAt).calibrated;
        referenceVersion = incumbent.version;
      }
      let probabilitiesC = !coherent && profiles?.C ? applyResearchProbabilityPipeline(scoreMatrixMarkets(row.matrixC), profiles.C,
        [], row.forecastAt).calibrated : scoreMatrixMarkets(row.matrixC);
      if (coherent) {
        const pipeline = applyCoherentProbabilityPipeline({ matrix: matrixC, rawProbabilities: scoreMatrixMarkets(matrixC),
          profile: profiles?.C, quotes: [], forecastAt: row.forecastAt,
          mode: artifact.probabilityCalibrationMode as CoherentCalibrationMode, temperature: artifact.probabilityTemperature as number });
        matrixC = pipeline.matrix; probabilitiesC = pipeline.decision;
      }
      evaluationRows.push({ ...row, matrixA, matrixC, probabilitiesA: flatA, probabilitiesC,
        modelVersionA: referenceVersion, modelVersionC: artifact.version, quotes: [], phase: 'test' });
    } catch { warn('unavailable_or_future_calibration_or_incumbent'); break; }
  }
  const evaluated = evaluateResearchBenchmark(evaluationRows);
  const operations = operationalEvidence(options.operationalRuns ?? [], artifact, now);
  if (!operations.passed) warn('measured_operational_checks_missing_or_failed');
  const paired = evaluated.paired;
  const nPaired = paired.n;
  const leagueCount = Object.keys(evaluated.byLeague).length;
  const periodCount = Object.keys(evaluated.byPeriod).length;
  const calibrationPassed = evaluated.A.ece !== null && evaluated.C.ece !== null && evaluated.C.ece <= evaluated.A.ece;
  const stableLeagues = Object.values(evaluated.byLeague).filter((group: any) =>
    group.A.logLoss !== null && group.C.logLoss !== null && group.C.logLoss <= group.A.logLoss).length;
  const minimums = nPaired >= 500 && leagueCount >= 4 && periodCount >= 4;
  const pairedCI = ciPasses(paired.weekLogLossCI) && ciPasses(paired.weekBrierCI);
  const passed = warnings.length === 0 && minimums && pairedCI && calibrationPassed && stableLeagues >= 4;
  return {
    ...evaluated, trainerReportType: trainerReport.type, datasetHash: artifact.datasetHash,
    candidateVersion: artifact.version, finalHoldout: final, calibrationProfiles: profiles,
    warnings, operationalEvidence: operations, holdoutPolicy,
    probabilityProtocol: artifact.probabilityProtocol ?? 'legacy-marginal-v1', pipelineHashV2: artifact.pipelineHashV2,
    probabilityCalibrationMode: artifact.probabilityCalibrationMode,
    probabilityTemperature: artifact.probabilityTemperature,
    calibrationProfilesV2: coherent ? profiles : undefined,
    validation: { passed, finalHoldout: chronology && holdoutPolicy.passed, pairedCI, minSamplesSatisfied: minimums,
      nPaired, leagueCount, periodCount, deltaLogLossCI: paired.weekLogLossCI, deltaBrierCI: paired.weekBrierCI,
      calibrationPassed, stableLeagues, operationalChecksPassed: operations.passed,
      preRegisteredRule: LIFECYCLE_RULE, comparisonReference: incumbent ? 'incumbent' : 'model_A',
      referenceModelVersion: incumbent?.version ?? baseline.version, dataHash: artifact.datasetHash,
      baselineHash: baseline.fingerprint, featureSchema: [...FEATURE_NAMES], holdoutMatchIds: [...ids].sort(),
      evaluationProtocol: holdoutPolicy.policyVersion, newIndependentForecastsAfter: holdoutPolicy.futureAfter },
    marketValidation: {},
    limitations: ['Probability-only promotion evaluation; no bookmaker prices are invented.',
      'Promotion does not enable a market. Market eligibility and prospective evidence are separate.',
      'Any final-holdout overlap with a different recorded candidate blocks promotion.'],
  };
}

/** Candidate registration is separate from promotion; failed checks preserve the incumbent. */
export async function registerLifecycleCandidate(db: LifecycleDatabase, input: {
  artifact: HybridArtifact; report: any; datasetRows?: any[]; now?: Date; evaluationPolicy?: ResearchEvaluationPolicy;
}) {
  const started = input.now ?? new Date();
  const artifact = input.artifact.probabilityProtocol === COHERENT_PROBABILITY_PROTOCOL
    ? JSON.parse(JSON.stringify(input.artifact)) as HybridArtifact : enrichLifecycleArtifact(input.artifact);
  validateArtifact(artifact);
  const baseline = baselineManifest();
  await db.research.saveModel({ family: 'A', version: baseline.version, artifact: baseline });
  await db.research.saveModel({ family: 'C', version: artifact.version, artifact });
  const incumbent = await db.research.getChampion('C');
  if (incumbent?.version === artifact.version) return { version: artifact.version, promoted: false, reason: 'already_champion' };
  const [priorBenchmarks, operationalRuns] = await Promise.all([
    db.research.listBenchmarks({ family: 'C', limit: 10000 }),
    db.listRecentSchedulerRunsByName?.('research_model_check', 50) ?? db.listRecentSchedulerRuns(50),
  ]);
  const report = buildLifecycleReport(artifact, input.report, { now: started, operationalRuns,
    priorBenchmarks, incumbent, datasetRows: input.datasetRows, evaluationPolicy: input.evaluationPolicy });
  const benchmark = await db.research.saveBenchmark({ family: 'C', modelVersion: artifact.version, report });
  for (const family of ['A', 'C'] as const) {
    const modelVersion = family === 'A' ? baseline.version : artifact.version;
    const existingMarkets = await db.research.listMarkets({ family, modelVersion });
    for (const market of [...GOAL_MARKETS, ...SPECIALIST_MARKETS]) {
      if (!existingMarkets.some((entry) => entry.market === market)) await db.research.setMarketState({ family,
        modelVersion, market, state: 'EXPERIMENTAL', reason: 'Independent market evidence not yet established' });
    }
  }
  let promoted = false;
  if (report.validation.passed && benchmark.validated === 1) {
    await db.research.promoteModel({ family: 'C', version: artifact.version, benchmarkId: benchmark.id,
      reason: 'Pre-registered final-holdout probability, calibration, stability and measured operational gates passed' });
    promoted = true;
  }
  const summary = { version: artifact.version, artifactHash: researchHash(artifact), benchmarkId: benchmark.id,
    promoted, validationPassed: report.validation.passed, blockers: report.warnings.map((warning) => warning.code),
    nPaired: report.validation.nPaired };
  await db.saveSchedulerRun({ schedulerName: 'research_training', trigger: 'weekly', startedAt: started.toISOString(),
    endedAt: new Date().toISOString(), success: true, summary });
  return summary;
}

/** Three consecutive measured model failures can restore only a previously approved champion. */
export async function rollbackUnhealthyChampion(db: LifecycleDatabase, now = new Date()) {
  const events = await db.research.listModelEvents('C');
  const champion = await db.research.getChampion('C');
  if (!champion) return { rolledBack: false, reason: 'no_champion' };
  const healthRuns = await (db.listRecentSchedulerRunsByName?.('research_model_check', 50) ?? db.listRecentSchedulerRuns(50));
  const matches = new Set<string>(), snapshots = new Set<string>();
  const runs = healthRuns.filter((run) => run.schedulerName === 'research_model_check'
    && run.summary?.family === 'C' && run.summary?.modelVersion === champion.version
    && timestamp(run.startedAt) <= now.getTime() && now.getTime() - timestamp(run.startedAt) <= WEEK_MS).sort(ordered)
    .filter((run) => {
      const matchId = run.summary?.matchId, snapshotHash = run.summary?.snapshotHash;
      if (!matchId || !snapshotHash || matches.has(matchId) || snapshots.has(snapshotHash)) return false;
      matches.add(matchId); snapshots.add(snapshotHash); return true;
    }).slice(0, 3);
  if (runs.length < 3 || runs.some((run) => run.success)) return { rolledBack: false, reason: 'no_repeated_model_failure' };
  const marketStates = await db.research.listMarkets({ family: 'C', modelVersion: champion.version });
  for (const market of marketStates) if (market.state !== 'SUSPENDED') await db.research.setMarketState({
    family: 'C', modelVersion: champion.version, market: market.market, state: 'SUSPENDED',
    evidence: { failureRunTimes: runs.map((run) => run.startedAt) }, reason: 'Three consecutive measured model failures',
  });
  const transition = [...events].reverse().find((event) => event.version === champion.version && event.action === 'PROMOTE');
  const previous = transition?.previousVersion;
  if (!previous) return { rolledBack: false, suspended: true, reason: 'no_previously_approved_champion' };
  await db.research.rollbackModel({ family: 'C', version: previous,
    reason: `Automatic rollback after three consecutive measured model failures (${runs.map((run) => run.startedAt).join(', ')})` });
  return { rolledBack: true, previousVersion: champion.version, version: previous };
}
