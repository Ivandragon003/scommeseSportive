/**
 * Dixon-Coles Model — v3.1
 *
 * MODIFICHE rispetto all'originale:
 *
 * 1. homeAdvantage default: 0.10 (era 0.15, era 0.25 in v1)
 *    I dati aggregati dei top 5 campionati europei 2020-2024 mostrano
 *    un calo strutturale del vantaggio casa post-COVID che non si è
 *    invertito. exp(0.10) ≈ +10.5% goal attesi in casa vs trasferta.
 *    Serie A 2022-2024: home win rate ~40%, ben lontano dal 46% pre-2015.
 *    Il vecchio 0.15 (+16%) sovrastimava l'edge casalingo e generava
 *    false opportunità di valore sul homeWin in partite equilibrate.
 *    Il parametro viene comunque riallenato dai dati storici reali via
 *    trainOnMatches(), quindi questa è solo la prior iniziale.
 *
 * 2. homeAdvantageShots: 1.08 (era 1.12)
 *    Coerente con la riduzione del vantaggio casa sui goal: anche i tiri
 *    in casa sono calati proporzionalmente.
 *
 * 3. computeFullProbabilities ora restituisce flatProbabilities:
 *    Record<string, number> con TUTTI i mercati già mappati con le
 *    chiavi usate da ValueBettingEngine v3:
 *      - goal:     homeWin, draw, awayWin, btts, bttsNo, over/under*
 *      - shots:    shotsOver*, shotsUnder*, shotsHomeOver*, shotsAwayOver*
 *      - shots OT: shotsOTOver*, shotsOTUnder*
 *      - gialli:   yellowOver*, yellowUnder*
 *      - falli:    foulsOver*, foulsUnder*
 *      - exact:    exact_H-A
 *      - handicap: hcp_home+X, hcp_away+X
 *    Questo elimina la necessità di flattenProbabilities nel BacktestingEngine.
 *
 * 3. SupplementaryData estesa con campi varianza e sampleSize per
 *    passare informazioni a SpecializedModels (r dinamico).
 *
 * Resto invariato (Dixon-Coles 1997, gradient ascent, normalizzazione,
 * correzione τ per bassi score, decadimento temporale τ=0.0065).
 **/
import { PlayerShotsData, CardsDistribution, FoulsDistribution, PlayerShotsPrediction, NegBinParams } from '../markets/SpecializedModels';
import { BootstrapMode } from '../../config/PredictionEngineConfig';
export interface ScoreDependenceModel {
    correction(i: number, j: number, lambdaHome: number, lambdaAway: number, rho: number): number;
}
export declare class ClassicDixonColesDependence implements ScoreDependenceModel {
    correction(i: number, j: number, lambdaHome: number, lambdaAway: number, rho: number): number;
}
export declare class NoDependence implements ScoreDependenceModel {
    correction(): number;
}
export interface DixonColesRuntimeOptions {
    scoreDependenceModel?: ScoreDependenceModel;
}
export interface MatchData {
    matchId: string;
    homeTeamId: string;
    awayTeamId: string;
    date: Date;
    homeGoals?: number;
    awayGoals?: number;
    homeXG?: number;
    awayXG?: number;
    homeShotsOnTarget?: number;
    awayShotsOnTarget?: number;
    homeTotalShots?: number;
    awayTotalShots?: number;
    homePossession?: number;
    awayPossession?: number;
    homeFouls?: number;
    awayFouls?: number;
    homeYellowCards?: number;
    awayYellowCards?: number;
    homeRedCards?: number;
    awayRedCards?: number;
    referee?: string;
    competition?: string;
    season?: string;
}
export interface ModelParams {
    attackParams: Record<string, number>;
    defenceParams: Record<string, number>;
    homeAdvantage: number;
    rho: number;
    tau: number;
    /**
     * homeAdvantagePerTeam: parametro di vantaggio casa per squadra/stadio.
     * Sovrascrive homeAdvantage globale per le squadre elencate.
     * Viene riallenato da fitModel() se enablePerTeamHomeAdvantage=true.
     *
     * Motivazione: alcune squadre hanno un vantaggio casa strutturalmente più
     * alto (es. Atalanta al Gewiss Stadium, Napoli al Maradona in certi anni)
     * o più basso (squadre che performano meglio in trasferta). Il parametro
     * globale unico livella queste differenze e distorce le probabilità.
     *
     * Default: {} → il parametro globale homeAdvantage viene usato per tutti.
     */
    homeAdvantagePerTeam: Record<string, number>;
    /**
     * levelCorrection: fattore di ri-livellamento per-lega del livello di λ,
     * stimato a fit-time come c = Σ(goal reali) / Σ(λ strutturale) sul training.
     *
     * Il modello Dixon-Coles sottostima strutturalmente il livello totale dei
     * goal (interazione tra correzione τ con ρ<0 e i gradienti att/def stimati sul
     * Poisson marginale). Backtest walk-forward OOS 2026-07: il bias NON è
     * universale ma per-lega (Serie A/Liga ~1.05-1.10, Premier/Bundesliga
     * ~1.25-1.32). Applicato in computeExpectedGoals scala λ verso il livello
     * reale: −1.44% logLoss sul raw, azzera il bias residuo sui totali dopo
     * calibrazione (over2.5 calibration-in-the-large z 6.3→0), neutro sul betting
     * (dove il blending col mercato già ri-livella).
     *
     * Default: assente → nessuna correzione (fattore 1.0).
     */
    levelCorrection?: {
        home: number;
        away: number;
    };
}
export interface ScoreMatrix {
    probabilities: number[][];
    maxGoals: number;
    lambdaHome: number;
    lambdaAway: number;
}
export interface FullMatchProbabilities {
    homeWin: number;
    draw: number;
    awayWin: number;
    btts: number;
    over05: number;
    over15: number;
    over25: number;
    over35: number;
    over45: number;
    under05: number;
    under15: number;
    under25: number;
    under35: number;
    under45: number;
    exactScore: Record<string, number>;
    handicap: Record<string, number>;
    asianHandicap: Record<string, number>;
    shotsHome: {
        expected: number;
        overUnder: Record<string, {
            over: number;
            under: number;
        }>;
        totalShots: {
            expected: number;
            variance: number;
            distribution: Record<string, number>;
        };
        shotsOnTarget: {
            expected: number;
            variance: number;
            distribution: Record<string, number>;
        };
        negBinParams: NegBinParams;
    };
    shotsAway: {
        expected: number;
        overUnder: Record<string, {
            over: number;
            under: number;
        }>;
        totalShots: {
            expected: number;
            variance: number;
            distribution: Record<string, number>;
        };
        shotsOnTarget: {
            expected: number;
            variance: number;
            distribution: Record<string, number>;
        };
        negBinParams: NegBinParams;
    };
    shotsTotal: Record<string, {
        over: number;
        under: number;
    }>;
    shotsOnTargetHome: {
        expected: number;
        variance: number;
        distribution: Record<string, number>;
    };
    shotsOnTargetAway: {
        expected: number;
        variance: number;
        distribution: Record<string, number>;
    };
    cards: CardsDistribution;
    fouls: FoulsDistribution;
    corners?: {
        expectedHomeCorners: number;
        expectedAwayCorners: number;
        expectedTotalCorners: number;
        overUnder: Record<string, {
            over: number;
            under: number;
        }>;
        negBinParams: {
            mu: number;
            r: number;
        };
    };
    playerShots: {
        home: PlayerShotsPrediction[];
        away: PlayerShotsPrediction[];
    };
    lambdaHome: number;
    lambdaAway: number;
    /**
     * Mappa piatta di TUTTI i mercati, pronta per ValueBettingEngine.analyzeMarkets().
     * Chiavi allineate con categorizeSelection() di ValueBettingEngine v3.
     */
    flatProbabilities: Record<string, number>;
}
export interface SupplementaryData {
    homeTeamStats?: {
        avgShots: number;
        avgShotsOT: number;
        avgYellowCards: number;
        avgRedCards: number;
        avgFouls: number;
        shotsSuppression: number;
        avgHomeCorners?: number;
        avgAwayCorners?: number;
        avgCornersConceded?: number;
        avgFoulsDrawn?: number;
        avgPossession?: number;
        varShots?: number;
        varShotsOT?: number;
        varYellowCards?: number;
        varFouls?: number;
        sampleSize?: number;
    };
    awayTeamStats?: {
        avgShots: number;
        avgShotsOT: number;
        avgYellowCards: number;
        avgRedCards: number;
        avgFouls: number;
        shotsSuppression: number;
        avgHomeCorners?: number;
        avgAwayCorners?: number;
        avgCornersConceded?: number;
        avgFoulsDrawn?: number;
        avgPossession?: number;
        varShots?: number;
        varShotsOT?: number;
        varYellowCards?: number;
        varFouls?: number;
        sampleSize?: number;
    };
    refereeStats?: {
        avgYellow: number;
        avgRed: number;
        avgFouls: number;
        sampleSize?: number;
    };
    homePlayers?: PlayerShotsData[];
    awayPlayers?: PlayerShotsData[];
    competitiveness?: number;
    isDerby?: boolean;
    leagueAvgYellow?: number;
    leagueAvgFouls?: number;
    homeAdvantageShots?: number;
    contextAdjustments?: {
        homeGoalMultiplier?: number;
        awayGoalMultiplier?: number;
        homeShotMultiplier?: number;
        awayShotMultiplier?: number;
        yellowCardMultiplier?: number;
        foulMultiplier?: number;
        homePossessionShift?: number;
    };
}
export declare class DixonColesModel {
    private params;
    private readonly MAX_GOALS;
    private readonly PARAM_BOUND;
    private readonly LAMBDA_MIN;
    private readonly LAMBDA_MAX;
    private specialized;
    private scoreDependenceModel;
    constructor(params?: Partial<ModelParams>, options?: DixonColesRuntimeOptions);
    private safeExp;
    private safeProb;
    private poissonPMF;
    /**
     * Correzione τ per correlazione negativa tra homeGoals e awayGoals
     * sui risultati bassi (0-0, 1-0, 0-1, 1-1).
     * Dixon & Coles 1997, eq. (2).
     */
    private tauCorrection;
    private tauDerivative;
    computeExpectedGoals(homeId: string, awayId: string, homeXG?: number, awayXG?: number): {
        lambdaHome: number;
        lambdaAway: number;
    };
    buildScoreMatrix(homeId: string, awayId: string, homeXG?: number, awayXG?: number): ScoreMatrix;
    private buildScoreMatrixFromLambdas;
    computeFullProbabilities(homeId: string, awayId: string, homeXG?: number, awayXG?: number, supp?: SupplementaryData): FullMatchProbabilities;
    /**
     * Calcola il peso temporale di una partita rispettando l'identità di stagione.
     *
     * PROBLEMA COL DECADIMENTO ESPONENZIALE PURO:
     * exp(-τ × età) tratta tutte le partite come un continuum temporale,
     * ignorando la struttura del campionato:
     * - A metà stagione (giornata 19/38) la giornata 1 pesa pochissimo,
     *   ma descrive la STESSA squadra con lo STESSO allenatore → informazione persa.
     * - Le partite della stagione precedente con lo stesso allenatore possono
     *   valere più di una partita recente post-cambio allenatore.
     *
     * SCHEMA IBRIDO stagione-aware + recency:
     *
     * 1. STAGIONE CORRENTE → peso quasi-uniforme (τ intra molto basso = 0.002):
     *    La squadra ha un'identità stabile. Le partite della giornata 1 e della
     *    giornata 20 descrivono la stessa rosa, lo stesso modulo, lo stesso
     *    allenatore. Decadimento minimo — solo per dare leggermente più peso
     *    alle partite delle ultime 2 settimane rispetto a quelle di 3 mesi fa.
     *
     * 2. STAGIONE PRECEDENTE → salto fisso (prevSeasonWeight=0.35) + decadimento inter:
     *    Le partite dell'anno prima descrivono spesso un'identità diversa.
     *    Peso massimo 35% di una partita corrente. Poi decadimento τ=0.018.
     *
     * 3. STAGIONI ANTECEDENTI → peso residuo (0.08) + stesso decadimento inter:
     *    Quasi irrilevanti dopo 2 anni.
     *
     * 4. CAMBIO ALLENATORE (opzionale):
     *    Partite pre-cambio ricevono moltiplicatore managerChangePenalty=0.15.
     *    Una partita della stagione corrente ma con l'ex-allenatore vale poco.
     *
     * ESEMPIO (metà stagione, giornata 20, Serie A 2024-25):
     *   Giornata  1 corrente  → w ≈ 0.98  (stesso allenatore, stesso modulo)
     *   Giornata 20 corrente  → w = 1.00  (partita più recente)
     *   Ultima giornata 23-24 → w ≈ 0.33  (anno prima, identità diversa)
     *   Giornata  1 del 23-24 → w ≈ 0.19  (anno prima + più vecchia)
     *   Due anni fa           → w ≈ 0.04  (quasi irrilevante)
     */
    private computeMatchWeight;
    /**
     * Risolve la stagione corrente e quella precedente dall'insieme di partite.
     * Formato atteso: "2024-25", "2023-24", "2024", "2023" (ordine lessicografico).
     */
    private resolveSeasons;
    /**
     * Gradient ascent sulla log-verosimiglianza con pesi ibridi stagione-aware.
     *
     * I pesi vengono pre-calcolati una volta sola prima del loop di ottimizzazione
     * (sono funzione solo dei metadati della partita, non dei parametri).
     * Il gradiente viene normalizzato per il peso totale (non per il numero di partite)
     * così le iterazioni sono comparabili indipendentemente dalla distribuzione dei pesi.
     *
     * @param opts.prevSeasonWeight     Peso massimo stagione precedente (default 0.35)
     * @param opts.tauInter             Decadimento inter-stagionale (default 0.018)
     * @param opts.managerChangeDates   Map teamId → data cambio allenatore
     * @param opts.managerChangePenalty Peso partite pre-cambio allenatore (default 0.15)
     */
    fitModel(matches: MatchData[], teams: string[], maxIter?: number, lr?: number, opts?: {
        /** Reference clock for historical fits; no mutation of the live clock. */
        referenceDate?: Date;
        prevSeasonWeight?: number;
        tauInter?: number;
        currentSeasonDecay?: number;
        previousSeasonDecay?: number;
        olderSeasonBaseWeight?: number;
        olderSeasonDecay?: number;
        managerChangeDates?: Record<string, Date>;
        managerChangePenalty?: number;
        /**
         * enablePerTeamHomeAdvantage: se true, stima un parametro homeAdvantage
         * separato per ciascuna squadra home. Richiede almeno 8-10 partite home
         * per squadra per stabilità. Con dataset piccoli preferire false.
         * Default: false → usa il parametro globale homeAdvantage per tutti.
         */
        enablePerTeamHomeAdvantage?: boolean;
        enableDynamicTeamStrengths?: boolean;
        dynamicSmoothingSigmaAttack?: number;
        dynamicSmoothingSigmaDefence?: number;
        dynamicSmoothingSigmaHomeAdvantage?: number;
        /**
         * structuralBreaks: eventi strutturali (cambio modulo, mercato estivo,
         * retrocessione/promozione) che azzerano parzialmente la storia di una
         * squadra, similmente al cambio allenatore.
         * Map teamId → data dell'evento strutturale.
         */
        structuralBreaks?: Record<string, Date>;
        /**
         * structuralBreakPenalty: moltiplicatore peso per partite pre-evento
         * strutturale. Default 0.25 (più permissivo di managerChangePenalty=0.15
         * perché il cambio tattico è parziale, non totale).
         */
        structuralBreakPenalty?: number;
        enableAutomaticStructuralBreakDetection?: boolean;
        /**
         * xgBlendWeight: peso dell'xG nello pseudo-goal usato dal fit
         * (quasi-likelihood). 0 = solo goal reali (comportamento storico),
         * 0.6 = default consigliato. Se undefined usa la config globale.
         * Il blend riduce il rumore della finalizzazione: un 3-0 con xG 0.8
         * non gonfia più l'attacco come tre goal "meritati".
         */
        xgBlendWeight?: number;
    }): ModelParams;
    /**
     * Stima e memorizza levelCorrection = Σ(goal reali)/Σ(λ strutturale) sul
     * training, separatamente per casa e trasferta. λ è calcolata come in
     * computeExpectedGoals (pre-tau, pre-xG blend) così il fattore corregge
     * esattamente il livello che il predict poi scala. Clamp prudente [0.85,1.35]:
     * il bias osservato OOS è ~1.04-1.32, valori fuori range indicano dati sporchi.
     */
    private assignLevelCorrection;
    detectStructuralBreaks(teamMatches: MatchData[], options?: {
        teamId?: string;
        minWindow?: number;
        minConfidence?: number;
    }): Array<{
        teamId: string;
        date: Date;
        confidence: number;
        breakType: 'attack' | 'defence' | 'global';
        suggestedWeightMultiplier: number;
        metrics: {
            attackShift: number;
            defenceShift: number;
        };
    }>;
    fitDynamicTeamStrengths(matches: MatchData[], teams: string[], options?: {
        windowSize?: number;
        maxIter?: number;
        lr?: number;
        enablePerTeamHomeAdvantage?: boolean;
        dynamicSmoothingSigmaAttack?: number;
        dynamicSmoothingSigmaDefence?: number;
        dynamicSmoothingSigmaHomeAdvantage?: number;
    }): Array<{
        windowStart: Date;
        windowEnd: Date;
        params: ModelParams;
        smoothingPenalty: number;
    }>;
    /**
     * Walk-forward temporal tuning for decay rates.
     *
     * The method sorts matches by date, fits each candidate only on matches
     * strictly before the validation window, then scores the immediately
     * following validation window. It does not use future validation rows in
     * the model fit for that fold.
     */
    optimizeTemporalWeights(matches: MatchData[], odds?: Record<string, Record<string, number>>, objective?: 'logLoss' | 'brierScore' | 'edgeNoVig'): {
        best: {
            currentSeasonDecay: number;
            previousSeasonDecay: number;
            olderSeasonDecay: number;
            objectiveValue: number;
        };
        folds: Array<{
            trainMatches: number;
            validationMatches: number;
            startDate: Date;
            endDate: Date;
            objectiveValue: number;
        }>;
        candidates: Array<{
            currentSeasonDecay: number;
            previousSeasonDecay: number;
            olderSeasonDecay: number;
            objectiveValue: number;
        }>;
        usedFallback: boolean;
    };
    getParams(): ModelParams;
    setParams(p: Partial<ModelParams>): void;
    /**
     * Bootstrap parametrico per propagazione dell'incertezza.
     *
     * Modalita implementate:
     * - paramNoise: perturbazione gaussiana stocastica dei parametri, implementazione primaria.
     * - jackknife: fallback deterministico compatibile, basato su shock-grid; non e leave-one-out empirico.
     * - hessian: fallback deterministico compatibile, basato su shock-grid; non calcola una Hessiana analitica.
     *
     * I fallback mantengono lo stesso output pubblico per non rompere computeSuggestedStakeWithUncertainty().
     *
     * PROBLEMA: computeExpectedGoals restituisce stime puntuali (λHome, λAway).
     * Ma i parametri attack/defence/homeAdvantage sono stimati da dati finiti
     * e hanno incertezza. Due squadre con attack=0.15 ma una con 8 partite e
     * l'altra con 35 hanno la stessa stima puntuale ma incertezza molto diversa.
     *
     * SOLUZIONE — bootstrap parametrico:
     * 1. Campiona N perturbazioni dei parametri da una distribuzione normale
     *    centrata sui valori stimati, con std proporzionale a 1/sqrt(n_matches).
     * 2. Per ogni campione, calcola (λHome_i, λAway_i).
     * 3. Restituisce media, std e intervallo di confidenza della distribuzione
     *    di λHome e λAway.
     *
     * La std dei parametri è approssimata come:
     *   σ_attack[t]  ≈ PARAM_NOISE_BASE / sqrt(n_home_matches[t])
     *   σ_defence[t] ≈ PARAM_NOISE_BASE / sqrt(n_away_matches[t])
     *   σ_ha         ≈ PARAM_NOISE_BASE / sqrt(total_matches)
     *
     * PARAM_NOISE_BASE = 0.18: calibrato su studi Monte Carlo del modello
     * Dixon-Coles con dataset Serie A (300-380 partite/stagione).
     * Produce una std dei λ di ~8-12% su squadre con 15-20 partite,
     * che corrisponde all'incertezza empirica osservata.
     *
     * UTILIZZO nel Value Engine:
     * La std(λ) viene convertita in uncertaintyFactor ∈ [0, 1]:
     *   uncertaintyFactor = clamp(cv_lambda / MAX_CV, 0, 1)
     *   dove cv_lambda = std(λ) / mean(λ)  [coefficiente di variazione]
     * Il Value Engine usa uncertaintyFactor per scalare lo stake
     * (Bayesian Kelly adattivo).
     *
     * @param homeId   ID squadra home
     * @param awayId   ID squadra away
     * @param nSamples Numero campioni bootstrap (default 200 — bilancia precisione/velocità)
     * @param matchCounts Numero partite per squadra (per calibrare σ dei parametri)
     */
    bootstrapLambdas(homeId: string, awayId: string, nSamplesOrOptions?: number | {
        bootstrapMode?: BootstrapMode;
        bootstrapSamples?: number;
        uncertaintyCvReference?: number;
        matchCounts?: Record<string, number>;
    }, matchCounts?: Record<string, number>): {
        lambdaHomeMean: number;
        lambdaAwayMean: number;
        lambdaHomeStd: number;
        lambdaAwayStd: number;
        cvMax: number;
        CV_max: number;
        uncertaintyFactor: number;
        lambda_home_mean: number;
        lambda_home_std: number;
        lambda_away_mean: number;
        lambda_away_std: number;
    };
}
