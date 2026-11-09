import { CatBoostJson, predictCatBoostJson } from './CatBoostModel';
import { evaluateGoalQuote, MarketQuote, normalizeScoreMatrix, scoreMatrixMarkets } from './GoalSettlement';

/** Frozen C six-class recipe: H_U, H_O, D_U, D_O, A_U, A_O. */
export function jointHeadMatrix(input: number[][], model: CatBoostJson, features: number[]): number[][] {
  const baseline = normalizeScoreMatrix(input), logits = predictCatBoostJson(model, features);
  if (logits.length !== 6) throw new Error('invalid_joint_head_dimension');
  const max = Math.max(...logits), weights = logits.map(x => Math.exp(x - max));
  const sum = weights.reduce((a, b) => a + b, 0), probabilities = weights.map(x => x / sum);
  const index = (h: number, a: number) => (h > a ? 0 : h === a ? 1 : 2) * 2 + Number(h + a >= 3);
  const masses = new Array(6).fill(0);
  baseline.forEach((row, h) => row.forEach((v, a) => { masses[index(h, a)] += v; }));
  if (masses.some(v => !(v > 0))) throw new Error('joint_head_unsupported_partition');
  return normalizeScoreMatrix(baseline.map((row, h) => row.map((v, a) => {
    const k = index(h, a), lifted = v * probabilities[k] / masses[k];
    return Math.pow(Math.max(1e-15, .25 * v + .75 * lifted), 1 / .8);
  })));
}

/** Restore conditional score spread while preserving calibrated 1X2 mass. */
export function restoreJointHeadSpread(matrix: number[][]): number[][] {
  let maximum = 0;
  if (!Array.isArray(matrix) || !matrix.length || matrix.some(row => !Array.isArray(row) || row.length !== matrix.length
    || row.some(v => !Number.isFinite(v) || v < 0))) throw new Error('invalid_joint_head_matrix');
  for (const row of matrix) for (const v of row) maximum = Math.max(maximum, v);
  if (!(maximum > 0)) throw new Error('invalid_joint_head_matrix');
  const scaled = matrix.map(row => row.map(v => v / maximum));
  const total = scaled.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
  const normalized = scaled.map(row => row.map(v => v / total)), out = normalized.map(row => row.map(() => 0));
  for (let group = 0; group < 3; group++) {
    const cells: Array<{ h: number; a: number; log: number; mass: number }> = [];
    normalized.forEach((row, h) => row.forEach((mass, a) => {
      if (mass > 0 && (h > a ? 0 : h === a ? 1 : 2) === group) cells.push({ h, a, log: Math.log(mass), mass });
    }));
    if (!cells.length) continue;
    const mass = cells.reduce((s, cell) => s + cell.mass, 0), maxLog = Math.max(...cells.map(cell => cell.log));
    const weights = cells.map(cell => Math.exp((cell.log - maxLog) * .8)), sum = weights.reduce((s, v) => s + v, 0);
    cells.forEach((cell, i) => { out[cell.h][cell.a] = mass * (weights[i] / sum); });
  }
  return out;
}

/** Recompute all approved quote marginals from the same restored score matrix. */
export function jointHeadMarkets(matrix: number[][], quotes: MarketQuote[], prior: Record<string, number>): Record<string, number> {
  const result = scoreMatrixMarkets(matrix);
  for (const quote of quotes) if (!(quote.selection in result) && quote.selection in prior) {
    result[quote.selection] = evaluateGoalQuote(matrix, quote).probability;
  }
  return result;
}
