import { predictionEngineConfig } from '../config/PredictionEngineConfig';

export interface AdaptiveTuningRates {
  filterRejectionRate?: number;
  rankingErrorRate?: number;
  confirmationRate?: number;
  wrongPickRate?: number;
  totalWeight?: number;
}

export interface AdaptiveTuningComputation {
  evDelta: number;
  rawEvDelta: number;
  confidenceScale: number;
}

export class AdaptiveTuningService {
  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  computeCategoryTuning(rates: AdaptiveTuningRates): AdaptiveTuningComputation {
    const filterRejectionRate = Number(rates.filterRejectionRate ?? 0);
    const rankingErrorRate = Number(rates.rankingErrorRate ?? 0);
    const confirmationRate = Number(rates.confirmationRate ?? 0);
    const wrongPickRate = Number(rates.wrongPickRate ?? 0);
    const totalWeight = Math.max(0, Number(rates.totalWeight ?? 0));

    const rawEvDelta =
      -filterRejectionRate * 0.010
      - rankingErrorRate * 0.002
      + confirmationRate * 0.002
      + wrongPickRate * 0.004;

    const confidenceScale = this.clamp(
      totalWeight / predictionEngineConfig.adaptiveTuning.confidenceWeightDenominator,
      0.2,
      1.0,
    );

    const evDelta = this.clamp(
      rawEvDelta * confidenceScale,
      predictionEngineConfig.adaptiveTuning.evDeltaMin,
      predictionEngineConfig.adaptiveTuning.evDeltaMax,
    );

    return {
      evDelta: Number(evDelta.toFixed(4)),
      rawEvDelta: Number(rawEvDelta.toFixed(4)),
      confidenceScale: Number(confidenceScale.toFixed(4)),
    };
  }
}
