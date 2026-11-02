import { ResearchComparison } from '../research/researchComparisonTypes';

/** Combine recorded A outcomes for presentation; never transfer or recreate ledger funds. */
export function withDeterministicHistory(data: ResearchComparison | null, bets: any[]): ResearchComparison | null {
  if (!data || !bets.length) return data;
  const inside = (at: unknown) => {
    if (data.period.key === 'all') return true;
    const time = Date.parse(String(at ?? ''));
    return Number.isFinite(time) && (!data.period.from || time >= Date.parse(data.period.from)) && time <= Date.parse(data.period.to);
  };
  const cents = (amount: unknown) => Number.isFinite(Number(amount)) ? Math.round(Number(amount) * 100) : 0;
  const placed = bets.filter(bet => inside(bet.placed_at));
  const settled = bets.filter(bet => ['WON', 'LOST', 'VOID', 'HALF_WON', 'HALF_LOST', 'SETTLED'].includes(bet.status)
    && inside(bet.settled_at || bet.placed_at));
  return { ...data, portfolios: data.portfolios.map(row => {
    if (row.family !== 'A') return row;
    const profitCents = (row.profitCents ?? 0) + settled.reduce((sum, bet) => sum + cents(bet.profit), 0);
    const settledStakeCents = (row.settledStakeCents ?? 0) + settled.reduce((sum, bet) => sum + cents(bet.stake), 0);
    return { ...row, betCount: (row.betCount ?? 0) + placed.length,
      stakeCents: (row.stakeCents ?? 0) + placed.reduce((sum, bet) => sum + cents(bet.stake), 0),
      settledCount: (row.settledCount ?? 0) + settled.length,
      wonCount: (row.wonCount ?? 0) + settled.filter(bet => ['WON', 'HALF_WON'].includes(bet.status)).length,
      lostCount: (row.lostCount ?? 0) + settled.filter(bet => ['LOST', 'HALF_LOST'].includes(bet.status)).length,
      voidCount: (row.voidCount ?? 0) + settled.filter(bet => bet.status === 'VOID').length,
      profitCents, settledStakeCents, roi: settledStakeCents ? profitCents / settledStakeCents : null };
  }) };
}
