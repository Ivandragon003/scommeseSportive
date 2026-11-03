import { parseArchiveQuery } from './WalletArchiveService';
import { recordedTime, walletPeriodResults } from './WalletPeriodResults';
import { buildResearchComparison, comparisonPeriod, ResearchComparisonQuery } from '../research/ResearchComparison';

type WalletStore = Parameters<typeof buildResearchComparison>[0];
type RecommendationReader = Parameters<typeof buildResearchComparison>[3];

/** The main app reads the already funded A/C ledger; it never creates another bankroll. */
export async function buildAppWallets(
  store: WalletStore,
  query: ResearchComparisonQuery = {},
  now = new Date(),
  recommendations?: RecommendationReader,
  history?: { records: () => Promise<Record<string, any>[]>; availableCents: () => Promise<number | null> },
) {
  // Reject malformed periods before reading the database, including on an empty account.
  comparisonPeriod(query, now);
  const wallets = await buildResearchComparison(store, query, now, recommendations);
  if (wallets.period.key === 'all') wallets.period.label = 'Dall’apertura dei portafogli';
  if (query.includeHistory || query.qualities?.length) {
    if (!history) throw new Error('Recorded wallet history unavailable');
    const [records, availableCents] = await Promise.all([history.records(), history.availableCents()]);
    if (wallets.period.key === 'all' && records.length) {
      const first = Math.min(...records.map(row => recordedTime(row.createdAt)).filter(Number.isFinite));
      if (Number.isFinite(first)) wallets.period.from = new Date(first).toISOString();
    }
    const results = Object.fromEntries(['A', 'C'].map(family => [family, walletPeriodResults(records, family, wallets.period, query.qualities || [])]));
    wallets.portfolios = wallets.portfolios.map((row: Record<string, any>) => ({ ...row, ...results[row.family].metrics }));
    for (const [key, field] of [['byLeague', 'league'], ['byMarket', 'market']] as const) {
      const labels = [...new Set(records.map(row => row[field] || 'Non disponibile'))];
      wallets[key] = labels.map(label => { const own = records.filter(row => (row[field] || 'Non disponibile') === label);
        return { label, A: walletPeriodResults(own, 'A', wallets.period, query.qualities || []).metrics,
          C: walletPeriodResults(own, 'C', wallets.period, query.qualities || []).metrics };
      }).filter(row => row.A.betCount + row.A.settledCount + row.C.betCount + row.C.settledCount > 0);
    }
    const [a, c] = ['A', 'C'].map(family => wallets.portfolios.find((row: Record<string, any>) => row.family === family));
    wallets.leader = !a?.initialized || !c?.initialized || a.profitCents == null || c.profitCents == null ? null
      : a.profitCents === c.profitCents ? 'TIE' : a.profitCents > c.profitCents ? 'A' : 'C';
    wallets.historicalAvailableCents = availableCents;
    wallets.filteredProfitCurves = query.qualities?.length ? { A: results.A.profitCurve, C: results.C.profitCurve } : null;
  }

  return wallets;
}

export function parseAppWalletQuery(raw: Record<string, unknown>): ResearchComparisonQuery {
  const query: ResearchComparisonQuery = {};
  for (const key of ['period', 'from', 'to'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string') throw new Error(`Invalid comparison query: ${key} must be a string`);
    query[key] = raw[key] as string;
  }
  if (raw.qualities !== undefined) {
    if (typeof raw.qualities !== 'string') throw new Error('Invalid comparison qualities');
    try { query.qualities = parseArchiveQuery({ qualities: raw.qualities }).qualities; }
    catch { throw new Error('Invalid comparison qualities'); }
  }
  if (raw.includeHistory !== undefined) {
    if (!['true', 'false'].includes(String(raw.includeHistory))) throw new Error('Invalid comparison history option');
    query.includeHistory = raw.includeHistory === 'true';
  }
  return query;
}

export const isAppWalletQueryError = (error: unknown): boolean => error instanceof Error
  && /^Invalid comparison|^Custom comparison|^Comparison end date/.test(error.message);

const isManagedWalletId = (value: unknown): boolean => typeof value === 'string'
  && /^(?:shadow_[ac]|[ac])$/i.test(value.trim());

/** A model-specific request must never fall through to the previous shared-user wallet. */
export function targetsAppWallet(body: Record<string, unknown> | undefined, pathUserId?: string): boolean {
  const target = body ?? {};
  const targetKeys = new Set(['modelfamily', 'family', 'model', 'portfolioid', 'userid']);
  return Object.entries(target).some(([key, value]) =>
    targetKeys.has(key.replace(/_/g, '').toLowerCase()) && isManagedWalletId(value))
    || isManagedWalletId(pathUserId);
}
