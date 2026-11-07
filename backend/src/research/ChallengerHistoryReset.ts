import type { Client, Transaction } from '@libsql/client';

type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;

/** An absent marker keeps legacy behavior; a malformed marker fails closed. */
export async function challengerHistoryCutoff(db: Executor): Promise<number | null> {
  const exists = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='research_worker_state'");
  if (!exists.rows.length) return null;
  const result = await db.execute({ sql: 'SELECT last_tick_json FROM research_worker_state WHERE scheduler=?', args: ['challenger_history_reset'] });
  if (!result.rows.length) return null;
  let cutoff: unknown;
  try { cutoff = JSON.parse(String(result.rows[0].last_tick_json)).cutoff; } catch { throw new Error('Invalid challenger history reset marker'); }
  if (typeof cutoff !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cutoff)
    || !Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString() !== cutoff) throw new Error('Invalid challenger history reset marker');
  return Date.parse(cutoff);
}

export function predatesChallengerReset(createdAt: unknown, cutoff: number | null): boolean {
  if (cutoff === null) return false;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid historical job timestamp');
  return Date.parse(createdAt) <= cutoff;
}
