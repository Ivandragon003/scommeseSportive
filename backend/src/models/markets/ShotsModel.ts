import {
  negBinPMF as computeNegBinPMF,
  poissonPMF as computePoissonPMF,
} from '../utils/MathUtils';
import { predictionEngineConfig, PlayerShotsDistribution } from '../../config/PredictionEngineConfig';

/**
 * ShotsModel — Modello Tiri a Livello Squadra e Giocatore
 *
 * DUE LIVELLI DISTINTI:
 *
 * LIVELLO SQUADRA:
 * I tiri totali di una squadra seguono una Poisson abbastanza bene
 * (meno overdispersion dei cartellini). Media Serie A: ~12 tiri/squadra/partita.
 * Modello: Poisson con intensità dipendente da:
 *   - Forza offensiva squadra (da Dixon-Coles)
 *   - Stile di gioco (possesso alto → più tiri)
 *   - Avversario (difesa chiusa → meno tiri)
 *   - Vantaggio campo
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
 * - Over/Under tiri squadra (totale e in porta)
 * - Tiri specifici giocatore (Over 0.5, 1.5, 2.5, 3.5)
 * - Tiri in porta giocatore (Over 0.5, 1.5)
 * - Primo tiratore della partita (molto speculativo, bassa confidenza)
 */

export interface PlayerShotProfile {
  playerId: string;
  playerName: string;
  teamId: string;
  position: 'GK' | 'DEF' | 'MID' | 'FWD';

  // Parametri ZIP stimati
  zipPi: number;          // probabilità strutturale di zero (0-1)
  zipLambda: number;      // intensità quando attivo

  // Parametri per tiri in porta (sottoinsieme)
  onTargetPi: number;
  onTargetLambda: number;

  // Parametri contestuali
  avgMinutesPlayed: number;       // media minuti giocati (influenza π)
  homeMultiplier: number;         // tende a tirare di più in casa?
  avgShotsVsTopDefence: number;   // vs difese forti (top 5 lega)
  avgShotsVsWeakDefence: number;  // vs difese deboli

  // Metadati stima
  sampleSize: number;
  lastUpdated: Date;
}

export interface TeamShotProfile {
  teamId: string;
  avgShotsHome: number;
  avgShotsAway: number;
  avgShotsOnTargetHome: number;
  avgShotsOnTargetAway: number;
  varianceShotsHome: number;
  varianceShotsAway: number;
  // Stile di gioco
  avgPossessionHome: number;
  avgPossessionAway: number;
  // Conversione: P(tiro → tiro in porta) storico
  onTargetRateHome: number;
  onTargetRateAway: number;
}

export interface TeamShotsPrediction {
  home: {
    totalShots: { expected: number; variance: number; distribution: Record<number, number> };
    shotsOnTarget: { expected: number; distribution: Record<number, number> };
    overUnder: {
      shots: { over85: number; over105: number; over125: number; over145: number; over165: number };
      onTarget: { over25: number; over35: number; over45: number; over55: number; over65: number };
    };
  };
  away: {
    totalShots: { expected: number; variance: number; distribution: Record<number, number> };
    shotsOnTarget: { expected: number; distribution: Record<number, number> };
    overUnder: {
      shots: { over55: number; over75: number; over95: number; over115: number; over135: number };
      onTarget: { over15: number; over25: number; over35: number; over45: number; over55: number };
    };
  };
  combined: {
    totalShots: { expected: number };
    overUnder: {
      over195: number; over225: number; over255: number; over285: number;
      under195: number; under225: number; under255: number; under285: number;
    };
    totalOnTarget: { expected: number };
    onTargetOverUnder: {
      over75: number; over95: number; over115: number;
      under75: number; under95: number; under115: number;
    };
  };
}

export interface PlayerShotPrediction {
  playerId: string;
  playerName: string;
  teamId: string;
  position: string;

  // Expected values
  expectedShots: number;
  expectedOnTarget: number;

  // Distribuzione completa (per calcolare qualsiasi Over/Under)
  shotDistribution: Record<number, number>;   // k -> P(shots = k)
  onTargetDistribution: Record<number, number>;

  // Mercati standard
  markets: {
    // Tiri totali
    over05shots: number;
    over15shots: number;
    over25shots: number;
    over35shots: number;
    // Tiri in porta
    over05onTarget: number;
    over15onTarget: number;
    over25onTarget: number;
    // Probabilità di non tirare
    zeroShots: number;
  };

  // Confidenza
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
  quantiles: { q25: number; q50: number; q75: number };
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

export type HierarchicalPlayerRole =
  | 'forward'
  | 'winger'
  | 'attacking_midfielder'
  | 'midfielder'
  | 'fullback'
  | 'centreback'
  | 'goalkeeper'
  | 'unknown';

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

export class ShotsModel {

  private poissonPMF(k: number, lambda: number): number {
    return computePoissonPMF(k, lambda);
  }

  private negBinPMF(k: number, mu: number, r: number): number {
    return computeNegBinPMF(k, mu, r);
  }

  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  private normalizeDistribution(dist: number[]): number[] {
    const total = dist.reduce((sum, value) => sum + Math.max(0, value), 0);
    if (total <= 1e-12) return dist.map((_, index) => index === 0 ? 1 : 0);
    return dist.map((value) => Math.max(0, value) / total);
  }

  private distributionToRecord(dist: number[]): Record<number, number> {
    return Object.fromEntries(this.normalizeDistribution(dist).map((p, k) => [k, parseFloat(p.toFixed(4))]));
  }

  private probabilityOver(dist: number[], line: number): number {
    const norm = this.normalizeDistribution(dist);
    return parseFloat(norm.reduce((sum, p, k) => k > line ? sum + p : sum, 0).toFixed(4));
  }

  private logFactorial(n: number): number {
    let out = 0;
    for (let i = 2; i <= n; i++) out += Math.log(i);
    return out;
  }

  private binomialPMF(k: number, n: number, p: number): number {
    if (k < 0 || k > n) return 0;
    const pp = this.clamp(p, 1e-9, 1 - 1e-9);
    const logComb = this.logFactorial(n) - this.logFactorial(k) - this.logFactorial(n - k);
    return Math.exp(logComb + k * Math.log(pp) + (n - k) * Math.log(1 - pp));
  }

  private logGamma(z: number): number {
    const coefficients = [
      676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - this.logGamma(1 - z);
    z -= 1;
    let x = 0.99999999999980993;
    for (let i = 0; i < coefficients.length; i++) x += coefficients[i] / (z + i + 1);
    const t = z + coefficients.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  private betaBinomialPMF(k: number, n: number, alpha: number, beta: number): number {
    if (k < 0 || k > n) return 0;
    const logComb = this.logFactorial(n) - this.logFactorial(k) - this.logFactorial(n - k);
    const logBetaNum = this.logGamma(k + alpha) + this.logGamma(n - k + beta) - this.logGamma(n + alpha + beta);
    const logBetaDen = this.logGamma(alpha) + this.logGamma(beta) - this.logGamma(alpha + beta);
    return Math.exp(logComb + logBetaNum - logBetaDen);
  }

  /**
   * Zero-Inflated Poisson PMF
   * P(X=0) = π + (1-π)×e^{-λ}
   * P(X=k) = (1-π)×e^{-λ}×λ^k/k!    k≥1
   */
  private zipPMF(k: number, pi: number, lambda: number): number {
    if (k === 0) {
      return pi + (1 - pi) * Math.exp(-lambda);
    }
    return (1 - pi) * this.poissonPMF(k, lambda);
  }

  private zinbPMF(k: number, pi: number, mu: number, r: number): number {
    if (k === 0) return pi + (1 - pi) * this.negBinPMF(0, mu, r);
    return (1 - pi) * this.negBinPMF(k, mu, r);
  }

  /**
   * Genera distribuzione completa ZIP
   */
  private generateZIPDistribution(pi: number, lambda: number, maxK: number = 10): number[] {
    const dist: number[] = [];
    for (let k = 0; k <= maxK; k++) {
      dist.push(this.zipPMF(k, pi, lambda));
    }
    return dist;
  }

  private generateZINBDistribution(pi: number, mu: number, r: number, maxK: number = 10): number[] {
    const dist: number[] = [];
    for (let k = 0; k <= maxK; k++) dist.push(this.zinbPMF(k, pi, mu, r));
    return dist;
  }

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
  fitZIPParameters(
    observations: number[],
    maxIter: number = 100,
    tol: number = 1e-6
  ): { pi: number; lambda: number; logLikelihood: number } {
    if (observations.length === 0) return { pi: 0.5, lambda: 1.5, logLikelihood: -Infinity };

    const n = observations.length;
    const zeros = observations.filter(x => x === 0).length;
    const sumX = observations.reduce((s, x) => s + x, 0);

    // Inizializzazione: metodo dei momenti
    const mean = sumX / n;
    const variance = observations.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);

    // Se variance ≈ mean, π ≈ 0 (quasi Poisson)
    let pi = Math.max(0.01, Math.min(0.95, 1 - mean / Math.max(variance, mean + 0.01)));
    let lambda = mean / Math.max(0.01, 1 - pi);

    for (let iter = 0; iter < maxIter; iter++) {
      const piOld = pi;
      const lambdaOld = lambda;

      // E-step: responsabilità degli zero strutturali
      const pZeroPoisson = Math.exp(-lambda);
      const pZeroZIP = pi + (1 - pi) * pZeroPoisson;
      const gamma = pZeroZIP > 0 ? (pi / pZeroZIP) : 0; // responsabilità media per uno zero
      const expectedStructuralZeros = zeros * gamma;

      // M-step
      pi = Math.max(0.001, Math.min(0.999, expectedStructuralZeros / n));
      lambda = Math.max(0.01, sumX / Math.max(0.001, n - expectedStructuralZeros));

      if (Math.abs(pi - piOld) < tol && Math.abs(lambda - lambdaOld) < tol) break;
    }

    // Log-likelihood
    let ll = 0;
    for (const x of observations) {
      const p = this.zipPMF(x, pi, lambda);
      if (p > 0) ll += Math.log(p);
    }

    return { pi, lambda, logLikelihood: ll };
  }

  fitZINBParameters(
    observations: number[],
    maxIter: number = 100,
    tol: number = 1e-6
  ): { pi: number; mu: number; dispersion: number; logLikelihood: number; fallbackUsed: boolean } {
    if (observations.length < 8) {
      const zip = this.fitZIPParameters(observations, maxIter, tol);
      return { pi: zip.pi, mu: zip.lambda, dispersion: 30, logLikelihood: zip.logLikelihood, fallbackUsed: true };
    }

    const n = observations.length;
    const zeros = observations.filter((x) => x === 0).length;
    const sumX = observations.reduce((s, x) => s + x, 0);
    const mean = sumX / n;
    const variance = observations.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1);
    let pi = Math.max(0.001, Math.min(0.90, zeros / n - Math.exp(-Math.max(0.01, mean))));
    let mu = Math.max(0.01, mean / Math.max(0.01, 1 - pi));
    let dispersion = variance > mean ? Math.max(0.8, Math.min(50, (mu * mu) / Math.max(0.01, variance - mu))) : 30;

    for (let iter = 0; iter < maxIter; iter++) {
      const oldPi = pi;
      const oldMu = mu;
      const oldDispersion = dispersion;
      const pZeroNb = this.negBinPMF(0, mu, dispersion);
      const pZeroZinb = pi + (1 - pi) * pZeroNb;
      const gamma = pZeroZinb > 0 ? pi / pZeroZinb : 0;
      const structuralZeros = zeros * gamma;
      const effectiveN = Math.max(0.001, n - structuralZeros);

      pi = Math.max(0.001, Math.min(0.98, structuralZeros / n));
      mu = Math.max(0.01, sumX / effectiveN);
      const adjustedVariance = Math.max(mu + 0.01, variance / Math.max(0.05, 1 - pi));
      dispersion = Math.max(0.5, Math.min(50, (mu * mu) / Math.max(0.01, adjustedVariance - mu)));

      if (
        Math.abs(pi - oldPi) < tol &&
        Math.abs(mu - oldMu) < tol &&
        Math.abs(dispersion - oldDispersion) < tol
      ) break;
    }

    const logLikelihood = observations.reduce((sum, x) => {
      const p = this.zinbPMF(x, pi, mu, dispersion);
      return sum + Math.log(Math.max(1e-12, p));
    }, 0);

    return { pi, mu, dispersion, logLikelihood, fallbackUsed: false };
  }

  estimateMinutesDistribution(params: {
    mode?: 'triangular' | 'empirical';
    expectedMinutes: number;
    minutesUncertainty?: number;
    observations?: MinutesObservation[];
    isLikelyStarter?: boolean;
    asOf?: Date;
    decayPerDay?: number;
  }): MinutesDistributionEstimate {
    const expectedMinutes = this.clamp(params.expectedMinutes, 1, 90);
    const minutesUncertainty = params.minutesUncertainty ?? 0.15;
    const triangular = (): MinutesDistributionEstimate => {
      const minMins = expectedMinutes * (1 - minutesUncertainty);
      const maxMins = Math.min(90, expectedMinutes * (1 + minutesUncertainty));
      const modeMins = expectedMinutes;
      const mean = (minMins + maxMins + modeMins) / 3;
      const variance =
        (minMins ** 2 + maxMins ** 2 + modeMins ** 2 - minMins * maxMins - minMins * modeMins - maxMins * modeMins) / 18;
      return {
        modeUsed: 'triangular',
        mean: Number(mean.toFixed(3)),
        std: Number(Math.sqrt(Math.max(0, variance)).toFixed(3)),
        quantiles: {
          q25: Number(((minMins + modeMins) / 2).toFixed(3)),
          q50: Number(modeMins.toFixed(3)),
          q75: Number(((modeMins + maxMins) / 2).toFixed(3)),
        },
        minutesFactor: Number((mean / 90).toFixed(6)),
        varianceFactor: Number((variance / (90 * 90)).toFixed(6)),
        sampleSize: 0,
      };
    };

    if (params.mode !== 'empirical') return triangular();
    const observations = (params.observations ?? [])
      .filter((obs) => Number.isFinite(obs.minutes) && obs.minutes >= 0 && obs.minutes <= 130)
      .filter((obs) => params.isLikelyStarter === undefined || obs.isStarter === undefined || obs.isStarter === params.isLikelyStarter);
    if (observations.length < 4) return triangular();

    const asOf = params.asOf ?? new Date();
    const decayPerDay = params.decayPerDay ?? 0.018;
    const weighted = observations.map((obs) => {
      const ageDays = obs.date instanceof Date
        ? Math.max(0, (asOf.getTime() - obs.date.getTime()) / (1000 * 60 * 60 * 24))
        : 0;
      return { minutes: this.clamp(obs.minutes, 0, 90), weight: Math.exp(-decayPerDay * ageDays) };
    });
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) return triangular();

    const mean = weighted.reduce((sum, item) => sum + item.minutes * item.weight, 0) / totalWeight;
    const variance = weighted.reduce((sum, item) => sum + item.weight * (item.minutes - mean) ** 2, 0) / totalWeight;
    const sorted = [...weighted].sort((a, b) => a.minutes - b.minutes);
    const quantile = (q: number): number => {
      const target = totalWeight * q;
      let running = 0;
      for (const item of sorted) {
        running += item.weight;
        if (running >= target) return item.minutes;
      }
      return sorted[sorted.length - 1].minutes;
    };

    return {
      modeUsed: 'empirical',
      mean: Number(mean.toFixed(3)),
      std: Number(Math.sqrt(Math.max(0, variance)).toFixed(3)),
      quantiles: {
        q25: Number(quantile(0.25).toFixed(3)),
        q50: Number(quantile(0.50).toFixed(3)),
        q75: Number(quantile(0.75).toFixed(3)),
      },
      minutesFactor: Number((mean / 90).toFixed(6)),
      varianceFactor: Number((variance / (90 * 90)).toFixed(6)),
      sampleSize: observations.length,
    };
  }

  /**
   * Predizione tiri per squadra
   * Usiamo Binomiale Negativa (lieve overdispersion nei tiri squadra)
   */
  predictTeamShots(
    homeProfile: TeamShotProfile,
    awayProfile: TeamShotProfile,
    attackMultiplierHome: number = 1.0,  // da Dixon-Coles (forza offensiva relativa)
    attackMultiplierAway: number = 1.0,
    defenceMultiplierHome: number = 1.0, // impatto difesa avversaria
    defenceMultiplierAway: number = 1.0
  ): TeamShotsPrediction {
    // Media aggiustata per forza relativa delle squadre
    const muHome = Math.max(3, homeProfile.avgShotsHome * attackMultiplierHome * defenceMultiplierAway);
    const muAway = Math.max(3, awayProfile.avgShotsAway * attackMultiplierAway * defenceMultiplierHome);

    // r dai dati: r = μ²/(σ²-μ), con floor a 5 (evita overdispersion eccessiva)
    const rHome = Math.max(5, homeProfile.varianceShotsHome > muHome
      ? (muHome * muHome) / (homeProfile.varianceShotsHome - muHome) : 20);
    const rAway = Math.max(5, homeProfile.varianceShotsAway > muAway
      ? (muAway * muAway) / (homeProfile.varianceShotsAway - muAway) : 20);

    const maxKHome = Math.ceil(muHome * 3 + 10);
    const maxKAway = Math.ceil(muAway * 3 + 10);

    // Distribuzione tiri totali
    const distHomeShots = Array.from({ length: maxKHome }, (_, k) => this.negBinPMF(k, muHome, rHome));
    const distAwayShots = Array.from({ length: maxKAway }, (_, k) => this.negBinPMF(k, muAway, rAway));

    // Tiri in porta: modello condizionale
    // SOT = totale × tasso_in_porta, ma non linearmente — usiamo Binomiale condizionale
    const muHomSOT = muHome * homeProfile.onTargetRateHome;
    const muAwaSOT = muAway * awayProfile.onTargetRateAway;
    const rHomSOT = Math.max(3, (muHomSOT * muHomSOT) / Math.max(0.01, muHomSOT * 0.4));
    const rAwaSOT = Math.max(3, (muAwaSOT * muAwaSOT) / Math.max(0.01, muAwaSOT * 0.4));

    const distHomeSOT = Array.from({ length: 20 }, (_, k) => this.negBinPMF(k, muHomSOT, rHomSOT));
    const distAwaySOT = Array.from({ length: 20 }, (_, k) => this.negBinPMF(k, muAwaSOT, rAwaSOT));

    // Distribuzione convoluta per totali
    const combineShots = (d1: number[], d2: number[]) => {
      const res = new Array(d1.length + d2.length - 1).fill(0);
      for (let i = 0; i < d1.length; i++)
        for (let j = 0; j < d2.length; j++)
          res[i + j] += d1[i] * d2[j];
      return res;
    };

    const distTotalShots = combineShots(distHomeShots, distAwayShots);
    const distTotalSOT = combineShots(distHomeSOT, distAwaySOT);

    const normShots = distTotalShots.map(p => p / Math.max(1e-10, distTotalShots.reduce((s, v) => s + v, 0)));
    const normSOT = distTotalSOT.map(p => p / Math.max(1e-10, distTotalSOT.reduce((s, v) => s + v, 0)));

    const cdfShots = (t: number) => normShots.reduce((s, p, k) => k > t ? s + p : s, 0);
    const cdfSOT = (t: number) => normSOT.reduce((s, p, k) => k > t ? s + p : s, 0);
    const cdfHomeSh = (t: number) => distHomeShots.reduce((s, p, k) => k > t ? s + p : s, 0);
    const cdfAwaySh = (t: number) => distAwayShots.reduce((s, p, k) => k > t ? s + p : s, 0);
    const cdfHomeSOT = (t: number) => distHomeSOT.reduce((s, p, k) => k > t ? s + p : s, 0);
    const cdfAwaySOT = (t: number) => distAwaySOT.reduce((s, p, k) => k > t ? s + p : s, 0);

    const fmt = (n: number) => parseFloat(n.toFixed(4));

    return {
      home: {
        totalShots: {
          expected: parseFloat(muHome.toFixed(2)),
          variance: parseFloat((muHome + muHome ** 2 / rHome).toFixed(2)),
          distribution: Object.fromEntries(distHomeShots.slice(0, 25).map((p, k) => [k, parseFloat(p.toFixed(4))]))
        },
        shotsOnTarget: {
          expected: parseFloat(muHomSOT.toFixed(2)),
          distribution: Object.fromEntries(distHomeSOT.slice(0, 15).map((p, k) => [k, parseFloat(p.toFixed(4))]))
        },
        overUnder: {
          shots: {
            over85: fmt(cdfHomeSh(8.5)), over105: fmt(cdfHomeSh(10.5)),
            over125: fmt(cdfHomeSh(12.5)), over145: fmt(cdfHomeSh(14.5)),
            over165: fmt(cdfHomeSh(16.5))
          },
          onTarget: {
            over25: fmt(cdfHomeSOT(2.5)), over35: fmt(cdfHomeSOT(3.5)),
            over45: fmt(cdfHomeSOT(4.5)), over55: fmt(cdfHomeSOT(5.5)),
            over65: fmt(cdfHomeSOT(6.5))
          }
        }
      },
      away: {
        totalShots: {
          expected: parseFloat(muAway.toFixed(2)),
          variance: parseFloat((muAway + muAway ** 2 / rAway).toFixed(2)),
          distribution: Object.fromEntries(distAwayShots.slice(0, 25).map((p, k) => [k, parseFloat(p.toFixed(4))]))
        },
        shotsOnTarget: {
          expected: parseFloat(muAwaSOT.toFixed(2)),
          distribution: Object.fromEntries(distAwaySOT.slice(0, 15).map((p, k) => [k, parseFloat(p.toFixed(4))]))
        },
        overUnder: {
          shots: {
            over55: fmt(cdfAwaySh(5.5)), over75: fmt(cdfAwaySh(7.5)),
            over95: fmt(cdfAwaySh(9.5)), over115: fmt(cdfAwaySh(11.5)),
            over135: fmt(cdfAwaySh(13.5))
          },
          onTarget: {
            over15: fmt(cdfAwaySOT(1.5)), over25: fmt(cdfAwaySOT(2.5)),
            over35: fmt(cdfAwaySOT(3.5)), over45: fmt(cdfAwaySOT(4.5)),
            over55: fmt(cdfAwaySOT(5.5))
          }
        }
      },
      combined: {
        totalShots: { expected: parseFloat((muHome + muAway).toFixed(2)) },
        overUnder: {
          over195: fmt(cdfShots(19.5)), over225: fmt(cdfShots(22.5)),
          over255: fmt(cdfShots(25.5)), over285: fmt(cdfShots(28.5)),
          under195: fmt(1 - cdfShots(19.5)), under225: fmt(1 - cdfShots(22.5)),
          under255: fmt(1 - cdfShots(25.5)), under285: fmt(1 - cdfShots(28.5)),
        },
        totalOnTarget: { expected: parseFloat((muHomSOT + muAwaSOT).toFixed(2)) },
        onTargetOverUnder: {
          over75: fmt(cdfSOT(7.5)), over95: fmt(cdfSOT(9.5)), over115: fmt(cdfSOT(11.5)),
          under75: fmt(1 - cdfSOT(7.5)), under95: fmt(1 - cdfSOT(9.5)), under115: fmt(1 - cdfSOT(11.5)),
        }
      }
    };
  }

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
  predictPlayerShots(
    profile: PlayerShotProfile,
    isHome: boolean,
    defenceQuality: number = 1.0,
    isLikelyStarter: boolean = true,
    expectedMinutes: number = 90,
    minutesUncertainty: number = 0.15,
    options: PlayerShotsPredictionOptions = {}
  ): PlayerShotPrediction {
    // --- minutesFactor con banda di incertezza (distribuzione triangolare) ---
    const clampedMinutes = Math.max(1, Math.min(90, expectedMinutes));
    const minMins  = clampedMinutes * (1 - minutesUncertainty);
    const maxMins  = Math.min(90, clampedMinutes * (1 + minutesUncertainty));
    const modeMins = clampedMinutes;

    // Media della distribuzione triangolare
    const avgMinutes = (minMins + maxMins + modeMins) / 3;
    const minutesFactor = avgMinutes / 90;

    // Varianza della distribuzione triangolare (normalizzata per 90)
    const minF  = minMins  / 90;
    const maxF  = maxMins  / 90;
    const modeF = modeMins / 90;
    const varMinutesFactor =
      (minF * minF + maxF * maxF + modeF * modeF - minF * maxF - minF * modeF - maxF * modeF) / 18;
    // Shift di π proporzionale alla deviazione standard dei minuti:
    // più incertezza sui minuti → più probabilità di 0 tiri per interruzione anticipata
    const VARIANCE_SHIFT = 0.4;
    const minutesVariancePenalty = VARIANCE_SHIFT * Math.sqrt(Math.max(0, varMinutesFactor));

    // Scala π in base ai minuti attesi (media) + penalità varianza
    const adjustedPi = Math.min(0.98, profile.zipPi + (1 - minutesFactor) * 0.3 + minutesVariancePenalty);

    // λ si scala con: casa/trasferta, qualità difesa, minutesFactor medio
    const teamInfluenceWeight = options.teamInfluenceWeight ?? predictionEngineConfig.playerShots.teamInfluenceWeight;
    const minTeamInfluenceMultiplier = options.minTeamInfluenceMultiplier ?? predictionEngineConfig.playerShots.minTeamInfluenceMultiplier;
    const maxTeamInfluenceMultiplier = options.maxTeamInfluenceMultiplier ?? predictionEngineConfig.playerShots.maxTeamInfluenceMultiplier;
    const teamShotEnvironmentMultiplier =
      options.teamShotsMean && options.leagueAvgTeamShots && options.leagueAvgTeamShots > 0
        ? Math.max(
            minTeamInfluenceMultiplier,
            Math.min(
              maxTeamInfluenceMultiplier,
              1 + teamInfluenceWeight * ((options.teamShotsMean / options.leagueAvgTeamShots) - 1)
            )
          )
        : 1;

    const locationMult = isHome ? profile.homeMultiplier : 1.0;
    const adjustedLambda = profile.zipLambda * locationMult * defenceQuality * minutesFactor * teamShotEnvironmentMultiplier;

    // Se probabile panchina: π molto alta (80%+ probabilità di 0 tiri)
    const finalPi = isLikelyStarter ? adjustedPi : Math.min(0.95, adjustedPi + 0.4);
    const finalLambda = Math.max(0.1, adjustedLambda);

    // Tiri in porta: stessa logica con lambda ridotto
    const sotLambda = Math.max(0.05, profile.onTargetLambda * locationMult * defenceQuality * minutesFactor * teamShotEnvironmentMultiplier);
    const sotVariancePenalty = minutesVariancePenalty * 0.8; // attenuato per SOT
    const sotPi = Math.min(0.99, profile.onTargetPi + (1 - minutesFactor) * 0.25 + sotVariancePenalty);

    // Distribuzione shots
    const maxK = 8;
    const modelUsed = options.playerShotsDistribution ?? predictionEngineConfig.playerShots.playerShotsDistribution;
    const dispersion = Math.max(0.5, options.dispersion ?? 8);
    const shotDist = modelUsed === 'ZINB'
      ? this.generateZINBDistribution(finalPi, finalLambda, dispersion, maxK)
      : this.generateZIPDistribution(finalPi, finalLambda, maxK);
    const sotDist  = modelUsed === 'ZINB'
      ? this.generateZINBDistribution(sotPi, sotLambda, Math.max(0.5, dispersion * 0.8), maxK)
      : this.generateZIPDistribution(sotPi, sotLambda, maxK);

    const shotTotal = Math.max(1e-10, shotDist.reduce((s, v) => s + v, 0));
    const sotTotal = Math.max(1e-10, sotDist.reduce((s, v) => s + v, 0));
    const normShot = shotDist.map(p => p / shotTotal);
    const normSOT  = sotDist.map(p => p / sotTotal);

    const cdfShot = (t: number) => normShot.reduce((s, p, k) => k > t ? s + p : s, 0);
    const cdfSOT  = (t: number) => normSOT.reduce((s, p, k)  => k > t ? s + p : s, 0);

    const expectedShots    = (1 - finalPi) * finalLambda;
    const expectedOnTarget = (1 - sotPi)   * sotLambda;

    // Confidenza: sigmoide su sample size — invariata
    const confidence = Math.min(0.90, 1 / (1 + Math.exp(-(profile.sampleSize - 10) / 7)));

    const fmt = (n: number) => parseFloat(n.toFixed(4));

    return {
      playerId:    profile.playerId,
      playerName:  profile.playerName,
      teamId:      profile.teamId,
      position:    profile.position,
      expectedShots:    parseFloat(expectedShots.toFixed(3)),
      expectedOnTarget: parseFloat(expectedOnTarget.toFixed(3)),
      shotDistribution:     Object.fromEntries(normShot.map((p, k) => [k, fmt(p)])),
      onTargetDistribution: Object.fromEntries(normSOT.map((p, k)  => [k, fmt(p)])),
      markets: {
        over05shots:    fmt(cdfShot(0.5)),
        over15shots:    fmt(cdfShot(1.5)),
        over25shots:    fmt(cdfShot(2.5)),
        over35shots:    fmt(cdfShot(3.5)),
        over05onTarget: fmt(cdfSOT(0.5)),
        over15onTarget: fmt(cdfSOT(1.5)),
        over25onTarget: fmt(cdfSOT(2.5)),
        zeroShots:      fmt(normShot[0] ?? 1),
      },
      confidenceLevel: parseFloat(confidence.toFixed(3)),
      sampleSize: profile.sampleSize,
      modelUsed,
      expectedValue: parseFloat(expectedShots.toFixed(3)),
      fullDistribution: Object.fromEntries(normShot.map((p, k) => [k, fmt(p)])),
      probabilityOver0_5: fmt(cdfShot(0.5)),
      probabilityOver1_5: fmt(cdfShot(1.5)),
      probabilityOver2_5: fmt(cdfShot(2.5)),
      confidence: parseFloat(confidence.toFixed(3)),
    };
  }

  predictPlayerShotsOnTarget(
    profile: PlayerShotProfile,
    options: PlayerShotsOnTargetOptions = {}
  ): PlayerShotsOnTargetPrediction {
    const minutes = this.estimateMinutesDistribution({
      mode: options.minutesDistributionMode ?? 'triangular',
      expectedMinutes: options.expectedMinutes ?? profile.avgMinutesPlayed ?? 75,
      observations: options.minutesObservations,
      isLikelyStarter: options.isLikelyStarter,
      asOf: options.asOf,
    });
    const minutesFactor = minutes.minutesFactor;
    const locationMult = options.isHome ? profile.homeMultiplier : 1;
    const leagueAccuracy = this.clamp(options.leagueAvgShotAccuracy ?? 0.34, 0.10, 0.65);
    const sampleWeight = this.clamp(profile.sampleSize / 25, 0, 1);
    const rawAccuracy = this.clamp(options.historicalShotAccuracy ?? leagueAccuracy, 0.05, 0.85);
    const shrinkedAccuracy = sampleWeight * rawAccuracy + (1 - sampleWeight) * leagueAccuracy;
    const accuracyMultiplier = this.clamp(shrinkedAccuracy / leagueAccuracy, 0.75, 1.25);

    const leagueTeamSot = Math.max(0.5, options.leagueAvgTeamShotsOnTarget ?? 4.5);
    const teamSotMultiplier = options.teamShotsOnTargetMean
      ? this.clamp(1 + 0.30 * ((options.teamShotsOnTargetMean / leagueTeamSot) - 1), 0.75, 1.25)
      : 1;
    const opponentSotMultiplier = options.opponentShotsOnTargetAllowed
      ? this.clamp(1 + 0.20 * ((options.opponentShotsOnTargetAllowed / leagueTeamSot) - 1), 0.80, 1.20)
      : 1;

    const pi = this.clamp(
      profile.onTargetPi + (1 - minutesFactor) * 0.28 + Math.sqrt(Math.max(0, minutes.varianceFactor)) * 0.30,
      0.001,
      options.isLikelyStarter === false ? 0.97 : 0.99,
    );
    const mu = Math.max(
      0.02,
      profile.onTargetLambda * minutesFactor * locationMult * teamSotMultiplier * opponentSotMultiplier * accuracyMultiplier
    );
    const modelUsed = options.playerShotsDistribution ?? predictionEngineConfig.playerShots.playerShotsDistribution;
    const dispersion = Math.max(0.5, options.dispersion ?? 10);
    const rawDist = modelUsed === 'ZINB'
      ? this.generateZINBDistribution(pi, mu, dispersion, 8)
      : this.generateZIPDistribution(pi, mu, 8);
    const dist = this.normalizeDistribution(rawDist);
    const expectedValue = (1 - pi) * mu;
    const confidence = this.clamp(
      0.25 + Math.min(0.45, profile.sampleSize / 60) + (minutes.modeUsed === 'empirical' ? 0.12 : 0) + (options.teamShotsOnTargetMean ? 0.08 : 0),
      0.10,
      0.92,
    );

    return {
      playerId: profile.playerId,
      playerName: profile.playerName,
      teamId: profile.teamId,
      position: profile.position,
      expectedValue: Number(expectedValue.toFixed(3)),
      fullDistribution: this.distributionToRecord(dist),
      probabilityOver0_5: this.probabilityOver(dist, 0.5),
      probabilityOver1_5: this.probabilityOver(dist, 1.5),
      probabilityOver2_5: this.probabilityOver(dist, 2.5),
      confidence: Number(confidence.toFixed(3)),
      sampleSize: profile.sampleSize,
      modelUsed,
    };
  }

  predictHierarchicalPlayerShots(
    teamShotsDistribution: { mean: number; dispersion?: number },
    covariates: {
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
    }
  ): HierarchicalPlayerShotsPrediction {
    const rolePriors: Record<HierarchicalPlayerRole, number> = {
      forward: 0.18,
      winger: 0.15,
      attacking_midfielder: 0.13,
      midfielder: 0.09,
      fullback: 0.06,
      centreback: 0.04,
      goalkeeper: 0.005,
      unknown: 0.08,
    };
    const role = covariates.role ?? 'unknown';
    const rolePrior = rolePriors[role] ?? rolePriors.unknown;
    const minMinutes = covariates.minMinutesForShotShare ?? 20;
    const asOf = covariates.asOf ?? new Date();
    const decayPerDay = covariates.decayPerDay ?? 0.018;
    const observations = (covariates.observations ?? [])
      .filter((obs) =>
        Number.isFinite(obs.playerShots) &&
        Number.isFinite(obs.teamShots) &&
        obs.teamShots > 0 &&
        Number(obs.playerMinutes) >= minMinutes
      )
      .map((obs) => {
        const ageDays = obs.date instanceof Date
          ? Math.max(0, (asOf.getTime() - obs.date.getTime()) / (1000 * 60 * 60 * 24))
          : 0;
        return {
          ...obs,
          weight: Math.exp(-decayPerDay * ageDays),
          share: this.clamp(obs.playerShots / Math.max(1, obs.teamShots), 0, 1),
        };
      });

    const weightedPlayerShots = observations.reduce((sum, obs) => sum + obs.playerShots * obs.weight, 0);
    const weightedTeamShots = observations.reduce((sum, obs) => sum + obs.teamShots * obs.weight, 0);
    const tauRaw = weightedTeamShots > 0 ? weightedPlayerShots / weightedTeamShots : rolePrior;
    const sampleWeight = this.clamp(observations.length / 8, 0, 1);
    const minutesMultiplier = this.clamp((covariates.expectedMinutes ?? 90) / 90, 0.10, 1.05);
    const tau = this.clamp((sampleWeight * tauRaw + (1 - sampleWeight) * rolePrior) * minutesMultiplier, 0.001, 0.65);

    const muTeam = Math.max(0.1, teamShotsDistribution.mean);
    const dispersion = Math.max(0.5, teamShotsDistribution.dispersion ?? 12);
    const teamStd = Math.sqrt(muTeam + (muTeam * muTeam) / dispersion);
    const maxTeamShots = Math.min(90, Math.max(12, Math.ceil(muTeam + 6 * teamStd)));
    const maxPlayerShots = Math.min(15, maxTeamShots);
    const playerDist = new Array(maxPlayerShots + 1).fill(0);

    const totalShareWeight = observations.reduce((sum, obs) => sum + obs.weight, 0);
    const meanShare = totalShareWeight > 0
      ? observations.reduce((sum, obs) => sum + obs.share * obs.weight, 0) / totalShareWeight
      : tau;
    const shareVariance = totalShareWeight > 0
      ? observations.reduce((sum, obs) => sum + obs.weight * (obs.share - meanShare) ** 2, 0) / totalShareWeight
      : 0;
    const baselineShareVariance = Math.max(1e-4, tau * (1 - tau) / Math.max(1, observations.length));
    const useBetaBinomial = Boolean(covariates.useBetaBinomial) && observations.length >= 4 && shareVariance > baselineShareVariance * 1.5;
    const concentration = useBetaBinomial
      ? this.clamp((tau * (1 - tau)) / Math.max(1e-4, shareVariance) - 1, 2, 80)
      : 0;
    const alpha = Math.max(0.05, tau * concentration);
    const beta = Math.max(0.05, (1 - tau) * concentration);

    for (let s = 0; s <= maxTeamShots; s++) {
      const pTeam = this.negBinPMF(s, muTeam, dispersion);
      for (let x = 0; x <= Math.min(s, maxPlayerShots); x++) {
        const conditional = useBetaBinomial
          ? this.betaBinomialPMF(x, s, alpha, beta)
          : this.binomialPMF(x, s, tau);
        playerDist[x] += pTeam * conditional;
      }
    }
    const dist = this.normalizeDistribution(playerDist);
    const expectedShots = dist.reduce((sum, p, k) => sum + p * k, 0);
    const confidence = this.clamp(0.25 + sampleWeight * 0.45 + Math.min(0.15, weightedTeamShots / 300), 0.10, 0.90);

    return {
      expectedShots: Number(expectedShots.toFixed(3)),
      expectedValue: Number(expectedShots.toFixed(3)),
      probabilityOver0_5: this.probabilityOver(dist, 0.5),
      probabilityOver1_5: this.probabilityOver(dist, 1.5),
      probabilityOver2_5: this.probabilityOver(dist, 2.5),
      fullDistribution: this.distributionToRecord(dist),
      confidence: Number(confidence.toFixed(3)),
      sampleSize: observations.length,
      modelUsed: useBetaBinomial ? 'hierarchical_beta_binomial' : 'hierarchical_binomial',
      tau: Number(tau.toFixed(6)),
    };
  }

  /**
   * Stima profilo giocatore da dati storici
   * Usa MLE per ZIP via algoritmo EM
   */
  estimatePlayerProfile(
    playerId: string,
    playerName: string,
    teamId: string,
    position: PlayerShotProfile['position'],
    shotObservations: number[],   // tiri per partita
    onTargetObservations: number[], // tiri in porta per partita
    homeShotObs: number[],         // solo partite in casa
    minutesObs: number[]           // minuti giocati per partita
  ): PlayerShotProfile {
    const { pi: shotPi, lambda: shotLambda } = this.fitZIPParameters(shotObservations);
    const { pi: sotPi, lambda: sotLambda } = this.fitZIPParameters(onTargetObservations);

    // Home multiplier: λ_casa / λ_trasferta
    const { lambda: homeLambda } = this.fitZIPParameters(homeShotObs);
    const awayObs = shotObservations.slice(Math.floor(shotObservations.length / 2)); // approssimazione
    const { lambda: awayLambda } = this.fitZIPParameters(awayObs);
    const homeMultiplier = awayLambda > 0 ? homeLambda / awayLambda : 1.1;

    const avgMinutes = minutesObs.length > 0
      ? minutesObs.reduce((s, m) => s + m, 0) / minutesObs.length
      : 85;

    return {
      playerId, playerName, teamId, position,
      zipPi: shotPi, zipLambda: shotLambda,
      onTargetPi: sotPi, onTargetLambda: sotLambda,
      avgMinutesPlayed: avgMinutes,
      homeMultiplier: Math.max(0.7, Math.min(1.5, homeMultiplier)),
      avgShotsVsTopDefence: shotLambda * 0.75,
      avgShotsVsWeakDefence: shotLambda * 1.30,
      sampleSize: shotObservations.length,
      lastUpdated: new Date()
    };
  }
}
