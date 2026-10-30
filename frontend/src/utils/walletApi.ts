import API, { ApiResponse } from './api';
import { ResearchComparison, ResearchComparisonQuery } from '../features/research/researchComparisonTypes';

/** Reads the funded app portfolios and their recorded bets without performing settlement. */
export async function getAppWallets(query: ResearchComparisonQuery, signal?: AbortSignal): Promise<ResearchComparison> {
  const response = await API.get<ApiResponse<ResearchComparison>>('/wallets', { params: query, signal });
  if (!response.data.success || !response.data.data) {
    throw new Error(response.data.error || 'Portafogli e giocate non disponibili.');
  }
  return response.data.data;
}
