/** Reuse the scoped DB read and only writes confirmed by the transactional adapter. */
export function understatCommitState(
  existingIds: Iterable<string>,
  pendingWrites: Record<string, unknown>[],
  committedCount: number,
): { persistedIds: Set<string>; affectedTeamIds: Set<string> } {
  const persistedIds = new Set(existingIds);
  const affectedTeamIds = new Set<string>();
  for (const row of pendingWrites.slice(0, Math.max(0, committedCount))) {
    persistedIds.add(String(row.matchId));
    if (row.homeGoals == null || row.awayGoals == null) continue;
    for (const id of [row.homeTeamId, row.awayTeamId]) {
      if (id != null && String(id).trim()) affectedTeamIds.add(String(id));
    }
  }
  return { persistedIds, affectedTeamIds };
}
