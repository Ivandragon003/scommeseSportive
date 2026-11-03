import { ComparisonBet } from '../research/researchComparisonTypes';
import { parseMatchDateValue } from '../../utils/dateTime';
import { getBetSelectionLabel } from '../../utils/betPresentation';
import { recordedBetQuality } from './BetQualityBadge';

const cents = (value: unknown): number | null => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? Math.round(Number(value) * 100) : null;

/** Display adapter only: preserve the original bets, amounts, and budget sessions. */
export function historicalArchiveRows(rows: any[]): ComparisonBet[] {
  return rows.map(row => ({
    id: `baseline:${row.bet_id}`, portfolioId: 'legacy_baseline', family: 'A', historical: true,
    matchId: row.match_id || null, modelVersion: 'baseline-recorded',
    matchLabel: [row.home_team_name, row.away_team_name].filter(Boolean).join(' – ') || row.match_id || 'Partita non disponibile',
    league: row.competition, kickoffAt: row.match_date || undefined,
    market: row.market_name, selection: getBetSelectionLabel(row) || row.selection,
    odds: Number(row.odds), stakeCents: cents(row.stake) ?? 0, profitCents: cents(row.profit),
    status: row.status, createdAt: row.placed_at, settledAt: row.settled_at || undefined,
    classification: row.classification ?? null, confidence: row.confidence ?? null,
    bookmaker: row.bookmaker_name || row.bookmaker || undefined,
  }));
}

export function archiveDay(value: string): string | null {
  const date = parseMatchDateValue(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}

export type ArchiveFilters = { model: string; status: string; from: string; to: string; qualities: string[] };
export function filterArchiveRows(rows: ComparisonBet[], filters: ArchiveFilters): ComparisonBet[] {
  return rows.filter(bet => {
    if (filters.model === 'baseline' ? !bet.historical : filters.model !== 'all' && bet.family !== filters.model) return false;
    const outcomes: Record<string, string[]> = {
      open: ['PENDING'], settled: ['WON', 'LOST', 'HALF_WON', 'HALF_LOST', 'VOID', 'SETTLED'],
      WON: ['WON', 'HALF_WON'], LOST: ['LOST', 'HALF_LOST'], VOID: ['VOID'],
    };
    if (filters.status !== 'all' && !outcomes[filters.status]?.includes(bet.status)) return false;
    if (filters.qualities.length && !filters.qualities.includes(recordedBetQuality(bet) || 'UNKNOWN')) return false;
    const day = archiveDay(bet.kickoffAt || bet.createdAt);
    return (!filters.from || (!!day && day >= filters.from)) && (!filters.to || (!!day && day <= filters.to));
  }).sort((a, b) => (parseMatchDateValue(b.createdAt)?.getTime() || 0) - (parseMatchDateValue(a.createdAt)?.getTime() || 0));
}

export function archiveSummary(rows: ComparisonBet[]) {
  const settled = rows.filter(bet => ['WON', 'LOST', 'HALF_WON', 'HALF_LOST', 'VOID', 'SETTLED'].includes(bet.status));
  const missingProfit = settled.some(bet => typeof bet.profitCents !== 'number' || !Number.isFinite(bet.profitCents));
  const wonCents = settled.reduce((sum, bet) => sum + Math.max(0, bet.profitCents ?? 0), 0);
  const lostCents = settled.reduce((sum, bet) => sum + Math.min(0, bet.profitCents ?? 0), 0);
  return { total: rows.length, settled: settled.length, open: rows.filter(bet => bet.status === 'PENDING').length,
    won: settled.filter(bet => ['WON', 'HALF_WON'].includes(bet.status)).length,
    lost: settled.filter(bet => ['LOST', 'HALF_LOST'].includes(bet.status)).length,
    void: settled.filter(bet => bet.status === 'VOID').length, missingProfit,
    wonCents: missingProfit ? null : wonCents, lostCents: missingProfit ? null : lostCents,
    netCents: missingProfit ? null : wonCents + lostCents };
}
