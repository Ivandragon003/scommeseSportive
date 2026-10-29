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

export interface NightlyDemandScenario {
  availableCredits?: number | null;
  admittedCredits?: number | null;
  admittedHttpRequests?: number | null;
  admittedGroups?: number | null;
  skippedGroups?: number | null;
  assumedCoveredFixtures?: number | null;
  skippedFixtures?: number | null;
  fractionOfObservedCalendar?: number | null;
  claim?: string;
}

export interface ResearchOddsForecast {
  kind: 'offline_remaining_nightly_calendar_projection';
  mode: 'NIGHTLY';
  scope: 'remaining_scheduled_nightly_runs_in_current_utc_month';
  enabled?: boolean;
  month: string;
  asOf: string;
  through: string;
  throughExclusive: boolean;
  nextScheduledAt?: string | null;
  calendarFixtures: number;
  competitionNightlyGroups?: number | null;
  baseCredits?: number | null;
  retryCreditAllowance?: number | null;
  estimatedCredits: number;
  estimatedHttpRequests: number;
  projectedTotalCredits: number;
  completeCalendarVerified: boolean;
  futureKickoffsVerified: boolean;
  measuredQuota: number | null;
  assumptions: {
    markets?: string[];
    regionCount?: number;
    retryRate?: number;
    retryGroups?: number;
    sharedByModels?: string[];
    scheduleTimezone?: string;
    accountingTimezone?: string;
    hour?: number;
    minute?: number;
    windowHours?: number | null;
    window?: string;
    retryScope?: string;
    note?: string;
  };
  budget?: {
    monthlyLimit?: number;
    reserveCredits?: number;
    ordinaryMonthlyLimit?: number;
    essentialMonthlyLimit?: number;
    usedCredits?: number;
    availableCredits?: number;
    availableSource?: string;
    nightlyPriority?: string;
    reservePolicy?: string;
  };
  ordinaryScenario?: NightlyDemandScenario;
  essentialScenario?: NightlyDemandScenario;
  exclusions?: Record<string, number>;
  groups?: Array<{ competition: string; decisionAt: string; windowEndAt: string; fixtureCount: number; retryAllowance: boolean; estimatedCredits: number }>;
  limitations?: string[];
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
