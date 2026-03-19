import { DixonColesModel, MatchData, FullMatchProbabilities, SupplementaryData } from '../models/DixonColesModel';
import {
  ValueBettingEngine,
  BetOpportunity,
  SelectionDiagnostics,
  AdaptiveEngineTuningProfile,
  MarketCategory,
} from '../models/ValueBettingEngine';
import { BacktestingEngine, WalkForwardBacktestResult } from '../models/BacktestingEngine';
import { DatabaseService } from '../db/DatabaseService';
import { v4 as uuidv4 } from 'uuid';
import { PredictionContextBuilder } from './PredictionContextBuilder';

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
  homeFormIndex?: number;
  awayFormIndex?: number;
  homeObjectiveIndex?: number;
  awayObjectiveIndex?: number;
  homeRestDays?: number;
  awayRestDays?: number;
  homeRecentMatchesCount?: number;
  awayRecentMatchesCount?: number;
  homeSuspensions?: number;
  awaySuspensions?: number;
  homeRecentRedCards?: number;
  awayRecentRedCards?: number;
  homeDiffidati?: number;
  awayDiffidati?: number;
  homeKeyAbsences?: number;
  awayKeyAbsences?: number;
}

export interface AnalysisFactors {
  homeAdvantageIndex: number;
  formDelta: number;
  motivationDelta: number;
  restDelta: number;
  scheduleLoadDelta: number;
  suspensionsDelta: number;
  disciplinaryDelta: number;
  atRiskPlayersDelta: number;
  competitiveness: number;
  notes: string[];
}

export interface BestValueOpportunityExplanation {
  selection: string;
  selectionLabel: string;
  marketName: string;
  marketTier: string;
  bookmakerOdds: number;
  expectedValue: number;
  edge: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  score: number;
  humanSummary: string;
  humanReasons: string[];
  reasons: string[];
  factorBreakdown: {
    baseModelScore: number;
    contextualScore: number;
    totalScore: number;
  };
}

export interface PredictionResponse {
  matchId: string;
  competition?: string;
  homeTeam: string;
  awayTeam: string;
  probabilities: FullMatchProbabilities;
  valueOpportunities: BetOpportunity[];
  bestValueOpportunity?: BestValueOpportunityExplanation | null;
  analysisFactors?: AnalysisFactors;
  modelConfidence: number;
  computedAt: Date;
}

export interface CompletedMatchLearningReview {
  reviewType: 'model_confirmed' | 'ranking_error' | 'filter_rejection' | 'no_actionable_signal';
  headline: string;
  humanSummary: string;
  lessons: string[];
  recommendedSelection: {
    selection: string;
    selectionLabel: string;
    marketName: string;
    bookmakerOdds: number;
    result: 'WON' | 'LOST' | 'VOID' | 'UNKNOWN';
  } | null;
  missedWinningSelection: {
    selection: string;
    selectionLabel: string;
    marketName: string;
    bookmakerOdds: number | null;
    result: 'WON' | 'LOST' | 'VOID';
    wasAlreadyValueBet: boolean;
    diagnostics: SelectionDiagnostics;
  } | null;
}

export class PredictionService {
  private models: Map<string, DixonColesModel> = new Map();
  private engine: ValueBettingEngine;
  private backtester: BacktestingEngine;
  private db: DatabaseService;
  private contextBuilder: PredictionContextBuilder;
  private adaptiveTuningCache: Map<string, { expiresAt: number; profile: AdaptiveEngineTuningProfile }> = new Map();

  constructor(db: DatabaseService) {
    this.db = db;
    this.engine = new ValueBettingEngine();
    this.backtester = new BacktestingEngine();
    this.contextBuilder = new PredictionContextBuilder();
  }

  private clamp(v: number, min: number, max: number): number {
    if (!isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
  }

  private normalizeReplayOdds(input?: Record<string, number>): Record<string, number> {
    return Object.entries(input ?? {}).reduce((acc, [selection, odds]) => {
      const value = Number(odds);
      if (Number.isFinite(value) && value > 1) {
        acc[selection] = Number(value.toFixed(2));
      }
      return acc;
    }, {} as Record<string, number>);
  }

  private buildEmptyAdaptiveTuningProfile(): AdaptiveEngineTuningProfile {
    return {
      source: 'learning_reviews',
      generatedAt: new Date().toISOString(),
      totalReviews: 0,
      categories: {},
    };
  }

  private getAdaptiveTuningCacheKey(competition?: string): string {
    const normalized = String(competition ?? '').trim().toLowerCase();
    return normalized || 'all';
  }

  async getAdaptiveTuningProfile(competition?: string, forceRefresh = false): Promise<AdaptiveEngineTuningProfile> {
    const cacheKey = this.getAdaptiveTuningCacheKey(competition);
    const now = Date.now();
    const cached = this.adaptiveTuningCache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > now) {
      return cached.profile;
    }

    const reviews = await this.db.getLearningReviews({
      competition,
      limit: 250,
    });

    const categories = new Map<MarketCategory, {
      total: number;
      rankingErrors: number;
      filterRejections: number;
      confirmations: number;
    }>();

    const register = (category: MarketCategory | null, reviewType: string) => {
      if (!category) return;
      const bucket = categories.get(category) ?? {
        total: 0,
        rankingErrors: 0,
        filterRejections: 0,
        confirmations: 0,
      };
      bucket.total += 1;
      if (reviewType === 'ranking_error') bucket.rankingErrors += 1;
      if (reviewType === 'filter_rejection') bucket.filterRejections += 1;
      if (reviewType === 'model_confirmed') bucket.confirmations += 1;
      categories.set(category, bucket);
    };

    for (const row of reviews) {
      const review = row?.review ?? {};
      const reviewType = String(row?.reviewType ?? review?.reviewType ?? 'no_actionable_signal');
      const primarySelection =
        reviewType === 'model_confirmed'
          ? String(review?.recommendedSelection?.selection ?? '').trim()
          : String(review?.missedWinningSelection?.selection ?? review?.recommendedSelection?.selection ?? '').trim();
      if (!primarySelection) continue;
      register(this.engine.categorizeSelection(primarySelection), reviewType);
    }

    const profile: AdaptiveEngineTuningProfile = this.buildEmptyAdaptiveTuningProfile();
    profile.generatedAt = new Date().toISOString();
    profile.totalReviews = reviews.length;

    for (const [category, bucket] of categories.entries()) {
      const total = Math.max(1, bucket.total);
      const confidenceScale = this.clamp(total / 12, 0.25, 1);
      const rankingErrorRate = bucket.rankingErrors / total;
      const filterRejectionRate = bucket.filterRejections / total;
      const confirmationRate = bucket.confirmations / total;

      const rawEvDelta =
        (-filterRejectionRate * 0.012) +
        (-rankingErrorRate * 0.004) +
        (confirmationRate * 0.003);
      const rawCoherenceDelta =
        (-filterRejectionRate * 0.08) +
        (-rankingErrorRate * 0.02) +
        (confirmationRate * 0.015);
      const rawRankingMultiplier =
        1 +
        (rankingErrorRate * 0.18) +
        (confirmationRate * 0.06) -
        (filterRejectionRate * 0.02);

      profile.categories[category] = {
        evDelta: Number(this.clamp(rawEvDelta * confidenceScale, -0.012, 0.006).toFixed(4)),
        coherenceDelta: Number(this.clamp(rawCoherenceDelta * confidenceScale, -0.08, 0.03).toFixed(4)),
        rankingMultiplier: Number(this.clamp(1 + ((rawRankingMultiplier - 1) * confidenceScale), 0.92, 1.18).toFixed(3)),
        sampleSize: bucket.total,
        rankingErrorRate: Number((rankingErrorRate * 100).toFixed(2)),
        filterRejectionRate: Number((filterRejectionRate * 100).toFixed(2)),
        confirmationRate: Number((confirmationRate * 100).toFixed(2)),
      };
    }

    this.adaptiveTuningCache.set(cacheKey, {
      expiresAt: now + 5 * 60 * 1000,
      profile,
    });
    return profile;
  }

  private async applyAdaptiveTuning(competition?: string, forceRefresh = false): Promise<AdaptiveEngineTuningProfile> {
    const profile = await this.getAdaptiveTuningProfile(competition, forceRefresh);
    this.engine.setAdaptiveTuning(profile);
    this.backtester.setAdaptiveTuning(profile);
    return profile;
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
      dnb_home_win: 'dnb_home',
      dnb_away_win: 'dnb_away',
      doublechance_1x: 'double_chance_1x',
      doublechance_x2: 'double_chance_x2',
      doublechance_12: 'double_chance_12',
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
      const prefixed = k.match(/^(shots_total|shots_home|shots_away|fouls|yellow|cards_total|sot_total|corners)_(over|under)_([0-9]+(?:[.,][0-9]+)?)$/i);
      if (prefixed) {
        const prefix = prefixed[1].toLowerCase();
        const side = prefixed[2].toLowerCase();
        const line = normalizeLine(prefixed[3]);
        register(`${prefix}_${side}_${line}`, v);
      }

      // team_home_over_15 -> team_home_over_15 / team_home_over_1.5
      const teamTotals = k.match(/^team_(home|away)_(over|under)_([0-9]+(?:[.,][0-9]+)?)$/i);
      if (teamTotals) {
        const sideTeam = teamTotals[1].toLowerCase();
        const side = teamTotals[2].toLowerCase();
        const line = normalizeLine(teamTotals[3]).replace('.', '');
        register(`team_${sideTeam}_${side}_${line}`, v);
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
      avgHomeCorners: row.avg_home_corners, avgAwayCorners: row.avg_away_corners,
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
    const matchRow = request.matchId ? await this.db.getMatchById(request.matchId).catch(() => null) : null;
    const referenceDate = String(matchRow?.date ?? '').trim() || undefined;
    const [homeSchedule, awaySchedule] = await Promise.all([
      this.db.getTeamScheduleInsights(request.homeTeamId, referenceDate).catch(() => null),
      this.db.getTeamScheduleInsights(request.awayTeamId, referenceDate).catch(() => null),
    ]);
    const derivedRequest: PredictionRequest = {
      ...request,
      homeRestDays: request.homeRestDays ?? homeSchedule?.restDays ?? undefined,
      awayRestDays: request.awayRestDays ?? awaySchedule?.restDays ?? undefined,
      homeRecentMatchesCount: request.homeRecentMatchesCount ?? homeSchedule?.matchesInLast14Days ?? undefined,
      awayRecentMatchesCount: request.awayRecentMatchesCount ?? awaySchedule?.matchesInLast14Days ?? undefined,
    };
    await this.applyAdaptiveTuning(derivedRequest.competition ?? homeTeam?.competition ?? awayTeam?.competition ?? undefined);

    // Carica giocatori per i tiri per giocatore
    const homePlayers = await this.db.getPlayersByTeam(request.homeTeamId);
    const awayPlayers = await this.db.getPlayersByTeam(request.awayTeamId);

    const context = this.contextBuilder.build({
      request: derivedRequest,
      homeTeam,
      awayTeam,
      referee,
      homePlayers,
      awayPlayers,
    });

    const supp: SupplementaryData = context.supplementaryData;
    const competitiveness = context.competitiveness;
    const probs = model.computeFullProbabilities(
      request.homeTeamId,
      request.awayTeamId,
      context.homeXG,
      context.awayXG,
      supp,
    );

    // Arricchisci con mercati secondari
    this.enrichFlatProbabilities(probs.flatProbabilities);

    // Allinea le chiavi delle quote
    const normalizedOdds = this.normalizeBookmakerOdds(request.bookmakerOdds || {});
    const alignedOdds = this.alignOddsKeys(normalizedOdds);

    const marketNames = this.getMarketNames(Object.keys(probs.flatProbabilities));
    const valueOpportunities = this.engine.analyzeMarkets(probs.flatProbabilities, alignedOdds, marketNames);

    const factors = this.buildAnalysisFactors(derivedRequest, probs, homeTeam, awayTeam, competitiveness);
    const bestValue = this.computeBestValueOpportunity(valueOpportunities, factors);
    const modelConfidence = context.richnessScore;

    return {
      matchId: request.matchId || uuidv4(),
      competition: request.competition ?? homeTeam?.competition ?? awayTeam?.competition ?? undefined,
      homeTeam: homeTeam?.name || 'Home',
      awayTeam: awayTeam?.name || 'Away',
      probabilities: probs,
      valueOpportunities,
      bestValueOpportunity: bestValue,
      analysisFactors: factors,
      modelConfidence,
      computedAt: new Date(),
    };
  }

  private enrichFlatProbabilities(flat: Record<string, number>): void {
    const p1 = flat['homeWin'] || 0;
    const px = flat['draw'] || 0;
    const p2 = flat['awayWin'] || 0;

    if (p1 + p2 > 0) {
      flat['dnb_home'] = p1 / (p1 + p2);
      flat['dnb_away'] = p2 / (p1 + p2);
    }
    flat['double_chance_1x'] = p1 + px;
    flat['double_chance_x2'] = p2 + px;
    flat['double_chance_12'] = p1 + p2;
    // bttsNo è già calcolato in DixonColesModel, rimosso duplicato
  }

  private alignOddsKeys(odds: Record<string, number>): Record<string, number> {
    const aligned: Record<string, number> = {};

    const domainMap: Record<string, string> = {
      'shots_total': 'shots',      // shots_total_over_23.5 → shotsOver235
      'shots_home': 'shotsHome',  // shots_home_over_11.5  → shotsHomeOver115
      'shots_away': 'shotsAway',
      'sot_total': 'shotsOT',
      'corners': 'corners',
      'yellow': 'yellow',
      'fouls': 'fouls',
      'cards_total': 'cardsTotal',
    };

    for (const [key, val] of Object.entries(odds)) {
      if (!Number.isFinite(val) || val <= 1) continue;

      // Formato snake_case con punto: shots_total_over_23.5 o senza punto shots_total_over_235
      const m = key.match(
        /^(shots_total|shots_home|shots_away|sot_total|corners|yellow|fouls|cards_total)_(over|under)_([0-9]+(?:[.,][0-9]+)?)$/i
      );
      if (m) {
        const domain = domainMap[m[1].toLowerCase()] ?? m[1];
        const side = m[2].charAt(0).toUpperCase() + m[2].slice(1);
        const lineKey = m[3].replace(/[.,]/g, '');
        const camelKey = `${domain}${side}${lineKey}`;
        aligned[camelKey] = val;
        aligned[key] = val; // mantieni anche originale per sicurezza
        continue;
      }

      // Chiavi già in altri formati → converti genericamente
      let k = key.toLowerCase()
        .replace(/_([a-z0-9])/g, (_, l) => l.toUpperCase())
        .replace(/[\.\s]/g, '');
      aligned[k] = val;
      aligned[key] = val;
    }

    return aligned;
  }

  getMarketNames(selections: string[]): Record<string, string> {
    const names: Record<string, string> = {
      homeWin: '1X2 - Vittoria Casa',
      draw: '1X2 - Pareggio',
      awayWin: '1X2 - Vittoria Ospite',
      homewin: '1X2 - Vittoria Casa',
      awaywin: '1X2 - Vittoria Ospite',
      double_chance_1x: 'Double Chance 1X',
      double_chance_x2: 'Double Chance X2',
      double_chance_12: 'Double Chance 12',
      dnb_home: 'Draw No Bet - Casa',
      dnb_away: 'Draw No Bet - Ospite',
      btts: 'Goal/Goal - Si',
      bttsNo: 'Goal/Goal - No',
      over25: 'Over 2.5 Goal',
      under25: 'Under 2.5 Goal',
      over15: 'Over 1.5 Goal',
      over35: 'Over 3.5 Goal',
      under05: 'Under 0.5 Goal',
    };

    const formatLine = (raw: string): string => {
      const n = Number(raw);
      return isFinite(n) ? n.toFixed(1) : raw;
    };

    const dynamicName = (selection: string): string | null => {
      const m = selection.match(/^(shots_total|shots_home|shots_away|fouls|yellow|cards_total|sot_total|corners)_(over|under)_([0-9]+(?:[.,][0-9]+)?)$/i);
      if (m) {
        const labels: Record<string, string> = {
          shots_total: 'Tiri Totali', shots_home: 'Tiri Casa', shots_away: 'Tiri Ospite',
          fouls: 'Falli Totali', yellow: 'Gialli Totali', cards_total: 'Cartellini Pesati',
          sot_total: 'Tiri in Porta Totali', corners: 'Angoli Totali'
        };
        return `${labels[m[1]] ?? m[1]} ${m[2] === 'over' ? 'Over' : 'Under'} ${formatLine(m[3])}`;
      }

      const compactStats = selection.match(/^(shots|shotshome|shotsaway|shotsot|corners|yellow|cardstotal|fouls)(Over|Under)(\d+)$/i);
      if (compactStats) {
        const labels: Record<string, string> = {
          shots: 'Tiri Totali',
          shotshome: 'Tiri Casa',
          shotsaway: 'Tiri Ospite',
          shotsot: 'Tiri in Porta Totali',
          corners: 'Angoli Totali',
          yellow: 'Gialli Totali',
          cardstotal: 'Cartellini Pesati',
          fouls: 'Falli Totali',
        };
        const side = compactStats[2].toLowerCase() === 'over' ? 'Over' : 'Under';
        const line = `${compactStats[3].slice(0, -1)}.${compactStats[3].slice(-1)}`;
        return `${labels[compactStats[1].toLowerCase()] ?? compactStats[1]} ${side} ${line}`;
      }

      const cornersMatch = selection.match(/^corners(Over|Under)(\d+)$/);
      if (cornersMatch) {
        const line = `${cornersMatch[2].slice(0, -1)}.${cornersMatch[2].slice(-1)}`;
        return `Angoli ${cornersMatch[1] === 'Over' ? 'Over' : 'Under'} ${line}`;
      }

      const teamTotal = selection.match(/^team_(home|away)_(over|under)_([0-9]+(?:\.[0-9]+)?)$/);
      if (teamTotal) return `Goal ${teamTotal[1] === 'home' ? 'Casa' : 'Ospite'} ${teamTotal[2] === 'over' ? 'Over' : 'Under'} ${formatLine(teamTotal[3])}`;

      const goal = selection.match(/^(over|under)(\d+)$/);
      if (goal && goal[2].length >= 2) {
        const line = `${goal[2].slice(0, -1)}.${goal[2].slice(-1)}`;
        return `${goal[1] === 'over' ? 'Over' : 'Under'} ${line} Goal`;
      }

      return null;
    };

    for (const key of selections) {
      if (!names[key]) {
        const inferred = dynamicName(key);
        if (inferred) names[key] = inferred;
      }
    }
    return names;
  }

  private inferSelectionDirection(selection: string): number {
    const k = String(selection ?? '').toLowerCase();
    if (k === 'homewin' || k === 'dnb_home' || k === 'double_chance_1x' || k.startsWith('hcp_home') || k.startsWith('team_home_') || k.startsWith('ahcp_')) return 1;
    if (k === 'awaywin' || k === 'dnb_away' || k === 'double_chance_x2' || k.startsWith('hcp_away') || k.startsWith('team_away_') || k.startsWith('ahcp_away_')) return -1;
    return 0;
  }

  private buildHumanBestPickExplanation(
    opportunity: BetOpportunity,
    factors: AnalysisFactors
  ): { selectionLabel: string; humanSummary: string; humanReasons: string[] } {
    const selection = String(opportunity.selection ?? '').toLowerCase();
    const selectionLabel =
      this.getMarketNames([opportunity.selection])[opportunity.selection]
      ?? opportunity.marketName
      ?? opportunity.selection;
    const category = this.engine.categorizeSelection(opportunity.selection);
    const direction = this.inferSelectionDirection(opportunity.selection);

    const homeSide = direction >= 0 ? 'la squadra di casa' : 'la squadra ospite';
    const awaySide = direction >= 0 ? 'la squadra ospite' : 'la squadra di casa';
    const reasons: string[] = [];

    const pushUnique = (text: string) => {
      if (!text || reasons.includes(text)) return;
      reasons.push(text);
    };

    if (category === 'goal_1x2') {
      if (selection === 'draw') {
        pushUnique('Il match appare piu equilibrato del normale e non si vede un vantaggio netto da una parte sola.');
      } else if (selection === 'btts' || selection === 'bttsno') {
        pushUnique(
          selection === 'btts'
            ? 'La partita ha segnali da gara in cui entrambe possono costruire occasioni utili.'
            : 'Il quadro atteso lascia spazio a una partita piu bloccata almeno da una delle due parti.'
        );
      } else {
        pushUnique(`La lettura complessiva del match spinge piu verso ${homeSide} che verso ${awaySide}.`);
      }
    } else if (category === 'goal_ou') {
      pushUnique(
        selection.includes('over')
          ? 'La partita ha segnali da ritmo abbastanza alto e da occasioni distribuite su piu fasi del match.'
          : 'Il match sembra piu controllato che aperto e la linea scelta segue meglio questo tipo di sviluppo.'
      );
    } else if (category === 'shots' || category === 'shots_ot') {
      pushUnique(
        selection.includes('over')
          ? 'Il volume offensivo atteso rende questa linea la piu coerente tra le opzioni disponibili.'
          : 'Il ritmo previsto non giustifica una soglia statistica troppo alta su questo mercato.'
      );
    } else if (category === 'fouls' || category === 'yellow_cards') {
      pushUnique(
        selection.includes('over')
          ? 'Il contesto della gara suggerisce una partita piu fisica e spezzettata del normale.'
          : 'Il quadro disciplinare atteso resta abbastanza pulito e non spinge verso una gara troppo ruvida.'
      );
    } else {
      pushUnique('Tra le quote disponibili, questa segue meglio la lettura complessiva della partita.');
    }

    if (Math.abs(factors.homeAdvantageIndex) > 0.18 && direction !== 0) {
      pushUnique(
        factors.homeAdvantageIndex * direction > 0
          ? `${homeSide.charAt(0).toUpperCase() + homeSide.slice(1)} parte con un vantaggio territoriale credibile.`
          : `${awaySide.charAt(0).toUpperCase() + awaySide.slice(1)} ha argomenti per limitare il fattore campo.`
      );
    }

    if (Math.abs(factors.formDelta) > 0.18) {
      pushUnique(`Il momento recente premia ${factors.formDelta > 0 ? 'la squadra di casa' : 'la squadra ospite'}.`);
    }

    if (Math.abs(factors.motivationDelta) > 0.15) {
      pushUnique(`Sul piano degli obiettivi la spinta sembra maggiore per ${factors.motivationDelta > 0 ? 'la squadra di casa' : 'la squadra ospite'}.`);
    }

    if (Math.abs(factors.restDelta) > 0.14) {
      pushUnique(`Sul piano della freschezza arriva meglio ${factors.restDelta > 0 ? 'la squadra di casa' : 'la squadra ospite'}.`);
    }

    if (Math.abs(factors.scheduleLoadDelta) > 0.12) {
      pushUnique(`Il calendario recente pesa di piu su ${factors.scheduleLoadDelta > 0 ? 'chi gioca fuori casa' : 'chi gioca in casa'}.`);
    }

    if (Math.abs(factors.suspensionsDelta) > 0.12) {
      pushUnique(`Le assenze pesano di piu su ${factors.suspensionsDelta > 0 ? 'chi gioca fuori casa' : 'chi gioca in casa'}.`);
    }

    if ((category === 'fouls' || category === 'yellow_cards') && factors.competitiveness > 0.55) {
      pushUnique('La posta della partita e abbastanza alta da aumentare contrasti e interruzioni.');
    }

    if ((category === 'fouls' || category === 'yellow_cards') && Math.abs(factors.disciplinaryDelta) > 0.12) {
      pushUnique('C e un segnale disciplinare che rende plausibile una gara meno pulita del solito.');
    }

    while (reasons.length < 2) {
      pushUnique(
        category === 'goal_1x2'
          ? 'E la scelta piu lineare rispetto a come si distribuiscono i principali scenari della partita.'
          : category === 'goal_ou'
            ? 'E la linea che resta piu coerente anche se il match cambia leggermente ritmo durante la gara.'
            : category === 'shots' || category === 'shots_ot'
              ? 'La soglia scelta resta la piu stabile rispetto al volume statistico previsto.'
              : category === 'fouls' || category === 'yellow_cards'
                ? 'Il tipo di partita atteso sostiene questa lettura in modo piu regolare delle alternative.'
                : 'Resta la giocata piu ordinata e sostenibile tra quelle disponibili.'
      );
    }

    const humanSummary =
      `${selectionLabel} e il pronostico finale consigliato per questa partita, ` +
      `${reasons[0].charAt(0).toLowerCase() + reasons[0].slice(1)}`;

    return {
      selectionLabel,
      humanSummary,
      humanReasons: reasons.slice(0, 3),
    };
  }

  private buildLearningLessonsFromDiagnostics(
    diagnostics: SelectionDiagnostics,
    wasAlreadyValueBet: boolean
  ): string[] {
    const lessons: string[] = [];
    const push = (text: string) => {
      if (!text || lessons.includes(text)) return;
      lessons.push(text);
    };

    if (wasAlreadyValueBet) {
      push('La linea vincente era gia considerata valida dal motore, ma il ranking finale ha premiato un altra selezione.');
      push('Serve ridurre i casi in cui due value bet vicine vengono separate troppo dal peso del ranking finale.');
    }

    if (diagnostics.rejectionCodes.includes('ev_below_threshold')) {
      push(`La linea e stata scartata per margine stimato troppo basso rispetto alla soglia ${diagnostics.minEvThreshold.toFixed(2)}% della categoria ${diagnostics.marketCategory}.`);
    }
    if (diagnostics.rejectionCodes.includes('coherence_too_low')) {
      push('Il modello era troppo lontano dal prezzo del mercato, quindi la selezione e stata trattata come segnale poco affidabile.');
    }
    if (diagnostics.rejectionCodes.includes('edge_no_vig_non_positive')) {
      push('Anche togliendo il margine bookmaker non emergeva un vantaggio sufficiente, quindi il motore ha preferito non forzare la giocata.');
    }
    if (diagnostics.rejectionCodes.includes('odds_out_of_range')) {
      push('La quota era fuori dal range operativo previsto per evitare linee troppo estreme o poco stabili.');
    }
    if (diagnostics.rejectionCodes.includes('kelly_non_positive')) {
      push('Lo stake ottimale risultava nullo, quindi il motore non la riteneva sostenibile da giocare.');
    }
    if (diagnostics.rejectionCodes.includes('missing_market_data')) {
      push('Il mercato non era coperto in modo sufficiente dallo snapshot quote o dalle probabilita interne, quindi non era realmente valutabile.');
    }

    if (lessons.length === 0) {
      push('Non emerge un errore meccanico singolo: il match e uno di quelli in cui una linea vincente resta plausibile solo a posteriori.');
    }

    return lessons.slice(0, 4);
  }

  buildCompletedMatchLearningReview(
    prediction: PredictionResponse,
    matchRow: any,
    bookmakerOdds: Record<string, number>
  ): CompletedMatchLearningReview {
    const recommended = prediction.bestValueOpportunity ?? null;
    const recommendedResult = recommended
      ? this.evaluateSelectionForMatch(String(recommended.selection ?? ''), matchRow)
      : null;
    const marketNames = this.getMarketNames(Object.keys(prediction.probabilities?.flatProbabilities ?? {}));

    const winningSelections = Object.keys(bookmakerOdds ?? {})
      .map((selection) => {
        const result = this.evaluateSelectionForMatch(selection, matchRow);
        if (!result || result.status !== 'WON') return null;
        const diagnostics = this.engine.diagnoseSelection(
          prediction.probabilities?.flatProbabilities ?? {},
          bookmakerOdds ?? {},
          selection,
          marketNames
        );
        const valueOpp = (prediction.valueOpportunities ?? []).find((o) => String(o.selection ?? '') === String(selection));
        return {
          selection,
          result,
          diagnostics,
          wasAlreadyValueBet: Boolean(valueOpp),
          valueOpp: valueOpp ?? null,
        };
      })
      .filter(Boolean) as Array<{
        selection: string;
        result: { status: 'WON' | 'LOST' | 'VOID'; reason: string };
        diagnostics: SelectionDiagnostics;
        wasAlreadyValueBet: boolean;
        valueOpp: BetOpportunity | null;
      }>;

    const alternativeWinningSelections = winningSelections.filter(
      (entry) => String(entry.selection) !== String(recommended?.selection ?? '')
    );

    alternativeWinningSelections.sort((a, b) => {
      if (a.wasAlreadyValueBet !== b.wasAlreadyValueBet) return a.wasAlreadyValueBet ? -1 : 1;
      if (a.diagnostics.passed !== b.diagnostics.passed) return a.diagnostics.passed ? -1 : 1;
      return Number(b.diagnostics.expectedValue ?? -999) - Number(a.diagnostics.expectedValue ?? -999);
    });

    const missed = alternativeWinningSelections[0] ?? null;
    const recommendedSelection = recommended
      ? {
          selection: String(recommended.selection ?? ''),
          selectionLabel: recommended.selectionLabel ?? recommended.marketName,
          marketName: recommended.marketName,
          bookmakerOdds: Number(recommended.bookmakerOdds ?? 0),
          result: (recommendedResult?.status ?? 'UNKNOWN') as 'WON' | 'LOST' | 'VOID' | 'UNKNOWN',
        }
      : null;

    if (recommended && recommendedResult?.status === 'WON') {
      return {
        reviewType: 'model_confirmed',
        headline: 'Pronostico finale confermato',
        humanSummary: 'La selezione finale ha letto correttamente il match. Non c e un errore da correggere su questa partita.',
        lessons: [
          'Il ranking finale ha scelto una linea che ha retto anche sul risultato reale.',
          'Questa partita conferma che il bilanciamento attuale tra filtro value e ranking finale, qui, ha funzionato.'
        ],
        recommendedSelection,
        missedWinningSelection: missed
          ? {
              selection: missed.selection,
              selectionLabel: marketNames[missed.selection] ?? missed.selection,
              marketName: missed.valueOpp?.marketName ?? marketNames[missed.selection] ?? missed.selection,
              bookmakerOdds: missed.diagnostics.bookmakerOdds,
              result: missed.result.status,
              wasAlreadyValueBet: missed.wasAlreadyValueBet,
              diagnostics: missed.diagnostics,
            }
          : null,
      };
    }

    if (!missed) {
      return {
        reviewType: 'no_actionable_signal',
        headline: 'Nessuna correzione chiara dal post-partita',
        humanSummary: 'Con i mercati effettivamente salvati per questa partita non emerge una linea vincente alternativa abbastanza leggibile da usarla come correzione affidabile.',
        lessons: [
          'Non tutte le partite perse producono un errore strutturale correggibile.',
          'Forzare l algoritmo a rincorrere ogni esito vincente a posteriori aumenterebbe l overfitting e peggiorerebbe il modello.'
        ],
        recommendedSelection,
        missedWinningSelection: null,
      };
    }

    const missedSelection = {
      selection: missed.selection,
      selectionLabel: marketNames[missed.selection] ?? missed.selection,
      marketName: missed.valueOpp?.marketName ?? marketNames[missed.selection] ?? missed.selection,
      bookmakerOdds: missed.diagnostics.bookmakerOdds,
      result: missed.result.status,
      wasAlreadyValueBet: missed.wasAlreadyValueBet,
      diagnostics: missed.diagnostics,
    };

    if (missed.wasAlreadyValueBet) {
      return {
        reviewType: 'ranking_error',
        headline: 'Linea vincente gia vista ma non scelta come finale',
        humanSummary: `${missedSelection.selectionLabel} aveva gia segnali utili, ma il ranking finale ha preferito ${recommendedSelection?.selectionLabel ?? 'un altra selezione'} e qui il match ha punito quella scelta.`,
        lessons: this.buildLearningLessonsFromDiagnostics(missed.diagnostics, true),
        recommendedSelection,
        missedWinningSelection: missedSelection,
      };
    }

    return {
      reviewType: 'filter_rejection',
      headline: 'Linea vincente esclusa dai filtri del motore',
      humanSummary: `${missedSelection.selectionLabel} e risultata vincente sul campo, ma non e entrata tra le giocate perche i filtri interni non la consideravano abbastanza solida prima del match.`,
      lessons: this.buildLearningLessonsFromDiagnostics(missed.diagnostics, false),
      recommendedSelection,
      missedWinningSelection: missedSelection,
    };
  }

  async syncCompletedMatchLearningReviews(options?: {
    competition?: string;
    season?: string;
    limit?: number;
    forceRefresh?: boolean;
  }): Promise<{
    considered: number;
    created: number;
    refreshed: number;
    skippedExisting: number;
    skippedNoSnapshot: number;
    skippedNoOdds: number;
    adaptiveTuning: AdaptiveEngineTuningProfile;
  }> {
    const limit = Math.max(5, Math.min(Number(options?.limit ?? 60), 250));
    const matches = await this.db.getRecentCompletedMatches({
      competition: options?.competition,
      season: options?.season,
      limit,
    });

    let considered = 0;
    let created = 0;
    let refreshed = 0;
    let skippedExisting = 0;
    let skippedNoSnapshot = 0;
    let skippedNoOdds = 0;

    for (const match of matches) {
      const matchId = String(match?.match_id ?? '').trim();
      if (!matchId) continue;
      considered += 1;

      const existing = await this.db.getLearningReview(matchId);
      if (existing && !options?.forceRefresh) {
        skippedExisting += 1;
        continue;
      }

      const historicalSnapshot =
        await this.db.getLatestOddsSnapshotForMatch(matchId)
        ?? await this.db.findLatestOddsSnapshotByTeams(
          String(match.home_team_name ?? ''),
          String(match.away_team_name ?? ''),
          String(match.competition ?? ''),
          String(match.date ?? '')
        );

      if (!historicalSnapshot) {
        skippedNoSnapshot += 1;
        continue;
      }

      const replayOdds = this.normalizeReplayOdds(
        historicalSnapshot?.liveSelectedOdds ?? historicalSnapshot?.eurobetOdds ?? {}
      );
      if (Object.keys(replayOdds).length === 0) {
        skippedNoOdds += 1;
        continue;
      }

      const replayPred = await this.predict({
        homeTeamId: String(match.home_team_id),
        awayTeamId: String(match.away_team_id),
        matchId,
        competition: String(match.competition ?? ''),
        bookmakerOdds: replayOdds,
      });
      const review = this.buildCompletedMatchLearningReview(replayPred, match, replayOdds);
      await this.db.saveLearningReview(matchId, String(match.competition ?? ''), review);

      if (existing) refreshed += 1;
      else created += 1;
    }

    const adaptiveTuning = await this.applyAdaptiveTuning(options?.competition, true);
    return {
      considered,
      created,
      refreshed,
      skippedExisting,
      skippedNoSnapshot,
      skippedNoOdds,
      adaptiveTuning,
    };
  }

  async getAdaptiveTuningSummary(competition?: string): Promise<AdaptiveEngineTuningProfile> {
    return this.getAdaptiveTuningProfile(competition);
  }


  private buildAnalysisFactors(
    request: PredictionRequest,
    probs: FullMatchProbabilities,
    homeTeam: any,
    awayTeam: any,
    competitiveness: number
  ): AnalysisFactors {
    const homeAdvantageIndex = this.clamp((Number(probs.lambdaHome ?? 0) - Number(probs.lambdaAway ?? 0)) / 2, -1, 1);

    const homeStrength = Number(homeTeam?.attack_strength ?? 0) - Number(homeTeam?.defence_strength ?? 0);
    const awayStrength = Number(awayTeam?.attack_strength ?? 0) - Number(awayTeam?.defence_strength ?? 0);
    const inferredFormDelta = this.clamp((homeStrength - awayStrength) / 2, -1, 1);

    const hasExplicitForm =
      request.homeFormIndex !== undefined || request.awayFormIndex !== undefined;
    const explicitFormDelta = this.clamp(
      Number(request.homeFormIndex ?? 0.5) - Number(request.awayFormIndex ?? 0.5),
      -1,
      1
    );
    const formDelta = hasExplicitForm
      ? this.clamp((explicitFormDelta * 0.7) + (inferredFormDelta * 0.3), -1, 1)
      : inferredFormDelta;

    const motivationDelta = this.clamp(
      Number(request.homeObjectiveIndex ?? 0.5) - Number(request.awayObjectiveIndex ?? 0.5),
      -1,
      1
    );
    const restDelta = this.clamp(
      (Number(request.homeRestDays ?? 6) - Number(request.awayRestDays ?? 6)) / 10,
      -1,
      1
    );
    const scheduleLoadDelta = this.clamp(
      (Number(request.awayRecentMatchesCount ?? 0) - Number(request.homeRecentMatchesCount ?? 0)) / 4,
      -1,
      1
    );

    const homeSuspImpact = Number(request.homeSuspensions ?? 0) + Number(request.homeKeyAbsences ?? 0) * 1.25;
    const awaySuspImpact = Number(request.awaySuspensions ?? 0) + Number(request.awayKeyAbsences ?? 0) * 1.25;
    const suspensionsDelta = this.clamp((awaySuspImpact - homeSuspImpact) / 6, -1, 1);

    const homeDisciplineRisk = Number(request.homeRecentRedCards ?? 0);
    const awayDisciplineRisk = Number(request.awayRecentRedCards ?? 0);
    const disciplinaryDelta = this.clamp((awayDisciplineRisk - homeDisciplineRisk) / 4, -1, 1);

    const homeAtRisk = Number(request.homeDiffidati ?? 0);
    const awayAtRisk = Number(request.awayDiffidati ?? 0);
    const atRiskPlayersDelta = this.clamp((awayAtRisk - homeAtRisk) / 8, -1, 1);

    const notes: string[] = [];
    if (Math.abs(homeAdvantageIndex) > 0.15) notes.push(`Vantaggio casa stimato: ${homeAdvantageIndex >= 0 ? 'pro casa' : 'pro ospite'}.`);
    if (Math.abs(formDelta) > 0.15) notes.push(`Forma recente: ${formDelta >= 0 ? 'migliore casa' : 'migliore ospite'}.`);
    if (Math.abs(motivationDelta) > 0.15) notes.push(`Obiettivi squadra: ${motivationDelta >= 0 ? 'motivazione casa superiore' : 'motivazione ospite superiore'}.`);
    if (Math.abs(restDelta) > 0.1) notes.push(`Freschezza: ${restDelta >= 0 ? 'casa con piu recupero' : 'ospite con piu recupero'}.`);
    if (Math.abs(scheduleLoadDelta) > 0.1) notes.push(`Congestione calendario: ${scheduleLoadDelta >= 0 ? 'ospite piu carica' : 'casa piu carica'}.`);
    if (Math.abs(suspensionsDelta) > 0.1) notes.push(`Assenze/squalifiche: ${suspensionsDelta >= 0 ? 'piu penalizzanti per ospite' : 'piu penalizzanti per casa'}.`);
    if (Math.abs(disciplinaryDelta) > 0.1) notes.push(`Disciplina (espulsioni recenti): ${disciplinaryDelta >= 0 ? 'rischio maggiore ospite' : 'rischio maggiore casa'}.`);
    if (Math.abs(atRiskPlayersDelta) > 0.1) notes.push(`Diffidati: ${atRiskPlayersDelta >= 0 ? 'piu diffidati ospite' : 'piu diffidati casa'}.`);

    return {
      homeAdvantageIndex: Number(homeAdvantageIndex.toFixed(3)),
      formDelta: Number(formDelta.toFixed(3)),
      motivationDelta: Number(motivationDelta.toFixed(3)),
      restDelta: Number(restDelta.toFixed(3)),
      scheduleLoadDelta: Number(scheduleLoadDelta.toFixed(3)),
      suspensionsDelta: Number(suspensionsDelta.toFixed(3)),
      disciplinaryDelta: Number(disciplinaryDelta.toFixed(3)),
      atRiskPlayersDelta: Number(atRiskPlayersDelta.toFixed(3)),
      competitiveness: Number(competitiveness.toFixed(3)),
      notes,
    };
  }

  private computeBestValueOpportunity(
    opportunities: BetOpportunity[],
    factors: AnalysisFactors
  ): BestValueOpportunityExplanation | null {
    if (!Array.isArray(opportunities) || opportunities.length === 0) return null;

    const clampNum = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    const confidenceRank = (c: BetOpportunity['confidence']) => c === 'HIGH' ? 3 : c === 'MEDIUM' ? 2 : 1;
    const tierWeight = (tier?: string) => tier === 'CORE' ? 1 : tier === 'SECONDARY' ? 0.94 : 0.82;
    const rankOpportunity = (o: BetOpportunity): number => {
      const ev = Number(o.expectedValue ?? 0) / 100;
      const edge = Number(o.edge ?? 0) / 100;
      const conf = confidenceRank(o.confidence) / 3;
      const kelly = Number(o.kellyFraction ?? 0) / 100;
      return ((kelly * 0.40) + (ev * 0.30) + (edge * 0.20) + (conf * 0.10))
        * tierWeight((o as any).marketTier)
        * Number((o as any).adaptiveRankMultiplier ?? 1);
    };
    const avgEv = opportunities.reduce((s, o) => s + Number(o.expectedValue ?? 0), 0) / opportunities.length;

    const scored = opportunities.map((opp) => {
      const direction = this.inferSelectionDirection(opp.selection);
      const prob = Number(opp.ourProbability ?? 0);
      const odds = Number(opp.bookmakerOdds ?? 0);

      // Ranking normalizzato (0-1) con Kelly come peso principale.
      const baseModelScore = clampNum(rankOpportunity(opp), 0, 1);

      const directionalContext =
        direction * (
          factors.homeAdvantageIndex * 8 +
          factors.formDelta * 6 +
          factors.motivationDelta * 5 +
          factors.restDelta * 4 +
          factors.scheduleLoadDelta * 3 +
          factors.suspensionsDelta * 4 +
          factors.disciplinaryDelta * 3 +
          factors.atRiskPlayersDelta * 2
        );

      let contextualScore = directionalContext / 100;
      const sKey = String(opp.selection ?? '').toLowerCase();
      if (sKey.includes('yellow') || sKey.includes('cards') || sKey.includes('fouls')) {
        contextualScore += (factors.competitiveness * 0.05) + Math.abs(factors.disciplinaryDelta) * 0.03;
      } else if (sKey.startsWith('over') || sKey.includes('_over_')) {
        contextualScore += factors.formDelta * 0.02 + factors.motivationDelta * 0.015;
      } else if (sKey.startsWith('under') || sKey.includes('_under_')) {
        contextualScore -= factors.formDelta * 0.015;
      }

      contextualScore = clampNum(contextualScore, -0.3, 0.3);
      const totalScore = baseModelScore + contextualScore;
      return { opp, baseModelScore, contextualScore, totalScore, prob, odds };
    });

    scored.sort((a, b) => b.totalScore - a.totalScore);
    const best = scored[0];

    // Floor minimo assoluto per evitare di consigliare scommesse troppo deboli
    if (best.baseModelScore < 0.05) return null;

    const implied = Number(100 / Math.max(1.01, Number(best.opp.bookmakerOdds ?? 0)));

    const reasons: string[] = [
      `EV +${Number(best.opp.expectedValue ?? 0).toFixed(2)}% (media opzioni +${avgEv.toFixed(2)}%).`,
      `Edge +${Number(best.opp.edge ?? 0).toFixed(2)}%: P modello ${Number(best.opp.ourProbability ?? 0).toFixed(2)}% vs P implicita ${implied.toFixed(2)}%.`,
      `Stake Kelly frazionale suggerito: ${Number(best.opp.suggestedStakePercent ?? 0).toFixed(2)}% bankroll.`,
    ];

    if (best.contextualScore >= 0.05) {
      reasons.push('I fattori contestuali (campo/forma/obiettivi/assenze/disciplina) rafforzano la scelta.');
    } else if (best.contextualScore <= -0.05) {
      reasons.push('La scelta resta +EV ma con contesto meno favorevole: consigliata prudenza sulla stake.');
    } else {
      reasons.push('La scelta e guidata principalmente da EV+edge, con contesto neutro.');
    }

    const human = this.buildHumanBestPickExplanation(best.opp, factors);

    return {
      selection: best.opp.selection,
      selectionLabel: human.selectionLabel,
      marketName: best.opp.marketName,
      marketTier: String((best.opp as any).marketTier ?? 'SECONDARY'),
      bookmakerOdds: Number(best.opp.bookmakerOdds ?? 0),
      expectedValue: Number(best.opp.expectedValue ?? 0),
      edge: Number(best.opp.edge ?? 0),
      confidence: best.opp.confidence,
      score: Number(best.totalScore.toFixed(3)),
      humanSummary: human.humanSummary,
      humanReasons: human.humanReasons,
      reasons,
      factorBreakdown: {
        baseModelScore: Number(best.baseModelScore.toFixed(3)),
        contextualScore: Number(best.contextualScore.toFixed(3)),
        totalScore: Number(best.totalScore.toFixed(3)),
      },
    };
  }
  // ==================== BUDGET ====================

  async getBudget(userId: string) {
    return this.db.getBudget(userId);
  }

  async initBudget(userId: string, amount: number) {
    await this.db.deleteBetsByUser(userId);
    await this.db.createOrResetBudget(userId, amount);
    return this.db.getBudget(userId);
  }

  async getBets(userId: string, status?: string) {
    return this.db.getBets(userId, status);
  }

  private parseMarketLine(raw: string): number | null {
    const cleaned = String(raw ?? '').trim().replace(',', '.');
    if (!cleaned) return null;
    if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
    if (cleaned.includes('.')) {
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }
    if (cleaned.length >= 2 && cleaned !== '0') {
      const n = Number(`${cleaned.slice(0, -1)}.${cleaned.slice(-1)}`);
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  private decideOverUnder(actual: number, side: 'over' | 'under', line: number): 'WON' | 'LOST' | 'VOID' {
    if (actual > line) return side === 'over' ? 'WON' : 'LOST';
    if (actual < line) return side === 'under' ? 'WON' : 'LOST';
    return 'VOID';
  }

  private evaluateSelectionForMatch(
    selection: string,
    matchRow: any
  ): { status: 'WON' | 'LOST' | 'VOID'; reason: string } | null {
    const s = String(selection ?? '').trim().toLowerCase();
    const hg = Number(matchRow?.home_goals);
    const ag = Number(matchRow?.away_goals);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;

    const totalGoals = hg + ag;
    const homeWins = hg > ag;
    const awayWins = ag > hg;
    const draw = hg === ag;
    const settled = (status: 'WON' | 'LOST' | 'VOID', reason: string) => ({ status, reason });

    if (s === 'homewin') return settled(homeWins ? 'WON' : 'LOST', 'Esito 1X2');
    if (s === 'draw') return settled(draw ? 'WON' : 'LOST', 'Esito 1X2');
    if (s === 'awaywin') return settled(awayWins ? 'WON' : 'LOST', 'Esito 1X2');
    if (s === 'btts') return settled(hg > 0 && ag > 0 ? 'WON' : 'LOST', 'Entrambe segnano');
    if (s === 'bttsno') return settled(hg === 0 || ag === 0 ? 'WON' : 'LOST', 'No goal/goal');
    if (s === 'double_chance_1x') return settled(homeWins || draw ? 'WON' : 'LOST', 'Double chance 1X');
    if (s === 'double_chance_x2') return settled(awayWins || draw ? 'WON' : 'LOST', 'Double chance X2');
    if (s === 'double_chance_12') return settled(!draw ? 'WON' : 'LOST', 'Double chance 12');

    if (s === 'dnb_home') {
      if (draw) return settled('VOID', 'Draw no bet (pareggio)');
      return settled(homeWins ? 'WON' : 'LOST', 'Draw no bet casa');
    }
    if (s === 'dnb_away') {
      if (draw) return settled('VOID', 'Draw no bet (pareggio)');
      return settled(awayWins ? 'WON' : 'LOST', 'Draw no bet ospite');
    }

    const exact = s.match(/^exact_(\d+)-(\d+)$/);
    if (exact) {
      const exHg = Number(exact[1]);
      const exAg = Number(exact[2]);
      return settled(hg === exHg && ag === exAg ? 'WON' : 'LOST', 'Risultato esatto');
    }

    const goalOu = s.match(/^(over|under)(\d+)$/);
    if (goalOu) {
      const line = this.parseMarketLine(goalOu[2]);
      if (line === null) return null;
      if (line > 7.5) return null;
      return settled(this.decideOverUnder(totalGoals, goalOu[1] as 'over' | 'under', line), 'Over/Under goal');
    }

    const teamTotals = s.match(/^team_(home|away)_(over|under)_([0-9]+(?:\.[0-9]+)?)$/);
    if (teamTotals) {
      const side = teamTotals[1];
      const actual = side === 'home' ? hg : ag;
      const line = this.parseMarketLine(teamTotals[3]);
      if (line === null) return null;
      return settled(this.decideOverUnder(actual, teamTotals[2] as 'over' | 'under', line), `Team total ${side}`);
    }

    const ahAway = s.match(/^ahcp_away_(-?[0-9]+(?:\.[0-9]+)?)$/);
    if (ahAway) {
      const line = Number(ahAway[1]);
      if (!Number.isFinite(line)) return null;
      const adjustedAway = ag + line;
      if (adjustedAway > hg) return settled('WON', 'Asian handicap ospite');
      if (adjustedAway < hg) return settled('LOST', 'Asian handicap ospite');
      return settled('VOID', 'Asian handicap ospite (push)');
    }
    const ahHome = s.match(/^ahcp_(-?[0-9]+(?:\.[0-9]+)?)$/);
    if (ahHome) {
      const line = Number(ahHome[1]);
      if (!Number.isFinite(line)) return null;
      const adjustedHome = hg + line;
      if (adjustedHome > ag) return settled('WON', 'Asian handicap casa');
      if (adjustedHome < ag) return settled('LOST', 'Asian handicap casa');
      return settled('VOID', 'Asian handicap casa (push)');
    }

    const numOrNull = (v: any): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const homeShots = numOrNull(matchRow?.home_shots);
    const awayShots = numOrNull(matchRow?.away_shots);
    const homeSot = numOrNull(matchRow?.home_shots_on_target);
    const awaySot = numOrNull(matchRow?.away_shots_on_target);
    const homeFouls = numOrNull(matchRow?.home_fouls);
    const awayFouls = numOrNull(matchRow?.away_fouls);
    const homeCorners = numOrNull(matchRow?.home_corners);
    const awayCorners = numOrNull(matchRow?.away_corners);
    const homeYellow = numOrNull(matchRow?.home_yellow_cards);
    const awayYellow = numOrNull(matchRow?.away_yellow_cards);
    const homeRed = numOrNull(matchRow?.home_red_cards);
    const awayRed = numOrNull(matchRow?.away_red_cards);

    const prefixedStats = s.match(/^(shots_total|shots_home|shots_away|sot_total|corners|fouls|yellow|cards_total)_(over|under)_([0-9]+(?:\.[0-9]+)?)$/);
    if (prefixedStats) {
      const domain = prefixedStats[1];
      const side = prefixedStats[2] as 'over' | 'under';
      const line = this.parseMarketLine(prefixedStats[3]);
      if (line === null) return null;

      let actual: number | null = null;
      if (domain === 'shots_total') {
        actual = homeShots !== null && awayShots !== null ? homeShots + awayShots : null;
      } else if (domain === 'shots_home') {
        actual = homeShots;
      } else if (domain === 'shots_away') {
        actual = awayShots;
      } else if (domain === 'sot_total') {
        actual = homeSot !== null && awaySot !== null ? homeSot + awaySot : null;
      } else if (domain === 'corners') {
        actual = homeCorners !== null && awayCorners !== null ? homeCorners + awayCorners : null;
      } else if (domain === 'fouls') {
        actual = homeFouls !== null && awayFouls !== null ? homeFouls + awayFouls : null;
      } else if (domain === 'yellow') {
        actual = homeYellow !== null && awayYellow !== null ? homeYellow + awayYellow : null;
      } else if (domain === 'cards_total') {
        if (homeYellow === null || awayYellow === null) return null;
        actual = homeYellow + awayYellow + 2 * ((homeRed ?? 0) + (awayRed ?? 0));
      }

      if (actual === null) return null;
      return settled(this.decideOverUnder(actual, side, line), `${domain} over/under`);
    }

    const legacyStats = s.match(/^(shots|sot|corners|fouls|cards)_(over|under)(\d+)$/);
    if (legacyStats) {
      const domain = legacyStats[1];
      const side = legacyStats[2] as 'over' | 'under';
      const line = this.parseMarketLine(legacyStats[3]);
      if (line === null) return null;

      let actual: number | null = null;
      if (domain === 'shots') {
        actual = homeShots !== null && awayShots !== null ? homeShots + awayShots : null;
      } else if (domain === 'sot') {
        actual = homeSot !== null && awaySot !== null ? homeSot + awaySot : null;
      } else if (domain === 'corners') {
        actual = homeCorners !== null && awayCorners !== null ? homeCorners + awayCorners : null;
      } else if (domain === 'fouls') {
        actual = homeFouls !== null && awayFouls !== null ? homeFouls + awayFouls : null;
      } else if (domain === 'cards') {
        actual = homeYellow !== null && awayYellow !== null ? homeYellow + awayYellow : null;
      }

      if (actual === null) return null;
      return settled(this.decideOverUnder(actual, side, line), `${domain} legacy over/under`);
    }

    const compactStats = s.match(/^(shots|shotshome|shotsaway|shotsot|corners|yellow|cardstotal|fouls)(over|under)(\d+)$/);
    if (compactStats) {
      const domain = compactStats[1];
      const side = compactStats[2] as 'over' | 'under';
      const line = this.parseMarketLine(compactStats[3]);
      if (line === null) return null;

      let actual: number | null = null;
      if (domain === 'shots') {
        actual = homeShots !== null && awayShots !== null ? homeShots + awayShots : null;
      } else if (domain === 'shotshome') {
        actual = homeShots;
      } else if (domain === 'shotsaway') {
        actual = awayShots;
      } else if (domain === 'shotsot') {
        actual = homeSot !== null && awaySot !== null ? homeSot + awaySot : null;
      } else if (domain === 'corners') {
        actual = homeCorners !== null && awayCorners !== null ? homeCorners + awayCorners : null;
      } else if (domain === 'yellow') {
        actual = homeYellow !== null && awayYellow !== null ? homeYellow + awayYellow : null;
      } else if (domain === 'cardstotal') {
        if (homeYellow === null || awayYellow === null) return null;
        actual = homeYellow + awayYellow + 2 * ((homeRed ?? 0) + (awayRed ?? 0));
      } else if (domain === 'fouls') {
        actual = homeFouls !== null && awayFouls !== null ? homeFouls + awayFouls : null;
      }

      if (actual === null) return null;
      return settled(this.decideOverUnder(actual, side, line), `${domain} compact over/under`);
    }

    return null;
  }

  evaluateSelectionAgainstMatch(
    selection: string,
    matchRow: any
  ): { status: 'WON' | 'LOST' | 'VOID'; reason: string } | null {
    return this.evaluateSelectionForMatch(selection, matchRow);
  }

  private async resolvePlayedMatchForBet(bet: any): Promise<any | null> {
    const byId = await this.db.getMatchById(String(bet?.match_id ?? ''));
    if (byId && byId.home_goals !== null && byId.away_goals !== null) return byId;

    const rawMatchDate = String(bet?.match_date ?? '').trim();
    if (rawMatchDate) {
      const scheduledAt = new Date(rawMatchDate);
      if (!Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() > Date.now()) {
        return null;
      }
    }

    const homeTeamName = String(bet?.home_team_name ?? '').trim();
    const awayTeamName = String(bet?.away_team_name ?? '').trim();
    if (!homeTeamName || !awayTeamName) return null;

    return this.db.findPlayedMatchByTeams(
      homeTeamName,
      awayTeamName,
      bet?.competition ? String(bet.competition) : undefined,
      bet?.match_date ? String(bet.match_date) : undefined
    );
  }

  private async recomputeBudgetFromBets(userId: string): Promise<any | null> {
    const budget = await this.db.getBudget(userId);
    if (!budget) return null;

    const allBets = await this.db.getBets(userId);
    const totalBets = allBets.length;
    const totalStaked = allBets.reduce((s: number, b: any) => s + Number(b.stake ?? 0), 0);
    const totalWon = allBets
      .filter((b: any) => b.status === 'WON')
      .reduce((s: number, b: any) => s + Number(b.return_amount ?? 0), 0);
    const totalLost = allBets
      .filter((b: any) => b.status === 'LOST')
      .reduce((s: number, b: any) => s + Number(b.stake ?? 0), 0);

    const totalReturned = allBets
      .filter((b: any) => b.status === 'WON' || b.status === 'VOID')
      .reduce((s: number, b: any) => s + Number(b.return_amount ?? 0), 0);

    const settled = allBets.filter((b: any) => b.status === 'WON' || b.status === 'LOST');
    const wonCount = settled.filter((b: any) => b.status === 'WON').length;
    const winRate = settled.length > 0 ? (wonCount / settled.length) * 100 : 0;

    const settledForRoi = allBets.filter((b: any) => b.status === 'WON' || b.status === 'LOST' || b.status === 'VOID');
    const totalProfit = settledForRoi.reduce((s: number, b: any) => s + Number(b.profit ?? 0), 0);
    const settledStaked = settledForRoi.reduce((s: number, b: any) => s + Number(b.stake ?? 0), 0);
    const roi = settledStaked > 0 ? (totalProfit / settledStaked) * 100 : 0;

    const availableBudget = Number(budget.total_budget ?? 0) - totalStaked + totalReturned;

    await this.db.updateBudget({
      userId,
      totalBudget: Number(budget.total_budget ?? 0),
      availableBudget: Number(availableBudget.toFixed(2)),
      totalBets,
      totalStaked: Number(totalStaked.toFixed(2)),
      totalWon: Number(totalWon.toFixed(2)),
      totalLost: Number(totalLost.toFixed(2)),
      roi: Number(roi.toFixed(2)),
      winRate: Number(winRate.toFixed(2)),
    });

    return this.db.getBudget(userId);
  }

  private async settleBetInternal(
    betId: string,
    status: 'WON' | 'LOST' | 'VOID',
    returnAmount?: number,
    notes?: string,
    recomputeBudget = true
  ) {
    const betRow = await this.db.getBet(betId);
    if (!betRow) throw new Error('Scommessa non trovata');
    if (betRow.status !== 'PENDING') {
      return { bet: betRow, budget: await this.db.getBudget(betRow.user_id) };
    }

    const baseReturn =
      status === 'WON'
        ? (returnAmount ?? Number(betRow.stake) * Number(betRow.odds))
        : status === 'VOID'
          ? (returnAmount ?? Number(betRow.stake))
          : 0;
    const actualReturn = Number.isFinite(baseReturn) ? baseReturn : 0;
    const profit = actualReturn - Number(betRow.stake ?? 0);

    await this.db.saveBet({
      ...betRow,
      betId: betRow.bet_id,
      userId: betRow.user_id,
      matchId: betRow.match_id,
      homeTeamName: betRow.home_team_name ?? null,
      awayTeamName: betRow.away_team_name ?? null,
      competition: betRow.competition ?? null,
      matchDate: betRow.match_date ?? null,
      marketName: betRow.market_name,
      selection: betRow.selection,
      ourProbability: betRow.our_probability,
      expectedValue: betRow.expected_value,
      placedAt: betRow.placed_at,
      status,
      returnAmount: Number(actualReturn.toFixed(2)),
      profit: Number(profit.toFixed(2)),
      settledAt: new Date(),
      notes: notes ?? betRow.notes ?? null,
    });

    const updatedBudget = recomputeBudget ? await this.recomputeBudgetFromBets(String(betRow.user_id)) : null;
    return { bet: await this.db.getBet(betId), budget: updatedBudget };
  }

  async syncPendingBets(userId: string) {
    const pendingBets = await this.db.getBets(userId, 'PENDING');
    let settled = 0;
    let unresolved = 0;

    for (const bet of pendingBets) {
      const matchRow = await this.resolvePlayedMatchForBet(bet);
      if (!matchRow) {
        unresolved++;
        continue;
      }

      const decision = this.evaluateSelectionForMatch(String(bet.selection ?? ''), matchRow);
      if (!decision) {
        unresolved++;
        continue;
      }

      const returnAmount =
        decision.status === 'WON'
          ? Number(bet.stake ?? 0) * Number(bet.odds ?? 0)
          : decision.status === 'VOID'
            ? Number(bet.stake ?? 0)
            : 0;

      await this.settleBetInternal(
        String(bet.bet_id),
        decision.status,
        returnAmount,
        `Auto-settle (${decision.reason})`,
        false
      );
      settled++;
    }

    const budget = settled > 0 ? await this.recomputeBudgetFromBets(userId) : await this.db.getBudget(userId);
    return { settled, unresolved, budget };
  }

  async placeBet(
    userId: string,
    matchId: string,
    marketName: string,
    selection: string,
    odds: number,
    stake: number,
    ourProbability: number,
    expectedValue: number,
    meta?: { homeTeamName?: string; awayTeamName?: string; competition?: string; matchDate?: string | Date }
  ) {
    const normalizedStake = Number(stake);
    if (!Number.isFinite(normalizedStake) || normalizedStake <= 0) throw new Error('Importo puntata non valido');
    if (normalizedStake < 1) throw new Error('Puntata minima Eurobet: 1 EUR');
    if (!Number.isFinite(Number(odds)) || Number(odds) <= 1) throw new Error('Quota non valida');

    await this.syncPendingBets(userId);
    const budget = await this.db.getBudget(userId);
    if (!budget) throw new Error('Budget non trovato');
    if (normalizedStake > Number(budget.available_budget ?? 0)) {
      throw new Error(`Budget insufficiente: EUR ${Number(budget.available_budget ?? 0).toFixed(2)} disponibili`);
    }

    const allBets = await this.db.getBets(userId);
    const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
    const duplicate = allBets.find(
      (b: any) =>
        norm(b.match_id) === norm(matchId) &&
        norm(b.selection) === norm(selection) &&
        norm(b.market_name) === norm(marketName)
    );
    if (duplicate) {
      throw new Error('Scommessa gia fatta');
    }

    const bet = {
      betId: uuidv4(),
      userId,
      matchId,
      homeTeamName: meta?.homeTeamName ?? null,
      awayTeamName: meta?.awayTeamName ?? null,
      competition: meta?.competition ?? null,
      matchDate: meta?.matchDate ?? null,
      marketName,
      selection,
      odds: Number(odds),
      stake: Number(normalizedStake.toFixed(2)),
      ourProbability: Number(ourProbability),
      expectedValue: Number(expectedValue),
      status: 'PENDING',
      placedAt: new Date(),
    };

    await this.db.saveBet(bet);
    const newBudget = await this.recomputeBudgetFromBets(userId);
    return { bet, budget: newBudget };
  }

  async settleBet(betId: string, won: boolean, returnAmount?: number) {
    const status: 'WON' | 'LOST' = won ? 'WON' : 'LOST';
    return this.settleBetInternal(betId, status, returnAmount, 'Settle manuale', true);
  }

  private async loadBacktestMatches(competition: string, season?: string): Promise<MatchData[]> {
    const rawMatches = await this.db.getMatches({ competition, season });
    const matches: MatchData[] = rawMatches
      .filter((m: any) => m.home_goals !== null && m.away_goals !== null)
      .map((m: any) => ({
        matchId: m.match_id, homeTeamId: m.home_team_id, awayTeamId: m.away_team_id,
        date: new Date(m.date), homeGoals: m.home_goals, awayGoals: m.away_goals,
        homeXG: m.home_xg, awayXG: m.away_xg,
      }));

    if (matches.length < 50) throw new Error(`Servono almeno 50 partite. Disponibili: ${matches.length}`);
    return matches;
  }

  async runBacktest(
    competition: string,
    season?: string,
    historicalOdds?: Record<string, Record<string, number>>,
    options?: {
      trainRatio?: number;
      confidenceLevel?: 'high_only' | 'medium_and_above';
    }
  ) {
    const matches = await this.loadBacktestMatches(competition, season);
    const adaptiveTuning = await this.applyAdaptiveTuning(competition);
    const oddsMap =
      historicalOdds && Object.keys(historicalOdds).length > 0
        ? historicalOdds
        : await this.db.getHistoricalOddsMap({ competition, season });
    const trainRatio = Number.isFinite(Number(options?.trainRatio))
      ? Math.max(0.5, Math.min(Number(options?.trainRatio), 0.9))
      : 0.7;
    const confidenceLevel = options?.confidenceLevel ?? 'medium_and_above';

    const result = this.backtester.runBacktest(matches, oddsMap, trainRatio, confidenceLevel);
    const payload = {
      kind: 'classic',
      competition,
      season: season ?? 'all',
      trainRatio,
      confidenceLevel,
      adaptiveTuning,
      historicalOddsCoverage: Object.keys(oddsMap).length,
      ...result,
    };
    await this.db.saveBacktestResult(competition, season ?? 'all', payload);
    return payload;
  }

  async runWalkForwardBacktest(
    competition: string,
    season?: string,
    historicalOdds?: Record<string, Record<string, number>>,
    options?: {
      initialTrainMatches?: number;
      testWindowMatches?: number;
      stepMatches?: number;
      confidenceLevel?: 'high_only' | 'medium_and_above';
      expandingWindow?: boolean;
      maxFolds?: number;
    }
  ): Promise<WalkForwardBacktestResult> {
    const matches = await this.loadBacktestMatches(competition, season);
    const adaptiveTuning = await this.applyAdaptiveTuning(competition);
    const oddsMap =
      historicalOdds && Object.keys(historicalOdds).length > 0
        ? historicalOdds
        : await this.db.getHistoricalOddsMap({ competition, season });

    const result = this.backtester.runWalkForwardBacktest(matches, oddsMap, options);
    const payload = {
      kind: 'walk_forward',
      competition,
      season: season ?? 'all',
      confidenceLevel: options?.confidenceLevel ?? 'medium_and_above',
      expandingWindow: options?.expandingWindow !== false,
      adaptiveTuning,
      historicalOddsCoverage: Object.keys(oddsMap).length,
      ...result,
    };
    await this.db.saveBacktestResult(competition, season ?? 'all', payload);
    return payload;
  }
}

