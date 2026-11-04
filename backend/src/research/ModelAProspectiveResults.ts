import { createHash } from 'node:crypto';

type Match = { match_id: string; source: string; source_match_id: string | number | null; date: string;
  home_goals: number | null; away_goals: number | null; raw_json: string | null };
type ResultSink = { appendModelAProspectiveResult: (event: { evidenceId: string; matchId: string; source: string;
  kickoffAt: string; observedAt: string; recordedAt: string; homeGoals: number; awayGoals: number; evidence: string }) => Promise<boolean> };
const withZone = (value: unknown) => typeof value === 'string' && /(?:z|[+-]\d\d:\d\d)$/i.test(value) && Number.isFinite(Date.parse(value));

/** Explicit opt-in association: reject scores without timestamped Understat final evidence. */
export async function recordModelAVerifiedResult(sink: ResultSink, row: Match): Promise<{ status: string; evidenceId?: string }> {
  const now = new Date();
  let raw: any;
  try { raw = JSON.parse(row.raw_json ?? ''); } catch { return { status: 'unverified' }; }
  const obs = raw?.resultObservation, match = raw?.match ?? raw;
  const sourceId = row.source_match_id ?? /^understat_([1-9]\d*)$/.exec(row.match_id)?.[1];
  const status = String(match?.status ?? '').toLowerCase();
  if (['postponed', 'cancelled', 'canceled', 'suspended', 'abandoned', 'live', 'in_progress', 'started'].includes(status)) return { status };
  if (status && !['ft', 'finished', 'final', 'full_time', 'fulltime', 'complete', 'completed'].includes(status)) return { status: 'unverified' };
  if (row.source !== 'understat' || obs?.source !== 'understat' || match?.isResult !== true
    || !/^[1-9]\d*$/.test(String(sourceId ?? '')) || String(match.id) !== String(sourceId)
    || ![row.home_goals, row.away_goals].every(x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0)
    || !/^(0|[1-9]\d*)$/.test(String(match.goals?.h ?? '')) || !/^(0|[1-9]\d*)$/.test(String(match.goals?.a ?? ''))
    || Number(match.goals.h) !== row.home_goals || Number(match.goals.a) !== row.away_goals
    || !withZone(row.date) || !withZone(obs.observedAt) || Date.parse(obs.observedAt) <= Date.parse(row.date)
    || Date.parse(obs.observedAt) > now.getTime() || !Number.isFinite(now.getTime())) return { status: 'unverified' };
  const evidence = JSON.stringify({ matchId: row.match_id, source: 'understat', sourceMatchId: String(sourceId),
    kickoffAt: row.date, observedAt: obs.observedAt, isResult: true, homeGoals: row.home_goals, awayGoals: row.away_goals });
  const evidenceId = createHash('sha256').update(evidence).digest('hex');
  const inserted = await sink.appendModelAProspectiveResult({ evidenceId, matchId: row.match_id, source: 'understat',
    kickoffAt: row.date, observedAt: obs.observedAt, recordedAt: now.toISOString(), homeGoals: row.home_goals!, awayGoals: row.away_goals!, evidence });
  return { status: inserted ? 'recorded' : 'duplicate', evidenceId };
}

/** Called by the optional recorder recovery loop; never mutates historical matches. */
export async function reconcileModelAProspectiveResults(sink: Partial<ResultSink> & { getModelAProspectiveResultCandidates?: () => Promise<Match[]> }): Promise<void> {
  if (!sink.getModelAProspectiveResultCandidates || !sink.appendModelAProspectiveResult) return;
  const rows = await sink.getModelAProspectiveResultCandidates();
  for (const row of rows) await recordModelAVerifiedResult(sink as ResultSink, row);
}
