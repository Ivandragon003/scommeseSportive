/**
 * PoissonXgModel — modello goal indipendente guidato dai RATE xG.
 *
 * È volutamente SEPARATO da DixonColesModel (single responsibility): il DC
 * resta responsabile solo del proprio modello. Questo è il "secondo parere"
 * dell'ensemble (vedi ProbabilityEnsembleService).
 *
 * Differenze dal DC che lo rendono un partner utile nell'ensemble:
 *   - usa le MEDIE xG fatte/subite per squadra (segnale stabile), non l'xG
 *     rumoroso del singolo match come fa il blend del DC;
 *   - Poisson INDIPENDENTE (nessuna correzione τ/ρ): distribuzione più semplice
 *     e senza il bias di livello strutturale del DC (già level-matched ai goal
 *     reali del training via levelScale).
 *
 * Fit (metodo dei momenti, nessuna ottimizzazione iterativa):
 *   leagueXG    = media xG per squadra/partita sul training
 *   attackRate[t] = (media xG fatti da t) / leagueXG,  shrinkata verso 1
 *   defRate[t]    = (media xG subiti da t) / leagueXG,  shrinkata verso 1
 *   homeAdv     = fattore casa da (xG medio casa)/(xG medio complessivo)
 *   levelScale  = (media goal reali totali) / (2*leagueXG)  → allinea il livello
 *
 * Predict:
 *   λH = leagueXG * attackRate[H] * defRate[A] * homeAdv * levelScale
 *   λA = leagueXG * attackRate[A] * defRate[H] * levelScale
 *   Poisson indipendente → probabilità dei mercati goal.
 *
 * Backtest OOS 2026-07: ensemble DC + questo modello (w≈0.5) → −0.63% logLoss,
 * ECE 0.0058→0.0019 sui mercati goal.
 */
export interface PoissonXgFitMatch {
    homeTeamId: string;
    awayTeamId: string;
    homeGoals?: number;
    awayGoals?: number;
    homeXG?: number;
    awayXG?: number;
}
export interface PoissonXgParams {
    leagueXG: number;
    homeAdv: number;
    levelScale: number;
    attackRate: Record<string, number>;
    defRate: Record<string, number>;
}
export interface PoissonXgFitOptions {
    /** Partite equivalenti di prior nello shrinkage dei rate verso 1 (media lega). Default 8. */
    shrinkage?: number;
    maxGoals?: number;
}
/** Chiavi dei mercati goal prodotte da computeGoalProbabilities. */
export declare const POISSON_XG_GOAL_KEYS: readonly ["homeWin", "draw", "awayWin", "btts", "bttsNo", "over05", "under05", "over15", "under15", "over25", "under25", "over35", "under35", "over45", "under45"];
export declare class PoissonXgModel {
    private params;
    private readonly maxGoals;
    constructor(params?: PoissonXgParams, maxGoals?: number);
    getParams(): PoissonXgParams | null;
    setParams(params: PoissonXgParams | null): void;
    hasParams(): boolean;
    /** Stima i parametri dal training (solo partite con goal e xG validi). */
    fit(matches: PoissonXgFitMatch[], options?: PoissonXgFitOptions): PoissonXgParams;
    /** λ attese (casa, trasferta) per una partita. Null se non fittato. */
    expectedGoals(homeId: string, awayId: string): {
        lambdaHome: number;
        lambdaAway: number;
    } | null;
    /** Probabilità dei mercati goal (POISSON_XG_GOAL_KEYS). Null se non fittato. */
    computeGoalProbabilities(homeId: string, awayId: string): Record<string, number> | null;
    private goalProbabilitiesFromLambdas;
}
