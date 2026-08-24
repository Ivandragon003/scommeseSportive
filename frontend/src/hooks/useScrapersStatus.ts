import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getOddsSnapshotStatus,
  getProviderHealth,
  getScraperStatus,
  getSystemHealth,
  getSystemMetrics,
  getUnderstatScraperInfo,
} from '../utils/api';
import {
  normalizeProviderHealth,
  normalizeSystemHealth,
  normalizeSystemMetrics,
} from '../utils/systemObservability';

interface ScrapersStatusState {
  scraperStatus: any;
  understatInfo: any;
  systemHealth: any;
  providerHealth: any;
  systemMetrics: any;
  remainingReq: number | null;
  oddsLastUpdatedAt: string | null;
  oddsMatches: any[];
}

const INITIAL_STATE: ScrapersStatusState = {
  scraperStatus: null,
  understatInfo: null,
  systemHealth: null,
  providerHealth: null,
  systemMetrics: null,
  remainingReq: null,
  oddsLastUpdatedAt: null,
  oddsMatches: [],
};

const normalizeOddsState = (data: any) => {
  const matches = Array.isArray(data?.matches) ? data.matches : [];
  const nextRemaining = Number(data?.remainingRequests);
  return {
    oddsMatches: matches,
    remainingReq: Number.isFinite(nextRemaining) && nextRemaining >= 0 ? nextRemaining : null,
    oddsLastUpdatedAt: typeof data?.lastUpdatedAt === 'string' && data.lastUpdatedAt ? data.lastUpdatedAt : null,
  };
};

export function useScrapersStatus() {
  const [state, setState] = useState<ScrapersStatusState>(INITIAL_STATE);
  const isUpdatingRef = useRef(false);

  // Source coverage is static metadata; fetch it once instead of including it in
  // the recurring operational poll.
  useEffect(() => {
    let active = true;
    void getUnderstatScraperInfo()
      .then((response) => {
        if (active) setState((current) => ({ ...current, understatInfo: response.data ?? null }));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  // Preserve the explicit initial diagnostics shown by the provider panel. The
  // recurring poll below uses the aggregated health payload instead.
  useEffect(() => {
    let active = true;
    void Promise.all([getProviderHealth(), getSystemMetrics()])
      .then(([providerHealthRes, systemMetricsRes]) => {
        if (!active) return;
        setState((current) => ({
          ...current,
          providerHealth: normalizeProviderHealth(providerHealthRes ?? {}),
          systemMetrics: normalizeSystemMetrics(systemMetricsRes ?? {}),
        }));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const applyOddsState = useCallback((data: any) => {
    setState((current) => ({
      ...current,
      ...normalizeOddsState(data),
    }));
  }, []);

  const refreshStatus = useCallback(async (options?: { force?: boolean }) => {
    try {
      // /system/health already aggregates provider health and system metrics.
      // Keep only the two payloads not represented there for the scraper UI.
      const [statusRes, oddsRes, systemHealthRes] = await Promise.all([
        getScraperStatus(options),
        getOddsSnapshotStatus(options),
        getSystemHealth(options),
      ]);
      const systemHealth = normalizeSystemHealth(systemHealthRes ?? {});
      isUpdatingRef.current = systemHealth.isUpdating;

      setState((current) => ({
        ...current,
        scraperStatus: statusRes.data ?? null,
        ...normalizeOddsState(oddsRes.data ?? null),
        systemHealth,
        providerHealth: systemHealth.providers.status === 'unknown' && current.providerHealth
          ? current.providerHealth
          : systemHealth.providers,
        systemMetrics: systemHealth.metrics.provider.requestsObserved === 0 && current.systemMetrics
          ? current.systemMetrics
          : systemHealth.metrics,
      }));
    } catch (error) {
      console.error('Failed to fetch scraper status:', error);
    }
  }, []);

  const refreshQuotePipeline = useCallback(async (options?: { force?: boolean }) => {
    try {
      const [statusRes, oddsRes, systemHealthRes] = await Promise.all([
        getScraperStatus(options),
        getOddsSnapshotStatus(options),
        getSystemHealth(options),
      ]);
      const systemHealth = normalizeSystemHealth(systemHealthRes ?? {});

      setState((current) => ({
        ...current,
        scraperStatus: statusRes.data ?? current.scraperStatus,
        ...normalizeOddsState(oddsRes.data ?? null),
        systemHealth,
        providerHealth: systemHealth.providers.status === 'unknown' && current.providerHealth
          ? current.providerHealth
          : systemHealth.providers,
        systemMetrics: systemHealth.metrics.provider.requestsObserved === 0 && current.systemMetrics
          ? current.systemMetrics
          : systemHealth.metrics,
      }));
    } catch (error) {
      console.error('Failed to refresh quote pipeline:', error);
    }
  }, []);

  const refreshProviderOnly = useCallback(async (options?: { force?: boolean }) => {
    const [providerHealthRes, systemHealthRes] = await Promise.all([
      getProviderHealth({ refresh: true, competition: 'Serie A' }, options),
      getSystemHealth(options),
    ]);

    setState((current) => ({
      ...current,
      providerHealth: normalizeSystemHealth({ data: { providers: providerHealthRes?.data ?? providerHealthRes } }).providers,
      systemHealth: normalizeSystemHealth(systemHealthRes ?? {}),
    }));
  }, []);

  useEffect(() => {
    let active = true;
    let timeout: number | undefined;
    let scheduleGeneration = 0;

    const clearScheduledRefresh = () => {
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
        timeout = undefined;
      }
    };

    const safeRefresh = async () => {
      if (document.hidden) return;
      await refreshStatus();
      if (!active) return;
    };

    const scheduleNext = () => {
      clearScheduledRefresh();
      const generation = ++scheduleGeneration;
      const intervalMs = document.hidden ? 60000 : (isUpdatingRef.current ? 5000 : 15000);
      timeout = window.setTimeout(async () => {
        if (!active || generation !== scheduleGeneration) return;
        await safeRefresh();
        if (active && generation === scheduleGeneration) scheduleNext();
      }, intervalMs);
    };

    void safeRefresh();
    scheduleNext();
    const onVisibilityChange = () => {
      if (!document.hidden) {
        scheduleGeneration += 1;
        clearScheduledRefresh();
        void safeRefresh().finally(() => { if (active) scheduleNext(); });
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      active = false;
      scheduleGeneration += 1;
      clearScheduledRefresh();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refreshStatus]);

  return {
    ...state,
    applyOddsState,
    refreshStatus,
    refreshQuotePipeline,
    refreshProviderOnly,
  };
}
