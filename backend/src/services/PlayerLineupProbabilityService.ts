export type PlayerLineupStatus =
  | 'predicted_starter'
  | 'predicted_bench'
  | 'confirmed_starter'
  | 'confirmed_bench'
  | 'unavailable';

export type PlayerLineupAssessment = {
  probability: number;
  tier: 'probable_starter' | 'ballotaggio' | 'uncertain' | 'confirmed_starter' | 'confirmed_bench' | 'unavailable';
  status: PlayerLineupStatus | 'modelled';
  warnings: string[];
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Deterministic fallback used until a provider returns a fixture-specific lineup.
 * It is intentionally conservative: historical minutes are evidence of usage,
 * not proof that the player starts this particular fixture.
 */
export function estimateStartingProbability(player: any): number {
  const avgMinutes = clamp(Number(player?.avg_minutes ?? player?.avgMinutes ?? 0) || 0, 0, 90);
  const games = clamp(Number(player?.games_played ?? player?.gamesPlayed ?? 0) || 0, 0, 15);
  const minutesSignal = avgMinutes / 90;
  const sampleSignal = games / 15;
  let probability = 0.34 + minutesSignal * 0.48 + sampleSignal * 0.10;
  if (avgMinutes < 45) probability -= 0.18;
  if (avgMinutes >= 75) probability += 0.05;
  return Number(clamp(probability, 0.05, 0.92).toFixed(4));
}

export function assessPlayerLineup(player: any, external?: { status?: PlayerLineupStatus; probability?: number }): PlayerLineupAssessment {
  const status = external?.status;
  if (status === 'confirmed_starter') {
    return { probability: 1, tier: 'confirmed_starter', status, warnings: [] };
  }
  if (status === 'confirmed_bench') {
    return { probability: 0, tier: 'confirmed_bench', status, warnings: ['confirmed_on_bench'] };
  }
  if (status === 'unavailable') {
    return { probability: 0, tier: 'unavailable', status, warnings: ['player_unavailable'] };
  }
  if (status === 'predicted_starter' || status === 'predicted_bench') {
    const probability = clamp(Number(external?.probability ?? 0), 0, 1);
    if (status === 'predicted_bench') {
      return { probability, tier: 'ballotaggio', status, warnings: ['predicted_bench'] };
    }
    return {
      probability,
      tier: probability >= 0.85 ? 'probable_starter' : probability >= 0.70 ? 'ballotaggio' : 'uncertain',
      status,
      warnings: probability >= 0.85 ? [] : ['lineup_prediction_uncertain'],
    };
  }
  const probability = estimateStartingProbability(player);
  return {
    probability,
    tier: probability >= 0.85 ? 'probable_starter' : probability >= 0.70 ? 'ballotaggio' : 'uncertain',
    status: 'modelled',
    warnings: ['lineup_modelled_not_confirmed', ...(probability < 0.85 ? ['lineup_prediction_uncertain'] : [])],
  };
}
