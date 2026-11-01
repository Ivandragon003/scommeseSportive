import API, { ApiResponse } from './api';
import { ResearchComparison, ResearchComparisonQuery } from '../features/research/researchComparisonTypes';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isOptionalAmount = (value: unknown): boolean => value == null || (typeof value === 'number' && Number.isSafeInteger(value));
const isOptionalText = (value: unknown): boolean => value == null || typeof value === 'string';
const isOptionalNumber = (value: unknown): boolean => value == null || (typeof value === 'number' && Number.isFinite(value));

function isWalletQuote(value: unknown): boolean {
  return value == null || (isRecord(value)
    && ['bookmaker', 'source', 'capturedAt', 'updatedAt', 'priceType', 'selection', 'market', 'side']
      .every((field) => isOptionalText(value[field])) && isOptionalNumber(value.line));
}

function isWalletData(value: unknown): value is ResearchComparison {
  if (!isRecord(value) || !isRecord(value.period) || typeof value.period.label !== 'string'
    || typeof value.period.key !== 'string' || !['all', '7d', '30d', '60d', '90d', 'custom'].includes(value.period.key)
    || !Array.isArray(value.portfolios) || !isRecord(value.bets) || !Array.isArray(value.bets.rows)
    || !isCount(value.bets.total) || value.bets.total < value.bets.rows.length
    || typeof value.bets.truncated !== 'boolean' || !isRecord(value.decisionDifferences)
    || !Array.isArray(value.decisionDifferences.rows) || !Array.isArray(value.byLeague) || !Array.isArray(value.byMarket)) return false;

  return value.portfolios.every((row) => isRecord(row) && (row.family === 'A' || row.family === 'C')
    && typeof row.portfolioId === 'string' && row.portfolioId.length > 0 && Array.isArray(row.equity)
    && row.equity.every((point) => isRecord(point) && typeof point.at === 'string'
      && typeof point.equityCents === 'number' && Number.isSafeInteger(point.equityCents))
    && ['initialCents', 'startEquityCents', 'endEquityCents', 'currentEquityCents', 'currentAvailableCents',
      'currentCommittedCents', 'stakeCents', 'settledStakeCents', 'profitCents'].every((field) => isOptionalAmount(row[field]))
    && ['betCount', 'settledCount', 'openCount', 'wonCount', 'lostCount', 'voidCount', 'halfWonCount', 'halfLostCount']
      .every((field) => row[field] == null || isCount(row[field]))
    && isOptionalNumber(row.roi) && isOptionalNumber(row.maxDrawdown))
    && value.bets.rows.every((row) => isRecord(row) && typeof row.id === 'string' && row.id.length > 0
      && typeof row.portfolioId === 'string' && typeof row.selection === 'string' && typeof row.status === 'string'
      && isCount(row.stakeCents) && typeof row.odds === 'number' && Number.isFinite(row.odds) && row.odds > 1
      && ['matchId', 'matchLabel', 'league', 'market', 'bookmaker', 'kickoffAt', 'createdAt', 'settledAt', 'modelVersion']
        .every((field) => isOptionalText(row[field]))
      && isOptionalAmount(row.profitCents) && isWalletQuote(row.quote));
}

/** Reads the funded app portfolios and their recorded bets without performing settlement. */
export async function getAppWallets(query: ResearchComparisonQuery, signal?: AbortSignal): Promise<ResearchComparison> {
  const response = await API.get<ApiResponse<unknown>>('/wallets', { params: query, signal });
  if (response.data?.success !== true || !response.data.data) {
    throw new Error(response.data?.error || 'Portafogli e giocate non disponibili.');
  }
  const data = response.data.data;
  if (!isWalletData(data)) {
    throw new Error('Risposta dei portafogli non valida.');
  }
  return data;
}
