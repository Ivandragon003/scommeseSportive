/**
 * MarketBlendLearningService — apprendimento del peso modello↔mercato.
 *
 * Il blending in ValueBettingEngine usa un peso euristico
 * (0.50 + dataQuality*0.35 ± aggiustamenti di categoria). Qui apprendiamo
 * il peso ottimale per categoria dai dati storici: per ogni coppia
 * (probabilità modello, probabilità mercato de-vig, esito) cerchiamo via
 * grid search il peso w che minimizza la log-loss della probabilità
 * blended w*p_model + (1-w)*p_market.
 *
 * Il peso appreso NON sostituisce l'euristica: la corregge entro un
 * raggio massimo (learnedBlendMaxShift) e solo con campione sufficiente
 * (learnedBlendMinSamples). Con pochi dati si resta sull'euristica.
 */
export interface BlendLearningSample {
    /** MarketCategory della selezione (es. goal_1x2, goal_over, btts_yes). */
    category: string;
    /** Probabilità del modello (già calibrata, 0-1 esclusi). */
    modelProb: number;
    /** Probabilità di mercato senza vig (0-1 esclusi). */
    marketProbNoVig: number;
    /** Esito reale della selezione: 1 vinta, 0 persa. */
    outcome: 0 | 1;
}
export interface LearnedBlendWeight {
    /** Peso del modello che minimizza la log-loss sul campione. */
    modelWeight: number;
    sampleSize: number;
    /** Log-loss media con solo modello (w=1). */
    logLossModelOnly: number;
    /** Log-loss media con il peso appreso. */
    logLossLearned: number;
}
export interface LearnBlendWeightsOptions {
    minSamples?: number;
    /** Estremi della griglia di ricerca; default allineati ai clamp dell'engine (0.40-0.84). */
    weightMin?: number;
    weightMax?: number;
    weightStep?: number;
}
export declare function learnBlendWeights(samples: BlendLearningSample[], options?: LearnBlendWeightsOptions): Record<string, LearnedBlendWeight>;
/**
 * Probabilità no-vig di una selezione a partire dalle quote della selezione
 * e delle companion dello stesso mercato (2-way o 3-way).
 * Restituisce null se non ci sono abbastanza quote per rimuovere il vig.
 */
export declare function noVigProbability(odds: number, companionOdds: number[]): number | null;
