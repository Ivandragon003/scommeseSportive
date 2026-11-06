import API, { ApiResponse } from './api';

export interface PaperBet {
  id: string; accountingMode: 'PAPER_FIXED_UNIT'; family: 'A' | 'C'; portfolioId: string;
  matchId: string; modelVersion: string; market: string; selection: string; selectionKey: string;
  odds: number; stakeUnits: 1; returnUnits: number | null; profitUnits: number | null;
  status: string; placedAt: string; createdAt: string; settledAt: string | null;
  bookmaker?: string | null; source?: string | null; quote?: { bookmaker?: string; source?: string; capturedAt?: string; updatedAt?: string; line?: number; side?: string } | null;
  probability?: number | null; confidence?: string | null; classification?: string | null;
  matchLabel?: string | null; league?: string | null; kickoffAt?: string | null;
}
export interface PaperMetrics {
  totalCount: number; betCount: number; openCount: number; settledCount: number;
  totalStakeUnits: number; settledStakeUnits: number; returnUnits: number; profitUnits: number;
  roiPercent: number | null; winRatePercent: number | null; wonCount: number; lostCount: number; voidCount: number;
}
export interface PaperHistoryPoint { at: string; betId: string; profitUnits: number }
export interface PaperPortfolio extends PaperMetrics { family: 'A' | 'C'; history: PaperHistoryPoint[] }
export interface PaperBetsData extends PaperMetrics {
  accountingMode: 'PAPER_FIXED_UNIT'; fixedStakeUnits: 1; portfolios: PaperPortfolio[];
  history: PaperHistoryPoint[]; bets: PaperBet[];
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): boolean => finite(value) && Number.isSafeInteger(value) && value >= 0;
const validMetrics = (value: unknown): boolean => record(value)
  && ['totalCount', 'betCount', 'openCount', 'settledCount', 'wonCount', 'lostCount', 'voidCount'].every(key => count(value[key]))
  && ['totalStakeUnits', 'settledStakeUnits', 'returnUnits', 'profitUnits'].every(key => finite(value[key]))
  && ['roiPercent', 'winRatePercent'].every(key => value[key] === null || finite(value[key]))
  && value.totalCount === value.betCount && Number(value.openCount) + Number(value.settledCount) === value.totalCount
  && value.totalStakeUnits === value.totalCount && value.settledStakeUnits === value.settledCount
  && Math.abs(Number(value.returnUnits) - Number(value.settledStakeUnits) - Number(value.profitUnits)) < 1e-9;
const validHistory = (value: unknown): boolean => Array.isArray(value) && value.every(point => record(point)
  && typeof point.at === 'string' && Number.isFinite(Date.parse(point.at)) && typeof point.betId === 'string' && finite(point.profitUnits));

export async function getPaperBets(signal?: AbortSignal): Promise<PaperBetsData> {
  try {
    const response = await API.get<ApiResponse<PaperBetsData>>('/paper-bets', { signal });
    const data = response.data?.data;
    if (response.data?.success !== true || !data || data.accountingMode !== 'PAPER_FIXED_UNIT' || data.fixedStakeUnits !== 1
      || !validMetrics(data) || !validHistory(data.history) || !Array.isArray(data.portfolios)
      || data.portfolios.length !== 2 || new Set(data.portfolios.map(row => row.family)).size !== 2
      || !data.portfolios.every(row => ['A', 'C'].includes(row.family) && validMetrics(row) && validHistory(row.history))
      || !Array.isArray(data.bets) || data.totalCount !== data.bets.length
      || !data.portfolios.every(row => row.totalCount === data.bets.filter(bet => bet.family === row.family).length)
      || new Set(data.bets.map(row => row.id)).size !== data.bets.length
      || !data.bets.every(row => typeof row.id === 'string' && row.id.length > 0 && row.accountingMode === 'PAPER_FIXED_UNIT'
        && ['A', 'C'].includes(row.family) && row.stakeUnits === 1 && finite(row.odds) && row.odds > 1
        && typeof row.selection === 'string' && typeof row.market === 'string'
        && ['PENDING', 'WON', 'LOST', 'VOID', 'HALF_WON', 'HALF_LOST'].includes(row.status)
        && (row.status === 'PENDING' ? row.returnUnits === null && row.profitUnits === null
          : finite(row.returnUnits) && finite(row.profitUnits) && Math.abs(row.returnUnits - 1 - row.profitUnits) < 1e-9))) {
      throw new Error('Risposta delle giocate paper non valida o incompleta.');
    }
    return data;
  } catch (error) {
    const failure = error as { response?: { data?: { code?: string } } };
    if (failure.response?.data?.code === 'paper_schema_required') {
      throw new Error('Registro paper non disponibile: lo schema del database deve essere aggiornato. Lo storico precedente resta separato.');
    }
    throw error;
  }
}
