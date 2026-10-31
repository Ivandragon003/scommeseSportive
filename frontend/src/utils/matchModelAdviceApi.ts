import API, { ApiResponse } from './api';

export type AdviceFamily = 'A' | 'C';

export interface RecordedModelAdvice {
  id: string;
  matchId: string;
  family: AdviceFamily;
  modelVersion: string;
  action: 'BET' | 'ABSTAIN';
  reason?: string;
  selection?: string;
  forecastAt?: string;
  createdAt?: string;
  betId?: string;
  stakeCents?: number;
  betStatus?: string;
  quote?: { selection?: string; odds?: number; bookmaker?: string; source?: string; capturedAt?: string; updatedAt?: string };
  recommendationPacket?: {
    selected: { selection: string; selectionLabel?: string; bookmakerOdds?: number; bookmakerName?: string } | null;
    decisionStatus?: string;
    asOf?: string;
    model?: { version?: string; source?: string };
  };
}

export interface MatchModelAdviceData {
  A: RecordedModelAdvice | null;
  C: RecordedModelAdvice | null;
  errors: Partial<Record<AdviceFamily, string>>;
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Reads only the effective execution decisions; legacy research A is not operational A. */
export async function getMatchModelAdvice(matchId: string, signal?: AbortSignal): Promise<MatchModelAdviceData> {
  if (!matchId.trim()) throw new Error('Partita non disponibile.');
  const response = await API.get<ApiResponse<{ matchId: string; decisions: unknown[] }>>('/research/forecasts', {
    params: { matchId }, signal,
  });
  const payload = response.data;
  if (!payload?.success || payload.data?.matchId !== matchId || !Array.isArray(payload.data?.decisions)) {
    throw new Error('I consigli archiviati della partita non sono disponibili.');
  }
  const result: MatchModelAdviceData = { A: null, C: null, errors: {} };
  for (const family of ['A', 'C'] as const) {
    const rows = payload.data.decisions.filter((row) => object(row) && row.family === family && row.authority === 'execution');
    if (!rows.length) continue;
    const row = rows[0] as Record<string, any>;
    const packet = row.recommendationPacket;
    const selected = packet?.selected;
    const invalid = rows.length !== 1 || row.matchId !== matchId || row.effective === false
      || !text(row.id) || !text(row.modelVersion) || !['BET', 'ABSTAIN'].includes(row.action)
      || (family === 'A' && row.modelSource && row.modelSource !== 'PredictionService')
      || (packet != null && (!object(packet) || !Object.prototype.hasOwnProperty.call(packet, 'selected')
        || (selected !== null && (!object(selected) || !text(selected.selection)))
        || !['RECOMMENDED', 'NO_BET'].includes(packet.decisionStatus)
        || (selected === null ? packet.decisionStatus !== 'NO_BET' : packet.decisionStatus !== 'RECOMMENDED')
        || (selected && selected.selectionLabel !== undefined && typeof selected.selectionLabel !== 'string')
        || (selected && selected.bookmakerName !== undefined && typeof selected.bookmakerName !== 'string')
        || (packet.model?.version && packet.model.version !== row.modelVersion)
        || (family === 'A' && packet.model?.source && packet.model.source !== 'PredictionService')));
    if (invalid) result.errors[family] = `Il consiglio archiviato del modello ${family} non è verificabile.`;
    else result[family] = row as RecordedModelAdvice;
  }
  return result;
}
