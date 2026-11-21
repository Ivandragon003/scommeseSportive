import { SOURCE_FEED_COOLDOWN_MS, SOURCE_FEED_PROVIDER } from '../services/FootballDataOrgFeed';
import { LOCAL_COMPETITIONS } from '../services/SourceFeedImport';

export const STALE_CALENDAR_REASON = 'source_feed_stale';
export const staleCalendarPair = (reasons?: { A?: string | null; C?: string | null }) =>
  reasons?.A === STALE_CALENDAR_REASON && reasons.C === STALE_CALENDAR_REASON;
const age = SOURCE_FEED_COOLDOWN_MS;
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = (value: unknown) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
export type CalendarReceipt = { requestedAt: string; acquiredAt: string; finishedAt: string; contentSha256: string; payloadSha256: string };
type Executor = { execute(statement: { sql: string; args: any[] }): Promise<{ rows: readonly any[] }> };

/** Use the actual last attempt known at admission, including later failed/pending attempts. */
function receiptStatement(snapshot: any) {
  const scope = Object.entries(LOCAL_COMPETITIONS).find(([, name]) => name === snapshot?.match?.competition)?.[0];
  const asOf = snapshot?.metadata?.sourceAdmission?.asOf;
  if (!scope || !Number.isFinite(time(asOf))) return null;
  return { sql: `SELECT a.requested_at,a.acquired_at,a.finished_at,a.status,
    a.snapshot_hash,a.payload_sha256,s.content_sha256 FROM matches m
    JOIN source_feed_attempts a ON a.id=(SELECT t.id FROM source_feed_attempts t WHERE t.provider=? AND t.competition=?
      AND t.season=CAST(substr(m.season,1,4) AS INTEGER) AND t.requested_at<=? ORDER BY t.id DESC LIMIT 1)
    LEFT JOIN source_feed_snapshots s ON s.provider=a.provider AND s.competition=a.competition AND s.season=a.season
      AND s.schema_version=1 AND s.content_sha256=a.snapshot_hash
    WHERE m.match_id=? AND m.competition=? AND m.date=? LIMIT 1`, args: [SOURCE_FEED_PROVIDER, scope, asOf,
      snapshot.match.matchId,snapshot.match.competition,snapshot.match.kickoffAt] };
}

function receiptFromRow(row: any, asOf: string): CalendarReceipt | null {
  if (!row || row.status !== 'success' || !hash(row.snapshot_hash) || row.content_sha256 !== row.snapshot_hash
    || !hash(row.payload_sha256) || !(time(row.requested_at) <= time(row.acquired_at)
      && time(row.acquired_at) <= time(row.finished_at) && time(row.finished_at) <= time(asOf))) return null;
  return { requestedAt: row.requested_at, acquiredAt: row.acquired_at, finishedAt: row.finished_at,
    contentSha256: row.snapshot_hash, payloadSha256: row.payload_sha256 };
}

export async function recoveryCalendarReceipt(db: Executor, snapshot: any): Promise<CalendarReceipt | null> {
  const query = receiptStatement(snapshot);
  return query ? receiptFromRow((await db.execute(query)).rows[0], snapshot.metadata.sourceAdmission.asOf) : null;
}

export async function recoveryCalendarReceipts(db: Pick<import('@libsql/client').Transaction, 'batch'>,
  snapshots: any[]): Promise<Array<CalendarReceipt | null>> {
  const receipts = snapshots.map((): CalendarReceipt | null => null);
  const queries = snapshots.flatMap((snapshot, index) => {
    const statement = receiptStatement(snapshot);
    return statement ? [{ index, statement, asOf: snapshot.metadata.sourceAdmission.asOf }] : [];
  });
  if (queries.length) {
    const results = await db.batch(queries.map(row => row.statement));
    queries.forEach((query, i) => { receipts[query.index] = receiptFromRow(results[i].rows[0], query.asOf); });
  }
  return receipts;
}

export function calendarExpiredDuringRun(snapshot: any, start: string, receipt?: CalendarReceipt | null): boolean {
  const gate = snapshot?.metadata?.sourceAdmission;
  const onlyStale = (check: any) => check?.eligible === false && Array.isArray(check.reasons)
    && check.reasons.includes(STALE_CALENDAR_REASON) && check.reasons.every((r: string) =>
      r === STALE_CALENDAR_REASON || r === 'calendar_stale_or_unavailable');
  return !!receipt && gate?.matchId === snapshot.match?.matchId && onlyStale(gate.common)
    && [gate.families?.A,gate.families?.C,gate.markets?.goal?.A,gate.markets?.goal?.C].every(onlyStale)
    && time(receipt.finishedAt) <= time(start) && time(start) < time(receipt.acquiredAt) + age
    && time(gate.asOf) >= time(receipt.acquiredAt) + age && time(gate.asOf) <= time(snapshot.observedAt);
}

export function calendarRecovered(snapshot: any, claimedAt: string, now: number, receipt: CalendarReceipt | null): boolean {
  const gate = snapshot?.metadata?.sourceAdmission, evidence = gate?.calendarEvidence;
  return !!receipt && gate?.matchId === snapshot.match?.matchId && gate.common?.eligible === true
    && Array.isArray(gate.common.reasons) && gate.common.reasons.length === 0 && !!evidence
    && evidence.attempt === receipt.requestedAt && evidence.acquisition === receipt.acquiredAt
    && evidence.payloadSha256 === receipt.payloadSha256 && evidence.contentSha256 === receipt.contentSha256
    && hash(evidence.mappingSha256) && hash(evidence.importManifestSha256)
    && ['NO_CHANGE','UPDATE_KICKOFF','CREATE_FIXTURE'].includes(evidence.action)
    && time(claimedAt) <= time(gate.asOf) && time(gate.asOf) <= time(snapshot.observedAt)
    && time(snapshot.observedAt) <= now && now < time(receipt.acquiredAt) + age;
}
