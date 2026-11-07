import type { Client, Transaction } from '@libsql/client';

type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;
export type DynamicReadOptions = { portfolioId?: string; status?: string; from?: string; until?: string; matchId?: string };

/** Read immutable dynamic placements alongside their optional settlements. */
export async function listDynamicBetViews(db: Executor, options: DynamicReadOptions = {}): Promise<any[]> {
  const schema = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dynamic_model_bets','dynamic_model_settlements')");
  if (!schema.rows.length) return [];
  if (schema.rows.length !== 2) throw new Error('Dynamic execution migration 030 is incomplete');
  const filters: string[] = [], args: any[] = [];
  if (options.portfolioId) { filters.push('b.portfolio_id=?'); args.push(options.portfolioId); }
  if (options.matchId) { filters.push('b.match_id=?'); args.push(options.matchId); }
  if (options.status === 'PENDING') filters.push('s.bet_id IS NULL');
  else if (options.status === 'SETTLED') filters.push('s.bet_id IS NOT NULL');
  else if (options.status) throw new Error('Invalid dynamic status');
  if (options.from) { filters.push('julianday(b.placed_at)>=julianday(?)'); args.push(options.from); }
  if (options.until) { filters.push('julianday(b.placed_at)<julianday(?)'); args.push(options.until); }
  const result = await db.execute({ sql: `SELECT b.*, b.origin_decision_id AS decision_id,
    b.execution_decision_id AS effective_execution_decision_id, s.multiplier,s.return_cents,s.evidence_json,s.settled_at,
    CASE WHEN s.bet_id IS NULL THEN 'PENDING' ELSE 'SETTLED' END AS status,
    CASE WHEN s.bet_id IS NULL THEN NULL ELSE s.return_cents-b.stake_cents END AS profit_cents
    FROM dynamic_model_bets b LEFT JOIN dynamic_model_settlements s ON s.bet_id=b.id
    ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY b.placed_at,b.id`, args });
  return result.rows.map(row => Object.fromEntries(Object.entries(row).flatMap(([key, value]) => {
    const name = key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
    const fields: [string, any][] = [[name, typeof value === 'bigint' ? Number(value) : value]];
    if (key.endsWith('_json') && typeof value === 'string') fields.push([name.slice(0, -4), JSON.parse(value)]);
    return fields;
  })));
}
