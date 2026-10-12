/** Temporary pause; preserve stored data for re-enabling player markets later. */
export function isPlayerDataEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.PLAYER_DATA_ENABLED ?? 'false').trim().toLowerCase() === 'true';
}
