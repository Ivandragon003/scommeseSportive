export declare const FEATURE_SCHEMA_VERSION = "prematch-numeric-v1";
export declare const BASELINE_PROTOCOL_VERSION = "statistical-asof-v1";
export declare const TOP5_COMPETITIONS: readonly ["Serie A", "Premier League", "La Liga", "Bundesliga", "Ligue 1"];
export interface ResearchMatch {
    matchId: string;
    homeTeamId: string;
    awayTeamId: string;
    date: string;
    competition: string;
    season?: string;
    homeGoals?: number | null;
    awayGoals?: number | null;
    homeXG?: number | null;
    awayXG?: number | null;
    homeTotalShots?: number | null;
    awayTotalShots?: number | null;
    homeShotsOnTarget?: number | null;
    awayShotsOnTarget?: number | null;
    homeYellowCards?: number | null;
    awayYellowCards?: number | null;
    homeRedCards?: number | null;
    awayRedCards?: number | null;
    homeFouls?: number | null;
    awayFouls?: number | null;
    /** Optional observed availability; never earlier than the conservative result delay. */
    availableAt?: string;
}
export interface ForecastInput {
    matchId: string;
    competition: string;
    kickoffAt: string;
    forecastAt: string;
    season?: string;
    homeTeamId?: string;
    awayTeamId?: string;
    features: number[];
    featureNames: string[];
    featureSchema: string;
    baselineMatrix: number[][];
    baselineProbabilities: Record<string, number>;
    lambdaHome: number;
    lambdaAway: number;
    maxTrainingAvailableAt: string | null;
    trainingCount: number;
    modelFitAt: string;
    baselineVersion: string;
}
export interface TrainingRow extends ForecastInput {
    homeGoals: number;
    awayGoals: number;
    availableAt: string;
}
export interface TrainingDataset {
    schemaVersion: string;
    featureNames: string[];
    asOf: string;
    baselineManifest: ReturnType<typeof baselineManifest>;
    rows: TrainingRow[];
    exclusions: {
        insufficientHistory: number;
        incomplete: number;
        outsideTop5: number;
    };
}
export declare const FEATURE_NAMES: string[];
declare const _BASELINE_DETAILS: {
    protocolVersion: string;
    algorithmVersion: string;
    backtestEngineVersion: string;
    rankingVersion: string;
    featureSchema: string;
    minTrainingMatches: number;
    refitIntervalMs: number;
    resultDelayMs: number;
    predictionConfig: any;
    predictionEngineConfig: any;
    fit: {
        iterations: number;
        learningRate: number;
    };
    codeHashes: Record<string, string>;
    probabilityProtocol: string;
    matrixProtocol: string;
    oddsAsFeatures: boolean;
    playerFeatures: boolean;
};
export declare function baselineManifest(): typeof _BASELINE_DETAILS & {
    version: string;
    fingerprint: string;
};
export declare function buildForecastInput(history: ResearchMatch[], target: ResearchMatch, forecastAt: string): ForecastInput;
/** All eligible matches, not only previous recommended bets; no silent 450-target cap. */
export declare function buildTrainingDataset(matches: ResearchMatch[], asOf: string): TrainingDataset;
export {};
