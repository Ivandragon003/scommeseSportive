import { DixonColesModel, MatchData, FullMatchProbabilities, SupplementaryData } from '../models/DixonColesModel';
import { ValueBettingEngine, BetOpportunity } from '../models/ValueBettingEngine';
import { BacktestingEngine } from '../models/BacktestingEngine';
import { DatabaseService } from '../db/DatabaseService';
import { PlayerShotsData } from '../models/SpecializedModels';
import { v4 as uuidv4 } from 'uuid';

export interface PredictionRequest {
  homeTeamId: string;
  awayTeamId: string;
  matchId?: string;
  competition?: string;
  referee?: string;
  competitiveness?: number;
  isDerby?: boolean;
  isHighStakes?: boolean;
  bookmakerOdds?: Record<string, number>;
}

export interface PredictionResponse {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  probabilities: FullMatchProbabilities;
  valueOpportunities: BetOpportunity[];
  modelConfidence: number;
  computedAt: Date;
}

export class PredictionService {
  private models: Map<string, DixonColesModel> = new Map();
  private engine: ValueBettingEngine;
  private backtester: BacktestingEngine;
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
    this.engine = new ValueBettingEngine();
    this.backtester = new BacktestingEngine();
  }

  private clamp(v: number, min: number, max: number): number {
    if (!isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
  }

  private sanitizeModelParams(raw: any) {
    const attackParams: Record<string, number> = {};
    const defenceParams: Record<string, number> = {};

    for (const [team, value] of Object.entries(raw?.attackParams ?? {})) {
      const n = Number(value);
      attackParams[team] = isFinite(n) ? this.clamp(n, -3.5, 3.5) : 0;
    }

    for (const [team, value] of Object.entries(raw?.defenceParams ?? {})) {
      const n = Number(value);
      defenceParams[team] = isFinite(n) ? this.clamp(n, -3.5, 3.5) : 0;
    }

    return {
      attackParams,
      defenceParams,
      homeAdvantage: this.clamp(Number(raw?.homeAdvantage ?? 0.25), -0.8, 1.2),
      rho: this.clamp(Number(raw?.rho ?? -0.13), -0.5, 0.0),
      tau: this.clamp(Number(raw?.tau ?? 0.0065), 0.0001, 0.05),
    };
  }

  private normalizeBookmakerOdds(input?: Record<string, number>): Record<string, number> {
    if (!input) return {};

    const out: Record<string, number> = {};
    const aliasMap: Record<string, string> = {
      cards_over35: 'yellow_over_3.5',
      cards_over45: 'yellow_over_4.5',
      cards_over55: 'yellow_over_5.5',
      cards_under35: 'yellow_under_3.5',
      cards_under45: 'yellow_under_4.5',
      fouls_over205: 'fouls_over_20.5',
      fouls_over235: 'fouls_over_23.5',
      fouls_over265: 'fouls_over_26.5',
      fouls_under235: 'fouls_under_23.5',
      shots_over225: 'shots_total_over_23.5',
      shots_over255: 'shots_total_over_25.5',
      shots_under225: 'shots_total_under_23.5',
      sot_over75: 'sot_total_over_7.5',
      sot_over95: 'sot_total_over_9.5',
    };

    const normalizeLine = (raw: string): string => {
      const cleaned = String(raw ?? '').trim().replace(',', '.');
      if (/^\d+\.\d+$/.test(cleaned)) return cleaned;
      if (/^\d+$/.test(cleaned) && cleaned.length >= 2) {
        return `${cleaned.slice(0, -1)}.${cleaned.slice(-1)}`;
      }
      return cleaned;
    };

    const register = (key: string, odd: number) => {
      if (!isFinite(odd) || odd <= 1) return;
      out[key] = odd;
    };

    for (const [k, rawV] of Object.entries(input)) {
      const v = Number(rawV);
      if (!isFinite(v) || v <= 1) continue;

      const canonical = aliasMap[k];
      register(canonical ?? k, v);

      // over25 -> over2.5 / under35 -> under3.5 (goal totals)
      const compactGoal = k.match(/^(over|under)(\d+)$/i);
      if (compactGoal && compactGoal[2].length >= 2) {
        const side = compactGoal[1].toLowerCase();
        const line = normalizeLine(compactGoal[2]);
        register(`${side}${line.replace('.', '')}`, v);
      }

      // Mercati dinamici: shots_total_over_235 -> shots_total_over_23.5
      const prefixed = k.match(/^(shots_total|shots_home|shots_away|fouls|yellow|cards_total|sot_total)_(over|under)_([0-9]+(?:[.,][0-9]+)?)$/i);
      if (prefixed) {
        const prefix = prefixed[1].toLowerCase();
        const side = prefixed[2].toLowerCase();
        const line = normalizeLine(prefixed[3]);
        register(`${prefix}_${side}_${line}`, v);
      }
    }

    return out;
  }

  private async getModel(competition: string = 'default'): Promise<DixonColesModel> {
    if (!this.models.has(competition)) {
      const saved = await this.db.getLatestModelParams(competition);
      if (saved) {
        const model = new DixonColesModel();
        model.setParams(this.sanitizeModelParams(saved.params));
        this.models.set(competition, model);
      } else {
        this.models.set(competition, new DixonColesModel());
      }
    }
    return this.models.get(competition)!;
  }

  async fitModelForCompetition(competition: string, season?: string, fromDate?: string, toDate?: string) {
    const rawMatches = await this.db.getMatches({ competition, season, fromDate, toDate });
    const matches: MatchData[] = rawMatches
      .filter((m: any) => m.home_goals !== null && m.away_goals !== null)
      .map((m: any) => ({
        matchId: m.match_id, homeTeamId: m.home_team_id, awayTeamId: m.away_team_id,
        date: new Date(m.date),
        homeGoals: m.home_goals, awayGoals: m.away_goals,
        homeXG: m.home_xg, awayXG: m.away_xg,
        competition: m.competition, season: m.season,
      }));

    if (matches.length < 20) throw new Error(`Dati insufficienti: ${matches.length} partite. Servono almeno 20.`);

    const teams = [...new Set(matches.flatMap(m => [m.homeTeamId, m.awayTeamId]))];
    const model = new DixonColesModel();
    const params = model.fitModel(matches, teams);

    // Aggiorna parametri nel DB e ricalcola medie statistiche
    for (const teamId of teams) {
      const existing = await this.db.getTeam(teamId);
      if (existing) {
        await this.db.upsertTeam({
          ...this.teamRowToObj(existing),
          teamId,
          attackStrength: params.attackParams[teamId] ?? 0,
          defenceStrength: params.defenceParams[teamId] ?? 0,
        });
        await this.db.recomputeTeamAverages(teamId);
      }
    }

    const logLikelihood = this.computeLL(model, matches);
    await this.db.saveModelParams(competition, season ?? 'all', params, matches.length, logLikelihood);
    this.models.set(competition, model);

    return { matchesUsed: matches.length, logLikelihood, teams: teams.length };
  }

  private teamRowToObj(row: any) {
    return {
      teamId: row.team_id, name: row.name, shortName: row.short_name,
      country: row.country, competition: row.competition,
      avgHomeShots: row.avg_home_shots, avgAwayShots: row.avg_away_shots,
      avgHomeShotsOT: row.avg_home_shots_ot, avgAwayShotsOT: row.avg_away_shots_ot,
      avgHomeXG: row.avg_home_xg, avgAwayXG: row.avg_away_xg,
      avgYellowCards: row.avg_yellow_cards, avgRedCards: row.avg_red_cards,
      avgFouls: row.avg_fouls, shotsSuppression: row.shots_suppression,
    };
  }

  private computeLL(model: DixonColesModel, matches: MatchData[]): number {
    let ll = 0;
    for (const m of matches) {
      if (m.homeGoals === undefined || m.awayGoals === undefined) continue;
      const matrix = model.buildScoreMatrix(m.homeTeamId, m.awayTeamId);
      const hg = Math.min(m.homeGoals, matrix.maxGoals);
      const ag = Math.min(m.awayGoals, matrix.maxGoals);
      const p = matrix.probabilities[hg][ag];
      ll += Math.log(Math.max(1e-12, p));
    }
    return ll;
  }

  async predict(request: PredictionRequest): Promise<PredictionResponse> {
    const model = await this.getModel(request.competition);
    const homeTeam = await this.db.getTeam(request.homeTeamId);
    const awayTeam = await this.db.getTeam(request.awayTeamId);
    const referee = request.referee ? await this.db.getRefereeByName(request.referee) : null;

    // Carica giocatori per i tiri per giocatore
    const homePlayers = await this.db.getPlayersByTeam(request.homeTeamId);
    const awayPlayers = await this.db.getPlayersByTeam(request.awayTeamId);

    const toPlayerData = (p: any): PlayerShotsData => ({
      playerId: p.player_id, playerName: p.name, teamId: p.team_id,
      avgShotsPerGame: p.avg_shots_per_game, avgShotsOnTargetPerGame: p.avg_shots_on_target_per_game,
      gamesPlayed: p.games_played, shotShareOfTeam: p.shot_share_of_team,
      isStarter: true, positionCode: p.position_code,
    });

    const competitiveness =
      request.competitiveness !== undefined
        ? this.clamp(request.competitiveness, 0, 1)
        : this.clamp(0.30 + (request.isDerby ? 0.35 : 0) + (request.isHighStakes ? 0.20 : 0), 0, 1);

    const supp: SupplementaryData = {
      homeTeamStats: homeTeam ? {
        avgShots: homeTeam.avg_home_shots ?? 12.1,
        avgShotsOT: homeTeam.avg_home_shots_ot ?? 4.8,
        avgYellowCards: homeTeam.avg_yellow_cards ?? 1.9,
        avgRedCards: homeTeam.avg_red_cards ?? 0.11,
        avgFouls: homeTeam.avg_fouls ?? 11.2,
        shotsSuppression: homeTeam.shots_suppression ?? 1.0,
      } : undefined,
      awayTeamStats: awayTeam ? {
        avgShots: awayTeam.avg_away_shots ?? 10.4,
        avgShotsOT: awayTeam.avg_away_shots_ot ?? 3.9,
        avgYellowCards: awayTeam.avg_yellow_cards ?? 1.9,
        avgRedCards: awayTeam.avg_red_cards ?? 0.11,
        avgFouls: awayTeam.avg_fouls ?? 11.2,
        shotsSuppression: awayTeam.shots_suppression ?? 1.0,
      } : undefined,
      refereeStats: referee ? {
        avgYellow: referee.avg_yellow_cards_per_game,
        avgRed: referee.avg_red_cards_per_game,
        avgFouls: referee.avg_fouls_per_game,
      } : undefined,
      homePlayers: homePlayers.map(toPlayerData),
      awayPlayers: awayPlayers.map(toPlayerData),
      competitiveness,
    };

    const probs = model.computeFullProbabilities(
      request.homeTeamId, request.awayTeamId,
      undefined, undefined, supp
    );

    // Value bets
    let valueOpportunities: BetOpportunity[] = [];
    const normalizedOdds = this.normalizeBookmakerOdds(request.bookmakerOdds);
    if (Object.keys(normalizedOdds).length > 0) {
      const flatProbs = this.flattenProbabilities(probs);
      const marketNames = this.buildMarketNames(Object.keys(flatProbs));
      valueOpportunities = this.engine.analyzeMarkets(flatProbs, normalizedOdds, marketNames);
    }

    const matchCount = (await this.db.getMatches({ competition: request.competition })).length;
    const modelConfidence = Math.min(0.95, Math.max(0.30, 1 / (1 + Math.exp(-(matchCount - 100) / 40))));

    return {
      matchId: request.matchId ?? `pred_${Date.now()}`,
      homeTeam: homeTeam?.name ?? request.homeTeamId,
      awayTeam: awayTeam?.name ?? request.awayTeamId,
      probabilities: probs,
      valueOpportunities,
      modelConfidence,
      computedAt: new Date(),
    };
  }

  private flattenProbabilities(probs: FullMatchProbabilities): Record<string, number> {
    const poisOver = (line: number, lambda: number) => {
      const maxK = Math.max(14, Math.ceil(lambda + 8 * Math.sqrt(Math.max(0.1, lambda))));
      let cdf = 0;
      for (let k = 0; k <= Math.floor(line) && k <= maxK; k++) {
        let p = Math.exp(-lambda);
        for (let i = 1; i <= k; i++) p *= lambda / i;
        cdf += p;
      }
      return Math.max(0, Math.min(1, 1 - cdf));
    };

    const flat: Record<string, number> = {
      homeWin: probs.homeWin, draw: probs.draw, awayWin: probs.awayWin,
      btts: probs.btts, bttsNo: 1 - probs.btts,
      over05: probs.over05, over15: probs.over15, over25: probs.over25,
      over35: probs.over35, over45: probs.over45,
      under05: probs.under05, under15: probs.under15, under25: probs.under25, under35: probs.under35, under45: probs.under45,
    };

    for (const [k, v] of Object.entries(probs.exactScore)) flat[`exact_${k}`] = v as number;
    for (const [k, v] of Object.entries(probs.handicap)) flat[`hcp_${k}`] = v as number;
    for (const [k, v] of Object.entries(probs.asianHandicap)) flat[`ahcp_${k}`] = v as number;

    // Tiri totali squadra
    for (const [k, v] of Object.entries(probs.shotsTotal)) {
      flat[`shots_total_over_${k}`] = (v as any).over;
      flat[`shots_total_under_${k}`] = (v as any).under;
    }
    for (const [k, v] of Object.entries(probs.shotsHome.overUnder)) {
      flat[`shots_home_over_${k}`] = (v as any).over;
    }
    for (const [k, v] of Object.entries(probs.shotsAway.overUnder)) {
      flat[`shots_away_over_${k}`] = (v as any).over;
    }

    // Cartellini
    for (const [k, v] of Object.entries(probs.cards.overUnderYellow)) {
      flat[`yellow_over_${k}`] = (v as any).over;
      flat[`yellow_under_${k}`] = (v as any).under;
    }
    for (const [k, v] of Object.entries(probs.cards.overUnderTotal)) {
      flat[`cards_total_over_${k}`] = (v as any).over;
      flat[`cards_total_under_${k}`] = (v as any).under;
    }
    flat.cards_over35 = probs.cards.overUnderYellow['3.5']?.over ?? 0;
    flat.cards_over45 = probs.cards.overUnderYellow['4.5']?.over ?? 0;
    flat.cards_over55 = probs.cards.overUnderYellow['5.5']?.over ?? 0;
    flat.cards_under35 = probs.cards.overUnderYellow['3.5']?.under ?? 0;
    flat.cards_under45 = probs.cards.overUnderYellow['4.5']?.under ?? 0;

    // Falli
    for (const [k, v] of Object.entries(probs.fouls.overUnder)) {
      flat[`fouls_over_${k}`] = (v as any).over;
      flat[`fouls_under_${k}`] = (v as any).under;
    }
    flat.fouls_over205 = probs.fouls.overUnder['20.5']?.over ?? 0;
    flat.fouls_over235 = probs.fouls.overUnder['23.5']?.over ?? 0;
    flat.fouls_over265 = probs.fouls.overUnder['26.5']?.over ?? 0;
    flat.fouls_under235 = probs.fouls.overUnder['23.5']?.under ?? 0;

    // Alias legacy usati dal frontend
    flat.shots_over225 = probs.shotsTotal['23.5']?.over ?? 0;
    flat.shots_over255 = probs.shotsTotal['25.5']?.over ?? 0;
    flat.shots_under225 = probs.shotsTotal['23.5']?.under ?? 0;
    const lambdaSOT = Math.max(0.1, probs.shotsOnTargetHome.expected + probs.shotsOnTargetAway.expected);
    for (const line of [5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5]) {
      const over = poisOver(line, lambdaSOT);
      const key = line.toFixed(1);
      flat[`sot_total_over_${key}`] = over;
      flat[`sot_total_under_${key}`] = 1 - over;
    }
    flat.sot_over75 = flat['sot_total_over_7.5'];
    flat.sot_over95 = flat['sot_total_over_9.5'];

    return flat;
  }

  private buildMarketNames(selections: string[] = []): Record<string, string> {
    const names: Record<string, string> = {
      homeWin: '1X2 - Vittoria Casa',
      draw: '1X2 - Pareggio',
      awayWin: '1X2 - Vittoria Ospite',
      btts: 'Goal/Goal - Si',
      bttsNo: 'Goal/Goal - No',
      over25: 'Over 2.5 Goal',
      under25: 'Under 2.5 Goal',
      over15: 'Over 1.5 Goal',
      over35: 'Over 3.5 Goal',
      under05: 'Under 0.5 Goal',
      cards_over35: 'Cartellini Over 3.5',
      cards_over45: 'Cartellini Over 4.5',
      cards_over55: 'Cartellini Over 5.5',
      cards_under35: 'Cartellini Under 3.5',
      cards_under45: 'Cartellini Under 4.5',
      fouls_over205: 'Falli Over 20.5',
      fouls_over235: 'Falli Over 23.5',
      fouls_over265: 'Falli Over 26.5',
      fouls_under235: 'Falli Under 23.5',
      shots_over225: 'Tiri Totali Over 22.5',
      shots_over255: 'Tiri Totali Over 25.5',
      shots_under225: 'Tiri Totali Under 22.5',
      sot_over75: 'Tiri in Porta Over 7.5',
      sot_over95: 'Tiri in Porta Over 9.5',
    };

    const formatLine = (raw: string): string => {
      const n = Number(raw);
      if (!isFinite(n)) return raw;
      return n.toFixed(1);
    };

    const dynamicName = (selection: string): string | null => {
      const m = selection.match(/^(shots_total|shots_home|shots_away|fouls|yellow|cards_total|sot_total)_(over|under)_([0-9]+(?:\.[0-9]+)?)$/);
      if (m) {
        const domainLabels: Record<string, string> = {
          shots_total: 'Tiri Totali',
          shots_home: 'Tiri Casa',
          shots_away: 'Tiri Ospite',
          fouls: 'Falli Totali',
          yellow: 'Gialli Totali',
          cards_total: 'Cartellini Pesati',
          sot_total: 'Tiri in Porta Totali',
        };
        const side = m[2] === 'over' ? 'Over' : 'Under';
        return `${domainLabels[m[1]] ?? m[1]} ${side} ${formatLine(m[3])}`;
      }

      const goal = selection.match(/^(over|under)(\d+)$/);
      if (goal && goal[2].length >= 2) {
        const side = goal[1] === 'over' ? 'Over' : 'Under';
        const line = `${goal[2].slice(0, -1)}.${goal[2].slice(-1)}`;
        return `${side} ${line} Goal`;
      }

      const exact = selection.match(/^exact_(\d+-\d+)$/);
      if (exact) return `Risultato Esatto ${exact[1]}`;

      if (selection.startsWith('hcp_')) return `Handicap Europeo ${selection.replace('hcp_', '')}`;
      if (selection.startsWith('ahcp_')) return `Asian Handicap ${selection.replace('ahcp_', '')}`;
      return null;
    };

    for (const key of selections) {
      if (names[key]) continue;
      const inferred = dynamicName(key);
      if (inferred) names[key] = inferred;
    }

    return names;
  }
  // ==================== BUDGET ====================

  async getBudget(userId: string) { return this.db.getBudget(userId); }

  async initBudget(userId: string, amount: number) {
    await this.db.createOrResetBudget(userId, amount);
    return this.db.getBudget(userId);
  }

  async placeBet(userId: string, matchId: string, marketName: string, selection: string, odds: number, stake: number, ourProbability: number, expectedValue: number) {
    const budget = await this.db.getBudget(userId);
    if (!budget) throw new Error('Budget non trovato');
    if (stake > budget.available_budget) throw new Error(`Budget insufficiente: €${budget.available_budget.toFixed(2)} disponibili`);

    const bet = {
      betId: uuidv4(), userId, matchId, marketName, selection,
      odds, stake, ourProbability, expectedValue,
      status: 'PENDING', placedAt: new Date(),
    };

    await this.db.saveBet(bet);
    await this.db.updateBudget({
      userId, totalBudget: budget.total_budget,
      availableBudget: budget.available_budget - stake,
      totalBets: budget.total_bets + 1,
      totalStaked: budget.total_staked + stake,
      totalWon: budget.total_won, totalLost: budget.total_lost,
      roi: budget.roi, winRate: budget.win_rate,
    });

    return { bet, budget: await this.db.getBudget(userId) };
  }

  async settleBet(betId: string, won: boolean, returnAmount?: number) {
    const betRow = await this.db.getBet(betId);
    if (!betRow) throw new Error('Scommessa non trovata');

    const budget = await this.db.getBudget(betRow.user_id);
    if (!budget) throw new Error('Budget non trovato');

    const actualReturn = won ? (returnAmount ?? betRow.stake * betRow.odds) : 0;
    const profit = actualReturn - betRow.stake;

    await this.db.saveBet({
      ...betRow, betId: betRow.bet_id, userId: betRow.user_id, matchId: betRow.match_id,
      marketName: betRow.market_name, ourProbability: betRow.our_probability,
      expectedValue: betRow.expected_value, placedAt: betRow.placed_at,
      status: won ? 'WON' : 'LOST',
      returnAmount: actualReturn, profit,
      settledAt: new Date(),
    });

    const newAvail = budget.available_budget + (won ? actualReturn : 0);
    const newWon = budget.total_won + (won ? actualReturn : 0);
    const newLost = budget.total_lost + (won ? 0 : betRow.stake);

    const allBets = await this.db.getBets(betRow.user_id);
    const settled = allBets.filter((b: any) => b.status === 'WON' || b.status === 'LOST');
    const wonCount = settled.filter((b: any) => b.status === 'WON').length;
    const winRate = settled.length > 0 ? (wonCount / settled.length) * 100 : 0;
    const roi = budget.total_staked > 0 ? ((newWon - newLost) / budget.total_staked) * 100 : 0;

    await this.db.updateBudget({
      userId: betRow.user_id, totalBudget: budget.total_budget,
      availableBudget: newAvail, totalBets: budget.total_bets,
      totalStaked: budget.total_staked, totalWon: newWon, totalLost: newLost,
      roi, winRate,
    });

    return { budget: await this.db.getBudget(betRow.user_id) };
  }

  async runBacktest(competition: string, season?: string, historicalOdds?: Record<string, Record<string, number>>) {
    const rawMatches = await this.db.getMatches({ competition, season });
    const matches: MatchData[] = rawMatches
      .filter((m: any) => m.home_goals !== null && m.away_goals !== null)
      .map((m: any) => ({
        matchId: m.match_id, homeTeamId: m.home_team_id, awayTeamId: m.away_team_id,
        date: new Date(m.date), homeGoals: m.home_goals, awayGoals: m.away_goals,
        homeXG: m.home_xg, awayXG: m.away_xg,
      }));

    if (matches.length < 50) throw new Error(`Servono almeno 50 partite. Disponibili: ${matches.length}`);

    const result = this.backtester.runBacktest(matches, historicalOdds ?? {});
    await this.db.saveBacktestResult(competition, season ?? 'all', result);
    return result;
  }
}

