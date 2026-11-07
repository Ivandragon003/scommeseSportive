// Resolved FL1/2026 identities: Understat 172 is Troyes, 282 is Le Havre,
// and 295 is Le Mans. Keep this check bounded to the reviewed local IDs;
// unrelated mappings and aliases retain their existing admission rules.
const REVIEWED_IDENTITIES: Record<string, { providerId: string; names: readonly string[] }> = {
  understat_team_172: { providerId: '531', names: ['troyes', 'estactroyes', 'estroyesac'] },
  le_havre: { providerId: '533', names: ['lehavre', 'havreac', 'lehavreac'] },
  understat_team_295: { providerId: '535', names: ['lemans', 'lemansfc'] },
};

/** Names alone cannot clear an incorrect association with a reviewed local ID. */
export function reviewedSourceIdentityConsistent(competition: string, season: number, localId: string | undefined,
  names: readonly unknown[], providerId?: string): boolean {
  if (competition !== 'FL1' || season !== 2026) return true;
  const identity = localId && Object.prototype.hasOwnProperty.call(REVIEWED_IDENTITIES, localId)
    ? REVIEWED_IDENTITIES[localId] : undefined;
  if (!identity) return true;
  return (providerId === undefined || providerId === identity.providerId) && names.every((name) =>
    typeof name === 'string' && identity.names.includes(name.toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')));
}
