import { predictionEngineConfig } from '../config/PredictionEngineConfig';
import { clamp } from '../models/utils/MathUtils';

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

export type AdaptiveTuningScope = 'category' | 'family';

export interface AdaptiveTuningBucket {
  totalWeight: number;
  rankingErrors: number;
  filterRejections: number;
  confirmations: number;
  wrongPicks: number;
}

export interface AdaptiveTuningProfileEntry {
  evDelta: number;
  coherenceDelta: number;
  rankingMultiplier: number;
  sampleSize: number;
  rankingErrorRate: number;
  filterRejectionRate: number;
  confirmationRate: number;
  wrongPickRate: number;
}

export class AdaptiveTuningService {
  private computeCore(params: {
    filterRejectionRate: number;
    rankingErrorRate: number;
    confirmationRate: number;
    wrongPickRate: number;
    totalWeight: number;
    scope: AdaptiveTuningScope;
  }) {
    const family = params.scope === 'family';

    const confidenceScale = clamp(
      params.totalWeight / (family ? 8 : predictionEngineConfig.adaptiveTuning.confidenceWeightDenominator),
      0.2,
      1.0,
    );

    const rawEvDelta =
      -params.filterRejectionRate * (family ? 0.018 : 0.010)
      - params.rankingErrorRate * (family ? 0.004 : 0.002)
      + params.confirmationRate * 0.002
      + params.wrongPickRate * (family ? 0.010 : 0.004);

    const rawCoherenceDelta =
      -params.filterRejectionRate * (family ? 0.10 : 0.06)
      - params.rankingErrorRate * (family ? 0.02 : 0.015)
      + params.confirmationRate * 0.01
      + params.wrongPickRate * (family ? 0.05 : 0.02);

    const rawRankingMultiplier =
      1 +
      (params.rankingErrorRate * (family ? 0.26 : 0.14)) +
      (params.confirmationRate * (family ? 0.04 : 0.05)) -
      (params.filterRejectionRate * 0.03) -
      (params.wrongPickRate * (family ? 0.18 : 0.10));

    const evDelta = clamp(
      rawEvDelta * confidenceScale,
      family ? -0.02 : predictionEngineConfig.adaptiveTuning.evDeltaMin,
      family ? 0.012 : predictionEngineConfig.adaptiveTuning.evDeltaMax,
    );

    const coherenceDelta = clamp(
      rawCoherenceDelta * confidenceScale,
      family ? -0.12 : -0.08,
      family ? 0.05 : 0.03,
    );

    const rankingMultiplier = clamp(
      1 + ((rawRankingMultiplier - 1) * confidenceScale),
      family ? 0.85 : 0.9,
      family ? 1.25 : 1.18,
    );

    return { confidenceScale, rawEvDelta, evDelta, coherenceDelta, rankingMultiplier };
  }

  computeCategoryTuning(rates: AdaptiveTuningRates): AdaptiveTuningComputation {
    const core = this.computeCore({
      filterRejectionRate: Number(rates.filterRejectionRate ?? 0),
      rankingErrorRate: Number(rates.rankingErrorRate ?? 0),
      confirmationRate: Number(rates.confirmationRate ?? 0),
      wrongPickRate: Number(rates.wrongPickRate ?? 0),
      totalWeight: Math.max(0, Number(rates.totalWeight ?? 0)),
      scope: 'category',
    });

    return {
      evDelta: Number(core.evDelta.toFixed(4)),
      rawEvDelta: Number(core.rawEvDelta.toFixed(4)),
      confidenceScale: Number(core.confidenceScale.toFixed(4)),
    };
  }

  buildTuning(bucket: AdaptiveTuningBucket, scope: AdaptiveTuningScope): AdaptiveTuningProfileEntry {
    const total = Math.max(0.15, Number(bucket.totalWeight ?? 0));
    const rankingErrorRate = bucket.rankingErrors / total;
    const filterRejectionRate = bucket.filterRejections / total;
    const confirmationRate = bucket.confirmations / total;
    const wrongPickRate = bucket.wrongPicks / total;

    const core = this.computeCore({
      filterRejectionRate,
      rankingErrorRate,
      confirmationRate,
      wrongPickRate,
      totalWeight: total,
      scope,
    });

    return {
      evDelta: Number(core.evDelta.toFixed(4)),
      coherenceDelta: Number(core.coherenceDelta.toFixed(4)),
      rankingMultiplier: Number(core.rankingMultiplier.toFixed(3)),
      sampleSize: Number(total.toFixed(2)),
      rankingErrorRate: Number((rankingErrorRate * 100).toFixed(2)),
      filterRejectionRate: Number((filterRejectionRate * 100).toFixed(2)),
      confirmationRate: Number((confirmationRate * 100).toFixed(2)),
      wrongPickRate: Number((wrongPickRate * 100).toFixed(2)),
    };
  }
}
