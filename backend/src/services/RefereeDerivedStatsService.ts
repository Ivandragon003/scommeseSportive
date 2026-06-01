// Referee derived-stats rebuild, extracted verbatim from api/routes.ts.
// The DB is injected (dependency inversion) so the logic is testable in
// isolation and no longer lives in the route layer. No behavior change.

export interface RefereeDerivedStatsDb {
  getMatches(filters: {
    competition?: string;
    season?: string;
    fromDate?: string;
    toDate?: string;
  }): Promise<any[]>;
  upsertReferee(payload: {
    name: string;
    avgFouls?: number;
    avgYellow?: number;
    avgRed?: number;
    games: number;
    dispersionYellow: number;
  }): Promise<unknown>;
}

export interface RebuildRefereeDerivedStatsOptions {
  competition?: string;
  season?: string;
  fromDate?: string;
  toDate?: string;
  names?: string[];
}

export interface RefereeDerivedStatsResult {
  refereesDetected: number;
  refereesUpdated: number;
  matchesConsidered: number;
}

// Local copy of the small numeric coercion helper used by the route layer.
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function rebuildRefereeDerivedStats(
  db: RefereeDerivedStatsDb,
  options?: RebuildRefereeDerivedStatsOptions
): Promise<RefereeDerivedStatsResult> {
  const matches = await db.getMatches({
    competition: String(options?.competition ?? '').trim() || undefined,
    season: String(options?.season ?? '').trim() || undefined,
    fromDate: String(options?.fromDate ?? '').trim() || undefined,
    toDate: String(options?.toDate ?? '').trim() || undefined,
  });
  const targetNames = new Set((options?.names ?? []).map((name) => String(name ?? '').trim().toLowerCase()).filter(Boolean));
  const playedMatches = matches.filter((m: any) =>
    m.home_goals !== null
    && m.away_goals !== null
    && String(m.referee ?? '').trim().length > 0
    && (targetNames.size === 0 || targetNames.has(String(m.referee ?? '').trim().toLowerCase()))
  );

  const aggregates = new Map<string, {
    name: string;
    games: number;
    foulsTotal: number;
    foulsGames: number;
    yellowTotal: number;
    yellowGames: number;
    redTotal: number;
    redGames: number;
    yellowSamples: number[];
  }>();

  for (const match of playedMatches) {
    const name = String(match.referee ?? '').trim();
    if (!name) continue;
    const current = aggregates.get(name) ?? {
      name,
      games: 0,
      foulsTotal: 0,
      foulsGames: 0,
      yellowTotal: 0,
      yellowGames: 0,
      redTotal: 0,
      redGames: 0,
      yellowSamples: [],
    };
    current.games += 1;

    const totalFouls =
      numOrNull(match.home_fouls) !== null && numOrNull(match.away_fouls) !== null
        ? Number(match.home_fouls) + Number(match.away_fouls)
        : null;
    if (totalFouls !== null) {
      current.foulsTotal += totalFouls;
      current.foulsGames += 1;
    }

    const totalYellow =
      numOrNull(match.home_yellow_cards) !== null && numOrNull(match.away_yellow_cards) !== null
        ? Number(match.home_yellow_cards) + Number(match.away_yellow_cards)
        : null;
    if (totalYellow !== null) {
      current.yellowTotal += totalYellow;
      current.yellowGames += 1;
      current.yellowSamples.push(totalYellow);
    }

    const totalRed =
      numOrNull(match.home_red_cards) !== null && numOrNull(match.away_red_cards) !== null
        ? Number(match.home_red_cards) + Number(match.away_red_cards)
        : null;
    if (totalRed !== null) {
      current.redTotal += totalRed;
      current.redGames += 1;
    }

    aggregates.set(name, current);
  }

  let refereesUpdated = 0;
  for (const [, referee] of aggregates) {
    const yellowMean = referee.yellowGames > 0 ? referee.yellowTotal / referee.yellowGames : 0;
    const variance = referee.yellowSamples.length > 0
      ? referee.yellowSamples.reduce((sum, sample) => sum + ((sample - yellowMean) ** 2), 0) / referee.yellowSamples.length
      : 0;
    await db.upsertReferee({
      name: referee.name,
      avgFouls: referee.foulsGames > 0 ? referee.foulsTotal / referee.foulsGames : undefined,
      avgYellow: referee.yellowGames > 0 ? yellowMean : undefined,
      avgRed: referee.redGames > 0 ? referee.redTotal / referee.redGames : undefined,
      games: referee.games,
      dispersionYellow: Math.sqrt(Math.max(0, variance)),
    });
    refereesUpdated++;
  }

  return {
    refereesDetected: aggregates.size,
    refereesUpdated,
    matchesConsidered: playedMatches.length,
  };
}
