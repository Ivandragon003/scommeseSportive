// Player derived-stats rebuild, extracted verbatim from api/routes.ts.
// The DB is injected (dependency inversion). Shared coercion helpers come from
// src/utils/dataHelpers. No behavior change.

import { numOrNull, parseRawJson, normalizeShotResult, safePct } from '../utils/dataHelpers';

export interface PlayerDerivedStatsDb {
  getMatches(filters: {
    competition?: string;
    season?: string;
    fromDate?: string;
    toDate?: string;
    includeRawJson?: boolean;
  }): Promise<any[]>;
  markPlayersUnavailable(competition?: string): Promise<number>;
  upsertPlayer(payload: any): Promise<unknown>;
}

export interface RebuildPlayerDerivedStatsOptions {
  competition?: string;
  season?: string;
  fromDate?: string;
  toDate?: string;
}

export interface PlayerDerivedStatsResult {
  playersMarkedUnavailable: number;
  playersDetected: number;
  playersUpdated: number;
  playedMatchesConsidered: number;
  matchesWithShotmap: number;
}

export async function rebuildPlayerDerivedStats(
  db: PlayerDerivedStatsDb,
  options?: RebuildPlayerDerivedStatsOptions
): Promise<PlayerDerivedStatsResult> {
  const normalizedCompetition = String(options?.competition ?? '').trim();
  const matches = await db.getMatches({
    competition: normalizedCompetition || undefined,
    season: String(options?.season ?? '').trim() || undefined,
    fromDate: String(options?.fromDate ?? '').trim() || undefined,
    toDate: String(options?.toDate ?? '').trim() || undefined,
    includeRawJson: true,
  });

  type PlayerAgg = {
    playerId: string;
    sourcePlayerId: number | null;
    name: string;
    teamId: string;
    positionCode: string;
    games: Set<string>;
    minutesTotal: number;
    shots: number;
    shotsOnTarget: number;
    goals: number;
    xg: number;
    xgot: number;
    yellowCards: number;
    redCards: number;
    rawSamples: Record<string, unknown>[];
  };

  const teamShotsTotals = new Map<string, number>();
  const playersAgg = new Map<string, PlayerAgg>();
  const playedMatches = matches.filter((m: any) => m.home_goals !== null && m.away_goals !== null);
  const playersMarkedUnavailable = await db.markPlayersUnavailable(normalizedCompetition || undefined);
  let matchesWithShotmap = 0;

  const buildOnTargetMap = (shots: any[]): Map<string, { count: number; xgot: number; samples: Record<string, unknown>[] }> => {
    const out = new Map<string, { count: number; xgot: number; samples: Record<string, unknown>[] }>();
    for (const shot of shots) {
      const playerId = String(shot?.player_id ?? shot?.playerId ?? '').trim();
      if (!playerId) continue;
      const result = normalizeShotResult(shot?.result ?? shot?.eventType);
      const isOnTarget = result === 'goal' || result === 'savedshot' || result.includes('ontarget');
      if (!isOnTarget) continue;
      const current = out.get(playerId) ?? { count: 0, xgot: 0, samples: [] };
      current.count += 1;
      current.xgot += Number(numOrNull(shot?.xG ?? shot?.expectedGoals) ?? 0);
      if (current.samples.length < 5) {
        current.samples.push({
          result: shot?.result ?? shot?.eventType ?? null,
          situation: shot?.situation ?? null,
          shotType: shot?.shotType ?? shot?.bodyPart ?? null,
        });
      }
      out.set(playerId, current);
    }
    return out;
  };

  const ingestRoster = (
    rosterEntries: Record<string, any>,
    shots: any[],
    teamId: string,
    matchId: string
  ) => {
    const onTargetByPlayer = buildOnTargetMap(shots);
    for (const entry of Object.values(rosterEntries ?? {})) {
      const playerName = String((entry as any)?.player ?? (entry as any)?.playerName ?? '').trim();
      if (!playerName) continue;
      const sourcePlayerId = numOrNull((entry as any)?.player_id ?? (entry as any)?.id);
      const playerId = sourcePlayerId !== null
        ? `understat_player_${Math.trunc(sourcePlayerId)}`
        : `understat_player_${playerName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`;
      const onTarget = onTargetByPlayer.get(String((entry as any)?.player_id ?? '')) ?? { count: 0, xgot: 0, samples: [] };
      const current = playersAgg.get(playerId) ?? {
        playerId,
        sourcePlayerId: sourcePlayerId === null ? null : Math.trunc(sourcePlayerId),
        name: playerName,
        teamId,
        positionCode: String((entry as any)?.position ?? 'MF').trim().split(/\s+/)[0] || 'MF',
        games: new Set<string>(),
        minutesTotal: 0,
        shots: 0,
        shotsOnTarget: 0,
        goals: 0,
        xg: 0,
        xgot: 0,
        yellowCards: 0,
        redCards: 0,
        rawSamples: [],
      };
      current.teamId = teamId;
      current.games.add(matchId);
      current.minutesTotal += Number(numOrNull((entry as any)?.time) ?? 0);
      current.shots += Number(numOrNull((entry as any)?.shots) ?? 0);
      current.shotsOnTarget += Number(onTarget.count ?? 0);
      current.goals += Number(numOrNull((entry as any)?.goals) ?? 0);
      current.xg += Number(numOrNull((entry as any)?.xG) ?? 0);
      current.xgot += Number(onTarget.xgot ?? 0);
      current.yellowCards += Number(numOrNull((entry as any)?.yellow_card) ?? 0);
      current.redCards += Number(numOrNull((entry as any)?.red_card) ?? 0);
      if (current.rawSamples.length < 8) {
        current.rawSamples.push({
          minutes: numOrNull((entry as any)?.time),
          position: (entry as any)?.position ?? null,
          yellowCard: numOrNull((entry as any)?.yellow_card),
          redCard: numOrNull((entry as any)?.red_card),
          onTargetSamples: onTarget.samples,
        });
      }
      playersAgg.set(playerId, current);
    }
  };

  for (const match of playedMatches) {
    const homeTeamId = String(match.home_team_id ?? '').trim();
    const awayTeamId = String(match.away_team_id ?? '').trim();
    if (!homeTeamId || !awayTeamId) continue;

    const homeShots = numOrNull(match.home_shots);
    const awayShots = numOrNull(match.away_shots);
    if (homeShots !== null) teamShotsTotals.set(homeTeamId, (teamShotsTotals.get(homeTeamId) ?? 0) + homeShots);
    if (awayShots !== null) teamShotsTotals.set(awayTeamId, (teamShotsTotals.get(awayTeamId) ?? 0) + awayShots);

    const raw = parseRawJson(match.raw_json);
    const homeRosters = raw?.details?.rosters?.h ?? {};
    const awayRosters = raw?.details?.rosters?.a ?? {};
    const homeShotsDetail = Array.isArray(raw?.details?.shots?.h) ? raw.details.shots.h : [];
    const awayShotsDetail = Array.isArray(raw?.details?.shots?.a) ? raw.details.shots.a : [];
    if (homeShotsDetail.length > 0 || awayShotsDetail.length > 0) matchesWithShotmap++;

    ingestRoster(homeRosters, homeShotsDetail, homeTeamId, String(match.match_id));
    ingestRoster(awayRosters, awayShotsDetail, awayTeamId, String(match.match_id));
  }

  let playersUpdated = 0;
  for (const [, player] of playersAgg) {
    const games = Math.max(1, player.games.size);
    const minutesBase = player.minutesTotal > 0 ? player.minutesTotal : games * 90;
    const teamShotsTotal = Math.max(1, Number(teamShotsTotals.get(player.teamId) ?? 0));

    await db.upsertPlayer({
      playerId: player.playerId,
      sourcePlayerId: player.sourcePlayerId,
      name: player.name,
      teamId: player.teamId,
      positionCode: player.positionCode,
      avgShotsPerGame: player.shots / games,
      avgShotsOnTargetPerGame: player.shotsOnTarget / games,
      avgXGPerGame: player.xg / games,
      avgXGOTPerGame: player.xgot / games,
      totalGoals: player.goals,
      totalShots: player.shots,
      totalShotsOnTarget: player.shotsOnTarget,
      minutesTotal: player.minutesTotal,
      avgMinutes: player.minutesTotal > 0 ? player.minutesTotal / games : 0,
      shotsPer90: minutesBase > 0 ? (player.shots / minutesBase) * 90 : 0,
      shotsOnTargetPer90: minutesBase > 0 ? (player.shotsOnTarget / minutesBase) * 90 : 0,
      xgPer90: minutesBase > 0 ? (player.xg / minutesBase) * 90 : 0,
      shotOnTargetPct: safePct(player.shotsOnTarget, player.shots),
      goalConversion: safePct(player.goals, player.shots),
      yellowCardsTotal: player.yellowCards,
      redCardsTotal: player.redCards,
      cardsPer90: minutesBase > 0 ? ((player.yellowCards + player.redCards) / minutesBase) * 90 : 0,
      shotShareOfTeam: player.shots / teamShotsTotal,
      gamesPlayed: games,
      isAvailable: true,
      statsJson: JSON.stringify({
        source: 'recompute_from_matches_raw',
        filters: {
          competition: normalizedCompetition || null,
          season: String(options?.season ?? '').trim() || null,
          fromDate: String(options?.fromDate ?? '').trim() || null,
          toDate: String(options?.toDate ?? '').trim() || null,
        },
        playedMatchesConsidered: playedMatches.length,
        matchesWithShotmap,
        totalXG: player.xg,
        totalXGOT: player.xgot,
        minutesTotal: player.minutesTotal,
        yellowCardsTotal: player.yellowCards,
        redCardsTotal: player.redCards,
        rawSamples: player.rawSamples.slice(0, 8),
      }),
    });
    playersUpdated++;
  }

  return {
    playersMarkedUnavailable,
    playersDetected: playersAgg.size,
    playersUpdated,
    playedMatchesConsidered: playedMatches.length,
    matchesWithShotmap,
  };
}
