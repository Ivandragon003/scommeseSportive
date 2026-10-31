import { buildForecastInput, FEATURE_NAMES, FEATURE_SCHEMA_VERSION, ForecastInput, ResearchMatch,
  TrainingDataset, TrainingRow, baselineManifest, TOP5_COMPETITIONS } from './ForecastCore';
import { HISTORICAL_RESULT_DELAY_MS } from '../services/ChronologicalForecastService';
import { ORIGINAL_HOLDOUT_POLICY } from './ResearchHoldoutPolicy';
import { CHALLENGER_DATA_QUALITY_MANIFEST, CHALLENGER_DATA_QUALITY_POLICY_HASH,
  ChallengerDataQualityEvidence, ChallengerDataQualityManifest, ChallengerDataQualityTag,
  challengerDataQualityReason, filterChallengerHistory, getChallengerDataQualityEvidence,
  hasCleanChallengerBaseline } from './ChallengerDataQuality';

export const CHALLENGER_FEATURE_SCHEMA_VERSION = 'prematch-challenger-v2';
export const CHALLENGER_FEATURE_PROTOCOL = 'asof-opponent-xg-calendar-v1';
export type ChallengerFeatureBlock = 'recent_xg' | 'schedule';
const recentNames = ['recent_xg_for', 'recent_xg_against', 'recent_adjusted_xg_for',
  'recent_adjusted_xg_against', 'recent_xg_coverage'];
const scheduleNames = ['observed_rest_days', 'observed_matches_7d', 'observed_matches_14d'];
const sides = (names: string[]) => ['home', 'away'].flatMap((side) => names.map((name) => `${side}_${name}`));
export const CHALLENGER_FEATURE_BLOCKS: Record<ChallengerFeatureBlock, string[]> = {
  recent_xg: sides(recentNames), schedule: sides(scheduleNames),
};
export const DEFAULT_CHALLENGER_BLOCKS: ChallengerFeatureBlock[] = ['recent_xg', 'schedule'];
const day = 86400000;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const competition = (value: string) => ({ EPL: 'Premier League', La_liga: 'La Liga', 'La liga': 'La Liga',
  Ligue_1: 'Ligue 1', Serie_A: 'Serie A' }[value] ?? value);
const completed = (match: ResearchMatch) => finite(match.homeGoals) && finite(match.awayGoals)
  && Number.isSafeInteger(match.homeGoals) && Number.isSafeInteger(match.awayGoals) && match.homeGoals >= 0 && match.awayGoals >= 0;
export const challengerResultAvailableAt = (match: ResearchMatch): number => Math.max(Date.parse(match.date) + HISTORICAL_RESULT_DELAY_MS,
  match.availableAt === undefined ? 0 : Date.parse(match.availableAt));

export function challengerFeatureNames(blocks: readonly ChallengerFeatureBlock[] = DEFAULT_CHALLENGER_BLOCKS): string[] {
  if (!blocks.length || new Set(blocks).size !== blocks.length || blocks.some((block) => !CHALLENGER_FEATURE_BLOCKS[block])) {
    throw new Error('invalid_challenger_feature_blocks');
  }
  return [...FEATURE_NAMES, ...blocks.flatMap((block) => CHALLENGER_FEATURE_BLOCKS[block])];
}

export function challengerBlocksForNames(names: readonly string[]): ChallengerFeatureBlock[] | null {
  for (const blocks of [['recent_xg'], ['schedule'], ['recent_xg', 'schedule'], ['schedule', 'recent_xg']] as ChallengerFeatureBlock[][]) {
    if (JSON.stringify(names) === JSON.stringify(challengerFeatureNames(blocks))) return blocks;
  }
  return null;
}

type XgObservation = { match: ResearchMatch; xgf: number; xga: number; adjustedFor: number; adjustedAgainst: number };
type RunningXg = { count: number; for: number; against: number };

/** Opponent strength for a historical game is estimated before that game's kickoff, never afterwards. */
function opponentAdjustedXg(matches: ResearchMatch[]): Map<string, { home: XgObservation; away: XgObservation }> {
  const ready = [...matches].sort((a, b) => challengerResultAvailableAt(a) - challengerResultAvailableAt(b));
  const ratings = new Map<string, RunningXg>(), observations = new Map<string, { home: XgObservation; away: XgObservation }>();
  let cursor = 0, total = 0, count = 0;
  const add = (team: string, xgf: number, xga: number) => {
    const previous = ratings.get(team) ?? { count: 0, for: 0, against: 0 };
    ratings.set(team, { count: previous.count + 1, for: previous.for + xgf, against: previous.against + xga });
  };
  const strength = (team: string, field: 'for' | 'against') => {
    const league = count ? total / count : 1.3, prior = ratings.get(team) ?? { count: 0, for: 0, against: 0 };
    const mean = (prior[field] + 5 * league) / (prior.count + 5);
    return Math.max(.5, Math.min(2, mean / Math.max(.05, league)));
  };
  for (const match of matches) {
    while (cursor < ready.length && challengerResultAvailableAt(ready[cursor]) <= Date.parse(match.date)) {
      const past = ready[cursor++];
      if (!finite(past.homeXG) || !finite(past.awayXG) || past.homeXG < 0 || past.awayXG < 0) continue;
      add(past.homeTeamId, past.homeXG, past.awayXG); add(past.awayTeamId, past.awayXG, past.homeXG);
      total += past.homeXG + past.awayXG; count += 2;
    }
    if (!finite(match.homeXG) || !finite(match.awayXG) || match.homeXG < 0 || match.awayXG < 0) continue;
    const observation = (home: boolean): XgObservation => {
      const opponent = home ? match.awayTeamId : match.homeTeamId;
      const xgf = home ? match.homeXG! : match.awayXG!, xga = home ? match.awayXG! : match.homeXG!;
      return { match, xgf, xga, adjustedFor: xgf / strength(opponent, 'against'), adjustedAgainst: xga / strength(opponent, 'for') };
    };
    observations.set(match.matchId, { home: observation(true), away: observation(false) });
  }
  return observations;
}

export type ChallengerForecastInput = ForecastInput & {
  featureBlocks: ChallengerFeatureBlock[];
  dataQualityPolicyHash: string; dataQualityBaselineClean: boolean;
  challengerFeatureMetadata: { protocol: string; forecastAt: string; maxHistoryAvailableAt: string | null;
    recentMatches: number; opponentPriorMatches: number; resultDelayMs: number;
    dataQualityPolicyHash: string; quarantinedHistoryRows: number };
};

/** Extend a clone of the frozen baseline. No A probability, feature or parameter is changed in place. */
export function withChallengerFeatures(input: ForecastInput, history: ResearchMatch[],
  blocks: readonly ChallengerFeatureBlock[] = DEFAULT_CHALLENGER_BLOCKS): ChallengerForecastInput {
  const featureNames = challengerFeatureNames(blocks), cutoff = Date.parse(input.forecastAt), kickoff = Date.parse(input.kickoffAt);
  if (challengerDataQualityReason(input.matchId)) throw new Error('challenger_target_data_quarantined');
  if (input.featureSchema !== FEATURE_SCHEMA_VERSION || JSON.stringify(input.featureNames) !== JSON.stringify(FEATURE_NAMES)
    || input.features.length !== FEATURE_NAMES.length || !input.features.every(finite)) throw new Error('challenger_requires_legacy_baseline_features');
  if (!Number.isFinite(cutoff) || !Number.isFinite(kickoff) || cutoff >= kickoff || !input.homeTeamId || !input.awayTeamId
    || !Number.isFinite(Date.parse(input.modelFitAt)) || Date.parse(input.modelFitAt) > cutoff
    || input.maxTrainingAvailableAt && (!Number.isFinite(Date.parse(input.maxTrainingAvailableAt)) || Date.parse(input.maxTrainingAvailableAt) > cutoff)) {
    throw new Error('invalid_challenger_forecast_context');
  }
  const protectedIds = new Set(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds);
  const seen = new Set<string>();
  const past = filterChallengerHistory(history).filter((match) => {
    if (match.matchId === input.matchId || protectedIds.has(match.matchId) || seen.has(match.matchId) || !completed(match)
      || !Number.isFinite(Date.parse(match.date)) || !Number.isFinite(challengerResultAvailableAt(match))
      || challengerResultAvailableAt(match) > cutoff) return false;
    seen.add(match.matchId); return true;
  }).sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.matchId.localeCompare(b.matchId));
  const observations = opponentAdjustedXg(past.filter((match) => competition(match.competition) === competition(input.competition)));
  const forTeam = (team: string) => past.filter((match) => match.homeTeamId === team || match.awayTeamId === team);
  const recent = (team: string): number[] => {
    const rows = forTeam(team).filter((match) => competition(match.competition) === competition(input.competition)).slice(-5);
    const values = rows.map((match) => observations.get(match.matchId)?.[match.homeTeamId === team ? 'home' : 'away'])
      .filter((entry): entry is XgObservation => !!entry);
    const mean = (field: 'xgf' | 'xga' | 'adjustedFor' | 'adjustedAgainst') => values.length
      ? values.reduce((sum, value) => sum + value[field], 0) / values.length : 1.3;
    return [mean('xgf'), mean('xga'), mean('adjustedFor'), mean('adjustedAgainst'), rows.length ? values.length / rows.length : 0];
  };
  const schedule = (team: string): number[] => {
    const rows = forTeam(team);
    return [rows.length ? Math.min(60, Math.max(0, (cutoff - Date.parse(rows[rows.length - 1].date)) / day)) : 60,
      rows.filter((match) => cutoff - Date.parse(match.date) <= 7 * day).length,
      rows.filter((match) => cutoff - Date.parse(match.date) <= 14 * day).length];
  };
  const extra = { recent_xg: [...recent(input.homeTeamId), ...recent(input.awayTeamId)],
    schedule: [...schedule(input.homeTeamId), ...schedule(input.awayTeamId)] };
  return { ...input, featureSchema: CHALLENGER_FEATURE_SCHEMA_VERSION, featureNames,
    features: [...input.features, ...blocks.flatMap((block) => extra[block])], featureBlocks: [...blocks],
    dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH,
    dataQualityBaselineClean: hasCleanChallengerBaseline(input as ForecastInput & ChallengerDataQualityTag),
    challengerFeatureMetadata: { protocol: CHALLENGER_FEATURE_PROTOCOL, forecastAt: input.forecastAt,
      maxHistoryAvailableAt: past.length ? new Date(Math.max(...past.map(challengerResultAvailableAt))).toISOString() : null,
      recentMatches: 5, opponentPriorMatches: 5, resultDelayMs: HISTORICAL_RESULT_DELAY_MS,
      dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH,
      quarantinedHistoryRows: getChallengerDataQualityEvidence(history).history.excludedRows } };
}

export type ChallengerTrainingDataset = Omit<TrainingDataset, 'rows'> & { rows: Array<TrainingRow & ChallengerForecastInput>;
  featureBlocks: ChallengerFeatureBlock[]; forecastTiming: { policy: string; resultDelayMs: number; forecastBeforeKickoff: true };
  protectedMatchesExcluded: number; protectedHoldoutPolicyVersion: string;
  dataQualityPolicyHash: string; dataQualityPolicy: ChallengerDataQualityManifest;
  dataQualityBaselineClean: boolean; dataQualityEvidence: ChallengerDataQualityEvidence;
  targetWindow?: { field: 'forecastAt'; from: string | null; until: string | null } };

export function extendChallengerTrainingDataset(dataset: TrainingDataset & ChallengerDataQualityTag & {
  forecastTiming?: ChallengerTrainingDataset['forecastTiming']; protectedMatchesExcluded?: number;
  dataQualityPolicy?: ChallengerDataQualityManifest; dataQualityEvidence?: ChallengerDataQualityEvidence;
}, history: ResearchMatch[],
  blocks: readonly ChallengerFeatureBlock[] = DEFAULT_CHALLENGER_BLOCKS): ChallengerTrainingDataset {
  const protectedIds = new Set(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds);
  const evidence = getChallengerDataQualityEvidence(history, dataset.rows);
  const cleanBaseline = hasCleanChallengerBaseline(dataset)
    && dataset.rows.every((row) => hasCleanChallengerBaseline(row as TrainingRow & ChallengerDataQualityTag));
  if (dataset.dataQualityPolicyHash !== undefined && dataset.dataQualityPolicyHash !== CHALLENGER_DATA_QUALITY_POLICY_HASH) {
    throw new Error('challenger_data_quality_policy_mismatch');
  }
  // Removing rows or recalculating only extra columns cannot repair an already fitted dirty baseline.
  if (evidence.history.excludedRows > 0 && !cleanBaseline) throw new Error('challenger_baseline_data_quality_rebuild_required');
  const rows = filterChallengerHistory(dataset.rows).filter((row) => !protectedIds.has(row.matchId));
  return { ...dataset, schemaVersion: CHALLENGER_FEATURE_SCHEMA_VERSION, featureNames: challengerFeatureNames(blocks),
    rows: rows.map((row) => ({ ...row, ...withChallengerFeatures(row, history, blocks) })), featureBlocks: [...blocks],
    forecastTiming: dataset.forecastTiming ?? { policy: 'preserved-input-forecast-times', resultDelayMs: HISTORICAL_RESULT_DELAY_MS, forecastBeforeKickoff: true },
    protectedMatchesExcluded: (dataset.protectedMatchesExcluded ?? 0) + dataset.rows.filter((row) => protectedIds.has(row.matchId)).length,
    dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityPolicy: CHALLENGER_DATA_QUALITY_MANIFEST,
    dataQualityBaselineClean: cleanBaseline, dataQualityEvidence: cleanBaseline && dataset.dataQualityEvidence
      ? dataset.dataQualityEvidence : evidence,
    protectedHoldoutPolicyVersion: ORIGINAL_HOLDOUT_POLICY.version };
}

/** Build forecasts at the real decision boundary; a T-15 dataset must never be relabelled as nightly. */
export function buildChallengerTrainingDataset(history: ResearchMatch[], asOf: string, options: {
  forecastAt: (kickoffAt: string) => string; forecastPolicy: string; blocks?: readonly ChallengerFeatureBlock[];
  forecastBuilder?: typeof buildForecastInput; targetFrom?: string; targetUntil?: string; targetCompetitions?: string[];
}): ChallengerTrainingDataset {
  const cutoff = Date.parse(asOf); if (!Number.isFinite(cutoff) || !options.forecastPolicy) throw new Error('invalid_challenger_dataset_policy');
  const from = options.targetFrom === undefined ? -Infinity : Date.parse(options.targetFrom);
  const until = options.targetUntil === undefined ? Infinity : Date.parse(options.targetUntil);
  if (Number.isNaN(from) || Number.isNaN(until) || from >= until) throw new Error('invalid_challenger_target_window');
  if (options.targetCompetitions && (!options.targetCompetitions.length
    || options.targetCompetitions.some((name) => !TOP5_COMPETITIONS.includes(competition(name) as any)))) {
    throw new Error('invalid_challenger_target_competitions');
  }
  const targetCompetitions = options.targetCompetitions ? new Set(options.targetCompetitions.map(competition)) : null;
  const cleanHistory = filterChallengerHistory(history), targetPopulation: ResearchMatch[] = [];
  const protectedIds = new Set(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds);
  const exclusions = { insufficientHistory: 0, incomplete: 0, outsideTop5: 0 }, rows: Array<TrainingRow & ChallengerDataQualityTag> = [];
  let protectedMatchesExcluded = 0;
  const seen = new Set<string>();
  for (const target of [...history].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.matchId.localeCompare(b.matchId))) {
    if (seen.has(target.matchId)) throw new Error(`duplicate_match_id: ${target.matchId}`); seen.add(target.matchId);
    if (targetCompetitions && !targetCompetitions.has(competition(target.competition))) continue;
    if (!TOP5_COMPETITIONS.includes(competition(target.competition) as any)) { exclusions.outsideTop5++; continue; }
    if (!completed(target) || !Number.isFinite(challengerResultAvailableAt(target)) || challengerResultAvailableAt(target) > cutoff) {
      exclusions.incomplete++; continue;
    }
    const forecastAt = options.forecastAt(target.date), forecast = Date.parse(forecastAt);
    if (!Number.isFinite(forecast) || forecast >= Date.parse(target.date)) throw new Error('invalid_challenger_decision_boundary');
    if (forecast < from || forecast >= until) continue;
    targetPopulation.push(target);
    const protectedTarget = protectedIds.has(target.matchId);
    if (protectedTarget) protectedMatchesExcluded++;
    if (challengerDataQualityReason(target.matchId) || protectedTarget) continue;
    try {
      const input = (options.forecastBuilder ?? buildForecastInput)(cleanHistory, target, forecastAt);
      if (input.matchId !== target.matchId || Date.parse(input.kickoffAt) !== Date.parse(target.date)
        || Date.parse(input.forecastAt) !== forecast || Date.parse(input.modelFitAt) > forecast
        || input.maxTrainingAvailableAt && Date.parse(input.maxTrainingAvailableAt) > forecast) throw new Error('future_challenger_baseline_information');
      rows.push({ ...input, homeGoals: target.homeGoals!, awayGoals: target.awayGoals!,
        dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true,
        availableAt: new Date(challengerResultAvailableAt(target)).toISOString() });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('insufficient_history')) { exclusions.insufficientHistory++; continue; }
      throw error;
    }
  }
  const base = { schemaVersion: FEATURE_SCHEMA_VERSION, featureNames: [...FEATURE_NAMES],
    asOf: new Date(cutoff).toISOString(), baselineManifest: baselineManifest(), rows, exclusions,
    dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityPolicy: CHALLENGER_DATA_QUALITY_MANIFEST,
    dataQualityBaselineClean: true, dataQualityEvidence: getChallengerDataQualityEvidence(history, targetPopulation) };
  return { ...extendChallengerTrainingDataset(base, history, options.blocks), protectedMatchesExcluded,
    targetWindow: { field: 'forecastAt', from: options.targetFrom ?? null, until: options.targetUntil ?? null },
    forecastTiming: { policy: options.forecastPolicy, resultDelayMs: HISTORICAL_RESULT_DELAY_MS, forecastBeforeKickoff: true } };
}
