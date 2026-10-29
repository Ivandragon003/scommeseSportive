import { OddsMatch, SelectedBookmaker } from '../OddsApiService';

export type OddsProviderHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'not_checked' | 'disabled';

export type OddsProviderHealth = {
  provider: string;
  status: OddsProviderHealthStatus;
  checkedAt: string;
  message?: string;
  details?: Record<string, unknown>;
};

/** Only a structured cache-policy denial is an expected request skip. */
export const oddsPolicySkipReason = (error: unknown): 'odds_cache_only' | null =>
  error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'odds_cache_only'
    ? 'odds_cache_only' : null;

export const providerPolicySkipReason = (health?: Record<string, OddsProviderHealth> | null): 'odds_cache_only' | null => {
  const providers = Object.values(health ?? {});
  if (providers.some((provider) => !provider || typeof provider !== 'object')) return null;
  const attempted = providers.filter((provider) =>
    provider.status !== 'not_checked' || provider.message || provider.details?.skipReason);
  return attempted.length > 0 && attempted.every((provider) =>
    provider.status === 'not_checked' && provider.details?.skipReason === 'odds_cache_only')
    ? 'odds_cache_only' : null;
};

export type OddsProviderFixture = {
  homeTeam: string;
  awayTeam: string;
  commenceTime?: string | null;
};

export type OddsProviderRequest = {
  competition: string;
  fixtures?: OddsProviderFixture[];
  markets?: string[];
  fallbackMarkets?: string[];
  extraEventMarkets?: string[];
  includeExtendedGroups?: boolean;
};

export type OddsProviderFetchResult<T extends OddsMatch = OddsMatch> = {
  matches: T[];
  fetchedAt: string;
  fallbackReason: string | null;
  warnings: string[];
  health?: OddsProviderHealth;
  details?: Record<string, unknown>;
};

export interface OddsProvider<T extends OddsMatch = OddsMatch> {
  getCompetitionOdds(request: OddsProviderRequest): Promise<OddsProviderFetchResult<T>>;
  getOddsForFixtures(request: OddsProviderRequest): Promise<OddsProviderFetchResult<T>>;
  healthCheck(request: OddsProviderRequest): Promise<OddsProviderHealth>;
  getProviderName(): string;
}

export interface OddsProviderTools<T extends OddsMatch = OddsMatch> {
  extractBestOdds(match: T, preferredBookmaker?: string): Record<string, number>;
  getSelectedBookmaker(match: T, preferredBookmaker?: string): SelectedBookmaker | null;
  compareBookmakers(match: T): Record<string, Record<string, number>>;
  calculateMargin(match: T, bookmakerKey: string): number | null;
  getRuntimeMetadata(): Record<string, unknown>;
  close?(): Promise<void>;
}

export type OddsProviderAdapter<T extends OddsMatch = OddsMatch> = OddsProvider<T> & OddsProviderTools<T>;
