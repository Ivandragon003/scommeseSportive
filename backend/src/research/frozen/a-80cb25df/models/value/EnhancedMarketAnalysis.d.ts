import { ValueBettingEngine, BetOpportunity, ComboBetOpportunity, MarketCategory, AdaptiveCategoryTuning, AdaptiveEngineTuningProfile, ValueAnalysisContext } from './ValueBettingEngine';
export interface FamilyCalibrationCurve {
    points: Array<{
        x: number;
        y: number;
    }>;
    nObservations: number;
}
export declare function applyCalibrationToFlatProbabilities(flatProbabilities: Record<string, number>, calibrationPoints: Array<{
    x: number;
    y: number;
}>, nObservations: number, engine: ValueBettingEngine, calibrationByFamily?: Record<string, FamilyCalibrationCurve>): Record<string, number>;
export declare function applyIntraMatchCorrelationCap(opportunities: BetOpportunity[], maxSingleMatchExposure?: number): BetOpportunity[];
export declare function computeEvMultiplierFromRichness(richnessScore: number, sensitivity?: number): number;
export declare function buildRichnessAwareAdaptivePatch(richnessScore: number, baseEvThresholds: Partial<Record<MarketCategory, number>>): Partial<AdaptiveEngineTuningProfile['categories']>;
export declare function applyRichnessToSelectionFamilies(existingFamilies: Record<string, AdaptiveCategoryTuning> | undefined, richnessScore: number): Record<string, AdaptiveCategoryTuning>;
export declare function separateByMarketTier(opportunities: BetOpportunity[]): {
    coreBets: BetOpportunity[];
    secondaryBets: BetOpportunity[];
    speculativeBets: BetOpportunity[];
};
export declare function analyzeMarketsEnhanced(params: {
    flatProbabilities: Record<string, number>;
    marketGroups: ReturnType<ValueBettingEngine['buildMarketGroups']>;
    marketNames: Record<string, string>;
    matchId?: string;
    richnessScore: number;
    calibrationPoints: Array<{
        x: number;
        y: number;
    }>;
    nCalibrationObs: number;
    calibrationByFamily?: Record<string, FamilyCalibrationCurve>;
    engine: ValueBettingEngine;
    maxComboLegs?: number;
    minCombinedEV?: number;
    analysisContext?: ValueAnalysisContext;
}): {
    coreBets: BetOpportunity[];
    secondaryBets: BetOpportunity[];
    speculativeBets: BetOpportunity[];
    comboBets: ComboBetOpportunity[];
    allBets: BetOpportunity[];
};
export declare function evaluateComboBet(combo: ComboBetOpportunity, matchResults: Record<string, {
    homeGoals?: number;
    awayGoals?: number;
    homeTotalShots?: number;
    awayTotalShots?: number;
    homeYellowCards?: number;
    awayYellowCards?: number;
    homeFouls?: number;
    awayFouls?: number;
    homeShotsOnTarget?: number;
    awayShotsOnTarget?: number;
}>, evaluateSingleBet: (selection: string, matchData: any) => boolean | null): {
    won: boolean;
    allLegsEvaluable: boolean;
    legsResults: Array<{
        selection: string;
        won: boolean | null;
    }>;
};
