import type { Client, Transaction } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { buildForecastInput, ForecastInput, ResearchMatch, TOP5_COMPETITIONS } from './ForecastCore';
import { CHALLENGER_DATA_QUALITY_POLICY_HASH, challengerDataQualityReason, filterChallengerHistory } from './ChallengerDataQuality';
import { withChallengerFeatures, CHALLENGER_FEATURE_SCHEMA_VERSION, ChallengerFeatureBlock } from './ChallengerFeatures';
import { HybridArtifact, predictHybrid, validateArtifact } from './CatBoostModel';
import { applyCoherentProbabilityPipeline, COHERENT_PROBABILITY_PROTOCOL, coherentProbabilityPipelineHash, CoherentCalibrationMode } from './CoherentProbabilityPipeline';
import { buildProbabilityConfiguration } from './ProbabilityConfiguration';
import { evaluateResearchBenchmark, EvaluationRow, ResearchQuote } from './ResearchEvaluation';
import { ORIGINAL_HOLDOUT_POLICY } from './ResearchHoldoutPolicy';
import { prospectivePartition } from './ResearchProspectiveEvidence';
import { researchHash, researchJson } from './ResearchStore';

export type ChallengerSelectorPolicy = 'canonical-binary-v1' | 'payout-aware-v1';
export type ChallengerDeployment = { modelVersion: string; baselineVersion: string; selectorPolicy: ChallengerSelectorPolicy;
  probabilityConfigurationHash: string | null; artifactHash: string | null };
export type ChallengerAdoptionState = { deployment: ChallengerDeployment; revision: string;
  source: 'fallback' | 'adopted' | 'rollback' | 'suspended' };
export type ChallengerCandidateDossier = { id: string; candidate: ChallengerDeployment; reference: ChallengerDeployment;
  candidateArtifact: HybridArtifact; referenceArtifact: HybridArtifact; registeredAt: string;
  trainingEvidence: { datasetHash: string; matchIdsHash: string; matchCount: number }; rule: string;
  testPolicy: typeof CHALLENGER_ADOPTION_TEST_POLICY };

export const CHALLENGER_ADOPTION_RULE = 'prospective-challenger-adoption-v1';
export const CHALLENGER_ADOPTION_TEST_POLICY = { partition: 'FUTURE_TEST', matchCount: 500,
  minimumMonths: 4, minimumLeagues: 4, minimumPeriods: 4, selection: 'first-frozen-chronological', singleAssessment: true } as const;
export const INITIAL_CHALLENGER_DEPLOYMENT: ChallengerDeployment = {
  modelVersion: 'C-906371b0b3a1e2c8', baselineVersion: 'A-80cb25df5552621e', selectorPolicy: 'canonical-binary-v1',
  probabilityConfigurationHash: null, artifactHash: null,
};
const RESULT_DELAY = 2 * 3600000;
const WEEK = 7 * 86400000;
type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;
const parse = (value: unknown): any => typeof value === 'string' ? JSON.parse(value) : value;
const timestamp = (value: unknown) => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
const same = (left: unknown, right: unknown) => researchHash(left) === researchHash(right);
const selectors: ChallengerSelectorPolicy[] = ['canonical-binary-v1', 'payout-aware-v1'];
const protectedIds = new Set(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds);
const ciPasses = (value: unknown): boolean => Array.isArray(value) && value.length === 2
  && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) && value[0] <= value[1] && value[1] < 0;
async function rows(db: Executor, sql: string, args: any[] = []): Promise<any[]> { return (await db.execute({ sql, args })).rows as any[]; }
async function first(db: Executor, sql: string, args: any[] = []): Promise<any> { return (await rows(db, sql, args))[0] ?? null; }

function configuration(artifact: HybridArtifact) {
  validateArtifact(artifact);
  if (artifact.probabilityProtocol !== COHERENT_PROBABILITY_PROTOCOL || artifact.pipelineHashV2 !== coherentProbabilityPipelineHash()
    || !artifact.baselineVersion || artifact.diagnosticOnly === true || artifact.runtimeCompatible === false) throw new Error('challenger_configuration_not_operational');
  return buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
    pipelineHashV2: artifact.pipelineHashV2 as string, mode: artifact.probabilityCalibrationMode as CoherentCalibrationMode,
    temperature: artifact.probabilityTemperature as number, profile: (artifact.calibrationProfilesV2 as any)?.C });
}
function deployment(artifact: HybridArtifact, selectorPolicy: ChallengerSelectorPolicy): ChallengerDeployment {
  if (!selectors.includes(selectorPolicy)) throw new Error('explicit_challenger_selector_policy_required');
  return { modelVersion: artifact.version, baselineVersion: artifact.baselineVersion!, selectorPolicy,
    probabilityConfigurationHash: configuration(artifact).hash, artifactHash: researchHash(artifact) };
}
function forecast(artifact: HybridArtifact, input: ForecastInput, quotes: ResearchQuote[], history?: ResearchMatch[]) {
  let modelInput = input;
  let modelHistory = history;
  if (artifact.dataQualityPolicyHash !== undefined) {
    if (artifact.dataQualityPolicyHash !== CHALLENGER_DATA_QUALITY_POLICY_HASH
      || challengerDataQualityReason(input.matchId)) throw new Error('challenger_data_quality_inputs_unavailable');
    const tagged = input as ForecastInput & { dataQualityPolicyHash?: string; dataQualityBaselineClean?: boolean };
    if (tagged.dataQualityPolicyHash !== CHALLENGER_DATA_QUALITY_POLICY_HASH || tagged.dataQualityBaselineClean !== true) {
      const target = history?.find((match) => match.matchId === input.matchId);
      if (!target || !history) throw new Error('challenger_data_quality_target_unavailable');
      modelHistory = filterChallengerHistory(history);
      modelInput = { ...buildForecastInput(modelHistory, target, input.forecastAt),
        dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true } as ForecastInput;
    }
  }
  if (artifact.featureSchema === CHALLENGER_FEATURE_SCHEMA_VERSION) {
    if (!modelHistory) throw new Error('challenger_history_for_new_features_required');
    modelInput = withChallengerFeatures(modelInput, modelHistory, artifact.featureBlocks as ChallengerFeatureBlock[]);
  }
  const predicted = predictHybrid(modelInput, artifact);
  return applyCoherentProbabilityPipeline({ matrix: predicted.matrix, rawProbabilities: predicted.probabilities,
    profile: (artifact.calibrationProfilesV2 as any)?.C, quotes, forecastAt: input.forecastAt,
    mode: artifact.probabilityCalibrationMode as CoherentCalibrationMode, temperature: artifact.probabilityTemperature as number });
}

/** Immutable, genuinely pre-outcome forecasts are the only observations scored for adoption. */
export function buildChallengerAdoptionReport(dossier: ChallengerCandidateDossier, evidence: Array<{
  matchId: string; competition: string; forecastAt: string; kickoffAt: string; frozenAt: string;
  partition: string; snapshot: any; result: { homeGoals: number; awayGoals: number; availableAt: string; source: string };
}>, now = new Date()) {
  const blockers = new Set<string>();
  if (dossier.candidateArtifact.dataQualityPolicyHash !== CHALLENGER_DATA_QUALITY_POLICY_HASH
    || dossier.candidateArtifact.dataQualityBaselineClean !== true) blockers.add('candidate_data_quality_policy_unverified');
  const evaluationRows: EvaluationRow[] = [];
  const seen = new Set<string>();
  for (const row of evidence) {
    if (row.partition !== 'FUTURE_TEST') continue;
    if (protectedIds.has(row.matchId) || prospectivePartition(row.matchId) !== 'FUTURE_TEST') {
      blockers.add('protected_or_wrong_partition_evidence'); continue;
    }
    if (seen.has(row.matchId)) { blockers.add('duplicate_evidence'); continue; }
    seen.add(row.matchId);
    const at = timestamp(row.forecastAt), kickoff = timestamp(row.kickoffAt), frozen = timestamp(row.frozenAt);
    if (![at, kickoff, frozen].every(Number.isFinite) || at < timestamp(dossier.registeredAt)
      || at <= timestamp(ORIGINAL_HOLDOUT_POLICY.newIndependentForecastsAfter) || frozen < at || frozen >= kickoff
      || timestamp(row.result.availableAt) < kickoff + RESULT_DELAY || timestamp(row.result.availableAt) > now.getTime()
      || !row.result.source?.trim() || /synthetic|model|estimated|unknown/i.test(row.result.source)
      || !same(row.snapshot.candidate, dossier.candidate) || !same(row.snapshot.reference, dossier.reference)) {
      blockers.add('unproven_preoutcome_chronology_or_identity'); continue;
    }
    evaluationRows.push({ matchId: row.matchId, competition: row.competition, season: row.snapshot.season ?? '',
      kickoffAt: row.kickoffAt, forecastAt: row.forecastAt, homeGoals: row.result.homeGoals, awayGoals: row.result.awayGoals,
      matrixA: row.snapshot.referenceMatrix, matrixC: row.snapshot.candidateMatrix,
      probabilitiesA: row.snapshot.referenceProbabilities, probabilitiesC: row.snapshot.candidateProbabilities,
      modelVersionA: dossier.reference.modelVersion, modelVersionC: dossier.candidate.modelVersion, quotes: [], phase: 'test' });
  }
  const scored = evaluateResearchBenchmark(evaluationRows);
  if (scored.paired.n !== evaluationRows.length) blockers.add('invalid_frozen_probabilities_or_outcomes');
  const leagueCount = Object.keys(scored.byLeague).length, periodCount = Object.keys(scored.byPeriod).length;
  const stableLeagues = Object.values(scored.byLeague).filter((entry: any) => entry.C.logLoss !== null
    && entry.A.logLoss !== null && entry.C.logLoss <= entry.A.logLoss).length;
  const monthCount = new Set(evaluationRows.map((row) => row.kickoffAt.slice(0, 7))).size;
  const samplePassed = scored.paired.n >= 500 && leagueCount >= 4 && monthCount >= 4 && periodCount >= 4 && scored.paired.weekClusters >= 4;
  const pairedCI = ciPasses(scored.paired.weekLogLossCI) && ciPasses(scored.paired.weekBrierCI);
  const calibrationPassed = scored.C.ece !== null && scored.A.ece !== null && scored.C.ece <= scored.A.ece;
  if (!samplePassed) blockers.add('independent_future_evidence_insufficient');
  if (!pairedCI) blockers.add('paired_probability_improvement_not_established');
  if (!calibrationPassed) blockers.add('calibration_not_improved');
  if (stableLeagues < 4) blockers.add('league_stability_not_established');
  return { rule: CHALLENGER_ADOPTION_RULE, candidateId: dossier.id, candidate: dossier.candidate, reference: dossier.reference,
    evaluatedAt: now.toISOString(), validation: { passed: blockers.size === 0, nPaired: scored.paired.n,
      leagueCount, monthCount, periodCount, stableLeagues, samplePassed, pairedCI, calibrationPassed,
      operationalChecksPassed: evaluationRows.length >= 3, comparisonReference: 'incumbent' },
    blockers: [...blockers], metrics: { reference: scored.A, candidate: scored.C, paired: scored.paired,
      byLeague: scored.byLeague, byPeriod: scored.byPeriod }, holdoutMatchIds: [...seen].sort(),
    limitations: ['Probability comparison between C deployments; no bookmaker ROI or APP-A approval.',
      'FUTURE_TEST only; forecasts and outcomes are frozen separately and cannot be reconstructed retrospectively.'] };
}

/** C-only append-only deployment registry. It never writes a bet, ledger or A champion. */
export class ChallengerAdoptionStore {
  private schemaPresent = false;
  private readonly fallback: ChallengerDeployment;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly client: Client, private readonly ready: () => Promise<void> = async () => {},
    private readonly options: { clock?: () => Date; fallback?: ChallengerDeployment } = {}) {
    this.fallback = { ...(options.fallback ?? INITIAL_CHALLENGER_DEPLOYMENT) };
  }
  private async hasSchema(): Promise<boolean> {
    await this.ready();
    if (!this.schemaPresent) this.schemaPresent = Number((await first(this.client,
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('challenger_candidates','challenger_paired_forecasts','challenger_forecast_results','challenger_adoption_events','challenger_candidate_reviews')")).n) === 5;
    return this.schemaPresent;
  }
  private async now(tx: Executor): Promise<string> {
    return this.options.clock ? this.options.clock().toISOString()
      : String((await first(tx, "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")).now);
  }
  private async write<T>(work: (tx: Transaction, at: string) => Promise<T>): Promise<T> {
    if (!await this.hasSchema()) throw new Error('challenger_adoption_migration_required');
    const pending = this.writeQueue.then(async () => {
      const tx = await this.client.transaction('write');
      try { const result = await work(tx, await this.now(tx)); await tx.commit(); return result; }
      catch (error) { await tx.rollback().catch(() => undefined); throw error; }
      finally { tx.close(); }
    });
    this.writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private async state(tx: Executor): Promise<ChallengerAdoptionState> {
    const latest = await first(tx, 'SELECT * FROM challenger_adoption_events ORDER BY sequence DESC LIMIT 1');
    if (!latest) return { deployment: { ...this.fallback }, revision: 'initial', source: 'fallback' };
    return { deployment: parse(latest.deployment_json), revision: latest.id,
      source: latest.action === 'ADOPT' ? 'adopted' : latest.action === 'ROLLBACK' ? 'rollback' : 'suspended' };
  }
  async getState(): Promise<ChallengerAdoptionState> {
    if (!await this.hasSchema()) return { deployment: { ...this.fallback }, revision: 'initial', source: 'fallback' };
    return this.state(this.client);
  }
  async snapshot(): Promise<ChallengerAdoptionState> { return this.getState(); }
  private async model(tx: Executor, version: string): Promise<HybridArtifact> {
    const row = await first(tx, "SELECT artifact_json,artifact_hash FROM research_models WHERE family='C' AND version=?", [version]);
    if (!row || researchHash(parse(row.artifact_json)) !== row.artifact_hash) throw new Error('challenger_artifact_unavailable_or_corrupt');
    const artifact = parse(row.artifact_json) as HybridArtifact;
    configuration(artifact); return artifact;
  }
  private async currentDeployment(tx: Executor, state: ChallengerAdoptionState): Promise<ChallengerDeployment> {
    const artifact = await this.model(tx, state.deployment.modelVersion);
    const resolved = deployment(artifact, state.deployment.selectorPolicy);
    // The initial C keeps its historical runtime. A different benchmark transform
    // must not be silently represented by the artifact's probability configuration.
    if (state.deployment.probabilityConfigurationHash === null) {
      const benchmark = await first(tx, `SELECT json_extract(report_json,'$.probabilityProtocol') AS protocol,
        json_extract(report_json,'$.pipelineHashV2') AS pipeline_hash,
        json_extract(report_json,'$.probabilityCalibrationMode') AS mode,
        json_extract(report_json,'$.probabilityTemperature') AS temperature,
        json_extract(report_json,'$.calibrationProfilesV2.C') AS profile_json
        FROM research_benchmarks WHERE family='C' AND model_version=?
        ORDER BY created_at DESC,rowid DESC LIMIT 1`, [artifact.version]);
      if (benchmark?.protocol === COHERENT_PROBABILITY_PROTOCOL) {
        const effective = buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion!,
          pipelineHashV2: benchmark.pipeline_hash, mode: benchmark.mode ?? 'isotonic_1x2',
          temperature: benchmark.temperature, profile: parse(benchmark.profile_json) });
        if (effective.hash !== resolved.probabilityConfigurationHash) throw new Error('initial_challenger_reference_configuration_drift');
      }
    } else if (!same(state.deployment, resolved)) throw new Error('adopted_challenger_configuration_mismatch');
    return resolved;
  }
  async registerCandidate(input: { modelVersion: string; selectorPolicy: ChallengerSelectorPolicy;
    trainingEvidence: { datasetHash: string; matchIds: string[] } }): Promise<ChallengerCandidateDossier> {
    return this.write(async (tx, at) => {
      const active = await this.state(tx), artifact = await this.model(tx, input.modelVersion);
      const referenceArtifact = await this.model(tx, active.deployment.modelVersion);
      if (artifact.productionValidated === true) throw new Error('candidate_must_not_claim_production_approval');
      if (artifact.dataQualityPolicyHash !== CHALLENGER_DATA_QUALITY_POLICY_HASH || artifact.dataQualityBaselineClean !== true) {
        throw new Error('candidate_data_quality_policy_unverified');
      }
      const ids = input.trainingEvidence?.matchIds;
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => !id || protectedIds.has(id) || challengerDataQualityReason(id))
        || input.trainingEvidence.datasetHash !== artifact.datasetHash
        || (artifact.calibrationPredictions as any[] | undefined)?.some((row) => protectedIds.has(row.matchId)
          || challengerDataQualityReason(row.matchId))) throw new Error('independent_training_manifest_required');
      if ([artifact.createdAt, artifact.validationThrough, artifact.trainedThrough].some((value) => !Number.isFinite(timestamp(value)) || timestamp(value) > timestamp(at))) {
        throw new Error('candidate_not_available_at_registration');
      }
      const candidate = deployment(artifact, input.selectorPolicy), reference = await this.currentDeployment(tx, active);
      if (same(candidate, reference)) throw new Error('candidate_equals_incumbent');
      if (candidate.baselineVersion !== reference.baselineVersion) throw new Error('challenger_baseline_mismatch');
      const trainingEvidence = { datasetHash: String(artifact.datasetHash), matchIdsHash: researchHash([...ids].sort()), matchCount: ids.length };
      const id = researchHash({ candidate, reference, trainingEvidence, rule: CHALLENGER_ADOPTION_RULE, testPolicy: CHALLENGER_ADOPTION_TEST_POLICY });
      const existing = await first(tx, 'SELECT dossier_json FROM challenger_candidates WHERE id=?', [id]);
      if (existing) return parse(existing.dossier_json);
      const dossier: ChallengerCandidateDossier = { id, candidate, reference, candidateArtifact: artifact, referenceArtifact,
        registeredAt: at, trainingEvidence, rule: CHALLENGER_ADOPTION_RULE,
        testPolicy: { ...CHALLENGER_ADOPTION_TEST_POLICY } };
      await tx.execute({ sql: 'INSERT INTO challenger_candidates(id,model_version,reference_version,dossier_json,dossier_hash,registered_at) VALUES (?,?,?,?,?,?)',
        args: [id, candidate.modelVersion, reference.modelVersion, researchJson(dossier), researchHash(dossier), at] });
      return dossier;
    });
  }
  async listCollectingCandidates(): Promise<ChallengerCandidateDossier[]> {
    if (!await this.hasSchema()) return [];
    const state = await this.getState();
    const current = await this.currentDeployment(this.client, state);
    const entries = await rows(this.client, `SELECT c.* FROM challenger_candidates c
      LEFT JOIN challenger_candidate_reviews r ON r.candidate_id=c.id WHERE r.candidate_id IS NULL ORDER BY c.registered_at,c.id`);
    return entries.map((entry) => {
      const dossier = parse(entry.dossier_json) as ChallengerCandidateDossier;
      if (researchHash(dossier) !== entry.dossier_hash) throw new Error('challenger_dossier_corrupt');
      return dossier;
    }).filter((entry) => entry.candidateArtifact.dataQualityPolicyHash === CHALLENGER_DATA_QUALITY_POLICY_HASH
      && entry.candidateArtifact.dataQualityBaselineClean === true && same(entry.reference, current)
      && !same(entry.candidate, state.deployment)).slice(0, 1);
  }
  async recordPairedChallengerForecast(input: { candidateId: string; input: ForecastInput; quotes: ResearchQuote[];
    history?: ResearchMatch[] }): Promise<{ recorded: boolean; reason?: string; id?: string }> {
    if (!await this.hasSchema()) return { recorded: false, reason: 'challenger_adoption_unavailable' };
    return this.write(async (tx, at) => {
      const record = await first(tx, 'SELECT * FROM challenger_candidates WHERE id=?', [input.candidateId]);
      if (!record) return { recorded: false, reason: 'candidate_not_registered' };
      if (await first(tx, 'SELECT candidate_id FROM challenger_candidate_reviews WHERE candidate_id=?', [input.candidateId])) {
        return { recorded: false, reason: 'candidate_already_assessed' };
      }
      const dossier = parse(record.dossier_json) as ChallengerCandidateDossier;
      if (researchHash(dossier) !== record.dossier_hash) throw new Error('challenger_dossier_corrupt');
      if (dossier.candidateArtifact.dataQualityPolicyHash !== CHALLENGER_DATA_QUALITY_POLICY_HASH
        || dossier.candidateArtifact.dataQualityBaselineClean !== true) return { recorded: false, reason: 'candidate_data_quality_policy_unverified' };
      const row = input.input, current = await this.state(tx);
      if (!same(await this.currentDeployment(tx, current), dossier.reference)) {
        return { recorded: false, reason: 'incumbent_changed' };
      }
      if (protectedIds.has(row.matchId) || !row.matchId || !TOP5_COMPETITIONS.includes(row.competition as any)) return { recorded: false, reason: 'protected_or_unsupported_fixture' };
      const kickoff = timestamp(row.kickoffAt), observed = timestamp(row.forecastAt), now = timestamp(at);
      if (![kickoff, observed].every(Number.isFinite) || observed < timestamp(dossier.registeredAt)
        || observed <= timestamp(ORIGINAL_HOLDOUT_POLICY.newIndependentForecastsAfter) || now < observed || now - observed > 300000
        || now >= kickoff || !Number.isFinite(timestamp(row.modelFitAt)) || timestamp(row.modelFitAt) > observed
        || row.maxTrainingAvailableAt !== null && (!Number.isFinite(timestamp(row.maxTrainingAvailableAt))
          || timestamp(row.maxTrainingAvailableAt) > observed)) return { recorded: false, reason: 'forecast_not_genuinely_preoutcome' };
      const fixture = await first(tx, 'SELECT date,home_goals,away_goals FROM matches WHERE match_id=?', [row.matchId]);
      if (!fixture || timestamp(fixture.date) !== kickoff || fixture.home_goals != null || fixture.away_goals != null) return { recorded: false, reason: 'fixture_not_future' };
      const id = researchHash({ candidateId: dossier.id, matchId: row.matchId });
      const existing = await first(tx, 'SELECT id FROM challenger_paired_forecasts WHERE id=?', [id]);
      if (existing) return { recorded: false, reason: 'already_frozen', id };
      if ((dossier.candidateArtifact.featureSchema === CHALLENGER_FEATURE_SCHEMA_VERSION
        || dossier.referenceArtifact.featureSchema === CHALLENGER_FEATURE_SCHEMA_VERSION) && !input.history) {
        return { recorded: false, reason: 'challenger_history_for_new_features_required' };
      }
      const candidate = forecast(dossier.candidateArtifact, row, input.quotes, input.history);
      const reference = forecast(dossier.referenceArtifact, row, input.quotes, input.history);
      const snapshot = { candidate: dossier.candidate, reference: dossier.reference,
        candidateMatrix: candidate.matrix, referenceMatrix: reference.matrix,
        candidateProbabilities: candidate.decision, referenceProbabilities: reference.decision,
        inputHash: researchHash(row), quotesHash: researchHash(input.quotes), season: row.season ?? '' };
      const frozenAt = await this.now(tx);
      if (timestamp(frozenAt) >= kickoff) return { recorded: false, reason: 'fixture_started_during_forecast' };
      await tx.execute({ sql: `INSERT INTO challenger_paired_forecasts(id,candidate_id,match_id,competition,forecast_at,kickoff_at,frozen_at,partition,snapshot_json,snapshot_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, args: [id, dossier.id, row.matchId, row.competition, row.forecastAt, row.kickoffAt, frozenAt,
        prospectivePartition(row.matchId), researchJson(snapshot), researchHash(snapshot)] });
      return { recorded: true, id };
    });
  }
  private async settle(tx: Executor, candidateId: string, at: string): Promise<void> {
    const pending = await rows(tx, `SELECT f.*,m.home_goals,m.away_goals,m.date,m.source FROM challenger_paired_forecasts f
      JOIN matches m ON m.match_id=f.match_id LEFT JOIN challenger_forecast_results r ON r.forecast_id=f.id
      WHERE f.candidate_id=? AND r.forecast_id IS NULL`, [candidateId]);
    for (const row of pending) {
      if (![row.home_goals, row.away_goals].every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        || !String(row.source ?? '').trim() || /synthetic|model|estimated|unknown/i.test(String(row.source)) || timestamp(row.date) !== timestamp(row.kickoff_at)
        || timestamp(at) < timestamp(row.kickoff_at) + RESULT_DELAY) continue;
      await tx.execute({ sql: 'INSERT INTO challenger_forecast_results(forecast_id,home_goals,away_goals,source,kickoff_at,available_at) VALUES (?,?,?,?,?,?)',
        args: [row.id, row.home_goals, row.away_goals, row.source, row.kickoff_at, at] });
    }
  }
  async assessAndAdopt(input: { candidateId: string; expectedRevision?: string }): Promise<any> {
    if (!await this.hasSchema()) return { adopted: false, reason: 'challenger_adoption_unavailable', state: await this.getState() };
    return this.write(async (tx, at) => {
      const state = await this.state(tx);
      if (input.expectedRevision && input.expectedRevision !== state.revision) return { adopted: false, reason: 'incumbent_changed', state };
      const record = await first(tx, 'SELECT * FROM challenger_candidates WHERE id=?', [input.candidateId]);
      if (!record) return { adopted: false, reason: 'candidate_not_registered', state };
      const previousReview = await first(tx, 'SELECT report_json FROM challenger_candidate_reviews WHERE candidate_id=?', [input.candidateId]);
      if (previousReview) return { adopted: false, reason: 'candidate_already_assessed', report: parse(previousReview.report_json), state };
      const dossier = parse(record.dossier_json) as ChallengerCandidateDossier;
      if (researchHash(dossier) !== record.dossier_hash) throw new Error('challenger_dossier_corrupt');
      if (dossier.candidateArtifact.dataQualityPolicyHash !== CHALLENGER_DATA_QUALITY_POLICY_HASH
        || dossier.candidateArtifact.dataQualityBaselineClean !== true) return { adopted: false, reason: 'candidate_data_quality_policy_unverified', state };
      if (!same(await this.currentDeployment(tx, state), dossier.reference)) return { adopted: false, reason: 'incumbent_changed', state };
      await this.settle(tx, dossier.id, at);
      const fixedTest = await rows(tx, `SELECT id FROM challenger_paired_forecasts WHERE candidate_id=? AND partition='FUTURE_TEST'
        ORDER BY forecast_at,match_id LIMIT 500`, [dossier.id]);
      if (fixedTest.length < 500) return { adopted: false, reason: 'independent_future_evidence_insufficient', state,
        candidateId: dossier.id, frozenTestMatches: fixedTest.length, requiredMatches: 500 };
      const records = await rows(tx, `SELECT f.*,r.home_goals,r.away_goals,r.source,r.available_at,
        m.home_goals AS current_home,m.away_goals AS current_away,m.date AS current_kickoff
        FROM challenger_paired_forecasts f JOIN challenger_forecast_results r ON r.forecast_id=f.id
        JOIN matches m ON m.match_id=f.match_id WHERE f.id IN (${fixedTest.map(() => '?').join(',')})`, fixedTest.map((entry) => entry.id));
      if (records.length !== 500) return { adopted: false, reason: 'fixed_future_test_results_pending', state,
        candidateId: dossier.id, observedTestResults: records.length, requiredMatches: 500 };
      const evidence = records.map((row) => {
        const snapshot = parse(row.snapshot_json);
        if (researchHash(snapshot) !== row.snapshot_hash || row.home_goals !== row.current_home || row.away_goals !== row.current_away
          || timestamp(row.current_kickoff) !== timestamp(row.kickoff_at)) throw new Error('challenger_evidence_changed_or_corrupt');
        return { matchId: row.match_id, competition: row.competition, forecastAt: row.forecast_at, kickoffAt: row.kickoff_at,
          frozenAt: row.frozen_at, partition: row.partition, snapshot,
          result: { homeGoals: row.home_goals, awayGoals: row.away_goals, source: row.source, availableAt: row.available_at } };
      });
      const report = buildChallengerAdoptionReport(dossier, evidence, new Date(at));
      await tx.execute({ sql: 'INSERT INTO challenger_candidate_reviews(candidate_id,verdict,report_json,report_hash,assessed_at) VALUES (?,?,?,?,?)',
        args: [dossier.id, report.validation.passed ? 'ADOPT' : 'REJECT', researchJson(report), researchHash(report), at] });
      if (!report.validation.passed) return { adopted: false, reason: 'independent_evidence_not_passed', report, state };
      const id = randomUUID();
      await tx.execute({ sql: `INSERT INTO challenger_adoption_events(id,action,candidate_id,deployment_json,previous_json,evidence_json,evidence_hash,created_at)
        VALUES (?,'ADOPT',?,?,?,?,?,?)`, args: [id, dossier.id, researchJson(dossier.candidate), researchJson(dossier.reference), researchJson(report), researchHash(report), at] });
      return { adopted: true, report, state: { deployment: dossier.candidate, revision: id, source: 'adopted' } };
    });
  }
  async rollbackUnhealthy(): Promise<any> {
    if (!await this.hasSchema()) return { rolledBack: false, reason: 'challenger_adoption_unavailable' };
    return this.write(async (tx, at) => {
      const state = await this.state(tx);
      const latest = await first(tx, "SELECT * FROM challenger_adoption_events WHERE action='ADOPT' ORDER BY sequence DESC LIMIT 1");
      if (state.source !== 'adopted' || !latest || latest.id !== state.revision) return { rolledBack: false, reason: 'no_adopted_challenger', state };
      const runs = await rows(tx, "SELECT started_at,success,summary_json FROM scheduler_runs WHERE scheduler_name='research_model_check' ORDER BY started_at DESC,rowid DESC LIMIT 200");
      const matches = new Set<string>(), snapshots = new Set<string>();
      const matching = runs.filter((row) => {
        const summary = parse(row.summary_json), time = timestamp(row.started_at);
        const modelChecks = ['inference', 'calibrationCompatible', 'finiteProbabilities', 'coherentProbabilities'];
        const measuredFailure = modelChecks.some((key) => summary?.checks?.[key] === false);
        const measuredSuccess = (row.success === 1 || row.success === true)
          && modelChecks.every((key) => summary?.checks?.[key] === true);
        if (summary?.family !== 'C' || summary.modelVersion !== state.deployment.modelVersion
          || (summary.expectedProbabilityConfigurationHash ?? summary.probabilityConfigurationHash) !== state.deployment.probabilityConfigurationHash
          || summary.selectorPolicy !== state.deployment.selectorPolicy || time < timestamp(latest.created_at)
          || time > timestamp(at) || timestamp(at) - time > WEEK || !measuredFailure && !measuredSuccess || !summary.matchId || !summary.snapshotHash
          || matches.has(summary.matchId) || snapshots.has(summary.snapshotHash)) return false;
        matches.add(summary.matchId); snapshots.add(summary.snapshotHash); return true;
      }).slice(0, 3);
      if (matching.length !== 3 || matching.some((row) => {
        const checks = parse(row.summary_json)?.checks;
        return row.success === 1 || row.success === true
          || !['inference', 'calibrationCompatible', 'finiteProbabilities', 'coherentProbabilities'].some((key) => checks?.[key] === false);
      })) return { rolledBack: false, reason: 'no_repeated_model_failure', state };
      const previous = parse(latest.previous_json) as ChallengerDeployment;
      const previousArtifact = await this.model(tx, previous.modelVersion);
      if (!same(deployment(previousArtifact, previous.selectorPolicy), previous)) throw new Error('rollback_deployment_unavailable');
      const report = { reason: 'three_independent_model_failures', failedRevision: state.revision, runTimes: matching.map((row) => row.started_at) };
      const id = randomUUID();
      await tx.execute({ sql: `INSERT INTO challenger_adoption_events(id,action,candidate_id,deployment_json,previous_json,evidence_json,evidence_hash,created_at)
        VALUES (?,'ROLLBACK',?,?,?,?,?,?)`, args: [id, latest.candidate_id, researchJson(previous), researchJson(state.deployment), researchJson(report), researchHash(report), at] });
      return { rolledBack: true, state: { deployment: previous, revision: id, source: 'rollback' } };
    });
  }
  async reviewCandidates(): Promise<any> {
    const rollback = await this.rollbackUnhealthy();
    const assessments = [];
    for (const candidate of await this.listCollectingCandidates()) {
      const assessed = await this.assessAndAdopt({ candidateId: candidate.id });
      assessments.push(assessed);
      if (assessed.adopted) break;
    }
    return { rollback, assessments, state: await this.getState() };
  }
}
