import { useCallback, useEffect, useState } from 'react';
import {
  getBets,
  getBudget,
  getMatchesCount,
  getProviderHealth,
  getRecentSystemRuns,
  getScraperStatus,
  getSystemAnalytics,
  getSystemHealth,
  getSystemMetrics,
} from '../utils/api';
import {
  normalizeProviderHealth,
  normalizeRecentRuns,
  normalizeSystemHealth,
  normalizeSystemMetrics,
} from '../utils/systemObservability';

interface DashboardDataState {
  budget: any;
  recentBets: any[];
  matchCount: number;
  analytics: any;
  scraperStatus: any;
  systemHealth: any;
  providerHealth: any;
  systemMetrics: any;
  recentSystemRuns: any;
  refreshing: boolean;
  showInit: boolean;
}

const INITIAL_STATE: DashboardDataState = {
  budget: null,
  recentBets: [],
  matchCount: 0,
  analytics: null,
  scraperStatus: null,
  systemHealth: null,
  providerHealth: null,
  systemMetrics: null,
  recentSystemRuns: null,
  refreshing: false,
  showInit: false,
};

export function useDashboardData(activeUser: string) {
  const [state, setState] = useState<DashboardDataState>(INITIAL_STATE);

  const loadData = useCallback(async (options?: { force?: boolean }) => {
    setState((current) => ({ ...current, refreshing: true }));

    const [budgetRes, betsRes, matchesCountRes, analyticsRes, scraperStatusRes, systemHealthRes, providerHealthRes, systemMetricsRes, recentRunsRes] =
      await Promise.allSettled([
        getBudget(activeUser),
        getBets(activeUser),
        getMatchesCount(undefined, options),
        getSystemAnalytics({ userId: activeUser }, options),
        getScraperStatus(options),
        getSystemHealth(options),
        getProviderHealth(undefined, options),
        getSystemMetrics(options),
        getRecentSystemRuns(12, options),
      ]);

    setState({
      budget: budgetRes.status === 'fulfilled' ? (budgetRes.value.data ?? null) : null,
      recentBets: betsRes.status === 'fulfilled' ? (betsRes.value.data ?? []).slice(0, 5) : [],
      matchCount: matchesCountRes.status === 'fulfilled' ? (matchesCountRes.value.count ?? 0) : 0,
      analytics: analyticsRes.status === 'fulfilled' ? (analyticsRes.value.data ?? null) : null,
      scraperStatus: scraperStatusRes.status === 'fulfilled' ? (scraperStatusRes.value.data ?? null) : null,
      systemHealth: systemHealthRes.status === 'fulfilled' ? normalizeSystemHealth(systemHealthRes.value) : null,
      providerHealth: providerHealthRes.status === 'fulfilled' ? normalizeProviderHealth(providerHealthRes.value) : null,
      systemMetrics: systemMetricsRes.status === 'fulfilled' ? normalizeSystemMetrics(systemMetricsRes.value) : null,
      recentSystemRuns: recentRunsRes.status === 'fulfilled' ? normalizeRecentRuns(recentRunsRes.value) : null,
      refreshing: false,
      showInit: !(budgetRes.status === 'fulfilled' && budgetRes.value.data),
    });
  }, [activeUser]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const onSyncDone = () => {
      void loadData({ force: true });
    };
    window.addEventListener('data-sync-complete', onSyncDone);
    return () => window.removeEventListener('data-sync-complete', onSyncDone);
  }, [loadData]);

  return {
    ...state,
    loadData,
    setBudget: (budget: any) => setState((current) => ({ ...current, budget })),
    setShowInit: (showInit: boolean) => setState((current) => ({ ...current, showInit })),
  };
}
