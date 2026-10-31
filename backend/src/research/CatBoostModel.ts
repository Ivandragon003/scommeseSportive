import { ForecastInput, FEATURE_NAMES, FEATURE_SCHEMA_VERSION } from './ForecastCore';
import { normalizeScoreMatrix, scoreMatrixMarkets } from './GoalSettlement';
import { CHALLENGER_FEATURE_SCHEMA_VERSION, CHALLENGER_FEATURE_PROTOCOL, challengerBlocksForNames } from './ChallengerFeatures';

export type HybridCandidateKind = 'intensity_correction' | 'probability_correction' | 'calibrated_ensemble' | 'no_ml';
export interface CatBoostJson {
  features_info?: { float_features?: Array<{ feature_index: number; flat_feature_index: number }>;
    categorical_features?: unknown[]; text_features?: unknown[]; embedding_features?: unknown[] };
  oblivious_trees: Array<{ splits?: Array<{ split_type: string; float_feature_index?: number; border?: number }>;
    leaf_values: number[] }>;
  scale_and_bias: [number, number[]];
}
export interface HybridArtifact {
  version: string; family: 'C'; featureNames: string[]; featureSchema: string;
  trainedThrough: string; validationThrough: string; createdAt: string;
  candidateKind: HybridCandidateKind; weight: number; temperature: number;
  models: { home?: CatBoostJson; away?: CatBoostJson; probability?: CatBoostJson };
  baselineVersion?: string; metrics?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Numeric oblivious-tree inference for CatBoost's documented JSON export; no Python at runtime. */
export function predictCatBoostJson(model: CatBoostJson, features: number[]): number[] {
  if (!Array.isArray(features) || features.some((value) => !Number.isFinite(value))) throw new Error('non_finite_features');
  if (!Array.isArray(model?.oblivious_trees) || !Array.isArray(model.scale_and_bias) || !Array.isArray(model.scale_and_bias[1])) {
    throw new Error('invalid_catboost_json');
  }
  if ((model.features_info?.categorical_features?.length ?? 0) || (model.features_info?.text_features?.length ?? 0)
    || (model.features_info?.embedding_features?.length ?? 0)) throw new Error('unsupported_catboost_feature_type');
  const bias = model.scale_and_bias[1], dimension = bias.length;
  if (!dimension || !Number.isFinite(model.scale_and_bias[0]) || bias.some((value) => !Number.isFinite(value))) throw new Error('invalid_catboost_scale');
  const result = new Array(dimension).fill(0);
  const floatIndexes = new Map((model.features_info?.float_features ?? []).map((feature) => [feature.feature_index, feature.flat_feature_index]));
  for (const tree of model.oblivious_trees) {
    let leaf = 0;
    const splits = tree.splits ?? [];
    if (splits.length > 16 || tree.leaf_values.length !== 2 ** splits.length * dimension) throw new Error('invalid_catboost_tree');
    splits.forEach((split, depth) => {
      if (split.split_type !== 'FloatFeature' || !Number.isFinite(split.border)) throw new Error('unsupported_catboost_split');
      const index = floatIndexes.get(split.float_feature_index!) ?? split.float_feature_index!;
      if (!Number.isInteger(index) || index < 0 || index >= features.length) throw new Error('invalid_catboost_feature_index');
      // CatBoost quantizes numeric inputs to float32 before border comparisons.
      if (Math.fround(features[index]) > split.border!) leaf += 2 ** depth;
    });
    for (let dimensionIndex = 0; dimensionIndex < dimension; dimensionIndex++) {
      const value = tree.leaf_values[leaf * dimension + dimensionIndex];
      if (!Number.isFinite(value)) throw new Error('invalid_catboost_leaf');
      result[dimensionIndex] += value;
    }
  }
  return result.map((value, index) => value * model.scale_and_bias[0] + bias[index]);
}

export function validateArtifact(value: unknown): asserts value is HybridArtifact {
  const artifact = value as HybridArtifact;
  const legacyFeatures = artifact?.featureSchema === FEATURE_SCHEMA_VERSION
    && JSON.stringify(artifact.featureNames) === JSON.stringify(FEATURE_NAMES);
  const extendedBlocks = artifact?.featureSchema === CHALLENGER_FEATURE_SCHEMA_VERSION
    && Array.isArray(artifact.featureNames) ? challengerBlocksForNames(artifact.featureNames) : null;
  if (!artifact || artifact.family !== 'C' || !String(artifact.version ?? '').startsWith('C-')
    || !legacyFeatures && !extendedBlocks
    || !['intensity_correction', 'probability_correction', 'calibrated_ensemble', 'no_ml'].includes(artifact.candidateKind)
    || !Number.isFinite(artifact.weight) || artifact.weight < 0 || artifact.weight > 1
    || !Number.isFinite(artifact.temperature) || artifact.temperature < 0.25 || artifact.temperature > 4
    || !Number.isFinite(Date.parse(artifact.trainedThrough)) || !Number.isFinite(Date.parse(artifact.validationThrough))
    || Date.parse(artifact.trainedThrough) > Date.parse(artifact.validationThrough)
    || !Number.isFinite(Date.parse(artifact.createdAt)) || !artifact.models) throw new Error('invalid_hybrid_artifact');
  if (extendedBlocks) {
    const timing = artifact.trainingForecastTiming as { policy?: string; forecastBeforeKickoff?: boolean; resultDelayMs?: number };
    const split = artifact.trainingSplit as { protocol?: string; train?: any; selection?: any; calibration?: any; test?: any };
    if (artifact.featureProtocol !== CHALLENGER_FEATURE_PROTOCOL
      || JSON.stringify(artifact.featureBlocks) !== JSON.stringify(extendedBlocks)
      || !timing?.policy || timing.forecastBeforeKickoff !== true || timing.resultDelayMs !== 7200000
      || split?.protocol !== 'purged-temporal-train-selection-calibration-test-v1') throw new Error('invalid_challenger_training_metadata');
    for (const part of ['train', 'selection', 'calibration', 'test'] as const) {
      const range = split[part];
      if (!range || !Number.isSafeInteger(range.n) || range.n <= 0
        || !Number.isFinite(Date.parse(range.from)) || !Number.isFinite(Date.parse(range.to))
        || Date.parse(range.from) > Date.parse(range.to)) throw new Error('invalid_challenger_training_split');
    }
    for (const [earlier, later] of [['train', 'selection'], ['selection', 'calibration'], ['calibration', 'test']] as const) {
      if (Date.parse(split[earlier].to) >= Date.parse(split[later].from)
        || !Number.isFinite(Date.parse(split[earlier].availableThrough))
        || Date.parse(split[earlier].availableThrough) >= Date.parse(split[later].from)) throw new Error('future_challenger_training_information');
    }
  }
  if (artifact.candidateKind === 'no_ml') {
    if (artifact.weight !== 0 || artifact.temperature !== 1 || Object.keys(artifact.models).length) throw new Error('invalid_no_ml_control');
    return;
  }
  const models = artifact.candidateKind === 'probability_correction'
    ? [artifact.models.probability] : [artifact.models.home, artifact.models.away];
  for (const model of models) {
    if (!model || model.oblivious_trees?.length > 1000) throw new Error('invalid_hybrid_models');
    const raw = predictCatBoostJson(model, new Array(artifact.featureNames.length).fill(0));
    if (raw.length !== (artifact.candidateKind === 'probability_correction' ? 3 : 1)) throw new Error('invalid_hybrid_output_dimension');
  }
}

export const normalizeJoint = normalizeScoreMatrix;
export const jointMarketProbabilities = scoreMatrixMarkets;

function independentPoisson(home: number, away: number, size: number): number[][] {
  const pmf = (lambda: number) => { const result = [Math.exp(-lambda)]; for (let i = 1; i < size; i++) result.push(result[i - 1] * lambda / i); return result; };
  const h = pmf(home), a = pmf(away); return normalizeJoint(h.map((x) => a.map((y) => x * y)));
}

export function predictHybrid(input: ForecastInput, artifact: HybridArtifact): { matrix: number[][]; probabilities: Record<string, number>; version: string } {
  validateArtifact(artifact);
  if (input.featureSchema !== artifact.featureSchema || JSON.stringify(input.featureNames) !== JSON.stringify(artifact.featureNames)
    || input.features.length !== artifact.featureNames.length) throw new Error('hybrid_feature_schema_mismatch');
  // A model may never be backdated into a prediction prior to its validation interval.
  if (Date.parse(input.forecastAt) <= Date.parse(artifact.validationThrough)) throw new Error('hybrid_model_not_available_at_forecast');
  if (artifact.baselineVersion && input.baselineVersion !== artifact.baselineVersion) throw new Error('hybrid_baseline_mismatch');
  const baseline = normalizeJoint(input.baselineMatrix);
  if (artifact.candidateKind === 'no_ml') return { matrix: baseline, probabilities: jointMarketProbabilities(baseline), version: artifact.version };
  let ml: number[][];
  if (artifact.candidateKind === 'probability_correction') {
    const logits = predictCatBoostJson(artifact.models.probability!, input.features);
    const baselineMarkets = jointMarketProbabilities(baseline);
    const prior = [baselineMarkets.homeWin, baselineMarkets.draw, baselineMarkets.awayWin];
    const raw = logits.map((value, index) => value + Math.log(Math.max(1e-12, prior[index])));
    const max = Math.max(...raw), exp = raw.map((value) => Math.exp(value - max)), sum = exp.reduce((a, b) => a + b, 0);
    const corrected = exp.map((value) => value / sum);
    ml = normalizeJoint(baseline.map((row, h) => row.map((value, a) => {
      const index = h > a ? 0 : h === a ? 1 : 2; return value * corrected[index] / Math.max(1e-12, prior[index]);
    })));
  } else {
    const rawHome = predictCatBoostJson(artifact.models.home!, input.features)[0];
    const rawAway = predictCatBoostJson(artifact.models.away!, input.features)[0];
    const residual = artifact.candidateKind === 'intensity_correction';
    const home = Math.max(0.05, Math.min(8, Math.exp(rawHome + (residual ? Math.log(Math.max(0.05, input.lambdaHome)) : 0))));
    const away = Math.max(0.05, Math.min(8, Math.exp(rawAway + (residual ? Math.log(Math.max(0.05, input.lambdaAway)) : 0))));
    ml = independentPoisson(home, away, baseline.length);
  }
  const combined = baseline.map((row, h) => row.map((value, a) => (1 - artifact.weight) * value + artifact.weight * ml[h][a]));
  const matrix = normalizeJoint(combined.map((row) => row.map((value) => Math.pow(Math.max(1e-15, value), 1 / artifact.temperature))));
  return { matrix, probabilities: jointMarketProbabilities(matrix), version: artifact.version };
}
