// Team-average recomputation for a set of match rows, extracted verbatim from
// api/routes.ts. The DB is injected (dependency inversion). No behavior change.

export interface TeamAveragesDb {
  recomputeTeamAverages(teamId: string): Promise<unknown>;
}

export async function recomputeTeamAveragesForMatchRows(
  db: TeamAveragesDb,
  rows: Array<{ home_team_id?: string | null; away_team_id?: string | null }>
): Promise<number> {
  const teamIds = Array.from(
    new Set(
      rows.flatMap((row) => [
        String(row?.home_team_id ?? '').trim(),
        String(row?.away_team_id ?? '').trim(),
      ]).filter(Boolean)
    )
  );
  let recomputed = 0;
  for (const teamId of teamIds) {
    await db.recomputeTeamAverages(teamId);
    recomputed += 1;
  }
  return recomputed;
}
