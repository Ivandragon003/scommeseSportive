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
} from '../markets/SpecializedModels';

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
  homeAdvantageShots: 1.08,  // v3.1: ridotto da 1.12 — coerente con riduzione HA goal
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
      homeAdvantage: 0.10,   // v3.1: ridotto da 0.15 — vantaggio casa moderno ~+10.5%
      rho:           -0.13,
      tau:           0.0065,
      homeAdvantagePerTeam: {},
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

    // Usa il vantaggio casa per-squadra se disponibile, altrimenti il globale.
    const ha = this.params.homeAdvantagePerTeam?.[homeId] ?? this.params.homeAdvantage;
    let lH = aH * dA * this.safeExp(ha);
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
  private computeMatchWeight(
    match: MatchData,
    currentSeason: string,
    previousSeason: string,
    now: Date,
    opts: {
      prevSeasonWeight?: number;
      tauInter?: number;
      managerChangeDates?: Record<string, Date>;
      managerChangePenalty?: number;
    } = {}
  ): number {
    const {
      prevSeasonWeight     = 0.35,
      tauInter             = 0.018,
      managerChangeDates   = {},
      managerChangePenalty = 0.15,
    } = opts;

    const ageWeeks = (now.getTime() - match.date.getTime()) / (1000 * 60 * 60 * 24 * 7);
    if (ageWeeks < 0) return 0;

    const matchSeason = match.season ?? '';

    let w: number;
    if (matchSeason === currentSeason) {
      // Stagione corrente: quasi-uniforme, lievissimo decadimento
      w = Math.exp(-0.002 * ageWeeks);
    } else if (matchSeason === previousSeason && previousSeason !== '') {
      // Stagione precedente: salto fisso + decadimento inter-stagionale
      w = prevSeasonWeight * Math.exp(-tauInter * ageWeeks);
    } else if (matchSeason === '') {
      // Season non valorizzato: fallback al decadimento esponenziale classico
      w = Math.exp(-this.params.tau * ageWeeks);
    } else {
      // Stagioni più vecchie: peso residuo minimo
      w = 0.08 * Math.exp(-tauInter * ageWeeks);
    }

    // Penalità cambio allenatore: la partita descrive un'identità che non esiste più
    for (const teamId of [match.homeTeamId, match.awayTeamId]) {
      const changeDate = managerChangeDates[teamId];
      if (changeDate && match.date < changeDate) {
        w *= managerChangePenalty;
        break;
      }
    }

    return Math.max(0, w);
  }

  /**
   * Risolve la stagione corrente e quella precedente dall'insieme di partite.
   * Formato atteso: "2024-25", "2023-24", "2024", "2023" (ordine lessicografico).
   */
  private resolveSeasons(matches: MatchData[], now: Date): { current: string; previous: string } {
    const seasons = [...new Set(matches.map(m => m.season).filter(Boolean) as string[])].sort();
    if (seasons.length === 0) {
      const yr = now.getFullYear();
      return { current: String(yr), previous: String(yr - 1) };
    }
    const current  = seasons[seasons.length - 1];
    const previous = seasons.length >= 2 ? seasons[seasons.length - 2] : '';
    return { current, previous };
  }

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
  fitModel(
    matches: MatchData[],
    teams: string[],
    maxIter = 280,
    lr = 0.04,
    opts: {
      prevSeasonWeight?: number;
      tauInter?: number;
      managerChangeDates?: Record<string, Date>;
      managerChangePenalty?: number;
      /**
       * enablePerTeamHomeAdvantage: se true, stima un parametro homeAdvantage
       * separato per ciascuna squadra home. Richiede almeno 8-10 partite home
       * per squadra per stabilità. Con dataset piccoli preferire false.
       * Default: false → usa il parametro globale homeAdvantage per tutti.
       */
      enablePerTeamHomeAdvantage?: boolean;
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
    } = {}
  ): ModelParams {
    for (const t of teams) {
      if (this.params.attackParams[t]  === undefined) this.params.attackParams[t]  = 0.0;
      if (this.params.defenceParams[t] === undefined) this.params.defenceParams[t] = 0.0;
    }

    const now = new Date();
    const { current: currentSeason, previous: previousSeason } = this.resolveSeasons(matches, now);

    const {
      enablePerTeamHomeAdvantage = false,
      structuralBreaks = {},
      structuralBreakPenalty = 0.25,
    } = opts;

    const validMatches = matches.filter(m => m.homeGoals !== undefined && m.awayGoals !== undefined);
    if (validMatches.length === 0 || teams.length === 0) return this.params;

    // Inizializza homeAdvantagePerTeam se abilitato
    if (enablePerTeamHomeAdvantage) {
      for (const t of teams) {
        if (this.params.homeAdvantagePerTeam[t] === undefined) {
          this.params.homeAdvantagePerTeam[t] = this.params.homeAdvantage;
        }
      }
    }

    // Pre-calcola i pesi una volta sola — immutabili durante il fitting.
    // Applica structuralBreakPenalty alle partite pre-evento strutturale.
    const weights = validMatches.map(m => {
      let w = this.computeMatchWeight(m, currentSeason, previousSeason, now, opts);
      if (w > 0 && Object.keys(structuralBreaks).length > 0) {
        for (const teamId of [m.homeTeamId, m.awayTeamId]) {
          const breakDate = structuralBreaks[teamId];
          if (breakDate && m.date < breakDate) {
            w *= structuralBreakPenalty;
            break;
          }
        }
      }
      return w;
    });
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    if (totalWeight <= 0) return this.params;
    const invTotalWeight = 1 / totalWeight;

    // Restituisce l'homeAdvantage effettivo: per-squadra se abilitato, globale altrimenti
    const getHA = (homeId: string): number =>
      enablePerTeamHomeAdvantage
        ? (this.params.homeAdvantagePerTeam[homeId] ?? this.params.homeAdvantage)
        : this.params.homeAdvantage;

    const logLikelihood = (): number => {
      let ll = 0;
      for (let i = 0; i < validMatches.length; i++) {
        const m = validMatches[i];
        const w = weights[i];
        if (w <= 0) continue;
        const lH  = this.safeExp((this.params.attackParams[m.homeTeamId]??0) - (this.params.defenceParams[m.awayTeamId]??0) + getHA(m.homeTeamId));
        const lA  = this.safeExp((this.params.attackParams[m.awayTeamId]??0) - (this.params.defenceParams[m.homeTeamId]??0));
        const x = m.homeGoals!, y = m.awayGoals!;
        const pBase = this.poissonPMF(x, lH) * this.poissonPMF(y, lA);
        const tauC  = Math.max(1e-8, this.tauCorrection(x, y, lH, lA, this.params.rho));
        if (pBase > 0) ll += w * Math.log(Math.max(1e-12, pBase * tauC));
      }
      return ll;
    };

    const reg = 0.003;

    /**
     * OTTIMIZZATORE: Adam (Kingma & Ba, 2014)
     *
     * Sostituisce il gradient ascent con decadimento 1/√iter.
     *
     * PERCHÉ ADAM È MEGLIO DEL GRADIENT ASCENT SEMPLICE:
     *
     * 1. MOMENTUM (β₁): accumula una media esponenziale mobile del gradiente
     *    (primo momento). Questo smussamento riduce l'oscillazione nei
     *    parametri dove i gradienti cambiano segno frequentemente —
     *    tipico di attack/defence su squadre con pochi dati.
     *
     * 2. ADATTIVITÀ (β₂): accumula la media esponenziale del gradiente al
     *    quadrato (secondo momento). Divide il learning rate per √(m₂+ε),
     *    producendo passi grandi dove il gradiente è piccolo e costante
     *    (parametri ben determinati) e passi piccoli dove è noisy (parametri
     *    su squadre con poche partite). In pratica: learning rate per-parametro.
     *
     * 3. CORREZIONE BIAS: nelle prime iterazioni m₁ e m₂ sono inizializzati
     *    a zero → sottostimano il gradiente reale. La correzione m̂₁=m₁/(1-β₁ᵗ)
     *    compensa questo, garantendo passi corretti fin dall'iter 1.
     *
     * 4. CONVERGENZA: Adam tipicamente converge in 80-120 iter su questo
     *    tipo di problema (vs 200-280 del gradient ascent). La tolleranza
     *    di flat-iter viene ridotta di conseguenza.
     *
     * IPERPARAMETRI:
     *   β₁ = 0.9   → momentum standard (media su ~10 iter recenti)
     *   β₂ = 0.999 → varianza stabile (media su ~1000 iter)
     *   ε  = 1e-8  → stabilità numerica (evita /0)
     *   lr = parametro passato (default 0.04, Adam è meno sensibile al lr
     *        rispetto al gradient ascent puro grazie all'adattività)
     */
    const β1 = 0.9, β2 = 0.999, ε = 1e-8;

    // Primo momento (media gradiente)
    const m1A: Record<string,number> = {}, m1D: Record<string,number> = {};
    const m1HAPt: Record<string,number> = {};
    let m1HA = 0, m1Rho = 0;

    // Secondo momento (varianza gradiente)
    const m2A: Record<string,number> = {}, m2D: Record<string,number> = {};
    const m2HAPt: Record<string,number> = {};
    let m2HA = 0, m2Rho = 0;

    for (const t of teams) {
      m1A[t] = 0; m1D[t] = 0; m2A[t] = 0; m2D[t] = 0;
      if (enablePerTeamHomeAdvantage) { m1HAPt[t] = 0; m2HAPt[t] = 0; }
    }

    let prevLL = -Infinity, flatIters = 0;

    for (let iter = 1; iter <= maxIter; iter++) {
      // ---- calcolo gradienti ----
      const gA: Record<string,number> = {}, gD: Record<string,number> = {};
      for (const t of teams) { gA[t] = 0; gD[t] = 0; }
      let gHA = 0, gRho = 0;
      const gHAPerTeam: Record<string, number> = {};
      if (enablePerTeamHomeAdvantage) {
        for (const t of teams) gHAPerTeam[t] = 0;
      }

      for (let i = 0; i < validMatches.length; i++) {
        const m = validMatches[i];
        const w = weights[i];
        if (w <= 0) continue;
        const lH = this.safeExp(
          (this.params.attackParams[m.homeTeamId]??0) -
          (this.params.defenceParams[m.awayTeamId]??0) +
          getHA(m.homeTeamId)
        );
        const lA = this.safeExp(
          (this.params.attackParams[m.awayTeamId]??0) -
          (this.params.defenceParams[m.homeTeamId]??0)
        );
        const x = m.homeGoals!, y = m.awayGoals!;
        const errH = x - lH, errA = y - lA;

        gA[m.homeTeamId] += w * errH;  gD[m.awayTeamId] += w * (-errH);
        gA[m.awayTeamId] += w * errA;  gD[m.homeTeamId] += w * (-errA);
        gHA += w * errH;

        if (enablePerTeamHomeAdvantage) {
          gHAPerTeam[m.homeTeamId] = (gHAPerTeam[m.homeTeamId] ?? 0) + w * errH;
        }

        const tauC = Math.max(1e-8, this.tauCorrection(x, y, lH, lA, this.params.rho));
        const dTau = this.tauDerivative(x, y, lH, lA);
        if (isFinite(dTau)) gRho += w * (dTau / tauC);
      }

      // ---- normalizza gradienti per peso totale + L2 regularization ----
      for (const t of teams) {
        gA[t] = gA[t] * invTotalWeight - reg * (this.params.attackParams[t]  ?? 0);
        gD[t] = gD[t] * invTotalWeight - reg * (this.params.defenceParams[t] ?? 0);
        if (enablePerTeamHomeAdvantage) {
          // Regularizzazione verso parametro globale (shrinkage)
          const regPt = 0.05 * ((this.params.homeAdvantagePerTeam[t] ?? this.params.homeAdvantage) - this.params.homeAdvantage);
          gHAPerTeam[t] = (gHAPerTeam[t] ?? 0) * invTotalWeight - regPt;
        }
      }
      const gHAnorm  = gHA  * invTotalWeight - reg * this.params.homeAdvantage;
      const gRhoNorm = gRho * invTotalWeight - 0.02 * (this.params.rho + 0.13);

      // ---- Adam update con bias correction ----
      const bc1 = 1 - Math.pow(β1, iter);   // bias correction primo momento
      const bc2 = 1 - Math.pow(β2, iter);   // bias correction secondo momento

      for (const t of teams) {
        // Attack
        m1A[t] = β1 * m1A[t] + (1 - β1) * gA[t];
        m2A[t] = β2 * m2A[t] + (1 - β2) * gA[t] * gA[t];
        const stepA = lr * (m1A[t] / bc1) / (Math.sqrt(m2A[t] / bc2) + ε);
        this.params.attackParams[t] = this.clamp(
          (this.params.attackParams[t] ?? 0) + stepA,
          -this.PARAM_BOUND, this.PARAM_BOUND
        );

        // Defence
        m1D[t] = β1 * m1D[t] + (1 - β1) * gD[t];
        m2D[t] = β2 * m2D[t] + (1 - β2) * gD[t] * gD[t];
        const stepD = lr * (m1D[t] / bc1) / (Math.sqrt(m2D[t] / bc2) + ε);
        this.params.defenceParams[t] = this.clamp(
          (this.params.defenceParams[t] ?? 0) + stepD,
          -this.PARAM_BOUND, this.PARAM_BOUND
        );

        // HomeAdvantage per-squadra (se abilitato)
        if (enablePerTeamHomeAdvantage) {
          m1HAPt[t] = β1 * m1HAPt[t] + (1 - β1) * gHAPerTeam[t];
          m2HAPt[t] = β2 * m2HAPt[t] + (1 - β2) * gHAPerTeam[t] * gHAPerTeam[t];
          const stepHAPt = lr * (m1HAPt[t] / bc1) / (Math.sqrt(m2HAPt[t] / bc2) + ε);
          this.params.homeAdvantagePerTeam[t] = this.clamp(
            (this.params.homeAdvantagePerTeam[t] ?? this.params.homeAdvantage) + stepHAPt,
            -0.5, 0.8
          );
        }
      }

      // HomeAdvantage globale
      m1HA = β1 * m1HA + (1 - β1) * gHAnorm;
      m2HA = β2 * m2HA + (1 - β2) * gHAnorm * gHAnorm;
      const stepHA = lr * (m1HA / bc1) / (Math.sqrt(m2HA / bc2) + ε);
      this.params.homeAdvantage = this.clamp(
        this.params.homeAdvantage + stepHA,
        -0.8, 1.2
      );

      // Rho
      m1Rho = β1 * m1Rho + (1 - β1) * gRhoNorm;
      m2Rho = β2 * m2Rho + (1 - β2) * gRhoNorm * gRhoNorm;
      const stepRho = lr * (m1Rho / bc1) / (Math.sqrt(m2Rho / bc2) + ε);
      this.params.rho = this.clamp(this.params.rho + stepRho, -0.5, 0.0);

      // ---- criterio di arresto ----
      // Adam converge più velocemente: tolleranza più stretta (1e-7 vs 1e-6)
      // e finestra flat più breve (8 iter vs 12)
      const ll = logLikelihood();
      if (!isFinite(ll)) break;
      if (Math.abs(ll - prevLL) < 1e-7) flatIters++; else flatIters = 0;
      prevLL = ll;
      if (iter > 40 && flatIters >= 8) break;
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

  /**
   * Bootstrap parametrico per propagazione dell'incertezza.
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
  bootstrapLambdas(
    homeId: string,
    awayId: string,
    nSamples = 200,
    matchCounts?: Record<string, number>
  ): {
    lambdaHomeMean: number;
    lambdaAwayMean: number;
    lambdaHomeStd: number;
    lambdaAwayStd: number;
    uncertaintyFactor: number;
  } {
    const PARAM_NOISE_BASE = 0.18;
    const MAX_CV = 0.25; // coefficiente di variazione massimo atteso

    // Stima il numero di partite per squadra se non fornito
    const nHome = Math.max(5, matchCounts?.[homeId] ?? 18);
    const nAway = Math.max(5, matchCounts?.[awayId] ?? 18);
    const nTotal = Math.max(10, (nHome + nAway) / 2);

    // Deviazione standard dei parametri
    const sigmaAttackHome  = PARAM_NOISE_BASE / Math.sqrt(nHome);
    const sigmaDefenceHome = PARAM_NOISE_BASE / Math.sqrt(nAway);  // difesa home vs attacchi avversari
    const sigmaAttackAway  = PARAM_NOISE_BASE / Math.sqrt(nAway);
    const sigmaDefenceAway = PARAM_NOISE_BASE / Math.sqrt(nHome);
    const sigmaHA          = PARAM_NOISE_BASE / Math.sqrt(nTotal);

    // Box-Muller per campioni normali (no dipendenze esterne)
    const randn = (): number => {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    const lambdaHomeSamples: number[] = [];
    const lambdaAwaySamples: number[] = [];

    const baseAH = this.params.attackParams[homeId]  ?? 0;
    const baseDH = this.params.defenceParams[homeId] ?? 0;
    const baseAA = this.params.attackParams[awayId]  ?? 0;
    const baseDA = this.params.defenceParams[awayId] ?? 0;
    const baseHA = this.params.homeAdvantagePerTeam?.[homeId] ?? this.params.homeAdvantage;

    for (let i = 0; i < nSamples; i++) {
      // Perturbazione gaussiana dei parametri
      const aH = this.clamp(baseAH + randn() * sigmaAttackHome,  -this.PARAM_BOUND, this.PARAM_BOUND);
      const dH = this.clamp(baseDH + randn() * sigmaDefenceHome, -this.PARAM_BOUND, this.PARAM_BOUND);
      const aA = this.clamp(baseAA + randn() * sigmaAttackAway,  -this.PARAM_BOUND, this.PARAM_BOUND);
      const dA = this.clamp(baseDA + randn() * sigmaDefenceAway, -this.PARAM_BOUND, this.PARAM_BOUND);
      const ha = this.clamp(baseHA + randn() * sigmaHA,          -0.8, 1.2);

      const lH = this.safeExp(aH - dA + ha);
      const lA = this.safeExp(aA - dH);

      lambdaHomeSamples.push(this.clamp(lH, this.LAMBDA_MIN, this.LAMBDA_MAX));
      lambdaAwaySamples.push(this.clamp(lA, this.LAMBDA_MIN, this.LAMBDA_MAX));
    }

    const mean  = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const std   = (arr: number[], m: number) =>
      Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);

    const lambdaHomeMean = mean(lambdaHomeSamples);
    const lambdaAwayMean = mean(lambdaAwaySamples);
    const lambdaHomeStd  = std(lambdaHomeSamples, lambdaHomeMean);
    const lambdaAwayStd  = std(lambdaAwaySamples, lambdaAwayMean);

    // Coefficiente di variazione medio (peggiore tra home e away)
    const cvHome = lambdaHomeMean > 0 ? lambdaHomeStd / lambdaHomeMean : 0;
    const cvAway = lambdaAwayMean > 0 ? lambdaAwayStd / lambdaAwayMean : 0;
    const cvMax  = Math.max(cvHome, cvAway);

    const uncertaintyFactor = Math.min(1, cvMax / MAX_CV);

    return {
      lambdaHomeMean: Number(lambdaHomeMean.toFixed(4)),
      lambdaAwayMean: Number(lambdaAwayMean.toFixed(4)),
      lambdaHomeStd:  Number(lambdaHomeStd.toFixed(4)),
      lambdaAwayStd:  Number(lambdaAwayStd.toFixed(4)),
      uncertaintyFactor: Number(uncertaintyFactor.toFixed(4)),
    };
  }
}
