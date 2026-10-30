import { buildResearchComparison, comparisonPeriod, ResearchComparisonQuery } from '../research/ResearchComparison';

type WalletStore = Parameters<typeof buildResearchComparison>[0];
type RecommendationReader = Parameters<typeof buildResearchComparison>[3];

/** The main app reads the already funded A/C ledger; it never creates another bankroll. */
export async function buildAppWallets(
  store: WalletStore,
  query: ResearchComparisonQuery = {},
  now = new Date(),
  recommendations?: RecommendationReader,
) {
  // Reject malformed periods before reading the database, including on an empty account.
  comparisonPeriod(query, now);
  const wallets = await buildResearchComparison(store, query, now, recommendations);
  if (wallets.period.key === 'all') wallets.period.label = 'Dall’apertura dei portafogli';
  return wallets;
}

export function parseAppWalletQuery(raw: Record<string, unknown>): ResearchComparisonQuery {
  const query: ResearchComparisonQuery = {};
  for (const key of ['period', 'from', 'to'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string') throw new Error(`Invalid comparison query: ${key} must be a string`);
    query[key] = raw[key] as string;
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
