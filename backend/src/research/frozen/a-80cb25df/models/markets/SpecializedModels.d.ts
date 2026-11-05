/**
 * MODELLI STATISTICI SPECIALIZZATI — Versione migliorata
 * =========================================================
 *
 * Miglioramenti principali rispetto alla versione originale:
 *
 * 1. DISPERSIONE NegBin: non più fissa (r=9 shots, r=12.4 cards),
 *    ma stimata dinamicamente dai dati squadra. Il parametro fisso
 *    ignorava la variabilità reale tra squadre diverse.
 *
 * 2. TIRI: aggiunta correzione per qualità difensiva avversaria
 *    sui tiri in porta (non solo sui tiri totali). Aggiunto anche
 *    un fattore di regressione verso la media di lega.
 *
 * 3. CARTELLINI: il fattore arbitro ora usa una media mobile ponderata
 *    (partite recenti pesano di più) invece di una media semplice.
 *    Aggiunta anche la correlazione cartellini-falli per partita
 *    (un arbitro severo con i falli tende a dare più cartellini).
 *
 * 4. FALLI: la correzione possesso ora usa una curva non-lineare
 *    (prima era lineare, ma l'effetto è saturo agli estremi).
 *    Aggiunta correlazione intra-partita tra falli casa e ospite.
 *
 * 5. GIOCATORI: il modello Dirichlet-Multinomiale ora tiene conto
 *    del regression-to-mean in funzione del sample size. Giocatori
 *    con poche partite vengono spinti verso la quota media del ruolo.
 *
 * 6. LOGAMMA: sostituita l'approssimazione di Stirling con quella
 *    di Lanczos a 9 coefficienti (più precisa per valori piccoli < 5).
 *
 * 7. CALIBRAZIONE probabilità: tutte le over/under passano per
 *    un unico metodo `negBinOver` corretto (prima c'erano 3 implementazioni
 *    diverse sparse nel codice con comportamenti leggermente diversi).
 */
export interface NegBinParams {
    mu: number;
    r: number;
}
export type CountDistributionType = 'negative_binomial' | 'poisson' | 'underdispersed_poisson_fallback';
export interface CountDistributionSelection {
    distributionType: CountDistributionType;
    warning?: string;
}
export interface TeamCountMarketPrediction {
    mean: number;
    variance: number;
    dispersion: number;
    distributionType: CountDistributionType;
    overUnder: Record<string, {
        over: number;
        under: number;
    }>;
    exact?: Record<string, number>;
    confidence: number;
    sampleSize: number;
    dataRichness: number;
    warning?: string;
}
export interface ShotsModelData {
    homeTeamAvgShots: number;
    awayTeamAvgShots: number;
    homeTeamAvgShotsOT: number;
    awayTeamAvgShotsOT: number;
    homeTeamShotsSuppression: number;
    awayTeamShotsSuppression: number;
    homeAdvantageShots: number;
    homeTeamVarShots?: number;
    awayTeamVarShots?: number;
    homeTeamVarShotsOT?: number;
    awayTeamVarShotsOT?: number;
    homeTeamSampleSize?: number;
    awayTeamSampleSize?: number;
    leagueAvgShots?: number;
    leagueAvgShotsOT?: number;
    regressionWeight?: number;
}
export interface CardsModelData {
    homeTeamAvgYellow: number;
    awayTeamAvgYellow: number;
    homeTeamAvgRed: number;
    awayTeamAvgRed: number;
    refereeAvgYellow: number;
    refereeAvgRed: number;
    leagueAvgYellow: number;
    competitiveness: number;
    homeTeamSampleSize?: number;
    awayTeamSampleSize?: number;
    refereeSampleSize?: number;
    homeTeamVarYellow?: number;
    awayTeamVarYellow?: number;
    refereeAvgFouls?: number;
    leagueAvgFouls?: number;
}
export interface FoulsModelData {
    homeTeamAvgFouls: number;
    awayTeamAvgFouls: number;
    homePossessionEst: number;
    refereeAvgFouls: number;
    leagueAvgFouls: number;
    homeTeamVarFouls?: number;
    awayTeamVarFouls?: number;
    homeTeamSampleSize?: number;
    awayTeamSampleSize?: number;
}
export interface PlayerShotsData {
    playerId: string;
    playerName: string;
    teamId: string;
    avgShotsPerGame: number;
    avgShotsOnTargetPerGame: number;
    gamesPlayed: number;
    shotShareOfTeam: number;
    isStarter: boolean;
    positionCode: string;
}
export interface ShotsDistribution {
    teamId: string;
    expectedTotalShots: number;
    expectedShotsOnTarget: number;
    overUnder: Record<string, {
        over: number;
        under: number;
    }>;
    negBinParams: NegBinParams;
}
export interface CardsDistribution {
    expectedHomeYellow: number;
    expectedAwayYellow: number;
    expectedTotalYellow: number;
    expectedHomeRed: number;
    expectedAwayRed: number;
    expectedTotalCards: number;
    overUnderYellow: Record<string, {
        over: number;
        under: number;
    }>;
    overUnderTotal: Record<string, {
        over: number;
        under: number;
    }>;
    negBinParams: NegBinParams;
}
export interface FoulsDistribution {
    expectedHomeFouls: number;
    expectedAwayFouls: number;
    expectedTotalFouls: number;
    overUnder: Record<string, {
        over: number;
        under: number;
    }>;
    negBinParams: NegBinParams;
}
export interface PlayerShotsPrediction {
    playerId: string;
    playerName: string;
    teamId: string;
    positionCode: string;
    sampleSize: number;
    expectedShots: number;
    expectedShotsOnTarget: number;
    prob1PlusShots: number;
    prob2PlusShots: number;
    prob3PlusShots: number;
    prob1PlusShotsOT: number;
    shotShareOfTeam: number;
}
export declare class SpecializedModels {
    /**
     * PMF della Binomiale Negativa via log-space per stabilità numerica.
     * Parametrizzazione (mu, r): E[X]=mu, Var[X]=mu+mu²/r.
     */
    negBinPMF(k: number, mu: number, r: number): number;
    /**
     * CDF della NegBin: P(X <= k).
     * Il limite superiore di somma è adattivo per evitare troncamenti.
     */
    negBinCDF(k: number, mu: number, r: number): number;
    /**
     * P(X > threshold) — usata per tutti i mercati Over/Under.
     * MIGLIORAMENTO: gestisce correttamente le linee intere vs .5
     * (threshold=2 → P(X>2) = P(X>=3); threshold=2.5 → P(X>=3)).
     */
    negBinOver(threshold: number, mu: number, r: number): number;
    /**
     * Tabella Over/Under NegBin per un insieme di linee: { "line": { over, under } }.
     * Estratto da 4 definizioni locali identiche (tiri, cartellini, falli, corner).
     */
    private makeNegBinOverUnder;
    /**
     * Stima r dal metodo dei momenti: r = mu²/(var - mu).
     * Se var <= mu il dato è equidisperso → usa r grande (quasi-Poisson).
     *
     * LOWER BOUND DIPENDENTE DALLA NUMEROSITÀ DEL CAMPIONE:
     *   r_min = 1 + 1/sqrt(n)
     *
     * Razionale: con pochi dati (n=5) r_min=1.45, con tanti dati (n=100)
     * r_min=1.1. Questo evita di ignorare arbitrariamente un r realmente
     * basso quando i dati sono abbondanti, ma protegge da stime instabili
     * con campioni piccoli. Il lower bound fisso 1.5 è un prior duro che
     * non distingue tra 10 e 200 partite osservate — sbagliato in senso
     * bayesiano. Questa versione fa parlare i dati quando sono sufficienti.
     *
     * Contesto betting: stiamo modellando mercati, non fenomeni fisici.
     * Un r=1.2 reale va rispettato se n è grande, perché corrisponde a
     * una distribuzione davvero overdispersa che il bookmaker potrebbe
     * non prezzare correttamente.
     *
     * @param sampleSize  n partite osservate (default=20 = prior moderato)
     */
    estimateDispersion(mu: number, variance: number, sampleSize?: number, maxR?: number): number;
    selectCountDistribution(mean: number, variance: number, tolerance?: number): CountDistributionSelection;
    estimateDispersionWithShrinkage(params: {
        mu: number;
        variance: number;
        sampleSize: number;
        leagueDispersion: number;
        maxR?: number;
        minSampleForTeamDispersion?: number;
    }): number;
    predictTeamCountMarket(params: {
        market: 'shots' | 'shots_on_target' | 'yellow_cards' | 'fouls' | 'corners';
        mean: number;
        variance: number;
        sampleSize: number;
        leagueMean?: number;
        leagueDispersion?: number;
        lines: number[];
        exactCounts?: number[];
    }): TeamCountMarketPrediction;
    /**
     * Regressione bayesiana verso la media di lega (shrinkage).
     * Con pochi dati, ci fidiamo di più della media di lega.
     * formula: mu_shrunk = (n * mu_team + k * mu_league) / (n + k)
     * dove k è il "prior strength" (quante partite equivalenti valgono le prior).
     */
    private shrinkToLeague;
    /**
     * Modello tiri NegBin.
     *
     * STRUTTURA DATI: il return è backward-compatible con DixonColesModel.ts
     * (mantiene i campi legacy ShotsDistribution: expectedTotalShots,
     * expectedShotsOnTarget, overUnder, total) E aggiunge i campi nuovi
     * attesi dal frontend (totalShots.distribution, shotsOnTarget.distribution,
     * combined.overUnder in formato flat "over235", combined.onTargetOverUnder).
     *
     * LOWER BOUND ADATTIVO: r_min = 1 + 1/sqrt(n)
     */
    computeShotsDistribution(data: ShotsModelData): {
        home: ShotsDistribution & {
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
        };
        away: ShotsDistribution & {
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
        };
        /** @deprecated usa home.totalShots / away.totalShots */
        total: Record<string, {
            over: number;
            under: number;
        }>;
        combined: {
            totalShots: {
                expected: number;
                variance: number;
            };
            totalOnTarget: {
                expected: number;
                variance: number;
            };
            overUnder: Record<string, number>;
            onTargetOverUnder: Record<string, number>;
        };
    };
    /**
     * MIGLIORAMENTI al modello cartellini:
     *
     * 1. r DINAMICO: il parametro di dispersione è stimato dalle varianze
     *    storiche di ogni squadra anziché usare r=12.4 fisso per tutti.
     *
     * 2. FATTORE ARBITRO con smorzamento bayesiano:
     *    Se l'arbitro ha poche partite, il suo fattore viene smorzato
     *    verso 1.0 (media lega). Un arbitro con 5 partite non dovrebbe
     *    pesare quanto uno con 50.
     *    referee_factor = 1 + (raw_factor - 1) * (n_games / (n_games + 15))
     *
     * 3. CORRELAZIONE falli→cartellini:
     *    Un arbitro molto rigoroso sui falli tende a dare anche più cartellini.
     *    Aggiungiamo un piccolo boost se l'arbitro è sotto i falli rispetto
     *    alla media (= gioca più fisico senza punire → più cartellini finali).
     *
     * 4. COMPETITIVENESS con curva sigmoidale CENTRATA invece di lineare:
     *    compFactor = 1 + max_boost * (2*sigmoid(competitiveness * 8 - 4) - 1)
     *    Neutra (1.0) per una partita media (competitiveness=0.5), +max_boost sui
     *    derby equilibratissimi, -max_boost sui match sbilanciati. Essere centrata
     *    è essenziale: competitiveness è valorizzata su OGNI partita, quindi un
     *    fattore non centrato introdurrebbe un bias sistematico sul livello dei
     *    cartellini (vedi BUGFIX 2026-07 in computeCardsDistribution).
     *
     * 5. Shrinkage verso la media di lega per squadre con pochi dati.
     */
    computeCardsDistribution(data: CardsModelData): CardsDistribution;
    /**
     * MIGLIORAMENTI al modello falli:
     *
     * 1. CORREZIONE POSSESSO non-lineare:
     *    La versione originale usava: corr = 1 - 0.35 * (poss - 0.5) / 0.5
     *    Questo è lineare e produce valori irrealistici agli estremi.
     *    Nuova formula: corr = exp(-0.6 * (poss - 0.5) / 0.5) per chi ha palla,
     *    e l'inverso per chi insegue. L'esponenziale è più fedele ai dati.
     *
     * 2. CORRELAZIONE INTRA-PARTITA positiva tra falli casa e ospite:
     *    Non è solo l'arbitro a determinare i falli: le partite "ruvide"
     *    portano entrambe le squadre a fare più falli. Nella stima della
     *    varianza del totale si aggiunge la covarianza con rho_fouls ≈ 0.25.
     *
     * 3. r DINAMICO stimato dalla varianza storica (se disponibile).
     *
     * 4. Shrinkage verso la media di lega per team con pochi dati.
     */
    computeFoulsDistribution(data: FoulsModelData): FoulsDistribution;
    /**
     * MIGLIORAMENTI al modello tiri per giocatore:
     *
     * 1. REGRESSION-TO-MEAN per ruolo:
     *    Giocatori con pochi dati vengono spinti verso la media del loro ruolo.
     *    Prior mean per ruolo (Media Serie A empirica):
     *      FW: shotShare ≈ 0.20, MF: ≈ 0.12, DF: ≈ 0.05
     *
     * 2. NORMALIZZAZIONE ROBUSTA delle share:
     *    Se la somma delle share è 0 o molto piccola, si usa 1/n_starters.
     *    Nella versione originale con totalShare → 0 si divideva per 0.
     *
     * 3. P(X >= k) via NegBin invece di approssimazioni ad hoc:
     *    Tutti i calcoli passano per negBinPMF/negBinCDF per consistenza.
     *
     * 4. BOUND realistici:
     *    expectedShots per giocatore clampato a [0, 6] (oltre 6 tiri
     *    per un singolo giocatore in una partita è statisticamente raro).
     */
    computePlayerShotsPredictions(players: PlayerShotsData[], expectedTeamShots: number, expectedTeamShotsOT: number): PlayerShotsPrediction[];
    /**
     * Modello angoli (corners) — Stima basata su tiri e stile di gioco.
     */
    computeCornersDistribution(data: {
        homeTeamAvgCornersFor: number;
        homeTeamAvgCornersAgainst: number;
        awayTeamAvgCornersFor: number;
        awayTeamAvgCornersAgainst: number;
        homeTeamSampleSize?: number;
        awayTeamSampleSize?: number;
    }): {
        expectedHomeCorners: number;
        expectedAwayCorners: number;
        expectedTotalCorners: number;
        overUnder: Record<string, {
            over: number;
            under: number;
        }>;
        negBinParams: NegBinParams;
    };
}
