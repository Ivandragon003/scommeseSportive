"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.predictionEngineConfig = void 0;
exports.predictionEngineConfig = {
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
    },
};
