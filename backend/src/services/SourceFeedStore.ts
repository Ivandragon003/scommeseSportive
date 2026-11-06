import { createHash } from 'node:crypto';
import {
  FootballDataOrgSnapshot, SOURCE_FEED_COOLDOWN_MS, SOURCE_FEED_MIN_REQUEST_INTERVAL_MS, SOURCE_FEED_PROVIDER, SOURCE_FEED_VERSION,
  SOURCE_FEED_TRANSIENT_FAILURE_BACKOFF_MS, SOURCE_FEED_TRANSIENT_FAILURE_REASONS, sourceFeedUtc, validateSourceFeedScope,
} from './FootballDataOrgFeed';
import type { FootballDataCompetition } from './modelAResearchCalendar';

export const SOURCE_FEED_CACHE_MARKER = 'dedicated_source_feed_cache_v2';
type Statement = { sql: string; args: Array<string | number | null> };
export interface SourceFeedClient {
  execute(statement: Statement | string): Promise<{ rows: any[]; rowsAffected?: number }>;
  batch(statements: Statement[], mode?: 'write' | 'read' | 'deferred'): Promise<any[]>;
}
export interface SourceFeedAttempt {
  id: number;
  requestedAt: string;
  finishedAt: string | null;
  status: 'pending' | 'success' | 'failure';
  snapshotHash: string | null;
  acquiredAt: string | null;
  payloadSha256: string | null;
  reason: string | null;
}
export interface SourceFeedState {
  provider: string;
  competition: FootballDataCompetition;
  season: number;
  available: boolean;
  status: 'available' | 'stale' | 'failure' | 'pending' | 'unavailable';
  reason: string | null;
  latestAttempt: SourceFeedAttempt | null;
  /** Persisted attempt completion, distinct from acquisition freshness and unchanged on cache hits. */
  lastVerifiedAt: string | null;
  snapshot: FootballDataOrgSnapshot | null;
}

const time = (value: string): string => {
  const normalized = sourceFeedUtc(value);
  if (!normalized) throw Error('source_feed_invalid_time');
  return normalized;
};
const safeReason = (reason: string): string => /^(?:source_feed_[a-z_]{1,90}|calendar_(?:http_\d{3}|timeout|network_error|invalid_json|response_too_large|invalid_configuration))$/.test(reason)
  ? reason : 'source_feed_fetch_failed';

/** Cache can also use its namespaced tables in an explicitly provisioned shared DB. */
export class SourceFeedStore {
  private initialized = false;
  constructor(private readonly client: SourceFeedClient) {}

  async initialize(options: { allowCreate?: boolean; shared?: boolean } = {}): Promise<void> {
    const objects = await this.client.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'");
    const allowed = new Set(['source_feed_meta', 'source_feed_attempts', 'source_feed_snapshots']);
    const cacheObjects = options.shared ? objects.rows.filter((row) => allowed.has(String(row.name))) : objects.rows;
    if (cacheObjects.some((row) => row.type !== 'table' || !allowed.has(String(row.name)))) throw Error('source_feed_database_not_dedicated');
    if (cacheObjects.length > 0) {
      if (cacheObjects.length !== allowed.size) throw Error('source_feed_database_not_dedicated');
      const marker = await this.client.execute({ sql: 'SELECT value FROM source_feed_meta WHERE key = ?', args: ['cache_marker'] });
      if (marker.rows.length !== 1 || marker.rows[0].value !== SOURCE_FEED_CACHE_MARKER) throw Error('source_feed_database_not_dedicated');
    } else {
      if (!options.allowCreate) throw Error('source_feed_database_not_dedicated');
      await this.client.batch([
        { sql: 'CREATE TABLE source_feed_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)', args: [] },
        { sql: `CREATE TABLE source_feed_snapshots (
          provider TEXT NOT NULL, competition TEXT NOT NULL, season INTEGER NOT NULL,
          schema_version INTEGER NOT NULL, content_sha256 TEXT NOT NULL, acquired_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL, PRIMARY KEY(provider,competition,season,schema_version,content_sha256))`, args: [] },
        { sql: `CREATE TABLE source_feed_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, competition TEXT NOT NULL,
          season INTEGER NOT NULL, requested_at TEXT NOT NULL, finished_at TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending','success','failure')), snapshot_hash TEXT,
          acquired_at TEXT, payload_sha256 TEXT, reason TEXT)`, args: [] },
        { sql: 'CREATE INDEX source_feed_attempt_scope ON source_feed_attempts(provider,competition,season,id DESC)', args: [] },
        { sql: 'INSERT INTO source_feed_meta(key,value) VALUES (?,?)', args: ['cache_marker', SOURCE_FEED_CACHE_MARKER] },
      ], 'write');
    }
    this.initialized = true;
  }

  private ready(): void { if (!this.initialized) throw Error('source_feed_store_not_initialized'); }

  async nextRequestDelay(now: string): Promise<number> {
    this.ready();
    const checkedAt = time(now);
    const latest = await this.client.execute({ sql: 'SELECT MAX(requested_at) AS requested_at FROM source_feed_attempts WHERE provider=?', args: [SOURCE_FEED_PROVIDER] });
    const requestedAt = latest.rows[0]?.requested_at;
    return requestedAt == null ? 0 : Math.max(0, SOURCE_FEED_MIN_REQUEST_INTERVAL_MS - (Date.parse(checkedAt) - Date.parse(String(requestedAt))));
  }

  /** Atomic durable claim, including failed or interrupted attempts. */
  async beginAttempt(competition: FootballDataCompetition, season: number, requestedAt: string): Promise<number | null> {
    this.ready(); validateSourceFeedScope(competition, season);
    const requested = time(requestedAt);
    const cutoff = new Date(Date.parse(requested) - SOURCE_FEED_COOLDOWN_MS).toISOString();
    const transientCutoff = new Date(Date.parse(requested) - SOURCE_FEED_TRANSIENT_FAILURE_BACKOFF_MS).toISOString();
    const spacingCutoff = new Date(Date.parse(requested) - SOURCE_FEED_MIN_REQUEST_INTERVAL_MS).toISOString();
    const result = await this.client.execute({
      sql: `INSERT INTO source_feed_attempts(provider,competition,season,requested_at,status)
        SELECT ?,?,?,?,'pending' WHERE NOT EXISTS (
          SELECT 1 FROM source_feed_attempts WHERE provider=? AND competition=? AND season=?
          AND COALESCE(finished_at,requested_at) > CASE WHEN status='failure'
            AND (reason IN (${SOURCE_FEED_TRANSIENT_FAILURE_REASONS.map(() => '?').join(',')}) OR reason GLOB 'calendar_http_5[0-9][0-9]')
            THEN ? ELSE ? END)
        AND NOT EXISTS (SELECT 1 FROM source_feed_attempts WHERE provider=? AND requested_at > ?)
        RETURNING id`,
      args: [SOURCE_FEED_PROVIDER, competition, season, requested, SOURCE_FEED_PROVIDER, competition, season,
        ...SOURCE_FEED_TRANSIENT_FAILURE_REASONS, transientCutoff, cutoff,
        SOURCE_FEED_PROVIDER, spacingCutoff],
    });
    return result.rows.length ? Number(result.rows[0].id) : null;
  }

  async succeed(attemptId: number, snapshot: FootballDataOrgSnapshot, finishedAt: string): Promise<void> {
    this.ready();
    this.verifySnapshot(snapshot, snapshot.competition, snapshot.season);
    const finished = time(finishedAt);
    const pending = await this.client.execute({ sql: 'SELECT provider,competition,season,requested_at,status,snapshot_hash,acquired_at,payload_sha256 FROM source_feed_attempts WHERE id=?', args: [attemptId] });
    const attempt = pending.rows[0];
    if (attempt?.status === 'success' && attempt.provider === snapshot.provider && attempt.competition === snapshot.competition
      && Number(attempt.season) === snapshot.season && attempt.snapshot_hash === snapshot.contentSha256
      && attempt.acquired_at === snapshot.acquiredAt && attempt.payload_sha256 === snapshot.payloadSha256) return;
    if (!attempt || attempt.status !== 'pending' || attempt.provider !== snapshot.provider || attempt.competition !== snapshot.competition
      || Number(attempt.season) !== snapshot.season || Date.parse(snapshot.acquiredAt) < Date.parse(attempt.requested_at)
      || Date.parse(snapshot.acquiredAt) > Date.parse(finished)) throw Error('source_feed_attempt_mismatch');
    await this.client.batch([
      { sql: `INSERT INTO source_feed_snapshots(provider,competition,season,schema_version,content_sha256,acquired_at,snapshot_json)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider,competition,season,schema_version,content_sha256) DO NOTHING`,
        args: [snapshot.provider, snapshot.competition, snapshot.season, snapshot.schemaVersion, snapshot.contentSha256, snapshot.acquiredAt, JSON.stringify(snapshot)] },
      { sql: `UPDATE source_feed_attempts SET status='success',finished_at=?,snapshot_hash=?,acquired_at=?,payload_sha256=?,reason=NULL WHERE id=? AND status='pending'`,
        args: [finished, snapshot.contentSha256, snapshot.acquiredAt, snapshot.payloadSha256, attemptId] },
    ], 'write');
  }

  async fail(attemptId: number, reason: string, finishedAt: string): Promise<void> {
    this.ready();
    await this.client.execute({
      sql: "UPDATE source_feed_attempts SET status='failure',finished_at=?,snapshot_hash=NULL,acquired_at=NULL,payload_sha256=NULL,reason=? WHERE id=? AND status='pending'",
      args: [time(finishedAt), safeReason(reason), attemptId],
    });
  }

  private verifySnapshot(snapshot: FootballDataOrgSnapshot, competition: FootballDataCompetition, season: number): void {
    if (!snapshot || snapshot.schemaVersion !== SOURCE_FEED_VERSION || snapshot.provider !== SOURCE_FEED_PROVIDER
      || snapshot.competition !== competition || snapshot.season !== season || !sourceFeedUtc(snapshot.acquiredAt)
      || !/^[a-f0-9]{64}$/.test(snapshot.payloadSha256 ?? '') || !/^[a-f0-9]{64}$/.test(snapshot.contentSha256 ?? '')) throw Error('source_feed_snapshot_invalid');
    const { acquiredAt: _acquired, payloadSha256: _payloadHash, contentSha256, ...content } = snapshot;
    const computed = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    if (computed !== contentSha256) throw Error('source_feed_snapshot_hash_mismatch');
  }

  /** A retained successful snapshot never hides a later failure or stale check. */
  async read(competition: FootballDataCompetition, season: number, now: string, maxAgeMs = SOURCE_FEED_COOLDOWN_MS): Promise<SourceFeedState> {
    this.ready(); validateSourceFeedScope(competition, season);
    const checkedAt = time(now);
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > SOURCE_FEED_COOLDOWN_MS) throw Error('source_feed_invalid_max_age');
    const attempts = await this.client.execute({
      sql: 'SELECT id,requested_at,finished_at,status,snapshot_hash,acquired_at,payload_sha256,reason FROM source_feed_attempts WHERE provider=? AND competition=? AND season=? ORDER BY id DESC LIMIT 1',
      args: [SOURCE_FEED_PROVIDER, competition, season],
    });
    const row = attempts.rows[0];
    const latestAttempt: SourceFeedAttempt | null = row ? { id: Number(row.id), requestedAt: String(row.requested_at),
      finishedAt: row.finished_at == null ? null : String(row.finished_at), status: row.status,
      acquiredAt: row.acquired_at == null ? null : String(row.acquired_at),
      payloadSha256: row.payload_sha256 == null ? null : String(row.payload_sha256),
      snapshotHash: row.snapshot_hash == null ? null : String(row.snapshot_hash), reason: row.reason == null ? null : String(row.reason) } : null;
    const cached = await this.client.execute({
      sql: `SELECT s.snapshot_json,a.id AS attempt_id,a.acquired_at,a.payload_sha256,a.finished_at FROM source_feed_attempts a JOIN source_feed_snapshots s
        ON s.provider=a.provider AND s.competition=a.competition AND s.season=a.season AND s.content_sha256=a.snapshot_hash
        AND s.schema_version=? WHERE a.provider=? AND a.competition=? AND a.season=? AND a.status='success'
        ORDER BY a.id DESC LIMIT 1`, args: [SOURCE_FEED_VERSION, SOURCE_FEED_PROVIDER, competition, season],
    });
    let snapshot: FootballDataOrgSnapshot | null = null;
    let lastVerifiedAt: string | null = null;
    let invalidCache = false;
    if (cached.rows.length) {
      try {
        if (latestAttempt?.status === 'success' && Number(cached.rows[0].attempt_id) !== latestAttempt.id) throw Error('source_feed_snapshot_invalid');
        const stored = JSON.parse(String(cached.rows[0].snapshot_json));
        this.verifySnapshot(stored, competition, season);
        // Content identity is deduplicated, but acquisition evidence belongs to
        // each real fetch, including raw fields ignored by the normalizer.
        snapshot = { ...stored, acquiredAt: cached.rows[0].acquired_at, payloadSha256: cached.rows[0].payload_sha256 };
        this.verifySnapshot(snapshot, competition, season);
        lastVerifiedAt = time(cached.rows[0].finished_at);
      } catch { snapshot = null; lastVerifiedAt = null; invalidCache = true; }
    }
    let status: SourceFeedState['status'] = 'unavailable', reason: string | null = 'source_feed_not_collected';
    if (latestAttempt?.status === 'failure') { status = 'failure'; reason = safeReason(latestAttempt.reason ?? 'source_feed_fetch_failed'); }
    else if (latestAttempt?.status === 'pending') { status = 'pending'; reason = 'source_feed_attempt_pending'; }
    else if (invalidCache) reason = 'source_feed_snapshot_invalid';
    else if (latestAttempt?.status === 'success' && snapshot) {
      const age = Date.parse(checkedAt) - Date.parse(snapshot.acquiredAt);
      if (age < 0 || age >= maxAgeMs) { status = 'stale'; reason = 'source_feed_stale'; }
      else { status = 'available'; reason = null; }
    }
    return { provider: SOURCE_FEED_PROVIDER, competition, season, available: status === 'available', status, reason, latestAttempt, lastVerifiedAt, snapshot };
  }
}
