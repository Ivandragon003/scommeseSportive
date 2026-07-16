/**
 * Bootstrap mode used by DixonColesModel.bootstrapLambdas().
 * - paramNoise: implemented stochastic Gaussian parameter perturbation.
 * - jackknife: accepted compatibility mode; currently a deterministic shock-grid fallback, not empirical leave-one-out jackknife.
 * - hessian: accepted compatibility mode; currently a deterministic shock-grid fallback, not an analytic Hessian approximation.
 */
export type BootstrapMode = 'paramNoise' | 'jackknife' | 'hessian';
export type PlayerShotsDistribution = 'ZIP' | 'ZINB' | 'hierarchical';
export type MinutesDistributionMode = 'triangular' | 'empirical';
export type MultiplierMode = 'linearClamp' | 'logExp';
export type KellyMode = 'quarter' | 'dynamic';
/**
 * Combo risk mode.
 * covarianceMonteCarlo is a legacy/config name; current implementation is deterministic covariance proxy scaling,
 * not random Monte Carlo simulation. The name is retained for backward compatibility.
 */
export type ComboRiskMode = 'sqrtLegs' | 'covarianceMonteCarlo';
export type MetricWeightMode = 'none' | 'stake' | 'inverseOdds' | 'marketVariance';

export interface PredictionEngineConfig {
  dixonColes: {
    dynamicTeamStrengths: {
      /** Default false. Recommended range: boolean. When false, fitModel remains legacy/static. */
      enableDynamicTeamStrengths: boolean;
      /** Temporal L2 sigma for attack snapshots. Recommended range 0.05-1.00; fallback 0.25. */
      dynamicSmoothingSigmaAttack: number;
      /** Temporal L2 sigma for defence snapshots. Recommended range 0.05-1.00; fallback 0.25. */
      dynamicSmoothingSigmaDefence: number;
      /** Temporal L2 sigma for per-team home advantage. Recommended range 0.05-1.00; fallback 0.20. */
      dynamicSmoothingSigmaHomeAdvantage: number;
    };
    temporalWeights: {
      /** Current season weekly decay. Recommended range 0.000-0.020; fallback 0.002. */
      currentSeasonDecay: number;
      /** Previous season base weight. Recommended range 0.05-0.80; fallback 0.35. */
      previousSeasonBaseWeight: number;
      /** Previous season weekly decay. Recommended range 0.002-0.050; fallback 0.018. */
      previousSeasonDecay: number;
      /** Older seasons base weight. Recommended range 0.00-0.30; fallback 0.08. */
      olderSeasonBaseWeight: number;
      /** Older seasons weekly decay. Recommended range 0.002-0.080; fallback 0.018. */
      olderSeasonDecay: number;
      /** Pre-coach-change multiplier. Recommended range 0.00-0.50; fallback 0.15. */
      preCoachChangeWeightMultiplier: number;
      /** Pre-structural-break multiplier. Recommended range 0.00-0.60; fallback 0.25. */
      preStructuralBreakWeightMultiplier: number;
    };
    structuralBreaks: {
      /** Default false. Enables measurable rolling-stat detection when explicitly requested. */
      enableAutomaticStructuralBreakDetection: boolean;
      /** Rolling window size for break detection. Recommended range 3-10; fallback 5. */
      detectionWindow: number;
      /** Minimum confidence to accept a break. Recommended range 0.50-0.90; fallback 0.62. */
      minConfidence: number;
    };
    bootstrap: {
      /** Default paramNoise preserves v4 behavior. jackknife/hessian are deterministic fallback approximations, not full empirical/analytic implementations. */
      bootstrapMode: BootstrapMode;
      /** Number of samples. Recommended range 20-1000; fallback 200. */
      bootstrapSamples: number;
      /** CV reference for uncertaintyFactor. Recommended range 0.10-0.50; fallback 0.25. */
      uncertaintyCvReference: number;
    };
    xgBlend: {
      /** Default true. When true, fitModel maximizes a quasi-likelihood on blended pseudo-goals (xgWeight*xG + (1-xgWeight)*goals) for matches with valid xG. */
      enableXgBlend: boolean;
      /** Weight of xG in the blended pseudo-goal. Recommended range 0.30-0.80; fallback 0.60. */
      xgWeight: number;
      /** Sanity cap for a single-match xG value. Recommended range 4-10; fallback 8. */
      maxXgValue: number;
    };
  };
  specializedModels: {
    /** Relative tolerance for Poisson vs NegBin selection. Recommended range 0.05-1.00; fallback 0.50. */
    countDispersionTolerance: number;
    /** Shrinkage strength toward league/market dispersion. Recommended range 0-30; fallback 12. */
    dispersionShrinkageStrength: number;
    /** Minimum sample before team dispersion dominates league prior. Recommended range 5-30; fallback 12. */
    minSampleForTeamDispersion: number;
  };
  playerShots: {
    /** Default ZIP preserves existing behavior. ZINB/hierarchical are opt-in. */
    playerShotsDistribution: PlayerShotsDistribution;
    /** Default triangular preserves existing minutes model. empirical falls back to triangular with sparse data. */
    minutesDistributionMode: MinutesDistributionMode;
    /** Minimum minutes for shot-share observations. Recommended range 1-45; fallback 20. */
    minMinutesForShotShare: number;
    /** Team environment weight. Recommended range 0.00-0.70; fallback 0.35. */
    teamInfluenceWeight: number;
    /** Lower clamp for team influence. Recommended range 0.50-1.00; fallback 0.75. */
    minTeamInfluenceMultiplier: number;
    /** Upper clamp for team influence. Recommended range 1.00-1.60; fallback 1.30. */
    maxTeamInfluenceMultiplier: number;
  };
  playerCards: {
    /** Team card environment weight. Recommended range 0.00-0.50; fallback 0.25. */
    teamYellowInfluenceWeight: number;
    /** Minutes required before player rate dominates role prior. Recommended range 300-2000; fallback 900. */
    minMinutesForStableCards: number;
  };
  context: {
    weights: {
      /** Statistical form weight. Recommended range 0.00-0.50; fallback 0.12. */
      w_form: number;
      /** Measurable motivation/objective weight. Recommended range 0.00-0.40; fallback 0.06. */
      w_motivation: number;
      /** Absence weight. Recommended range 0.00-0.40; fallback 0.05. */
      w_absences: number;
      /** Discipline weight. Recommended range 0.00-0.30; fallback 0.03. */
      w_discipline: number;
      /** Rest weight. Recommended range 0.00-0.20; fallback 0.05. */
      w_rest: number;
      /** Schedule-load weight. Recommended range 0.00-0.20; fallback 0.04. */
      w_scheduleLoad: number;
      /** Form-absence interaction weight. Recommended range 0.00-0.15; fallback 0.04. */
      w_formAbsenceInteraction: number;
    };
    /** Multiplier mode. linearClamp preserves existing behavior; logExp is opt-in. */
    multiplierMode: MultiplierMode;
    richnessScore: {
      /** Baseline richness. Recommended range 0.10-0.50; fallback 0.30. */
      baseline: number;
      /** Sample component weight. Recommended range 0.00-0.60; fallback 0.32. */
      sampleWeight: number;
      /** xG availability component. Recommended range 0.00-0.30; fallback 0.12. */
      xgWeight: number;
      /** Player coverage component. Recommended range 0.00-0.25; fallback 0.10. */
      playerCoverageWeight: number;
      /** Referee coverage component. Recommended range 0.00-0.20; fallback 0.06. */
      refereeCoverageWeight: number;
      /** Lower clamp. Recommended range 0.10-0.50; fallback 0.30. */
      min: number;
      /** Upper clamp. Recommended range 0.70-0.99; fallback 0.93. */
      max: number;
    };
  };
  valueBetting: {
    /** Kelly mode. quarter preserves existing behavior; dynamic is opt-in. */
    kellyMode: KellyMode;
    /** Dynamic Kelly minimum fraction. Recommended range 0.05-0.25; fallback 0.10. */
    dynamicKellyMinFraction: number;
    /** Dynamic Kelly maximum fraction. Recommended range 0.25-0.75; fallback 0.50. */
    dynamicKellyMaxFraction: number;
    /** Enables dynamic EV thresholds when explicit context is provided. */
    dynamicEvThresholdEnabled: boolean;
    bootstrapUncertainty: {
      /** Default true. Feeds DixonColesModel.bootstrapLambdas uncertainty into the stake/risk pipeline. */
      enableBootstrapUncertainty: boolean;
      /** Additive weight of the bootstrap uncertainty inside uncertaintyFactor. Recommended range 0.10-0.60; fallback 0.35. */
      uncertaintyWeight: number;
    };
    operational: {
      /** MAX_ODDS operational cap. Recommended range 3.00-20.00; fallback 8.00. */
      maxOdds: number;
      /** When true, applies MAX_ODDS to every active market including shots/cards. */
      applyMaxOddsToAllMarkets: boolean;
    };
  };
  lineupXg: {
    /** Default true. Adjusts team xG inputs from player-level absences passed in the prediction request. */
    enableLineupXgAdjustment: boolean;
    /** Fraction of an absent player's xG that the replacement is assumed to produce. Recommended range 0.40-0.85; fallback 0.60. */
    replacementRatio: number;
    /** Maximum total xG reduction per team from absences. Recommended range 0.08-0.30; fallback 0.18. */
    maxXgReduction: number;
  };
  comboBetting: {
    /** Risk mode. covarianceMonteCarlo uses deterministic covariance proxy scaling; no random simulation is performed. */
    comboRiskMode: ComboRiskMode;
  };
  calibration: {
    /** Desired adaptive buckets. Recommended range 3-20; fallback 10. */
    desiredBuckets: number;
    /** Minimum bucket size floor. Recommended range 10-100; fallback 20. */
    minBucketSize: number;
    /** Default true. Fits a separate isotonic curve per market family (per competition) with global fallback. */
    enablePerFamilyCalibration: boolean;
    /** Minimum (prediction, outcome) pairs required to trust a family-specific curve. Recommended range 60-400; fallback 120. */
    perFamilyMinSamples: number;
  };
  marketBlending: {
    /** Default true. Learns per-category model-vs-market blend weights from historical odds+outcomes (log-loss grid search). */
    enableLearnedBlendWeights: boolean;
    /** Minimum samples per category before a learned weight is applied. Recommended range 40-300; fallback 80. */
    learnedBlendMinSamples: number;
    /** Maximum deviation of the learned weight from the heuristic weight. Recommended range 0.05-0.30; fallback 0.18. */
    learnedBlendMaxShift: number;
  };
  ensemble: {
    /** Default true. Blends Dixon-Coles goal-market probabilities with an independent Poisson-xG model BEFORE per-family calibration. Backward-compatible: no-op if the fitted model lacks Poisson-xG params. */
    enabled: boolean;
    /**
     * Peso del modello Poisson-xG nel blend, per famiglia di mercato goal:
     *   p = (1 - w) * p_DixonColes + w * p_PoissonXg
     * Ogni famiglia ricade su `default` se non specificata. Predisposto per pesi
     * distinti (1X2 / Over-Under / BTTS); da backtest OOS 2026-07 l'ottimo è ~0.5
     * per tutte. Recommended range 0.00-0.65; fallback 0.50.
     */
    weights: {
      default: number;
      oneXTwo?: number;
      overUnder?: number;
      btts?: number;
    };
  };
  backtesting: {
    /** Weight mode for probability metrics. none preserves legacy unweighted metrics. */
    metricWeightMode: MetricWeightMode;
  };
  adaptiveTuning: {
    /** Category confidence denominator. Recommended range 4-30; fallback 12. */
    confidenceWeightDenominator: number;
    /** Lower evDelta clamp. Recommended range -0.05-0.00; fallback -0.012. */
    evDeltaMin: number;
    /** Upper evDelta clamp. Recommended range 0.00-0.03; fallback 0.008. */
    evDeltaMax: number;
  };
  operational: {
    /** Primary user-visible odds provider. */
    primaryOddsProvider: 'odds_api';
    /** Default false: Sofascore supplemental flow remains disabled. */
    sofascoreSupplementalEnabled: boolean;
    /** Understat-only market switches; fallback markets stay disabled in value filtering. */
    understatOnlyMarkets: {
      cornersEnabled: boolean;
      foulsEnabled: boolean;
    };
  };
}

export const predictionEngineConfig: PredictionEngineConfig = {
  dixonColes: {
    dynamicTeamStrengths: {
      enableDynamicTeamStrengths: false,
      dynamicSmoothingSigmaAttack: 0.25,
      dynamicSmoothingSigmaDefence: 0.25,
      dynamicSmoothingSigmaHomeAdvantage: 0.20,
    },
    temporalWeights: {
      currentSeasonDecay: 0.002,
      previousSeasonBaseWeight: 0.35,
      previousSeasonDecay: 0.018,
      olderSeasonBaseWeight: 0.08,
      olderSeasonDecay: 0.018,
      preCoachChangeWeightMultiplier: 0.15,
      preStructuralBreakWeightMultiplier: 0.25,
    },
    structuralBreaks: {
      enableAutomaticStructuralBreakDetection: false,
      detectionWindow: 5,
      minConfidence: 0.62,
    },
    bootstrap: {
      bootstrapMode: 'paramNoise',
      bootstrapSamples: 200,
      uncertaintyCvReference: 0.25,
    },
    xgBlend: {
      enableXgBlend: true,
      // 0.80: ottimo empirico (plateau 0.75-0.85) da backtest walk-forward OOS
      // 2026-07 su 5 leghe/~3500 partite (−0.11% logLoss, ECE cal 0.0060→0.0041
      // vs 0.60 precedente). Oltre 0.85 la logLoss ririsale.
      xgWeight: 0.80,
      maxXgValue: 8,
    },
  },
  specializedModels: {
    countDispersionTolerance: 0.5,
    dispersionShrinkageStrength: 12,
    minSampleForTeamDispersion: 12,
  },
  playerShots: {
    playerShotsDistribution: 'ZIP',
    minutesDistributionMode: 'triangular',
    minMinutesForShotShare: 20,
    teamInfluenceWeight: 0.35,
    minTeamInfluenceMultiplier: 0.75,
    maxTeamInfluenceMultiplier: 1.30,
  },
  playerCards: {
    teamYellowInfluenceWeight: 0.25,
    minMinutesForStableCards: 900,
  },
  context: {
    weights: {
      w_form: 0.12,
      w_motivation: 0.06,
      w_absences: 0.05,
      w_discipline: 0.03,
      w_rest: 0.05,
      w_scheduleLoad: 0.04,
      w_formAbsenceInteraction: 0.04,
    },
    multiplierMode: 'linearClamp',
    richnessScore: {
      baseline: 0.30,
      sampleWeight: 0.32,
      xgWeight: 0.12,
      playerCoverageWeight: 0.10,
      refereeCoverageWeight: 0.06,
      min: 0.30,
      max: 0.93,
    },
  },
  valueBetting: {
    kellyMode: 'quarter',
    dynamicKellyMinFraction: 0.10,
    dynamicKellyMaxFraction: 0.50,
    dynamicEvThresholdEnabled: false,
    bootstrapUncertainty: {
      enableBootstrapUncertainty: true,
      uncertaintyWeight: 0.35,
    },
    operational: {
      maxOdds: 8.00,
      applyMaxOddsToAllMarkets: true,
    },
  },
  lineupXg: {
    enableLineupXgAdjustment: true,
    replacementRatio: 0.60,
    maxXgReduction: 0.18,
  },
  comboBetting: {
    comboRiskMode: 'sqrtLegs',
  },
  calibration: {
    desiredBuckets: 10,
    minBucketSize: 20,
    enablePerFamilyCalibration: true,
    perFamilyMinSamples: 120,
  },
  marketBlending: {
    enableLearnedBlendWeights: true,
    learnedBlendMinSamples: 80,
    learnedBlendMaxShift: 0.18,
  },
  ensemble: {
    enabled: true,
    weights: { default: 0.5, oneXTwo: 0.5, overUnder: 0.5, btts: 0.5 },
  },
  backtesting: {
    metricWeightMode: 'none',
  },
  adaptiveTuning: {
    confidenceWeightDenominator: 12,
    evDeltaMin: -0.012,
    evDeltaMax: 0.008,
  },
  operational: {
    primaryOddsProvider: 'odds_api',
    sofascoreSupplementalEnabled: false,
    understatOnlyMarkets: {
      cornersEnabled: false,
      foulsEnabled: false,
    },
  },
};
