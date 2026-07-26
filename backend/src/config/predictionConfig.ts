import { clamp } from '../models/utils/MathUtils';

const readNumberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const predictionConfig = {
  model: {
    // 0.1-0.3: impatto casa molto attenuato, 0.4-0.7: default equilibrato, 0.8-1.0: vantaggio casa molto incisivo.
    homeAdvantageScale: clamp(readNumberEnv('MODEL_HOME_ADVANTAGE_SCALE', 0.5), 0.1, 1.0),
    contextWeights: {
      // 0.00-0.10: forma recente quasi marginale, 0.10-0.20: peso normale, 0.20-0.50: forma molto dominante sul moltiplicatore goal.
      form: clamp(readNumberEnv('MODEL_WEIGHT_FORM', 0.12), 0, 0.5),
      // 0.00-0.05: motivazioni quasi neutre, 0.05-0.15: peso normale, 0.15-0.40: motivazione molto influente sul match context.
      motivation: clamp(readNumberEnv('MODEL_WEIGHT_MOTIVATION', 0.06), 0, 0.4),
      // 0.00-0.05: assenze poco rilevanti, 0.05-0.15: peso normale, 0.15-0.40: assenze molto penalizzanti.
      absences: clamp(readNumberEnv('MODEL_WEIGHT_ABSENCES', 0.05), 0, 0.4),
      // 0.00-0.03: disciplina quasi trascurabile, 0.03-0.10: peso normale, 0.10-0.30: cartellini/falli incidono molto sul profilo gara.
      discipline: clamp(readNumberEnv('MODEL_WEIGHT_DISCIPLINE', 0.03), 0, 0.3),
    },
  },
  markets: {
    minSampleSizePerTeam: Math.max(1, Math.round(readNumberEnv('MODEL_MARKET_MIN_SAMPLE', 8))),
    minCombinedSampleSize: Math.max(2, Math.round(readNumberEnv('MODEL_MARKET_MIN_COMBINED_SAMPLE', 20))),
  },
  playerGoals: {
    // Marcatore anytime (E5): shrink su lambda=xG/90 per la lieve sovrastima
    // misurata in validazione as-of (9.4% pred vs 8.3% reale). 1.0 = nessuno shrink.
    xgShrink: clamp(readNumberEnv('PLAYER_GOALS_XG_SHRINK', 0.88), 0.5, 1.0),
  },
};

/**
 * Media gialli/match per lega (empirica, 4 stagioni su DB, 2026-07). Usata SOLO
 * dal modello cartellino GIOCATORE (B6): prima usava le costanti hardcoded
 * leagueAvgTeamYellows=1.9 / leagueAvgRefereeYellow=3.8, che sovrastimavano il
 * moltiplicatore-disciplina in La Liga (reale 4.58/match, non 3.8) e lo
 * sottostimavano in Ligue 1. NON usata dal modello squadra (il parametro
 * per-lega li' e' documentato NO-GO). Aggiornare rigirando la query per-lega.
 */
export const LEAGUE_AVG_YELLOW_PER_MATCH: Record<string, number> = {
  'La Liga': 4.58,
  'Serie A': 4.01,
  'Bundesliga': 3.90,
  'Premier League': 3.89,
  'Ligue 1': 3.61,
};

export const DEFAULT_LEAGUE_AVG_YELLOW_PER_MATCH = 3.9;

export function resolveLeagueAvgYellowPerMatch(competition?: string | null): number {
  const key = String(competition ?? '').trim();
  if (key && LEAGUE_AVG_YELLOW_PER_MATCH[key] !== undefined) return LEAGUE_AVG_YELLOW_PER_MATCH[key];
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(LEAGUE_AVG_YELLOW_PER_MATCH)) {
    if (name.toLowerCase() === lower) return value;
  }
  return DEFAULT_LEAGUE_AVG_YELLOW_PER_MATCH;
}
