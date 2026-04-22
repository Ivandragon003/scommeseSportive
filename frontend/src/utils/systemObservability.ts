export type NormalizedProviderHealth = {
  status: string;
  primaryProvider: string;
  fallbackProvider: string | null;
  activeProvider: string | null;
  oddsSource: string | null;
  fallbackReason: string | null;
  providerHealth: Record<string, { status: string; checkedAt?: string | null; message?: string | null }>;
  fetchedAt: string | null;
  matchCount: number;
  matchesWithBaseOdds: number;
  matchesWithExtendedGroups: number;
  marketCount: number;
  durationMs: number | null;
  errorCategory: string | null;
  warnings: string[];
  warningCount: number;
  isMerged: boolean;
  freshnessMinutes: number | null;
  lastSmokeRun: {
    origin: string;
    competition: string;
    generatedAt: string | null;
    freshnessMinutes: number | null;
    severity: string;
    success: boolean;
    errorCategory: string | null;
    sourceUsed: string | null;
    matchesFound: number;
    matchesWithBaseOdds: number;
    matchesWithExtendedGroups: number;
    durationMs: number | null;
    warnings: string[];
  } | null;
};

export type NormalizedSystemMetrics = {
  provider: {
    eurobetSuccessRatePct: number;
    fallbackRatePct: number;
    fixtureMatchRatePct: number;
    avgScrapeLatencyMs: number | null;
    avgMarketsFound: number | null;
    requestsObserved: number;
  };
  sync: {
    successRatePct: number;
    lastOutcome: {
      component: string;
      success: boolean;
      startedAt: string | null;
      durationMs: number | null;
      errorCategory: string | null;
    } | null;
    runsObserved: number;
  };
  trends: {
    warningRuns: number;
    errorRuns: number;
    topErrorCategories: Array<{ category: string; count: number }>;
  };
};

export type NormalizedSystemHealth = {
  status: string;
  isUpdating: boolean;
  lastUpdate: { at: string | null; success: boolean; message: string } | null;
  freshness: {
    lastUnderstatSyncAt: string | null;
    understatFreshnessMinutes: number | null;
    lastProviderFetchAt: string | null;
    providerFreshnessMinutes: number | null;
  };
  providers: NormalizedProviderHealth;
  metrics: NormalizedSystemMetrics;
  issues: Array<{ scope: string; severity: string; message: string; errorCategory?: string | null }>;
};

export type NormalizedRecentRuns = {
  count: number;
  runs: Array<{
    runId: number | string;
    kind: string;
    component: string;
    status: string;
    startedAt: string | null;
    durationMs: number | null;
    errorCategory: string | null;
    warningCount: number;
    provider?: string | null;
    competition?: string | null;
    matchCount?: number | null;
    sourceUsed?: string | null;
  }>;
};

const num = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const nullableNum = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

export const normalizeProviderHealth = (payload: any): NormalizedProviderHealth => {
  const data = record(payload?.data ?? payload);
  const providerHealth = record(data.providerHealth);
  const lastSmokeRun = data.lastSmokeRun && typeof data.lastSmokeRun === 'object'
    ? {
      origin: String(data.lastSmokeRun.origin ?? 'local_artifact'),
      competition: String(data.lastSmokeRun.competition ?? ''),
      generatedAt: data.lastSmokeRun.generatedAt ? String(data.lastSmokeRun.generatedAt) : null,
      freshnessMinutes: nullableNum(data.lastSmokeRun.freshnessMinutes),
      severity: String(data.lastSmokeRun.severity ?? 'unknown'),
      success: Boolean(data.lastSmokeRun.success),
      errorCategory: data.lastSmokeRun.errorCategory ? String(data.lastSmokeRun.errorCategory) : null,
      sourceUsed: data.lastSmokeRun.sourceUsed ? String(data.lastSmokeRun.sourceUsed) : null,
      matchesFound: num(data.lastSmokeRun.matchesFound),
      matchesWithBaseOdds: num(data.lastSmokeRun.matchesWithBaseOdds),
      matchesWithExtendedGroups: num(data.lastSmokeRun.matchesWithExtendedGroups),
      durationMs: nullableNum(data.lastSmokeRun.durationMs),
      warnings: Array.isArray(data.lastSmokeRun.warnings) ? data.lastSmokeRun.warnings.map(String) : [],
    }
    : null;
  const normalizedProviderHealth = Object.fromEntries(
    Object.entries(providerHealth).map(([key, provider]) => [
      key,
      {
        status: String(provider?.status ?? 'unknown'),
        checkedAt: provider?.checkedAt ? String(provider.checkedAt) : null,
        message: provider?.message ? String(provider.message) : null,
      },
    ])
  );

  return {
    status: String(data.status ?? 'unknown'),
    primaryProvider: String(data.primaryProvider ?? 'eurobet'),
    fallbackProvider: data.fallbackProvider ? String(data.fallbackProvider) : null,
    activeProvider: data.activeProvider ? String(data.activeProvider) : null,
    oddsSource: data.oddsSource ? String(data.oddsSource) : null,
    fallbackReason: data.fallbackReason ? String(data.fallbackReason) : null,
    providerHealth: normalizedProviderHealth,
    fetchedAt: data.fetchedAt ? String(data.fetchedAt) : null,
    matchCount: num(data.matchCount),
    matchesWithBaseOdds: num(data.matchesWithBaseOdds),
    matchesWithExtendedGroups: num(data.matchesWithExtendedGroups),
    marketCount: num(data.marketCount),
    durationMs: nullableNum(data.durationMs),
    errorCategory: data.errorCategory ? String(data.errorCategory) : null,
    warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [],
    warningCount: num(data.warningCount),
    isMerged: Boolean(data.isMerged),
    freshnessMinutes: nullableNum(data.freshnessMinutes),
    lastSmokeRun,
  };
};

export const normalizeSystemMetrics = (payload: any): NormalizedSystemMetrics => {
  const data = record(payload?.data ?? payload);
  const provider = record(data.provider);
  const sync = record(data.sync);
  const trends = record(data.trends);
  const lastOutcome = sync.lastOutcome && typeof sync.lastOutcome === 'object'
    ? {
      component: String(sync.lastOutcome.component ?? ''),
      success: Boolean(sync.lastOutcome.success),
      startedAt: sync.lastOutcome.startedAt ? String(sync.lastOutcome.startedAt) : null,
      durationMs: nullableNum(sync.lastOutcome.durationMs),
      errorCategory: sync.lastOutcome.errorCategory ? String(sync.lastOutcome.errorCategory) : null,
    }
    : null;

  return {
    provider: {
      eurobetSuccessRatePct: num(provider.eurobetSuccessRatePct),
      fallbackRatePct: num(provider.fallbackRatePct),
      fixtureMatchRatePct: num(provider.fixtureMatchRatePct),
      avgScrapeLatencyMs: nullableNum(provider.avgScrapeLatencyMs),
      avgMarketsFound: nullableNum(provider.avgMarketsFound),
      requestsObserved: num(provider.requestsObserved),
    },
    sync: {
      successRatePct: num(sync.successRatePct),
      lastOutcome,
      runsObserved: num(sync.runsObserved),
    },
    trends: {
      warningRuns: num(trends.warningRuns),
      errorRuns: num(trends.errorRuns),
      topErrorCategories: Array.isArray(trends.topErrorCategories)
        ? trends.topErrorCategories.map((item: any) => ({
          category: String(item?.category ?? ''),
          count: num(item?.count),
        }))
        : [],
    },
  };
};

export const normalizeRecentRuns = (payload: any): NormalizedRecentRuns => {
  const data = record(payload?.data ?? payload);
  const runs = Array.isArray(data.runs) ? data.runs : [];

  return {
    count: num(data.count, runs.length),
    runs: runs.map((run: any) => ({
      runId: run?.runId ?? `${String(run?.kind ?? 'run')}-${String(run?.startedAt ?? '')}`,
      kind: String(run?.kind ?? run?.runType ?? 'unknown'),
      component: String(run?.component ?? run?.schedulerName ?? 'unknown'),
      status: String(run?.status ?? (run?.success ? 'ok' : 'error')),
      startedAt: run?.startedAt ? String(run.startedAt) : null,
      durationMs: nullableNum(run?.durationMs),
      errorCategory: run?.errorCategory ? String(run.errorCategory) : null,
      warningCount: num(run?.warningCount),
      provider: run?.provider ? String(run.provider) : null,
      competition: run?.competition ? String(run.competition) : null,
      matchCount: nullableNum(run?.matchCount),
      sourceUsed: run?.sourceUsed ? String(run.sourceUsed) : null,
    })),
  };
};

export const normalizeSystemHealth = (payload: any): NormalizedSystemHealth => {
  const data = record(payload?.data ?? payload);

  return {
    status: String(data.status ?? 'unknown'),
    isUpdating: Boolean(data.isUpdating),
    lastUpdate: data.lastUpdate
      ? {
        at: data.lastUpdate.at ? String(data.lastUpdate.at) : null,
        success: Boolean(data.lastUpdate.success),
        message: String(data.lastUpdate.message ?? ''),
      }
      : null,
    freshness: {
      lastUnderstatSyncAt: data.freshness?.lastUnderstatSyncAt ? String(data.freshness.lastUnderstatSyncAt) : null,
      understatFreshnessMinutes: nullableNum(data.freshness?.understatFreshnessMinutes),
      lastProviderFetchAt: data.freshness?.lastProviderFetchAt ? String(data.freshness.lastProviderFetchAt) : null,
      providerFreshnessMinutes: nullableNum(data.freshness?.providerFreshnessMinutes),
    },
    providers: normalizeProviderHealth(data.providers ?? {}),
    metrics: normalizeSystemMetrics(data.metrics ?? {}),
    issues: Array.isArray(data.issues)
      ? data.issues.map((issue: any) => ({
        scope: String(issue?.scope ?? 'unknown'),
        severity: String(issue?.severity ?? 'warning'),
        message: String(issue?.message ?? ''),
        errorCategory: issue?.errorCategory ? String(issue.errorCategory) : null,
      }))
      : [],
  };
};
