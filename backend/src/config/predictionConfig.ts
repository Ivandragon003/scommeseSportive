const readNumberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
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
};

export type PredictionConfig = typeof predictionConfig;
