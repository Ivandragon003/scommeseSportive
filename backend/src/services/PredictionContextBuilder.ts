import { SupplementaryData } from '../models/DixonColesModel';
import { PlayerShotsData } from '../models/SpecializedModels';

export interface ContextualPredictionInput {
  competitiveness?: number;
  isDerby?: boolean;
  isHighStakes?: boolean;
  homeFormIndex?: number;
  awayFormIndex?: number;
  homeObjectiveIndex?: number;
  awayObjectiveIndex?: number;
  homeSuspensions?: number;
  awaySuspensions?: number;
  homeRecentRedCards?: number;
  awayRecentRedCards?: number;
  homeDiffidati?: number;
  awayDiffidati?: number;
  homeKeyAbsences?: number;
  awayKeyAbsences?: number;
}

type VenueKey = 'home' | 'away';

type TeamVenueStats = {
  sampleSize?: number;
  avgPossession?: number;
  varShots?: number;
  varShotsOT?: number;
  varYellowCards?: number;
  varFouls?: number;
};

export interface PredictionContextBuildParams {
  request: ContextualPredictionInput;
  homeTeam: any;
  awayTeam: any;
  referee: any;
  homePlayers: any[];
  awayPlayers: any[];
}

export interface PredictionContextBuildResult {
  supplementaryData: SupplementaryData;
  competitiveness: number;
  homeXG?: number;
  awayXG?: number;
  richnessScore: number;
}

export class PredictionContextBuilder {
  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  private toFiniteNumber(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private parseJson(value: unknown): Record<string, any> | null {
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
    } catch {
      return null;
    }
  }

  private toPlayerData(player: any): PlayerShotsData {
    return {
      playerId: String(player?.player_id ?? player?.playerId ?? ''),
      playerName: String(player?.name ?? player?.playerName ?? 'Unknown'),
      teamId: String(player?.team_id ?? player?.teamId ?? ''),
      avgShotsPerGame: Number(player?.avg_shots_per_game ?? player?.avgShotsPerGame ?? 0),
      avgShotsOnTargetPerGame: Number(player?.avg_shots_on_target_per_game ?? player?.avgShotsOnTargetPerGame ?? 0),
      gamesPlayed: Math.max(0, Number(player?.games_played ?? player?.gamesPlayed ?? 0)),
      shotShareOfTeam: Math.max(0, Number(player?.shot_share_of_team ?? player?.shotShareOfTeam ?? 0)),
      isStarter: player?.isStarter !== false,
      positionCode: String(player?.position_code ?? player?.positionCode ?? 'MF'),
    };
  }

  private readVenueStats(teamRow: any, venue: VenueKey): TeamVenueStats {
    const json = this.parseJson(teamRow?.team_stats_json);
    const venueNode = json?.computed?.[venue] ?? json?.[venue] ?? {};

    return {
      sampleSize: this.toFiniteNumber(venueNode?.sampleSize ?? venueNode?.games ?? venueNode?.matches),
      avgPossession: this.toFiniteNumber(venueNode?.avgPossession ?? venueNode?.possession),
      varShots: this.toFiniteNumber(venueNode?.varShots),
      varShotsOT: this.toFiniteNumber(venueNode?.varShotsOT ?? venueNode?.varShotsOnTarget),
      varYellowCards: this.toFiniteNumber(venueNode?.varYellowCards ?? venueNode?.varYellow),
      varFouls: this.toFiniteNumber(venueNode?.varFouls),
    };
  }

  private buildTeamStats(teamRow: any, venue: VenueKey) {
    const venueStats = this.readVenueStats(teamRow, venue);

    return {
      avgShots: Number(
        venue === 'home'
          ? teamRow?.avg_home_shots ?? 12.1
          : teamRow?.avg_away_shots ?? 10.4
      ),
      avgShotsOT: Number(
        venue === 'home'
          ? teamRow?.avg_home_shots_ot ?? 4.8
          : teamRow?.avg_away_shots_ot ?? 3.9
      ),
      avgYellowCards: Number(teamRow?.avg_yellow_cards ?? 1.9),
      avgRedCards: Number(teamRow?.avg_red_cards ?? 0.11),
      avgFouls: Number(teamRow?.avg_fouls ?? 11.2),
      shotsSuppression: Number(teamRow?.shots_suppression ?? 1.0),
      avgHomeCorners: this.toFiniteNumber(teamRow?.avg_home_corners ?? 5.5),
      avgAwayCorners: this.toFiniteNumber(teamRow?.avg_away_corners ?? 4.5),
      avgPossession: venueStats.avgPossession,
      varShots: venueStats.varShots,
      varShotsOT: venueStats.varShotsOT,
      varYellowCards: venueStats.varYellowCards,
      varFouls: venueStats.varFouls,
      sampleSize: venueStats.sampleSize,
    };
  }

  private buildContextAdjustments(
    request: ContextualPredictionInput,
    competitiveness: number
  ): NonNullable<SupplementaryData['contextAdjustments']> {
    const formDelta = this.clamp(
      Number(request.homeFormIndex ?? 0.5) - Number(request.awayFormIndex ?? 0.5),
      -1,
      1,
    );
    const motivationDelta = this.clamp(
      Number(request.homeObjectiveIndex ?? 0.5) - Number(request.awayObjectiveIndex ?? 0.5),
      -1,
      1,
    );

    const homeAbsenceLoad =
      Number(request.homeSuspensions ?? 0) + Number(request.homeKeyAbsences ?? 0) * 1.35;
    const awayAbsenceLoad =
      Number(request.awaySuspensions ?? 0) + Number(request.awayKeyAbsences ?? 0) * 1.35;
    const absencesDelta = this.clamp((awayAbsenceLoad - homeAbsenceLoad) / 6, -1, 1);

    const disciplineDelta = this.clamp(
      Number(request.awayRecentRedCards ?? 0) - Number(request.homeRecentRedCards ?? 0),
      -1,
      1,
    );
    const atRiskTotal = this.clamp(
      (Number(request.homeDiffidati ?? 0) + Number(request.awayDiffidati ?? 0)) / 10,
      0,
      1,
    );

    const goalBias =
      formDelta * 0.12 +
      motivationDelta * 0.06 +
      absencesDelta * 0.05 +
      disciplineDelta * 0.03;
    const shotBias =
      formDelta * 0.09 +
      motivationDelta * 0.04 +
      absencesDelta * 0.04;

    return {
      homeGoalMultiplier: this.clamp(1 + goalBias, 0.72, 1.35),
      awayGoalMultiplier: this.clamp(1 - goalBias, 0.72, 1.35),
      homeShotMultiplier: this.clamp(1 + shotBias, 0.75, 1.30),
      awayShotMultiplier: this.clamp(1 - shotBias, 0.75, 1.30),
      yellowCardMultiplier: this.clamp(
        1 + competitiveness * 0.08 + atRiskTotal * 0.04 + Math.abs(disciplineDelta) * 0.05,
        0.9,
        1.35,
      ),
      foulMultiplier: this.clamp(
        1 + competitiveness * 0.05 + atRiskTotal * 0.03 + Math.abs(disciplineDelta) * 0.04,
        0.92,
        1.25,
      ),
      homePossessionShift: this.clamp(
        formDelta * 0.03 + motivationDelta * 0.015 + absencesDelta * 0.02,
        -0.08,
        0.08,
      ),
    };
  }

  build(params: PredictionContextBuildParams): PredictionContextBuildResult {
    const { request, homeTeam, awayTeam, referee, homePlayers, awayPlayers } = params;
    const competitiveness =
      request.competitiveness !== undefined
        ? this.clamp(Number(request.competitiveness), 0, 1)
        : this.clamp(
            0.30 +
            (request.isDerby ? 0.35 : 0) +
            (request.isHighStakes ? 0.20 : 0),
            0,
            1,
          );

    const homeTeamStats = homeTeam ? this.buildTeamStats(homeTeam, 'home') : undefined;
    const awayTeamStats = awayTeam ? this.buildTeamStats(awayTeam, 'away') : undefined;
    const contextAdjustments = this.buildContextAdjustments(request, competitiveness);

    const refereeStats = referee
      ? {
          avgYellow: Number(referee?.avg_yellow_cards_per_game ?? 3.8),
          avgRed: Number(referee?.avg_red_cards_per_game ?? 0.22),
          avgFouls: Number(referee?.avg_fouls_per_game ?? 22.4),
          sampleSize: this.toFiniteNumber(referee?.total_games),
        }
      : undefined;

    const sampleBase = Math.min(
      Number(homeTeamStats?.sampleSize ?? 0),
      Number(awayTeamStats?.sampleSize ?? 0),
    );
    const hasBothXg =
      Number.isFinite(Number(homeTeam?.avg_home_xg)) &&
      Number.isFinite(Number(awayTeam?.avg_away_xg));
    const playerCoverage =
      Math.min(homePlayers.length, awayPlayers.length) > 0 ? 1 : 0;
    const refereeCoverage = refereeStats?.sampleSize ? 1 : 0;

    const richnessScore = this.clamp(
      0.45 +
      Math.min(1, sampleBase / 24) * 0.25 +
      (hasBothXg ? 0.10 : 0) +
      playerCoverage * 0.08 +
      refereeCoverage * 0.05,
      0.45,
      0.93,
    );

    return {
      supplementaryData: {
        homeTeamStats,
        awayTeamStats,
        refereeStats,
        homePlayers: homePlayers.map((player) => this.toPlayerData(player)),
        awayPlayers: awayPlayers.map((player) => this.toPlayerData(player)),
        competitiveness,
        isDerby: Boolean(request.isDerby),
        contextAdjustments,
      },
      competitiveness,
      homeXG: this.toFiniteNumber(homeTeam?.avg_home_xg),
      awayXG: this.toFiniteNumber(awayTeam?.avg_away_xg),
      richnessScore: Number(richnessScore.toFixed(3)),
    };
  }
}
