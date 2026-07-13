import { predictionEngineConfig } from '../config/PredictionEngineConfig';
import { clamp } from '../models/utils/MathUtils';

/**
 * MarketBlendLearningService — apprendimento del peso modello↔mercato.
 *
 * Il blending in ValueBettingEngine usa un peso euristico
 * (0.50 + dataQuality*0.35 ± aggiustamenti di categoria). Qui apprendiamo
 * il peso ottimale per categoria dai dati storici: per ogni coppia
 * (probabilità modello, probabilità mercato de-vig, esito) cerchiamo via
 * grid search il peso w che minimizza la log-loss della probabilità
 * blended w*p_model + (1-w)*p_market.
 *
 * Il peso appreso NON sostituisce l'euristica: la corregge entro un
 * raggio massimo (learnedBlendMaxShift) e solo con campione sufficiente
 * (learnedBlendMinSamples). Con pochi dati si resta sull'euristica.
 */

export interface BlendLearningSample {
  /** MarketCategory della selezione (es. goal_1x2, goal_over, btts_yes). */
  category: string;
  /** Probabilità del modello (già calibrata, 0-1 esclusi). */
  modelProb: number;
  /** Probabilità di mercato senza vig (0-1 esclusi). */
  marketProbNoVig: number;
  /** Esito reale della selezione: 1 vinta, 0 persa. */
  outcome: 0 | 1;
}

export interface LearnedBlendWeight {
  /** Peso del modello che minimizza la log-loss sul campione. */
  modelWeight: number;
  sampleSize: number;
  /** Log-loss media con solo modello (w=1). */
  logLossModelOnly: number;
  /** Log-loss media con il peso appreso. */
  logLossLearned: number;
}

export interface LearnBlendWeightsOptions {
  minSamples?: number;
  /** Estremi della griglia di ricerca; default allineati ai clamp dell'engine (0.40-0.84). */
  weightMin?: number;
  weightMax?: number;
  weightStep?: number;
}

const EPS = 1e-9;

function meanLogLoss(
  samples: Array<{ modelProb: number; marketProbNoVig: number; outcome: 0 | 1 }>,
  modelWeight: number
): number {
  let total = 0;
  for (const sample of samples) {
    const blended = clamp(
      modelWeight * sample.modelProb + (1 - modelWeight) * sample.marketProbNoVig,
      EPS,
      1 - EPS
    );
    total += sample.outcome === 1 ? -Math.log(blended) : -Math.log(1 - blended);
  }
  return total / samples.length;
}

export function learnBlendWeights(
  samples: BlendLearningSample[],
  options: LearnBlendWeightsOptions = {}
): Record<string, LearnedBlendWeight> {
  const minSamples = Math.max(10, options.minSamples ?? predictionEngineConfig.marketBlending.learnedBlendMinSamples);
  const weightMin = clamp(options.weightMin ?? 0.40, 0, 1);
  const weightMax = clamp(options.weightMax ?? 0.84, weightMin, 1);
  const weightStep = Math.max(0.005, options.weightStep ?? 0.02);

  const byCategory = new Map<string, BlendLearningSample[]>();
  for (const sample of samples ?? []) {
    const category = String(sample?.category ?? '').trim();
    const modelProb = Number(sample?.modelProb);
    const marketProb = Number(sample?.marketProbNoVig);
    const outcome = sample?.outcome;
    if (!category) continue;
    if (!Number.isFinite(modelProb) || modelProb <= 0 || modelProb >= 1) continue;
    if (!Number.isFinite(marketProb) || marketProb <= 0 || marketProb >= 1) continue;
    if (outcome !== 0 && outcome !== 1) continue;
    const bucket = byCategory.get(category) ?? [];
    bucket.push({ category, modelProb, marketProbNoVig: marketProb, outcome });
    byCategory.set(category, bucket);
  }

  const learned: Record<string, LearnedBlendWeight> = {};

  for (const [category, bucket] of byCategory.entries()) {
    if (bucket.length < minSamples) continue;

    let bestWeight = weightMax;
    let bestLoss = Infinity;
    for (let w = weightMin; w <= weightMax + 1e-9; w += weightStep) {
      const loss = meanLogLoss(bucket, w);
      if (loss < bestLoss - 1e-12) {
        bestLoss = loss;
        bestWeight = w;
      }
    }

    learned[category] = {
      modelWeight: Number(bestWeight.toFixed(3)),
      sampleSize: bucket.length,
      logLossModelOnly: Number(meanLogLoss(bucket, 1).toFixed(6)),
      logLossLearned: Number(bestLoss.toFixed(6)),
    };
  }

  return learned;
}

/**
 * Probabilità no-vig di una selezione a partire dalle quote della selezione
 * e delle companion dello stesso mercato (2-way o 3-way).
 * Restituisce null se non ci sono abbastanza quote per rimuovere il vig.
 */
export function noVigProbability(odds: number, companionOdds: number[]): number | null {
  if (!Number.isFinite(odds) || odds <= 1) return null;
  const validCompanions = (companionOdds ?? []).filter((o) => Number.isFinite(o) && o > 1);
  if (validCompanions.length === 0) return null;
  const impliedSelf = 1 / odds;
  const impliedTotal = impliedSelf + validCompanions.reduce((sum, o) => sum + 1 / o, 0);
  if (impliedTotal <= 0) return null;
  const noVig = impliedSelf / impliedTotal;
  return noVig > 0 && noVig < 1 ? noVig : null;
}
