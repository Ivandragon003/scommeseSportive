import { DatabaseService } from '../db/DatabaseService';

type StructuredLogLevel = 'info' | 'warn' | 'error';
type SystemRunType = 'provider_fetch' | 'sync' | 'health_check';

export type ProviderRunRecord = {
  requestId?: string | null;
  runId: string;
  provider: string;
  competition?: string | null;
  meetingAlias?: string | null;
  sourceUsed?: string | null;
  matchCount?: number | null;
  marketCount?: number | null;
  fixtureCount?: number | null;
  matchesWithBaseOdds?: number | null;
  matchesWithExtendedGroups?: number | null;
  durationMs?: number | null;
  success: boolean;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  warningCount?: number | null;
  warnings?: string[];
  errorCategory?: string | null;
  providerHealth?: Record<string, any> | null;
  metadata?: Record<string, unknown> | null;
  startedAt: string;
  endedAt?: string | null;
};

export type SyncRunRecord = {
  requestId?: string | null;
  runId: string;
  component: 'understat_scheduler' | 'odds_scheduler' | 'learning_scheduler' | 'boot_sync';
  provider?: string | null;
  competition?: string | null;
  matchCount?: number | null;
  marketCount?: number | null;
  durationMs?: number | null;
  success: boolean;
  warningCount?: number | null;
  warnings?: string[];
  errorCategory?: string | null;
  metadata?: Record<string, unknown> | null;
  startedAt: string;
  endedAt?: string | null;
};

export type ProviderSnapshot = {
  runId: string;
  requestId: string | null;
  provider: string;
  competition: string | null;
  meetingAlias: string | null;
  sourceUsed: string | null;
  matchCount: number;
  marketCount: number;
  fixtureCount: number;
  matchesWithBaseOdds: number;
  matchesWithExtendedGroups: number;
  durationMs: number | null;
  success: boolean;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  warningCount: number;
  warnings: string[];
  errorCategory: string | null;
  providerHealth: Record<string, any>;
  metadata: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
  fetchedAt: string;
};

const MAX_RECENT_RUNS = 200;

const nowIso = (): string => new Date().toISOString();

const safeNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const average = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const percent = (value: number, total: number): number => {
  if (total <= 0) return 0;
  return Number(((value / total) * 100).toFixed(1));
};

const minutesSince = (value?: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / 60000));
};

const detectErrorCategoryFromText = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('resolve_meeting_alias_failed')) return 'resolve_meeting_alias_failed';
  if (normalized.includes('meeting_json_failed')) return 'meeting_json_failed';
  if (normalized.includes('non_json_response')) return 'non_json_response';
  if (normalized.includes('html_or_captcha')) return 'html_or_captcha';
  if (normalized.includes('cookie_or_spa_dom_issue')) return 'cookie_or_spa_dom_issue';
  if (normalized.includes('parsing_zero_markets')) return 'parsing_zero_markets';
  if (normalized.includes('fixture_matching_failed')) return 'fixture_matching_failed';
  if (normalized.includes('extended_groups_failed')) return 'extended_groups_failed';
  if (normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('captcha') || normalized.includes('cloudflare') || normalized.includes('html')) {
    return 'html_or_captcha';
  }
  if (normalized.includes('json')) return 'non_json_response';
  return null;
};

export class SystemObservabilityService {
  private lastProviderSnapshot: ProviderSnapshot | null = null;

  constructor(private readonly db: DatabaseService) {}

  createRunId(prefix: string): string {
    const compactPrefix = String(prefix ?? 'run').trim().replace(/[^a-z0-9_-]+/gi, '_');
    return `${compactPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  log(level: StructuredLogLevel, event: string, fields: Record<string, unknown>): void {
    const payload = {
      timestamp: nowIso(),
      level,
      event,
      ...fields,
    };
    const line = JSON.stringify(payload);
    if (level === 'error') {
      console.error(line);
      return;
    }
    if (level === 'warn') {
      console.warn(line);
      return;
    }
    console.info(line);
  }

  async recordProviderRun(entry: ProviderRunRecord): Promise<void> {
    const warningCount = entry.warningCount ?? entry.warnings?.length ?? 0;
    const endedAt = entry.endedAt ?? nowIso();
    const errorCategory =
      entry.errorCategory
      ?? detectErrorCategoryFromText(entry.fallbackReason)
      ?? detectErrorCategoryFromText(entry.warnings?.join(' | '))
      ?? detectErrorCategoryFromText(this.extractProviderHealthMessage(entry.providerHealth))
      ?? null;

    const metadata = {
      ...(entry.metadata ?? {}),
      fallbackReason: entry.fallbackReason ?? null,
      providerHealth: entry.providerHealth ?? {},
    };

    this.lastProviderSnapshot = {
      runId: entry.runId,
      requestId: entry.requestId ?? null,
      provider: entry.provider,
      competition: entry.competition ?? null,
      meetingAlias: entry.meetingAlias ?? null,
      sourceUsed: entry.sourceUsed ?? null,
      matchCount: safeNumber(entry.matchCount, 0),
      marketCount: safeNumber(entry.marketCount, 0),
      fixtureCount: safeNumber(entry.fixtureCount, 0),
      matchesWithBaseOdds: safeNumber(entry.matchesWithBaseOdds, 0),
      matchesWithExtendedGroups: safeNumber(entry.matchesWithExtendedGroups, 0),
      durationMs: entry.durationMs ?? null,
      success: entry.success,
      fallbackUsed: Boolean(entry.fallbackUsed),
      fallbackReason: entry.fallbackReason ?? null,
      warningCount,
      warnings: entry.warnings ?? [],
      errorCategory,
      providerHealth: entry.providerHealth ?? {},
      metadata,
      startedAt: entry.startedAt,
      endedAt,
      fetchedAt: endedAt,
    };

    this.log(entry.success ? 'info' : 'error', 'provider_run', {
      requestId: entry.requestId ?? null,
      runId: entry.runId,
      provider: entry.provider,
      competition: entry.competition ?? null,
      meetingAlias: entry.meetingAlias ?? null,
      matchCount: safeNumber(entry.matchCount, 0),
      durationMs: entry.durationMs ?? null,
      errorCategory,
      fallbackUsed: Boolean(entry.fallbackUsed),
      sourceUsed: entry.sourceUsed ?? null,
      warningCount,
    });

    await this.db.saveSystemRun({
      runType: 'provider_fetch',
      component: `${entry.provider}_provider`,
      requestId: entry.requestId ?? null,
      externalRunId: entry.runId,
      provider: entry.provider,
      competition: entry.competition ?? null,
      meetingAlias: entry.meetingAlias ?? null,
      sourceUsed: entry.sourceUsed ?? null,
      matchCount: entry.matchCount ?? null,
      marketCount: entry.marketCount ?? null,
      fixtureCount: entry.fixtureCount ?? null,
      matchesWithBaseOdds: entry.matchesWithBaseOdds ?? null,
      matchesWithExtendedGroups: entry.matchesWithExtendedGroups ?? null,
      durationMs: entry.durationMs ?? null,
      success: entry.success,
      warningCount,
      fallbackUsed: Boolean(entry.fallbackUsed),
      errorCategory,
      warnings: entry.warnings ?? [],
      metadata,
      startedAt: entry.startedAt,
      endedAt,
    });
  }

  async recordSyncRun(entry: SyncRunRecord): Promise<void> {
    const warningCount = entry.warningCount ?? entry.warnings?.length ?? 0;
    const endedAt = entry.endedAt ?? nowIso();
    const errorCategory =
      entry.errorCategory
      ?? detectErrorCategoryFromText(entry.warnings?.join(' | '))
      ?? null;

    this.log(entry.success ? 'info' : 'error', 'sync_run', {
      requestId: entry.requestId ?? null,
      runId: entry.runId,
      provider: entry.provider ?? null,
      competition: entry.competition ?? null,
      meetingAlias: null,
      matchCount: entry.matchCount ?? null,
      durationMs: entry.durationMs ?? null,
      errorCategory,
      component: entry.component,
      warningCount,
    });

    await this.db.saveSystemRun({
      runType: 'sync',
      component: entry.component,
      requestId: entry.requestId ?? null,
      externalRunId: entry.runId,
      provider: entry.provider ?? null,
      competition: entry.competition ?? null,
      matchCount: entry.matchCount ?? null,
      marketCount: entry.marketCount ?? null,
      durationMs: entry.durationMs ?? null,
      success: entry.success,
      warningCount,
      fallbackUsed: false,
      errorCategory,
      warnings: entry.warnings ?? [],
      metadata: entry.metadata ?? null,
      startedAt: entry.startedAt,
      endedAt,
    });
  }

  getLastProviderSnapshot(): ProviderSnapshot | null {
    return this.lastProviderSnapshot;
  }

  async getProviderHealthPayload(): Promise<Record<string, unknown>> {
    const snapshot = this.lastProviderSnapshot ?? await this.loadLatestProviderSnapshot();
    const providerHealth = snapshot?.providerHealth ?? {};
    const fallbackProvider = providerHealth.odds_api ? 'odds_api' : null;
    const eurobetStatus = providerHealth.eurobet?.status ?? (snapshot?.provider === 'eurobet' && snapshot.success ? 'healthy' : 'unknown');
    const overallStatus =
      eurobetStatus === 'healthy'
        ? 'healthy'
        : snapshot?.fallbackUsed
          ? 'degraded'
          : eurobetStatus === 'unknown'
            ? 'unknown'
            : 'unhealthy';

    return {
      status: overallStatus,
      primaryProvider: 'eurobet',
      fallbackProvider,
      oddsSource: snapshot?.sourceUsed ?? null,
      fallbackReason: snapshot?.fallbackReason ?? null,
      providerHealth,
      fetchedAt: snapshot?.fetchedAt ?? null,
      matchCount: snapshot?.matchCount ?? 0,
      matchesWithBaseOdds: snapshot?.matchesWithBaseOdds ?? 0,
      matchesWithExtendedGroups: snapshot?.matchesWithExtendedGroups ?? 0,
      marketCount: snapshot?.marketCount ?? 0,
      durationMs: snapshot?.durationMs ?? null,
      errorCategory: snapshot?.errorCategory ?? null,
      warnings: snapshot?.warnings ?? [],
      warningCount: snapshot?.warningCount ?? 0,
      isMerged: snapshot?.sourceUsed?.includes('+') ?? false,
      freshnessMinutes: minutesSince(snapshot?.fetchedAt ?? null),
    };
  }

  async getMetricsPayload(): Promise<Record<string, unknown>> {
    const recentRuns = await this.db.listRecentSystemRuns(MAX_RECENT_RUNS);
    const providerRuns = recentRuns.filter((run) => run.runType === 'provider_fetch');
    const syncRuns = recentRuns.filter((run) => run.runType === 'sync');
    const eurobetObservedRuns = providerRuns.filter((run) => {
      const providerHealth = run?.metadata?.providerHealth ?? {};
      return run.provider === 'eurobet' || providerHealth.eurobet !== undefined;
    });
    const eurobetSuccessfulRuns = eurobetObservedRuns.filter((run) => {
      const status = run?.metadata?.providerHealth?.eurobet?.status;
      if (status) return status === 'healthy' || status === 'degraded';
      return run.success === true && run.fallbackUsed === false;
    });
    const fixtureRuns = providerRuns.filter((run) => safeNumber(run.fixtureCount, 0) > 0);
    const matchedFixtures = fixtureRuns.reduce(
      (sum, run) => sum + Math.min(safeNumber(run.matchCount, 0), safeNumber(run.fixtureCount, 0)),
      0
    );
    const requestedFixtures = fixtureRuns.reduce((sum, run) => sum + safeNumber(run.fixtureCount, 0), 0);
    const avgScrapeLatency = average(
      providerRuns
        .map((run) => (run.durationMs === null ? null : Number(run.durationMs)))
        .filter((value): value is number => value !== null && Number.isFinite(value))
    );
    const avgMarketsFound = average(
      providerRuns
        .map((run) => (run.marketCount === null ? null : Number(run.marketCount)))
        .filter((value): value is number => value !== null && Number.isFinite(value))
    );
    const latestSyncRun = syncRuns[0] ?? null;
    const errorCategories = recentRuns.reduce((acc, run) => {
      const key = String(run.errorCategory ?? '').trim();
      if (!key) return acc;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const topErrorCategories = Object.entries(errorCategories)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 5)
      .map(([category, count]) => ({ category, count }));
    const warningRuns = recentRuns.filter((run) => safeNumber(run.warningCount, 0) > 0).length;
    const errorRuns = recentRuns.filter((run) => run.success === false).length;

    return {
      generatedAt: nowIso(),
      provider: {
        eurobetSuccessRatePct: percent(eurobetSuccessfulRuns.length, eurobetObservedRuns.length),
        fallbackRatePct: percent(providerRuns.filter((run) => Boolean(run.fallbackUsed)).length, providerRuns.length),
        fixtureMatchRatePct: percent(matchedFixtures, requestedFixtures),
        avgScrapeLatencyMs: avgScrapeLatency === null ? null : Math.round(avgScrapeLatency),
        avgMarketsFound: avgMarketsFound === null ? null : Number(avgMarketsFound.toFixed(1)),
        requestsObserved: providerRuns.length,
      },
      sync: {
        successRatePct: percent(syncRuns.filter((run) => run.success).length, syncRuns.length),
        lastOutcome: latestSyncRun
          ? {
            component: latestSyncRun.component,
            success: latestSyncRun.success,
            startedAt: latestSyncRun.startedAt,
            durationMs: latestSyncRun.durationMs,
            errorCategory: latestSyncRun.errorCategory,
          }
          : null,
        runsObserved: syncRuns.length,
      },
      trends: {
        warningRuns,
        errorRuns,
        topErrorCategories,
      },
    };
  }

  async getRecentRunsPayload(limit = 20, schedulerRuns: any[] = []): Promise<Record<string, unknown>> {
    const systemRuns = await this.db.listRecentSystemRuns(limit);
    const normalizedSystemRuns = systemRuns.map((run) => ({
      ...run,
      kind: run.runType,
      status: run.success ? 'ok' : 'error',
    }));
    const normalizedSchedulerRuns = schedulerRuns.map((run) => ({
      runId: run.runId,
      kind: 'scheduler',
      status: run.success ? 'ok' : 'error',
      component: run.schedulerName,
      schedulerName: run.schedulerName,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.durationMs,
      errorCategory: run.success ? null : 'sync_failed',
      warningCount: 0,
      success: run.success,
      summary: run.summary ?? null,
      error: run.error ?? null,
    }));
    const combined = [...normalizedSystemRuns, ...normalizedSchedulerRuns]
      .sort((a, b) => Date.parse(String(b.startedAt ?? 0)) - Date.parse(String(a.startedAt ?? 0)))
      .slice(0, limit);

    return {
      generatedAt: nowIso(),
      count: combined.length,
      runs: combined,
    };
  }

  async getSystemHealthPayload(input: {
    isUpdating: boolean;
    lastUpdate: { at: Date; success: boolean; message: string } | null;
    schedulers: {
      understat: any;
      odds: any;
      learning: any;
    };
    recentSchedulerRuns?: any[];
  }): Promise<Record<string, unknown>> {
    const providerHealth = await this.getProviderHealthPayload();
    const metrics = await this.getMetricsPayload();
    const issues: Array<{ scope: string; severity: 'warning' | 'error'; message: string; errorCategory?: string | null }> = [];
    const lastUpdateAt = input.lastUpdate?.at ? new Date(input.lastUpdate.at).toISOString() : null;
    const lastUnderstatSyncAt = input.schedulers.understat?.lastRunAt
      ? new Date(input.schedulers.understat.lastRunAt).toISOString()
      : lastUpdateAt;
    const freshnessMinutes = minutesSince(lastUnderstatSyncAt);

    if (input.schedulers.understat?.lastError) {
      issues.push({
        scope: 'sync',
        severity: 'error',
        message: String(input.schedulers.understat.lastError),
        errorCategory: 'sync_failed',
      });
    }
    if (input.schedulers.odds?.lastError) {
      issues.push({
        scope: 'provider',
        severity: 'warning',
        message: String(input.schedulers.odds.lastError),
        errorCategory: 'sync_failed',
      });
    }
    if (input.schedulers.learning?.lastError) {
      issues.push({
        scope: 'learning',
        severity: 'warning',
        message: String(input.schedulers.learning.lastError),
        errorCategory: 'sync_failed',
      });
    }
    if ((providerHealth.status === 'unhealthy' || providerHealth.status === 'degraded') && providerHealth.errorCategory) {
      issues.push({
        scope: 'provider',
        severity: providerHealth.status === 'unhealthy' ? 'error' : 'warning',
        message: String(providerHealth.fallbackReason ?? providerHealth.errorCategory),
        errorCategory: String(providerHealth.errorCategory ?? ''),
      });
    }
    if (freshnessMinutes !== null && freshnessMinutes > 24 * 60) {
      issues.push({
        scope: 'freshness',
        severity: 'warning',
        message: `Ultimo sync dati principale fermo da ${freshnessMinutes} minuti.`,
        errorCategory: 'stale_data',
      });
    }

    const status =
      issues.some((issue) => issue.severity === 'error')
        ? 'unhealthy'
        : issues.length > 0 || input.isUpdating
          ? 'degraded'
          : 'healthy';

    return {
      generatedAt: nowIso(),
      status,
      isUpdating: input.isUpdating,
      lastUpdate: input.lastUpdate
        ? {
          at: lastUpdateAt,
          success: input.lastUpdate.success,
          message: input.lastUpdate.message,
        }
        : null,
      freshness: {
        lastUnderstatSyncAt,
        understatFreshnessMinutes: freshnessMinutes,
        lastProviderFetchAt: providerHealth.fetchedAt,
        providerFreshnessMinutes: providerHealth.freshnessMinutes,
      },
      providers: providerHealth,
      schedulers: input.schedulers,
      metrics,
      issues,
    };
  }

  private extractProviderHealthMessage(providerHealth?: Record<string, any> | null): string | null {
    if (!providerHealth) return null;
    for (const provider of Object.values(providerHealth)) {
      const message = typeof provider?.message === 'string' ? provider.message : null;
      if (message) return message;
    }
    return null;
  }

  private async loadLatestProviderSnapshot(): Promise<ProviderSnapshot | null> {
    const latest = await this.db.listRecentSystemRuns(1, { runType: 'provider_fetch' });
    const run = latest[0];
    if (!run) return null;

    return {
      runId: run.externalRunId ?? String(run.runId ?? ''),
      requestId: run.requestId ?? null,
      provider: run.provider ?? 'eurobet',
      competition: run.competition ?? null,
      meetingAlias: run.meetingAlias ?? null,
      sourceUsed: run.sourceUsed ?? null,
      matchCount: safeNumber(run.matchCount, 0),
      marketCount: safeNumber(run.marketCount, 0),
      fixtureCount: safeNumber(run.fixtureCount, 0),
      matchesWithBaseOdds: safeNumber(run.matchesWithBaseOdds, 0),
      matchesWithExtendedGroups: safeNumber(run.matchesWithExtendedGroups, 0),
      durationMs: run.durationMs ?? null,
      success: Boolean(run.success),
      fallbackUsed: Boolean(run.fallbackUsed),
      fallbackReason: run.metadata?.fallbackReason ? String(run.metadata.fallbackReason) : null,
      warningCount: safeNumber(run.warningCount, 0),
      warnings: Array.isArray(run.warnings) ? run.warnings.map(String) : [],
      errorCategory: run.errorCategory ?? null,
      providerHealth: run.metadata?.providerHealth ?? {},
      metadata: run.metadata ?? {},
      startedAt: run.startedAt ?? nowIso(),
      endedAt: run.endedAt ?? null,
      fetchedAt: run.endedAt ?? run.startedAt ?? nowIso(),
    };
  }
}
