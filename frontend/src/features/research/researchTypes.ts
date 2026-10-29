export type ModelFamily = 'A' | 'C';
export type MarketState = 'EXPERIMENTAL' | 'SHADOW' | 'ACTIVE' | 'SUSPENDED';

export interface ResearchPortfolio {
  id: string;
  family: ModelFamily;
  initialCents: number;
  availableCents: number;
  committedCents: number;
  equityCents: number;
  profitCents: number;
  betCount?: number;
  settledCount?: number;
  openCount?: number;
  history?: Array<{ at: string; equityCents: number }>;
}

export interface ResearchBet {
  id: string;
  portfolioId: string;
  matchId: string;
  modelVersion: string;
  selection: string;
  stakeCents: number;
  odds: number;
  status: string;
  createdAt: string;
  settledAt?: string;
  profitCents?: number;
  quote?: { bookmaker?: string; source?: string; capturedAt?: string; updatedAt?: string; priceType?: string };
}

export interface ResearchModel {
  family: ModelFamily;
  version: string;
  status: string;
  createdAt: string;
  trainedThrough?: string;
  metrics?: Record<string, unknown>;
}

export interface ResearchMarket {
  family: ModelFamily;
  modelVersion: string;
  market: string;
  state: MarketState;
  evidence?: Record<string, unknown>;
  reason?: string;
}

export interface ResearchJob {
  id: string;
  matchId: string;
  kickoffAt: string;
  targetAt: string;
  status: string;
  reason?: string;
  updatedAt?: string;
}

export interface ResearchDecision {
  id: string;
  matchId: string;
  family: ModelFamily;
  modelVersion: string;
  action: 'BET' | 'ABSTAIN';
  selection?: string;
  market?: string;
  reason?: string;
  createdAt: string;
  probability?: number;
  inputId?: string;
  forecastAt?: string;
  probabilityStages?: {
    raw?: Record<string, number> | null;
    calibrated?: Record<string, number> | null;
    decision?: Record<string, number> | null;
  };
  quote?: ResearchBet['quote'] & { odds?: number };
  bookmakerProbabilities?: Record<string, { bookmaker: string; source: string; raw: number; noVig: number | null }>;
}

export interface ProbabilityMetrics {
  logLoss?: number | null;
  brier?: number | null;
  ece?: number | null;
  n?: number | null;
  calibration?: Array<{ predicted: number; observed: number; n: number }>;
}

export interface ResearchExperiment {
  id: string;
  createdAt: string;
  family: 'C';
  kind: string;
  featureGroup: string;
  runtimeCompatible: boolean;
  eligibleForPromotion: boolean;
  report: {
    id?: string;
    phase?: string;
    kind?: string;
    featureGroup?: string;
    hyperparameters?: unknown;
    history?: unknown;
    calibration?: unknown;
    metricsA?: ProbabilityMetrics;
    metricsC?: ProbabilityMetrics;
    pairedCI?: {
      logLoss?: [number, number] | null;
      brier?: [number, number] | null;
      weeklyLogLoss?: [number, number] | null;
      weeklyBrier?: [number, number] | null;
    };
    byLeague?: Record<string, { A?: ProbabilityMetrics; C?: ProbabilityMetrics }>;
    bySeason?: Record<string, { A?: ProbabilityMetrics; C?: ProbabilityMetrics }>;
    byMarket?: Record<string, { A?: ProbabilityMetrics; C?: ProbabilityMetrics }>;
    featureImportance?: Array<{
      feature: string;
      importance: number;
      permutationMean?: number;
      permutationStd?: number;
    }>;
    rejectionReasons?: string[];
  };
}

export interface ResearchModelEvent {
  family: ModelFamily;
  version: string;
  previousVersion?: string | null;
  action: 'PROMOTE' | 'ROLLBACK';
  reason: string;
  createdAt: string;
}

export interface ResearchDiagnostics {
  id: string;
  createdAt: string;
  report: {
    findings?: Array<{ severity: string; code: string; message: string }>;
    datasetAudit?: Record<string, unknown>;
    protection?: {
      protectedFinalCount?: number;
      originalReportHash?: string;
      newIndependentTestAvailable?: boolean;
    };
    recommendation?: string;
  };
}

export interface EconomicMetrics {
  initialCents?: number;
  finalCents?: number;
  profitCents?: number;
  roi?: number;
  maxDrawdown?: number;
  betCount?: number;
  winRate?: number;
  clv?: number;
  equity?: Array<{ at?: string; date?: string; equityCents?: number; value?: number }>;
}

export interface ComparisonBreakdown {
  label?: string;
  league?: string;
  competition?: string;
  market?: string;
  season?: string;
  A?: ProbabilityMetrics & EconomicMetrics;
  C?: ProbabilityMetrics & EconomicMetrics;
  n?: number;
}

export interface ResearchBenchmarkReport {
  summary?: string;
  probabilistic?: {
    A?: ProbabilityMetrics;
    C?: ProbabilityMetrics;
    bookmaker?: ProbabilityMetrics;
    paired?: Record<string, unknown>;
  };
  economic?: { A?: EconomicMetrics; C?: EconomicMetrics };
  byLeague?: ComparisonBreakdown[];
  byMarket?: ComparisonBreakdown[];
  bySeason?: ComparisonBreakdown[];
  byOddsBand?: ComparisonBreakdown[];
  decisionDifferences?: { same?: number; different?: number; onlyA?: number; onlyC?: number; neither?: number };
  conclusion?: string;
  warnings?: string[];
}

export interface ResearchOverview {
  baseline?: { version?: string; [key: string]: unknown };
  models: ResearchModel[];
  portfolios: ResearchPortfolio[];
  bets: ResearchBet[];
  markets: ResearchMarket[];
  jobs: ResearchJob[];
  decisions?: ResearchDecision[];
  experiments?: ResearchExperiment[];
  modelEvents?: ResearchModelEvent[];
  latestDiagnostics?: ResearchDiagnostics | null;
  dailySummary?: {
    day: string;
    timezone: string;
    portfolios: Array<{
      portfolioId: string;
      family: ModelFamily;
      registeredBets: number;
      settledBets: number;
      profitCents: number;
      portfolioDeltaCents: number;
      startEquityCents: number;
      endEquityCents: number;
      endAvailableCents: number;
      endCommittedCents: number;
    }>;
  };
  latestBenchmark: ({ id?: string; createdAt?: string; report?: ResearchBenchmarkReport } & ResearchBenchmarkReport) | null;
  status: {
    nightlyCreatesBets: boolean;
    legacyAutomationDisabled: boolean;
    schedulerEnabled: boolean | null;
    mode?: 'NIGHTLY_PRE_MATCH';
    schedulerState?: 'ACTIVE' | 'STOPPED' | 'STALE' | 'UNKNOWN' | 'DISABLED' | 'NOT_OBSERVED' | 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'MISSED';
    nightly?: {
      executionEnabled?: boolean | null;
      lastRun?: { startedAt?: string; endedAt?: string; success?: boolean; error?: string | null; summary?: { enabled?: boolean; [key: string]: unknown } } | null;
      expectedAt?: string | null;
      nextAt?: string | null;
      graceSeconds?: number;
      overdue?: boolean;
      metrics?: {
        analyzedMatches?: number | null; registeredBets?: number | null; skippedMatches?: number | null;
        missedMatches?: number | null; errors?: number | null; apiErrors?: number | null;
        settlement?: { checked?: number | null; settled?: number | null; unresolved?: number | null } | null;
        reasonCounts?: Record<string, number> | null;
      };
    };
    heartbeatAt?: string | null;
    toleranceSeconds: number | null;
    training?: { lastAt?: string; status?: string; nextAt?: string; lastPromotionAt?: string; lastRollbackAt?: string; [key: string]: unknown };
    blockers: string[];
    deployment: string;
    lastNightlyAt?: string | null;
    providerStatus?: string;
    quotesFreshThrough?: string | null;
    automationScope?: 'local_code';
    remoteVerification?: 'not_verified_from_backend';
    apiQuota?: {
      remaining?: number | null;
      used?: number | null;
      lastCost?: number | null;
      observedAt?: string | null;
    } | null;
    lastDataUpdateAt?: string | null;
    dbStatus?: string | null;
    lastProviderAt?: string | null;
    lastValidationAt?: string | null;
    lastPromotionAt?: string | null;
    lastRollbackAt?: string | null;
  };
  notifications: Array<{ id?: string; title?: string; message?: string; createdAt?: string; level?: string; kind?: string }>;
}
