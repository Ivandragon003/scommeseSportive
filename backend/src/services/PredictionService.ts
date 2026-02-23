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

  private getModel(competition: string = 'default'): DixonColesModel {
    if (!this.models.has(competition)) {
      const saved = this.db.getLatestModelParams(competition);
      if (saved) {
        const model = new DixonColesModel();
        model.setParams(saved.params);
        this.models.set(competition, model);
      } else {
        this.models.set(competition, new DixonColesModel());
      }
    }
    return this.models.get(competition)!;
  }

  async fitModelForCompetition(competition: string, season?: string, fromDate?: string, toDate?: string) {
    const rawMatches = this.db.getMatches({ competition, season, fromDate, toDate });
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
      const existing = this.db.getTeam(teamId);
      if (existing) {
        this.db.upsertTeam({
          ...this.teamRowToObj(existing),
          teamId,
          attackStrength: params.attackParams[teamId] ?? 0,
          defenceStrength: params.defenceParams[teamId] ?? 0,
        });
        this.db.recomputeTeamAverages(teamId);
      }
    }

    const logLikelihood = this.computeLL(model, matches);
    this.db.saveModelParams(competition, season ?? 'all', params, matches.length, logLikelihood);
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
      if (p > 0) ll += Math.log(p);
    }
    return ll;
  }

  predict(request: PredictionRequest): PredictionResponse {
    const model = this.getModel(request.competition);
    const homeTeam = this.db.getTeam(request.homeTeamId);
    const awayTeam = this.db.getTeam(request.awayTeamId);
    const referee = request.referee ? this.db.getRefereeByName(request.referee) : null;

    // Carica giocatori per i tiri per giocatore
    const homePlayers = this.db.getPlayersByTeam(request.homeTeamId);
    const awayPlayers = this.db.getPlayersByTeam(request.awayTeamId);

    const toPlayerData = (p: any): PlayerShotsData => ({
      playerId: p.player_id, playerName: p.name, teamId: p.team_id,
      avgShotsPerGame: p.avg_shots_per_game, avgShotsOnTargetPerGame: p.avg_shots_on_target_per_game,
      gamesPlayed: p.games_played, shotShareOfTeam: p.shot_share_of_team,
      isStarter: true, positionCode: p.position_code,
    });

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
      competitiveness: request.competitiveness ?? 0.3,
    };

    const probs = model.computeFullProbabilities(
      request.homeTeamId, request.awayTeamId,
      undefined, undefined, supp
    );

    // Value bets
    let valueOpportunities: BetOpportunity[] = [];
    if (request.bookmakerOdds && Object.keys(request.bookmakerOdds).length > 0) {
      const flatProbs = this.flattenProbabilities(probs);
      const marketNames = this.buildMarketNames();
      valueOpportunities = this.engine.analyzeMarkets(flatProbs, request.bookmakerOdds, marketNames);
    }

    const matchCount = this.db.getMatches({ competition: request.competition }).length;
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
    const flat: Record<string, number> = {
      homeWin: probs.homeWin, draw: probs.draw, awayWin: probs.awayWin,
      btts: probs.btts, bttsNo: 1 - probs.btts,
      over05: probs.over05, over15: probs.over15, over25: probs.over25,
      over35: probs.over35, over45: probs.over45,
      under15: probs.under15, under25: probs.under25, under35: probs.under35, under45: probs.under45,
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

    // Falli
    for (const [k, v] of Object.entries(probs.fouls.overUnder)) {
      flat[`fouls_over_${k}`] = (v as any).over;
      flat[`fouls_under_${k}`] = (v as any).under;
    }

    return flat;
  }

  private buildMarketNames(): Record<string, string> {
    return {
      homeWin: '1X2 - Vittoria Casa', draw: '1X2 - Pareggio', awayWin: '1X2 - Vittoria Ospite',
      btts: 'Goal/Goal - Sì', bttsNo: 'Goal/Goal - No',
      over25: 'Over 2.5 Goal', under25: 'Under 2.5 Goal',
      over15: 'Over 1.5 Goal', over35: 'Over 3.5 Goal',
    };
  }

  // ==================== BUDGET ====================

  getBudget(userId: string) { return this.db.getBudget(userId); }

  initBudget(userId: string, amount: number) {
    this.db.createOrResetBudget(userId, amount);
    return this.db.getBudget(userId);
  }

  placeBet(userId: string, matchId: string, marketName: string, selection: string, odds: number, stake: number, ourProbability: number, expectedValue: number) {
    const budget = this.db.getBudget(userId);
    if (!budget) throw new Error('Budget non trovato');
    if (stake > budget.available_budget) throw new Error(`Budget insufficiente: €${budget.available_budget.toFixed(2)} disponibili`);

    const bet = {
      betId: uuidv4(), userId, matchId, marketName, selection,
      odds, stake, ourProbability, expectedValue,
      status: 'PENDING', placedAt: new Date(),
    };

    this.db.saveBet(bet);
    this.db.updateBudget({
      userId, totalBudget: budget.total_budget,
      availableBudget: budget.available_budget - stake,
      totalBets: budget.total_bets + 1,
      totalStaked: budget.total_staked + stake,
      totalWon: budget.total_won, totalLost: budget.total_lost,
      roi: budget.roi, winRate: budget.win_rate,
    });

    return { bet, budget: this.db.getBudget(userId) };
  }

  settleBet(betId: string, won: boolean, returnAmount?: number) {
    const betRow = this.db.getBet(betId);
    if (!betRow) throw new Error('Scommessa non trovata');

    const budget = this.db.getBudget(betRow.user_id);
    if (!budget) throw new Error('Budget non trovato');

    const actualReturn = won ? (returnAmount ?? betRow.stake * betRow.odds) : 0;
    const profit = actualReturn - betRow.stake;

    this.db.saveBet({
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

    const allBets = this.db.getBets(betRow.user_id);
    const settled = allBets.filter((b: any) => b.status === 'WON' || b.status === 'LOST');
    const wonCount = settled.filter((b: any) => b.status === 'WON').length;
    const winRate = settled.length > 0 ? (wonCount / settled.length) * 100 : 0;
    const roi = budget.total_staked > 0 ? ((newWon - newLost) / budget.total_staked) * 100 : 0;

    this.db.updateBudget({
      userId: betRow.user_id, totalBudget: budget.total_budget,
      availableBudget: newAvail, totalBets: budget.total_bets,
      totalStaked: budget.total_staked, totalWon: newWon, totalLost: newLost,
      roi, winRate,
    });

    return { budget: this.db.getBudget(betRow.user_id) };
  }

  async runBacktest(competition: string, season?: string, historicalOdds?: Record<string, Record<string, number>>) {
    const rawMatches = this.db.getMatches({ competition, season });
    const matches: MatchData[] = rawMatches
      .filter((m: any) => m.home_goals !== null && m.away_goals !== null)
      .map((m: any) => ({
        matchId: m.match_id, homeTeamId: m.home_team_id, awayTeamId: m.away_team_id,
        date: new Date(m.date), homeGoals: m.home_goals, awayGoals: m.away_goals,
        homeXG: m.home_xg, awayXG: m.away_xg,
      }));

    if (matches.length < 50) throw new Error(`Servono almeno 50 partite. Disponibili: ${matches.length}`);

    const result = this.backtester.runBacktest(matches, historicalOdds ?? {});
    this.db.saveBacktestResult(competition, season ?? 'all', result);
    return result;
  }
}
