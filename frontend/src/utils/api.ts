import axios, { AxiosRequestConfig } from 'axios';
import { Capacitor } from '@capacitor/core';

const HOSTLESS_API_URL = 'https://scommese-sportive-backend.hostless.app/api';
const configuredApiUrl = String(process.env.REACT_APP_API_URL ?? '').trim();
const apiBaseUrl = configuredApiUrl || (Capacitor.isNativePlatform() ? HOSTLESS_API_URL : '/api');

const API = axios.create({
  // In produzione il frontend è un servizio separato dal backend. CRA
  // sostituisce REACT_APP_* durante la build; in locale resta il proxy /api.
  baseURL: apiBaseUrl.replace(/\/$/, ''),
  timeout: 30000,
  withCredentials: true,
});

export const LONG_BACKTEST_TIMEOUT_MS = 10 * 60 * 1000;
export const WALK_FORWARD_TIMEOUT_MESSAGE =
  'Il walk-forward Top 5 sta impiegando troppo tempo. Riduci max folds, disattiva il tuning pesi oppure riprova con un singolo campionato.';

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

export interface AdminSession {
  authenticated: true;
  sharedDataUserId: string;
}

export const getAdminSession = () =>
  API.get<ApiResponse<AdminSession>>('/auth/session').then((response) => response.data.data!);

export const loginSharedAdmin = (password: string) =>
  API.post<ApiResponse<AdminSession>>('/auth/login', { password }).then((response) => {
    invalidateApiCache();
    return response.data.data!;
  });

export const logoutSharedAdmin = () =>
  API.post('/auth/logout').then(() => {
    invalidateApiCache();
  });

type CacheMatcher = string | RegExp | ((key: string) => boolean);

const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const inFlightGetRequests = new Map<string, Promise<unknown>>();
export const RESPONSE_CACHE_MAX_ENTRIES = 200;

const pruneResponseCache = (now = Date.now()): void => {
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(key);
  }
};

const ensureResponseCacheCapacityForInsert = (requestKey: string): void => {
  if (responseCache.has(requestKey)) return;
  // FIFO eviction is intentional: Map preserves insertion order and this keeps
  // read caching bounded without changing in-flight request coalescing.
  while (responseCache.size >= RESPONSE_CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (!oldestKey) break;
    responseCache.delete(oldestKey);
  }
};

export const getApiResponseCacheStats = () => ({
  responseEntries: responseCache.size,
  inFlightEntries: inFlightGetRequests.size,
});

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

const rethrowWalkForwardBacktestError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const isTimeoutError = axios.isAxiosError(error) && (
    error.code === 'ECONNABORTED' ||
    message.toLowerCase().includes('timeout')
  );

  if (isTimeoutError) {
    throw new Error(WALK_FORWARD_TIMEOUT_MESSAGE);
  }

  throw error;
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
  const now = Date.now();
  pruneResponseCache(now);
  const cached = responseCache.get(requestKey);

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
        pruneResponseCache(Date.now());
        ensureResponseCacheCapacityForInsert(requestKey);
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

export const getOddsForMatch = (params: {
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
  oddsSource?: string;
}) =>
  API.post<ApiResponse<any>>('/predict', request).then(r => r.data);

export const getPlayerAvailability = (matchId: string) =>
  cachedGet<any>(`/player-availability/${encodeURIComponent(matchId)}`);

export const PLAYER_AVAILABILITY_UPDATED_EVENT = 'player-availability-updated';

const notifyPlayerAvailabilityUpdated = (matchId: string) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PLAYER_AVAILABILITY_UPDATED_EVENT, {
    detail: { matchId },
  }));
};

export const refreshPlayerAvailability = (matchId: string) =>
  API.post<ApiResponse<any>>(`/player-availability/refresh/${encodeURIComponent(matchId)}`, {}, { timeout: 45000 })
    .then(r => {
      invalidateApiCache((key) => key.includes(`GET:/player-availability/${encodeURIComponent(matchId)}`));
      notifyPlayerAvailabilityUpdated(matchId);
      return r.data;
    });

export const syncUpcomingPlayerAvailability = (windowHours = 48) =>
  API.post<ApiResponse<any>>('/player-availability/sync-upcoming', { windowHours }, { timeout: 120000 })
    .then(r => r.data);

export type PredictionArchiveStatus = 'played' | 'unplayed' | 'pending' | 'win' | 'loss' | 'void';

export interface PredictionArchiveFilters {
  status?: PredictionArchiveStatus;
  matchId?: string;
  limit?: number;
}

export interface PredictionArchiveRecord {
  prediction_id: string;
  match_id: string;
  home_team_name?: string | null;
  away_team_name?: string | null;
  competition?: string | null;
  match_date?: string | null;
  market: string;
  selection: string;
  raw_probability?: number | null;
  calibrated_probability?: number | null;
  odds_at_prediction?: number | null;
  source?: string | null;
  ev?: number | null;
  ev_reason?: string | null;
  kelly?: number | null;
  confidence_computed?: string | null;
  sample_size_at_time?: number | null;
  created_at?: string | null;
  result?: string | null;
  settled_at?: string | null;
  was_played: number | boolean;
  bet_id?: string | null;
  bet_status?: string | null;
  bet_stake?: number | null;
  bet_odds?: number | null;
  bet_placed_at?: string | null;
}

export const getPredictionArchive = (filters: PredictionArchiveFilters = {}) =>
  cachedGet<PredictionArchiveRecord[]>('/predictions/archive', { params: filters });

export type BetOpportunityArchiveType = 'operative' | 'simulated';
export type BetOpportunityClassification = 'high' | 'medium' | 'low' | 'speculative';
export type BetOpportunityResult = 'pending' | 'win' | 'loss' | 'void';

export interface BetOpportunityArchiveFilters {
  type?: BetOpportunityArchiveType;
  classification?: BetOpportunityClassification;
  result?: BetOpportunityResult;
  matchId?: string;
  limit?: number;
}

export interface BetOpportunityArchiveRecord {
  decision_id: string;
  match_id: string;
  home_team_name?: string | null;
  away_team_name?: string | null;
  competition?: string | null;
  match_date?: string | null;
  market_name: string;
  selection: string;
  classification: 'HIGH' | 'MEDIUM' | 'LOW' | 'SPECULATIVE';
  archive_type: BetOpportunityArchiveType;
  display_odds?: number | null;
  bookmaker_odds?: number | null;
  bookmaker_name?: string | null;
  raw_probability?: number | null;
  calibrated_probability?: number | null;
  ev?: number | null;
  ev_reason?: string | null;
  kelly?: number | null;
  source?: string | null;
  sample_size_at_time?: number | null;
  theoretical_stake_percent?: number | null;
  theoretical_stake_amount?: number | null;
  bet_stake?: number | null;
  ranking_position?: number | null;
  operational_slot?: number | null;
  decision_status?: string | null;
  exclusion_reason?: string | null;
  prediction_id?: string | null;
  bet_id?: string | null;
  result: BetOpportunityResult;
  created_at?: string | null;
  settled_at?: string | null;
}

export const getBetOpportunityArchive = (filters: BetOpportunityArchiveFilters = {}) =>
  cachedGet<BetOpportunityArchiveRecord[]>('/bet-opportunities/archive', { params: filters });

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

export const syncSharedBets = () =>
  API.post<ApiResponse<any>>('/bets/sync').then(r => {
    invalidateApiCache((key) => key.includes('GET:/budget/') || key.includes('GET:/bets/'));
    return r.data;
  });

export const getBets = (userId: string, status?: string, options?: ReadRequestOptions) =>
  cachedGet<any[]>(`/bets/${userId}`, { params: { status } }, { cacheMs: 0, ...options });

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
  saveIndividualRuns?: boolean;
  compareBaseline?: boolean;
  optimizeRankingWeights?: boolean;
}) =>
  API.post<ApiResponse<any>>('/backtest/walk-forward', params, { timeout: LONG_BACKTEST_TIMEOUT_MS }).then(r => {
    invalidateApiCache((key) => key.includes('GET:/backtest/'));
    return r.data;
  }).catch(rethrowWalkForwardBacktestError);

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

export const getCompetitionTransitionAudit = (options?: ReadRequestOptions) =>
  cachedGet<any>('/competition-transitions/audit', undefined, { cacheMs: CACHE_TTL.statsOverview, ...options });

export const getCompetitionTransitionReferences = (options?: ReadRequestOptions) =>
  cachedGet<any[]>('/competition-transitions/references', undefined, { cacheMs: CACHE_TTL.statsOverview, ...options });

export const getCompetitionTransitions = (options?: ReadRequestOptions) =>
  cachedGet<any[]>('/competition-transitions', undefined, { cacheMs: CACHE_TTL.statsOverview, ...options });

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
}) =>
  API.post<ApiResponse<any>>('/scraper/understat', {
    mode: params?.mode ?? 'top5',
    competition: params?.competition ?? 'Serie A',
    competitions: params?.competitions,
    // Policy server-side non aggirabile: corrente + quattro precedenti.
    seasons: undefined,
    yearsBack: 5,
    importPlayers: params?.importPlayers ?? true,
    includeMatchDetails: params?.includeMatchDetails ?? true,
    forceRefresh: params?.forceRefresh ?? false,
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

export const syncUpcomingKickoffs = (params?: {
  mode?: 'single' | 'top5';
  competition?: string;
  season?: string;
  limit?: number;
}) =>
  API.post<ApiResponse<any>>('/system/sync-upcoming-kickoffs', {
    mode: params?.mode ?? 'top5',
    competition: params?.competition,
    season: params?.season,
    limit: params?.limit ?? 160,
  }, { timeout: 120000 }).then(r => {
    invalidateApiCache((key) =>
      key.includes('GET:/matches/upcoming') ||
      key.includes('GET:/matches/matchdays') ||
      key.includes('GET:/system/provider-health') ||
      key.includes('GET:/system/health')
    );
    return r.data;
  });

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

export const runFootballDataSync = (params?: {
  competitions?: string[];
  recomputeAverages?: boolean;
}) =>
  API.post<ApiResponse<any>>('/scraper/football-data', {
    competitions: params?.competitions,
    recomputeAverages: params?.recomputeAverages ?? true,
  }, { timeout: 3600000 }).then(r => {
    invalidateApiCache((key) =>
      key.includes('GET:/matches')
      || key.includes('GET:/stats/')
      || key.includes('GET:/teams')
    );
    return r.data;
  });

// Health
export const healthCheck = () =>
  API.get<ApiResponse<any>>('/health').then(r => r.data);

export default API;
