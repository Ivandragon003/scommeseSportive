import axios, { AxiosRequestConfig } from 'axios';

const API = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  count?: number;
}

export interface ReadRequestOptions {
  force?: boolean;
  cacheMs?: number;
}

type CacheMatcher = string | RegExp | ((key: string) => boolean);

const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const inFlightGetRequests = new Map<string, Promise<unknown>>();

const stableSerialize = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nestedValue]) => `${key}:${stableSerialize(nestedValue)}`).join(',')}}`;
  }
  return String(value);
};

const buildGetRequestKey = (url: string, config?: AxiosRequestConfig) =>
  `GET:${url}:${stableSerialize(config?.params ?? null)}`;

const matchesCacheKey = (key: string, matcher: CacheMatcher) => {
  if (typeof matcher === 'string') return key.includes(matcher);
  if (matcher instanceof RegExp) return matcher.test(key);
  return matcher(key);
};

export const invalidateApiCache = (matcher?: CacheMatcher) => {
  if (!matcher) {
    responseCache.clear();
    inFlightGetRequests.clear();
    return;
  }

  for (const key of Array.from(responseCache.keys())) {
    if (matchesCacheKey(key, matcher)) {
      responseCache.delete(key);
    }
  }

  for (const key of Array.from(inFlightGetRequests.keys())) {
    if (matchesCacheKey(key, matcher)) {
      inFlightGetRequests.delete(key);
    }
  }
};

const cachedGet = <T>(
  url: string,
  config?: AxiosRequestConfig,
  options?: ReadRequestOptions
) => {
  const requestKey = buildGetRequestKey(url, config);
  const cacheMs = Math.max(0, Number(options?.cacheMs ?? 0));
  const force = options?.force === true;
  const cached = responseCache.get(requestKey);
  const now = Date.now();

  if (!force && cached && cached.expiresAt > now) {
    return Promise.resolve(cached.value as ApiResponse<T>);
  }

  if (cached && (force || cached.expiresAt <= now)) {
    responseCache.delete(requestKey);
  }

  const inFlight = inFlightGetRequests.get(requestKey);
  if (inFlight) {
    return inFlight as Promise<ApiResponse<T>>;
  }

  const request = API.get<ApiResponse<T>>(url, config)
    .then((response) => {
      if (cacheMs > 0) {
        responseCache.set(requestKey, {
          expiresAt: Date.now() + cacheMs,
          value: response.data,
        });
      }
      return response.data;
    })
    .finally(() => {
      inFlightGetRequests.delete(requestKey);
    });

  inFlightGetRequests.set(requestKey, request as Promise<unknown>);
  return request;
};

const CACHE_TTL = {
  teams: 5 * 60 * 1000,
  players: 5 * 60 * 1000,
  matches: 60 * 1000,
  matchList: 30 * 1000,
  matchdays: 60 * 1000,
  statsOverview: 60 * 1000,
  analytics: 30 * 1000,
  understatInfo: 30 * 1000,
  scraperStatus: 5 * 1000,
  oddsSnapshotStatus: 5 * 1000,
  systemHealth: 10 * 1000,
  providerHealth: 10 * 1000,
  systemMetrics: 10 * 1000,
  recentRuns: 10 * 1000,
  understatTeamSeasonStats: 5 * 60 * 1000,
  backtestResults: 15 * 1000,
  backtestResult: 15 * 1000,
  backtestReport: 15 * 1000,
} as const;

// Teams
export const getTeams = (competition?: string, options?: ReadRequestOptions) =>
  cachedGet<any[]>('/teams', { params: { competition } }, { cacheMs: CACHE_TTL.teams, ...options });

export const createTeam = (team: any) =>
  API.post<ApiResponse<any>>('/teams', team).then(r => r.data);

export const getPlayersByTeam = (teamId: string, options?: ReadRequestOptions) =>
  cachedGet<any[]>(`/players/${teamId}`, undefined, { cacheMs: CACHE_TTL.players, ...options });

// Matches
export const getMatches = (
  filters?: { competition?: string; season?: string; fromDate?: string; toDate?: string },
  options?: ReadRequestOptions
) =>
  cachedGet<any[]>('/matches', { params: filters, timeout: 120000 }, { cacheMs: CACHE_TTL.matches, ...options });

export const getMatchesCount = (
  filters?: { competition?: string; season?: string; fromDate?: string; toDate?: string },
  options?: ReadRequestOptions
) =>
  cachedGet<null>('/matches/count', { params: filters }, { cacheMs: CACHE_TTL.matches, ...options });

export const getUpcomingMatches = (
  filters?: { competition?: string; season?: string; limit?: number } | string,
  options?: ReadRequestOptions
) => {
  const params = typeof filters === 'string' ? { competition: filters } : (filters ?? {});
  return cachedGet<any[]>('/matches/upcoming', { params }, { cacheMs: CACHE_TTL.matchList, ...options });
};

export const getRecentMatches = (
  filters?: { competition?: string; season?: string; limit?: number } | string,
  options?: ReadRequestOptions
) => {
  const params = typeof filters === 'string' ? { competition: filters } : (filters ?? {});
  return cachedGet<any[]>('/matches/recent', { params }, { cacheMs: CACHE_TTL.matchList, ...options });
};

export const getMatchdayMap = (
  params?: { competition?: string; season?: string; matchesPerMatchday?: number },
  options?: ReadRequestOptions
) =>
  cachedGet<Record<string, number>>('/matches/matchdays', { params }, { cacheMs: CACHE_TTL.matchdays, ...options });

export const getEurobetOddsForMatch = (params: {
  matchId?: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime?: string;
}) =>
  API.post<ApiResponse<any>>('/scraper/odds/match', params, { timeout: 240000 }).then(r => r.data);

export const createMatch = (match: any) =>
  API.post<ApiResponse<any>>('/matches', match).then(r => r.data);

export const bulkImportMatches = (matches: any[]) =>
  API.post<ApiResponse<any>>('/matches/bulk', { matches }).then(r => {
    invalidateApiCache((key) =>
      key.includes('GET:/matches') ||
      key.includes('GET:/matches/count') ||
      key.includes('GET:/stats/overview')
    );
    return r.data;
  });

// Model
export const fitModel = (params: { competition: string; season?: string; fromDate?: string; toDate?: string }) =>
  API.post<ApiResponse<any>>('/model/fit', params).then(r => r.data);

// Predictions
export const getPrediction = (request: {
  homeTeamId: string;
  awayTeamId: string;
  matchId?: string;
  competition?: string;
  bookmakerOdds?: Record<string, number>;
}) =>
  API.post<ApiResponse<any>>('/predict', request).then(r => r.data);

export const replayPlayedMatchPrediction = (matchId: string) =>
  API.post<ApiResponse<any>>('/predict/replay', { matchId }).then(r => r.data);

// Budget
export const getBudget = (userId: string, options?: ReadRequestOptions) =>
  cachedGet<any>(`/budget/${userId}`, undefined, { cacheMs: 0, ...options });

export const initBudget = (userId: string, amount: number) =>
  API.post<ApiResponse<any>>(`/budget/${userId}/init`, { amount }).then(r => {
    invalidateApiCache((key) => key.includes(`/budget/${userId}`) || key.includes(`/bets/${userId}`));
    return r.data;
  });

// Bets
export const placeBet = (bet: {
  userId: string;
  matchId: string;
  marketName: string;
  selection: string;
  odds: number;
  stake: number;
  ourProbability: number;
  expectedValue: number;
  homeTeamName?: string;
  awayTeamName?: string;
  competition?: string;
  matchDate?: string;
}) =>
  API.post<ApiResponse<any>>('/bets/place', bet).then(r => {
    invalidateApiCache((key) =>
      key.includes(`/budget/${bet.userId}`) ||
      key.includes(`/bets/${bet.userId}`) ||
      key.includes('GET:/analytics/system')
    );
    return r.data;
  });

export const settleBet = (betId: string, won: boolean, returnAmount?: number) =>
  API.post<ApiResponse<any>>(`/bets/${betId}/settle`, { won, returnAmount }).then(r => {
    invalidateApiCache((key) => key.includes('GET:/budget/') || key.includes('GET:/bets/'));
    return r.data;
  });

export const getBets = (userId: string, status?: string, options?: ReadRequestOptions) =>
  cachedGet<any[]>(`/bets/${userId}`, { params: { status } }, { cacheMs: 0, ...options });

// Backtesting
export const runBacktest = (params: {
  competition: string;
  season?: string;
  historicalOdds?: any;
  trainRatio?: number;
  confidenceLevel?: 'high_only' | 'medium_and_above';
}) =>
  API.post<ApiResponse<any>>('/backtest', params).then(r => {
    invalidateApiCache((key) => key.includes('GET:/backtest/'));
    return r.data;
  });

export const runWalkForwardBacktest = (params: {
  competition: string;
  season?: string;
  historicalOdds?: any;
  initialTrainMatches?: number;
  testWindowMatches?: number;
  stepMatches?: number;
  confidenceLevel?: 'high_only' | 'medium_and_above';
  expandingWindow?: boolean;
  maxFolds?: number;
}) =>
  API.post<ApiResponse<any>>('/backtest/walk-forward', params).then(r => {
    invalidateApiCache((key) => key.includes('GET:/backtest/'));
    return r.data;
  });

export const getBacktestResults = (competition?: string, options?: ReadRequestOptions) =>
  cachedGet<any[]>('/backtest/results', { params: { competition } }, { cacheMs: CACHE_TTL.backtestResults, ...options });

export const getBacktestResult = (id: number, options?: ReadRequestOptions) =>
  cachedGet<any>(`/backtest/results/${id}`, undefined, { cacheMs: CACHE_TTL.backtestResult, ...options });

export const getBacktestReport = (params?: {
  runId?: number;
  competition?: string;
  market?: string;
  source?: string;
  dateFrom?: string;
  dateTo?: string;
}, options?: ReadRequestOptions) =>
  cachedGet<any>('/backtest/report', { params }, { cacheMs: CACHE_TTL.backtestReport, ...options });

export const deleteBacktestResult = (id: number) =>
  API.delete<ApiResponse<{ deleted: boolean }>>(`/backtest/results/${id}`).then(r => {
    invalidateApiCache((key) => key.includes('GET:/backtest/'));
    return r.data;
  });

export const deleteBacktestResults = (competition?: string) =>
  API.delete<ApiResponse<{ deletedCount: number }>>('/backtest/results', { params: { competition } }).then(r => {
    invalidateApiCache((key) => key.includes('GET:/backtest/'));
    return r.data;
  });

export const pruneBacktestResults = (keepLatest: number, competition?: string) =>
  API.post<ApiResponse<{ deletedCount: number }>>('/backtest/results/prune', { keepLatest, competition }).then(r => {
    invalidateApiCache((key) => key.includes('GET:/backtest/'));
    return r.data;
  });

export const recomputeAverages = (competition?: string) =>
  API.post<ApiResponse<any>>('/model/recompute-averages', { competition }).then(r => r.data);

export const getStatsOverview = (options?: ReadRequestOptions) =>
  cachedGet<any>('/stats/overview', undefined, { cacheMs: CACHE_TTL.statsOverview, ...options });

export const getSystemAnalytics = (params?: { userId?: string; competition?: string }, options?: ReadRequestOptions) =>
  cachedGet<any>('/analytics/system', { params }, { cacheMs: CACHE_TTL.analytics, ...options });

export const getUnderstatTeamSeasonStats = (
  params: { competition: string; season: string; teamId: string },
  options?: ReadRequestOptions
) =>
  cachedGet<any>('/stats/understat/team-season', { params, timeout: 120000 }, { cacheMs: CACHE_TTL.understatTeamSeasonStats, ...options });

export const getUnderstatScraperInfo = (options?: ReadRequestOptions) =>
  cachedGet<any>('/scraper/understat/info', { timeout: 120000 }, { cacheMs: CACHE_TTL.understatInfo, ...options });

export const runUnderstatImport = (params?: {
  mode?: 'single' | 'top5';
  competition?: string;
  competitions?: string[];
  seasons?: string[];
  yearsBack?: number;
  importPlayers?: boolean;
  includeMatchDetails?: boolean;
  forceRefresh?: boolean;
  includeSofaScoreSupplemental?: boolean;
  sofaScoreSupplementalLimit?: number;
}) =>
  API.post<ApiResponse<any>>('/scraper/understat', {
    mode: params?.mode ?? 'top5',
    competition: params?.competition ?? 'Serie A',
    competitions: params?.competitions,
    seasons: params?.seasons,
    yearsBack: params?.yearsBack ?? 1,
    importPlayers: params?.importPlayers ?? true,
    includeMatchDetails: params?.includeMatchDetails ?? true,
    forceRefresh: params?.forceRefresh ?? false,
    includeSofaScoreSupplemental: params?.includeSofaScoreSupplemental ?? true,
    sofaScoreSupplementalLimit: params?.sofaScoreSupplementalLimit,
  }, { timeout: 3600000 }).then(r => {
    invalidateApiCache((key) =>
      key.includes('GET:/scraper/') ||
      key.includes('GET:/matches') ||
      key.includes('GET:/stats/')
    );
    return r.data;
  });

export const getScraperStatus = (options?: ReadRequestOptions) =>
  cachedGet<any>('/scraper/status', undefined, { cacheMs: CACHE_TTL.scraperStatus, ...options });

export const getOddsSnapshotStatus = (options?: ReadRequestOptions) =>
  cachedGet<any>('/scraper/odds/status', { timeout: 120000 }, { cacheMs: CACHE_TTL.oddsSnapshotStatus, ...options });

export const runOddsSnapshot = (params?: { competition?: string; markets?: string[] }) =>
  API.post<ApiResponse<any>>('/scraper/odds', {
    competition: params?.competition ?? 'Serie A',
    markets: params?.markets ?? ['h2h', 'totals'],
  }, { timeout: 3600000 }).then(r => {
    invalidateApiCache((key) =>
      key.includes('GET:/scraper/odds') ||
      key.includes('GET:/system/provider-health') ||
      key.includes('GET:/system/health') ||
      key.includes('GET:/system/metrics') ||
      key.includes('GET:/system/recent-runs')
    );
    return r.data;
  });

export const getSystemHealth = (options?: ReadRequestOptions) =>
  cachedGet<any>('/system/health', undefined, { cacheMs: CACHE_TTL.systemHealth, ...options });

export const getProviderHealth = (
  params?: { refresh?: boolean; competition?: string },
  options?: ReadRequestOptions
) =>
  cachedGet<any>('/system/provider-health', { params }, {
    cacheMs: params?.refresh ? 0 : CACHE_TTL.providerHealth,
    ...options,
  });

export const getSystemMetrics = (options?: ReadRequestOptions) =>
  cachedGet<any>('/system/metrics', undefined, { cacheMs: CACHE_TTL.systemMetrics, ...options });

export const getRecentSystemRuns = (limit = 20, options?: ReadRequestOptions) =>
  cachedGet<any>('/system/recent-runs', { params: { limit } }, { cacheMs: CACHE_TTL.recentRuns, ...options });

export const runSofaScoreSupplemental = (params?: {
  competition?: string;
  season?: string;
  limit?: number;
  onlyMissing?: boolean;
  enabled?: boolean;
}) =>
  API.post<ApiResponse<any>>('/scraper/sofascore/supplemental', {
    competition: params?.competition,
    season: params?.season,
    limit: params?.limit,
    onlyMissing: params?.onlyMissing ?? true,
    enabled: params?.enabled,
  }, { timeout: 3600000 }).then(r => r.data);

// Health
export const healthCheck = () =>
  API.get<ApiResponse<any>>('/health').then(r => r.data);

export default API;
