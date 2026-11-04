import { createHash, randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { UnderstatScraper, UnderstatMatch } from '../services/UnderstatScraper';
import { recordModelAVerifiedResult } from './ModelAProspectiveResults';

const DAY = 86400000;
const COMPETITIONS = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];
export type ResultRefreshCandidate = {
  match_id: string; source: string; source_match_id: string | number | null; date: string;
  home_team_id: string; away_team_id: string; home_source_team_id?: string | number | null;
  away_source_team_id?: string | number | null; competition: string; season: string; current_kickoff_at?: string;
};
export type ResultLifecycleStatus = 'final' | 'postponed' | 'canceled' | 'not_final' | 'missing' | 'conflict' | 'unverified' | 'provider_error';
export type ResultLifecycleObservation = {
  evidenceId: string; matchId: string; source: string; kickoffAt: string; observedAt: string;
  recordedAt: string; status: ResultLifecycleStatus; reason: string; evidence: string;
};
type ResultEvent = Parameters<Parameters<typeof recordModelAVerifiedResult>[0]['appendModelAProspectiveResult']>[0];
type RefreshCursor = { afterMatchId?: string; afterKickoffAt?: string; pendingAfter?: string };
export type ResultRefreshSink = {
  getModelAProspectiveResultRefreshCandidates: (options: { afterMatchId?: string; afterKickoffAt?: string; from: string; to: string; limit: number }) => Promise<ResultRefreshCandidate[]>;
  appendModelAProspectiveResult: (event: ResultEvent) => Promise<boolean>;
  appendModelAProspectiveResultObservation: (event: ResultLifecycleObservation) => Promise<boolean>;
  getModelAProspectivePendingFinalObservations?: (options: { afterEvidenceId?: string; limit: number }) => Promise<ResultLifecycleObservation[]>;
  acquireModelAProspectiveResultRefreshLease?: (owner: string, startedAt: string) => Promise<RefreshCursor | null>;
  renewModelAProspectiveResultRefreshLease?: (owner: string) => Promise<boolean>;
  completeModelAProspectiveResultRefresh?: (owner: string, cursor: RefreshCursor, completedAt: string, summary: ResultRefreshSummary) => Promise<void>;
};
export type ResultRefreshSummary = {
  status: 'disabled' | 'busy' | 'completed' | 'partial'; scanned: number; recorded: number; duplicate: number;
  observations: number; recovered: number; failed: number; cycleComplete: boolean;
  from: string; to: string; reasonCounts: Record<string, number>;
};
type RefreshOptions = { env?: NodeJS.ProcessEnv; source?: Pick<UnderstatScraper, 'scrapeSeason'>;
  clock?: () => Date; pageSize?: number; correctionHorizonDays?: number };
type Scan = RefreshCursor & { running?: Promise<ResultRefreshSummary> };
const scans = new WeakMap<ResultRefreshSink, Scan>();
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): string | null => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? String(value) : null;
function timestamp(value: unknown, understat = false): number {
  if (typeof value !== 'string') return NaN;
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/i.exec(value);
  if (!parts || (!parts[7] && !understat)) return NaN;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return NaN;
  return Date.parse(value.replace(' ', 'T') + (parts[7] ? '' : 'Z'));
}
function teamId(internal: string, stored: unknown): string | null {
  const encoded = id(/^understat_team_([1-9]\d*)$/.exec(internal ?? '')?.[1] ?? internal);
  const external = id(stored);
  return stored != null && (!external || (encoded && encoded !== external)) ? null : external ?? encoded;
}
function candidateReason(row: ResultRefreshCandidate, from: number, to: number): string | null {
  const kickoff = timestamp(row.date), encoded = /^understat_([1-9]\d*)$/.exec(row.match_id)?.[1];
  if (!Number.isFinite(kickoff) || kickoff < from || kickoff > to) return 'candidate_outside_horizon';
  if (row.source !== 'understat' || !encoded || id(row.source_match_id) !== encoded) return 'candidate_identity_unverified';
  if (!COMPETITIONS.includes(row.competition) || !/^\d{4}\/(?:\d{2}|\d{4})$/.test(row.season)) return 'candidate_scope_unverified';
  if (!teamId(row.home_team_id, row.home_source_team_id) || !teamId(row.away_team_id, row.away_source_team_id)
    || teamId(row.home_team_id, row.home_source_team_id) === teamId(row.away_team_id, row.away_source_team_id)) return 'candidate_team_identity_unverified';
  return null;
}
function inspect(row: ResultRefreshCandidate, found: UnderstatMatch): { status: ResultLifecycleStatus; reason: string; raw?: Record<string, any> } {
  let raw: any;
  try { if (typeof found.rawJson !== 'string' || found.rawJson.length > 65536) throw new Error(); raw = JSON.parse(found.rawJson); }
  catch { return { status: 'unverified', reason: 'provider_payload_invalid' }; }
  if (!object(raw)) return { status: 'unverified', reason: 'provider_payload_invalid' };
  if (id(raw.id) !== id(row.source_match_id) || found.matchId !== row.match_id || id(found.sourceMatchId) !== id(raw.id)
    || id(raw.h?.id) !== teamId(row.home_team_id, row.home_source_team_id)
    || id(raw.a?.id) !== teamId(row.away_team_id, row.away_source_team_id)
    || id(found.homeTeamId) !== id(raw.h?.id) || id(found.awayTeamId) !== id(raw.a?.id)
    || found.competition !== row.competition || found.season !== row.season) return { status: 'conflict', reason: 'provider_identity_mismatch', raw };
  const providerKickoff = timestamp(raw.datetime, true);
  if (!Number.isFinite(providerKickoff) || timestamp(found.date, true) !== providerKickoff) return { status: 'unverified', reason: 'provider_kickoff_invalid', raw };
  const status = String(raw.status ?? '').toLowerCase();
  // Explicit cancellation/postponement is retained even when its new date differs.
  if (['postponed', 'suspended', 'abandoned'].includes(status)) return { status: 'postponed', reason: `provider_${status}`, raw };
  if (['cancelled', 'canceled'].includes(status)) return { status: 'canceled', reason: 'provider_canceled', raw };
  if (providerKickoff !== timestamp(row.date) || (row.current_kickoff_at && timestamp(row.current_kickoff_at) !== timestamp(row.date)))
    return { status: 'conflict', reason: 'kickoff_changed', raw };
  if (raw.isResult === false) return { status: 'not_final', reason: 'provider_not_final', raw };
  if (raw.isResult !== true || (status && !['ft', 'finished', 'final', 'full_time', 'fulltime', 'complete', 'completed'].includes(status)))
    return { status: 'unverified', reason: 'provider_final_unverified', raw };
  const score = (v: unknown) => /^(0|[1-9]\d*)$/.test(String(v ?? '')) && Number.isSafeInteger(Number(v));
  if (!score(raw.goals?.h) || !score(raw.goals?.a) || found.homeGoals !== Number(raw.goals.h) || found.awayGoals !== Number(raw.goals.a))
    return { status: 'unverified', reason: 'provider_score_invalid', raw };
  return { status: 'final', reason: 'provider_final_observed', raw };
}

/** Opt-in, bounded research evidence refresh. No operational fixture/result is updated. */
export async function refreshModelAProspectiveResults(sink: ResultRefreshSink, options: RefreshOptions = {}): Promise<ResultRefreshSummary> {
  const env = options.env ?? process.env;
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  if (!Number.isFinite(now.getTime())) throw new Error('result_refresh_clock_invalid');
  const days = options.correctionHorizonDays ?? 30, limit = options.pageSize ?? 20;
  if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('result_refresh_bounds_invalid');
  const from = new Date(now.getTime() - days * DAY).toISOString(), to = now.toISOString();
  const empty = (): ResultRefreshSummary => ({ status: 'disabled', scanned: 0, recorded: 0, duplicate: 0, observations: 0, recovered: 0,
    failed: 0, cycleComplete: true, from, to, reasonCounts: {} });
  if (env.MODEL_A_PROSPECTIVE_ENABLED !== 'true' || env.MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED !== 'true') return empty();
  let state = scans.get(sink);
  if (!state) { state = {}; scans.set(sink, state); }
  if (state.running) return state.running;
  const current = state;
  const run = async () => {
    const summary = empty(); summary.status = 'completed';
    const owner = randomUUID();
    if (sink.acquireModelAProspectiveResultRefreshLease) {
      const cursor = await sink.acquireModelAProspectiveResultRefreshLease(owner, to);
      if (!cursor) { summary.status = 'busy'; summary.cycleComplete = false; return summary; }
      current.afterMatchId = cursor.afterMatchId; current.afterKickoffAt = cursor.afterKickoffAt; current.pendingAfter = cursor.pendingAfter;
    }
    const initialCursor: RefreshCursor = { afterMatchId: current.afterMatchId, afterKickoffAt: current.afterKickoffAt, pendingAfter: current.pendingAfter };
    const reason = (code: string) => { summary.reasonCounts[code] = (summary.reasonCounts[code] ?? 0) + 1; };
    const renew = async () => {
      if (sink.renewModelAProspectiveResultRefreshLease && !(await sink.renewModelAProspectiveResultRefreshLease(owner))) throw new Error('result_refresh_lease_lost');
    };
    const writeFinal = async (observation: ResultLifecycleObservation, recovered = false) => {
      const parsed = JSON.parse(observation.evidence);
      if (!object(parsed.resultRow)) throw new Error('pending_result_evidence_invalid');
      const result = await recordModelAVerifiedResult(sink, parsed.resultRow);
      if (result.status === 'recorded') { summary.recorded++; if (recovered) summary.recovered++; }
      else if (result.status === 'duplicate') summary.duplicate++;
      else throw new Error('pending_result_verification_failed');
    };
    try {
      // Evidence persisted before a failed result write is replayed with its original
      // fetch timestamp. Recovery is paginated independently, including after restart.
      if (sink.getModelAProspectivePendingFinalObservations) {
        try {
          const pending = await sink.getModelAProspectivePendingFinalObservations({ afterEvidenceId: current.pendingAfter, limit });
          current.pendingAfter = pending.length < limit ? undefined : pending[pending.length - 1].evidenceId;
          for (const observation of pending) {
            await renew();
            try { await writeFinal(observation, true); }
            catch { summary.failed++; reason('pending_result_write_failed'); }
          }
        } catch { summary.failed++; reason('pending_result_query_failed'); }
      }
      const rows = await sink.getModelAProspectiveResultRefreshCandidates({ afterMatchId: current.afterMatchId, afterKickoffAt: current.afterKickoffAt, from, to, limit });
      if (!Array.isArray(rows) || rows.length > limit) throw new Error('result_refresh_candidates_invalid');
      summary.scanned = rows.length; summary.cycleComplete = rows.length < limit;
      current.afterMatchId = summary.cycleComplete ? undefined : rows[rows.length - 1].match_id;
      current.afterKickoffAt = summary.cycleComplete ? undefined : rows[rows.length - 1].date;
      const feeds = new Map<string, Promise<{ matches: UnderstatMatch[]; observedAt: string }>>();
      const source = options.source ?? new UnderstatScraper();
      const fetch = (row: ResultRefreshCandidate) => {
        const key = JSON.stringify([row.competition, row.season]);
        if (!feeds.has(key)) feeds.set(key, (async () => {
          const matches = await source.scrapeSeason(row.competition, row.season, { includeDetails: false });
          if (!Array.isArray(matches) || matches.length > 1000) throw new Error('provider_payload_invalid');
          const observed = clock();
          if (!Number.isFinite(observed.getTime()) || observed < now || observed.getTime() > Date.now()) throw new Error('provider_observation_time_invalid');
          return { matches, observedAt: observed.toISOString() };
        })());
        return feeds.get(key)!;
      };
      for (const row of rows) {
        await renew();
        let status: ResultLifecycleStatus = 'unverified', code = candidateReason(row, Date.parse(from), Date.parse(to));
        let raw: Record<string, any> | undefined, observedAt = to;
        try {
          if (!code) {
            try {
              const feed = await fetch(row); observedAt = feed.observedAt;
              const matches = feed.matches.filter(m => m?.matchId === row.match_id || id(m?.sourceMatchId) === id(row.source_match_id));
              if (matches.length === 0) { status = 'missing'; code = 'provider_match_missing'; }
              else if (matches.length !== 1) { status = 'conflict'; code = 'provider_duplicate_match'; }
              else { const inspection = inspect(row, matches[0]); status = inspection.status; code = inspection.reason; raw = inspection.raw; }
            } catch (error) {
              status = 'provider_error';
              code = error instanceof Error && ['provider_payload_invalid', 'provider_observation_time_invalid'].includes(error.message) ? error.message : 'provider_fetch_failed';
              observedAt = clock().toISOString();
            }
          }
          // A clock at/before kickoff cannot confirm a final result.
          if (status === 'final' && timestamp(observedAt) <= timestamp(row.date)) { status = 'unverified'; code = 'final_observation_not_after_kickoff'; }
          const kickoffAt = new Date(timestamp(row.date)).toISOString();
          const resultRow = status === 'final' ? { ...row, date: kickoffAt, home_goals: Number(raw!.goals.h), away_goals: Number(raw!.goals.a),
            raw_json: JSON.stringify({ match: raw, resultObservation: { source: 'understat', observedAt } }) } : null;
          const evidence = JSON.stringify({ matchId: row.match_id, source: 'understat', sourceMatchId: row.source_match_id,
            kickoffAt, currentKickoffAt: row.current_kickoff_at ?? null, observedAt, providerPublishedAt: null,
            status, reason: code, raw: raw ?? null, resultRow });
          const evidenceId = createHash('sha256').update(evidence).digest('hex');
          const observation = { evidenceId, matchId: row.match_id, source: 'understat', kickoffAt, observedAt,
            recordedAt: clock().toISOString(), status, reason: code!, evidence };
          await renew();
          if (await sink.appendModelAProspectiveResultObservation(observation)) summary.observations++;
          reason(code!);
          if (status === 'provider_error') summary.status = 'partial';
          if (status === 'final') await writeFinal(observation);
        } catch { summary.failed++; reason('result_observation_write_failed'); }
      }
      if (summary.failed) summary.status = 'partial';
    } catch (error) {
      summary.failed++; summary.status = 'partial';
      reason(error instanceof Error && error.message === 'result_refresh_lease_lost' ? error.message : 'result_refresh_run_failed');
      // An incomplete page is retried after restart, rather than silently skipped.
      current.afterMatchId = initialCursor.afterMatchId; current.afterKickoffAt = initialCursor.afterKickoffAt; current.pendingAfter = initialCursor.pendingAfter;
    }
    if (sink.completeModelAProspectiveResultRefresh) await sink.completeModelAProspectiveResultRefresh(owner,
      { afterMatchId: current.afterMatchId, afterKickoffAt: current.afterKickoffAt, pendingAfter: current.pendingAfter }, clock().toISOString(), summary);
    return summary;
  };
  current.running = run();
  try { return await current.running; } finally { current.running = undefined; }
}

/** Research evidence is append-only; mutable coordination metadata never changes it. No bootstrap. */
export function createModelAProspectiveResultRefreshSink(client: Pick<Client, 'execute'>): ResultRefreshSink {
  const execute = (sql: string, args: any[] = []) => client.execute({ sql, args });
  const append = async (table: string, event: ResultEvent | ResultLifecycleObservation, columns: string[], values: any[]) => {
    const inserted = await execute(`INSERT OR IGNORE INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, values);
    if (inserted.rowsAffected === 1) return true;
    const existing = (await execute(`SELECT * FROM ${table} WHERE evidence_id=?`, [event.evidenceId])).rows[0];
    if (!existing || columns.some((column, index) => column !== 'recorded_at' && existing[column] !== values[index])) throw new Error('conflicting prospective result identifier');
    return false;
  };
  const refreshId = 'understat-results-v1';
  return {
    async acquireModelAProspectiveResultRefreshLease(owner, startedAt) {
      await execute('INSERT OR IGNORE INTO model_a_prospective_result_refresh_state(refresh_id,last_status) VALUES (?,\'never_run\')', [refreshId]);
      const acquired = await execute(`UPDATE model_a_prospective_result_refresh_state
        SET lease_owner=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),last_started_at=?,last_status='running'
        WHERE refresh_id=? AND (lease_owner IS NULL OR julianday(lease_until)<=julianday('now'))`, [owner, startedAt, refreshId]);
      if (acquired.rowsAffected !== 1) return null;
      const row = (await execute('SELECT after_match_id,after_kickoff_at,pending_after_evidence_id FROM model_a_prospective_result_refresh_state WHERE refresh_id=? AND lease_owner=?', [refreshId, owner])).rows[0];
      if (!row) throw new Error('result_refresh_lease_lost');
      return { afterMatchId: row.after_match_id == null ? undefined : String(row.after_match_id), afterKickoffAt: row.after_kickoff_at == null ? undefined : String(row.after_kickoff_at),
        pendingAfter: row.pending_after_evidence_id == null ? undefined : String(row.pending_after_evidence_id) };
    },
    async renewModelAProspectiveResultRefreshLease(owner) {
      return (await execute(`UPDATE model_a_prospective_result_refresh_state SET lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')
        WHERE refresh_id=? AND lease_owner=? AND julianday(lease_until)>julianday('now')`, [refreshId, owner])).rowsAffected === 1;
    },
    async completeModelAProspectiveResultRefresh(owner, cursor, completedAt, summary) {
      const error = summary.status === 'completed' ? null : Object.keys(summary.reasonCounts).find(code => /failed|invalid|lost/.test(code)) ?? 'result_refresh_partial';
      const result = await execute(`UPDATE model_a_prospective_result_refresh_state SET after_match_id=?,after_kickoff_at=?,pending_after_evidence_id=?,
        last_completed_at=?,last_success_at=CASE WHEN ?='completed' THEN ? ELSE last_success_at END,last_status=?,last_error_code=?,last_summary_json=?,lease_owner=NULL,lease_until=NULL
        WHERE refresh_id=? AND lease_owner=? AND julianday(lease_until)>julianday('now')`,
      [cursor.afterMatchId ?? null, cursor.afterKickoffAt ?? null, cursor.pendingAfter ?? null, completedAt, summary.status, completedAt,
        summary.status, error, JSON.stringify(summary), refreshId, owner]);
      if (result.rowsAffected !== 1) throw new Error('result_refresh_lease_lost');
    },
    async getModelAProspectiveResultRefreshCandidates(options) {
      const rows = await execute(`WITH forecast AS (
        SELECT f.*, row_number() OVER (PARTITION BY f.match_id,julianday(f.kickoff_at) ORDER BY julianday(f.forecast_at),f.id) AS rank
        FROM model_a_prospective_forecasts f WHERE julianday(f.kickoff_at)>=julianday(?) AND julianday(f.kickoff_at)<=julianday(?) AND json_valid(f.payload_json)
      ) SELECT f.match_id,m.source,m.source_match_id,f.kickoff_at AS date,m.date AS current_kickoff_at,
        json_extract(f.payload_json,'$.homeTeamId') AS home_team_id,json_extract(f.payload_json,'$.awayTeamId') AS away_team_id,
        json_extract(f.payload_json,'$.competition') AS competition,json_extract(f.payload_json,'$.season') AS season,
        ht.source_team_id AS home_source_team_id,at.source_team_id AS away_source_team_id
      FROM forecast f LEFT JOIN matches m ON m.match_id=f.match_id
      LEFT JOIN teams ht ON ht.team_id=json_extract(f.payload_json,'$.homeTeamId')
      LEFT JOIN teams at ON at.team_id=json_extract(f.payload_json,'$.awayTeamId')
      WHERE f.rank=1 AND (f.match_id>? OR (f.match_id=? AND f.kickoff_at>?)) ORDER BY f.match_id,f.kickoff_at LIMIT ?`,
      [options.from, options.to, options.afterMatchId ?? '', options.afterMatchId ?? '', options.afterKickoffAt ?? '', options.limit]);
      return rows.rows as unknown as ResultRefreshCandidate[];
    },
    appendModelAProspectiveResult(event) {
      return append('model_a_prospective_results', event, ['evidence_id', 'match_id', 'source', 'kickoff_at', 'observed_at', 'recorded_at', 'home_goals', 'away_goals', 'evidence_json'],
        [event.evidenceId, event.matchId, event.source, event.kickoffAt, event.observedAt, event.recordedAt, event.homeGoals, event.awayGoals, event.evidence]);
    },
    appendModelAProspectiveResultObservation(event) {
      return append('model_a_prospective_result_observations', event, ['evidence_id', 'match_id', 'source', 'kickoff_at', 'observed_at', 'recorded_at', 'status', 'reason', 'evidence_json'],
        [event.evidenceId, event.matchId, event.source, event.kickoffAt, event.observedAt, event.recordedAt, event.status, event.reason, event.evidence]);
    },
    async getModelAProspectivePendingFinalObservations(options) {
      const result = await execute(`SELECT o.* FROM model_a_prospective_result_observations o
        WHERE o.status='final' AND o.evidence_id>? AND NOT EXISTS (SELECT 1 FROM model_a_prospective_results r
          WHERE r.match_id=o.match_id AND r.kickoff_at=o.kickoff_at AND r.observed_at=o.observed_at AND r.source=o.source
            AND r.home_goals=json_extract(o.evidence_json,'$.resultRow.home_goals')
            AND r.away_goals=json_extract(o.evidence_json,'$.resultRow.away_goals'))
        ORDER BY o.evidence_id LIMIT ?`, [options.afterEvidenceId ?? '', options.limit]);
      return result.rows.map(r => ({ evidenceId: String(r.evidence_id), matchId: String(r.match_id), source: String(r.source), kickoffAt: String(r.kickoff_at),
        observedAt: String(r.observed_at), recordedAt: String(r.recorded_at), status: r.status as ResultLifecycleStatus, reason: String(r.reason), evidence: String(r.evidence_json) }));
    }
  };
}
