import axios from 'axios';

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

// Teams
export const getTeams = (competition?: string) =>
  API.get<ApiResponse<any[]>>('/teams', { params: { competition } }).then(r => r.data);

export const createTeam = (team: any) =>
  API.post<ApiResponse<any>>('/teams', team).then(r => r.data);

export const getPlayersByTeam = (teamId: string) =>
  API.get<ApiResponse<any[]>>(`/players/${teamId}`).then(r => r.data);

// Matches
export const getMatches = (filters?: { competition?: string; season?: string; fromDate?: string; toDate?: string }) =>
  API.get<ApiResponse<any[]>>('/matches', { params: filters, timeout: 120000 }).then(r => r.data);

export const getMatchesCount = (filters?: { competition?: string; season?: string; fromDate?: string; toDate?: string }) =>
  API.get<ApiResponse<null>>('/matches/count', { params: filters }).then(r => r.data);

export const getUpcomingMatches = (
  filters?: { competition?: string; season?: string; limit?: number } | string
) => {
  const params = typeof filters === 'string' ? { competition: filters } : (filters ?? {});
  return API.get<ApiResponse<any[]>>('/matches/upcoming', { params }).then(r => r.data);
};

export const getMatchdayMap = (params?: { competition?: string; season?: string; matchesPerMatchday?: number }) =>
  API.get<ApiResponse<Record<string, number>>>('/matches/matchdays', { params }).then(r => r.data);

export const getEurobetOddsForMatch = (params: {
  competition: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime?: string;
}) =>
  API.post<ApiResponse<any>>('/scraper/odds/match', params).then(r => r.data);

export const createMatch = (match: any) =>
  API.post<ApiResponse<any>>('/matches', match).then(r => r.data);

export const bulkImportMatches = (matches: any[]) =>
  API.post<ApiResponse<any>>('/matches/bulk', { matches }).then(r => r.data);

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

// Budget
export const getBudget = (userId: string) =>
  API.get<ApiResponse<any>>(`/budget/${userId}`).then(r => r.data);

export const initBudget = (userId: string, amount: number) =>
  API.post<ApiResponse<any>>(`/budget/${userId}/init`, { amount }).then(r => r.data);

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
  API.post<ApiResponse<any>>('/bets/place', bet).then(r => r.data);

export const settleBet = (betId: string, won: boolean, returnAmount?: number) =>
  API.post<ApiResponse<any>>(`/bets/${betId}/settle`, { won, returnAmount }).then(r => r.data);

export const getBets = (userId: string, status?: string) =>
  API.get<ApiResponse<any[]>>(`/bets/${userId}`, { params: { status } }).then(r => r.data);

// Backtesting
export const runBacktest = (params: { competition: string; season?: string; historicalOdds?: any }) =>
  API.post<ApiResponse<any>>('/backtest', params).then(r => r.data);

export const getBacktestResults = (competition?: string) =>
  API.get<ApiResponse<any[]>>('/backtest/results', { params: { competition } }).then(r => r.data);

export const getBacktestResult = (id: number) =>
  API.get<ApiResponse<any>>(`/backtest/results/${id}`).then(r => r.data);

export const recomputeAverages = (competition?: string) =>
  API.post<ApiResponse<any>>('/model/recompute-averages', { competition }).then(r => r.data);

export const getStatsOverview = () =>
  API.get<ApiResponse<any>>('/stats/overview').then(r => r.data);

export const getFotmobTeamSeasonStats = (params: { competition: string; season: string; teamId: string }) =>
  API.get<ApiResponse<any>>('/stats/fotmob/team-season', { params, timeout: 120000 }).then(r => r.data);

export const autoRefreshDataOnEnter = (params?: {
  mode?: 'single' | 'top5';
  competition?: string;
  yearsBack?: number;
  importPlayers?: boolean;
  includeMatchDetails?: boolean;
  forceRefresh?: boolean;
}) =>
  API.post<ApiResponse<any>>('/scraper/fotmob', {
    mode: params?.mode ?? 'top5',
    competition: params?.competition ?? 'Serie A',
    yearsBack: params?.yearsBack ?? 2,
    importPlayers: params?.importPlayers ?? false,
    includeMatchDetails: params?.includeMatchDetails ?? false,
    forceRefresh: params?.forceRefresh ?? false,
  }, { timeout: 3600000 }).then(r => r.data);

// Health
export const healthCheck = () =>
  API.get<ApiResponse<any>>('/health').then(r => r.data);

export default API;
