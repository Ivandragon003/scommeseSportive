import API, { ApiResponse } from './api';
import { ResearchOverview } from '../features/research/researchTypes';
import { ResearchOddsStatus } from '../features/research/researchOddsTypes';

/** Uses the same authenticated web/Capacitor client as the rest of the app. */
export const getResearchOverview = async (signal?: AbortSignal): Promise<ResearchOverview> => {
  const response = await API.get<ApiResponse<ResearchOverview>>('/research/overview', { signal });
  if (!response.data.success || !response.data.data) {
    throw new Error(response.data.error || 'Dati del confronto non disponibili.');
  }
  return response.data.data;
};

/** Reads stored accounting only; it never requests prices from a provider. */
export const getResearchOddsStatus = async (signal?: AbortSignal): Promise<ResearchOddsStatus> => {
  const response = await API.get<ApiResponse<ResearchOddsStatus>>('/research/odds-status', { signal });
  if (!response.data.success || !response.data.data) {
    throw new Error(response.data.error || 'Stato delle API quote non disponibile.');
  }
  return response.data.data;
};
