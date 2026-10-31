import API, { ApiResponse } from './api';

export type ChallengerPreviewStatus = 'RECOMMENDED' | 'NO_BET' | 'UNAVAILABLE' | 'NOT_ELIGIBLE' | 'ARCHIVED';

export interface ChallengerPreview {
  kind: 'C_PREVIEW';
  family: 'C';
  matchId: string;
  asOf: string;
  kickoffAt: string | null;
  expiresAt: string | null;
  modelVersion: string | null;
  deploymentRevision: string | null;
  status: ChallengerPreviewStatus;
  reason: string | null;
  recommendationPacket: {
    selected: {
      selection: string;
      selectionLabel?: string;
      bookmakerOdds?: number;
      bookmakerName?: string;
    } | null;
    decisionStatus: 'RECOMMENDED' | 'NO_BET';
  } | null;
  quote: {
    selection: string;
    odds: number;
    bookmaker: string;
    source: 'odds_api';
    capturedAt: string;
    updatedAt: string;
    priceType: 'prematch';
  } | null;
  suggestedStakePercent: 1;
  registered: false;
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const timestamp = (value: unknown): number => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
  ? Date.parse(value) : NaN;
const statuses: ChallengerPreviewStatus[] = ['RECOMMENDED', 'NO_BET', 'UNAVAILABLE', 'NOT_ELIGIBLE', 'ARCHIVED'];
const unavailable = (preview: ChallengerPreview, reason: string): ChallengerPreview => ({
  ...preview, status: 'UNAVAILABLE', reason, recommendationPacket: null, quote: null,
});

/** The preview is never an execution decision and cannot supply recorded stakes. */
export function validateChallengerPreview(value: unknown, matchId: string, now = Date.now()): ChallengerPreview {
  if (!object(value) || value.kind !== 'C_PREVIEW' || value.family !== 'C' || value.matchId !== matchId
    || value.registered !== false || value.suggestedStakePercent !== 1 || !statuses.includes(value.status)
    || !Number.isFinite(timestamp(value.asOf)) || timestamp(value.asOf) > now
    || (value.reason !== null && typeof value.reason !== 'string')
    || (value.modelVersion !== null && !text(value.modelVersion))
    || (value.deploymentRevision !== null && !text(value.deploymentRevision))
    || (value.kickoffAt !== null && !Number.isFinite(timestamp(value.kickoffAt)))
    || (value.expiresAt !== null && !Number.isFinite(timestamp(value.expiresAt)))) {
    throw new Error('L’anteprima del modello C non è verificabile.');
  }
  const preview: ChallengerPreview = {
    kind: 'C_PREVIEW', family: 'C', matchId, asOf: value.asOf, kickoffAt: value.kickoffAt,
    expiresAt: value.expiresAt, modelVersion: value.modelVersion, deploymentRevision: value.deploymentRevision,
    status: value.status, reason: value.reason, recommendationPacket: null, quote: null,
    suggestedStakePercent: 1, registered: false,
  };
  if (preview.status !== 'RECOMMENDED' && preview.status !== 'NO_BET') return preview;
  if (!text(preview.modelVersion) || !text(preview.deploymentRevision)
    || !Number.isFinite(timestamp(preview.kickoffAt)) || timestamp(preview.kickoffAt) <= now
    || !Number.isFinite(timestamp(preview.expiresAt)) || timestamp(preview.expiresAt) <= now
    || timestamp(preview.expiresAt) > timestamp(preview.kickoffAt)) return unavailable(preview, 'challenger_preview_expired');
  const packet = value.recommendationPacket;
  if (!object(packet) || packet.decisionStatus !== preview.status
    || (preview.status === 'NO_BET' ? packet.selected !== null : !object(packet.selected))) {
    throw new Error('Il consiglio dell’anteprima C non è verificabile.');
  }
  if (preview.status === 'NO_BET') return { ...preview, recommendationPacket: { selected: null, decisionStatus: 'NO_BET' } };
  const selected = packet.selected;
  const quote = value.quote;
  if (!text(selected.selection) || (selected.selectionLabel !== undefined && typeof selected.selectionLabel !== 'string')
    || (selected.bookmakerName !== undefined && typeof selected.bookmakerName !== 'string')
    || !object(quote) || quote.selection !== selected.selection || typeof quote.odds !== 'number'
    || !Number.isFinite(quote.odds) || quote.odds <= 1 || !text(quote.bookmaker)
    || quote.source !== 'odds_api' || quote.priceType !== 'prematch' || quote.timestampEvidence === 'observed_snapshot'
    || (selected.bookmakerOdds !== undefined && selected.bookmakerOdds !== quote.odds)
    || (selected.bookmakerName && selected.bookmakerName.trim().toLowerCase() !== quote.bookmaker.trim().toLowerCase())) {
    return unavailable(preview, 'challenger_preview_quote_unavailable');
  }
  if ([quote.capturedAt, quote.updatedAt].some((at) => !Number.isFinite(timestamp(at))
    || timestamp(at) > now || timestamp(at) > timestamp(preview.asOf) || now - timestamp(at) > 300_000)
    || timestamp(preview.expiresAt) > Math.min(timestamp(quote.capturedAt), timestamp(quote.updatedAt)) + 300_000) {
    return unavailable(preview, 'challenger_preview_quote_expired');
  }
  return { ...preview, recommendationPacket: { decisionStatus: 'RECOMMENDED', selected: {
    selection: selected.selection, ...(selected.selectionLabel ? { selectionLabel: selected.selectionLabel } : {}),
    bookmakerOdds: quote.odds, bookmakerName: quote.bookmaker,
  } }, quote: { selection: quote.selection, odds: quote.odds, bookmaker: quote.bookmaker, source: 'odds_api',
    capturedAt: quote.capturedAt, updatedAt: quote.updatedAt, priceType: 'prematch' } };
}

export const challengerPreviewExpired = (preview: ChallengerPreview, now = Date.now()): boolean =>
  ['RECOMMENDED', 'NO_BET'].includes(preview.status)
  && (timestamp(preview.kickoffAt) <= now || timestamp(preview.expiresAt) <= now);

/** Requests C inference only; it never calls a bet, settlement or Nightly execution route. */
export async function getChallengerPreview(matchId: string, signal?: AbortSignal): Promise<ChallengerPreview> {
  if (!matchId.trim()) throw new Error('Partita non disponibile.');
  const response = await API.post<ApiResponse<unknown>>('/research/challenger-preview', { matchId }, { signal, timeout: 45_000 });
  if (!response?.data?.success) throw new Error('L’anteprima del modello C non è disponibile.');
  return validateChallengerPreview(response.data.data, matchId);
}
