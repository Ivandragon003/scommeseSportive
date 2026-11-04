import { createHash } from 'node:crypto';

type Match = { match_id: string; source: string; source_match_id: string | number | null; date: string;
  home_team_id?: string; away_team_id?: string; home_source_team_id?: string | number | null; away_source_team_id?: string | number | null;
  home_goals: number | null; away_goals: number | null; raw_json: string | null };
type ResultSink = { appendModelAProspectiveResult: (event: { evidenceId: string; matchId: string; source: string;
  kickoffAt: string; observedAt: string; recordedAt: string; homeGoals: number; awayGoals: number; evidence: string }) => Promise<boolean> };
export type ResultCandidateOptions = { afterMatchId?: string; limit?: number };
type ReconciliationSink = Partial<ResultSink> & {
  getModelAProspectiveResultCandidates?: (options?: ResultCandidateOptions) => Promise<Match[]>;
};
export type ResultReconciliationSummary = { scanned: number; recorded: number; duplicate: number; unverified: number;
  excluded: number; failed: number; cycleComplete: boolean };

// Never let the host's timezone interpret a source timestamp. Only Understat's
// own naive datetime has the UTC convention already used by its importer.
function timestamp(value: unknown, understatDatetime = false): number {
  if (typeof value !== 'string') return NaN;
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/i.exec(value);
  if (!parts || (!parts[7] && !understatDatetime)) return NaN;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return NaN;
  return Date.parse(value.replace(' ', 'T') + (parts[7] ? '' : 'Z'));
}
const sourceId = (value: unknown): string | null => /^[1-9]\d*$/.test(String(value ?? ''))
  && Number.isSafeInteger(Number(value)) ? String(value) : null;
function verifiedTeamId(rawId: unknown, internalId?: string, storedSourceId?: string | number | null): boolean {
  if (rawId === undefined || rawId === null) return true;
  const raw = sourceId(rawId), stored = sourceId(storedSourceId);
  const encoded = sourceId(/^understat_team_([1-9]\d*)$/.exec(internalId ?? '')?.[1] ?? internalId);
  if (storedSourceId != null && !stored) return false;
  return !!raw && !(stored && encoded && stored !== encoded) && raw === (stored ?? encoded);
}

/** Timestamped Understat final evidence, not an official competition result. */
export async function recordModelAVerifiedResult(sink: ResultSink, row: Match): Promise<{ status: string; evidenceId?: string }> {
  const now = new Date();
  let raw: any;
  try { raw = JSON.parse(row.raw_json ?? ''); } catch { return { status: 'unverified' }; }
  const obs = raw?.resultObservation, match = raw?.match ?? raw;
  const encodedId = /^understat_([1-9]\d*)$/.exec(row.match_id)?.[1];
  const id = sourceId(row.source_match_id ?? encodedId);
  const status = String(match?.status ?? '').toLowerCase();
  if (['postponed', 'cancelled', 'canceled', 'suspended', 'abandoned', 'live', 'in_progress', 'started'].includes(status)) return { status };
  if (status && !['ft', 'finished', 'final', 'full_time', 'fulltime', 'complete', 'completed'].includes(status)) return { status: 'unverified' };
  const kickoff = timestamp(row.date), observed = timestamp(obs?.observedAt);
  if (row.source !== 'understat' || obs?.source !== 'understat' || match?.isResult !== true
    || !id || (encodedId && encodedId !== id) || sourceId(match.id) !== id
    || !verifiedTeamId(match.h?.id, row.home_team_id, row.home_source_team_id)
    || !verifiedTeamId(match.a?.id, row.away_team_id, row.away_source_team_id)
    || (match.h?.id != null && String(match.h.id) === String(match.a?.id))
    || (match.datetime != null && timestamp(match.datetime, true) !== kickoff)
    || ![row.home_goals, row.away_goals].every(x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0)
    || !/^(0|[1-9]\d*)$/.test(String(match.goals?.h ?? '')) || !/^(0|[1-9]\d*)$/.test(String(match.goals?.a ?? ''))
    || Number(match.goals.h) !== row.home_goals || Number(match.goals.a) !== row.away_goals
    || !Number.isFinite(kickoff) || !Number.isFinite(observed) || observed <= kickoff || observed > now.getTime()) return { status: 'unverified' };
  const kickoffAt = new Date(kickoff).toISOString(), observedAt = new Date(observed).toISOString();
  const evidence = JSON.stringify({ matchId: row.match_id, source: 'understat', sourceMatchId: id,
    homeTeamId: row.home_team_id ?? null, awayTeamId: row.away_team_id ?? null,
    sourceHomeTeamId: match.h?.id == null ? null : String(match.h.id), sourceAwayTeamId: match.a?.id == null ? null : String(match.a.id),
    sourceKickoffAt: match.datetime == null ? null : kickoffAt, sourceStatus: status || null,
    kickoffAt, observedAt, isResult: true, homeGoals: row.home_goals, awayGoals: row.away_goals });
  const evidenceId = createHash('sha256').update(evidence).digest('hex');
  const inserted = await sink.appendModelAProspectiveResult({ evidenceId, matchId: row.match_id, source: 'understat',
    kickoffAt, observedAt, recordedAt: now.toISOString(), homeGoals: row.home_goals!, awayGoals: row.away_goals!, evidence });
  return { status: inserted ? 'recorded' : 'duplicate', evidenceId };
}

const pageSize = 200;
const scans = new WeakMap<ReconciliationSink, { afterMatchId?: string; running?: Promise<ResultReconciliationSummary> }>();

/** One keyset page per tick; no wrap inside a tick and no concurrent overlapping scans. */
export async function reconcileModelAProspectiveResults(sink: ReconciliationSink): Promise<ResultReconciliationSummary> {
  let scan = scans.get(sink);
  if (!scan) { scan = {}; scans.set(sink, scan); }
  if (scan.running) return scan.running;
  const current = scan;
  const run = async (): Promise<ResultReconciliationSummary> => {
    const summary = { scanned: 0, recorded: 0, duplicate: 0, unverified: 0, excluded: 0, failed: 0, cycleComplete: true };
    if (!sink.getModelAProspectiveResultCandidates || !sink.appendModelAProspectiveResult) return summary;
    const rows = await sink.getModelAProspectiveResultCandidates({ afterMatchId: current.afterMatchId, limit: pageSize });
    summary.scanned = rows.length;
    summary.cycleComplete = rows.length < pageSize;
    // Advance even after a single write fails; retry failures on the next cycle.
    current.afterMatchId = summary.cycleComplete ? undefined : rows[rows.length - 1].match_id;
    for (const row of rows) {
      try {
        const result = await recordModelAVerifiedResult(sink as ResultSink, row);
        if (result.status === 'recorded' || result.status === 'duplicate' || result.status === 'unverified') summary[result.status]++;
        else summary.excluded++;
      } catch {
        summary.failed++;
        console.error('[ModelAProspective] result observation write failed');
      }
    }
    return summary;
  };
  current.running = run();
  try { return await current.running; } finally { current.running = undefined; }
}
