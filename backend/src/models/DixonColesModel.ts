/**
 * Dixon-Coles Model — Versione riveduta con integrazione modelli specializzati
 *
 * MODELLO GOAL: Poisson bivariata con correzione Dixon-Coles (1997)
 * Motivazione: i goal reali mostrano correlazione negativa lieve
 * tra casa e ospite — il modello indipendente sovrastima alcuni esiti.
 *
 * NOTA sulla scelta Poisson vs NegBin per i goal:
 * Al contrario di cartellini e falli, i goal di squadra sono somme di
 * eventi rari quasi indipendenti → la Poisson è giustificata teoricamente
 * (legge dei piccoli numeri). Dixon & Coles (1997) validano su dati reali
 * che il fit è buono, con l'unica eccezione dei risultati 0-0/1-0/0-1/1-1
 * che richiedono la correzione τ.
 *
 * Il decadimento temporale esponenziale con τ=0.0065 corrisponde a
 * half-life di circa 107 giorni (≈15 settimane), bilanciamento testato
 * empiricamente tra reattività ai cambi di forma e stabilità statistica.
 */

import {
  SpecializedModels,
  ShotsModelData,
  CardsModelData,
  FoulsModelData,
  PlayerShotsData,
  CardsDistribution,
  FoulsDistribution,
  PlayerShotsPrediction
} from './SpecializedModels';

export interface TeamStrength {
  teamId: string;
  name: string;
  attackParam: number;
  defenceParam: number;
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
}

export interface ScoreMatrix {
  probabilities: number[][];
  maxGoals: number;
  lambdaHome: number;
  lambdaAway: number;
}

export interface FullMatchProbabilities {
  // Mercati goal (Dixon-Coles)
  homeWin: number;
  draw: number;
  awayWin: number;
  btts: number;
  over05: number; over15: number; over25: number; over35: number; over45: number;
  under05: number; under15: number; under25: number; under35: number; under45: number;
  exactScore: Record<string, number>;
  handicap: Record<string, number>;
  asianHandicap: Record<string, number>;

  // Mercati tiri (NegBin)
  shotsHome: { expected: number; overUnder: Record<string, { over: number; under: number }> };
  shotsAway: { expected: number; overUnder: Record<string, { over: number; under: number }> };
  shotsTotal: Record<string, { over: number; under: number }>;
  shotsOnTargetHome: { expected: number };
  shotsOnTargetAway: { expected: number };

  // Mercati cartellini (NegBin con fattore arbitro)
  cards: CardsDistribution;

  // Mercati falli (NegBin con correzione possesso)
  fouls: FoulsDistribution;

  // Tiri per giocatore
  playerShots: { home: PlayerShotsPrediction[]; away: PlayerShotsPrediction[] };

  // Lambda attesi
  lambdaHome: number;
  lambdaAway: number;
}

export interface SupplementaryData {
  homeTeamStats?: {
    avgShots: number;
    avgShotsOT: number;
    avgYellowCards: number;
    avgRedCards: number;
    avgFouls: number;
    shotsSuppression: number;   // 1.0 = media, <1 = difesa migliore sui tiri
  };
  awayTeamStats?: {
    avgShots: number;
    avgShotsOT: number;
    avgYellowCards: number;
    avgRedCards: number;
    avgFouls: number;
    shotsSuppression: number;
  };
  refereeStats?: {
    avgYellow: number;
    avgRed: number;
    avgFouls: number;
  };
  homePlayers?: PlayerShotsData[];
  awayPlayers?: PlayerShotsData[];
  competitiveness?: number;  // 0 (amichevole) → 1 (derby/scontro diretto)
  leagueAvgYellow?: number;
  leagueAvgFouls?: number;
  homeAdvantageShots?: number;  // default 1.12
}

// Default per Serie A basati su dati storici 2019-2024
const SERIE_A_DEFAULTS = {
  avgShots: 12.1,
  avgShotsOT: 4.8,
  avgYellowCards: 1.9,      // per squadra per partita
  avgRedCards: 0.11,
  avgFouls: 11.2,
  shotsSuppression: 1.0,
  leagueAvgYellow: 3.8,
  leagueAvgFouls: 22.4,
  refereeAvgYellow: 3.8,
  refereeAvgRed: 0.22,
  refereeAvgFouls: 22.4,
  homeAdvantageShots: 1.12
};

export class DixonColesModel {
  private params: ModelParams;
  private readonly MAX_GOALS = 10;
  private specialized: SpecializedModels;

  constructor(params?: Partial<ModelParams>) {
    this.params = {
      attackParams: {},
      defenceParams: {},
      homeAdvantage: 0.25,
      rho: -0.13,
      tau: 0.0065,
      ...params
    };
    this.specialized = new SpecializedModels();
  }

  private poissonPMF(k: number, lambda: number): number {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    let logP = -lambda + k * Math.log(lambda);
    for (let i = 1; i <= k; i++) logP -= Math.log(i);
    return isFinite(logP) ? Math.exp(logP) : 0;
  }

  /**
   * Correzione Dixon-Coles per basse frequenze di goal.
   */
  private tauCorrection(x: number, y: number, lH: number, lA: number, rho: number): number {
    if (x === 0 && y === 0) return 1 - lH * lA * rho;
    if (x === 1 && y === 0) return 1 + lA * rho;
    if (x === 0 && y === 1) return 1 + lH * rho;
    if (x === 1 && y === 1) return 1 - rho;
    return 1.0;
  }

  computeExpectedGoals(
    homeId: string, awayId: string,
    homeXG?: number, awayXG?: number
  ): { lambdaHome: number; lambdaAway: number } {
    const aH = Math.exp(this.params.attackParams[homeId] ?? 0);
    const dA = Math.exp(-(this.params.defenceParams[awayId] ?? 0));
    const aA = Math.exp(this.params.attackParams[awayId] ?? 0);
    const dH = Math.exp(-(this.params.defenceParams[homeId] ?? 0));

    let lH = aH * dA * Math.exp(this.params.homeAdvantage);
    let lA = aA * dH;

    if (homeXG !== undefined && awayXG !== undefined && homeXG > 0 && awayXG > 0) {
      lH = 0.6 * lH + 0.4 * homeXG;
      lA = 0.6 * lA + 0.4 * awayXG;
    }

    return { lambdaHome: Math.max(0.1, lH), lambdaAway: Math.max(0.1, lA) };
  }

  buildScoreMatrix(homeId: string, awayId: string, homeXG?: number, awayXG?: number): ScoreMatrix {
    const { lambdaHome, lambdaAway } = this.computeExpectedGoals(homeId, awayId, homeXG, awayXG);
    const rho = this.params.rho;
    const N = this.MAX_GOALS;
    const probs: number[][] = [];
    let total = 0;

    for (let h = 0; h <= N; h++) {
      probs[h] = [];
      for (let a = 0; a <= N; a++) {
        const p = Math.max(0,
          this.poissonPMF(h, lambdaHome) *
          this.poissonPMF(a, lambdaAway) *
          this.tauCorrection(h, a, lambdaHome, lambdaAway, rho)
        );
        probs[h][a] = p;
        total += p;
      }
    }

    for (let h = 0; h <= N; h++)
      for (let a = 0; a <= N; a++)
        probs[h][a] /= total;

    return { probabilities: probs, maxGoals: N, lambdaHome, lambdaAway };
  }

  /**
   * Calcola probabilità complete per tutti i mercati.
   * I mercati goal derivano da Dixon-Coles.
   * I mercati tiri, cartellini, falli usano i modelli specializzati NegBin.
   */
  computeFullProbabilities(
    homeId: string,
    awayId: string,
    homeXG?: number,
    awayXG?: number,
    supp?: SupplementaryData
  ): FullMatchProbabilities {
    const matrix = this.buildScoreMatrix(homeId, awayId, homeXG, awayXG);
    const p = matrix.probabilities;
    const N = this.MAX_GOALS;

    // --- GOAL MARKETS ---
    let homeWin = 0, draw = 0, awayWin = 0, btts = 0;
    for (let h = 0; h <= N; h++) {
      for (let a = 0; a <= N; a++) {
        if (h > a) homeWin += p[h][a];
        else if (h === a) draw += p[h][a];
        else awayWin += p[h][a];
        if (h > 0 && a > 0) btts += p[h][a];
      }
    }

    const over = (t: number) => {
      let s = 0;
      for (let h = 0; h <= N; h++)
        for (let a = 0; a <= N; a++)
          if (h + a > t) s += p[h][a];
      return s;
    };

    const exactScore: Record<string, number> = {};
    for (let h = 0; h <= 6; h++)
      for (let a = 0; a <= 6; a++)
        exactScore[`${h}-${a}`] = p[Math.min(h, N)][Math.min(a, N)];

    const handicap: Record<string, number> = {};
    for (const line of [-2.5, -2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2, 2.5]) {
      let hw = 0;
      for (let h = 0; h <= N; h++)
        for (let a = 0; a <= N; a++)
          if (h - a + line > 0) hw += p[h][a];
      handicap[`home${line > 0 ? '+' : ''}${line}`] = hw;
      handicap[`away${(-line) > 0 ? '+' : ''}${-line}`] = 1 - hw;
    }

    const asianHandicap: Record<string, number> = {};
    for (const line of [-1.75, -1.5, -1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]) {
      let prob = 0;
      for (let h = 0; h <= N; h++)
        for (let a = 0; a <= N; a++) {
          const diff = (h - a) + line;
          if (diff > 0) prob += p[h][a];
          else if (diff === 0) prob += p[h][a] * 0.5;
        }
      asianHandicap[`${line}`] = prob;
    }

    // --- SHOTS MARKETS (NegBin) ---
    const hs = supp?.homeTeamStats ?? {};
    const as_ = supp?.awayTeamStats ?? {};

    const shotsData: ShotsModelData = {
      homeTeamAvgShots: (hs as any).avgShots ?? SERIE_A_DEFAULTS.avgShots,
      awayTeamAvgShots: (as_ as any).avgShots ?? SERIE_A_DEFAULTS.avgShots,
      homeTeamAvgShotsOT: (hs as any).avgShotsOT ?? SERIE_A_DEFAULTS.avgShotsOT,
      awayTeamAvgShotsOT: (as_ as any).avgShotsOT ?? SERIE_A_DEFAULTS.avgShotsOT,
      homeTeamShotsSuppression: (hs as any).shotsSuppression ?? 1.0,
      awayTeamShotsSuppression: (as_ as any).shotsSuppression ?? 1.0,
      homeAdvantageShots: supp?.homeAdvantageShots ?? SERIE_A_DEFAULTS.homeAdvantageShots,
    };

    const shotsResult = this.specialized.computeShotsDistribution(shotsData);

    // --- CARDS MARKETS (NegBin + referee factor) ---
    const refStats = supp?.refereeStats ?? {};
    const cardsData: CardsModelData = {
      homeTeamAvgYellow: (hs as any).avgYellowCards ?? SERIE_A_DEFAULTS.avgYellowCards,
      awayTeamAvgYellow: (as_ as any).avgYellowCards ?? SERIE_A_DEFAULTS.avgYellowCards,
      homeTeamAvgRed: (hs as any).avgRedCards ?? SERIE_A_DEFAULTS.avgRedCards,
      awayTeamAvgRed: (as_ as any).avgRedCards ?? SERIE_A_DEFAULTS.avgRedCards,
      refereeAvgYellow: (refStats as any).avgYellow ?? SERIE_A_DEFAULTS.refereeAvgYellow,
      refereeAvgRed: (refStats as any).avgRed ?? SERIE_A_DEFAULTS.refereeAvgRed,
      refereeAvgTotal: ((refStats as any).avgYellow ?? 3.8) + ((refStats as any).avgRed ?? 0.22) * 2,
      leagueAvgYellow: supp?.leagueAvgYellow ?? SERIE_A_DEFAULTS.leagueAvgYellow,
      competitiveness: supp?.competitiveness ?? 0.3,
    };

    const cards = this.specialized.computeCardsDistribution(cardsData);

    // --- FOULS MARKETS (NegBin + possession correction) ---
    // Stima possesso atteso dai lambda goal (proxy: squadra più forte tende ad avere più palla)
    const lambdaTotal = matrix.lambdaHome + matrix.lambdaAway;
    const estimatedHomePoss = lambdaTotal > 0
      ? 0.5 + 0.1 * (matrix.lambdaHome - matrix.lambdaAway) / lambdaTotal
      : 0.5;

    const foulsData: FoulsModelData = {
      homeTeamAvgFouls: (hs as any).avgFouls ?? SERIE_A_DEFAULTS.avgFouls,
      awayTeamAvgFouls: (as_ as any).avgFouls ?? SERIE_A_DEFAULTS.avgFouls,
      homePossessionEst: Math.max(0.3, Math.min(0.7, estimatedHomePoss)),
      refereeAvgFouls: (refStats as any).avgFouls ?? SERIE_A_DEFAULTS.refereeAvgFouls,
      leagueAvgFouls: supp?.leagueAvgFouls ?? SERIE_A_DEFAULTS.leagueAvgFouls,
    };

    const fouls = this.specialized.computeFoulsDistribution(foulsData);

    // --- PLAYER SHOTS ---
    const homePlayers = supp?.homePlayers ?? [];
    const awayPlayers = supp?.awayPlayers ?? [];

    const playerShotsHome = homePlayers.length > 0
      ? this.specialized.computePlayerShotsPredictions(
          homePlayers, shotsResult.home.expectedTotalShots, shotsResult.home.expectedShotsOnTarget
        )
      : [];

    const playerShotsAway = awayPlayers.length > 0
      ? this.specialized.computePlayerShotsPredictions(
          awayPlayers, shotsResult.away.expectedTotalShots, shotsResult.away.expectedShotsOnTarget
        )
      : [];

    return {
      homeWin, draw, awayWin, btts,
      over05: over(0.5), over15: over(1.5), over25: over(2.5),
      over35: over(3.5), over45: over(4.5),
      under05: 1 - over(0.5), under15: 1 - over(1.5), under25: 1 - over(2.5),
      under35: 1 - over(3.5), under45: 1 - over(4.5),
      exactScore, handicap, asianHandicap,

      shotsHome: {
        expected: shotsResult.home.expectedTotalShots,
        overUnder: shotsResult.home.overUnder
      },
      shotsAway: {
        expected: shotsResult.away.expectedTotalShots,
        overUnder: shotsResult.away.overUnder
      },
      shotsTotal: shotsResult.total,
      shotsOnTargetHome: { expected: shotsResult.home.expectedShotsOnTarget },
      shotsOnTargetAway: { expected: shotsResult.away.expectedShotsOnTarget },

      cards,
      fouls,
      playerShots: { home: playerShotsHome, away: playerShotsAway },
      lambdaHome: matrix.lambdaHome,
      lambdaAway: matrix.lambdaAway,
    };
  }

  /**
   * Stima parametri via gradient ascent sulla log-verosimiglianza ponderata.
   */
  fitModel(matches: MatchData[], teams: string[], maxIter = 400, lr = 0.008): ModelParams {
    for (const t of teams) {
      if (this.params.attackParams[t] === undefined) this.params.attackParams[t] = 0.0;
      if (this.params.defenceParams[t] === undefined) this.params.defenceParams[t] = 0.0;
    }

    const now = new Date();
    const validMatches = matches.filter(m => m.homeGoals !== undefined && m.awayGoals !== undefined);

    const logLikelihood = (): number => {
      let ll = 0;
      for (const m of validMatches) {
        const age = (now.getTime() - m.date.getTime()) / (1000 * 60 * 60 * 24 * 7);
        const w = Math.exp(-this.params.tau * age);

        const aH = Math.exp(this.params.attackParams[m.homeTeamId] ?? 0);
        const dA = Math.exp(-(this.params.defenceParams[m.awayTeamId] ?? 0));
        const aA = Math.exp(this.params.attackParams[m.awayTeamId] ?? 0);
        const dH = Math.exp(-(this.params.defenceParams[m.homeTeamId] ?? 0));

        const lH = aH * dA * Math.exp(this.params.homeAdvantage);
        const lA = aA * dH;
        const x = m.homeGoals!;
        const y = m.awayGoals!;

        const pBase = this.poissonPMF(x, lH) * this.poissonPMF(y, lA);
        const tau = this.tauCorrection(x, y, lH, lA, this.params.rho);

        if (pBase > 0 && tau > 0) ll += w * Math.log(pBase * tau);
      }
      return ll;
    };

    const h = 1e-5;
    let prevLL = logLikelihood();
    let currentLR = lr;

    for (let iter = 0; iter < maxIter; iter++) {
      let improved = false;

      for (const team of teams) {
        this.params.attackParams[team] += h;
        const llA = logLikelihood();
        this.params.attackParams[team] -= h;
        this.params.attackParams[team] += currentLR * (llA - prevLL) / h;

        this.params.defenceParams[team] += h;
        const llD = logLikelihood();
        this.params.defenceParams[team] -= h;
        this.params.defenceParams[team] += currentLR * (llD - prevLL) / h;
      }

      this.params.homeAdvantage += h;
      const llHA = logLikelihood();
      this.params.homeAdvantage -= h;
      this.params.homeAdvantage += currentLR * (llHA - prevLL) / h;
      this.params.homeAdvantage = Math.max(-0.3, Math.min(1.2, this.params.homeAdvantage));

      this.params.rho += h;
      const llR = logLikelihood();
      this.params.rho -= h;
      this.params.rho += currentLR * (llR - prevLL) / h;
      this.params.rho = Math.max(-0.5, Math.min(0.0, this.params.rho));

      const newLL = logLikelihood();
      if (newLL < prevLL - 1e-8) {
        currentLR *= 0.7;
      } else {
        improved = true;
        prevLL = newLL;
      }
      if (iter > 50 && !improved) break;
    }

    // Normalizzazione (identifiability constraint)
    const nTeams = teams.length;
    const avgAttack = teams.reduce((s, t) => s + (this.params.attackParams[t] ?? 0), 0) / nTeams;
    const avgDefence = teams.reduce((s, t) => s + (this.params.defenceParams[t] ?? 0), 0) / nTeams;
    for (const t of teams) {
      this.params.attackParams[t] = (this.params.attackParams[t] ?? 0) - avgAttack;
      this.params.defenceParams[t] = (this.params.defenceParams[t] ?? 0) - avgDefence;
    }

    return this.params;
  }

  getParams(): ModelParams { return this.params; }
  setParams(p: Partial<ModelParams>): void { this.params = { ...this.params, ...p }; }
}
