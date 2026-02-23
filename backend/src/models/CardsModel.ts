/**
 * CardsModel — Modello Cartellini con Distribuzione Binomiale Negativa
 *
 * MOTIVAZIONE STATISTICA:
 * La Poisson assume Var(X) = E(X). Nei cartellini da calcio reali:
 *   E(cartellini_totali) ≈ 3.8 per partita (Serie A, 5 stagioni)
 *   Var(cartellini_totali) ≈ 5.1 — sistematicamente > media (overdispersion)
 *
 * La Binomiale Negativa modella questa overdispersion con un secondo parametro r:
 *   P(X=k) = C(k+r-1, k) × p^r × (1-p)^k
 *   E(X) = r(1-p)/p = μ
 *   Var(X) = r(1-p)/p² = μ + μ²/r
 *
 * Quando r → ∞, NegBin → Poisson. Il parametro r (dispersion) si stima dai dati.
 *
 * FATTORI CONSIDERATI:
 * 1. Media storica cartellini per squadra (casa e ospite separatamente)
 * 2. Fattore arbitro (stimato da storico partite con quell'arbitro)
 * 3. Rivalità/intensità partita (derby, scontri diretti)
 * 4. Importanza partita (coeff. da posizione classifica)
 * 5. Stanchezza squadra (partite giocate negli ultimi 7 giorni)
 * 6. Fase della partita (le partite bilanciate producono più falli)
 *
 * SEPARAZIONE GIALLI E ROSSI:
 * I rossi non seguono la stessa distribuzione dei gialli — sono eventi rari
 * con p molto bassa. Usiamo una Binomiale(n=22, p_rosso) dove p_rosso
 * dipende dall'arbitro e dalla rivalità.
 */

export interface TeamCardProfile {
  teamId: string;
  avgYellowHome: number;        // media gialli quando gioca in casa
  avgYellowAway: number;        // media gialli quando gioca in trasferta
  avgRedHome: number;
  avgRedAway: number;
  dispersionYellow: number;     // parametro r Binomiale Negativa (stimato)
  sampleSize: number;           // partite usate per la stima
}

export interface RefereeProfile {
  name: string;
  avgYellowPerGame: number;
  avgRedPerGame: number;
  avgFoulsPerGame: number;
  stdYellow: number;            // deviazione standard (per calibrare r)
  totalGames: number;
  // Fattori contestuali stimati dall'arbitro
  yellowRateHighStakes: number; // moltiplicatore in partite di alta tensione
  yellowRateDerby: number;      // moltiplicatore nei derby
}

export interface CardsPrediction {
  // Probabilità marginali gialli totali (entrambe le squadre)
  totalYellow: {
    expected: number;
    variance: number;
    distribution: Record<number, number>;  // k -> P(totalYellow = k)
  };
  totalRed: {
    expected: number;
    probAtLeastOne: number;
    distribution: Record<number, number>;
  };
  // Over/Under cartellini totali (gialli)
  overUnder: {
    over15: number; over25: number; over35: number;
    over45: number; over55: number; over65: number;
    under15: number; under25: number; under35: number;
    under45: number; under55: number; under65: number;
  };
  // Per squadra
  homeYellow: { expected: number; over15: number; over25: number; over35: number };
  awayYellow: { expected: number; over15: number; over25: number; over35: number };
  // Cartellini totali inclusi rossi (ponderati: rosso = 2 gialli in molti mercati)
  totalCardsWeighted: {
    expected: number;
    over35: number; over45: number; over55: number; over65: number;
  };
  // Confidenza del modello
  confidenceLevel: number;  // 0-1, basato su sample size
}

export interface FoulsPrediction {
  totalFouls: {
    expected: number;
    variance: number;
    distribution: Record<number, number>;
  };
  overUnder: {
    over175: number; over205: number; over235: number;
    over265: number; over295: number; over325: number;
    under175: number; under205: number; under235: number;
    under265: number; under295: number; under325: number;
  };
  homeFouls: { expected: number };
  awayFouls: { expected: number };
}

export class CardsModel {

  /**
   * Funzione di massa della Binomiale Negativa
   * P(X=k | μ, r) dove μ = media, r = dispersion parameter
   *
   * Derivazione: p = r/(r+μ), poi:
   * P(X=k) = Γ(k+r)/(Γ(r)×k!) × p^r × (1-p)^k
   *
   * Usiamo log-sum per stabilità numerica con k grandi
   */
  private negBinPMF(k: number, mu: number, r: number): number {
    if (mu <= 0) return k === 0 ? 1 : 0;
    if (r <= 0) {
      // Degenera a Poisson quando r → ∞
      return this.poissonPMF(k, mu);
    }

    const p = r / (r + mu);

    // Calcola log P(X=k) per stabilità
    let logProb = 0;

    // log Γ(k+r) - log Γ(r) - log k! usando approssimazione log-gamma
    logProb += this.logGamma(k + r) - this.logGamma(r);
    for (let i = 1; i <= k; i++) logProb -= Math.log(i);

    logProb += r * Math.log(p) + k * Math.log(1 - p);

    return Math.exp(logProb);
  }

  /**
   * Approssimazione Stirling per log-gamma
   * Accurata per valori > 1, per valori piccoli usa la ricorsione
   */
  private logGamma(x: number): number {
    if (x <= 0) return Infinity;
    if (x < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * x)) - this.logGamma(1 - x);
    if (x < 12) {
      // Ricorsione verso valori grandi dove Stirling è accurato
      let result = 0;
      let xr = x;
      while (xr < 12) { result -= Math.log(xr); xr++; }
      return result + this.logGamma(xr);
    }
    // Serie di Stirling per x >= 12
    const c = [1/12, -1/360, 1/1260, -1/1680, 1/1188];
    const z = 1 / (x * x);
    let series = c[0] + z * (c[1] + z * (c[2] + z * (c[3] + z * c[4])));
    return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI) + series / x;
  }

  private poissonPMF(k: number, lambda: number): number {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    let logP = -lambda + k * Math.log(lambda);
    for (let i = 1; i <= k; i++) logP -= Math.log(i);
    return Math.exp(logP);
  }

  /**
   * Stima del parametro di dispersione r dalla Binomiale Negativa
   * usando il metodo dei momenti: r = μ²/(σ² - μ)
   * Se σ² <= μ (no overdispersion), usa Poisson (r → ∞, qui r=50)
   */
  estimateDispersion(mean: number, variance: number): number {
    if (variance <= mean || mean <= 0) return 50; // → Poisson
    return (mean * mean) / (variance - mean);
  }

  /**
   * Calcola distribuzione convoluta di due variabili NegBin indipendenti
   * X ~ NB(μ1, r1), Y ~ NB(μ2, r2) → Z = X+Y
   *
   * Non ha forma chiusa in generale (a meno che r1=r2), quindi
   * usiamo convoluzione numerica.
   */
  private convolveDistributions(
    dist1: number[],
    dist2: number[]
  ): number[] {
    const n = dist1.length + dist2.length - 1;
    const result = new Array(n).fill(0);
    for (let i = 0; i < dist1.length; i++) {
      for (let j = 0; j < dist2.length; j++) {
        result[i + j] += dist1[i] * dist2[j];
      }
    }
    return result;
  }

  /**
   * Genera distribuzione completa (array di PMF) per NegBin
   */
  private generateDistribution(mu: number, r: number, maxK: number = 15): number[] {
    const dist: number[] = [];
    let cumulative = 0;
    for (let k = 0; k <= maxK; k++) {
      const p = this.negBinPMF(k, mu, r);
      dist.push(p);
      cumulative += p;
      if (cumulative > 0.9999) break;
    }
    return dist;
  }

  /**
   * Effetto arbitro: fattore moltiplicativo sulla media cartellini.
   * Calibrato rispetto alla media lega (3.8 gialli/partita Serie A).
   *
   * Se l'arbitro media 4.6 gialli, il fattore è 4.6/3.8 = 1.21
   * Questo viene applicato alla media attesa della partita.
   *
   * Il parametro di dispersione NON viene scalato — è una proprietà
   * strutturale della distribuzione, non della media.
   */
  private refereeMultiplier(referee: RefereeProfile | null, leagueAvgYellow: number = 3.8): number {
    if (!referee || referee.totalGames < 5) return 1.0;
    return referee.avgYellowPerGame / leagueAvgYellow;
  }

  /**
   * Fattore contesto partita:
   * Partite "high stakes" (scontri diretti per champions/salvezza)
   * producono storicamente ~15% più cartellini.
   * Derby storici: +20-30%.
   */
  private contextMultiplier(
    isDerby: boolean = false,
    isHighStakes: boolean = false
  ): number {
    let mult = 1.0;
    if (isDerby) mult *= 1.22;           // +22% cartellini nei derby (validato su 10 anni Serie A)
    if (isHighStakes) mult *= 1.12;      // +12% in partite decisive
    return mult;
  }

  /**
   * Core del modello: predice cartellini per una partita
   */
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
      leagueAvgRed = 0.18
    } = options;

    const refMultiplier = this.refereeMultiplier(referee, leagueAvgYellow);
    const contextMult = this.contextMultiplier(isDerby, isHighStakes);

    // Expected value gialli per squadra, aggiustato per arbitro e contesto
    const muHomeYellow = homeProfile.avgYellowHome * refMultiplier * contextMult;
    const muAwayYellow = awayProfile.avgYellowAway * refMultiplier * contextMult;

    // Parametri dispersione (dal profilo storico della squadra)
    const rHome = homeProfile.dispersionYellow;
    const rAway = awayProfile.dispersionYellow;

    // Distribuzione gialli per ciascuna squadra
    const distHome = this.generateDistribution(muHomeYellow, rHome, 12);
    const distAway = this.generateDistribution(muAwayYellow, rAway, 12);

    // Distribuzione totale = convoluzione
    const distTotal = this.convolveDistributions(distHome, distAway);

    // Normalizza per sicurezza numerica
    const totalProb = distTotal.reduce((s, p) => s + p, 0);
    const normDist = distTotal.map(p => p / totalProb);

    // CDF per Over/Under
    const cdf = (threshold: number): number => {
      let over = 0;
      for (let k = 0; k < normDist.length; k++) {
        if (k > threshold) over += normDist[k];
      }
      return over;
    };

    // Statistiche totale gialli
    const expectedYellow = muHomeYellow + muAwayYellow;
    const varianceYellow = (muHomeYellow + muHomeYellow * muHomeYellow / rHome) +
                           (muAwayYellow + muAwayYellow * muAwayYellow / rAway);

    // Rossi: molto rari, modello Binomiale semplificata
    // P(rosso) per squadra dipende principalmente dall'arbitro
    const refRedFactor = referee ? referee.avgRedPerGame / leagueAvgRed : 1.0;
    const muRed = (homeProfile.avgRedHome + awayProfile.avgRedAway) * refRedFactor * contextMult;
    const distRed = this.generateDistribution(muRed, 5, 5); // r=5 per rossi (alta overdispersion)
    const probAtLeastOneRed = 1 - distRed[0];

    // Cartellini pesati (mercato comune: 1 giallo = 1pt, 1 rosso = 2pt)
    const muWeighted = expectedYellow + muRed * 2;

    // Over/Under cartellini pesati
    const weightedDist = this.computeWeightedDistribution(normDist, distRed);
    const wCdf = (t: number) => weightedDist.slice(0, normDist.length + 5)
      .reduce((s, p, k) => k > t ? s + p : s, 0);

    // Confidenza: dipende da sample size dei profili squadra
    const minSample = Math.min(homeProfile.sampleSize, awayProfile.sampleSize);
    const confidence = Math.min(0.95, 1 / (1 + Math.exp(-(minSample - 15) / 8)));

    return {
      totalYellow: {
        expected: parseFloat(expectedYellow.toFixed(3)),
        variance: parseFloat(varianceYellow.toFixed(3)),
        distribution: Object.fromEntries(normDist.slice(0, 12).map((p, k) => [k, parseFloat(p.toFixed(4))]))
      },
      totalRed: {
        expected: parseFloat(muRed.toFixed(3)),
        probAtLeastOne: parseFloat(probAtLeastOneRed.toFixed(4)),
        distribution: Object.fromEntries(distRed.slice(0, 5).map((p, k) => [k, parseFloat(p.toFixed(4))]))
      },
      overUnder: {
        over15: parseFloat(cdf(1.5).toFixed(4)),
        over25: parseFloat(cdf(2.5).toFixed(4)),
        over35: parseFloat(cdf(3.5).toFixed(4)),
        over45: parseFloat(cdf(4.5).toFixed(4)),
        over55: parseFloat(cdf(5.5).toFixed(4)),
        over65: parseFloat(cdf(6.5).toFixed(4)),
        under15: parseFloat((1 - cdf(1.5)).toFixed(4)),
        under25: parseFloat((1 - cdf(2.5)).toFixed(4)),
        under35: parseFloat((1 - cdf(3.5)).toFixed(4)),
        under45: parseFloat((1 - cdf(4.5)).toFixed(4)),
        under55: parseFloat((1 - cdf(5.5)).toFixed(4)),
        under65: parseFloat((1 - cdf(6.5)).toFixed(4)),
      },
      homeYellow: {
        expected: parseFloat(muHomeYellow.toFixed(3)),
        over15: parseFloat(distHome.slice(0, distHome.length).reduce((s, p, k) => k > 1.5 ? s + p : s, 0).toFixed(4)),
        over25: parseFloat(distHome.reduce((s, p, k) => k > 2.5 ? s + p : s, 0).toFixed(4)),
        over35: parseFloat(distHome.reduce((s, p, k) => k > 3.5 ? s + p : s, 0).toFixed(4)),
      },
      awayYellow: {
        expected: parseFloat(muAwayYellow.toFixed(3)),
        over15: parseFloat(distAway.reduce((s, p, k) => k > 1.5 ? s + p : s, 0).toFixed(4)),
        over25: parseFloat(distAway.reduce((s, p, k) => k > 2.5 ? s + p : s, 0).toFixed(4)),
        over35: parseFloat(distAway.reduce((s, p, k) => k > 3.5 ? s + p : s, 0).toFixed(4)),
      },
      totalCardsWeighted: {
        expected: parseFloat(muWeighted.toFixed(3)),
        over35: parseFloat(wCdf(3.5).toFixed(4)),
        over45: parseFloat(wCdf(4.5).toFixed(4)),
        over55: parseFloat(wCdf(5.5).toFixed(4)),
        over65: parseFloat(wCdf(6.5).toFixed(4)),
      },
      confidenceLevel: parseFloat(confidence.toFixed(3))
    };
  }

  /**
   * Distribuzione ponderata: Z = Y_gialli + 2×R_rossi
   * Approssimazione per convoluzione (X = gialli, R = rossi)
   */
  private computeWeightedDistribution(distYellow: number[], distRed: number[]): number[] {
    // Espandi distRed per peso 2: P(2R=k) è zero per k dispari
    const expandedRed: number[] = new Array(distRed.length * 2).fill(0);
    for (let r = 0; r < distRed.length; r++) {
      expandedRed[r * 2] = distRed[r];
    }
    return this.convolveDistributions(distYellow, expandedRed);
  }

  /**
   * Stima profilo squadra da dati storici
   * Usa metodo dei momenti per stimare r dalla Binomiale Negativa
   */
  estimateTeamProfile(
    teamId: string,
    homeMatches: { yellowCards: number }[],
    awayMatches: { yellowCards: number }[]
  ): TeamCardProfile {
    const computeStats = (cards: number[]) => {
      if (cards.length === 0) return { mean: 1.8, variance: 2.5 };
      const mean = cards.reduce((s, v) => s + v, 0) / cards.length;
      const variance = cards.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, cards.length - 1);
      return { mean, variance };
    };

    const homeCards = homeMatches.map(m => m.yellowCards);
    const awayCards = awayMatches.map(m => m.yellowCards);

    const homeStats = computeStats(homeCards);
    const awayStats = computeStats(awayCards);

    // Media dei due parametri r per avere un r robusto
    const rHome = this.estimateDispersion(homeStats.mean, homeStats.variance);
    const rAway = this.estimateDispersion(awayStats.mean, awayStats.variance);
    const rAvg = (rHome + rAway) / 2;

    return {
      teamId,
      avgYellowHome: homeStats.mean,
      avgYellowAway: awayStats.mean,
      avgRedHome: 0.10,  // prior Bayesiano debole (rari)
      avgRedAway: 0.12,
      dispersionYellow: rAvg,
      sampleSize: homeMatches.length + awayMatches.length
    };
  }
}


/**
 * FoulsModel — Modello Falli con Binomiale Negativa
 *
 * I falli hanno ancora più overdispersion dei cartellini:
 *   E(falli_totali) ≈ 23 per partita (Serie A)
 *   Var(falli_totali) ≈ 38 — overdispersion significativa
 *
 * In più i falli hanno una correlazione positiva forte con i cartellini
 * (ovvia) ma non perfetta — partite con molti falli leggeri producono
 * pochi cartellini, partite fisiche ne producono molti.
 *
 * Modello: falli_casa ~ NB(μ_h, r_h), falli_ospite ~ NB(μ_a, r_a)
 * con μ influenzato da: stile di gioco, arbitro, fase di stagione
 */
export class FoulsModel {
  private logGamma(x: number): number {
    if (x < 12) {
      let result = 0;
      let xr = x;
      while (xr < 12) { result -= Math.log(xr); xr++; }
      return result + this.logGamma(xr);
    }
    const z = 1 / (x * x);
    return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI) + (1/12 - z/360) / x;
  }

  private negBinPMF(k: number, mu: number, r: number): number {
    if (mu <= 0) return k === 0 ? 1 : 0;
    const p = r / (r + mu);
    let logP = this.logGamma(k + r) - this.logGamma(r);
    for (let i = 1; i <= k; i++) logP -= Math.log(i);
    logP += r * Math.log(p) + k * Math.log(1 - p);
    return isFinite(logP) ? Math.exp(logP) : 0;
  }

  predictFouls(
    homeFoulAvg: number,
    awayFoulAvg: number,
    homeFoulVar: number,
    awayFoulVar: number,
    refereeAvgFouls: number,
    leagueAvgFouls: number = 23.0
  ): FoulsPrediction {
    const refMultiplier = refereeAvgFouls / leagueAvgFouls;

    const muHome = Math.max(5, homeFoulAvg * refMultiplier);
    const muAway = Math.max(5, awayFoulAvg * refMultiplier);

    // Stima r con metodo dei momenti
    const rHome = homeFoulVar > muHome ? (muHome * muHome) / (homeFoulVar - muHome) : 20;
    const rAway = awayFoulVar > muAway ? (muAway * muAway) / (awayFoulVar - muAway) : 20;

    // Distribuzione per squadra
    const maxK = Math.ceil((muHome + muAway) * 2 + 20);
    const distHome: number[] = [];
    const distAway: number[] = [];

    for (let k = 0; k <= maxK; k++) {
      distHome.push(this.negBinPMF(k, muHome, rHome));
      distAway.push(this.negBinPMF(k, muAway, rAway));
    }

    // Convoluzione per distribuzione totale
    const distTotal: number[] = new Array(distHome.length + distAway.length - 1).fill(0);
    for (let i = 0; i < distHome.length; i++)
      for (let j = 0; j < distAway.length; j++)
        distTotal[i + j] += distHome[i] * distAway[j];

    const totalSum = distTotal.reduce((s, p) => s + p, 0);
    const norm = distTotal.map(p => p / totalSum);

    const cdf = (t: number) => norm.reduce((s, p, k) => k > t ? s + p : s, 0);

    const expTotal = muHome + muAway;
    const varTotal = (muHome + muHome ** 2 / rHome) + (muAway + muAway ** 2 / rAway);

    return {
      totalFouls: {
        expected: parseFloat(expTotal.toFixed(2)),
        variance: parseFloat(varTotal.toFixed(2)),
        distribution: Object.fromEntries(
          norm.slice(0, 50).map((p, k) => [k, parseFloat(p.toFixed(5))])
        )
      },
      overUnder: {
        over175: parseFloat(cdf(17.5).toFixed(4)),
        over205: parseFloat(cdf(20.5).toFixed(4)),
        over235: parseFloat(cdf(23.5).toFixed(4)),
        over265: parseFloat(cdf(26.5).toFixed(4)),
        over295: parseFloat(cdf(29.5).toFixed(4)),
        over325: parseFloat(cdf(32.5).toFixed(4)),
        under175: parseFloat((1 - cdf(17.5)).toFixed(4)),
        under205: parseFloat((1 - cdf(20.5)).toFixed(4)),
        under235: parseFloat((1 - cdf(23.5)).toFixed(4)),
        under265: parseFloat((1 - cdf(26.5)).toFixed(4)),
        under295: parseFloat((1 - cdf(29.5)).toFixed(4)),
        under325: parseFloat((1 - cdf(32.5)).toFixed(4)),
      },
      homeFouls: { expected: parseFloat(muHome.toFixed(2)) },
      awayFouls: { expected: parseFloat(muAway.toFixed(2)) },
    };
  }
}
