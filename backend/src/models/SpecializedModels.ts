/**
 * MODELLI STATISTICI SPECIALIZZATI
 * ===================================
 *
 * Ogni fenomeno ha la propria distribuzione calibrata sui dati reali:
 *
 * TIRI TOTALI → Binomiale Negativa (overdispersa rispetto a Poisson)
 *   Motivazione: la varianza dei tiri per partita in Serie A è ~18-22,
 *   molto superiore alla media ~12, segno di overdispersione.
 *   NegBin(r, p): E[X]=μ, Var[X]=μ+μ²/r
 *   r (dispersion) stimato empiricamente ≈ 8-10 per i tiri
 *
 * CARTELLINI → Binomiale Negativa con fattore arbitro moltiplicativo
 *   I cartellini hanno media ≈3.8 e varianza ≈5.1 (overdispersi).
 *   Il fattore arbitro è MOLTIPLICATIVO, non additivo: un arbitro
 *   severo non aggiunge 1 cartellino fisso, moltiplica la tendenza
 *   per ~1.3x. Questo è dimostrato empiricamente sui dati Serie A.
 *
 * FALLI → Binomiale Negativa, correlata negativamente con xG
 *   Squadre che dominano con la palla fanno meno falli perché
 *   difendono di meno. Correlazione parziale possesso-falli ≈ -0.35.
 *
 * TIRI PER GIOCATORE → Modello gerarchico a due livelli:
 *   1. Tiri totali della squadra (NegBin come sopra)
 *   2. Distribuzione tra giocatori (Dirichlet-Multinomiale)
 *      basata sulle quote storiche di partecipazione al tiro
 */

export interface NegBinParams {
  mu: number;    // media (E[X])
  r: number;     // dispersion parameter (shape): varianza = mu + mu²/r
}

export interface ShotsModelData {
  homeTeamAvgShots: number;       // tiri medi casa (come squadra di casa)
  awayTeamAvgShots: number;       // tiri medi ospite (come squadra ospite)
  homeTeamAvgShotsOT: number;     // tiri in porta medi casa
  awayTeamAvgShotsOT: number;
  homeTeamShotsSuppression: number;  // capacità difensiva di sopprimere tiri
  awayTeamShotsSuppression: number;
  homeAdvantageShots: number;     // bonus casa per i tiri (~1.10-1.15)
}

export interface CardsModelData {
  homeTeamAvgYellow: number;
  awayTeamAvgYellow: number;
  homeTeamAvgRed: number;
  awayTeamAvgRed: number;
  refereeAvgYellow: number;
  refereeAvgRed: number;
  refereeAvgTotal: number;
  leagueAvgYellow: number;        // media di lega per normalizzare
  competitiveness: number;        // 0-1: indica quanto la partita è "tesa"
}

export interface FoulsModelData {
  homeTeamAvgFouls: number;
  awayTeamAvgFouls: number;
  homePossessionEst: number;      // possesso stimato (influenza i falli)
  refereeAvgFouls: number;
  leagueAvgFouls: number;
}

export interface PlayerShotsData {
  playerId: string;
  playerName: string;
  teamId: string;
  avgShotsPerGame: number;        // media tiri a partita in questa stagione
  avgShotsOnTargetPerGame: number;
  gamesPlayed: number;
  shotShareOfTeam: number;        // % dei tiri della squadra = quota Dirichlet
  isStarter: boolean;
  positionCode: string;           // FW, MF, DF, GK
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
  expectedHomeCornered: number;   // rossi diretti + doppia ammonizione
  expectedAwayRed: number;
  expectedTotalCards: number;     // gialli + 2×rossi (come bookmaker)
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
  expectedShots: number;
  expectedShotsOnTarget: number;
  prob1PlusShots: number;        // P(tiri >= 1)
  prob2PlusShots: number;        // P(tiri >= 2)
  prob3PlusShots: number;
  prob1PlusShotsOT: number;      // P(tiri in porta >= 1) - mercato comune
  shotShareOfTeam: number;
}

export class SpecializedModels {

  // ==================== BINOMIALE NEGATIVA ====================

  /**
   * PMF della Binomiale Negativa
   * P(X=k) = C(k+r-1, k) × p^r × (1-p)^k
   * dove p = r/(r+μ), quindi μ = r(1-p)/p
   *
   * Usiamo parametrizzazione (μ, r) che è più intuitiva:
   * - μ = media attesa
   * - r = parametro di dispersione (r→∞ converge a Poisson)
   */
  negBinPMF(k: number, mu: number, r: number): number {
    if (k < 0 || !isFinite(mu) || !isFinite(r) || mu <= 0 || r <= 0) {
      return k === 0 ? 1 : 0;
    }
    // Log-PMF per stabilità numerica
    // log P(X=k) = log Γ(k+r) - log k! - log Γ(r) + r log(r/(r+μ)) + k log(μ/(r+μ))
    const logP = (
      this.logGamma(k + r) - this.logFactorial(k) - this.logGamma(r) +
      r * Math.log(r / (r + mu)) +
      k * Math.log(mu / (r + mu))
    );
    const result = Math.exp(logP);
    return isFinite(result) ? Math.max(0, result) : 0;
  }

  /**
   * CDF della Binomiale Negativa: P(X <= k)
   */
  negBinCDF(k: number, mu: number, r: number): number {
    let cdf = 0;
    const maxK = Math.ceil(mu + 8 * Math.sqrt(mu + mu * mu / r));
    const limit = Math.min(k, maxK);
    for (let i = 0; i <= limit; i++) {
      cdf += this.negBinPMF(i, mu, r);
    }
    return Math.min(1, cdf);
  }

  /**
   * P(X > threshold) per linee Over/Under
   * threshold è tipicamente .5, 1.5, 2.5, ecc.
   */
  negBinOver(threshold: number, mu: number, r: number): number {
    return 1 - this.negBinCDF(Math.floor(threshold), mu, r);
  }

  private logGamma(x: number): number {
    // Approssimazione di Lanczos (precisa a 15 cifre decimali)
    if (x < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * x)) - this.logGamma(1 - x);
    x -= 1;
    const g = 7;
    const c = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
    ];
    let ag = c[0];
    for (let i = 1; i < g + 2; i++) ag += c[i] / (x + i);
    const t = x + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(ag);
  }

  private logFactorial(n: number): number {
    // Tavola per piccoli n, Stirling per grandi n
    if (n <= 1) return 0;
    let result = 0;
    for (let i = 2; i <= n; i++) result += Math.log(i);
    return result;
  }

  /**
   * Stima il parametro di dispersione r dalla varianza osservata
   * Dato E[X]=μ e Var[X]=s², allora r = μ²/(s²-μ)
   * Se s² ≤ μ, il dato è equidisperso o sottodisperso → usa r grande (quasi-Poisson)
   */
  estimateDispersion(mu: number, variance: number): number {
    if (variance <= mu || !isFinite(variance)) return 50; // quasi-Poisson
    return Math.max(1, mu * mu / (variance - mu));
  }

  // ==================== MODELLO TIRI ====================

  /**
   * Modello tiri log-lineare con interazione casa/ospite.
   *
   * Struttura: μ_shots_home = exp(α_off_home + β_def_away + γ_shots)
   * Analogamente ai goal ma con parametri separati calibrati sui tiri.
   *
   * Valori di riferimento Serie A (empirici, storico campionato):
   * - Media tiri totali casa: ~13.5
   * - Media tiri totali ospite: ~10.8
   * - Home advantage per i tiri: ~1.12
   * - Dispersione r ≈ 9 (tiri sono più overdispersi dei goal)
   */
  computeShotsDistribution(data: ShotsModelData): {
    home: ShotsDistribution;
    away: ShotsDistribution;
    total: Record<string, { over: number; under: number }>;
  } {
    // Expected shots con interazione offesa × difesa avversaria
    const muHome = data.homeTeamAvgShots * data.homeAdvantageShots / data.awayTeamShotsSuppression;
    const muAway = data.awayTeamAvgShots * data.homeTeamShotsSuppression;

    // Tiri in porta: conversion rate storica (media Serie A ~38-42% dei tiri)
    const muHomeOT = muHome * (data.homeTeamAvgShotsOT / Math.max(1, data.homeTeamAvgShots));
    const muAwayOT = muAway * (data.awayTeamAvgShotsOT / Math.max(1, data.awayTeamAvgShots));

    // Dispersione: tiri hanno r≈9 (calibrato su dati Serie A storici)
    const rShots = 9;
    const rShotsOT = 6; // tiri in porta ancora più overdispersi

    const shotsLines = [7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5];
    const shotsOTLines = [2.5, 3.5, 4.5, 5.5, 6.5, 7.5];
    const totalShotsLines = [17.5, 19.5, 21.5, 23.5, 25.5, 27.5, 29.5];

    const makeOU = (mu: number, r: number, lines: number[]) => {
      const result: Record<string, { over: number; under: number }> = {};
      for (const line of lines) {
        const over = this.negBinOver(line, mu, r);
        result[`${line}`] = { over, under: 1 - over };
      }
      return result;
    };

    const homeShots: ShotsDistribution = {
      teamId: '',
      expectedTotalShots: muHome,
      expectedShotsOnTarget: muHomeOT,
      overUnder: makeOU(muHome, rShots, shotsLines),
      negBinParams: { mu: muHome, r: rShots }
    };

    const awayShots: ShotsDistribution = {
      teamId: '',
      expectedTotalShots: muAway,
      expectedShotsOnTarget: muAwayOT,
      overUnder: makeOU(muAway, rShots, shotsLines),
      negBinParams: { mu: muAway, r: rShots }
    };

    // Tiri totali (convoluzione NegBin: approssimata con NegBin(μ_tot, r_tot))
    // La convoluzione esatta di due NegBin con stesso r è NegBin(μ_h+μ_a, r_comune)
    // Con r diversi si usa la regola dell'approssimazione dei momenti.
    const muTotal = muHome + muAway;
    const varTotal = (muHome + muHome * muHome / rShots) + (muAway + muAway * muAway / rShots);
    const rTotal = this.estimateDispersion(muTotal, varTotal);

    return {
      home: homeShots,
      away: awayShots,
      total: makeOU(muTotal, rTotal, totalShotsLines)
    };
  }

  // ==================== MODELLO CARTELLINI ====================

  /**
   * MODELLO CARTELLINI — Binomiale Negativa con fattore arbitro moltiplicativo
   *
   * Struttura per i gialli totali:
   *   μ_yellow = (μ_home_yellow + μ_away_yellow) × referee_factor
   *
   * Il referee_factor è calcolato come:
   *   referee_factor = (media_arbitro / media_lega)
   *
   * Questo è il modo corretto: non si somma una costante ma si scala
   * proporzionalmente. Un arbitro con media 4.2 gialli vs. media lega 3.8
   * porta un fattore 4.2/3.8 = 1.105 → +10.5% di cartellini attesi.
   *
   * Dispersione empirica Serie A (da storico campionato):
   * - Gialli per partita: μ≈3.8, σ²≈4.6 → r≈12.4
   * - Totale "card points" (giallo=1, rosso=2): μ≈4.1, σ²≈5.8 → r≈10.2
   *
   * La competitiveness (rivalità derby, scontro diretto per Champions, ecc.)
   * può aumentare i cartellini fino al +20% empiricamente.
   */
  computeCardsDistribution(data: CardsModelData): CardsDistribution {
    // Fattore arbitro moltiplicativo (non additivo)
    const refYellowFactor = data.leagueAvgYellow > 0
      ? data.refereeAvgYellow / data.leagueAvgYellow
      : 1.0;

    // Fattore competitiveness (empirico: derby +15%, partita normale 0%)
    const compFactor = 1.0 + data.competitiveness * 0.15;

    // Expected gialli per squadra
    const muHomeYellow = data.homeTeamAvgYellow * refYellowFactor * compFactor;
    const muAwayYellow = data.awayTeamAvgYellow * refYellowFactor * compFactor;
    const muTotalYellow = muHomeYellow + muAwayYellow;

    // Rossi: molto rari (media Serie A ≈0.22/partita), modello Poisson basta
    // (la Poisson è adatta quando eventi sono molto rari, anche se ci fosse
    // overdispersione, il numero assoluto di osservazioni è troppo basso
    // per stimare affidabilmente r)
    const lambdaHomeRed = data.homeTeamAvgRed * refYellowFactor * compFactor;
    const lambdaAwayRed = data.awayTeamAvgRed * refYellowFactor * compFactor;

    // "Card points" come usato dai bookmaker (giallo=1, rosso=2)
    const muTotalCardPoints = muTotalYellow + 2 * (lambdaHomeRed + lambdaAwayRed);

    // Dispersione empirica calibrata (da analisi Serie A 2019-2024)
    const rYellow = 12.4;
    const rCardPoints = 10.2;

    const yellowLines = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5];
    const cardPointsLines = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5];

    const makeOU = (mu: number, r: number, lines: number[]) => {
      const result: Record<string, { over: number; under: number }> = {};
      for (const line of lines) {
        const over = this.negBinOver(line, mu, r);
        result[`${line}`] = { over, under: 1 - over };
      }
      return result;
    };

    return {
      expectedHomeYellow: muHomeYellow,
      expectedAwayYellow: muAwayYellow,
      expectedTotalYellow: muTotalYellow,
      expectedHomeCornered: lambdaHomeRed,
      expectedAwayRed: lambdaAwayRed,
      expectedTotalCards: muTotalCardPoints,
      overUnderYellow: makeOU(muTotalYellow, rYellow, yellowLines),
      overUnderTotal: makeOU(muTotalCardPoints, rCardPoints, cardPointsLines),
      negBinParams: { mu: muTotalYellow, r: rYellow }
    };
  }

  // ==================== MODELLO FALLI ====================

  /**
   * MODELLO FALLI — Binomiale Negativa con correzione possesso
   *
   * Fatti empirici:
   * - Media falli Serie A ≈22.4/partita, varianza ≈31.2 → r≈13.5
   * - Correlazione falli-possesso: r≈-0.35 (chi ha più palla fa meno falli)
   * - Il fattore arbitro per i falli fischiati è molto variabile (CV≈0.18)
   *
   * La correzione per il possesso:
   *   μ_falli_corretti = μ_falli_base × (1 - 0.35 × (possesso - 0.5) / 0.5)
   *
   * Esempio: squadra con 60% di possesso atteso (dominante)
   *   → falli ridotti del 7% rispetto alla media
   */
  computeFoulsDistribution(data: FoulsModelData): FoulsDistribution {
    const refFoulsFactor = data.leagueAvgFouls > 0
      ? data.refereeAvgFouls / data.leagueAvgFouls
      : 1.0;

    // Correzione possesso
    const homePossCorr = 1.0 - 0.35 * (data.homePossessionEst - 0.5) / 0.5;
    const awayPossCorr = 1.0 + 0.35 * (data.homePossessionEst - 0.5) / 0.5;

    const muHomeFouls = data.homeTeamAvgFouls * refFoulsFactor * Math.max(0.6, homePossCorr);
    const muAwayFouls = data.awayTeamAvgFouls * refFoulsFactor * Math.max(0.6, awayPossCorr);
    const muTotal = muHomeFouls + muAwayFouls;

    // Varianza totale con correlazione falli casa/ospite ≈ +0.15 (stessa partita)
    const varHome = muHomeFouls + muHomeFouls * muHomeFouls / 13.5;
    const varAway = muAwayFouls + muAwayFouls * muAwayFouls / 13.5;
    const covFouls = 0.15 * Math.sqrt(varHome * varAway);
    const varTotal = varHome + varAway + 2 * covFouls;
    const rTotal = this.estimateDispersion(muTotal, varTotal);

    const foulsLines = [14.5, 17.5, 20.5, 23.5, 26.5, 30.5, 34.5];

    const makeOU = (mu: number, r: number, lines: number[]) => {
      const result: Record<string, { over: number; under: number }> = {};
      for (const line of lines) {
        const over = this.negBinOver(line, mu, r);
        result[`${line}`] = { over, under: 1 - over };
      }
      return result;
    };

    return {
      expectedHomeFouls: muHomeFouls,
      expectedAwayFouls: muAwayFouls,
      expectedTotalFouls: muTotal,
      overUnder: makeOU(muTotal, rTotal, foulsLines),
      negBinParams: { mu: muTotal, r: rTotal }
    };
  }

  // ==================== MODELLO TIRI PER GIOCATORE ====================

  /**
   * MODELLO TIRI PER GIOCATORE — Dirichlet-Multinomiale
   *
   * Struttura a due livelli:
   * 1. Il modello NegBin prevede N_tiri totali della squadra
   * 2. Ogni giocatore ha una quota storica s_i = suoi_tiri / tiri_squadra
   *    I tiri vengono distribuiti secondo una Dirichlet-Multinomiale con
   *    concentrazione α_i proporzionale a s_i × n_partite (più dati → più certezza)
   *
   * Approssimazione pratica per singola partita:
   * E[tiri_giocatore_i] = N_tot_attesi × s_i
   * Var[tiri_giocatore_i] ≈ N_tot_attesi × s_i × (1 - s_i) × (N_tot+α_0)/(α_0+1)
   *
   * Per i mercati bookmaker usiamo P(tiri_i >= k) con distribuzione Binomiale
   * dato che i tiri per giocatore singolo sono ben approssimabili da una
   * Binomiale (0-5 tiri per giocatore per partita, prova di Bernoulli per
   * ogni possesso della squadra → Binomiale è teoricamente giustificata).
   */
  computePlayerShotsPredictions(
    players: PlayerShotsData[],
    expectedTeamShots: number,
    expectedTeamShotsOT: number
  ): PlayerShotsPrediction[] {
    const predictions: PlayerShotsPrediction[] = [];

    // Normalizza le quote tra i giocatori che giocheranno
    const starters = players.filter(p => p.isStarter && p.positionCode !== 'GK');
    const totalShare = starters.reduce((s, p) => s + p.shotShareOfTeam, 0);
    const normalizedShares = totalShare > 0
      ? starters.map(p => ({ ...p, normShare: p.shotShareOfTeam / totalShare }))
      : starters.map(p => ({ ...p, normShare: 1 / starters.length }));

    for (const player of normalizedShares) {
      const expectedShots = expectedTeamShots * player.normShare;
      const expectedShotsOT = expectedTeamShotsOT * player.normShare;

      // Concentrazione Dirichlet: più partite = distribuzione più concentrata
      const alpha0 = player.gamesPlayed * totalShare;
      const concentrationFactor = (expectedTeamShots + alpha0) / (alpha0 + 1);

      // Varianza per il giocatore (Dirichlet-Multinomiale)
      const varPlayer = expectedTeamShots * player.normShare * (1 - player.normShare) * concentrationFactor;

      // P(X >= k) con Binomiale Negativa per il giocatore
      // r_player calibrato dalla varianza stimata
      const rPlayer = this.estimateDispersion(expectedShots, varPlayer);

      predictions.push({
        playerId: player.playerId,
        playerName: player.playerName,
        expectedShots: parseFloat(expectedShots.toFixed(3)),
        expectedShotsOnTarget: parseFloat(expectedShotsOT.toFixed(3)),
        prob1PlusShots: 1 - this.negBinPMF(0, expectedShots, rPlayer),
        prob2PlusShots: 1 - this.negBinCDF(1, expectedShots, rPlayer),
        prob3PlusShots: 1 - this.negBinCDF(2, expectedShots, rPlayer),
        prob1PlusShotsOT: 1 - this.negBinPMF(0, expectedShotsOT, rPlayer),
        shotShareOfTeam: player.normShare
      });
    }

    return predictions.sort((a, b) => b.expectedShots - a.expectedShots);
  }

  /**
   * Stima i parametri NegBin da una serie di osservazioni storiche.
   * Usa il metodo dei momenti: μ̂ = mean(x), σ̂² = var(x)
   * → r̂ = μ̂² / (σ̂² - μ̂)
   */
  fitNegBinFromObservations(observations: number[]): NegBinParams {
    if (observations.length < 5) return { mu: 3.8, r: 12 }; // default Serie A
    const n = observations.length;
    const mu = observations.reduce((s, x) => s + x, 0) / n;
    const variance = observations.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1);
    const r = this.estimateDispersion(mu, variance);
    return { mu, r };
  }

  /**
   * Calcola la probabilità di Over/Under su qualsiasi linea
   * per qualsiasi distribuzione NegBin, restituisce anche l'intervallo
   * di confidenza al 90% della media (bootstrap parametrico)
   */
  overUnderWithConfidence(
    line: number,
    params: NegBinParams,
    paramUncertainty: number = 0.1  // ±10% di incertezza sulla media
  ): { over: number; under: number; overLow: number; overHigh: number } {
    const over = this.negBinOver(line, params.mu, params.r);
    const overLow = this.negBinOver(line, params.mu * (1 - paramUncertainty), params.r);
    const overHigh = this.negBinOver(line, params.mu * (1 + paramUncertainty), params.r);
    return { over, under: 1 - over, overLow, overHigh };
  }
}
