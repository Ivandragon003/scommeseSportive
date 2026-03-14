/**
 * Dixon-Coles Model — v3
 *
 * MODIFICHE rispetto all'originale:
 *
 * 1. homeAdvantage default: 0.15 (era 0.25)
 *    I dati Serie A 2020-2024 mostrano un vantaggio casa ridotto.
 *    0.15 ≈ +16% goal attesi in casa vs trasferta (era +28%).
 *
 * 2. computeFullProbabilities ora restituisce flatProbabilities:
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

import {
  SpecializedModels,
  ShotsModelData,
  CardsModelData,
  FoulsModelData,
  PlayerShotsData,
  CardsDistribution,
  FoulsDistribution,
  PlayerShotsPrediction,
  NegBinParams,
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
  // Goal markets
  homeWin: number; draw: number; awayWin: number; btts: number;
  over05: number; over15: number; over25: number; over35: number; over45: number;
  under05: number; under15: number; under25: number; under35: number; under45: number;
  exactScore: Record<string, number>;
  handicap: Record<string, number>;
  asianHandicap: Record<string, number>;
  // Shot markets
  shotsHome: {
    expected: number;
    overUnder: Record<string, { over: number; under: number }>;
    totalShots: { expected: number; variance: number; distribution: Record<string, number> };
    shotsOnTarget: { expected: number; variance: number; distribution: Record<string, number> };
    negBinParams: NegBinParams;
  };
  shotsAway: {
    expected: number;
    overUnder: Record<string, { over: number; under: number }>;
    totalShots: { expected: number; variance: number; distribution: Record<string, number> };
    shotsOnTarget: { expected: number; variance: number; distribution: Record<string, number> };
    negBinParams: NegBinParams;
  };
  shotsTotal: Record<string, { over: number; under: number }>;
  shotsOnTargetHome: { expected: number; variance: number; distribution: Record<string, number> };
  shotsOnTargetAway: { expected: number; variance: number; distribution: Record<string, number> };
  // Cards & fouls
  cards: CardsDistribution;
  fouls: FoulsDistribution;
  corners?: {
    expectedHomeCorners: number;
    expectedAwayCorners: number;
    expectedTotalCorners: number;
    overUnder: Record<string, { over: number; under: number }>;
    negBinParams: { mu: number; r: number };
  };
  // Player shots
  playerShots: { home: PlayerShotsPrediction[]; away: PlayerShotsPrediction[] };
  // Expected goals
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
    avgPossession?: number;
    // Varianza per r dinamico in SpecializedModels
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
  competitiveness?: number;   // 0 = amichevole, 1 = derby storico
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

// Default Serie A 2019-2024
const SERIE_A_DEFAULTS = {
  avgShots: 12.1,
  avgShotsOT: 4.8,
  avgYellowCards: 1.9,
  avgRedCards: 0.11,
  avgFouls: 11.2,
  shotsSuppression: 1.0,
  leagueAvgYellow: 3.8,
  leagueAvgFouls: 22.4,
  refereeAvgYellow: 3.8,
  refereeAvgRed: 0.22,
  refereeAvgFouls: 22.4,
  homeAdvantageShots: 1.12,
};

export class DixonColesModel {
  private params: ModelParams;
  private readonly MAX_GOALS   = 10;
  private readonly PARAM_BOUND = 3.5;
  private readonly LAMBDA_MIN  = 0.05;
  private readonly LAMBDA_MAX  = 6.0;
  private specialized: SpecializedModels;

  constructor(params?: Partial<ModelParams>) {
    this.params = {
      attackParams:  {},
      defenceParams: {},
      homeAdvantage: 0.15,   // v3: ridotto da 0.25
      rho:           -0.13,
      tau:           0.0065,
      ...params,
    };
    this.specialized = new SpecializedModels();
  }

  // ==================== UTILITY NUMERICA ====================

  private clamp(v: number, min: number, max: number): number {
    if (!isFinite(v)) return min;
    return Math.min(max, Math.max(min, v));
  }

  private safeExp(x: number): number {
    return Math.exp(this.clamp(x, -10, 10));
  }

  private safeProb(p: number): number {
    return !isFinite(p) || p < 0 ? 0 : p;
  }

  private poissonPMF(k: number, lambda: number): number {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    let logP = -lambda + k * Math.log(lambda);
    for (let i = 1; i <= k; i++) logP -= Math.log(i);
    return isFinite(logP) ? Math.exp(logP) : 0;
  }

  // ==================== CORREZIONE DIXON-COLES ====================

  /**
   * Correzione τ per correlazione negativa tra homeGoals e awayGoals
   * sui risultati bassi (0-0, 1-0, 0-1, 1-1).
   * Dixon & Coles 1997, eq. (2).
   */
  private tauCorrection(
    x: number, y: number,
    lH: number, lA: number,
    rho: number
  ): number {
    if (x === 0 && y === 0) return 1 - lH * lA * rho;
    if (x === 1 && y === 0) return 1 + lA * rho;
    if (x === 0 && y === 1) return 1 + lH * rho;
    if (x === 1 && y === 1) return 1 - rho;
    return 1.0;
  }

  private tauDerivative(x: number, y: number, lH: number, lA: number): number {
    if (x === 0 && y === 0) return -lH * lA;
    if (x === 1 && y === 0) return lA;
    if (x === 0 && y === 1) return lH;
    if (x === 1 && y === 1) return -1;
    return 0;
  }

  // ==================== EXPECTED GOALS ====================

  computeExpectedGoals(
    homeId: string, awayId: string,
    homeXG?: number, awayXG?: number
  ): { lambdaHome: number; lambdaAway: number } {
    const aH = this.safeExp(this.clamp(this.params.attackParams[homeId]  ?? 0, -this.PARAM_BOUND, this.PARAM_BOUND));
    const dA = this.safeExp(-this.clamp(this.params.defenceParams[awayId] ?? 0, -this.PARAM_BOUND, this.PARAM_BOUND));
    const aA = this.safeExp(this.clamp(this.params.attackParams[awayId]  ?? 0, -this.PARAM_BOUND, this.PARAM_BOUND));
    const dH = this.safeExp(-this.clamp(this.params.defenceParams[homeId] ?? 0, -this.PARAM_BOUND, this.PARAM_BOUND));

    let lH = aH * dA * this.safeExp(this.params.homeAdvantage);
    let lA = aA * dH;

    // Blend con xG se disponibile (60% modello, 40% xG)
    if (homeXG !== undefined && awayXG !== undefined && homeXG > 0 && awayXG > 0) {
      lH = 0.6 * lH + 0.4 * homeXG;
      lA = 0.6 * lA + 0.4 * awayXG;
    }

    if (!isFinite(lH) || lH <= 0) lH = 1.35;
    if (!isFinite(lA) || lA <= 0) lA = 1.05;

    return {
      lambdaHome: this.clamp(lH, this.LAMBDA_MIN, this.LAMBDA_MAX),
      lambdaAway: this.clamp(lA, this.LAMBDA_MIN, this.LAMBDA_MAX),
    };
  }

  buildScoreMatrix(
    homeId: string, awayId: string,
    homeXG?: number, awayXG?: number
  ): ScoreMatrix {
    const { lambdaHome, lambdaAway } = this.computeExpectedGoals(homeId, awayId, homeXG, awayXG);
    return this.buildScoreMatrixFromLambdas(lambdaHome, lambdaAway);
  }

  private buildScoreMatrixFromLambdas(lambdaHome: number, lambdaAway: number): ScoreMatrix {
    const rho = this.params.rho;
    const N   = this.MAX_GOALS;
    const probs: number[][] = [];
    let total = 0;

    for (let h = 0; h <= N; h++) {
      probs[h] = [];
      for (let a = 0; a <= N; a++) {
        const p = this.safeProb(
          this.poissonPMF(h, lambdaHome) *
          this.poissonPMF(a, lambdaAway) *
          this.tauCorrection(h, a, lambdaHome, lambdaAway, rho)
        );
        probs[h][a] = p;
        total += p;
      }
    }

    if (!isFinite(total) || total <= 0) {
      for (let h = 0; h <= N; h++) for (let a = 0; a <= N; a++) probs[h][a] = 0;
      probs[0][0] = 1; total = 1;
    }
    for (let h = 0; h <= N; h++) for (let a = 0; a <= N; a++) probs[h][a] /= total;

    return { probabilities: probs, maxGoals: N, lambdaHome, lambdaAway };
  }

  // ==================== PROBABILITÀ COMPLETE ====================

  computeFullProbabilities(
    homeId: string, awayId: string,
    homeXG?: number, awayXG?: number,
    supp?: SupplementaryData
  ): FullMatchProbabilities {
    const context = supp?.contextAdjustments ?? {};
    const baseMatrix = this.buildScoreMatrix(homeId, awayId, homeXG, awayXG);
    const adjustedLambdaHome = this.clamp(
      baseMatrix.lambdaHome * (context.homeGoalMultiplier ?? 1),
      this.LAMBDA_MIN,
      this.LAMBDA_MAX,
    );
    const adjustedLambdaAway = this.clamp(
      baseMatrix.lambdaAway * (context.awayGoalMultiplier ?? 1),
      this.LAMBDA_MIN,
      this.LAMBDA_MAX,
    );

    const matrix: ScoreMatrix =
      adjustedLambdaHome === baseMatrix.lambdaHome && adjustedLambdaAway === baseMatrix.lambdaAway
        ? baseMatrix
        : this.buildScoreMatrixFromLambdas(adjustedLambdaHome, adjustedLambdaAway);

    const p = matrix.probabilities;
    const N = this.MAX_GOALS;

    // --- Goal markets ---
    let homeWin = 0, draw = 0, awayWin = 0, btts = 0;
    for (let h = 0; h <= N; h++) for (let a = 0; a <= N; a++) {
      if      (h > a)  homeWin += p[h][a];
      else if (h === a) draw   += p[h][a];
      else              awayWin += p[h][a];
      if (h > 0 && a > 0) btts += p[h][a];
    }

    const over = (t: number): number => {
      let s = 0;
      for (let h = 0; h <= N; h++) for (let a = 0; a <= N; a++) if (h + a > t) s += p[h][a];
      return s;
    };

    const o05 = over(0.5), o15 = over(1.5), o25 = over(2.5), o35 = over(3.5), o45 = over(4.5);

    // Exact score
    const exactScore: Record<string, number> = {};
    for (let h = 0; h <= 6; h++) for (let a = 0; a <= 6; a++)
      exactScore[`${h}-${a}`] = p[Math.min(h, N)][Math.min(a, N)];

    // Handicap europeo
    const handicap: Record<string, number> = {};
    for (const line of [-2.5,-2,-1.5,-1,-0.5,0.5,1,1.5,2,2.5]) {
      let hw = 0;
      for (let h = 0; h <= N; h++) for (let a = 0; a <= N; a++)
        if (h - a + line > 0) hw += p[h][a];
      handicap[`home${line > 0 ? '+' : ''}${line}`] = hw;
      handicap[`away${(-line) > 0 ? '+' : ''}${-line}`] = 1 - hw;
    }

    // Asian handicap
    const asianHandicap: Record<string, number> = {};
    for (const line of [-1.75,-1.5,-1.25,-1,-0.75,-0.5,-0.25,0,0.25,0.5,0.75,1,1.25,1.5,1.75]) {
      let prob = 0;
      for (let h = 0; h <= N; h++) for (let a = 0; a <= N; a++) {
        const diff = (h - a) + line;
        if      (diff > 0)  prob += p[h][a];
        else if (diff === 0) prob += p[h][a] * 0.5;
      }
      asianHandicap[`${line}`] = prob;
    }

    // --- Shots (NegBin) ---
    const hs  = supp?.homeTeamStats ?? {} as any;
    const as_ = supp?.awayTeamStats ?? {} as any;
    const SERIE_A_SHOT_GOAL_RATIO = 11.0; // shots totali / goal
    const alpha = 0.35; // peso prior lambda
    const impliedShotsHome = matrix.lambdaHome * SERIE_A_SHOT_GOAL_RATIO;
    const impliedShotsAway = matrix.lambdaAway * SERIE_A_SHOT_GOAL_RATIO;
    const blendedHomeShotsBase = (1 - alpha) * (hs.avgShots ?? SERIE_A_DEFAULTS.avgShots) + alpha * impliedShotsHome;
    const blendedAwayShotsBase = (1 - alpha) * (as_.avgShots ?? SERIE_A_DEFAULTS.avgShots) + alpha * impliedShotsAway;
    const blendedHomeShots = blendedHomeShotsBase * (context.homeShotMultiplier ?? 1);
    const blendedAwayShots = blendedAwayShotsBase * (context.awayShotMultiplier ?? 1);
    const shotsData: ShotsModelData = {
      homeTeamAvgShots:         Math.max(3, blendedHomeShots),
      awayTeamAvgShots:         Math.max(3, blendedAwayShots),
      homeTeamAvgShotsOT:       hs.avgShotsOT       ?? SERIE_A_DEFAULTS.avgShotsOT,
      awayTeamAvgShotsOT:       as_.avgShotsOT      ?? SERIE_A_DEFAULTS.avgShotsOT,
      homeTeamShotsSuppression: hs.shotsSuppression ?? 1.0,
      awayTeamShotsSuppression: as_.shotsSuppression ?? 1.0,
      homeAdvantageShots:       supp?.homeAdvantageShots ?? SERIE_A_DEFAULTS.homeAdvantageShots,
      homeTeamVarShots:         hs.varShots,
      awayTeamVarShots:         as_.varShots,
      homeTeamVarShotsOT:       hs.varShotsOT,
      awayTeamVarShotsOT:       as_.varShotsOT,
      homeTeamSampleSize:       hs.sampleSize,
      awayTeamSampleSize:       as_.sampleSize,
    };
    const shotsResult = this.specialized.computeShotsDistribution(shotsData);

    // --- Cards (NegBin + referee factor) ---
    const ref = supp?.refereeStats ?? {} as any;
    const strengthDiff = Math.abs(matrix.lambdaHome - matrix.lambdaAway);
    const matchIntensity = Math.max(0, Math.min(1, 1 - strengthDiff / 2.0));
    const derivedCompetitiveness = supp?.competitiveness !== undefined
      ? supp.competitiveness
      : Math.max(0.25, matchIntensity * 0.7 + (supp?.isDerby ? 0.3 : 0));
    const cardsData: CardsModelData = {
      homeTeamAvgYellow:  hs.avgYellowCards  ?? SERIE_A_DEFAULTS.avgYellowCards,
      awayTeamAvgYellow:  as_.avgYellowCards ?? SERIE_A_DEFAULTS.avgYellowCards,
      homeTeamAvgRed:     hs.avgRedCards     ?? SERIE_A_DEFAULTS.avgRedCards,
      awayTeamAvgRed:     as_.avgRedCards    ?? SERIE_A_DEFAULTS.avgRedCards,
      refereeAvgYellow:   ref.avgYellow      ?? SERIE_A_DEFAULTS.refereeAvgYellow,
      refereeAvgRed:      ref.avgRed         ?? SERIE_A_DEFAULTS.refereeAvgRed,
      refereeAvgTotal:    (ref.avgYellow ?? 3.8) + (ref.avgRed ?? 0.22) * 2,
      leagueAvgYellow:    supp?.leagueAvgYellow ?? SERIE_A_DEFAULTS.leagueAvgYellow,
      competitiveness:    derivedCompetitiveness,
      homeTeamVarYellow:  hs.varYellowCards,
      awayTeamVarYellow:  as_.varYellowCards,
      homeTeamSampleSize: hs.sampleSize,
      awayTeamSampleSize: as_.sampleSize,
      refereeSampleSize:  ref.sampleSize,
      refereeAvgFouls:    ref.avgFouls,
      leagueAvgFouls:     supp?.leagueAvgFouls ?? SERIE_A_DEFAULTS.leagueAvgFouls,
    };
    const cards = this.specialized.computeCardsDistribution(cardsData);
    if (context.yellowCardMultiplier && Math.abs(context.yellowCardMultiplier - 1) > 0.01) {
      const yellowFactor = Math.max(0.8, Math.min(1.4, context.yellowCardMultiplier));
      const rYellow = cards.negBinParams.r;
      const adjustedHomeYellow = cards.expectedHomeYellow * yellowFactor;
      const adjustedAwayYellow = cards.expectedAwayYellow * yellowFactor;
      const adjustedTotalYellow = adjustedHomeYellow + adjustedAwayYellow;
      const adjustedCardPoints = cards.expectedTotalCards * yellowFactor;

      cards.expectedHomeYellow = parseFloat(adjustedHomeYellow.toFixed(4));
      cards.expectedAwayYellow = parseFloat(adjustedAwayYellow.toFixed(4));
      cards.expectedTotalYellow = parseFloat(adjustedTotalYellow.toFixed(4));
      cards.expectedTotalCards = parseFloat(adjustedCardPoints.toFixed(4));
      cards.negBinParams.mu = parseFloat(adjustedTotalYellow.toFixed(4));

      for (const line of Object.keys(cards.overUnderYellow ?? {})) {
        const over = this.specialized.negBinOver(Number(line), adjustedTotalYellow, rYellow);
        cards.overUnderYellow[line] = {
          over: parseFloat(over.toFixed(6)),
          under: parseFloat((1 - over).toFixed(6)),
        };
      }
      for (const line of Object.keys(cards.overUnderTotal ?? {})) {
        const over = this.specialized.negBinOver(Number(line), adjustedCardPoints, Math.max(3, rYellow * 0.82));
        cards.overUnderTotal[line] = {
          over: parseFloat(over.toFixed(6)),
          under: parseFloat((1 - over).toFixed(6)),
        };
      }
    }

    // --- Fouls (NegBin + possession correction) ---
    const lambdaTotal = matrix.lambdaHome + matrix.lambdaAway;
    const inferredHomePoss = lambdaTotal > 0
      ? 0.5 + 0.1 * (matrix.lambdaHome - matrix.lambdaAway) / lambdaTotal
      : 0.5;
    const toPossessionRatio = (value: unknown): number | undefined => {
      const raw = Number(value);
      if (!Number.isFinite(raw)) return undefined;
      const normalized = raw > 1 ? raw / 100 : raw;
      return this.clamp(normalized, 0.3, 0.7);
    };
    const homePossRatio = toPossessionRatio(hs.avgPossession);
    const awayPossRatio = toPossessionRatio(as_.avgPossession);
    const historicalHomePoss = homePossRatio !== undefined
      ? homePossRatio
      : awayPossRatio !== undefined
        ? this.clamp(1 - awayPossRatio, 0.3, 0.7)
        : undefined;
    const estimatedHomePossBase = historicalHomePoss !== undefined
      ? (historicalHomePoss * 0.65) + (inferredHomePoss * 0.35)
      : inferredHomePoss;
    const estimatedHomePoss = this.clamp(
      estimatedHomePossBase + (context.homePossessionShift ?? 0),
      0.3,
      0.7,
    );
    const foulsData: FoulsModelData = {
      homeTeamAvgFouls:   hs.avgFouls         ?? SERIE_A_DEFAULTS.avgFouls,
      awayTeamAvgFouls:   as_.avgFouls        ?? SERIE_A_DEFAULTS.avgFouls,
      homePossessionEst:  Math.max(0.3, Math.min(0.7, estimatedHomePoss)),
      refereeAvgFouls:    ref.avgFouls        ?? SERIE_A_DEFAULTS.refereeAvgFouls,
      leagueAvgFouls:     supp?.leagueAvgFouls ?? SERIE_A_DEFAULTS.leagueAvgFouls,
      homeTeamVarFouls:   hs.varFouls,
      awayTeamVarFouls:   as_.varFouls,
      homeTeamSampleSize: hs.sampleSize,
      awayTeamSampleSize: as_.sampleSize,
    };
    const fouls = this.specialized.computeFoulsDistribution(foulsData);
    if (context.foulMultiplier && Math.abs(context.foulMultiplier - 1) > 0.01) {
      const foulFactor = Math.max(0.85, Math.min(1.3, context.foulMultiplier));
      const adjustedHomeFouls = fouls.expectedHomeFouls * foulFactor;
      const adjustedAwayFouls = fouls.expectedAwayFouls * foulFactor;
      const adjustedTotalFouls = adjustedHomeFouls + adjustedAwayFouls;
      fouls.expectedHomeFouls = parseFloat(adjustedHomeFouls.toFixed(4));
      fouls.expectedAwayFouls = parseFloat(adjustedAwayFouls.toFixed(4));
      fouls.expectedTotalFouls = parseFloat(adjustedTotalFouls.toFixed(4));
      fouls.negBinParams.mu = parseFloat(adjustedTotalFouls.toFixed(4));

      for (const line of Object.keys(fouls.overUnder ?? {})) {
        const over = this.specialized.negBinOver(Number(line), adjustedTotalFouls, fouls.negBinParams.r);
        fouls.overUnder[line] = {
          over: parseFloat(over.toFixed(6)),
          under: parseFloat((1 - over).toFixed(6)),
        };
      }
    }

    // --- Correzione gialli in funzione dei falli attesi ---
    const leagueAvgFouls = supp?.leagueAvgFouls ?? SERIE_A_DEFAULTS.leagueAvgFouls;
    const foulsRatio = fouls.expectedTotalFouls / Math.max(1, leagueAvgFouls);
    const foulEffect = Math.pow(foulsRatio, 0.7);
    const refStrictness = ref.avgYellow !== undefined
      ? Math.min(1, Math.max(0, ref.avgYellow / Math.max(0.1, SERIE_A_DEFAULTS.refereeAvgYellow)))
      : 0.5;
    const yellowFoulsCorrFactor = foulEffect * (0.7 + 0.3 * refStrictness);
    const adjustedYellowMu = cards.expectedTotalYellow * yellowFoulsCorrFactor;
    if (Math.abs(yellowFoulsCorrFactor - 1) > 0.02) {
      const rYellow = cards.negBinParams.r;
      const yellowLines = [0.5,1.5,2.5,3.5,4.5,5.5,6.5,7.5,8.5,9.5];
      for (const line of yellowLines) {
        const over = this.specialized.negBinOver(line, adjustedYellowMu, rYellow);
        cards.overUnderYellow[`${line}`] = {
          over: parseFloat(over.toFixed(6)),
          under: parseFloat((1 - over).toFixed(6)),
        };
      }
      cards.expectedTotalYellow = parseFloat(adjustedYellowMu.toFixed(4));
    }

    // --- Corners ---
    let cornersResult: ReturnType<SpecializedModels['computeCornersDistribution']> | null = null;
    if (hs.avgHomeCorners !== undefined && as_.avgAwayCorners !== undefined) {
      const cornersData = {
        homeTeamAvgCornersFor:     hs.avgHomeCorners     ?? 5.5,
        homeTeamAvgCornersAgainst: as_.avgAwayCorners    ?? 4.5,
        awayTeamAvgCornersFor:     as_.avgAwayCorners    ?? 4.5,
        awayTeamAvgCornersAgainst: hs.avgHomeCorners     ?? 5.5,
        homeTeamSampleSize:        hs.sampleSize,
        awayTeamSampleSize:        as_.sampleSize,
      };

      const leagueAvgShots = 24.0;
      const shotsRatio = (shotsData.homeTeamAvgShots + shotsData.awayTeamAvgShots) / leagueAvgShots;
      const shotsCorrFactor = 1 + 0.3 * (shotsRatio - 1);
      cornersData.homeTeamAvgCornersFor = Math.max(2, (hs.avgHomeCorners ?? 5.5) * shotsCorrFactor);
      cornersData.awayTeamAvgCornersFor = Math.max(2, (as_.avgAwayCorners ?? 4.5) * shotsCorrFactor);

      cornersResult = this.specialized.computeCornersDistribution(cornersData);
    }

    // --- Player shots ---
    const playerShotsHome = (supp?.homePlayers ?? []).length > 0
      ? this.specialized.computePlayerShotsPredictions(
          supp!.homePlayers!, shotsResult.home.expectedTotalShots, shotsResult.home.expectedShotsOnTarget)
      : [];
    const playerShotsAway = (supp?.awayPlayers ?? []).length > 0
      ? this.specialized.computePlayerShotsPredictions(
          supp!.awayPlayers!, shotsResult.away.expectedTotalShots, shotsResult.away.expectedShotsOnTarget)
      : [];

    // ==================== FLAT PROBABILITIES ====================
    // Helper: "15.5" → "155", "7.5" → "75"
    const fmtLine = (l: string) => l.replace('.', '');

    const flatProbabilities: Record<string, number> = {
      // 1X2 + BTTS
      homeWin, draw, awayWin,
      btts, bttsNo: 1 - btts,

      // Over/Under goal
      over05: o05,  under05: 1 - o05,
      over15: o15,  under15: 1 - o15,
      over25: o25,  under25: 1 - o25,
      over35: o35,  under35: 1 - o35,
      over45: o45,  under45: 1 - o45,

      // Exact score
      ...Object.fromEntries(
        Object.entries(exactScore).map(([k, v]) => [`exact_${k}`, v])
      ),

      // Handicap europeo
      ...Object.fromEntries(
        Object.entries(handicap).map(([k, v]) => [`hcp_${k}`, v])
      ),

      // Tiri casa
      ...Object.fromEntries(
        Object.entries(shotsResult.home.overUnder).flatMap(([line, { over, under }]) => [
          [`shotsHomeOver${fmtLine(line)}`,  over],
          [`shotsHomeUnder${fmtLine(line)}`, under],
        ])
      ),

      // Tiri ospite
      ...Object.fromEntries(
        Object.entries(shotsResult.away.overUnder).flatMap(([line, { over, under }]) => [
          [`shotsAwayOver${fmtLine(line)}`,  over],
          [`shotsAwayUnder${fmtLine(line)}`, under],
        ])
      ),

      // Tiri totali
      ...Object.fromEntries(
        Object.entries(shotsResult.total).flatMap(([line, { over, under }]) => [
          [`shotsOver${fmtLine(line)}`,  over],
          [`shotsUnder${fmtLine(line)}`, under],
        ])
      ),

      // Tiri in porta (combined OT)
      ...Object.fromEntries(
        Object.entries(shotsResult.combined?.onTargetOverUnder ?? {}).flatMap(([key, prob]) => {
          // chiavi tipo "over75" → "shotsOTOver75"
          const isOver = key.startsWith('over');
          const line   = key.slice(isOver ? 4 : 5);
          return isOver
            ? [[`shotsOTOver${line}`, prob], [`shotsOTUnder${line}`, 1 - (prob as number)]]
            : [];
        })
      ),

      // Cartellini gialli
      ...Object.fromEntries(
        Object.entries(cards.overUnderYellow).flatMap(([line, { over, under }]) => [
          [`yellowOver${fmtLine(line)}`,  over],
          [`yellowUnder${fmtLine(line)}`, under],
        ])
      ),

      // Falli
      ...Object.fromEntries(
        Object.entries(fouls.overUnder).flatMap(([line, { over, under }]) => [
          [`foulsOver${fmtLine(line)}`,  over],
          [`foulsUnder${fmtLine(line)}`, under],
        ])
      ),

      // Angoli
      ...(cornersResult ? Object.fromEntries(
        Object.entries(cornersResult.overUnder).flatMap(([line, { over, under }]) => [
          [`cornersOver${fmtLine(line)}`,  over],
          [`cornersUnder${fmtLine(line)}`, under],
        ])
      ) : {}),
    };

    return {
      homeWin, draw, awayWin, btts,
      over05: o05,  over15: o15,  over25: o25,  over35: o35,  over45: o45,
      under05: 1-o05, under15: 1-o15, under25: 1-o25, under35: 1-o35, under45: 1-o45,
      exactScore, handicap, asianHandicap,
      shotsHome: {
        expected: shotsResult.home.expectedTotalShots,
        overUnder: shotsResult.home.overUnder,
        totalShots: shotsResult.home.totalShots,
        shotsOnTarget: shotsResult.home.shotsOnTarget,
        negBinParams: shotsResult.home.negBinParams,
      },
      shotsAway: {
        expected: shotsResult.away.expectedTotalShots,
        overUnder: shotsResult.away.overUnder,
        totalShots: shotsResult.away.totalShots,
        shotsOnTarget: shotsResult.away.shotsOnTarget,
        negBinParams: shotsResult.away.negBinParams,
      },
      shotsTotal: shotsResult.total,
      shotsOnTargetHome: {
        expected: shotsResult.home.expectedShotsOnTarget,
        variance: shotsResult.home.shotsOnTarget.variance,
        distribution: shotsResult.home.shotsOnTarget.distribution,
      },
      shotsOnTargetAway: {
        expected: shotsResult.away.expectedShotsOnTarget,
        variance: shotsResult.away.shotsOnTarget.variance,
        distribution: shotsResult.away.shotsOnTarget.distribution,
      },
      cards, fouls,
      corners: cornersResult ?? undefined,
      playerShots: { home: playerShotsHome, away: playerShotsAway },
      lambdaHome: matrix.lambdaHome,
      lambdaAway: matrix.lambdaAway,
      flatProbabilities,
    };
  }

  // ==================== FITTING ====================

  /**
   * Gradient ascent sulla log-verosimiglianza ponderata temporalmente.
   * Peso: w = exp(-τ × età_in_settimane)
   * τ=0.0065 → half-life ≈ 107 giorni.
   */
  fitModel(
    matches: MatchData[], teams: string[],
    maxIter = 280, lr = 0.04
  ): ModelParams {
    for (const t of teams) {
      if (this.params.attackParams[t]  === undefined) this.params.attackParams[t]  = 0.0;
      if (this.params.defenceParams[t] === undefined) this.params.defenceParams[t] = 0.0;
    }

    const now          = new Date();
    const validMatches = matches.filter(m => m.homeGoals !== undefined && m.awayGoals !== undefined);
    if (validMatches.length === 0 || teams.length === 0) return this.params;

    const logLikelihood = (): number => {
      let ll = 0;
      for (const m of validMatches) {
        const age = (now.getTime() - m.date.getTime()) / (1000*60*60*24*7);
        const w   = Math.exp(-this.params.tau * age);
        const lH  = this.safeExp((this.params.attackParams[m.homeTeamId]??0) - (this.params.defenceParams[m.awayTeamId]??0) + this.params.homeAdvantage);
        const lA  = this.safeExp((this.params.attackParams[m.awayTeamId]??0) - (this.params.defenceParams[m.homeTeamId]??0));
        const x = m.homeGoals!, y = m.awayGoals!;
        const pBase = this.poissonPMF(x, lH) * this.poissonPMF(y, lA);
        const tauC  = Math.max(1e-8, this.tauCorrection(x, y, lH, lA, this.params.rho));
        if (pBase > 0) ll += w * Math.log(Math.max(1e-12, pBase * tauC));
      }
      return ll;
    };

    const reg = 0.003;
    let prevLL = -Infinity, flatIters = 0;

    for (let iter = 1; iter <= maxIter; iter++) {
      const gA: Record<string,number> = {}, gD: Record<string,number> = {};
      for (const t of teams) { gA[t] = 0; gD[t] = 0; }
      let gHA = 0, gRho = 0;

      for (const m of validMatches) {
        const age = (now.getTime() - m.date.getTime()) / (1000*60*60*24*7);
        const w   = Math.exp(-this.params.tau * age);
        const lH  = this.safeExp((this.params.attackParams[m.homeTeamId]??0) - (this.params.defenceParams[m.awayTeamId]??0) + this.params.homeAdvantage);
        const lA  = this.safeExp((this.params.attackParams[m.awayTeamId]??0) - (this.params.defenceParams[m.homeTeamId]??0));
        const x = m.homeGoals!, y = m.awayGoals!;
        const errH = x - lH, errA = y - lA;

        gA[m.homeTeamId]  += w * errH;  gD[m.awayTeamId] += w * (-errH);
        gA[m.awayTeamId]  += w * errA;  gD[m.homeTeamId] += w * (-errA);
        gHA += w * errH;

        const tauC = Math.max(1e-8, this.tauCorrection(x, y, lH, lA, this.params.rho));
        const dTau = this.tauDerivative(x, y, lH, lA);
        if (isFinite(dTau)) gRho += w * (dTau / tauC);
      }

      const invN = 1 / validMatches.length;
      const step = lr / Math.sqrt(iter);

      for (const t of teams) {
        this.params.attackParams[t] = this.clamp(
          (this.params.attackParams[t]??0) + step * this.clamp(gA[t]*invN - reg*(this.params.attackParams[t]??0), -4, 4),
          -this.PARAM_BOUND, this.PARAM_BOUND
        );
        this.params.defenceParams[t] = this.clamp(
          (this.params.defenceParams[t]??0) + step * this.clamp(gD[t]*invN - reg*(this.params.defenceParams[t]??0), -4, 4),
          -this.PARAM_BOUND, this.PARAM_BOUND
        );
      }
      this.params.homeAdvantage = this.clamp(
        this.params.homeAdvantage + step * this.clamp(gHA*invN - reg*this.params.homeAdvantage, -2, 2),
        -0.8, 1.2
      );
      this.params.rho = this.clamp(
        this.params.rho + step * this.clamp(gRho*invN - 0.02*(this.params.rho+0.13), -1, 1),
        -0.5, 0.0
      );

      const ll = logLikelihood();
      if (!isFinite(ll)) break;
      if (Math.abs(ll - prevLL) < 1e-6) flatIters++; else flatIters = 0;
      prevLL = ll;
      if (iter > 60 && flatIters >= 12) break;
    }

    // Normalizzazione (vincolo di identificabilità: Σ attack = 0)
    const nT   = teams.length;
    const avgA = teams.reduce((s,t) => s+(this.params.attackParams[t]??0),  0) / nT;
    const avgD = teams.reduce((s,t) => s+(this.params.defenceParams[t]??0), 0) / nT;
    for (const t of teams) {
      this.params.attackParams[t]  = (this.params.attackParams[t]??0)  - avgA;
      this.params.defenceParams[t] = (this.params.defenceParams[t]??0) - avgD;
    }

    return this.params;
  }

  getParams(): ModelParams { return this.params; }
  setParams(p: Partial<ModelParams>): void { this.params = { ...this.params, ...p }; }
}
