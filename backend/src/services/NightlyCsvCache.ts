import { createHash } from 'node:crypto';
import type { SourceFeedClient } from './SourceFeedStore';

const marker = 'nightly_csv_cache_v1';
const codes = ['I1', 'E0', 'SP1', 'D1', 'F1'] as const;
export type CsvCode = typeof codes[number];
function validCsv(csv: string, code: CsvCode): boolean {
  const lines = csv.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2 || lines.some(line => line.includes('"'))) return false;
  const header = lines[0].replace(/^\uFEFF/, '').split(',');
  if (['Div','Date','HomeTeam','AwayTeam','FTHG','FTAG'].some(field => header.filter(value => value === field).length !== 1)) return false;
  return lines.slice(1).every(line => { const fields = line.split(','); return fields.length === header.length && fields[header.indexOf('Div')]?.trim() === code; });
}

/** Shared, durable seven-day collection budget. A crash consumes its reservation. */
export class NightlyCsvCache {
  private initialized = false;
  constructor(private readonly client: SourceFeedClient) {}
  async initialize(options: { allowCreate?: boolean } = {}): Promise<void> {
    const objects = await this.client.execute("SELECT name,type FROM sqlite_master WHERE name IN ('nightly_csv_meta','nightly_csv_attempts','nightly_csv_snapshots')");
    if (objects.rows.length === 0 && options.allowCreate === true) {
      await this.client.batch([
        { sql: 'CREATE TABLE nightly_csv_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)' },
        { sql: "CREATE TABLE nightly_csv_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, season INTEGER NOT NULL, requested_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL CHECK(status IN ('pending','success','partial','failure')))" },
        { sql: 'CREATE TABLE nightly_csv_snapshots (attempt_id INTEGER NOT NULL, code TEXT NOT NULL, acquired_at TEXT NOT NULL, sha256 TEXT NOT NULL, csv TEXT NOT NULL, PRIMARY KEY(attempt_id,code), FOREIGN KEY(attempt_id) REFERENCES nightly_csv_attempts(id))' },
        { sql: 'INSERT INTO nightly_csv_meta(key,value) VALUES (?,?)', args: ['marker', marker] },
        { sql: "INSERT INTO nightly_csv_meta(key,value) VALUES ('collection_not_before',strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days'))" },
      ], 'write');
    } else if (objects.rows.length !== 3 || objects.rows.some(row => row.type !== 'table')) throw Error('nightly_csv_cache_not_initialized');
    const meta = await this.client.execute({ sql: 'SELECT value FROM nightly_csv_meta WHERE key=?', args: ['marker'] });
    if (meta.rows.length !== 1 || meta.rows[0].value !== marker) throw Error('nightly_csv_cache_invalid');
    let anchor = await this.client.execute("SELECT value FROM nightly_csv_meta WHERE key='collection_not_before' AND julianday(value) IS NOT NULL");
    if (!anchor.rows.length && options.allowCreate === true) {
      // An old empty ledger cannot attest requests made by the previous importer.
      await this.client.execute("INSERT INTO nightly_csv_meta(key,value) VALUES ('collection_not_before',strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days')) ON CONFLICT(key) DO NOTHING");
      anchor = await this.client.execute("SELECT value FROM nightly_csv_meta WHERE key='collection_not_before' AND julianday(value) IS NOT NULL");
    }
    if (anchor.rows.length !== 1) throw Error('nightly_csv_cutover_uninitialized');
    this.initialized = true;
  }
  private ready() { if (!this.initialized) throw Error('nightly_csv_cache_not_initialized'); }
  async reserve(season: number): Promise<number | null> {
    this.ready();
    if (!Number.isInteger(season) || season < 2000 || season > 2099) throw Error('nightly_csv_scope_invalid');
    // Database clock and a single conditional write serialize all runners. Pending,
    // failed and interrupted attempts all count, regardless of season.
    const result = await this.client.execute({ sql: `INSERT INTO nightly_csv_attempts(season,requested_at,status)
      SELECT ?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'pending'
      WHERE julianday('now') >= (SELECT julianday(value) FROM nightly_csv_meta WHERE key='collection_not_before')
      AND NOT EXISTS (SELECT 1 FROM nightly_csv_meta WHERE key='provider_not_before' AND (julianday(value) IS NULL OR julianday(value) > julianday('now')))
      AND (SELECT COUNT(*) FROM nightly_csv_attempts WHERE julianday(requested_at) > julianday('now','-7 days')) < 2
      AND NOT EXISTS (SELECT 1 FROM nightly_csv_attempts WHERE status='success' AND julianday(COALESCE(finished_at,requested_at)) > julianday('now','-3.5 days'))
      AND NOT EXISTS (SELECT 1 FROM nightly_csv_attempts WHERE status='pending' AND julianday(requested_at) > julianday('now','-15 minutes')) RETURNING id`, args: [season] });
    return result.rows.length ? Number(result.rows[0].id) : null;
  }
  async retryCodes(id: number, season: number): Promise<CsvCode[]> {
    this.ready();
    const prior = await this.client.execute({ sql: `SELECT id,status FROM nightly_csv_attempts WHERE id < ? AND season=? ORDER BY id DESC LIMIT 1`, args: [id, season] });
    if (prior.rows[0]?.status !== 'partial') return [...codes];
    const rows = await this.client.execute({ sql: `SELECT s.code FROM nightly_csv_snapshots s JOIN nightly_csv_attempts a ON a.id=s.attempt_id
      WHERE a.id=? AND julianday(a.finished_at) > julianday('now','-15 minutes')`, args: [Number(prior.rows[0].id)] });
    const collected = new Set(rows.rows.map(row => String(row.code)));
    return codes.filter(code => !collected.has(code));
  }
  async finish(id: number, season: number, successes: Array<{ code: CsvCode; csv: string; acquiredAt: string }>, retryAfterSeconds = 0): Promise<void> {
    this.ready();
    if (!Number.isSafeInteger(id) || id < 1 || new Set(successes.map(x => x.code)).size !== successes.length
      || successes.some(x => !codes.includes(x.code) || typeof x.csv !== 'string' || !x.csv.length || Buffer.byteLength(x.csv) > 5_000_000
        || !Number.isFinite(Date.parse(x.acquiredAt)) || Date.parse(x.acquiredAt) > Date.now())) throw Error('nightly_csv_collection_invalid');
    const attempt = await this.client.execute({ sql: 'SELECT season,status FROM nightly_csv_attempts WHERE id=?', args: [id] });
    if (attempt.rows.length !== 1 || Number(attempt.rows[0].season) !== season || attempt.rows[0].status !== 'pending') throw Error('nightly_csv_attempt_invalid');
    const statements = successes.map(({ code, csv, acquiredAt }) => ({
      sql: `INSERT INTO nightly_csv_snapshots(attempt_id,code,acquired_at,sha256,csv)
        SELECT id,?,?,?,? FROM nightly_csv_attempts WHERE id=? AND season=? AND status='pending'`,
      args: [code, acquiredAt, createHash('sha256').update(csv, 'utf8').digest('hex'), csv, id, season],
    }));
    const expected = await this.retryCodes(id, season);
    if (successes.some(item => !expected.includes(item.code))) throw Error('nightly_csv_retry_scope_invalid');
    const complete = expected.length > 0 && expected.every(code => successes.some(item => item.code === code));
    const throttled = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.max(86400, Math.ceil(retryAfterSeconds)) : 0;
    const throttle = throttled ? [{ sql: "INSERT INTO nightly_csv_meta(key,value) VALUES ('provider_not_before',strftime('%Y-%m-%dT%H:%M:%fZ','now',?)) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      args: [`+${throttled} seconds`] }] : [];
    await this.client.batch([...statements, ...throttle, { sql: "UPDATE nightly_csv_attempts SET status=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND season=? AND status='pending'",
      args: [complete ? 'success' : successes.length ? 'partial' : 'failure', id, season] }], 'write');
  }
  async read(season: number, code: CsvCode) {
    this.ready();
    if (!Number.isInteger(season) || season < 2000 || season > 2099 || !codes.includes(code)) throw Error('nightly_csv_scope_invalid');
    const result = await this.client.execute({ sql: `SELECT s.csv,s.sha256,s.acquired_at,a.id AS attempt_id,a.status FROM nightly_csv_snapshots s
      JOIN nightly_csv_attempts a ON a.id=s.attempt_id WHERE a.season=? AND s.code=? AND a.status IN ('success','partial') ORDER BY a.id DESC LIMIT 1`, args: [season, code] });
    const row = result.rows[0];
    if (!row) return null;
    const csv = String(row.csv), sha256 = String(row.sha256);
    if (createHash('sha256').update(csv, 'utf8').digest('hex') !== sha256) throw Error('nightly_csv_cache_hash_mismatch');
    const latest = await this.client.execute({ sql: 'SELECT id,requested_at,status FROM nightly_csv_attempts WHERE season=? ORDER BY id DESC LIMIT 1', args: [season] });
    return { csv, sha256, acquiredAt: String(row.acquired_at), attemptId: Number(row.attempt_id), status: String(row.status),
      latestAttempt: latest.rows[0] ? { id: Number(latest.rows[0].id), requestedAt: String(latest.rows[0].requested_at), status: String(latest.rows[0].status) } : null };
  }
}

/** One request per file, no retries within a reserved collection. */
export async function collectNightlyCsv(options: { cache: NightlyCsvCache; season: number; fetcher?: typeof fetch }) {
  const attemptId = await options.cache.reserve(options.season);
  if (attemptId === null) return { attemptId: null, networkRequests: 0, successful: 0, reason: 'collection_budget_or_pending' };
  const seasonCode = `${String(options.season).slice(-2)}${String(options.season + 1).slice(-2)}`;
  const successes: Array<{ code: CsvCode; csv: string; acquiredAt: string }> = [];
  let networkRequests = 0, retryAfterSeconds = 0;
  const requestedCodes = await options.cache.retryCodes(attemptId, options.season);
  try {
    for (const code of requestedCodes) {
      try {
        networkRequests++;
        const response = await (options.fetcher ?? fetch)(`https://www.football-data.co.uk/mmz4281/${seasonCode}/${code}.csv`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (response.status === 429) {
          const header = response.headers.get('retry-after');
          const numeric = Number(header);
          const until = header && Number.isFinite(Date.parse(header)) ? (Date.parse(header) - Date.now()) / 1000 : 0;
          retryAfterSeconds = Math.max(86400, Number.isFinite(numeric) ? numeric : 0, until); break;
        }
        if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 5_000_000 || !response.body) continue;
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 5_000_000) { await reader.cancel(); throw Error('nightly_csv_too_large'); }
          chunks.push(chunk.value);
        }
        const csv = Buffer.concat(chunks).toString('utf8');
        if (!csv || Buffer.byteLength(csv) > 5_000_000 || !validCsv(csv, code)) continue;
        successes.push({ code, csv, acquiredAt: new Date().toISOString() });
      } catch { /* A failed request consumes the same durable collection slot. */ }
    }
  } finally { await options.cache.finish(attemptId, options.season, successes, retryAfterSeconds); }
  return { attemptId, networkRequests, successful: successes.length,
    reason: successes.length === requestedCodes.length ? null : retryAfterSeconds ? 'provider_rate_limited' : 'collection_incomplete' };
}
