import type { Client, Transaction } from '@libsql/client';

type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;
export type FundedReadOptions = { portfolioId?: string; status?: string; from?: string; until?: string; matchId?: string };

/** Read immutable funded placements alongside their optional settlements. */
export async function listFundedBetViews(db: Executor, options: FundedReadOptions = {}): Promise<any[]> {
  const schema = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('funded_model_bets','funded_model_settlements')");
  if (!schema.rows.length) return [];
  if (schema.rows.length !== 2) throw new Error('Funded execution migration 029 is incomplete');
  const filters: string[] = [], args: any[] = [];
  const cancellationSchema = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='funded_model_bet_cancellations'");
  if (cancellationSchema.rows.length) filters.push('NOT EXISTS (SELECT 1 FROM funded_model_bet_cancellations c WHERE c.bet_id=b.id)');
  if (options.portfolioId) { filters.push('b.portfolio_id=?'); args.push(options.portfolioId); }
  if (options.matchId) { filters.push('b.match_id=?'); args.push(options.matchId); }
  if (options.status === 'PENDING') filters.push('s.bet_id IS NULL');
  else if (options.status === 'SETTLED') filters.push('s.bet_id IS NOT NULL');
  else if (options.status) throw new Error('Invalid funded status');
  if (options.from) { filters.push('julianday(b.placed_at)>=julianday(?)'); args.push(options.from); }
  if (options.until) { filters.push('julianday(b.placed_at)<julianday(?)'); args.push(options.until); }
  const result = await db.execute({ sql: `SELECT b.*, b.origin_decision_id AS decision_id,
    b.execution_decision_id AS effective_execution_decision_id, s.multiplier,s.return_cents,s.evidence_json,s.settled_at,
    CASE WHEN s.bet_id IS NULL THEN 'PENDING' ELSE 'SETTLED' END AS status,
    CASE WHEN s.bet_id IS NULL THEN NULL ELSE s.return_cents-b.stake_cents END AS profit_cents
    FROM funded_model_bets b LEFT JOIN funded_model_settlements s ON s.bet_id=b.id
    ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY b.placed_at,b.id`, args });
  return result.rows.map(row => Object.fromEntries(Object.entries(row).flatMap(([key, value]) => {
    const name = key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
    const fields: [string, any][] = [[name, typeof value === 'bigint' ? Number(value) : value]];
    if (key.endsWith('_json') && typeof value === 'string') fields.push([name.slice(0, -4), JSON.parse(value)]);
    return fields;
  })));
}
