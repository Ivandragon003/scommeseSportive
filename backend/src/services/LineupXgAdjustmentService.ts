import { predictionEngineConfig } from '../config/PredictionEngineConfig';
import { clamp } from '../models/utils/MathUtils';

/**
 * LineupXgAdjustmentService — assenze player-level → correzione dell'xG squadra.
 *
 * Il context builder gestisce già un segnale generico di assenze
 * (homeKeyAbsences: un conteggio). Qui il segnale è più fine: la lista dei
 * giocatori assenti (id o nome) viene incrociata con la tabella players e
 * l'xG atteso della squadra viene ridotto in proporzione alla quota di xG
 * che i giocatori assenti producono di solito.
 *
 * Modello: ogni giocatore contribuisce peso = avg_xg_per_game (fallback
 * xg_per90 × avg_minutes/90). La quota assente non si perde tutta: il
 * sostituto produce replacementRatio (default 60%) di quella quota.
 *   multiplier = 1 - quotaAssente × (1 - replacementRatio)
 * cappato a maxXgReduction (default -18%).
 */

export interface LineupXgAdjustment {
  multiplier: number;
  /** Quota di xG squadra attribuita ai giocatori assenti riconosciuti (0-1). */
  absentXgShare: number;
  /** Giocatori assenti riconosciuti nella rosa (nome dal db). */
  matchedAbsences: string[];
  /** Identificatori richiesti ma non trovati nella rosa. */
  unmatchedAbsences: string[];
}

const NEUTRAL_ADJUSTMENT: LineupXgAdjustment = {
  multiplier: 1,
  absentXgShare: 0,
  matchedAbsences: [],
  unmatchedAbsences: [],
};

function normalizeIdentifier(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function playerXgWeight(player: any): number {
  const perGame = Number(player?.avg_xg_per_game);
  if (Number.isFinite(perGame) && perGame > 0) return perGame;

  const per90 = Number(player?.xg_per90);
  const avgMinutes = Number(player?.avg_minutes);
  if (Number.isFinite(per90) && per90 > 0) {
    const minutesFactor = Number.isFinite(avgMinutes) && avgMinutes > 0
      ? clamp(avgMinutes / 90, 0.1, 1)
      : 0.7;
    return per90 * minutesFactor;
  }

  return 0;
}

export function computeLineupXgAdjustment(
  players: any[],
  absentPlayers: Array<string | null | undefined> | null | undefined,
  options?: {
    replacementRatio?: number;
    maxXgReduction?: number;
  }
): LineupXgAdjustment {
  const config = predictionEngineConfig.lineupXg;
  const absentIdentifiers = (absentPlayers ?? [])
    .map(normalizeIdentifier)
    .filter((value) => value.length > 0);
  if (absentIdentifiers.length === 0 || !Array.isArray(players) || players.length === 0) {
    return { ...NEUTRAL_ADJUSTMENT, unmatchedAbsences: absentIdentifiers };
  }

  const replacementRatio = clamp(options?.replacementRatio ?? config.replacementRatio, 0, 1);
  const maxXgReduction = clamp(options?.maxXgReduction ?? config.maxXgReduction, 0, 0.9);

  let poolXg = 0;
  let absentXg = 0;
  const matchedAbsences: string[] = [];
  const matchedIdentifiers = new Set<string>();

  for (const player of players) {
    const weight = playerXgWeight(player);
    poolXg += weight;

    const idKey = normalizeIdentifier(player?.player_id ?? player?.playerId);
    const nameKey = normalizeIdentifier(player?.name ?? player?.playerName);
    const matchKey = absentIdentifiers.find((identifier) => identifier === idKey || identifier === nameKey);
    if (matchKey !== undefined) {
      absentXg += weight;
      matchedAbsences.push(String(player?.name ?? player?.playerName ?? matchKey));
      matchedIdentifiers.add(matchKey);
    }
  }

  const unmatchedAbsences = absentIdentifiers.filter((identifier) => !matchedIdentifiers.has(identifier));

  if (poolXg <= 0 || absentXg <= 0) {
    return { ...NEUTRAL_ADJUSTMENT, matchedAbsences, unmatchedAbsences };
  }

  const absentXgShare = clamp(absentXg / poolXg, 0, 1);
  const netLoss = Math.min(maxXgReduction, absentXgShare * (1 - replacementRatio));
  const multiplier = clamp(1 - netLoss, 1 - maxXgReduction, 1);

  return {
    multiplier: Number(multiplier.toFixed(4)),
    absentXgShare: Number(absentXgShare.toFixed(4)),
    matchedAbsences,
    unmatchedAbsences,
  };
}
