import type { Client, Transaction, InValue, Row } from '@libsql/client';
import { createHash, randomUUID } from 'node:crypto';

export type SmartOddsRequest = {
  provider: string; accountScope: string; endpoint: string; operation: string;
  markets: string[]; regions: string[]; bookmakers?: string[]; requestKey: string;
  expectedCredits: number; priority: 'essential' | 'informational'; cacheMaxAgeMs: number;
  allowNetwork?: boolean;
};
export type SmartOddsResponse<T> = { data: T; headers: Record<string, string>; fetchedAt: string; cacheHit: boolean };
export class SmartOddsRequestError extends Error {
  constructor(public readonly code: string, public readonly httpStatus?: number) { super(code); this.name = 'SmartOddsRequestError'; }
}
type Db = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;
const LEASE_MS = 60_000, FETCH_TIMEOUT_MS = 15_000, WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const monthOf = (date: Date) => date.toISOString().slice(0, 7);
const resetOf = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString();
const quotaNumber = (value: unknown): number | null => value !== undefined && value !== null && String(value).trim() !== ''
  && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const setting = (value: unknown, fallback: number) => quotaNumber(value) ?? fallback;
async function first(db: Db, sql: string, args: InValue[] = []): Promise<Row | null> {
  return (await db.execute({ sql, args })).rows[0] ?? null;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
function errorDetails(value: unknown) {
  const error = object(value), response = object(error.response);
  return { code: error.code, message: error.message, headers: response.headers ?? error.headers,
    status: response.status ?? error.httpStatus ?? error.status };
}
async function retryLocked<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error: unknown) {
      const details = errorDetails(error);
      if (!/SQLITE_BUSY|database is locked/i.test(`${details.code} ${details.message}`) || attempt >= 6) throw error;
      await sleep(10 * 2 ** attempt);
    }
  }
}
function quotaHeaders(input: unknown): Record<string, string> {
  const candidate = object(input);
  const output: Record<string, string> = {};
  // Never persist authentication, URLs, cookies or arbitrary response headers.
  for (const name of ['x-requests-used', 'x-requests-remaining', 'x-requests-last']) {
    const value = typeof candidate.get === 'function' ? (candidate.get as (key: string) => unknown).call(input, name)
      : Object.entries(candidate).find(([key]) => key.toLowerCase() === name)?.[1];
    if (quotaNumber(value) !== null) output[name] = String(value);
  }
  return output;
}

/** Shared libSQL transport accounting; a logical account scope must survive API-key rotation. */
export class SmartOddsRequestStore {
  private readonly clock: () => Date;
  private readonly monthlyLimit: number;
  private readonly reserveCredits: number;
  private queue: Promise<unknown> = Promise.resolve();
  private guards?: Promise<void>;
  constructor(private readonly client: Client, private readonly ready: () => Promise<void>, options: {
    clock?: () => Date; monthlyLimit?: number; reserveCredits?: number;
  } = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.monthlyLimit = setting(options.monthlyLimit ?? process.env.ODDS_API_MONTHLY_CREDITS, 500);
    this.reserveCredits = setting(options.reserveCredits ?? process.env.ODDS_API_RESERVE_CREDITS, 50);
  }

  private async write<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.ensureReady();
    const run = () => retryLocked(async () => {
      let tx: Transaction | undefined;
      try {
        tx = await this.client.transaction('write');
        const result = await work(tx); await tx.commit(); return result;
      }
      catch (error: unknown) { await tx?.rollback().catch(() => undefined); throw error; }
      finally { tx?.close(); }
    });
    const result = this.queue.then(run, run); this.queue = result.catch(() => undefined); return result;
  }

  private async ensureReady() {
    await this.ready();
    this.guards ??= retryLocked(async () => {
      // The local libSQL driver needs WAL for concurrent clients; remote Turso manages its own journal.
      if (this.client.protocol === 'file') await this.client.execute('PRAGMA journal_mode=WAL');
      const statements: string[] = [];
      for (const table of ['smart_odds_requests', 'smart_odds_results', 'smart_odds_events']) {
        for (const operation of ['UPDATE', 'DELETE']) statements.push(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()}
          BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'smart odds history is immutable'); END;`);
      }
      await this.client.executeMultiple(statements.join('\n'));
    }).catch((error: unknown) => {
      // A transient startup failure must not poison this process for its lifetime.
      this.guards = undefined;
      throw error;
    });
    await this.guards;
  }

  private normalize(request: SmartOddsRequest) {
    if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(request.provider) || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(request.accountScope)
      || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(request.operation) || !request.requestKey
      || !Number.isFinite(request.expectedCredits) || request.expectedCredits < 0
      || !['essential', 'informational'].includes(request.priority)
      || !Number.isFinite(request.cacheMaxAgeMs) || request.cacheMaxAgeMs < 0) throw new SmartOddsRequestError('odds_invalid_request');
    let endpoint: string;
    try { endpoint = request.endpoint.startsWith('http') ? new URL(request.endpoint).pathname : request.endpoint.split('?')[0]; }
    catch { throw new SmartOddsRequestError('odds_invalid_endpoint'); }
    if (!endpoint.startsWith('/') || endpoint.length > 300 || /[\r\n]/.test(endpoint)) throw new SmartOddsRequestError('odds_invalid_endpoint');
    const group = (values: string[]) => {
      if (!Array.isArray(values) || values.some((value) => !/^[a-zA-Z0-9_.:-]{1,120}$/.test(value))) throw new SmartOddsRequestError('odds_invalid_request_group');
      return JSON.stringify([...new Set(values)].sort());
    };
    return { ...request, endpoint, key: hash(request.requestKey), marketsJson: group(request.markets),
      regionsJson: group(request.regions), bookmakersJson: group(request.bookmakers ?? []),
      cacheMaxAgeMs: request.priority === 'essential' && request.expectedCredits > 0
        ? Math.min(request.cacheMaxAgeMs, 300_000) : request.cacheMaxAgeMs };
  }

  private async event(tx: Db, request: ReturnType<SmartOddsRequestStore['normalize']>, type: string, reason?: string, requestId?: string) {
    await tx.execute({ sql: `INSERT INTO smart_odds_events(id,provider,account_scope,request_key_hash,endpoint,operation,markets_json,type,reason,request_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, args: [randomUUID(), request.provider, request.accountScope, request.key, request.endpoint,
      request.operation, request.marketsJson, type, reason ?? null, requestId ?? null, this.clock().toISOString()] });
  }

  private async amounts(tx: Db, provider: string, accountScope: string, month: string) {
    const row = await first(tx, `SELECT COALESCE(SUM(CASE WHEN s.request_id IS NOT NULL THEN s.charged_credits ELSE 0 END),0) AS charged,
      COALESCE(SUM(CASE WHEN s.request_id IS NULL THEN r.expected_credits ELSE 0 END),0) AS reserved,
      COALESCE(SUM(CASE WHEN s.request_id IS NOT NULL AND s.measured_cost IS NULL THEN s.charged_credits ELSE 0 END),0) AS unknown_charged,
      COALESCE(SUM(r.expected_credits),0) AS planned FROM smart_odds_requests r LEFT JOIN smart_odds_results s ON s.request_id=r.id
      WHERE r.provider=? AND r.account_scope=? AND r.month=?`, [provider, accountScope, month]);
    // A request dispatched before the planning boundary can still be billed after it. Its old header
    // cannot establish a new-month allowance, but the liability must remain reserved in that allowance.
    const carryover = await first(tx, `SELECT COALESCE(SUM(CASE WHEN s.request_id IS NULL THEN r.expected_credits ELSE s.charged_credits END),0) AS credits
      FROM smart_odds_requests r LEFT JOIN smart_odds_results s ON s.request_id=r.id
      WHERE r.provider=? AND r.account_scope=? AND r.month<? AND (s.request_id IS NULL OR s.finished_at>=?)`,
    [provider, accountScope, month, `${month}-01T00:00:00.000Z`]);
    return { charged: Number(row.charged), unknownCharged: Number(row.unknown_charged), reserved: Number(row.reserved),
      planned: Number(row.planned), carryoverCredits: Number(carryover.credits) };
  }

  private remaining(budget: Row | null, amounts: { charged: number; unknownCharged: number; reserved: number; carryoverCredits: number }): number {
    // A later cumulative quota header cannot prove that an ambiguous timed-out request was included.
    const sinceHeader = amounts.unknownCharged + Math.max(0, amounts.charged - amounts.unknownCharged - Number(budget?.header_charged_anchor ?? 0));
    return Math.max(0, Math.min(this.monthlyLimit - amounts.charged - amounts.reserved - amounts.carryoverCredits,
      budget?.measured_used === null || budget?.measured_used === undefined ? Infinity
        : this.monthlyLimit - Number(budget.measured_used) - sinceHeader - amounts.reserved - amounts.carryoverCredits,
      budget?.measured_remaining === null || budget?.measured_remaining === undefined ? Infinity
        : Number(budget.measured_remaining) - sinceHeader - amounts.reserved - amounts.carryoverCredits));
  }

  async execute<T>(input: SmartOddsRequest, fetcher: () => Promise<{ data: T; headers?: unknown }>): Promise<SmartOddsResponse<T>> {
    const request = this.normalize(input), started = Date.now();
    for (;;) {
      const admission = await this.write(async (tx) => {
        const now = this.clock(), at = now.toISOString(), month = monthOf(now);
        const keys = [request.provider, request.accountScope, request.key];
        const cached = await first(tx, 'SELECT * FROM smart_odds_cache WHERE provider=? AND account_scope=? AND request_key_hash=?', keys);
        const age = cached ? now.getTime() - Date.parse(String(cached.fetched_at)) : Infinity;
        if (cached && age >= 0 && age <= request.cacheMaxAgeMs) {
          await this.event(tx, request, 'CACHE_HIT', undefined, String(cached.request_id));
          return { cached };
        }
        if (request.allowNetwork === false) {
          await this.event(tx, request, 'DENIED', 'odds_cache_only'); return { denied: 'odds_cache_only' };
        }
        const lease = await first(tx, 'SELECT * FROM smart_odds_leases WHERE provider=? AND account_scope=? AND request_key_hash=?', keys);
        if (lease && Date.parse(String(lease.expires_at)) > now.getTime()) return { wait: true };
        if (lease) {
          const abandoned = await first(tx, 'SELECT expected_credits FROM smart_odds_requests WHERE id=?', [lease.request_id]);
          if (abandoned) await tx.execute({ sql: `INSERT OR IGNORE INTO smart_odds_results
            (request_id,status,charged_credits,measured_cost,headers_json,finished_at,error_code) VALUES (?,'UNKNOWN',?,NULL,'{}',?,'lease_expired_unknown')`,
          args: [lease.request_id, abandoned.expected_credits, at] });
          await this.event(tx, request, 'LEASE_EXPIRED', 'lease_expired_unknown', String(lease.request_id));
        }
        const prior = await first(tx, `SELECT * FROM smart_odds_budgets WHERE provider=? AND account_scope=? AND month<? ORDER BY month DESC LIMIT 1`,
          [request.provider, request.accountScope, month]);
        await tx.execute({ sql: `INSERT OR IGNORE INTO smart_odds_budgets(provider,account_scope,month,measured_used,measured_remaining,reset_confirmed)
          VALUES (?,?,?,?,?,?)`, args: [request.provider, request.accountScope, month, prior?.measured_used ?? null,
          prior?.measured_remaining ?? null, prior ? 0 : 1] });
        const budget = await first(tx, 'SELECT * FROM smart_odds_budgets WHERE provider=? AND account_scope=? AND month=?',
          [request.provider, request.accountScope, month]);
        const available = this.remaining(budget, await this.amounts(tx, request.provider, request.accountScope, month));
        if (request.expectedCredits > 0 && !Number(budget.reset_confirmed)) {
          await this.event(tx, request, 'DENIED', 'odds_reset_unconfirmed'); return { denied: 'odds_reset_unconfirmed' };
        }
        const reserve = request.priority === 'informational' ? this.reserveCredits : 0;
        if (request.expectedCredits > 0 && available - request.expectedCredits < reserve) {
          await this.event(tx, request, 'DENIED', 'odds_credit_budget_exhausted'); return { denied: 'odds_credit_budget_exhausted' };
        }
        const id = randomUUID(), token = randomUUID();
        await tx.execute({ sql: `INSERT INTO smart_odds_requests(id,provider,account_scope,month,request_key_hash,endpoint,operation,markets_json,
          regions_json,bookmakers_json,expected_credits,priority,reserved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [id, request.provider,
          request.accountScope, month, request.key, request.endpoint, request.operation, request.marketsJson, request.regionsJson,
          request.bookmakersJson, request.expectedCredits, request.priority, at] });
        await tx.execute({ sql: `INSERT INTO smart_odds_leases(provider,account_scope,request_key_hash,token,request_id,expires_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(provider,account_scope,request_key_hash) DO UPDATE SET token=excluded.token,request_id=excluded.request_id,expires_at=excluded.expires_at`,
        args: [...keys, token, id, new Date(now.getTime() + LEASE_MS).toISOString()] });
        return { id, token, month, reservedAt: at };
      });
      if (admission.cached) return { data: JSON.parse(String(admission.cached.data_json)), headers: JSON.parse(String(admission.cached.headers_json)),
        fetchedAt: String(admission.cached.fetched_at), cacheHit: true };
      if (admission.denied) throw new SmartOddsRequestError(admission.denied);
      if (admission.wait) {
        if (Date.now() - started >= WAIT_MS) {
          await this.write((tx) => this.event(tx, request, 'DENIED', 'odds_request_inflight_timeout'));
          throw new SmartOddsRequestError('odds_request_inflight_timeout');
        }
        await sleep(100); continue;
      }
      let data: T, headers: Record<string, string> = {}, failure: unknown, timer: ReturnType<typeof setTimeout>;
      try {
        const response = await Promise.race([fetcher(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('odds_transport_timeout')), FETCH_TIMEOUT_MS);
        })]);
        data = response.data; headers = quotaHeaders(response.headers);
      } catch (error: unknown) { failure = error; headers = quotaHeaders(errorDetails(error).headers); }
      finally { clearTimeout(timer!); }
      let serialized: string;
      if (!failure) {
        try { serialized = JSON.stringify(data!); if (serialized === undefined) throw new Error('missing payload'); }
        catch { failure = new Error('odds_invalid_json_payload'); }
      }
      const rawStatus = Number(errorDetails(failure).status);
      const failureStatus = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
      const failureCode = failureStatus === 401 || failureStatus === 403 ? 'odds_provider_authentication_failed'
        : failureStatus === 429 ? 'odds_provider_rate_limited' : failureStatus === 402 ? 'odds_provider_quota_exhausted' : 'odds_transport_failed';
      const fetchedAt = this.clock().toISOString();
      const accepted = await this.write(async (tx) => {
        const keys = [request.provider, request.accountScope, request.key];
        const lease = await first(tx, 'SELECT * FROM smart_odds_leases WHERE provider=? AND account_scope=? AND request_key_hash=?', keys);
        const ownsLease = lease?.token === admission.token && lease?.request_id === admission.id && Date.parse(String(lease.expires_at)) > Date.parse(fetchedAt);
        const cost = quotaNumber(headers['x-requests-last']);
        await tx.execute({ sql: `INSERT OR IGNORE INTO smart_odds_results(request_id,status,charged_credits,measured_cost,headers_json,finished_at,error_code)
          VALUES (?,?,?,?,?,?,?)`, args: [admission.id, failure ? cost === null ? 'UNKNOWN' : 'ERROR' : 'SUCCESS',
          cost ?? request.expectedCredits, cost, JSON.stringify(headers), fetchedAt, failure ? failureCode : null] });
        // Headers for a request crossing a UTC month boundary cannot establish the next month's quota.
        if (admission.month === monthOf(this.clock())) {
          const used = quotaNumber(headers['x-requests-used']), remaining = quotaNumber(headers['x-requests-remaining']);
          const budget = await first(tx, 'SELECT * FROM smart_odds_budgets WHERE provider=? AND account_scope=? AND month=?',
            [request.provider, request.accountScope, admission.month]);
          const resetConfirmed = !Number(budget.reset_confirmed) && request.expectedCredits === 0
            && ((used !== null && (budget.measured_used === null || used < Number(budget.measured_used)))
              || (remaining !== null && (budget.measured_remaining === null || remaining > Number(budget.measured_remaining)))
              || (used === 0 && remaining !== null && remaining >= this.monthlyLimit));
          const stricter = resetConfirmed || (used !== null && (budget.measured_used === null || used > Number(budget.measured_used)))
            || (remaining !== null && (budget.measured_remaining === null || remaining < Number(budget.measured_remaining)));
          if (stricter) {
            const amounts = await this.amounts(tx, request.provider, request.accountScope, admission.month!);
            const knownCharged = amounts.charged - amounts.unknownCharged;
            // A cumulative delta does not identify which concurrent requests were included. Only prior completed
            // requests and this header's own measured charge can be proven to precede its quota observation.
            const included = await first(tx, `SELECT COALESCE(SUM(s.charged_credits),0) AS charged
              FROM smart_odds_requests r JOIN smart_odds_results s ON s.request_id=r.id
              WHERE r.provider=? AND r.account_scope=? AND r.month=? AND s.measured_cost IS NOT NULL
                AND (s.finished_at<? OR r.id=?)`, [request.provider, request.accountScope, admission.month,
              admission.reservedAt, admission.id]);
            const anchor = Math.min(knownCharged, Math.max(Number(budget.header_charged_anchor), Number(included.charged)));
            await tx.execute({ sql: `UPDATE smart_odds_budgets SET measured_used=?,measured_remaining=?,header_charged_anchor=?,header_observed_at=?,reset_confirmed=?
              WHERE provider=? AND account_scope=? AND month=?`, args: [resetConfirmed ? used
                : used === null ? budget.measured_used : Math.max(Number(budget.measured_used ?? 0), used), resetConfirmed ? remaining
                : remaining === null ? budget.measured_remaining : Math.min(Number(budget.measured_remaining ?? Infinity), remaining), anchor,
              fetchedAt, resetConfirmed ? 1 : budget.reset_confirmed, request.provider, request.accountScope, admission.month] });
          }
        }
        if (!failure && ownsLease) await tx.execute({ sql: `INSERT INTO smart_odds_cache(provider,account_scope,request_key_hash,data_json,headers_json,fetched_at,request_id)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider,account_scope,request_key_hash) DO UPDATE SET data_json=excluded.data_json,headers_json=excluded.headers_json,
          fetched_at=excluded.fetched_at,request_id=excluded.request_id`, args: [...keys, serialized!, JSON.stringify(headers), fetchedAt, admission.id] });
        await tx.execute({ sql: 'DELETE FROM smart_odds_leases WHERE provider=? AND account_scope=? AND request_key_hash=? AND token=?', args: [...keys, admission.token] });
        await this.event(tx, request, failure ? 'FETCH_FAILED' : ownsLease ? 'FETCH_SUCCESS' : 'LATE_RESPONSE',
          failure ? failureCode : ownsLease ? undefined : 'odds_lease_lost', admission.id);
        return ownsLease;
      });
      if (failure) throw new SmartOddsRequestError(failureCode, failureStatus);
      if (!accepted) throw new SmartOddsRequestError('odds_lease_lost');
      return { data: JSON.parse(serialized!), headers, fetchedAt, cacheHit: false };
    }
  }

  async overview() {
    await this.ready();
    const now = this.clock(), month = monthOf(now), cutoff = new Date(now.getTime() - 90 * 86400000).toISOString();
    const budgetRows = (await this.client.execute({ sql: 'SELECT * FROM smart_odds_budgets WHERE month=? ORDER BY provider,account_scope LIMIT 100', args: [month] })).rows;
    const providers = await Promise.all(budgetRows.map(async (budget) => {
      const amounts = await this.amounts(this.client, String(budget.provider), String(budget.account_scope), month);
      const counts = await first(this.client, `SELECT COUNT(*) AS requests, SUM(CASE WHEN s.status IN ('ERROR','UNKNOWN') THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN s.measured_cost IS NOT NULL THEN s.measured_cost ELSE 0 END) AS measured_credits,
        SUM(CASE WHEN s.request_id IS NOT NULL AND s.measured_cost IS NULL THEN s.charged_credits ELSE 0 END) AS unknown_credits,
        MAX(CASE WHEN s.status='SUCCESS' THEN s.finished_at END) AS last_fetch FROM smart_odds_requests r LEFT JOIN smart_odds_results s ON s.request_id=r.id
        WHERE r.provider=? AND r.account_scope=? AND r.month=?`, [budget.provider, budget.account_scope, month]);
      const cached = (await this.client.execute({ sql: `SELECT data_json,fetched_at FROM smart_odds_cache WHERE provider=? AND account_scope=?
        ORDER BY fetched_at DESC LIMIT 20`, args: [budget.provider, budget.account_scope] })).rows;
      const actualBookmakers = new Set<string>(), actualMarkets = new Set<string>();
      let actualCoverageAsOf: string | null = null;
      for (const row of cached) {
        const payload: unknown = JSON.parse(String(row.data_json));
        for (const eventValue of (Array.isArray(payload) ? payload : [payload]).slice(0, 200)) {
          const event = object(eventValue);
          for (const bookmakerValue of (Array.isArray(event.bookmakers) ? event.bookmakers : []).slice(0, 100)) {
            const bookmaker = object(bookmakerValue);
            const name = bookmaker?.title || bookmaker?.key;
            if (typeof name === 'string' && name.trim()) {
              actualBookmakers.add(name.slice(0, 120)); actualCoverageAsOf ??= String(row.fetched_at);
            }
            for (const marketValue of (Array.isArray(bookmaker.markets) ? bookmaker.markets : []).slice(0, 100)) {
              const market = object(marketValue);
              if (typeof market?.key === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(market.key)) {
                actualMarkets.add(market.key); actualCoverageAsOf ??= String(row.fetched_at);
              }
            }
          }
        }
      }
      return { provider: budget.provider, accountScope: budget.account_scope, status: amounts.reserved > 0 ? 'REQUESTS_INFLIGHT'
        : Number(counts.failures) > 0 ? 'DEGRADED' : counts.last_fetch ? 'OK' : 'UNOBSERVED', month,
        monthlyLimit: this.monthlyLimit, reserveCredits: this.reserveCredits, resetAt: resetOf(month), resetConvention: 'local_planning_calendar_month_utc',
        resetConfirmed: Boolean(Number(budget.reset_confirmed)), planningVerified: budget.header_observed_at !== null,
        observedUsed: budget.measured_used === null ? null : Number(budget.measured_used),
        observedRemaining: budget.measured_remaining === null ? null : Number(budget.measured_remaining), observedAt: budget.header_observed_at,
        plannedCredits: amounts.planned, chargedCredits: amounts.charged, reservedCredits: amounts.reserved,
        carryoverCredits: amounts.carryoverCredits,
        measuredCredits: Number(counts.measured_credits ?? 0), unknownChargedCredits: Number(counts.unknown_credits ?? 0),
        availableCredits: this.remaining(budget, amounts), requests: Number(counts.requests), failures: Number(counts.failures ?? 0),
        lastFetch: counts.last_fetch ?? null, plannedForecast: null, actualBookmakers: [...actualBookmakers].sort(),
        actualMarkets: [...actualMarkets].sort(), actualCoverageAsOf, actualCoverageSource: 'last_20_cached_responses' };
    }));
    const usage = (await this.client.execute({ sql: `SELECT r.provider,r.account_scope,r.endpoint,r.operation,r.markets_json,
      COUNT(*) AS requests,SUM(r.expected_credits) AS planned_credits,SUM(COALESCE(s.charged_credits,0)) AS charged_credits,
      SUM(CASE WHEN s.measured_cost IS NOT NULL THEN s.measured_cost ELSE 0 END) AS measured_credits
      FROM smart_odds_requests r LEFT JOIN smart_odds_results s ON s.request_id=r.id WHERE r.reserved_at>=?
      GROUP BY r.provider,r.account_scope,r.endpoint,r.operation,r.markets_json ORDER BY requests DESC LIMIT 100`, args: [cutoff] })).rows;
    const events = (await this.client.execute({ sql: `SELECT provider,account_scope,type,reason,COUNT(*) AS count,MAX(created_at) AS last_at
      FROM smart_odds_events WHERE created_at>=? GROUP BY provider,account_scope,type,reason ORDER BY last_at DESC LIMIT 100`, args: [cutoff] })).rows;
    const cacheCounts = await first(this.client, `SELECT (SELECT COUNT(*) FROM smart_odds_events WHERE type='CACHE_HIT' AND created_at>=?) AS hits,
      (SELECT COUNT(*) FROM smart_odds_requests WHERE reserved_at>=?) AS fetch_reservations`, [cutoff, cutoff]);
    const hits = Number(cacheCounts.hits), fetchReservations = Number(cacheCounts.fetch_reservations);
    return { observedAt: now.toISOString(), month, resetAt: resetOf(month), providers,
      cache: { window: 'last_90_days', hits, fetchReservations, hitRate: hits + fetchReservations ? hits / (hits + fetchReservations) : null },
      usage: usage.map((row) => ({
      provider: row.provider, accountScope: row.account_scope, endpoint: row.endpoint, operation: row.operation,
      markets: JSON.parse(String(row.markets_json)), requests: Number(row.requests), plannedCredits: Number(row.planned_credits),
      chargedCredits: Number(row.charged_credits), measuredCredits: Number(row.measured_credits),
    })), events: events.map((row) => ({ provider: row.provider, accountScope: row.account_scope, type: row.type,
      reason: row.reason, count: Number(row.count), lastAt: row.last_at })), plannedForecast: null,
    limitations: ['UTC calendar months are a local planning policy, not a confirmed provider reset timezone. New-month paid requests require a fresh zero-cost quota probe confirming reset.',
      'A fresh full allowance (used zero, remaining at least the configured limit) also permits new-month spending; this does not prove that a reset occurred.',
      'Unknown failures retain their estimated charge; quota availability is deliberately conservative.',
      'Prior-period requests still outstanding or completed in the current period retain a separate conservative carryover liability.',
      'Usage is grouped by the complete market bundle; joint request costs are never allocated to individual markets.',
      'History is preserved; the overview reads the last 90 days and at most 100 groups.'] };
  }
}
