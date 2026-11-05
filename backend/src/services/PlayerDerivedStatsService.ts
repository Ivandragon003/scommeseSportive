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
  upsertPlayers?(payloads: any[]): Promise<number>;
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
    teamObservedAt: number;
    positionCode: string;
    games: Set<string>;
    minutesTotal: number;
    teamShotsInPlayedGames: number;
    shots: number;
    shotsOnTarget: number;
    goals: number;
    xg: number;
    xgot: number;
    yellowCards: number;
    redCards: number;
    coverage: { shots: number; shotsOnTarget: number; yellowCards: number; redCards: number; shotShare: number };
    pairedShots: number;
    pairedShotsOnTarget: number;
    conversionShots: number;
    conversionGoals: number;
    shareShots: number;
    shotsFor90: number;
    shotsMinutes: number;
    targetFor90: number;
    targetMinutes: number;
    cardsFor90: number;
    cardsMinutes: number;
    yellowMinutes: number;
    yellowForMinutes: number;
    rawSamples: Record<string, unknown>[];
  };

  const playersAgg = new Map<string, PlayerAgg>();
  const playedMatches = matches.filter((m: any) => m.home_goals != null && m.away_goals != null);
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
    shots: any[] | null,
    teamId: string,
    matchId: string,
    matchDate: string,
    teamMatchShots: number | null
  ) => {
    const onTargetByPlayer = buildOnTargetMap(shots ?? []);
    const roster = Object.values(rosterEntries ?? {});
    const identity = (entry: any): string => String(entry?.player_id ?? entry?.id ?? entry?.player ?? entry?.playerName ?? '').trim().toLowerCase();
    const rosterCounts = new Map<string, number>();
    for (const entry of roster) {
      const key = identity(entry);
      if (key) rosterCounts.set(key, (rosterCounts.get(key) ?? 0) + 1);
    }
    const knownResults = new Set(['goal', 'savedshot', 'missedshots', 'blockedshot', 'shotonpost', 'owngoal']);
    const shotKeys = new Set<string>();
    const completeShotmap = shots !== null && shots.every((shot: any) => {
      const playerId = String(shot?.player_id ?? shot?.playerId ?? '').trim();
      const id = String(shot?.id ?? shot?.shot_id ?? '').trim();
      const key = id ? `id:${id}` : `event:${JSON.stringify(shot)}`;
      if (!playerId || !knownResults.has(normalizeShotResult(shot?.result ?? shot?.eventType)) || shotKeys.has(key)) return false;
      shotKeys.add(key);
      return true;
    });
    for (const entry of roster) {
      if ((rosterCounts.get(identity(entry)) ?? 0) > 1) continue;
      const playerName = String((entry as any)?.player ?? (entry as any)?.playerName ?? '').trim();
      if (!playerName) continue;
      const sourcePlayerId = numOrNull((entry as any)?.player_id ?? (entry as any)?.id);
      const playerId = sourcePlayerId !== null
        ? `understat_player_${Math.trunc(sourcePlayerId)}`
        : `understat_player_${playerName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`;
      const onTarget = onTargetByPlayer.get(String((entry as any)?.player_id ?? (entry as any)?.id ?? '')) ?? { count: 0, xgot: 0, samples: [] };
      const current = playersAgg.get(playerId) ?? {
        playerId,
        sourcePlayerId: sourcePlayerId === null ? null : Math.trunc(sourcePlayerId),
        name: playerName,
        teamId,
        teamObservedAt: Number.isFinite(Date.parse(matchDate)) ? Date.parse(matchDate) : -Infinity,
        positionCode: String((entry as any)?.position ?? 'MF').trim().split(/\s+/)[0] || 'MF',
        games: new Set<string>(),
        minutesTotal: 0,
        teamShotsInPlayedGames: 0,
        shots: 0,
        shotsOnTarget: 0,
        goals: 0,
        xg: 0,
        xgot: 0,
        yellowCards: 0,
        redCards: 0,
        coverage: { shots: 0, shotsOnTarget: 0, yellowCards: 0, redCards: 0, shotShare: 0 },
        pairedShots: 0, pairedShotsOnTarget: 0, conversionShots: 0, conversionGoals: 0, shareShots: 0,
        shotsFor90: 0, shotsMinutes: 0, targetFor90: 0, targetMinutes: 0, cardsFor90: 0, cardsMinutes: 0, yellowMinutes: 0, yellowForMinutes: 0,
        rawSamples: [],
      };
      const observedAt = Date.parse(matchDate);
      if (Number.isFinite(observedAt) && observedAt > current.teamObservedAt) {
        current.teamId = teamId;
        current.teamObservedAt = observedAt;
      }
      if (current.games.has(matchId)) continue;
      current.games.add(matchId);
      const observed = (value: unknown): number | null => {
        if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && value.trim() === '')) return null;
        const parsed = numOrNull(value);
        return parsed !== null && parsed >= 0 ? parsed : null;
      };
      const minutes = observed((entry as any)?.time);
      const count = (value: unknown): number | null => {
        const parsed = observed(value);
        return parsed !== null && Number.isInteger(parsed) ? parsed : null;
      };
      const playerShots = count((entry as any)?.shots);
      const playerGoals = count((entry as any)?.goals);
      const yellow = count((entry as any)?.yellow_card);
      const red = count((entry as any)?.red_card);
      const matchingShots = shots?.filter((shot: any) =>
        normalizeShotResult(shot?.result ?? shot?.eventType) !== 'owngoal'
        && String(shot?.player_id ?? shot?.playerId ?? '').trim() === String((entry as any)?.player_id ?? (entry as any)?.id ?? '').trim()
      ).length ?? 0;
      const target = completeShotmap && playerShots !== null && matchingShots === playerShots ? onTarget.count : null;
      current.minutesTotal += minutes ?? 0;
      if (playerShots !== null) {
        current.shots += playerShots;
        current.coverage.shots++;
        if (playerGoals !== null) { current.conversionShots += playerShots; current.conversionGoals += playerGoals; }
        if (minutes !== null && minutes > 0) { current.shotsFor90 += playerShots; current.shotsMinutes += minutes; }
        if (teamMatchShots !== null) {
          current.shareShots += playerShots;
          current.teamShotsInPlayedGames += teamMatchShots;
          current.coverage.shotShare++;
        }
      }
      if (target !== null) {
        current.shotsOnTarget += target;
        current.coverage.shotsOnTarget++;
        if (minutes !== null && minutes > 0) { current.targetFor90 += target; current.targetMinutes += minutes; }
        if (playerShots !== null) { current.pairedShots += playerShots; current.pairedShotsOnTarget += target; }
      }
      if (yellow !== null) {
        current.yellowCards += yellow;
        current.coverage.yellowCards++;
        if (minutes !== null && minutes > 0) { current.yellowMinutes += minutes; current.yellowForMinutes += yellow; }
      }
      if (red !== null) { current.redCards += red; current.coverage.redCards++; }
      if (yellow !== null && red !== null && minutes !== null && minutes > 0) {
        current.cardsFor90 += yellow + red;
        current.cardsMinutes += minutes;
      }
      current.goals += Number(numOrNull((entry as any)?.goals) ?? 0);
      current.xg += Number(numOrNull((entry as any)?.xG) ?? 0);
      current.xgot += Number(onTarget.xgot ?? 0);
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

    const raw = parseRawJson(match.raw_json);
    const homeRosters = raw?.details?.rosters?.h ?? {};
    const awayRosters = raw?.details?.rosters?.a ?? {};
    const homeShotsDetail = Array.isArray(raw?.details?.shots?.h) ? raw.details.shots.h : null;
    const awayShotsDetail = Array.isArray(raw?.details?.shots?.a) ? raw.details.shots.a : null;
    if (homeShotsDetail !== null || awayShotsDetail !== null) matchesWithShotmap++;

    // A partial shotmap cannot establish the team's total shots.
    const homeMatchShots = homeShots !== null && Number.isInteger(homeShots) && homeShots >= 0 ? homeShots : null;
    const awayMatchShots = awayShots !== null && Number.isInteger(awayShots) && awayShots >= 0 ? awayShots : null;

    ingestRoster(homeRosters, homeShotsDetail, homeTeamId, String(match.match_id), String(match.date ?? ''), homeMatchShots);
    ingestRoster(awayRosters, awayShotsDetail, awayTeamId, String(match.match_id), String(match.date ?? ''), awayMatchShots);
  }

  const playerWrites: any[] = [];
  for (const [, player] of playersAgg) {
    const games = Math.max(1, player.games.size);
    const minutesBase = player.minutesTotal > 0 ? player.minutesTotal : games * 90;
    // A4: denominatore = tiri squadra nelle SOLE gare giocate dal giocatore
    // (prima: tiri squadra su TUTTE le partite del periodo, che deprimeva la
    // share di chi aveva saltato gare per infortunio/rotazione).
    const teamShotsInGames = player.teamShotsInPlayedGames;

    playerWrites.push({
      playerId: player.playerId,
      sourcePlayerId: player.sourcePlayerId,
      name: player.name,
      teamId: player.teamId,
      positionCode: player.positionCode,
      avgShotsPerGame: player.coverage.shots > 0 ? player.shots / player.coverage.shots : null,
      avgShotsOnTargetPerGame: player.coverage.shotsOnTarget > 0 ? player.shotsOnTarget / player.coverage.shotsOnTarget : null,
      avgXGPerGame: player.xg / games,
      avgXGOTPerGame: player.xgot / games,
      totalGoals: player.goals,
      totalShots: player.coverage.shots > 0 ? player.shots : null,
      totalShotsOnTarget: player.coverage.shotsOnTarget > 0 ? player.shotsOnTarget : null,
      minutesTotal: player.minutesTotal,
      avgMinutes: player.minutesTotal > 0 ? player.minutesTotal / games : 0,
      shotsPer90: player.shotsMinutes > 0 ? (player.shotsFor90 / player.shotsMinutes) * 90 : null,
      shotsOnTargetPer90: player.targetMinutes > 0 ? (player.targetFor90 / player.targetMinutes) * 90 : null,
      xgPer90: minutesBase > 0 ? (player.xg / minutesBase) * 90 : 0,
      shotOnTargetPct: player.pairedShots > 0 ? safePct(player.pairedShotsOnTarget, player.pairedShots) : null,
      goalConversion: player.conversionShots > 0 ? player.conversionGoals / player.conversionShots : null,
      yellowCardsTotal: player.coverage.yellowCards > 0 ? player.yellowCards : null,
      redCardsTotal: player.coverage.redCards > 0 ? player.redCards : null,
      cardsPer90: player.cardsMinutes > 0 ? (player.cardsFor90 / player.cardsMinutes) * 90 : null,
      shotShareOfTeam: teamShotsInGames > 0 ? player.shareShots / teamShotsInGames : null,
      gamesPlayed: games,
      isAvailable: true,
      statsJson: JSON.stringify({
        source: 'recompute_from_matches_raw',
        coverage: player.coverage,
        observedMinutes: { yellowCards: player.yellowMinutes },
        observedTotals: { yellowCards: player.yellowForMinutes },
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
  }
  if (db.upsertPlayers) await db.upsertPlayers(playerWrites);
  else for (const payload of playerWrites) await db.upsertPlayer(payload);
  const playersUpdated = playerWrites.length;

  return {
    playersMarkedUnavailable,
    playersDetected: playersAgg.size,
    playersUpdated,
    playedMatchesConsidered: playedMatches.length,
    matchesWithShotmap,
  };
}
