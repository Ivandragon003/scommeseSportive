import { recordedQuality } from './WalletArchiveService';

type Row = Record<string, any>;
const closed = ['WON', 'LOST', 'VOID', 'HALF_WON', 'HALF_LOST', 'SETTLED'];
export function recordedTime(value: unknown): number {
  const raw = String(value || '');
  return Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw);
}

/** Statistics and a cumulative-profit curve, never a filtered spendable balance. */
export function walletPeriodResults(records: Row[], family: string, period: { from: string; to: string }, qualities: string[]) {
  const from = recordedTime(period.from), to = recordedTime(period.to);
  const rows = records.filter(row => row.family === family && (!qualities.length || qualities.includes(recordedQuality(row))));
  const inside = (at: unknown) => recordedTime(at) >= from && recordedTime(at) < to;
  const placed = rows.filter(row => inside(row.createdAt));
  const liquidated = rows.filter(row => closed.includes(row.status) && inside(row.settledAt || row.createdAt))
    .sort((a, b) => recordedTime(a.settledAt || a.createdAt) - recordedTime(b.settledAt || b.createdAt) || a.id.localeCompare(b.id));
  const missingProfit = liquidated.some(row => typeof row.profitCents !== 'number' || !Number.isFinite(row.profitCents));
  const profitCents = missingProfit ? null : liquidated.reduce((sum, row) => sum + row.profitCents, 0);
  const settledStakeCents = liquidated.reduce((sum, row) => sum + row.stakeCents, 0);
  let cumulative = 0;
  const profitCurve = missingProfit ? [] : [{ at: period.from, equityCents: 0 }, ...liquidated.map(row => {
    cumulative += row.profitCents;
    return { at: new Date(recordedTime(row.settledAt || row.createdAt)).toISOString(), equityCents: cumulative };
  })];
  return { profitCurve, metrics: { betCount: placed.length, stakeCents: placed.reduce((sum, row) => sum + row.stakeCents, 0),
    settledCount: liquidated.length, settledStakeCents, profitCents,
    roi: profitCents == null || !settledStakeCents ? null : profitCents / settledStakeCents,
    openCount: placed.filter(row => row.status === 'PENDING' || recordedTime(row.settledAt) >= to).length,
    wonCount: liquidated.filter(row => ['WON', 'HALF_WON'].includes(row.status)).length,
    lostCount: liquidated.filter(row => ['LOST', 'HALF_LOST'].includes(row.status)).length,
    voidCount: liquidated.filter(row => row.status === 'VOID').length } };
}
