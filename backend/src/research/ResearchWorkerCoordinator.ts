import type { Client, Transaction } from '@libsql/client';
import { randomUUID } from 'node:crypto';

export const WORKER_LEASE_MS = 30_000;
export const WORKER_RENEWAL_MS = 5_000;
const SCHEDULER = 'research_t15';
export type WorkerLease = { ownerId: string; token: string };

/** A database lease reduces duplicate work; job leases fence every final write. */
export class ResearchWorkerCoordinator {
  constructor(private readonly client: Client, private readonly ready: () => Promise<void> = async () => {},
    private readonly options: { clock?: () => Date } = {}) {}

  private async timestamp(tx: Pick<Transaction, 'execute'>): Promise<string> {
    // Production uses the shared database clock, not a possibly skewed replica.
    if (this.options.clock) return this.options.clock().toISOString();
    return String((await tx.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")).rows[0].now);
  }

  private async write<T>(work: (tx: Transaction, now: string) => Promise<T>): Promise<T> {
    await this.ready();
    for (let attempt = 0; ; attempt++) {
      let tx: Transaction | undefined;
      try {
        tx = await this.client.transaction('write');
        const result = await work(tx, await this.timestamp(tx));
        await tx.commit(); return result;
      } catch (error: any) {
        await tx?.rollback().catch(() => undefined);
        if (attempt >= 5 || !/SQLITE_BUSY|database is locked/i.test(String(error?.code) + String(error?.message))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      } finally { tx?.close(); }
    }
  }

  async acquire(ownerId: string, prior?: WorkerLease | null): Promise<WorkerLease | null> {
    if (!ownerId.trim()) throw new Error('Worker identity required');
    return this.write(async (tx, now) => {
      const row = (await tx.execute({ sql: 'SELECT * FROM research_worker_state WHERE scheduler=?', args: [SCHEDULER] })).rows[0];
      const own = row?.owner_id === ownerId && prior?.token === row?.lease_token;
      if (row?.lease_expires_at && String(row.lease_expires_at) > now && !own) return null;
      const token = own && String(row.lease_expires_at) > now ? prior!.token : randomUUID();
      const expires = new Date(Date.parse(now) + WORKER_LEASE_MS).toISOString();
      await tx.execute({ sql: `INSERT INTO research_worker_state
        (scheduler,owner_id,lease_token,lease_expires_at,heartbeat_at,enabled,updated_at)
        VALUES (?,?,?,?,?,1,?) ON CONFLICT(scheduler) DO UPDATE SET owner_id=excluded.owner_id,
        lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at,heartbeat_at=excluded.heartbeat_at,
        enabled=1,updated_at=excluded.updated_at`, args: [SCHEDULER, ownerId, token, expires, now, now] });
      return { ownerId, token };
    });
  }

  async renew(lease: WorkerLease): Promise<boolean> {
    return this.write(async (tx, now) => {
      const result = await tx.execute({ sql: `UPDATE research_worker_state SET heartbeat_at=?,lease_expires_at=?,updated_at=?
        WHERE scheduler=? AND owner_id=? AND lease_token=? AND lease_expires_at>?`,
      args: [now, new Date(Date.parse(now) + WORKER_LEASE_MS).toISOString(), now, SCHEDULER, lease.ownerId, lease.token, now] });
      return result.rowsAffected === 1;
    });
  }

  async assertOwned(lease: WorkerLease): Promise<void> {
    await this.ready();
    const now = await this.timestamp(this.client);
    const result = await this.client.execute({ sql: `SELECT scheduler FROM research_worker_state
      WHERE scheduler=? AND owner_id=? AND lease_token=? AND lease_expires_at>?`,
    args: [SCHEDULER, lease.ownerId, lease.token, now] });
    if (!result.rows.length) throw new Error('Research worker lease lost');
  }

  async complete(lease: WorkerLease, summary: unknown, error: string | null): Promise<void> {
    await this.write(async (tx, now) => {
      await tx.execute({ sql: `UPDATE research_worker_state SET last_tick_at=?,last_tick_json=?,last_error=?,updated_at=?
        WHERE scheduler=? AND owner_id=? AND lease_token=? AND lease_expires_at>?`,
      args: [now, JSON.stringify(summary), error && /^(?:research|t15)_[a-z_]+$/.test(error) ? error : null,
        now, SCHEDULER, lease.ownerId, lease.token, now] });
    });
  }

  async release(lease: WorkerLease): Promise<void> {
    await this.write(async (tx, now) => {
      await tx.execute({ sql: `UPDATE research_worker_state SET owner_id=NULL,lease_token=NULL,lease_expires_at=NULL,
        enabled=0,updated_at=? WHERE scheduler=? AND owner_id=? AND lease_token=?`,
      args: [now, SCHEDULER, lease.ownerId, lease.token] });
    });
  }

  /** Reading operational state does not create a lease or issue a heartbeat. */
  async status(): Promise<{ enabled: boolean; active: boolean; heartbeatFresh: boolean; observedAt: string;
    ownerId: string | null; heartbeatAt: string | null; leaseExpiresAt: string | null;
    lastTickAt: string | null; lastTick: Record<string, unknown> | null; lastError: string | null }> {
    await this.ready();
    const observedAt = await this.timestamp(this.client);
    const row = (await this.client.execute({ sql: 'SELECT * FROM research_worker_state WHERE scheduler=?', args: [SCHEDULER] })).rows[0];
    const value = (field: string): string | null => row?.[field] == null ? null : String(row[field]);
    const heartbeatAt = value('heartbeat_at'), leaseExpiresAt = value('lease_expires_at');
    const enabled = Number(row?.enabled) === 1;
    const heartbeatAge = heartbeatAt ? Date.parse(observedAt) - Date.parse(heartbeatAt) : Number.NaN;
    return { enabled, active: enabled && !!row?.owner_id && !!leaseExpiresAt && leaseExpiresAt > observedAt,
      heartbeatFresh: Number.isFinite(heartbeatAge) && heartbeatAge >= 0 && heartbeatAge <= 45_000,
      observedAt, ownerId: value('owner_id'), heartbeatAt, leaseExpiresAt,
      lastTickAt: value('last_tick_at'), lastTick: row?.last_tick_json ? JSON.parse(String(row.last_tick_json)) : null,
      lastError: value('last_error') };
  }
}
