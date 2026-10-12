import { isPlayerDataEnabled } from './PlayerDataConfig';

/** Pause lineup collection/reads without deleting the player statistics or snapshots. */
export function isPlayerAvailabilityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isPlayerDataEnabled(env)
    && String(env.PLAYER_AVAILABILITY_ENABLED ?? 'false').trim().toLowerCase() === 'true';
}
