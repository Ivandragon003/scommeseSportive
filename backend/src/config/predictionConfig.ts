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
    homeAdvantageScale: clamp(readNumberEnv('MODEL_HOME_ADVANTAGE_SCALE', 0.5), 0.1, 1.0),
    contextWeights: {
      form: clamp(readNumberEnv('MODEL_WEIGHT_FORM', 0.12), 0, 0.5),
      motivation: clamp(readNumberEnv('MODEL_WEIGHT_MOTIVATION', 0.06), 0, 0.4),
      absences: clamp(readNumberEnv('MODEL_WEIGHT_ABSENCES', 0.05), 0, 0.4),
      discipline: clamp(readNumberEnv('MODEL_WEIGHT_DISCIPLINE', 0.03), 0, 0.3),
    },
  },
  markets: {
    minSampleSizePerTeam: Math.max(1, Math.round(readNumberEnv('MODEL_MARKET_MIN_SAMPLE', 8))),
    minCombinedSampleSize: Math.max(2, Math.round(readNumberEnv('MODEL_MARKET_MIN_COMBINED_SAMPLE', 20))),
  },
};

export type PredictionConfig = typeof predictionConfig;
