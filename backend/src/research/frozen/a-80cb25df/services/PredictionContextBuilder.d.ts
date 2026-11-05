import { SupplementaryData } from '../models/core/DixonColesModel';
/**
 * PredictionContextBuilder — v2
 * ==============================
 *
 * MODIFICHE RISPETTO A v1:
 *
 * 1. FIX ASIMMETRIA MOLTIPLICATORI GOAL/SHOT:
 *    I vecchi homeGoalMultiplier = 1 + goalBias / awayGoalMultiplier = 1 − goalBias
 *    erano puramente simmetrici: se entrambe le squadre erano in ottima forma
 *    il delta si annullava e i moltiplicatori rimanevano a 1.00 per entrambe,
 *    perdendo informazione sull'intensità assoluta di gioco attesa.
 *    Ora: base_home/away riflette la forma assoluta di ciascuna squadra
 *    (±4% max), e il bias differenziale viene aggiunto sopra.
 *
 * 2. FIX RICHNESSCORE BASELINE (0.45 → 0.30):
 *    La vecchia baseline 0.45 comunicava una confidenza del modello del 45%
 *    anche in assenza di qualsiasi dato supplementare. Ora parte da 0.30
 *    (incertezza genuina) e sale fino a 0.93 solo con dati ricchi.
 *
 * 3. VANTAGGIO CASA RIDOTTO:
 *    L'analisi empirica del calcio moderno (2018-2024) mostra un calo
 *    significativo del vantaggio casa in tutti i top 5 campionati europei:
 *    - Serie A: win rate home sceso da ~46% (2010) a ~40% (2024)
 *    - Premier League: da ~47% a ~41%
 *    I moltiplicatori homePossessionShift e i clamp dei moltiplicatori goal
 *    riflettono questo contesto: il vantaggio casa è reale ma più piccolo.
 *    Il parametro homeAdvantage del DixonColesModel è già impostato a 0.10
 *    (exp(0.10) ≈ +10.5% goal rate casa) anziché il vecchio 0.25 (+28%).
 *    Questo file NON sovrascrive quel parametro, ma i contextAdjustments
 *    devono essere coerenti: il clamp homeGoalMultiplier ora parte da 0.74
 *    (era 0.72) per evitare stime eccessivamente punitive sull'home.
 */
export interface ContextualPredictionInput {
    competitiveness?: number;
    isDerby?: boolean;
    isHighStakes?: boolean;
    homeFormIndex?: number;
    awayFormIndex?: number;
    homeObjectiveIndex?: number;
    awayObjectiveIndex?: number;
    homeRestDays?: number;
    awayRestDays?: number;
    homeRecentMatchesCount?: number;
    awayRecentMatchesCount?: number;
    homeSuspensions?: number;
    awaySuspensions?: number;
    homeRecentRedCards?: number;
    awayRecentRedCards?: number;
    homeDiffidati?: number;
    awayDiffidati?: number;
    homeKeyAbsences?: number;
    awayKeyAbsences?: number;
    /**
     * homeRosterDepth / awayRosterDepth: dimensione effettiva della rosa
     * disponibile (esclusi infortunati a lungo termine già non convocabili).
     * Default: 22 (rosa tipo Serie A).
     *
     * MOTIVAZIONE: perdere 2 titolari su una rosa di 16 è catastrofico;
     * perderne 2 su 26 è gestibile. Il vecchio absenceLoad usava un
     * divisore fisso (/ 6) che ignorava questa differenza strutturale.
     * Con rosterDepth il peso delle assenze scala correttamente:
     *   absenceImpact = absenceCount / (rosterDepth × absenceImpactRate)
     */
    homeRosterDepth?: number;
    awayRosterDepth?: number;
}
export interface PredictionContextBuildParams {
    request: ContextualPredictionInput;
    homeTeam: any;
    awayTeam: any;
    referee: any;
    homePlayers: any[];
    awayPlayers: any[];
    homeHistoricalCoverage?: TeamHistoricalCoverage | null;
    awayHistoricalCoverage?: TeamHistoricalCoverage | null;
}
export interface TeamHistoricalCoverage {
    teamId?: string;
    seasonsExpected: number;
    seasonsAvailable: number;
    coveragePercent: number;
    seasons?: string[];
    transitionHistory?: any[];
    activeTransition?: any | null;
    promotedTeamPrior?: any | null;
    effectiveCoveragePercent?: number | null;
}
export interface PredictionContextBuildResult {
    supplementaryData: SupplementaryData;
    competitiveness: number;
    homeXG?: number;
    awayXG?: number;
    richnessScore: number;
    historicalCoverage: {
        home: TeamHistoricalCoverage | null;
        away: TeamHistoricalCoverage | null;
        matchCoveragePercent: number | null;
        rawMatchCoveragePercent?: number | null;
    };
}
export declare class PredictionContextBuilder {
    private toFiniteNumber;
    private normalizeFormIndex;
    private parseJson;
    private toPlayerData;
    private readVenueStats;
    private buildTeamStats;
    private buildContextAdjustments;
    build(params: PredictionContextBuildParams): PredictionContextBuildResult;
}
