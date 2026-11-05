/**
 * Value Betting Engine — v3 (Ibrido Adattivo Kelly)
 * ===================================================
 *
 * FILOSOFIA v3:
 * -------------
 * Kelly Criterion è già un filtro adattivo naturale:
 * - Bet prob 20%, quota 4.50, EV +10% → stake Kelly ≈ 0.7% bankroll
 * - Bet prob 60%, quota 1.90, EV +14% → stake Kelly ≈ 4.2% → capped 4%
 * Non serve quindi un filtro arbitrario MIN_PROBABILITY o MAX_ODDS.
 * Il modello decide quanto scommettere in base all'edge reale.
 *
 * FILTRI MANTENUTI (matematicamente giustificati):
 * -------------------------------------------------
 * 1. MIN_ODDS 1.40: sotto questa quota il margine bookmaker erode qualsiasi edge.
 *    (Un'odds 1.30 con vig 6% → implied no-vig ≈ 1.23 → pochissimo spazio.)
 * 2. MAX_ODDS 8.00: oltre questa quota il modello Dixon-Coles non ha abbastanza
 *    dati storici per stimare correttamente probabilità così basse.
 * 3. Edge no-vig > 0: filtro qualità fondamentale. Confrontiamo la nostra prob
 *    con quella del bookmaker SENZA il suo margine. Se anche dopo aver tolto
 *    il vig siamo sotto, non c'è valore.
 * 4. EV MINIMO PER CATEGORIA (soglie differenziate per modello):
 *    - goal/1x2/btts:          EV > 3.0%  (modello DC maturo, affidabile)
 *    - over/under goal:        EV > 2.5%  (DC ottimo su goal totali)
 *    - tiri/shots:             EV > 4.0%  (NegBin shots, buono ma più rumore)
 *    - cartellini/gialli:      EV > 4.5%  (NegBin cards, fattore arbitro stima incerta)
 *    - falli:                  EV > 5.0%  (NegBin fouls, modello con più incertezza)
 *    - exact score/handicap:   EV > 5.0%  (alta varianza, serve margine ampio)
 * 5. MAX_STAKE 4% bankroll (Quarter Kelly già lo limita, questo è un cap assoluto).
 * 6. Coerenza: nostra prob >= 80% * implied_raw (se il mercato ci "sorpassa"
 *    di oltre il 20% probabilmente non sappiamo qualcosa che il mercato sa).
 *
 * VOLUME TARGET 150-400 BET/STAGIONE:
 * ------------------------------------
 * Le soglie EV differenziate per categoria fungono da volume control naturale.
 * Alzare una soglia → meno bet in quella categoria.
 * Il metodo getBetVolumeEstimate() restituisce una stima del volume atteso.
 *
 * CONFIDENCE → STAKE MULTIPLIER (non floor):
 * -------------------------------------------
 * HIGH:   Kelly × 1.20  (leggero boost: alta EV e alta prob)
 * MEDIUM: Kelly × 1.00  (neutro)
 * LOW:    Kelly × 0.70  (riduzione: segnale debole)
 * LOW viene ancora accettata se Kelly è positivo — solo con stake ridotto.
 */
import { PredictionEngineConfig, ComboRiskMode } from '../../config/PredictionEngineConfig';
/**
 * Rappresenta una scommessa combinata (accumulatore) di N quote singole.
 *
 * MATEMATICA:
 * - Probabilità combinata = Π(ourProbability_i) — SOLO se le quote sono su
 *   partite diverse (indipendenza statistica). Quote della stessa partita
 *   possono essere correlate: il campo warningCorrelation lo segnala.
 * - Quota combinata = Π(bookmakerOdds_i)
 * - EV combinato = P_combinata × Quota_combinata − 1
 * - Kelly combinato = (P × Q − 1) / (Q − 1) × 0.25 (Quarter Kelly)
 * - MAX_STAKE combinata: cap più basso (2.4% vs 4%) perché la varianza
 *   aumenta moltiplicativamente con il numero di gambe.
 */
export interface ComboBetOpportunity {
    /** Quote singole che compongono la combinata */
    legs: BetOpportunity[];
    /** Numero di gambe (2, 3, ...) */
    numLegs: number;
    /** Quota decimale combinata = Π(odds_i) */
    combinedOdds: number;
    /** Probabilità combinata del modello in percentuale = Π(ourProb_i/100)×100 */
    combinedProbability: number;
    /** EV combinato in percentuale */
    combinedEV: number;
    /** Quarter Kelly applicato alla combinata, in percentuale */
    kellyFraction: number;
    /** Stake suggerito in % bankroll (capped più basso delle singole) */
    suggestedStakePercent: number;
    /** Confidence: HIGH solo se tutte le gambe sono HIGH; LOW se almeno una è LOW */
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    /** True se tutte le gambe provengono da matchId diversi */
    isIndependent: boolean;
    /** Presente se due o più gambe provengono dalla stessa partita */
    warningCorrelation?: string;
    /** Effective risk mode used; covarianceMonteCarlo currently means deterministic covariance proxy. */
    comboRiskMode?: ComboRiskMode;
    /** Return variance proxy, populated only when covariance correlations are configured. */
    returnVariance?: number;
}
export interface BetOpportunity {
    marketName: string;
    selection: string;
    marketCategory: MarketCategory;
    marketTier: MarketTier;
    selectionFamily?: string;
    adaptiveRankMultiplier?: number;
    ourProbability: number;
    bookmakerOdds: number;
    impliedProbability: number;
    impliedProbabilityNoVig: number;
    expectedValue: number;
    kellyFraction: number;
    suggestedStakePercent: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    isValueBet: boolean;
    edge: number;
    edgeNoVig: number;
    modelProbability?: number;
    calibratedProbability?: number;
    blendedProbability?: number;
    marketProbabilityNoVig?: number;
    modelWeight?: number;
    marketWeight?: number;
    categoryCalibrationStatus?: 'none' | 'applied' | 'global_fallback' | 'insufficient_sample';
    calibrationSampleSize?: number;
    calibrationReliability?: number;
    mainReason?: string;
    riskReasons?: string[];
    dataQuality?: number;
    companionOddsAvailable?: boolean;
    evReason?: 'computed' | 'computed_reduced_missing_complement' | 'computed_insufficient_complement' | 'missing_odds' | 'invalid_odds' | 'synthetic_odds' | 'stale_odds' | 'unsupported_market' | 'calculation_error';
    uncertaintyFactor?: number;
    riskPenalty?: number;
    rankingScore?: number;
    logGrowth?: number;
    dynamicEvThreshold?: number;
    contextStrength?: number;
    playerId?: string;
    playerName?: string;
    teamName?: string;
    marketType?: 'player_shots' | 'player_shots_ot' | 'player_yellow_cards' | 'player_goals';
    line?: number;
    expectedMinutes?: number;
    sampleSize?: number;
    playerConfidence?: 'HIGH' | 'MEDIUM' | 'LOW';
    dataWarnings?: string[];
    rejectionCodes?: string[];
    rejectionReasons?: string[];
    slateStatus?: 'recommended' | 'skipped' | 'not_evaluated';
    slateSkipReason?: string;
    slateDiagnostics?: {
        reasonCode?: string;
        categoryCap?: number;
        categoryCount?: number;
        slateRank?: number;
        slatePosition?: number;
    };
    /** matchId della partita di riferimento — usato per rilevare correlazione nelle combinate */
    matchId?: string;
}
export type MarketCategory = 'goal_1x2' | 'btts_yes' | 'btts_no' | 'goal_over' | 'goal_under' | 'goal_ou' | 'shots' | 'shots_ot' | 'corners' | 'yellow_cards' | 'player_shots' | 'player_shots_ot' | 'player_yellow_cards' | 'player_goals' | 'fouls' | 'exact_score' | 'handicap' | 'other';
export type MarketTier = 'CORE' | 'SECONDARY' | 'SPECULATIVE';
export type SelectionFamily = string;
export interface ValueAnalysisFactors {
    homeAdvantageIndex?: number;
    formDelta?: number;
    motivationDelta?: number;
    restDelta?: number;
    scheduleLoadDelta?: number;
    suspensionsDelta?: number;
    disciplinaryDelta?: number;
    atRiskPlayersDelta?: number;
    competitiveness?: number;
    statSampleStrength?: number;
    shotsReliability?: number;
    cornersReliability?: number;
    disciplineReliability?: number;
    expectedCards?: number;
    expectedFouls?: number;
    refereeAvgYellow?: number;
    refereeAvgFouls?: number;
    refereeSampleSize?: number;
    leagueAvgYellow?: number;
    leagueAvgFouls?: number;
    disciplinaryRiskScore?: number;
    isDerby?: boolean;
    highStakes?: boolean;
}
export interface MarketCalibrationEntry {
    predictedAvg: number;
    actualHitRate: number;
    sampleSize: number;
    reliability: number;
    calibrationGap?: number;
}
export interface MarketCalibrationProfile {
    global?: MarketCalibrationEntry;
    byMarket?: Record<string, MarketCalibrationEntry>;
    byCompetition?: Record<string, {
        global?: MarketCalibrationEntry;
        byMarket?: Record<string, MarketCalibrationEntry>;
    }>;
}
export interface ValueAnalysisContext {
    richnessScore?: number;
    competition?: string;
    teamSampleSize?: {
        home?: number;
        away?: number;
    };
    hasXg?: boolean;
    hasPlayerData?: boolean;
    hasRefereeData?: boolean;
    marketVariance?: Partial<Record<MarketCategory, number>>;
    marketCalibrationProfile?: MarketCalibrationProfile;
    enableMarketCalibration?: boolean;
    enableMarketBlending?: boolean;
    /**
     * Pesi modello↔mercato appresi dallo storico (per MarketCategory).
     * Quando presenti e con campione sufficiente, correggono il peso
     * euristico entro learnedBlendMaxShift.
     */
    learnedBlendWeights?: Record<string, {
        modelWeight: number;
        sampleSize: number;
    }>;
    /**
     * Incertezza dei parametri del modello (0-1) da
     * DixonColesModel.bootstrapLambdas().uncertaintyFactor: 0 = lambda ben
     * determinati, 1 = pochi dati / parametri instabili. Alza uncertaintyFactor
     * e riduce stake/Kelly su tutte le selezioni del match.
     */
    modelUncertainty?: number;
    analysisFactors?: ValueAnalysisFactors;
    expectedGoals?: number;
    expectedCards?: number;
    expectedCardsByLine?: Record<string, number>;
    expectedFouls?: number;
    refereeAvgYellow?: number;
    refereeAvgFouls?: number;
    refereeSampleSize?: number;
    leagueAvgYellow?: number;
    leagueAvgFouls?: number;
    disciplinaryRiskScore?: number;
    isDerby?: boolean;
    highStakes?: boolean;
}
export interface AdaptiveCategoryTuning {
    evDelta: number;
    coherenceDelta: number;
    rankingMultiplier: number;
    sampleSize: number;
    rankingErrorRate: number;
    filterRejectionRate: number;
    confirmationRate: number;
    wrongPickRate: number;
}
export interface AdaptiveEngineTuningProfile {
    source: string;
    generatedAt: string;
    totalReviews: number;
    categories: Partial<Record<MarketCategory, AdaptiveCategoryTuning>>;
    selectionFamilies?: Record<string, AdaptiveCategoryTuning>;
}
export interface BudgetState {
    userId: string;
    totalBudget: number;
    availableBudget: number;
    totalBets: number;
    totalStaked: number;
    totalWon: number;
    totalLost: number;
    roi: number;
    winRate: number;
    createdAt: Date;
    updatedAt: Date;
}
export interface BetRecord {
    betId: string;
    userId: string;
    matchId: string;
    marketName: string;
    selection: string;
    odds: number;
    stake: number;
    ourProbability: number;
    expectedValue: number;
    status: 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'CASHOUT';
    returnAmount?: number;
    profit?: number;
    placedAt: Date;
    settledAt?: Date;
    notes?: string;
}
export interface MarketOddsGroup {
    selection: string;
    odds: number;
    companions: number[];
}
export interface SelectionDiagnostics {
    selection: string;
    marketName: string;
    marketCategory: MarketCategory;
    marketTier: MarketTier;
    selectionFamily: SelectionFamily;
    bookmakerOdds: number | null;
    ourProbability: number | null;
    impliedProbability: number | null;
    impliedProbabilityNoVig: number | null;
    expectedValue: number | null;
    edge: number | null;
    edgeNoVig: number | null;
    kellyFraction: number | null;
    suggestedStakePercent: number | null;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
    bookmakerMargin: number;
    minEvThreshold: number;
    filterSettings: {
        minOdds: number;
        maxOdds: number;
        coherenceRatio: number;
    };
    adaptiveRankMultiplier: number;
    passed: boolean;
    rejectionCodes: string[];
    rejectionReasons: string[];
}
type ValueBettingRuntimeConfig = Partial<PredictionEngineConfig['valueBetting']> & {
    /** Legacy name: current behavior is deterministic covariance proxy scaling, not random Monte Carlo simulation. */
    comboRiskMode?: ComboRiskMode;
    comboCorrelationMatrix?: Record<string, number>;
    rankingWeights?: RankingWeightsConfig;
};
export interface RankingWeightVector {
    edgeNoVig: number;
    edgeRaw: number;
    ev: number;
    kelly: number;
    confidence: number;
    logGrowth: number;
    riskPenalty: number;
    uncertainty: number;
    contextStrength: number;
}
export interface RankingWeightsConfig {
    global?: Partial<RankingWeightVector>;
    byCategory?: Partial<Record<MarketCategory, Partial<RankingWeightVector>>>;
    bySelectionFamily?: Record<string, Partial<RankingWeightVector>>;
    byCompetition?: Record<string, {
        global?: Partial<RankingWeightVector>;
        byCategory?: Partial<Record<MarketCategory, Partial<RankingWeightVector>>>;
        bySelectionFamily?: Record<string, Partial<RankingWeightVector>>;
    }>;
}
export interface SlateSelectionOptions {
    maxBets?: number;
    maxLowConfidence?: number;
    maxCardsBets?: number;
    maxFragileUnderBets?: number;
    minRankingScore?: number;
}
export interface SlateSelectionResult {
    recommended: BetOpportunity[];
    skipped: BetOpportunity[];
    diagnostics: {
        totalInput: number;
        selected: number;
        skippedBecauseWeakSlateRank: number;
        skippedBecauseDailyCardCap: number;
        skippedBecauseDailyUnderCap: number;
        skippedBecauseCorrelation: number;
        skippedBecauseLowConfidence: number;
    };
}
export type SingleMatchBetStatus = 'PLAYABLE' | 'PRUDENT' | 'SPECULATIVE' | 'NO_MARKET' | 'NO_BET';
export interface SingleMatchBetComparedAlternative {
    selection: string;
    marketName: string;
    marketCategory: MarketCategory;
    family: string;
    bookmakerOdds: number;
    expectedValue: number;
    edgeNoVig: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    riskAdjustedScore: number;
    reason: string;
}
export interface SingleMatchBetDecision {
    status: SingleMatchBetStatus;
    reason: string;
    riskAdjustedScore: number;
    rejectedReasons: string[];
    comparedAlternatives: SingleMatchBetComparedAlternative[];
}
export interface SingleMatchBetSelectionResult {
    bestBet: BetOpportunity | null;
    analyticalBest: BetOpportunity | null;
    alternatives: BetOpportunity[];
    decision: SingleMatchBetDecision;
}
export interface SingleMatchBetSelectionContext extends ValueAnalysisContext {
    minRiskAdjustedScore?: number;
}
export declare class ValueBettingEngine {
    private readonly runtimeConfig;
    private readonly MIN_ODDS;
    private readonly MAX_ODDS;
    private readonly KELLY_FRACTION;
    private readonly MAX_STAKE_PERCENT;
    private readonly MIN_STAKE_PERCENT;
    private readonly COHERENCE_RATIO;
    private readonly DISABLED_CATEGORIES;
    private readonly CONFIDENCE_MULTIPLIERS;
    private adaptiveTuningProfile;
    constructor(config?: ValueBettingRuntimeConfig);
    private clampNumber;
    setAdaptiveTuning(profile: AdaptiveEngineTuningProfile | null | undefined): void;
    getAdaptiveTuning(): AdaptiveEngineTuningProfile | null;
    setRankingWeights(config: RankingWeightsConfig | null | undefined): void;
    getRankingWeightsConfig(): RankingWeightsConfig;
    private normalizeCompetitionKey;
    getRankingWeightsForCategory(category: MarketCategory, scope?: {
        competition?: string | null;
        selectionFamily?: string | null;
    }): RankingWeightVector;
    private getCategoryTuning;
    private getFamilyTuning;
    private getCombinedTuning;
    private getClampedEvDelta;
    private getFilterSettings;
    getMarketTier(category: MarketCategory): MarketTier;
    getSelectionFamily(selection: string): SelectionFamily;
    categorizeSelection(selection: string): MarketCategory;
    computeExpectedValue(probability: number, decimalOdds: number): number;
    impliedProbabilityFromOdds(decimalOdds: number): number;
    /**
     * Vig removal proporzionale (Pinnacle standard).
     * P_no_vig_i = (1/odds_i) / Σ(1/odds_j)
     */
    impliedProbabilityNoVig(odds: number, allOdds: number[]): number;
    computeOverround(allOdds: number[]): number;
    private computeBookmakerMargin;
    private minEvForCategory;
    getEffectiveEvThreshold(category: MarketCategory, margin?: number, selection?: string): number;
    computeDynamicEvThreshold(category: MarketCategory, context?: {
        richnessScore?: number;
        marketVariance?: number;
        calibrationPenalty?: number;
        baseThreshold?: number;
    }): number;
    private computeContextualEvThreshold;
    private getDefaultMarketVariance;
    private inferSelectionDirection;
    private computeContextStrength;
    private computeUncertaintyFactor;
    private computeRiskPenalty;
    getMarketCalibrationKey(selection: string, category?: MarketCategory): string;
    private applyMarketCalibration;
    private computeDataQualityScore;
    /** Applies the live probability pipeline without EV/confidence filtering. */
    blendForecastProbability(selection: string, probability: number, group: MarketOddsGroup | undefined, context?: ValueAnalysisContext): number;
    private blendWithMarketProbability;
    private buildPickDiagnostics;
    private computeExpectedLogGrowth;
    private computeRankingScore;
    private getCategoryRankingMultiplier;
    private computeCategoryMargins;
    private computeCategoryMarginsFromGroups;
    kellyFraction(probability: number, decimalOdds: number, uncertaintyFactor?: number): number;
    /**
     * Frazione di Kelly effettiva (n.7).
     * - kellyMode 'quarter' (default): 0.25 fisso, comportamento storico.
     * - kellyMode 'dynamic': la frazione scala linearmente con l'incertezza
     *   del modello — dynamicKellyMaxFraction con parametri stabili (u=0),
     *   dynamicKellyMinFraction con parametri instabili (u=1, bootstrap CV alto).
     *   Senza uncertaintyFactor si resta sul quarter Kelly.
     */
    private resolveKellyFraction;
    /**
     * Bayesian Kelly adattivo con penalità per incertezza del modello.
     *
     * PROBLEMA DEL KELLY STANDARD:
     * Kelly assume che P_model sia la probabilità vera. Ma P_model è una
     * stima con incertezza: un modello allenato su 8 partite home della
     * Juventus ha un'incertezza molto più alta di uno con 35 partite.
     * Kelly su un P_model incerto tende a sovracommettere, specialmente
     * sulle high-confidence bet dove i parametri sono meno stabili.
     *
     * SOLUZIONE — Kelly con penalità varianza:
     *   stake_bayesian = stake_kelly × (1 - uncertaintyPenalty × uncertaintyFactor)
     *
     * dove:
     *   uncertaintyFactor ∈ [0,1]: output di DixonColesModel.bootstrapLambdas()
     *     0 = parametri stabili (molte partite, λ ben determinato)
     *     1 = alta incertezza (poche partite, λ molto variabile)
     *
     *   uncertaintyPenalty ∈ [0,1]: quanto l'incertezza riduce lo stake.
     *     Default 0.5 → con uncertaintyFactor=1 lo stake è dimezzato.
     *     Questo è conservativo ma giustificato: con alta incertezza
     *     il Kelly pieno è quasi certamente troppo aggressivo.
     *
     * EFFETTO PRATICO su HIGH-confidence bet:
     *   Le bet HIGH hanno EV alto → Kelly suggerisce stake alto.
     *   Ma se l'EV alto viene da parametri incerti (poche partite),
     *   uncertaintyFactor è alto → stake ridotto automaticamente.
     *   Questo risolve il problema di sovraconfidenza su HIGH.
     *
     * @param uncertaintyFactor  Da DixonColesModel.bootstrapLambdas() (default 0 = no penalità)
     * @param uncertaintyPenalty Quanto ridurre lo stake al max (default 0.5 = -50%)
     */
    computeSuggestedStakeWithUncertainty(probability: number, decimalOdds: number, ev: number, uncertaintyFactor?: number, uncertaintyPenalty?: number): {
        stakePercent: number;
        confidence: 'HIGH' | 'MEDIUM' | 'LOW';
        uncertaintyDiscount: number;
    };
    computeSuggestedStake(probability: number, decimalOdds: number, ev: number): {
        stakePercent: number;
        confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    };
    private isPlayerPropCategory;
    private getStakeCapForCategory;
    private isUnderCardsSelection;
    private isOverCardsSelection;
    private parseCardsLine;
    private isGoalUnderSelection;
    private parseGoalLine;
    private expectedCardsForLine;
    private requiredUnderCardsBuffer;
    private requiredOverCardsBuffer;
    private requiredUnderGoalsBuffer;
    private computeDisciplinaryRiskScore;
    private computeUnderCardsGuard;
    private computeOverCardsGuard;
    private emptySelectionGuard;
    private computeFragileGoalGuard;
    private combineSelectionGuards;
    private computeSelectionRiskGuard;
    private capConfidence;
    private capConfidenceForMarket;
    /**
     * Gate principale — Kelly adattivo, filtri minimi giustificati.
     *
     * NON filtra per probabilità minima assoluta: Kelly già penalizza
     * le bet su underdog assegnando stake proporzionalmente piccoli.
     * NON filtra per MAX_ODDS fisso basso: un underdog a quota 7.00 con
     * EV genuino riceve stake piccolo ma viene accettato.
     *
     * FILTRA:
     * 1. Odds fuori da [MIN_ODDS, MAX_ODDS] = [1.40, 8.00]
     * 2. EV <= soglia della categoria (differenziata per affidabilità modello)
     * 3. Edge no-vig <= 0 (il bookmaker ci batte anche senza margine)
     * 4. Incoerenza: nostra prob < 80% implied_raw (mercato sa qualcosa che non sappiamo)
     * 5. Kelly = 0 (EV negativo dal punto di vista Kelly → non scommettere mai)
     */
    private passesFilters;
    diagnoseSelection(probabilities: Record<string, number>, bookmakerOdds: Record<string, number>, selection: string, marketNames?: Record<string, string>): SelectionDiagnostics;
    analyzeMarkets(probabilities: Record<string, number>, bookmakerOdds: Record<string, number>, marketNames: Record<string, string>, context?: ValueAnalysisContext): BetOpportunity[];
    /**
     * Versione con vig removal completo: usa le quote di tutti gli outcome
     * dello stesso mercato per calcolare l'edge reale (più preciso).
     */
    analyzeMarketsWithVigRemoval(probabilities: Record<string, number>, marketGroups: Record<string, MarketOddsGroup>, marketNames: Record<string, string>, context?: ValueAnalysisContext): BetOpportunity[];
    buildSingleMatchCandidateBoard(probabilities: Record<string, number>, marketGroups: Record<string, MarketOddsGroup>, marketNames: Record<string, string>, context?: ValueAnalysisContext): BetOpportunity[];
    /**
     * Stima volume bet atteso per partita (utile per capire se si è nel
     * range target 150-400/stagione su 38 partite per squadra top di lega).
     */
    getBetVolumeEstimate(opportunities: BetOpportunity[]): {
        total: number;
        byCategory: Record<MarketCategory, number>;
    };
    /**
     * Seleziona solo HIGH confidence — usato dal BacktestingEngine
     * per simulazioni conservative.
     */
    selectHighConfidence(opportunities: BetOpportunity[]): BetOpportunity[];
    /**
     * Seleziona HIGH + MEDIUM confidence — usato per target 150-400 bet.
     */
    selectMediumAndAbove(opportunities: BetOpportunity[]): BetOpportunity[];
    private slateRank;
    private getSingleMatchFamily;
    private getSingleMatchStatus;
    private getSingleMatchFragilityPenalty;
    private getSingleMatchMissingDataPenalty;
    private getComplementRequirement;
    private deriveEvReason;
    /** Public wrapper used by the pre-filter prediction audit. */
    getPredictionEvReason(selection: string, category: MarketCategory, companionCount: number): BetOpportunity['evReason'];
    private getHighOddsPenalty;
    private computeRiskAdjustedBestScore;
    private isOperationalSingleMatchCandidate;
    private buildSingleMatchRejectedReasons;
    private canAggressiveBeatProtected;
    private chooseFamilyRepresentative;
    private buildSingleMatchComparedAlternatives;
    private buildSingleMatchReason;
    selectBestSingleMatchBet(opportunities: BetOpportunity[], context?: SingleMatchBetSelectionContext): SingleMatchBetSelectionResult;
    private isCardsOpportunity;
    private isFragileUnderOpportunity;
    private markSlateSkipped;
    selectRecommendedSlateBets(opportunities: BetOpportunity[], options?: SlateSelectionOptions): SlateSelectionResult;
    buildMarketGroups(bookmakerOdds: Record<string, number>): Record<string, MarketOddsGroup>;
    fitIsotonicCalibration(predictions: number[], outcomes: number[], options?: {
        presorted?: boolean;
    }): {
        calibrationPoints: Array<{
            x: number;
            y: number;
        }>;
    };
    calibrate(rawProb: number, calibrationPoints: Array<{
        x: number;
        y: number;
    }>, nObservations?: number): number;
    validateBudget(budget: BudgetState): boolean;
    settleBet(budget: BudgetState, bet: BetRecord, won: boolean, returnAmount?: number, allBets?: BetRecord[]): {
        updatedBudget: BudgetState;
        updatedBet: BetRecord;
    };
    placeBet(budget: BudgetState, stakeAmount: number): BudgetState;
    /**
     * Genera tutte le combinazioni di valore dalle scommesse singole passate.
     *
     * Logica di filtraggio:
     * - Combina da 2 a maxLegs scommesse.
     * - Scarta combinazioni con EV combinato inferiore a minCombinedEV.
     * - Segnala (ma non scarta) le combinazioni con quote della stessa partita
     *   (correlazione potenziale → EV potrebbe essere sovrastimato).
     * - Ordina per EV combinato decrescente.
     *
     * Uso tipico:
     *   const singles = engine.analyzeMarketsWithVigRemoval(...);
     *   const combos  = engine.buildCombinations(singles, 3, 0.08);
     *   // Considera solo le prime 5 combinate per partita
     *   const top5    = combos.slice(0, 5);
     *
     * @param opportunities  Lista di scommesse singole già filtrate con isValueBet=true.
     * @param maxLegs        Numero massimo di gambe per combinata (default 3).
     *                       Non superare 4: oltre quella soglia l'EV combinato
     *                       dipende troppo dall'accuratezza delle singole probabilità.
     * @param minCombinedEV  Soglia EV minimo in decimale (default 0.06 = 6%).
     *                       Più alta rispetto alle singole perché la varianza
     *                       aumenta con il numero di gambe.
     */
    buildCombinations(opportunities: BetOpportunity[], maxLegs?: number, minCombinedEV?: number): ComboBetOpportunity[];
    /**
     * Valuta una singola combinazione di gambe.
     * Restituisce null se non supera la soglia EV o se il Kelly è nullo.
     */
    private evaluateCombo;
    /**
     * Genera tutte le combinazioni di dimensione `size` dall'array `arr`.
     * Usa ricorsione tail-friendly con slice per evitare stack overflow su
     * array grandi (in pratica le bet singole per partita sono < 30).
     */
    private generateCombinations;
    /**
     * Deterministic covariance proxy for combo stake scaling.
     *
     * Despite the legacy config name `covarianceMonteCarlo`, this method does not
     * run random Monte Carlo simulation. It uses the configured pairwise
     * correlation matrix to derive a variance multiplier and keeps results
     * deterministic for repeatable backtests/tests.
     */
    private computeComboCovarianceRisk;
    devig1X2(oddsHome: number, oddsDraw: number, oddsAway: number): {
        home: number;
        draw: number;
        away: number;
        overround: number;
    };
    devigOverUnder(oddsOver: number, oddsUnder: number): {
        over: number;
        under: number;
        overround: number;
    };
}
export {};
