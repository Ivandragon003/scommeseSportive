/**
 * Chronological walk-forward validation of the current prematch pipeline.
 * Results become available two hours after kickoff. Model fit, context and
 * calibration cannot read target outcomes. Probability scores cover every
 * common fixed forecast; financial metrics require verifiable real prices.
 */
import { MatchData, SupplementaryData } from '../core/DixonColesModel';
import { ComboBetOpportunity, MarketCategory, AdaptiveEngineTuningProfile, RankingWeightsConfig } from '../value/ValueBettingEngine';
import { MetricWeightMode } from '../../config/PredictionEngineConfig';
export interface BacktestResult {
    algorithmVersion: string;
    rankingVersion: string;
    backtestEngineVersion: string;
    totalMatches: number;
    trainingMatches: number;
    testMatches: number;
    betsPlaced: number;
    voidedBets: number;
    unevaluableRate: number;
    betsWon: number;
    totalStaked: number;
    totalReturn: number;
    netProfit: number;
    roi: number;
    roiRealEurobetOdds: number | null;
    roiSyntheticOdds: number | null;
    roiTotal: number;
    betsWithRealEurobetOdds: number;
    betsWithSyntheticOdds: number;
    profitRealEurobetOdds: number;
    profitSyntheticOdds: number;
    stakedRealEurobetOdds: number;
    stakedSyntheticOdds: number;
    oddsReliabilityWarning?: string | null;
    winRate: number;
    averageOdds: number;
    averageEV: number;
    brierScore: number;
    logLoss: number;
    probabilityMetrics?: BacktestProbabilityMetrics;
    probabilityObservations?: BacktestProbabilityObservation[];
    weightedBrierScore?: number;
    weightedLogLoss?: number;
    calibration: CalibrationBucket[];
    equityCurve: EquityPoint[];
    monthlyStats: MonthlyStats[];
    sharpeRatio: number;
    maxDrawdown: number;
    recoveryFactor: number;
    profitFactor: number;
    marketBreakdown: Record<string, MarketStats>;
    detailedBets: BacktestBetDetail[];
    marketUnevaluableBreakdown: Record<string, {
        attempted: number;
        voided: number;
        unevaluableRate: number;
    }>;
    /**
     * edgeNoVig: edge medio del modello calcolato rimuovendo il vig dalle quote
     * usate nel backtest. È il proxy più vicino al Closing Line Value (CLV).
     * Formula: edgeNoVig_i = ourProb_i - (1 / odds_i)
     * Un valore > 0 in media indica che il modello batte il mercato ante-vig.
     * NOTA: con quote sintetiche questo valore è ottimisticamente distorto;
     * ha significato reale solo con quote storiche di chiusura (Pinnacle/Betfair).
     */
    edgeNoVig: number;
    /**
     * edgeDecayByMonth: edgeNoVig medio per mese, in ordine cronologico.
     * Permette di rilevare erosione dell'alpha nel tempo (edge decay).
     * Se i valori scendono sistematicamente → il modello perde valore.
     */
    edgeDecayByMonth: Array<{
        year: number;
        month: number;
        edgeNoVig: number;
        bets: number;
    }>;
    /**
     * rollingSharpePeriods: Sharpe ratio calcolato su finestre fisse di N bet.
     * Utile per rilevare se il Sharpe globale è trainato da un sottoperiodo.
     */
    rollingSharpePeriods: Array<{
        periodStart: number;
        periodEnd: number;
        sharpe: number;
    }>;
    /**
     * usedSyntheticOddsOnly: true se non è stata passata nessuna quota reale.
     * In questo caso edgeNoVig e Sharpe hanno valore puramente indicativo.
     */
    usedSyntheticOddsOnly: boolean;
    marketCalibration?: Record<string, CalibrationBucket[]>;
    marketReports?: Record<string, MarketLevelReport>;
    calibrationDiagnostics?: CalibrationDiagnostics;
    blendedVsRawComparison?: BlendedVsRawComparison;
    categoryOverfittingRisk?: Record<string, OverfittingRisk>;
    averageClv: number | null;
    positiveClvRate: number | null;
    missingClosingOddsCount: number;
    clvByMarket: Record<string, {
        bets: number;
        averageClv: number;
        positiveClvRate: number;
    }>;
    clvByCompetition: Record<string, {
        bets: number;
        averageClv: number;
        positiveClvRate: number;
    }>;
    roiYellowCardsOver: number | null;
    roiYellowCardsUnder: number | null;
    clvYellowCardsOver: number | null;
    clvYellowCardsUnder: number | null;
    averageLineErrorYellowCardsUnder: number | null;
    missSeverityBreakdown: Record<CardMissSeverity, number>;
    underCardsCloseToLineCount: number;
    underCardsFragilePickedCount: number;
    algorithmMode?: BacktestAlgorithmMode;
    algorithmComparison?: BacktestAlgorithmComparison | null;
    rankingWeightsUsed?: RankingWeightsConfig;
    rankingOptimization?: RankingWeightSearchResult | null;
    overfittingRisk?: OverfittingRisk;
    overfittingWarnings?: string[];
    singleBestAlways?: SingleBestAlwaysMetrics;
}
export type BacktestAlgorithmMode = 'current' | 'baseline';
export interface BacktestRunOptions {
    compareBaseline?: boolean;
    algorithmMode?: BacktestAlgorithmMode;
    /**
     * I1 (2026-07): se true (default), il backtest costruisce i dati
     * supplementari (medie squadra/arbitro) as-of-date dal solo passato e li
     * passa al modello, replicando la pipeline di produzione. Se false, il
     * modello gira sui default (comportamento legacy pre-I1) — utile per A/B.
     */
    asOfSupplementaryData?: boolean;
    /** Prior out-of-sample forecasts only; availability is checked again at the fold cutoff. */
    calibrationObservations?: BacktestProbabilityObservation[];
    /** Explicit offline diagnostic export; omitted from persisted results by default. */
    includeProbabilityObservations?: boolean;
}
export interface BacktestProbabilityObservation {
    matchId: string;
    date: Date;
    competition?: string;
    season?: string;
    selection: string;
    probability: number;
    outcome: 0 | 1;
    stage: 'raw' | 'calibrated' | 'blended';
    odds?: number;
    companionOdds?: number[];
}
export interface BacktestProbabilityMetrics {
    scope: 'all_common_forecasts';
    primaryFamily: 'goals';
    nMatches: number;
    nObservations: number;
    brierScore: number;
    logLoss: number;
    byFamily: Record<string, {
        nMatches: number;
        nObservations: number;
        brierScore: number;
        logLoss: number;
    }>;
}
export interface BacktestComparisonMetrics {
    algorithmMode: BacktestAlgorithmMode;
    roi: number;
    netProfit: number;
    totalStaked: number;
    betsPlaced: number;
    winRate: number;
    averageOdds: number;
    averageEV: number;
    averageClv: number | null;
    positiveClvRate: number | null;
    maxDrawdown: number;
    profitFactor: number;
}
export interface BacktestAlgorithmComparison {
    baselineResult: BacktestComparisonMetrics;
    currentResult: BacktestComparisonMetrics;
    tunedResult?: BacktestComparisonMetrics;
    deltaROI: number;
    deltaProfit: number;
    deltaCLV: number | null;
    deltaDrawdown: number;
}
export interface SingleBestAlwaysMetrics {
    roi: number;
    winRate: number;
    totalBets: number;
    totalStaked: number;
    netProfit: number;
    maxDrawdown: number;
    roiByCategory: Record<string, number>;
    roiByStatus: Record<string, number>;
    totalByStatus: Record<string, number>;
    speculativePicks: number;
    roiSpeculative: number | null;
    roiPlayable: number | null;
    roiPrudent: number | null;
    comparisonWithPrudentSelector: {
        prudentSelectorBets: number;
        singleBestAlwaysBets: number;
        deltaBets: number;
        deltaRoi: number;
    };
}
export interface MarketStats {
    bets: number;
    voided: number;
    won: number;
    staked: number;
    returned: number;
    roi: number;
    winRate: number;
    avgOdds: number;
    avgEV: number;
    unevaluableRate: number;
}
export interface MarketLevelReport {
    roi: number;
    winRate: number;
    brierScore: number;
    logLoss: number;
    weightedBrierScore: number;
    weightedLogLoss: number;
    sharpe: number;
    maxDrawdown: number;
    recoveryFactor: number;
    profitFactor: number;
    edgeNoVig: number;
    edgeDecayByMonth: Array<{
        year: number;
        month: number;
        edgeNoVig: number;
        bets: number;
    }>;
    rollingSharpePeriods: Array<{
        periodStart: number;
        periodEnd: number;
        sharpe: number;
    }>;
    usedSyntheticOddsOnly: boolean;
}
export interface CalibrationDiagnostics {
    global: {
        sampleSize: number;
        averageCalibrationGap: number;
        reliability: number;
    };
    byMarket: Record<string, {
        sampleSize: number;
        averageCalibrationGap: number;
        reliability: number;
    }>;
}
export interface BlendedVsRawComparison {
    betsWithBlendedProbability: number;
    averageModelProbability: number | null;
    averageBlendedProbability: number | null;
    averageProbabilityShift: number;
}
interface MarketReportBet {
    ourProb: number;
    won: boolean;
    marketCategory?: MarketCategory | string;
    stake?: number;
    odds?: number;
    profit?: number;
    edgeNoVig?: number;
    matchDate?: Date;
    isSynthetic?: boolean;
}
export interface CalibrationBucket {
    predictedRange: string;
    predictedAvg: number;
    actualFrequency: number;
    count: number;
}
export interface EquityPoint {
    date: Date;
    matchNumber: number;
    bankroll: number;
    profit: number;
    cumulativeROI: number;
}
export interface MonthlyStats {
    year: number;
    month: number;
    bets: number;
    staked: number;
    returned: number;
    profit: number;
    roi: number;
}
export interface WalkForwardFoldSummary {
    algorithmVersion: string;
    rankingVersion: string;
    backtestEngineVersion: string;
    foldNumber: number;
    trainMatches: number;
    testMatches: number;
    betsPlaced: number;
    betsWon: number;
    totalStaked: number;
    roi: number;
    winRate: number;
    netProfit: number;
    brierScore: number;
    logLoss: number;
    probabilityMetrics?: BacktestProbabilityMetrics;
    averageClv: number | null;
    positiveClvRate: number | null;
    maxDrawdown: number;
    betsWithRealEurobetOdds: number;
    betsWithSyntheticOdds: number;
    baselineRoi?: number;
    currentRoi?: number;
    tunedRoi?: number;
    foldWinner?: 'baseline' | 'current' | 'tuned' | 'none';
    singleBestAlways?: SingleBestAlwaysMetrics;
    startDate: Date;
    endDate: Date;
}
export interface WalkForwardBacktestResult {
    algorithmVersion: string;
    rankingVersion: string;
    backtestEngineVersion: string;
    totalMatches: number;
    totalFolds: number;
    expandingWindow: boolean;
    initialTrainMatches: number;
    testWindowMatches: number;
    stepMatches: number;
    folds: WalkForwardFoldSummary[];
    summary: {
        totalBetsPlaced: number;
        totalBetsWon: number;
        totalNetProfit: number;
        totalStaked: number;
        roi: number;
        winRate: number;
        averageFoldROI: number;
        medianFoldROI: number;
        roiStdDev: number;
        roiVariance: number;
        clvVariance: number;
        currentBeatsBaselineFolds: number;
        baselineBeatsCurrentFolds: number;
        tunedBeatsCurrentFolds: number;
        rankingStabilityScore: number;
        positiveFoldRate: number;
        averageBrierScore: number;
        averageLogLoss: number;
    };
    detailedBets: BacktestBetDetail[];
    probabilityMetrics?: BacktestProbabilityMetrics;
    probabilityObservations?: BacktestProbabilityObservation[];
    calibrationDiagnostics?: CalibrationDiagnostics;
    blendedVsRawComparison?: BlendedVsRawComparison;
    categoryOverfittingRisk?: Record<string, OverfittingRisk>;
    rankingOptimization?: RankingWeightSearchResult | null;
}
export type OverfittingRisk = 'LOW' | 'MEDIUM' | 'HIGH';
export interface RankingWeightSearchCandidateResult {
    name: string;
    weights: RankingWeightsConfig;
    score: number;
    roiRealEurobetOdds: number | null;
    averageClv: number | null;
    positiveClvRate: number | null;
    maxDrawdown: number;
    profitFactor: number;
    betsPlaced: number;
    betsWithRealEurobetOdds: number;
    betsWithSyntheticOdds: number;
    overfittingRisk: OverfittingRisk;
    overfittingWarnings: string[];
}
export interface RankingWeightSearchResult {
    bestWeights: RankingWeightsConfig;
    testedWeights: RankingWeightSearchCandidateResult[];
    bestScore: number;
    comparison: {
        baselineResult: BacktestComparisonMetrics;
        currentResult: BacktestComparisonMetrics;
        tunedResult: BacktestComparisonMetrics;
        deltaROI: number;
        deltaProfit: number;
        deltaCLV: number | null;
        deltaDrawdown: number;
    };
    overfittingRisk: OverfittingRisk;
    overfittingWarnings: string[];
    warning?: string | null;
}
export interface RankingWeightSearchOptions {
    minBetsPerFold?: number;
    minRealEurobetBets?: number;
    maxAllowedDrawdown?: number;
    minimumPositiveClvRate?: number;
    maxFolds?: number;
    confidenceLevel?: 'high_only' | 'medium_and_above';
    candidateWeights?: Array<{
        name: string;
        weights: RankingWeightsConfig;
    }>;
}
export type BacktestOddsSource = 'odds_api' | 'eurobet_scraper' | 'fallback' | 'synthetic' | 'unknown';
export interface HistoricalOddsContextEntry {
    odds: Record<string, number>;
    oddsSource: BacktestOddsSource;
    snapshotSource?: string | null;
    selectedBookmakerKey?: string | null;
    selectedBookmakerName?: string | null;
    capturedAt?: string | null;
    closingOdds?: Record<string, number>;
    closingCapturedAt?: string | null;
    closingSource?: string | null;
    closingBookmakerKey?: string | null;
    closingBookmakerName?: string | null;
    usedFallbackBookmaker?: boolean;
    usedSyntheticOdds?: boolean;
    closingRejectedReason?: ClvMissingReason | null;
}
export type ClvMissingReason = 'missing_closing_odds' | 'non_eurobet_snapshot' | 'snapshot_after_kickoff_rejected';
export type CardMissSeverity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
export type OutcomeVsMarketAssessment = 'good_process_bad_result' | 'bad_process_good_result' | 'good_process_good_result' | 'bad_process_bad_result' | 'unknown_clv';
export interface BacktestBetDetail {
    matchId: string;
    matchDate: string;
    competition?: string | null;
    season?: string | null;
    marketName: string;
    marketCategory: MarketCategory;
    selection: string;
    odds: number;
    impliedProbability: number;
    ourProbability: number;
    expectedValue: number;
    edge: number;
    edgeNoVig: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    stake: number;
    profit: number;
    outcome: 'WON' | 'LOST';
    won: boolean;
    isSynthetic: boolean;
    oddsSource: BacktestOddsSource;
    snapshotSource?: string | null;
    oddsCapturedAt?: string | null;
    closingOdds?: number | null;
    closingOddsCapturedAt?: string | null;
    closingSource?: string | null;
    clv?: number | null;
    clvMissingReason?: ClvMissingReason | null;
    /** Additive semantic flag; `isRealEurobetOdds` remains for compatibility. */
    isRealBookmakerOdds?: boolean;
    isRealEurobetOdds?: boolean;
    uncertaintyFactor?: number;
    riskPenalty?: number;
    rankingScore?: number;
    logGrowth?: number;
    dynamicEvThreshold?: number;
    algorithmMode?: BacktestAlgorithmMode;
    algorithmVersion?: string;
    rankingVersion?: string;
    backtestEngineVersion?: string;
    contextCompletenessScore?: number;
    historicalContextUsed?: boolean;
    contextWarnings?: string[];
    cardLineError?: number | null;
    cardMissSeverity?: CardMissSeverity | null;
    cardLearningAdjustment?: number | null;
    outcomeVsMarketAssessment?: OutcomeVsMarketAssessment | null;
    underCardsCloseToLine?: boolean;
    modelProbability?: number | null;
    calibratedProbability?: number | null;
    blendedProbability?: number | null;
    marketProbabilityNoVig?: number | null;
    modelWeight?: number | null;
    marketWeight?: number | null;
    categoryCalibrationStatus?: string | null;
    dataQuality?: number | null;
    companionOddsAvailable?: boolean | null;
}
export declare class BacktestingEngine {
    private model;
    private engine;
    private readonly INITIAL_BANKROLL;
    private readonly SYNTHETIC_MARGIN;
    private readonly SYNTHETIC_JITTER;
    private readonly SYN_MIN_ODDS;
    private readonly SYN_MAX_ODDS;
    constructor();
    private clampNumber;
    assessCardLineLearning(input: {
        selection: string;
        actualCards: number | null | undefined;
        clv?: number | null;
        wasRecommendedTooCloseToLine?: boolean;
    }): {
        cardLineError: number | null;
        cardMissSeverity: CardMissSeverity | null;
        cardLearningAdjustment: number | null;
        outcomeVsMarketAssessment: OutcomeVsMarketAssessment | null;
    };
    private assessOutcomeVsMarket;
    private parseCardsSelection;
    computeWeightedProbabilityMetrics(bets: Array<{
        ourProb: number;
        won: boolean;
        stake?: number;
        odds?: number;
        marketCategory?: MarketCategory | string;
        marketVariance?: number;
    }>, weightMode?: MetricWeightMode): {
        weightedBrierScore: number;
        weightedLogLoss: number;
        weightMode: MetricWeightMode;
    };
    computeCalibrationByMarket(bets: Array<{
        ourProb: number;
        won: boolean;
        marketCategory?: MarketCategory | string;
    }>, options?: {
        desiredBuckets?: number;
        minBucketSize?: number;
    }): {
        global: CalibrationBucket[];
        byMarket: Record<string, CalibrationBucket[]>;
        blending: Record<string, {
            alpha: number;
            sampleSize: number;
            fallbackGlobal: boolean;
        }>;
    };
    calibrateProbabilityWithBlending(rawProb: number, buckets: CalibrationBucket[], nObservations: number): number;
    computeMarketLevelReports(bets: MarketReportBet[], weightMode?: MetricWeightMode): Record<string, MarketLevelReport>;
    private reportStake;
    private reportStakeFloor;
    private reportProfit;
    private calibrationAlpha;
    private computeCalibrationBuckets;
    private computeEdgeDecayForRows;
    private computeRollingSharpeForRows;
    setAdaptiveTuning(profile: AdaptiveEngineTuningProfile | null | undefined): void;
    private buildTeamSampleSizes;
    private buildBacktestValueAnalysisContext;
    /** Curves are fitted exclusively on forecasts made before their outcomes existed. */
    private buildOutOfSampleCalibrationProfile;
    private probabilityMetrics;
    private isRealBookmakerOddsContext;
    private isTrustedClosingContext;
    private resolveClosingOdds;
    private baselineScore;
    private selectOpportunities;
    private readonly ASOF_DECAY_PER_DAY;
    private readonly ASOF_LEAGUE_SHOTS_CONCEDED;
    private asOfWeight;
    /**
     * Aggregati per venue di UNA squadra sui soli match con date < asOfMs.
     * Medie decadute (come produzione), varianza NON decaduta (E[X²]-E[X]²,
     * come le colonne var_* di recomputeTeamAverages), sampleSize per venue.
     */
    private computeAsOfTeamRecord;
    /** Medie arbitro (semplici, non decadute) sui match passati con lo stesso arbitro. */
    private computeAsOfRefereeRecord;
    /**
     * Costruisce `supp` as-of-date per una partita. `history` è l'insieme di
     * match da cui aggregare; il filtro strettamente-precedente e la guardia
     * anti-leakage garantiscono che nessun dato della partita o futuro entri.
     */
    buildAsOfSupp(match: MatchData, history: MatchData[]): SupplementaryData | undefined;
    private isFiniteObserved;
    private isCompletedMatch;
    private availableHistory;
    /** Same as-of inputs are shared by the backtest and historical runtime calibration. */
    buildAsOfPredictionContext(match: MatchData, history: MatchData[]): {
        supplementaryData?: SupplementaryData;
        homeXG?: number;
        awayXG?: number;
    };
    private simulateBacktestScenario;
    runWalkForwardBacktest(matches: MatchData[], historicalOdds: Record<string, Record<string, number>>, options?: {
        initialTrainMatches?: number;
        testWindowMatches?: number;
        stepMatches?: number;
        confidenceLevel?: 'high_only' | 'medium_and_above';
        expandingWindow?: boolean;
        maxFolds?: number;
        compareBaseline?: boolean;
        asOfSupplementaryData?: boolean;
        /** Opt in only when the caller needs the full raw/calibrated/blended forecast rows. */
        includeProbabilityObservations?: boolean;
    }, historicalOddsContext?: Record<string, HistoricalOddsContextEntry>): WalkForwardBacktestResult;
    private buildDetailedBetCalibrationDiagnostics;
    private buildDetailedBetBlendedComparison;
    private buildDetailedBetCategoryOverfittingRisk;
    private defaultRankingWeightCandidates;
    private assessOverfittingRisk;
    private scoreRankingCandidate;
    runRankingWeightSearch(matches: MatchData[], historicalOdds: Record<string, Record<string, number>>, options?: RankingWeightSearchOptions, historicalOddsContext?: Record<string, HistoricalOddsContextEntry>): RankingWeightSearchResult;
    private deterministicNoise;
    /**
     * Genera quote sintetiche per tutti i mercati con probabilità plausibile.
     * Applica margine 5% + jitter deterministico ±6%.
     * Genera solo se la quota fair è nel range [SYN_MIN_ODDS, SYN_MAX_ODDS].
     */
    private generateSyntheticOdds;
    private buildMarketNames;
    /** "shotsOver155" → "15.5" */
    private lineFromKey;
    private parseStatLine;
    private evaluateBet;
    private evaluateBetNullable;
    private getActualCards;
    evaluateComboBetOpportunity(combo: ComboBetOpportunity, matchResults: Record<string, MatchData>): {
        won: boolean;
        allLegsEvaluable: boolean;
        legsResults: Array<{
            selection: string;
            won: boolean | null;
        }>;
    };
    private buildSingleBestAlwaysMetrics;
    private computeMetrics;
    /**
     * Calibrazione con isotonic regression e bucket adattivi.
     *
     * PROBLEMI DEI BUCKET FISSI (vecchia implementazione):
     * - Bucket [0.6-0.7] può avere 300 bet, [0.8-1.0] solo 8.
     *   Le frequenze osservate su 8 campioni sono statisticamente inutili.
     * - Non c'è garanzia di monotonia: un modello ben calibrato dovrebbe
     *   avere actualFrequency crescente con predictedAvg. I bucket fissi
     *   non lo impongono e producono inversioni spurie da rumore campionario.
     *
     * SOLUZIONE — due passi:
     *
     * PASSO 1: Bucket adattivi a densità uniforme.
     *   Le bet vengono ordinate per ourProb e divise in N_BUCKETS gruppi
     *   di dimensione uguale (~MIN_BUCKET_SIZE bet ciascuno). Questo
     *   garantisce che ogni bucket abbia abbastanza campioni per una
     *   stima stabile della frequenza osservata.
     *   Se le bet sono poche (< 2×MIN_BUCKET_SIZE) si usa un unico bucket.
     *
     * PASSO 2: Isotonic regression (Pool Adjacent Violators — PAV).
     *   Imposta la monotonia: se bucket[i].actualFreq > bucket[i+1].actualFreq
     *   (inversione), i due bucket vengono fusi e la loro frequenza viene
     *   rimpiazzata dalla media ponderata per count.
     *   Il PAV garantisce che la sequenza finale sia non-decrescente.
     *   Questo è il metodo standard per la calibrazione in ML
     *   (Platt scaling, temperature scaling usano isotonica come base).
     *
     * OUTPUT: array di CalibrationBucket con predictedRange nel formato
     *   "[min%-max%]" basato sui quantili effettivi dei dati, non su
     *   intervalli fissi — più informativo per capire dove il modello
     *   è davvero esposto.
     */
    private computeCalibration;
    private computeMonthlyStats;
}
export {};
