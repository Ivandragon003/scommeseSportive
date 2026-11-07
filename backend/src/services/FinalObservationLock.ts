import { createHash } from 'node:crypto';

export const OBSERVATION_FIELDS = ['home_goals', 'away_goals', 'home_xg', 'away_xg'] as const;
export type ObservationField = typeof OBSERVATION_FIELDS[number];
export type FinalObservation = { matchId: string; field: ObservationField; value: number; source: 'understat'; evidenceJson: string; evidenceSha256: string };
const name = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** An observation preserves source evidence, not a claim that the provider is infallible. */
export function assessFinalObservations(row: Record<string, any>): { observations: FinalObservation[]; reasons: Record<ObservationField, string> } {
  const reasons = {} as Record<ObservationField, string>;
  const observations: FinalObservation[] = [];
  let raw: any;
  try { raw = JSON.parse(row.raw_json); } catch { raw = null; }
  const match = raw?.match ?? raw;
  const identity = row.source === 'understat' && match?.isResult === true
    && String(match.id) === String(row.source_match_id ?? String(row.match_id).replace(/^understat_/, ''))
    && String(row.match_id) === `understat_${match.id}`
    && match.h?.id != null && match.a?.id != null && String(match.h.id) !== String(match.a.id)
    && (!Object.prototype.hasOwnProperty.call(row, 'home_source_team_id') ||
      (row.home_source_team_id != null && row.away_source_team_id != null
        && String(match.h.id) === String(row.home_source_team_id) && String(match.a.id) === String(row.away_source_team_id)))
    && !!name(row.home_team_name) && !!name(row.away_team_name)
    && name(match.h.title) === name(row.home_team_name) && name(match.a.title) === name(row.away_team_name)
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(match.datetime ?? ''))
    && Date.parse(`${String(match.datetime).replace(' ', 'T')}Z`) === Date.parse(String(row.date ?? ''))
    && row.home_goals != null && row.away_goals != null;
  for (const field of OBSERVATION_FIELDS) {
    const value = row[field];
    const side = field.startsWith('home_') ? 'h' : 'a';
    const sourceValue = field.endsWith('_goals') ? match?.goals?.[side] : match?.xG?.[side];
    if (value == null) { reasons[field] = 'missing'; continue; }
    if (!identity) { reasons[field] = 'source_identity_or_result_unverified'; continue; }
    if ((typeof sourceValue !== 'string' && typeof sourceValue !== 'number') || String(sourceValue).trim() === ''
      || !Number.isFinite(Number(sourceValue)) || Number(sourceValue) < 0
      || Number(value) !== Number(sourceValue)
      || (field.endsWith('_goals') && !Number.isSafeInteger(Number(value)))) {
      reasons[field] = 'source_value_missing_or_mismatch'; continue;
    }
    const evidenceJson = JSON.stringify({ provider: 'understat', matchId: String(match.id), field, sourceValue, match });
    observations.push({ matchId: String(row.match_id), field, value: Number(value), source: 'understat', evidenceJson,
      evidenceSha256: createHash('sha256').update(evidenceJson).digest('hex') });
    reasons[field] = 'eligible_source_evidence';
  }
  return { observations, reasons };
}
