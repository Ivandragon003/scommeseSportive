import { DixonColesModel, FullMatchProbabilities, ScoreMatrix, SupplementaryData } from '../models/core/DixonColesModel';
import { PoissonXgModel } from '../models/core/PoissonXgModel';
import { blendGoalProbabilities, EnsembleConfig } from './ProbabilityEnsembleService';

export interface PreparedForecast {
  homeTeamId: string;
  awayTeamId: string;
  full: FullMatchProbabilities;
  matrix: ScoreMatrix;
}

/** Calculate Dixon–Coles before any asynchronous loading of its ensemble partner. */
export function prepareSharedForecast(model: DixonColesModel, homeTeamId: string, awayTeamId: string,
  homeXG?: number, awayXG?: number, supplementaryData?: SupplementaryData): PreparedForecast {
  return { homeTeamId, awayTeamId,
    ...model.computeFullProbabilitiesWithMatrix(homeTeamId, awayTeamId, homeXG, awayXG, supplementaryData) };
}

/** Finish the common goal ensemble. The optional joint proxy preserves the research protocol. */
export function finishSharedForecast(prepared: PreparedForecast, poisson: PoissonXgModel | null,
  ensemble: EnsembleConfig, includeJointProxy = false): {
    full: FullMatchProbabilities; flatProbabilities: Record<string, number>; jointProxy?: number[][];
  } {
  const { homeTeamId, awayTeamId, full, matrix } = prepared;
  const poissonProbabilities = ensemble.enabled && poisson?.hasParams()
    ? poisson.computeGoalProbabilities(homeTeamId, awayTeamId) : null;
  const flatProbabilities = blendGoalProbabilities(full.flatProbabilities, poissonProbabilities, ensemble);
  if (!includeJointProxy) return { full, flatProbabilities };

  // Preserve the actual contextual matrix, including the model's dependence implementation.
  const dependence = matrix.probabilities;
  const poissonMatrix = poisson?.computeScoreMatrix(homeTeamId, awayTeamId, dependence.length - 1) ?? null;
  const weight = ensemble.enabled && poissonMatrix ? Math.max(0, Math.min(1, ensemble.weights.default)) : 0;
  const partner = poissonMatrix ?? dependence;
  const jointProxy = dependence.map((row, i) => row.map((p, j) => (1 - weight) * p + weight * partner[i][j]));
  return { full, flatProbabilities, jointProxy };
}
