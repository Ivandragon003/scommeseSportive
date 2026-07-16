/**
 * PoissonXgModel — modello goal indipendente guidato dai RATE xG.
 *
 * È volutamente SEPARATO da DixonColesModel (single responsibility): il DC
 * resta responsabile solo del proprio modello. Questo è il "secondo parere"
 * dell'ensemble (vedi ProbabilityEnsembleService).
 *
 * Differenze dal DC che lo rendono un partner utile nell'ensemble:
 *   - usa le MEDIE xG fatte/subite per squadra (segnale stabile), non l'xG
 *     rumoroso del singolo match come fa il blend del DC;
 *   - Poisson INDIPENDENTE (nessuna correzione τ/ρ): distribuzione più semplice
 *     e senza il bias di livello strutturale del DC (già level-matched ai goal
 *     reali del training via levelScale).
 *
 * Fit (metodo dei momenti, nessuna ottimizzazione iterativa):
 *   leagueXG    = media xG per squadra/partita sul training
 *   attackRate[t] = (media xG fatti da t) / leagueXG,  shrinkata verso 1
 *   defRate[t]    = (media xG subiti da t) / leagueXG,  shrinkata verso 1
 *   homeAdv     = fattore casa da (xG medio casa)/(xG medio complessivo)
 *   levelScale  = (media goal reali totali) / (2*leagueXG)  → allinea il livello
 *
 * Predict:
 *   λH = leagueXG * attackRate[H] * defRate[A] * homeAdv * levelScale
 *   λA = leagueXG * attackRate[A] * defRate[H] * levelScale
 *   Poisson indipendente → probabilità dei mercati goal.
 *
 * Backtest OOS 2026-07: ensemble DC + questo modello (w≈0.5) → −0.63% logLoss,
 * ECE 0.0058→0.0019 sui mercati goal.
 */

export interface PoissonXgFitMatch {
  homeTeamId: string;
  awayTeamId: string;
  homeGoals?: number;
  awayGoals?: number;
  homeXG?: number;
  awayXG?: number;
}

export interface PoissonXgParams {
  leagueXG: number;
  homeAdv: number;
  levelScale: number;
  attackRate: Record<string, number>;
  defRate: Record<string, number>;
}

export interface PoissonXgFitOptions {
  /** Partite equivalenti di prior nello shrinkage dei rate verso 1 (media lega). Default 8. */
  shrinkage?: number;
  maxGoals?: number;
}

const DEFAULT_SHRINKAGE = 8;
const DEFAULT_MAX_GOALS = 10;
const LAMBDA_MIN = 0.15;
const LAMBDA_MAX = 5;

/** Chiavi dei mercati goal prodotte da computeGoalProbabilities. */
export const POISSON_XG_GOAL_KEYS = [
  'homeWin', 'draw', 'awayWin',
  'btts', 'bttsNo',
  'over05', 'under05', 'over15', 'under15',
  'over25', 'under25', 'over35', 'under35',
  'over45', 'under45',
] as const;

export class PoissonXgModel {
  private params: PoissonXgParams | null;
  private readonly maxGoals: number;

  constructor(params?: PoissonXgParams, maxGoals = DEFAULT_MAX_GOALS) {
    this.params = params ?? null;
    this.maxGoals = maxGoals;
  }

  getParams(): PoissonXgParams | null {
    return this.params;
  }

  setParams(params: PoissonXgParams | null): void {
    this.params = params;
  }

  hasParams(): boolean {
    return this.params !== null;
  }

  /** Stima i parametri dal training (solo partite con goal e xG validi). */
  fit(matches: PoissonXgFitMatch[], options: PoissonXgFitOptions = {}): PoissonXgParams {
    const shrinkage = Math.max(0, options.shrinkage ?? DEFAULT_SHRINKAGE);

    const xgFor: Record<string, number> = {};
    const xgAgainst: Record<string, number> = {};
    const games: Record<string, number> = {};
    let sumXG = 0, countXG = 0;
    let homeXGsum = 0, awayXGsum = 0, nHomeAway = 0;
    let sumRealTotal = 0, nReal = 0;

    for (const m of matches) {
      const hx = Number(m.homeXG), ax = Number(m.awayXG);
      if (!Number.isFinite(hx) || !Number.isFinite(ax) || hx < 0 || ax < 0) continue;
      const h = m.homeTeamId, a = m.awayTeamId;
      xgFor[h] = (xgFor[h] ?? 0) + hx; xgAgainst[h] = (xgAgainst[h] ?? 0) + ax; games[h] = (games[h] ?? 0) + 1;
      xgFor[a] = (xgFor[a] ?? 0) + ax; xgAgainst[a] = (xgAgainst[a] ?? 0) + hx; games[a] = (games[a] ?? 0) + 1;
      sumXG += hx + ax; countXG += 2;
      homeXGsum += hx; awayXGsum += ax; nHomeAway += 1;
      if (Number.isFinite(Number(m.homeGoals)) && Number.isFinite(Number(m.awayGoals))) {
        sumRealTotal += Number(m.homeGoals) + Number(m.awayGoals); nReal += 1;
      }
    }

    const leagueXG = countXG > 0 ? sumXG / countXG : 1.3;
    const homeAdv = (nHomeAway > 0 && (homeXGsum + awayXGsum) > 0)
      ? (homeXGsum / nHomeAway) / ((homeXGsum + awayXGsum) / (2 * nHomeAway))
      : 1.05;
    const realMeanTotal = nReal > 0 ? sumRealTotal / nReal : 2 * leagueXG;
    const levelScale = leagueXG > 0 ? realMeanTotal / (2 * leagueXG) : 1;

    const attackRate: Record<string, number> = {};
    const defRate: Record<string, number> = {};
    const teams = new Set<string>([...Object.keys(xgFor), ...Object.keys(xgAgainst)]);
    for (const t of teams) {
      const n = games[t] ?? 0;
      const rawAtt = n > 0 ? (xgFor[t] / n) / Math.max(0.2, leagueXG) : 1;
      const rawDef = n > 0 ? (xgAgainst[t] / n) / Math.max(0.2, leagueXG) : 1;
      // Shrinkage bayesiano verso 1 (media lega) per squadre con pochi dati.
      attackRate[t] = (n * rawAtt + shrinkage * 1) / (n + shrinkage);
      defRate[t] = (n * rawDef + shrinkage * 1) / (n + shrinkage);
    }

    this.params = { leagueXG, homeAdv, levelScale, attackRate, defRate };
    return this.params;
  }

  /** λ attese (casa, trasferta) per una partita. Null se non fittato. */
  expectedGoals(homeId: string, awayId: string): { lambdaHome: number; lambdaAway: number } | null {
    if (!this.params) return null;
    const p = this.params;
    const aH = p.attackRate[homeId] ?? 1;
    const dA = p.defRate[awayId] ?? 1;
    const aA = p.attackRate[awayId] ?? 1;
    const dH = p.defRate[homeId] ?? 1;
    let lH = p.leagueXG * aH * dA * p.homeAdv * p.levelScale;
    let lA = p.leagueXG * aA * dH * p.levelScale;
    lH = Math.max(LAMBDA_MIN, Math.min(LAMBDA_MAX, lH));
    lA = Math.max(LAMBDA_MIN, Math.min(LAMBDA_MAX, lA));
    return { lambdaHome: lH, lambdaAway: lA };
  }

  /** Probabilità dei mercati goal (POISSON_XG_GOAL_KEYS). Null se non fittato. */
  computeGoalProbabilities(homeId: string, awayId: string): Record<string, number> | null {
    const lambdas = this.expectedGoals(homeId, awayId);
    if (!lambdas) return null;
    return this.goalProbabilitiesFromLambdas(lambdas.lambdaHome, lambdas.lambdaAway);
  }

  private goalProbabilitiesFromLambdas(lH: number, lA: number): Record<string, number> {
    const N = this.maxGoals;
    const ph: number[] = [], pa: number[] = [];
    for (let k = 0; k <= N; k++) { ph[k] = poissonPMF(k, lH); pa[k] = poissonPMF(k, lA); }

    let homeWin = 0, draw = 0, awayWin = 0, btts = 0, mass = 0;
    const overCounts: Record<string, number> = { 0.5: 0, 1.5: 0, 2.5: 0, 3.5: 0, 4.5: 0 };
    for (let h = 0; h <= N; h++) {
      for (let a = 0; a <= N; a++) {
        const p = ph[h] * pa[a];
        mass += p;
        if (h > a) homeWin += p; else if (h === a) draw += p; else awayWin += p;
        if (h > 0 && a > 0) btts += p;
        const total = h + a;
        for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) if (total > line) overCounts[line] += p;
      }
    }

    // Normalizza per la massa della griglia troncata (coda oltre N): garantisce
    // 1X2=1, over+under=1, btts+no=1 in modo esatto.
    const Z = mass > 0 ? mass : 1;
    const over = (line: number) => overCounts[line] / Z;
    return {
      homeWin: homeWin / Z, draw: draw / Z, awayWin: awayWin / Z,
      btts: btts / Z, bttsNo: 1 - btts / Z,
      over05: over(0.5), under05: 1 - over(0.5),
      over15: over(1.5), under15: 1 - over(1.5),
      over25: over(2.5), under25: 1 - over(2.5),
      over35: over(3.5), under35: 1 - over(3.5),
      over45: over(4.5), under45: 1 - over(4.5),
    };
  }
}

/** PMF Poisson in log-space per stabilità numerica. */
function poissonPMF(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}
