import { OddsMatch } from '../OddsApiService';

export type OddsProviderHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'not_checked' | 'disabled';

export type OddsProviderHealth = {
  provider: string;
  status: OddsProviderHealthStatus;
  checkedAt: string;
  message?: string;
  details?: Record<string, unknown>;
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
  compareBookmakers(match: T): Record<string, Record<string, number>>;
  calculateMargin(match: T, bookmakerKey: string): number | null;
  getRuntimeMetadata(): Record<string, unknown>;
  close?(): Promise<void>;
}

export type OddsProviderAdapter<T extends OddsMatch = OddsMatch> = OddsProvider<T> & OddsProviderTools<T>;
