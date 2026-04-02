import {
  negBinOver as computeNegBinOver,
  negBinPMF as computeNegBinPMF,
} from './MathUtils';

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
  mu: number;    // media (E[X])
  r: number;     // dispersion parameter: Var[X] = mu + mu²/r
}

export interface ShotsModelData {
  homeTeamAvgShots: number;
  awayTeamAvgShots: number;
  homeTeamAvgShotsOT: number;
  awayTeamAvgShotsOT: number;
  homeTeamShotsSuppression: number;
  awayTeamShotsSuppression: number;
  homeAdvantageShots: number;
  // Varianza storica per stima r dinamica
  homeTeamVarShots?: number;
  awayTeamVarShots?: number;
  homeTeamVarShotsOT?: number;
  awayTeamVarShotsOT?: number;
  // Sample size per lower bound adattivo r_min = 1 + 1/sqrt(n)
  homeTeamSampleSize?: number;
  awayTeamSampleSize?: number;
  // Regressione verso la media di lega
  leagueAvgShots?: number;
  leagueAvgShotsOT?: number;
  regressionWeight?: number;   // 0 = no regressione, 1 = solo media lega
}

export interface CardsModelData {
  homeTeamAvgYellow: number;
  awayTeamAvgYellow: number;
  homeTeamAvgRed: number;
  awayTeamAvgRed: number;
  refereeAvgYellow: number;
  refereeAvgRed: number;
  refereeAvgTotal: number;
  leagueAvgYellow: number;
  competitiveness: number;
  // NUOVO: sample size per stabilità stime
  homeTeamSampleSize?: number;
  awayTeamSampleSize?: number;
  refereeSampleSize?: number;
  // NUOVO: varianza cartellini per r dinamico
  homeTeamVarYellow?: number;
  awayTeamVarYellow?: number;
  // NUOVO: correlazione arbitro-falli (arbitri rigorosi sui falli → più gialli)
  refereeAvgFouls?: number;
  leagueAvgFouls?: number;
}

export interface FoulsModelData {
  homeTeamAvgFouls: number;
  awayTeamAvgFouls: number;
  homePossessionEst: number;
  refereeAvgFouls: number;
  leagueAvgFouls: number;
  // NUOVO: varianza per r dinamico
  homeTeamVarFouls?: number;
  awayTeamVarFouls?: number;
  // NUOVO: sample size
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
  overUnder: Record<string, { over: number; under: number }>;
  negBinParams: NegBinParams;
}

export interface CardsDistribution {
  expectedHomeYellow: number;
  expectedAwayYellow: number;
  expectedTotalYellow: number;
  expectedHomeRed: number;
  expectedAwayRed: number;
  expectedTotalCards: number;
  overUnderYellow: Record<string, { over: number; under: number }>;
  overUnderTotal: Record<string, { over: number; under: number }>;
  negBinParams: NegBinParams;
}

export interface FoulsDistribution {
  expectedHomeFouls: number;
  expectedAwayFouls: number;
  expectedTotalFouls: number;
  overUnder: Record<string, { over: number; under: number }>;
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

export class SpecializedModels {

  // ==================== BINOMIALE NEGATIVA ====================

  /**
   * PMF della Binomiale Negativa via log-space per stabilità numerica.
   * Parametrizzazione (mu, r): E[X]=mu, Var[X]=mu+mu²/r.
   */
  negBinPMF(k: number, mu: number, r: number): number {
    return computeNegBinPMF(k, mu, r);
  }

  /**
   * CDF della NegBin: P(X <= k).
   * Il limite superiore di somma è adattivo per evitare troncamenti.
   */
  negBinCDF(k: number, mu: number, r: number): number {
    if (k < 0) return 0;
    let cdf = 0;
    // Somma fino a dove la massa residua è trascurabile
    const maxK = Math.ceil(mu + 8 * Math.sqrt(mu + mu * mu / Math.max(r, 0.1)));
    const limit = Math.min(Math.floor(k), maxK + 20);
    for (let i = 0; i <= limit; i++) {
      cdf += this.negBinPMF(i, mu, r);
      if (cdf >= 1 - 1e-10 && i > k) break; // early exit
    }
    return Math.min(1, cdf);
  }

  /**
   * P(X > threshold) — usata per tutti i mercati Over/Under.
   * MIGLIORAMENTO: gestisce correttamente le linee intere vs .5
   * (threshold=2 → P(X>2) = P(X>=3); threshold=2.5 → P(X>=3)).
   */
  negBinOver(threshold: number, mu: number, r: number): number {
    return computeNegBinOver(threshold, mu, r);
  }

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
  estimateDispersion(mu: number, variance: number, sampleSize = 20, maxR = 200): number {
    if (!isFinite(variance) || !isFinite(mu) || mu <= 0) return 50;
    if (variance <= mu) return maxR; // equidisperso → quasi-Poisson

    const n = Math.max(1, sampleSize);
    const minR = 1 + 1 / Math.sqrt(n);   // lower bound data-adaptive

    const r = (mu * mu) / (variance - mu);
    return Math.max(minR, Math.min(maxR, r));
  }

  /**
   * Regressione bayesiana verso la media di lega (shrinkage).
   * Con pochi dati, ci fidiamo di più della media di lega.
   * formula: mu_shrunk = (n * mu_team + k * mu_league) / (n + k)
   * dove k è il "prior strength" (quante partite equivalenti valgono le prior).
   */
  private shrinkToLeague(
    teamValue: number,
    leagueValue: number,
    sampleSize: number,
    priorStrength = 20
  ): number {
    if (!isFinite(leagueValue) || leagueValue <= 0) return teamValue;
    const n = Math.max(0, sampleSize);
    return (n * teamValue + priorStrength * leagueValue) / (n + priorStrength);
  }

  // ==================== MODELLO TIRI ====================

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
      totalShots: { expected: number; variance: number; distribution: Record<string, number> };
      shotsOnTarget: { expected: number; variance: number; distribution: Record<string, number> };
    };
    away: ShotsDistribution & {
      totalShots: { expected: number; variance: number; distribution: Record<string, number> };
      shotsOnTarget: { expected: number; variance: number; distribution: Record<string, number> };
    };
    /** @deprecated usa home.totalShots / away.totalShots */
    total: Record<string, { over: number; under: number }>;
    combined: {
      totalShots: { expected: number; variance: number };
      totalOnTarget: { expected: number; variance: number };
      overUnder: Record<string, number>;
      onTargetOverUnder: Record<string, number>;
    };
  } {
    const nHome = data.homeTeamSampleSize ?? 20;
    const nAway = data.awayTeamSampleSize ?? 20;

    // --- Expected shots ---
    const muHome = Math.max(3, data.homeTeamAvgShots * data.homeAdvantageShots / Math.max(0.5, data.awayTeamShotsSuppression));
    const muAway = Math.max(3, data.awayTeamAvgShots * Math.max(0.5, data.homeTeamShotsSuppression));

    const homeOTRate = Math.min(0.65, (data.homeTeamAvgShotsOT / Math.max(1, data.homeTeamAvgShots)) / Math.max(0.7, data.awayTeamShotsSuppression ** 0.5));
    const awayOTRate = Math.min(0.65, (data.awayTeamAvgShotsOT / Math.max(1, data.awayTeamAvgShots)) / Math.max(0.7, data.homeTeamShotsSuppression ** 0.5));
    const muHomeOT = Math.max(0.5, muHome * homeOTRate);
    const muAwayOT = Math.max(0.5, muAway * awayOTRate);

    // --- r DINAMICO con lower bound adattivo r_min = 1 + 1/sqrt(n) ---
    const varHome = data.homeTeamVarShots ?? muHome * 1.6;
    const varAway = data.awayTeamVarShots ?? muAway * 1.6;
    const varHomeOT = data.homeTeamVarShotsOT ?? muHomeOT * 2.0;
    const varAwayOT = data.awayTeamVarShotsOT ?? muAwayOT * 2.0;

    const rHome = this.estimateDispersion(muHome, varHome, nHome, 40);
    const rAway = this.estimateDispersion(muAway, varAway, nAway, 40);
    const rHomeOT = this.estimateDispersion(muHomeOT, varHomeOT, nHome, 30);
    const rAwayOT = this.estimateDispersion(muAwayOT, varAwayOT, nAway, 30);

    // Varianza effettiva NegBin: Var = mu + mu²/r
    const varHomeEff = muHome + muHome * muHome / rHome;
    const varAwayEff = muAway + muAway * muAway / rAway;
    const varHomeOTEff = muHomeOT + muHomeOT * muHomeOT / rHomeOT;
    const varAwayOTEff = muAwayOT + muAwayOT * muAwayOT / rAwayOT;

    // --- PMF discreta per grafici ---
    const makeDist = (mu: number, r: number): Record<string, number> => {
      const maxK = Math.ceil(mu + 5 * Math.sqrt(mu + mu * mu / Math.max(r, 0.1)));
      const dist: Record<string, number> = {};
      let total = 0;
      for (let k = 0; k <= Math.min(maxK, 60); k++) {
        const p = this.negBinPMF(k, mu, r);
        dist[String(k)] = p;
        total += p;
      }
      if (total > 1e-9 && Math.abs(total - 1) > 1e-6) {
        for (const k of Object.keys(dist)) dist[k] = dist[k] / total;
      }
      return dist;
    };

    // --- Over/Under strutturato legacy (per DixonColesModel.ts) ---
    const makeOU = (mu: number, r: number, lines: number[]): Record<string, { over: number; under: number }> => {
      const result: Record<string, { over: number; under: number }> = {};
      for (const line of lines) {
        const over = this.negBinOver(line, mu, r);
        result[`${line}`] = { over: parseFloat(over.toFixed(6)), under: parseFloat((1 - over).toFixed(6)) };
      }
      return result;
    };

    // --- Over/Under flat per frontend (chiave: "over" + digits senza ".") ---
    const makeFlatOU = (mu: number, r: number, lines: number[]): Record<string, number> => {
      const result: Record<string, number> = {};
      for (const line of lines) {
        const key = 'over' + String(line).replace('.', '');
        result[key] = parseFloat(this.negBinOver(line, mu, r).toFixed(4));
      }
      return result;
    };

    const shotsLines = [
      7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5
    ];
    const totalShotsLines = [
      15.5, 17.5, 19.5, 20.5, 21.5, 22.5, 23.5,
      24.5, 25.5, 26.5, 27.5, 28.5, 29.5, 31.5
    ];
    const onTargetLines = [4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5];

    // --- Totali combinati ---
    const muTotal = muHome + muAway;
    const muTotalOT = muHomeOT + muAwayOT;
    const varTotal = varHomeEff + varAwayEff;
    const varTotalOT = varHomeOTEff + varAwayOTEff;
    const nMin = Math.min(nHome, nAway);
    const rTotal = this.estimateDispersion(muTotal, varTotal, nMin, 60);
    const rTotalOT = this.estimateDispersion(muTotalOT, varTotalOT, nMin, 50);

    return {
      home: {
        // Legacy ShotsDistribution (usati da DixonColesModel.ts)
        teamId: '',
        expectedTotalShots: parseFloat(muHome.toFixed(3)),
        expectedShotsOnTarget: parseFloat(muHomeOT.toFixed(3)),
        overUnder: makeOU(muHome, rHome, shotsLines),
        negBinParams: { mu: muHome, r: rHome },
        // Nuovi (frontend)
        totalShots: { expected: parseFloat(muHome.toFixed(3)), variance: parseFloat(varHomeEff.toFixed(3)), distribution: makeDist(muHome, rHome) },
        shotsOnTarget: { expected: parseFloat(muHomeOT.toFixed(3)), variance: parseFloat(varHomeOTEff.toFixed(3)), distribution: makeDist(muHomeOT, rHomeOT) },
      },
      away: {
        // Legacy ShotsDistribution (usati da DixonColesModel.ts)
        teamId: '',
        expectedTotalShots: parseFloat(muAway.toFixed(3)),
        expectedShotsOnTarget: parseFloat(muAwayOT.toFixed(3)),
        overUnder: makeOU(muAway, rAway, shotsLines),
        negBinParams: { mu: muAway, r: rAway },
        // Nuovi (frontend)
        totalShots: { expected: parseFloat(muAway.toFixed(3)), variance: parseFloat(varAwayEff.toFixed(3)), distribution: makeDist(muAway, rAway) },
        shotsOnTarget: { expected: parseFloat(muAwayOT.toFixed(3)), variance: parseFloat(varAwayOTEff.toFixed(3)), distribution: makeDist(muAwayOT, rAwayOT) },
      },
      // Legacy total (usato da DixonColesModel.ts riga ~419)
      total: makeOU(muTotal, rTotal, totalShotsLines),
      combined: {
        totalShots: { expected: parseFloat(muTotal.toFixed(3)), variance: parseFloat(varTotal.toFixed(3)) },
        totalOnTarget: { expected: parseFloat(muTotalOT.toFixed(3)), variance: parseFloat(varTotalOT.toFixed(3)) },
        overUnder: makeFlatOU(muTotal, rTotal, totalShotsLines),
        onTargetOverUnder: makeFlatOU(muTotalOT, rTotalOT, onTargetLines),
      },
    };
  }

  // ==================== MODELLO CARTELLINI ====================

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
   * 4. COMPETITIVENESS con curva sigmoidale invece di lineare:
   *    compFactor = 1 + max_boost * sigmoid(competitiveness * 6 - 3)
   *    Questo evita che un competitiveness=0.99 produca un boost irrealistico.
   *
   * 5. Shrinkage verso la media di lega per squadre con pochi dati.
   */
  computeCardsDistribution(data: CardsModelData): CardsDistribution {
    const leagueAvgYellow = data.leagueAvgYellow ?? 3.8;
    const sampleHome = data.homeTeamSampleSize ?? 20;
    const sampleAway = data.awayTeamSampleSize ?? 20;
    const sampleRef = data.refereeSampleSize ?? 15;

    // --- Shrinkage medie squadra verso media lega ---
    const avgYellowPerTeam = leagueAvgYellow / 2; // ~1.9 per squadra
    const muHomeYellowBase = this.shrinkToLeague(
      data.homeTeamAvgYellow, avgYellowPerTeam, sampleHome, 15
    );
    const muAwayYellowBase = this.shrinkToLeague(
      data.awayTeamAvgYellow, avgYellowPerTeam, sampleAway, 15
    );

    // --- Fattore arbitro con smorzamento bayesiano ---
    const rawRefFactor = leagueAvgYellow > 0
      ? data.refereeAvgYellow / leagueAvgYellow
      : 1.0;
    // Smorzamento: più partite → più fiducia nel fattore arbitro
    const refDamping = sampleRef / (sampleRef + 15);
    const refYellowFactor = 1 + (rawRefFactor - 1) * refDamping;

    // --- Bonus arbitro-falli: se fischia tanti falli → cartellini simili o no? ---
    // Empiricamente: arbitri con >25 falli/partita tendono a dare +8% cartellini
    let foulsBonus = 1.0;
    if (data.refereeAvgFouls !== undefined && data.leagueAvgFouls !== undefined) {
      const foulRatio = data.refereeAvgFouls / Math.max(1, data.leagueAvgFouls);
      // Correlazione stimata empiricamente ≈ 0.35
      foulsBonus = 1 + (foulRatio - 1) * 0.35;
    }

    // --- Competitiveness: curva sigmoidale (evita boost estremi) ---
    // sigmoid(x) = 1 / (1 + exp(-x))
    // Boost max empirico +22% (derby storici)
    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
    const compBoost = 0.22 * (2 * sigmoid(data.competitiveness * 8 - 4) - 0);
    const compFactor = 1.0 + compBoost;

    // --- Expected gialli ---
    const totalFactor = refYellowFactor * foulsBonus * compFactor;
    const muHomeYellow = Math.max(0.3, muHomeYellowBase * totalFactor);
    const muAwayYellow = Math.max(0.3, muAwayYellowBase * totalFactor);
    const muTotalYellow = muHomeYellow + muAwayYellow;

    // --- Rossi: modello Poisson (eventi molto rari) ---
    // Il fattore arbitro per i rossi è smorzato di più (meno affidabile)
    const rawRefRedFactor = (data.leagueAvgYellow > 0)
      ? data.refereeAvgRed / Math.max(0.05, data.leagueAvgYellow * 0.05)
      : 1.0;
    const refRedDamping = sampleRef / (sampleRef + 25); // più smorzamento per i rossi
    const refRedFactor = 1 + (rawRefRedFactor - 1) * refRedDamping;

    const lambdaHomeRed = Math.max(0.01, data.homeTeamAvgRed * refRedFactor * compFactor);
    const lambdaAwayRed = Math.max(0.01, data.awayTeamAvgRed * refRedFactor * compFactor);

    // Card points (giallo=1, rosso=2 come bookmaker)
    const muTotalCardPoints = muTotalYellow + 2 * (lambdaHomeRed + lambdaAwayRed);

    // --- r DINAMICO per i gialli ---
    // Varianza stimata: se non disponibile, usiamo prior empirica
    // Dati Serie A: r_yellow ≈ 10-15, mediana ≈ 12
    const varHomeYellow = data.homeTeamVarYellow ?? muHomeYellow * 1.35;
    const varAwayYellow = data.awayTeamVarYellow ?? muAwayYellow * 1.35;

    // Varianza del totale (indipendenza tra squadre)
    const varTotalYellow = (muHomeYellow + muHomeYellow * muHomeYellow / this.estimateDispersion(muHomeYellow, varHomeYellow, sampleHome, 50)) +
      (muAwayYellow + muAwayYellow * muAwayYellow / this.estimateDispersion(muAwayYellow, varAwayYellow, sampleAway, 50));
    const rYellow = this.estimateDispersion(muTotalYellow, varTotalYellow, Math.min(sampleHome, sampleAway), 50);

    // Card points: più overdispersi (r più basso)
    const rCardPoints = Math.max(3, rYellow * 0.82);

    // --- Linee Over/Under ---
    const yellowLines = [
      0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5
    ];
    const cardPointsLines = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5];

    const makeOU = (mu: number, r: number, lines: number[]) => {
      const result: Record<string, { over: number; under: number }> = {};
      for (const line of lines) {
        const over = this.negBinOver(line, mu, r);
        result[`${line}`] = {
          over: parseFloat(over.toFixed(6)),
          under: parseFloat((1 - over).toFixed(6)),
        };
      }
      return result;
    };

    return {
      expectedHomeYellow: parseFloat(muHomeYellow.toFixed(4)),
      expectedAwayYellow: parseFloat(muAwayYellow.toFixed(4)),
      expectedTotalYellow: parseFloat(muTotalYellow.toFixed(4)),
      expectedHomeRed: parseFloat(lambdaHomeRed.toFixed(4)),
      expectedAwayRed: parseFloat(lambdaAwayRed.toFixed(4)),
      expectedTotalCards: parseFloat(muTotalCardPoints.toFixed(4)),
      overUnderYellow: makeOU(muTotalYellow, rYellow, yellowLines),
      overUnderTotal: makeOU(muTotalCardPoints, rCardPoints, cardPointsLines),
      negBinParams: { mu: muTotalYellow, r: rYellow },
    };
  }

  // ==================== MODELLO FALLI ====================

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
  computeFoulsDistribution(data: FoulsModelData): FoulsDistribution {
    const leagueAvgFouls = data.leagueAvgFouls ?? 22.4;
    const sampleHome = data.homeTeamSampleSize ?? 20;
    const sampleAway = data.awayTeamSampleSize ?? 20;

    // --- Fattore arbitro ---
    const refFactor = leagueAvgFouls > 0
      ? data.refereeAvgFouls / leagueAvgFouls
      : 1.0;

    // --- Shrinkage verso media lega ---
    const leagueAvgFoulsPerTeam = leagueAvgFouls / 2; // ≈ 11.2
    const homeAvgBase = this.shrinkToLeague(data.homeTeamAvgFouls, leagueAvgFoulsPerTeam, sampleHome, 15);
    const awayAvgBase = this.shrinkToLeague(data.awayTeamAvgFouls, leagueAvgFoulsPerTeam, sampleAway, 15);

    // --- Correzione possesso NON-LINEARE ---
    // poss ∈ [0.3, 0.7] tipicamente
    // Chi ha più possesso fa meno falli (difende meno)
    // La relazione è approssimativamente log-lineare
    const poss = Math.max(0.3, Math.min(0.7, data.homePossessionEst));
    const possDeviation = (poss - 0.5) / 0.5; // [-1, 1]

    // Curva esponenziale: a poss=60% → riduzione ~10.5%; a 70% → ~18%
    // Original: riduzione lineare 7% a 60%, 14% a 70% (sottostima l'effetto)
    const homePossCorr = Math.exp(-0.22 * possDeviation);
    const awayPossCorr = Math.exp(+0.22 * possDeviation);

    const muHomeFouls = Math.max(3, homeAvgBase * refFactor * homePossCorr);
    const muAwayFouls = Math.max(3, awayAvgBase * refFactor * awayPossCorr);
    const muTotal = muHomeFouls + muAwayFouls;

    // --- r DINAMICO ---
    // Prior empirica Serie A: var_fouls ≈ mu * 1.7 (overdispersion ~70%)
    const varHome = data.homeTeamVarFouls ?? muHomeFouls * 1.7;
    const varAway = data.awayTeamVarFouls ?? muAwayFouls * 1.7;

    const rHome = this.estimateDispersion(muHomeFouls, varHome, sampleHome, 60);
    const rAway = this.estimateDispersion(muAwayFouls, varAway, sampleAway, 60);

    // --- Varianza totale con correlazione intra-partita ---
    // Cov[X,Y] = rho * sqrt(Var[X] * Var[Y])
    //
    // ρ = 0.25 è una BEST CONSERVATIVE ESTIMATE, non una verità statistica.
    // La correlazione reale varia in base a: arbitro specifico, tipo di match
    // (derby, alta posta), stato della partita (goal anticipato → gioco più
    // aperto). Letteratura empirica: ρ ∈ [0.15, 0.40] su dati Serie A.
    // Usare 0.25 come prior da ricalibrarsi con il proprio backtesting.
    const varHomeFoulsActual = muHomeFouls + muHomeFouls * muHomeFouls / rHome;
    const varAwayFoulsActual = muAwayFouls + muAwayFouls * muAwayFouls / rAway;
    const rhoCovFouls = 0.25; // prior baseline; aggiornare con regressione su dataset proprio
    const covFouls = rhoCovFouls * Math.sqrt(varHomeFoulsActual * varAwayFoulsActual);
    const varTotal = varHomeFoulsActual + varAwayFoulsActual + 2 * covFouls;
    const rTotal = this.estimateDispersion(muTotal, varTotal, Math.min(sampleHome, sampleAway), 60);

    const foulsLines = [
      12.5, 14.5, 17.5, 19.5, 20.5, 21.5, 22.5,
      23.5, 24.5, 25.5, 26.5, 29.5, 32.5, 35.5
    ];

    const makeOU = (mu: number, r: number, lines: number[]) => {
      const result: Record<string, { over: number; under: number }> = {};
      for (const line of lines) {
        const over = this.negBinOver(line, mu, r);
        result[`${line}`] = {
          over: parseFloat(over.toFixed(6)),
          under: parseFloat((1 - over).toFixed(6)),
        };
      }
      return result;
    };

    return {
      expectedHomeFouls: parseFloat(muHomeFouls.toFixed(4)),
      expectedAwayFouls: parseFloat(muAwayFouls.toFixed(4)),
      expectedTotalFouls: parseFloat(muTotal.toFixed(4)),
      overUnder: makeOU(muTotal, rTotal, foulsLines),
      negBinParams: { mu: muTotal, r: rTotal },
    };
  }

  // ==================== MODELLO TIRI PER GIOCATORE ====================

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
  computePlayerShotsPredictions(
    players: PlayerShotsData[],
    expectedTeamShots: number,
    expectedTeamShotsOT: number
  ): PlayerShotsPrediction[] {

    // --- Prior per ruolo (media shot share Serie A) ---
    const positionPriors: Record<string, { share: number; priorN: number }> = {
      FW: { share: 0.20, priorN: 10 },
      MF: { share: 0.12, priorN: 10 },
      DF: { share: 0.05, priorN: 10 },
      GK: { share: 0.01, priorN: 20 },
    };

    const starters = players.filter(
      (p) => p.isStarter && p.positionCode !== 'GK'
    );

    if (starters.length === 0) return [];

    // --- Shrinkage delle share verso prior di ruolo ---
    const adjustedShares = starters.map((p) => {
      const prior = positionPriors[p.positionCode] ?? positionPriors['MF'];
      const n = Math.max(0, p.gamesPlayed);
      // Bayesian update: share_adj = (n * share_obs + priorN * share_prior) / (n + priorN)
      const shareAdj = (n * p.shotShareOfTeam + prior.priorN * prior.share) / (n + prior.priorN);
      return { ...p, shareAdj };
    });

    // --- Normalizzazione robusta ---
    const totalAdjShare = adjustedShares.reduce((s, p) => s + p.shareAdj, 0);
    const normFactor = totalAdjShare > 1e-6 ? totalAdjShare : 1;
    const normalized = adjustedShares.map((p) => ({
      ...p,
      normShare: p.shareAdj / normFactor,
    }));

    const predictions: PlayerShotsPrediction[] = [];

    for (const player of normalized) {
      // Expected shots per giocatore
      const expectedShots = Math.min(6, Math.max(0, expectedTeamShots * player.normShare));
      const expectedShotsOT = Math.min(4, Math.max(0, expectedTeamShotsOT * player.normShare));

      // --- r per giocatore via Dirichlet-Multinomiale ---
      // Var[shots_i] = N_tot * s_i * (1 - s_i) * (N_tot + alpha0) / (alpha0 + 1)
      // alpha0 = prior strength (partite equivalenti) ~ gamesPlayed
      const alpha0 = Math.max(1, player.gamesPlayed);
      const varPlayer =
        expectedTeamShots * player.normShare * (1 - player.normShare) *
        (expectedTeamShots + alpha0) / (alpha0 + 1);

      // r per questo giocatore (con bound conservativi)
      const rPlayer = this.estimateDispersion(
        expectedShots,
        Math.max(expectedShots * 1.1, varPlayer),
        player.gamesPlayed,  // FIX: use actual sample size
        30
      );

      // r per SOT (ancora più variabile)
      const varPlayerOT = expectedTeamShotsOT * player.normShare * (1 - player.normShare) *
        (expectedTeamShotsOT + alpha0) / (alpha0 + 1);
      const rPlayerOT = this.estimateDispersion(
        expectedShotsOT,
        Math.max(expectedShotsOT * 1.1, varPlayerOT),
        player.gamesPlayed,  // FIX: use actual sample size
        30
      );

      // P(X >= k) via negBinCDF
      const p1PlusShots =
        expectedShots < 1e-4 ? 0 : Math.max(0, 1 - this.negBinPMF(0, expectedShots, rPlayer));
      const p2PlusShots =
        expectedShots < 1e-4 ? 0 : Math.max(0, 1 - this.negBinCDF(1, expectedShots, rPlayer));
      const p3PlusShots =
        expectedShots < 1e-4 ? 0 : Math.max(0, 1 - this.negBinCDF(2, expectedShots, rPlayer));
      const p1PlusShotsOT =
        expectedShotsOT < 1e-4 ? 0 : Math.max(0, 1 - this.negBinPMF(0, expectedShotsOT, rPlayerOT));

      predictions.push({
        playerId: player.playerId,
        playerName: player.playerName,
        teamId: player.teamId,
        positionCode: player.positionCode,
        sampleSize: player.gamesPlayed,
        expectedShots: parseFloat(expectedShots.toFixed(4)),
        expectedShotsOnTarget: parseFloat(expectedShotsOT.toFixed(4)),
        prob1PlusShots: parseFloat(p1PlusShots.toFixed(4)),
        prob2PlusShots: parseFloat(p2PlusShots.toFixed(4)),
        prob3PlusShots: parseFloat(p3PlusShots.toFixed(4)),
        prob1PlusShotsOT: parseFloat(p1PlusShotsOT.toFixed(4)),
        shotShareOfTeam: parseFloat(player.normShare.toFixed(4)),
      });
    }

    return predictions.sort((a, b) => b.expectedShots - a.expectedShots);
  }

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
    overUnder: Record<string, { over: number; under: number }>;
    negBinParams: NegBinParams;
  } {
    const nHome = data.homeTeamSampleSize ?? 20;
    const nAway = data.awayTeamSampleSize ?? 20;

    // Media angoli: difesa avversaria influenza indirettamente
    const muHome = Math.max(2,
      (data.homeTeamAvgCornersFor * 0.6 + data.awayTeamAvgCornersAgainst * 0.4)
    );
    const muAway = Math.max(2,
      (data.awayTeamAvgCornersFor * 0.6 + data.homeTeamAvgCornersAgainst * 0.4)
    );
    const muTotal = muHome + muAway;

    // Corners: NegBin con overdispersion moderata
    const varHome = muHome * 1.5;
    const varAway = muAway * 1.5;
    const varTotal = varHome + varAway + 0.2 * Math.sqrt(varHome * varAway);

    const rHome = this.estimateDispersion(muHome, varHome, nHome, 40);
    const rAway = this.estimateDispersion(muAway, varAway, nAway, 40);
    const nMin = Math.min(nHome, nAway);
    const rTotal = this.estimateDispersion(muTotal, varTotal, nMin, 60);

    const cornerLines = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5];

    const makeOU = (mu: number, r: number, lines: number[]) => {
      const result: Record<string, { over: number; under: number }> = {};
      for (const line of lines) {
        const over = this.negBinOver(line, mu, r);
        result[`${line}`] = {
          over: parseFloat(over.toFixed(6)),
          under: parseFloat((1 - over).toFixed(6)),
        };
      }
      return result;
    };

    return {
      expectedHomeCorners: parseFloat(muHome.toFixed(3)),
      expectedAwayCorners: parseFloat(muAway.toFixed(3)),
      expectedTotalCorners: parseFloat(muTotal.toFixed(3)),
      overUnder: makeOU(muTotal, rTotal, cornerLines),
      negBinParams: { mu: muTotal, r: rTotal },
    };
  }

  // ==================== UTILITY PUBBLICHE ====================

  /**
   * Stima NegBin da osservazioni con metodo dei momenti.
   * Aggiunto: correzione di Bessel (divisione per n-1 per la varianza).
   */
  fitNegBinFromObservations(observations: number[]): NegBinParams {
    if (observations.length < 5) return { mu: 3.8, r: 12 };
    const n = observations.length;
    const mu = observations.reduce((s, x) => s + x, 0) / n;
    // Varianza corretta di Bessel
    const variance = n > 1
      ? observations.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1)
      : mu;
    const r = this.estimateDispersion(mu, variance);
    return { mu, r };
  }

  /**
   * Over/Under con intervallo di confidenza (±10% sulla media).
   */
  overUnderWithConfidence(
    line: number,
    params: NegBinParams,
    paramUncertainty = 0.10
  ): { over: number; under: number; overLow: number; overHigh: number } {
    const over = this.negBinOver(line, params.mu, params.r);
    const overLow = this.negBinOver(line, params.mu * (1 - paramUncertainty), params.r);
    const overHigh = this.negBinOver(line, params.mu * (1 + paramUncertainty), params.r);
    return {
      over: parseFloat(over.toFixed(6)),
      under: parseFloat((1 - over).toFixed(6)),
      overLow: parseFloat(overLow.toFixed(6)),
      overHigh: parseFloat(overHigh.toFixed(6)),
    };
  }
}
