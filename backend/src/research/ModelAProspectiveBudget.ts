export type ModelACollectionBudgets = { predictMs: number; confirmationMs: number };
export type ModelACollectionPerformance = {
  version: 1;
  budgets: ModelACollectionBudgets;
  timingSemantics: { predict: string; confirmation: string };
  predict: { count: number; maxMs: number | null; overBudget: number };
  confirmation: { count: number; maxMs: number | null; overBudget: number; stored: number; unconfirmed: number };
  alert: boolean;
};

function budgetValue(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error('collection_budget_invalid');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 3600000) throw new Error('collection_budget_invalid');
  return n;
}
export function collectionBudgetsFromEnv(env: NodeJS.ProcessEnv): ModelACollectionBudgets {
  return { predictMs: budgetValue(env.MODEL_A_COLLECTION_PREDICT_BUDGET_MS, 30000),
    confirmationMs: budgetValue(env.MODEL_A_COLLECTION_CONFIRMATION_BUDGET_MS, 45000) };
}
export class ModelACollectionPerformanceMeter {
  private readonly metrics: ModelACollectionPerformance;
  constructor(budgets: ModelACollectionBudgets) {
    if (![budgets.predictMs, budgets.confirmationMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 3600000)) throw new Error('collection_budget_invalid');
    this.metrics = { version: 1, budgets: { ...budgets }, timingSemantics: { predict: 'predict start to response or error', confirmation: 'predict start to recorder completion; stored or unconfirmed' }, predict: { count: 0, maxMs: null, overBudget: 0 },
      confirmation: { count: 0, maxMs: null, overBudget: 0, stored: 0, unconfirmed: 0 }, alert: false };
  }
  observe(kind: 'predict' | 'confirmation', elapsedMs: number, completion?: 'stored' | 'unconfirmed'): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('collection_measurement_invalid');
    const m = this.metrics[kind]; m.count++; m.maxMs = Math.max(m.maxMs ?? 0, elapsedMs);
    if (kind === 'confirmation') this.metrics.confirmation[completion === 'stored' ? 'stored' : 'unconfirmed']++;
    if (elapsedMs > (kind === 'predict' ? this.metrics.budgets.predictMs : this.metrics.budgets.confirmationMs)) { m.overBudget++; this.metrics.alert = true; }
  }
  snapshot(): ModelACollectionPerformance {
    return { ...this.metrics, budgets: { ...this.metrics.budgets }, timingSemantics: { ...this.metrics.timingSemantics }, predict: { ...this.metrics.predict }, confirmation: { ...this.metrics.confirmation } };
  }
}
