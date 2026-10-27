export interface ResearchOddsProvider {
  provider: string;
  accountScope: string;
  status: string;
  monthlyLimit: number | null;
  reserveCredits: number | null;
  resetConfirmed: boolean;
  planningVerified: boolean;
  observedUsed: number | null;
  observedRemaining: number | null;
  observedAt: string | null;
  plannedCredits: number;
  chargedCredits: number;
  reservedCredits: number;
  measuredCredits: number;
  unknownChargedCredits: number;
  carryoverCredits?: number | null;
  availableCredits: number | null;
  requests: number;
  failures: number;
  lastFetch: string | null;
  plannedForecast: unknown;
  actualBookmakers?: string[] | null;
  actualMarkets?: string[] | null;
  actualCoverageAsOf?: string | null;
  actualCoverageSource?: string;
  resetAt?: string;
  resetConvention?: string;
}

export interface ResearchOddsUsage {
  provider: string;
  accountScope: string;
  endpoint: string;
  operation: string;
  markets: string[];
  requests: number;
  plannedCredits: number;
  chargedCredits: number;
  measuredCredits: number;
}

export interface ResearchOddsEvent {
  provider: string;
  accountScope: string;
  type: string;
  reason: string | null;
  count: number;
  lastAt: string;
}

export interface ResearchOddsForecast {
  calendarFixtures: number;
  competitionKickoffGroups: number;
  estimatedCredits: number;
  estimatedHttpRequests: number;
  completeCalendarVerified: boolean;
  futureKickoffsVerified: boolean;
  through: string;
  scope: 'remaining_decision_targets_in_current_utc_month';
  measuredQuota: number | null;
  assumptions: string[] | {
    markets?: string[];
    regionCount?: number;
    retryRate?: number;
    calendarSource?: string;
    cacheHitRate?: number;
    sharedByModels?: string[];
    cacheWindowSeconds?: number;
    note?: string;
  };
  projectedTotalCredits: number;
}

export interface ResearchOddsStatus {
  observedAt: string;
  month: string;
  resetAt: string;
  providers: ResearchOddsProvider[];
  usage: ResearchOddsUsage[];
  events: ResearchOddsEvent[];
  plannedForecast: ResearchOddsForecast | null;
  limitations: string[];
  cache?: {
    window: 'last_90_days';
    hits: number;
    fetchReservations: number;
    hitRate: number | null;
  };
  configuredProviders?: Array<{
    provider: string;
    accountScope: string;
    configured: boolean;
    status: 'CONFIGURED_NOT_PROBED' | 'NOT_CONFIGURED';
    note: string;
  }>;
  fallback?: { status: 'UNAVAILABLE'; provider: string | null; reason: string };
}
