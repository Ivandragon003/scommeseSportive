import { useCallback, useEffect, useState } from 'react';
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

  const applyOddsState = useCallback((data: any) => {
    setState((current) => ({
      ...current,
      ...normalizeOddsState(data),
    }));
  }, []);

  const refreshStatus = useCallback(async (options?: { force?: boolean }) => {
    try {
      const [statusRes, infoRes, oddsRes, systemHealthRes, providerHealthRes, systemMetricsRes] = await Promise.all([
        getScraperStatus(options),
        getUnderstatScraperInfo(options),
        getOddsSnapshotStatus(options),
        getSystemHealth(options),
        getProviderHealth(undefined, options),
        getSystemMetrics(options),
      ]);

      setState((current) => ({
        ...current,
        scraperStatus: statusRes.data ?? null,
        understatInfo: infoRes.data ?? null,
        ...normalizeOddsState(oddsRes.data ?? null),
        systemHealth: normalizeSystemHealth(systemHealthRes ?? {}),
        providerHealth: normalizeProviderHealth(providerHealthRes ?? {}),
        systemMetrics: normalizeSystemMetrics(systemMetricsRes ?? {}),
      }));
    } catch (error) {
      console.error('Failed to fetch scraper status:', error);
    }
  }, []);

  const refreshQuotePipeline = useCallback(async (options?: { force?: boolean }) => {
    try {
      const [statusRes, oddsRes, systemHealthRes, providerHealthRes, systemMetricsRes] = await Promise.all([
        getScraperStatus(options),
        getOddsSnapshotStatus(options),
        getSystemHealth(options),
        getProviderHealth(undefined, options),
        getSystemMetrics(options),
      ]);

      setState((current) => ({
        ...current,
        scraperStatus: statusRes.data ?? current.scraperStatus,
        ...normalizeOddsState(oddsRes.data ?? null),
        systemHealth: normalizeSystemHealth(systemHealthRes ?? {}),
        providerHealth: normalizeProviderHealth(providerHealthRes ?? {}),
        systemMetrics: normalizeSystemMetrics(systemMetricsRes ?? {}),
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
      providerHealth: normalizeProviderHealth(providerHealthRes ?? {}),
      systemHealth: normalizeSystemHealth(systemHealthRes ?? {}),
    }));
  }, []);

  useEffect(() => {
    let active = true;

    const safeRefresh = async () => {
      await refreshStatus();
      if (!active) return;
    };

    void safeRefresh();
    const interval = window.setInterval(() => {
      void safeRefresh();
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(interval);
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
