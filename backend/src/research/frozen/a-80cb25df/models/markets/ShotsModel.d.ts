import { PlayerShotsDistribution } from '../../config/PredictionEngineConfig';
/**
 * ShotsModel — Modello Tiri a Livello Giocatore
 *
 * NOTA: la predizione tiri a livello squadra vive in SpecializedModels
 * (computeShotsDistribution), che è il percorso usato dal runtime.
 * Questo modulo copre il livello giocatore (v4), non ancora collegato
 * al flusso di predizione principale.
 *
 * LIVELLO GIOCATORE (Zero-Inflated Poisson — ZIP):
 * I tiri di un singolo giocatore in una partita hanno una struttura
 * molto diversa dai tiri squadra:
 *   - Il 60-70% dei giocatori fa 0 tiri in una partita
 *   - Chi tira fa in media 1.5-3 tiri
 *   - C'è un "excess zero" rispetto alla Poisson ordinaria
 *
 * ZIP model: P(X=0) = π + (1-π)×e^(-λ)
 *            P(X=k) = (1-π)×e^(-λ)×λ^k/k!  per k>0
 *
 * dove:
 *   π = probabilità strutturale di zero tiri (non gioca, neutralizzato)
 *   λ = intensità tiri quando il giocatore è "attivo"
 *
 * E(X) = (1-π)×λ
 * Var(X) = (1-π)×λ×(1 + π×λ)  > E(X) sempre → overdispersion naturale
 *
 * Parametri stimati per ogni giocatore da dati storici con MLE.
 *
 * MERCATI SUPPORTATI:
 * - Tiri specifici giocatore (Over 0.5, 1.5, 2.5, 3.5)
 * - Tiri in porta giocatore (Over 0.5, 1.5)
 */
export interface PlayerShotProfile {
    playerId: string;
    playerName: string;
    teamId: string;
    position: 'GK' | 'DEF' | 'MID' | 'FWD';
    zipPi: number;
    zipLambda: number;
    onTargetPi: number;
    onTargetLambda: number;
    avgMinutesPlayed: number;
    homeMultiplier: number;
    avgShotsVsTopDefence: number;
    avgShotsVsWeakDefence: number;
    sampleSize: number;
    lastUpdated: Date;
}
export interface PlayerShotPrediction {
    playerId: string;
    playerName: string;
    teamId: string;
    position: string;
    expectedShots: number;
    expectedOnTarget: number;
    shotDistribution: Record<number, number>;
    onTargetDistribution: Record<number, number>;
    markets: {
        over05shots: number;
        over15shots: number;
        over25shots: number;
        over35shots: number;
        over05onTarget: number;
        over15onTarget: number;
        over25onTarget: number;
        zeroShots: number;
    };
    confidenceLevel: number;
    sampleSize: number;
    modelUsed?: PlayerShotsDistribution;
    expectedValue?: number;
    fullDistribution?: Record<number, number>;
    probabilityOver0_5?: number;
    probabilityOver1_5?: number;
    probabilityOver2_5?: number;
    confidence?: number;
}
export interface PlayerShotsPredictionOptions {
    playerShotsDistribution?: PlayerShotsDistribution;
    dispersion?: number;
    teamShotsMean?: number;
    leagueAvgTeamShots?: number;
    teamInfluenceWeight?: number;
    minTeamInfluenceMultiplier?: number;
    maxTeamInfluenceMultiplier?: number;
}
export interface MinutesObservation {
    minutes: number;
    date?: Date;
    isStarter?: boolean;
}
export interface MinutesDistributionEstimate {
    modeUsed: 'triangular' | 'empirical';
    mean: number;
    std: number;
    quantiles: {
        q25: number;
        q50: number;
        q75: number;
    };
    minutesFactor: number;
    varianceFactor: number;
    sampleSize: number;
}
export interface PlayerShotsOnTargetPrediction {
    playerId: string;
    playerName: string;
    teamId: string;
    position: string;
    expectedValue: number;
    fullDistribution: Record<number, number>;
    probabilityOver0_5: number;
    probabilityOver1_5: number;
    probabilityOver2_5: number;
    confidence: number;
    sampleSize: number;
    modelUsed: PlayerShotsDistribution;
}
export interface PlayerShotsOnTargetOptions {
    isHome?: boolean;
    expectedMinutes?: number;
    minutesDistributionMode?: 'triangular' | 'empirical';
    minutesObservations?: MinutesObservation[];
    isLikelyStarter?: boolean;
    asOf?: Date;
    historicalShotAccuracy?: number;
    leagueAvgShotAccuracy?: number;
    teamShotsOnTargetMean?: number;
    opponentShotsOnTargetAllowed?: number;
    leagueAvgTeamShotsOnTarget?: number;
    playerShotsDistribution?: PlayerShotsDistribution;
    dispersion?: number;
}
export type HierarchicalPlayerRole = 'forward' | 'winger' | 'attacking_midfielder' | 'midfielder' | 'fullback' | 'centreback' | 'goalkeeper' | 'unknown';
export interface PlayerShotShareObservation {
    playerShots: number;
    teamShots: number;
    playerMinutes: number;
    date?: Date;
}
export interface HierarchicalPlayerShotsPrediction {
    expectedShots: number;
    expectedValue?: number;
    probabilityOver0_5: number;
    probabilityOver1_5: number;
    probabilityOver2_5: number;
    fullDistribution: Record<number, number>;
    confidence: number;
    sampleSize: number;
    modelUsed: 'hierarchical_binomial' | 'hierarchical_beta_binomial';
    tau: number;
}
export declare class ShotsModel {
    private poissonPMF;
    private negBinPMF;
    private normalizeDistribution;
    private distributionToRecord;
    private probabilityOver;
    private logFactorial;
    private binomialPMF;
    private logGamma;
    private betaBinomialPMF;
    /**
     * Zero-Inflated Poisson PMF
     * P(X=0) = π + (1-π)×e^{-λ}
     * P(X=k) = (1-π)×e^{-λ}×λ^k/k!    k≥1
     */
    private zipPMF;
    private zinbPMF;
    /**
     * Genera distribuzione completa ZIP
     */
    private generateZIPDistribution;
    private generateZINBDistribution;
    /**
     * MLE per parametri ZIP da dati osservati
     * Usa algoritmo EM (Expectation-Maximization):
     *
     * E-step: calcola responsabilità degli zero strutturali
     *   γ_i = π / (π + (1-π)×e^{-λ})  per ogni zero osservato
     *
     * M-step: aggiorna parametri
     *   π_new = (Σ γ_i) / n
     *   λ_new = (Σ x_i) / (n - Σ γ_i)
     *
     * Converge in genere in 20-50 iterazioni
     */
    fitZIPParameters(observations: number[], maxIter?: number, tol?: number): {
        pi: number;
        lambda: number;
        logLikelihood: number;
    };
    fitZINBParameters(observations: number[], maxIter?: number, tol?: number): {
        pi: number;
        mu: number;
        dispersion: number;
        logLikelihood: number;
        fallbackUsed: boolean;
    };
    estimateMinutesDistribution(params: {
        mode?: 'triangular' | 'empirical';
        expectedMinutes: number;
        minutesUncertainty?: number;
        observations?: MinutesObservation[];
        isLikelyStarter?: boolean;
        asOf?: Date;
        decayPerDay?: number;
    }): MinutesDistributionEstimate;
    /**
     * Predizione tiri per singolo giocatore (ZIP model)
     *
     * Aggiustamenti contestuali:
     * 1. Se gioca in casa vs in trasferta (homeMultiplier dal profilo)
     * 2. Qualità difesa avversaria (defenceQuality: 0.7 difesa forte, 1.3 debole)
     * 3. Se titolare vs probabile panchina (riduce λ, aumenta π)
     *
     * NUOVO — minutesFactor con intervallo di confidenza:
     *   Il vecchio modello usava minutesFactor = expectedMinutes / 90 come
     *   scalare puntuale. Questo è ottimistico: i minuti attesi hanno
     *   incertezza reale (sostituzione anticipata, espulsione, infortunio).
     *
     *   Modelliamo l'incertezza con una distribuzione triangolare sui minuti:
     *     minMinutes = expectedMinutes × (1 - minutesUncertainty)
     *     maxMinutes = min(90, expectedMinutes × (1 + minutesUncertainty))
     *     mode = expectedMinutes
     *
     *   E[minutesFactor] = (min + max + mode) / (3 × 90)  [media triangolare]
     *   Var[minutesFactor] = (min² + max² + mode² - min×max - min×mode - max×mode) / (18 × 90²)
     *
     *   La varianza del minutesFactor si propaga su π come shift verso
     *   valori più alti (più incertezza → più probabilità di 0 tiri).
     *   La formula è: π_adj += varianceShift × sqrt(Var[minutesFactor])
     *
     * @param minutesUncertainty  Incertezza relativa sui minuti (default 0.15 = ±15%)
     */
    predictPlayerShots(profile: PlayerShotProfile, isHome: boolean, defenceQuality?: number, isLikelyStarter?: boolean, expectedMinutes?: number, minutesUncertainty?: number, options?: PlayerShotsPredictionOptions): PlayerShotPrediction;
    predictPlayerShotsOnTarget(profile: PlayerShotProfile, options?: PlayerShotsOnTargetOptions): PlayerShotsOnTargetPrediction;
    predictHierarchicalPlayerShots(teamShotsDistribution: {
        mean: number;
        dispersion?: number;
    }, covariates: {
        playerId: string;
        playerName: string;
        teamId: string;
        role?: HierarchicalPlayerRole;
        expectedMinutes?: number;
        observations?: PlayerShotShareObservation[];
        minMinutesForShotShare?: number;
        useBetaBinomial?: boolean;
        asOf?: Date;
        decayPerDay?: number;
    }): HierarchicalPlayerShotsPrediction;
    /**
     * Stima profilo giocatore da dati storici
     * Usa MLE per ZIP via algoritmo EM
     */
    estimatePlayerProfile(playerId: string, playerName: string, teamId: string, position: PlayerShotProfile['position'], shotObservations: number[], // tiri per partita
    onTargetObservations: number[], // tiri in porta per partita
    homeShotObs: number[], // solo partite in casa
    minutesObs: number[]): PlayerShotProfile;
}
