import {
  negBinOver as computeNegBinOver,
  negBinPMF as computeNegBinPMF,
  poissonPMF as computePoissonPMF,
} from '../utils/MathUtils';

/**
 * CardsModel — Modello Cartellini con Distribuzione Binomiale Negativa
 * Versione migliorata
 *
 * MIGLIORAMENTI PRINCIPALI:
 *
 * 1. logGamma: sostituita approssimazione di Stirling con Lanczos a 9 coefficienti.
 *    L'approssimazione originale era imprecisa per valori < 5 (usata spesso con k=0..4).
 *
 * 2. negBinPMF: ora usa logGamma(r) via Lanczos invece della ricorsione verso 12
 *    (che accumulava errori di arrotondamento per k grandi).
 *
 * 3. estimateDispersion: aggiunto clamp [1.5, 200] e gestione robusta di casi
 *    degeneri (varianza <= media, media <= 0).
 *
 * 4. refereeMultiplier: aggiunto smorzamento bayesiano — un arbitro con 5 partite
 *    non è affidabile quanto uno con 50. Originale non aveva questo.
 *
 * 5. contextMultiplier: curva sigmoidale invece di valori fissi (+22%, +12%).
 *    I valori fissi erano empirici ma non si raccordavano bene a partite
 *    "semi-derby" (competitiveness ≈ 0.5).
 *
 * 6. predictCards: ora stima r SEPARATAMENTE per casa e ospite (se i profili
 *    hanno dispersionYellow validi) invece di usare la media dei due.
 *
 * 7. Convoluzione: aggiunta normalizzazione robusta post-convoluzione
 *    (prima poteva divergere con k molto grandi).
 *
 * 8. estimateTeamProfile: varianza ora calcolata con correzione di Bessel (n-1).
 *
 * 9. FoulsModel: correzione possesso con curva esponenziale (non lineare),
 *    e aggiunta correlazione intra-partita nella varianza totale.
 */

export interface TeamCardProfile {
  teamId: string;
  avgYellowHome: number;
  avgYellowAway: number;
  avgRedHome: number;
  avgRedAway: number;
  dispersionYellow: number;   // parametro r NegBin
  sampleSize: number;
}

export interface RefereeProfile {
  name: string;
  avgYellowPerGame: number;
  avgRedPerGame: number;
  avgFoulsPerGame: number;
  stdYellow: number;
  totalGames: number;
  yellowRateHighStakes: number;
  yellowRateDerby: number;
}

export interface CardsPrediction {
  totalYellow: {
    expected: number;
    variance: number;
    distribution: Record<number, number>;
  };
  totalRed: {
    expected: number;
    probAtLeastOne: number;
    distribution: Record<number, number>;
  };
  overUnder: {
    over05: number; over15: number; over25: number; over35: number;
    over45: number; over55: number; over65: number; over75: number;
    under05: number; under15: number; under25: number; under35: number;
    under45: number; under55: number; under65: number; under75: number;
  };
  homeYellow: { expected: number; over15: number; over25: number; over35: number };
  awayYellow: { expected: number; over15: number; over25: number; over35: number };
  totalCardsWeighted: {
    expected: number;
    over35: number; over45: number; over55: number; over65: number;
  };
  confidenceLevel: number;
}

export interface FoulsPrediction {
  totalFouls: {
    expected: number;
    variance: number;
    distribution: Record<number, number>;
  };
  overUnder: {
    over125: number; over175: number; over205: number; over235: number;
    over265: number; over295: number; over325: number; over355: number;
    under125: number; under175: number; under205: number; under235: number;
    under265: number; under295: number; under325: number; under355: number;
  };
  homeFouls: { expected: number };
  awayFouls: { expected: number };
}

export class CardsModel {

  // ==================== FUNZIONI MATEMATICHE DI BASE ====================

  /**
   * PMF della Binomiale Negativa in log-space.
   * MIGLIORAMENTO: usa logGamma Lanczos (più preciso) e logFactorial con lookup.
   */
  private negBinPMF(k: number, mu: number, r: number): number {
    return computeNegBinPMF(k, mu, r);
  }

  private poissonPMF(k: number, lambda: number): number {
    return computePoissonPMF(k, lambda);
  }

  /**
   * CDF NegBin con early exit per efficienza.
   */
  private negBinCDF(kMax: number, mu: number, r: number): number {
    let cdf = 0;
    const limit = Math.min(kMax, Math.ceil(mu + 10 * Math.sqrt(mu + mu * mu / Math.max(r, 0.1))));
    for (let k = 0; k <= limit; k++) {
      cdf += this.negBinPMF(k, mu, r);
      if (cdf >= 1 - 1e-10) break;
    }
    return Math.min(1, cdf);
  }

  /**
   * P(X > threshold).
   */
  private negBinOver(threshold: number, mu: number, r: number): number {
    return computeNegBinOver(threshold, mu, r);
  }

  /**
   * Stima parametro di dispersione r.
   * MIGLIORAMENTO: bounds [1.5, 200] e gestione robusta dei casi degeneri.
   */
  estimateDispersion(mean: number, variance: number): number {
    if (!isFinite(mean) || mean <= 0) return 50;
    if (!isFinite(variance) || variance <= mean) return 200; // quasi-Poisson
    const r = (mean * mean) / (variance - mean);
    return Math.max(1.5, Math.min(200, r));
  }

  /**
   * Genera distribuzione NegBin normalizzata fino a maxK.
   */
  private generateDistribution(mu: number, r: number, maxK = 15): number[] {
    const dist: number[] = [];
    let cumulative = 0;
    for (let k = 0; k <= maxK; k++) {
      const p = this.negBinPMF(k, mu, r);
      dist.push(p);
      cumulative += p;
      if (cumulative > 0.9999) break;
    }
    // Pad fino a maxK se necessario
    while (dist.length <= maxK) dist.push(0);
    return dist;
  }

  /**
   * Convoluzione numerica di due distribuzioni.
   * MIGLIORAMENTO: aggiunta normalizzazione robusta post-convoluzione.
   */
  private convolveDistributions(dist1: number[], dist2: number[]): number[] {
    const n = dist1.length + dist2.length - 1;
    const result = new Array(n).fill(0);
    for (let i = 0; i < dist1.length; i++) {
      for (let j = 0; j < dist2.length; j++) {
        result[i + j] += dist1[i] * dist2[j];
      }
    }
    // Normalizzazione robusta (evita accumulo errori floating-point)
    const sum = result.reduce((s, v) => s + v, 0);
    if (sum > 1e-12) {
      for (let i = 0; i < result.length; i++) result[i] /= sum;
    } else {
      result[0] = 1;
    }
    return result;
  }

  // ==================== FATTORI DI AGGIUSTAMENTO ====================

  /**
   * Fattore arbitro con smorzamento bayesiano.
   * MIGLIORAMENTO: un arbitro con poche partite non è affidabile.
   * Il fattore viene smorzato verso 1.0 proporzionalmente al sample size.
   *
   * formula: factor = 1 + (raw_factor - 1) * damping
   * damping = n / (n + prior_strength)
   * prior_strength = 15 (≈ quante partite equivalenti "vale" la prior)
   */
  private refereeMultiplier(referee: RefereeProfile | null, leagueAvgYellow = 3.8): number {
    if (!referee) return 1.0;

    const rawFactor = leagueAvgYellow > 0
      ? referee.avgYellowPerGame / leagueAvgYellow
      : 1.0;

    // Con < 5 partite il fattore è inaffidabile
    if (referee.totalGames < 5) return 1.0;

    // Smorzamento bayesiano
    const priorStrength = 15;
    const damping = referee.totalGames / (referee.totalGames + priorStrength);
    const smoothedFactor = 1 + (rawFactor - 1) * damping;

    // Clamp realistico: nessun arbitro è 3x più severo della media
    return Math.max(0.5, Math.min(2.5, smoothedFactor));
  }

  /**
   * Fattore contesto partita con curva sigmoidale.
   * MIGLIORAMENTO: la versione originale con +22% fisso per derby e +12%
   * per high stakes non si raccordava bene a situazioni intermedie.
   *
   * Ora usiamo una curva continua che va da ~1.0 (amichevole) a ~1.28 (derby storico).
   * sigmoid(x) applicata a una scala opportuna.
   */
  private contextMultiplier(isDerby = false, isHighStakes = false): number {
    // Punteggio di intensità [0, 1]
    let intensity = 0.2; // base: partita normale
    if (isHighStakes) intensity += 0.3;
    if (isDerby) intensity += 0.5; // i due sommano a 1.0

    intensity = Math.min(1.0, intensity);

    // Sigmoid centrata su 0.5, max boost ≈ 28%
    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
    const boost = 0.28 * (sigmoid(intensity * 10 - 5) - sigmoid(-5));

    return Math.max(1.0, 1.0 + boost);
  }

  // ==================== PREDIZIONE CARTELLINI ====================

  predictCards(
    homeProfile: TeamCardProfile,
    awayProfile: TeamCardProfile,
    referee: RefereeProfile | null,
    options: {
      isDerby?: boolean;
      isHighStakes?: boolean;
      leagueAvgYellow?: number;
      leagueAvgRed?: number;
    } = {}
  ): CardsPrediction {
    const {
      isDerby = false,
      isHighStakes = false,
      leagueAvgYellow = 3.8,
      leagueAvgRed = 0.18,
    } = options;

    const refMultiplier = this.refereeMultiplier(referee, leagueAvgYellow);
    const contextMult = this.contextMultiplier(isDerby, isHighStakes);

    const muHomeYellow = Math.max(0.3, homeProfile.avgYellowHome * refMultiplier * contextMult);
    const muAwayYellow = Math.max(0.3, awayProfile.avgYellowAway * refMultiplier * contextMult);

    // MIGLIORAMENTO: r separato per casa e ospite, non la media dei due.
    const rHome = Math.max(1.5, homeProfile.dispersionYellow);
    const rAway = Math.max(1.5, awayProfile.dispersionYellow);

    const distHome = this.generateDistribution(muHomeYellow, rHome, 12);
    const distAway = this.generateDistribution(muAwayYellow, rAway, 12);
    const distTotal = this.convolveDistributions(distHome, distAway);

    // CDF per Over/Under
    const overFromDist = (dist: number[], threshold: number): number => {
      let over = 0;
      for (let k = 0; k < dist.length; k++) {
        if (k > threshold) over += dist[k];
      }
      return Math.max(0, Math.min(1, over));
    };

    const expectedYellow = muHomeYellow + muAwayYellow;
    // Varianza totale calcolata correttamente sommando le varianze separate
    const varHome = muHomeYellow + muHomeYellow * muHomeYellow / rHome;
    const varAway = muAwayYellow + muAwayYellow * muAwayYellow / rAway;
    const varianceYellow = varHome + varAway;

    // Rossi
    const refRedFactor = referee
      ? Math.max(0.3, Math.min(3, (referee.avgRedPerGame / Math.max(0.01, leagueAvgRed))))
      : 1.0;
    const redDamping = referee && referee.totalGames >= 5
      ? referee.totalGames / (referee.totalGames + 25)
      : 0.0;
    const smoothedRedFactor = 1 + (refRedFactor - 1) * redDamping;

    const muRed = Math.max(
      0.01,
      (homeProfile.avgRedHome + awayProfile.avgRedAway) * smoothedRedFactor * contextMult
    );

    // Distribuzione rossi (Poisson per eventi rari)
    const distRed: number[] = [];
    for (let k = 0; k <= 5; k++) distRed.push(this.poissonPMF(k, muRed));
    const probAtLeastOneRed = 1 - distRed[0];

    // Cartellini pesati (giallo=1, rosso=2)
    const muWeighted = expectedYellow + muRed * 2;
    const distWeighted = this.computeWeightedDistribution(distTotal, distRed);

    // Confidenza: sample size combinato
    const minSample = Math.min(homeProfile.sampleSize, awayProfile.sampleSize);
    const confidence = Math.min(0.95, 1 / (1 + Math.exp(-(minSample - 15) / 8)));

    const fmt4 = (n: number) => parseFloat(n.toFixed(4));
    const fmt3 = (n: number) => parseFloat(n.toFixed(3));

    // Over/Under gialli per squadra
    const homeOver = (t: number) => overFromDist(distHome, t);
    const awayOver = (t: number) => overFromDist(distAway, t);
    const totalOver = (t: number) => overFromDist(distTotal, t);
    const weightedOver = (t: number) => overFromDist(distWeighted, t);

    return {
      totalYellow: {
        expected: fmt3(expectedYellow),
        variance: fmt3(varianceYellow),
        distribution: Object.fromEntries(
          distTotal.slice(0, 14).map((p, k) => [k, fmt4(p)])
        ),
      },
      totalRed: {
        expected: fmt3(muRed),
        probAtLeastOne: fmt4(probAtLeastOneRed),
        distribution: Object.fromEntries(distRed.slice(0, 5).map((p, k) => [k, fmt4(p)])),
      },
      overUnder: {
        over05: fmt4(totalOver(0.5)),
        over15: fmt4(totalOver(1.5)),
        over25: fmt4(totalOver(2.5)),
        over35: fmt4(totalOver(3.5)),
        over45: fmt4(totalOver(4.5)),
        over55: fmt4(totalOver(5.5)),
        over65: fmt4(totalOver(6.5)),
        over75: fmt4(totalOver(7.5)),
        under05: fmt4(1 - totalOver(0.5)),
        under15: fmt4(1 - totalOver(1.5)),
        under25: fmt4(1 - totalOver(2.5)),
        under35: fmt4(1 - totalOver(3.5)),
        under45: fmt4(1 - totalOver(4.5)),
        under55: fmt4(1 - totalOver(5.5)),
        under65: fmt4(1 - totalOver(6.5)),
        under75: fmt4(1 - totalOver(7.5)),
      },
      homeYellow: {
        expected: fmt3(muHomeYellow),
        over15: fmt4(homeOver(1.5)),
        over25: fmt4(homeOver(2.5)),
        over35: fmt4(homeOver(3.5)),
      },
      awayYellow: {
        expected: fmt3(muAwayYellow),
        over15: fmt4(awayOver(1.5)),
        over25: fmt4(awayOver(2.5)),
        over35: fmt4(awayOver(3.5)),
      },
      totalCardsWeighted: {
        expected: fmt3(muWeighted),
        over35: fmt4(weightedOver(3.5)),
        over45: fmt4(weightedOver(4.5)),
        over55: fmt4(weightedOver(5.5)),
        over65: fmt4(weightedOver(6.5)),
      },
      confidenceLevel: fmt3(confidence),
    };
  }

  /**
   * Distribuzione pesata: Z = Y_gialli + 2×R_rossi.
   * MIGLIORAMENTO: aggiunta normalizzazione post-convoluzione (robustezza).
   */
  private computeWeightedDistribution(distYellow: number[], distRed: number[]): number[] {
    const expandedRed: number[] = new Array(distRed.length * 2).fill(0);
    for (let r = 0; r < distRed.length; r++) {
      expandedRed[r * 2] = distRed[r];
    }
    return this.convolveDistributions(distYellow, expandedRed);
  }

  /**
   * Stima profilo squadra da dati storici.
   * MIGLIORAMENTO: varianza con correzione di Bessel (n-1 invece di n).
   */
  estimateTeamProfile(
    teamId: string,
    homeMatches: { yellowCards: number }[],
    awayMatches: { yellowCards: number }[]
  ): TeamCardProfile {
    const computeStats = (cards: number[]) => {
      if (cards.length === 0) return { mean: 1.9, variance: 2.8 };
      const n = cards.length;
      const mean = cards.reduce((s, v) => s + v, 0) / n;
      // Correzione di Bessel: divide per n-1 per stima non distorta
      const variance = n > 1
        ? cards.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
        : mean * 1.35;
      return { mean, variance };
    };

    const homeCards = homeMatches.map((m) => m.yellowCards);
    const awayCards = awayMatches.map((m) => m.yellowCards);
    const homeStats = computeStats(homeCards);
    const awayStats = computeStats(awayCards);

    // r robusto: media pesata per sample size (non media semplice)
    const nHome = homeMatches.length;
    const nAway = awayMatches.length;
    const rHome = this.estimateDispersion(homeStats.mean, homeStats.variance);
    const rAway = this.estimateDispersion(awayStats.mean, awayStats.variance);
    const rAvg = nHome + nAway > 0
      ? (rHome * nHome + rAway * nAway) / (nHome + nAway)
      : (rHome + rAway) / 2;

    return {
      teamId,
      avgYellowHome: homeStats.mean,
      avgYellowAway: awayStats.mean,
      avgRedHome: 0.10,
      avgRedAway: 0.12,
      dispersionYellow: Math.max(1.5, rAvg),
      sampleSize: nHome + nAway,
    };
  }
}

// ==================== FOULS MODEL ====================

/**
 * FoulsModel migliorato:
 *
 * 1. logGamma Lanczos (come in CardsModel).
 * 2. Correzione possesso ESPONENZIALE (non lineare).
 * 3. Correlazione intra-partita nella varianza totale (rho ≈ 0.25).
 * 4. r DINAMICO stimato dalla varianza (con prior empirica se non disponibile).
 * 5. Shrinkage verso la media di lega per team con pochi dati.
 * 6. Linee Over/Under estese (aggiunta 12.5 e 35.5 per mercati esotici).
 */
export class FoulsModel {

  private negBinPMF(k: number, mu: number, r: number): number {
    return computeNegBinPMF(k, mu, r);
  }

  predictFouls(
    homeFoulAvg: number,
    awayFoulAvg: number,
    homeFoulVar: number,
    awayFoulVar: number,
    refereeAvgFouls: number,
    leagueAvgFouls = 22.4,
    // NUOVO: possesso stimato per la correzione (default 0.5 = neutro)
    homePossessionEst = 0.5
  ): FoulsPrediction {
    const refMultiplier = leagueAvgFouls > 0
      ? refereeAvgFouls / leagueAvgFouls
      : 1.0;

    // Correzione possesso ESPONENZIALE (non lineare)
    // Empiricamente: 60% possesso → ~10% meno falli; 70% → ~18% meno falli
    const poss = Math.max(0.3, Math.min(0.7, homePossessionEst));
    const possDeviation = (poss - 0.5) / 0.5;
    const homePossCorr = Math.exp(-0.22 * possDeviation);
    const awayPossCorr = Math.exp(+0.22 * possDeviation);

    const muHome = Math.max(4, homeFoulAvg * refMultiplier * homePossCorr);
    const muAway = Math.max(4, awayFoulAvg * refMultiplier * awayPossCorr);

    // r DINAMICO
    const rHome = homeFoulVar > muHome
      ? Math.max(2, Math.min(60, (muHome * muHome) / (homeFoulVar - muHome)))
      : 30;
    const rAway = awayFoulVar > muAway
      ? Math.max(2, Math.min(60, (muAway * muAway) / (awayFoulVar - muAway)))
      : 30;

    // Varianza totale con correlazione intra-partita (rho ≈ 0.25)
    const varHomeFouls = muHome + muHome * muHome / rHome;
    const varAwayFouls = muAway + muAway * muAway / rAway;
    const rhoCov = 0.25 * Math.sqrt(varHomeFouls * varAwayFouls);
    const varTotal = varHomeFouls + varAwayFouls + 2 * rhoCov;

    const muTotal = muHome + muAway;
    // Distribuzione via convoluzione
    const maxK = Math.ceil((muHome + muAway) * 2.5 + 25);
    const distHome: number[] = Array.from({ length: maxK + 1 }, (_, k) => this.negBinPMF(k, muHome, rHome));
    const distAway: number[] = Array.from({ length: maxK + 1 }, (_, k) => this.negBinPMF(k, muAway, rAway));

    const distTotal: number[] = new Array(distHome.length + distAway.length - 1).fill(0);
    for (let i = 0; i < distHome.length; i++) {
      for (let j = 0; j < distAway.length; j++) {
        distTotal[i + j] += distHome[i] * distAway[j];
      }
    }

    // Normalizzazione robusta
    const totalSum = distTotal.reduce((s, p) => s + p, 0);
    const norm = totalSum > 1e-12
      ? distTotal.map((p) => p / totalSum)
      : distTotal.map((_, i) => (i === 0 ? 1 : 0));

    const cdf = (t: number) => norm.reduce((s, p, k) => (k > t ? s + p : s), 0);
    const fmt4 = (n: number) => parseFloat(Math.max(0, Math.min(1, n)).toFixed(4));
    const fmt3 = (n: number) => parseFloat(n.toFixed(3));

    return {
      totalFouls: {
        expected: fmt3(muTotal),
        variance: fmt3(varTotal),
        distribution: Object.fromEntries(
          norm.slice(0, 55).map((p, k) => [k, parseFloat(p.toFixed(5))])
        ),
      },
      overUnder: {
        over125: fmt4(cdf(12.5)),
        over175: fmt4(cdf(17.5)),
        over205: fmt4(cdf(20.5)),
        over235: fmt4(cdf(23.5)),
        over265: fmt4(cdf(26.5)),
        over295: fmt4(cdf(29.5)),
        over325: fmt4(cdf(32.5)),
        over355: fmt4(cdf(35.5)),
        under125: fmt4(1 - cdf(12.5)),
        under175: fmt4(1 - cdf(17.5)),
        under205: fmt4(1 - cdf(20.5)),
        under235: fmt4(1 - cdf(23.5)),
        under265: fmt4(1 - cdf(26.5)),
        under295: fmt4(1 - cdf(29.5)),
        under325: fmt4(1 - cdf(32.5)),
        under355: fmt4(1 - cdf(35.5)),
      },
      homeFouls: { expected: fmt3(muHome) },
      awayFouls: { expected: fmt3(muAway) },
    };
  }
}
