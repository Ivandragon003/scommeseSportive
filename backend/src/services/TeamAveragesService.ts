// Prefer set-based recomputation; retain the single-team contract for adapters.

export interface TeamAveragesDb {
  recomputeTeamAverages(teamId: string): Promise<unknown>;
  recomputeTeamAveragesBatch?(teamIds: string[]): Promise<unknown>;
}

export async function recomputeTeamAveragesForTeamIds(
  db: TeamAveragesDb,
  ids: string[],
): Promise<number> {
  const teamIds = [...new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean))];
  if (teamIds.length === 0) return 0;
  if (typeof db.recomputeTeamAveragesBatch === 'function') {
    await db.recomputeTeamAveragesBatch(teamIds);
  } else {
    for (const teamId of teamIds) await db.recomputeTeamAverages(teamId);
  }
  return teamIds.length;
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
  return recomputeTeamAveragesForTeamIds(db, teamIds);
}
