import API from './api';

type ModelAction = { family: 'A' | 'C'; matchId: string; selection: string; bookmakerOdds: number; bookmakerName: string };
export type ManualModelOpportunity = { id: string; family: 'A' | 'C'; matchId: string; selection: string;
  classification: 'LOW' | 'SPECULATIVE'; snapshot: any; createdAt: string };
export async function getManualModelOpportunities(): Promise<ManualModelOpportunity[]> {
  const response = await API.get('/wallets/opportunities/manual');
  if (response.data?.success !== true || !Array.isArray(response.data.data)) throw new Error('Archivio manuale non disponibile.');
  return response.data.data;
}
export async function placeModelBet(input: ModelAction & { stakeCents: number }): Promise<any> {
  const response = await API.post('/wallets/bets/manual', input, { timeout: 60_000 });
  if (response.data?.success !== true) throw new Error(response.data?.error || 'Registrazione della giocata non riuscita.');
  return response.data.data;
}
export async function archiveModelOpportunity(input: ModelAction & { classification: 'LOW' | 'SPECULATIVE';
  marketName: string; suggestedStakePercent?: number }): Promise<any> {
  const response = await API.post('/wallets/opportunities/archive/manual', input, { timeout: 60_000 });
  if (response.data?.success !== true) throw new Error(response.data?.error || 'Archiviazione non riuscita.');
  return response.data.data;
}
