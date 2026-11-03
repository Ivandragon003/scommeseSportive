import { comparisonPeriod, recordedResearchBetView } from '../research/ResearchComparison';

type Row = Record<string, any>;
export const ARCHIVE_QUALITIES = ['HIGH', 'MEDIUM', 'LOW', 'SPECULATIVE', 'UNKNOWN'];
const CLOSED = ['WON', 'LOST', 'HALF_WON', 'HALF_LOST', 'VOID', 'SETTLED'];
export type ArchiveQuery = { model: string; status: string; from: string; to: string; qualities: string[]; offset: number; limit: number };
const invalid = () => new Error('Invalid archive filters');
export function parseArchiveQuery(raw: Record<string, unknown>): ArchiveQuery {
  const text = (key: string, fallback = '') => { if (raw[key] === undefined) return fallback; if (typeof raw[key] !== 'string') throw invalid(); return raw[key] as string; };
  const model = text('model', 'all') === 'baseline' ? 'A' : text('model', 'all');
  const status = text('status', 'all'); const from = text('from'); const to = text('to');
  if (!['all', 'A', 'C'].includes(model) || !['all', 'open', 'settled', 'WON', 'LOST', 'VOID'].includes(status)) throw invalid();
  if (from || to) { try { comparisonPeriod({ period: 'custom', from: from || to, to: to || from }, new Date()); } catch { throw invalid(); } }
  const qualities = [...new Set(text('qualities').split(',').filter(Boolean))];
  if (qualities.some(value => !ARCHIVE_QUALITIES.includes(value))) throw invalid();
  const offset = Number(text('offset', '0')); const limit = Number(text('limit', '200'));
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw invalid();
  return { model, status, from, to, qualities, offset, limit };
}
export function recordedQuality(row: Row): string {
  return ARCHIVE_QUALITIES.includes(row.classification) ? row.classification
    : ['HIGH', 'MEDIUM', 'LOW'].includes(row.confidence) ? row.confidence : 'UNKNOWN';
}
const date = (value: unknown): Date | null => {
  const raw = String(value || '');
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
  const parsed = new Date(normalized); return Number.isFinite(parsed.getTime()) ? parsed : null;
};
function day(value: unknown): string {
  const parsed = date(value); if (!parsed) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(parsed);
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-');
}
const cents = (value: unknown): number | null => value != null && Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : null;
export function summarizeArchive(rows: Row[]) {
  const settled = rows.filter(row => CLOSED.includes(row.status));
  const missingProfit = settled.some(row => typeof row.profitCents !== 'number' || !Number.isFinite(row.profitCents));
  const wonCents = settled.reduce((sum, row) => sum + Math.max(0, row.profitCents ?? 0), 0);
  const lostCents = settled.reduce((sum, row) => sum + Math.min(0, row.profitCents ?? 0), 0);
  return { total: rows.length, settled: settled.length, open: rows.filter(row => row.status === 'PENDING').length,
    won: settled.filter(row => ['WON', 'HALF_WON'].includes(row.status)).length,
    lost: settled.filter(row => ['LOST', 'HALF_LOST'].includes(row.status)).length,
    void: settled.filter(row => row.status === 'VOID').length, missingProfit,
    wonCents: missingProfit ? null : wonCents, lostCents: missingProfit ? null : lostCents, netCents: missingProfit ? null : wonCents + lostCents };
}

/** All calculations use the recorded database bets, before pagination; no balances or bets are mutated. */
export async function readWalletArchiveRows(db: { getBetHistory(userId: string): Promise<Row[]>; research: { listBetViews(): Promise<Row[]> } }, userId: string, now = new Date()) {
  const [history, research] = await Promise.all([db.getBetHistory(userId), db.research.listBetViews()]);
  const historical = history.map(row => {
    if (row.model_family !== 'A') throw new Error('Recorded deterministic model identity missing');
    return { id: `baseline:${row.bet_id}`, portfolioId: 'legacy_deterministic_A', family: row.model_family,
      historical: true, matchId: row.match_id, modelVersion: '', matchLabel: [row.home_team_name, row.away_team_name].filter(Boolean).join(' – ') || row.match_id,
      league: row.competition, kickoffAt: row.match_date, market: row.market_name, selection: row.selection,
      odds: row.odds, stakeCents: cents(row.stake), profitCents: cents(row.profit), status: row.status,
      createdAt: row.placed_at, settledAt: row.settled_at, classification: row.classification, bookmaker: row.bookmaker_name || row.bookmaker || null };
  });
  const current = research.filter(row => ['shadow_A', 'shadow_C'].includes(row.portfolioId)).map(row => recordedResearchBetView(row, now.getTime() + 1));
  const all = [...historical, ...current].filter(row => { const at = date(row.createdAt); return at && at <= now; });
  return all;
}

export async function buildWalletArchive(db: { getBetHistory(userId: string): Promise<Row[]>; research: { listBetViews(): Promise<Row[]> } }, userId: string, query: ArchiveQuery, now = new Date()) {
  const all = await readWalletArchiveRows(db, userId, now);
  const outcomes: Record<string, string[]> = { open: ['PENDING'], settled: CLOSED, WON: ['WON', 'HALF_WON'], LOST: ['LOST', 'HALF_LOST'], VOID: ['VOID'] };
  const filtered = all.filter(row => {
    if (query.model !== 'all' && row.family !== query.model) return false;
    if (query.status !== 'all' && !outcomes[query.status].includes(row.status)) return false;
    if (query.qualities.length && !query.qualities.includes(recordedQuality(row))) return false;
    const matchDay = day(row.kickoffAt || row.createdAt);
    return (!query.from || (!!matchDay && matchDay >= query.from)) && (!query.to || (!!matchDay && matchDay <= query.to));
  }).sort((a, b) => (date(b.createdAt)?.getTime() || 0) - (date(a.createdAt)?.getTime() || 0) || a.id.localeCompare(b.id));
  return { summary: summarizeArchive(filtered), byClassification: ARCHIVE_QUALITIES.map(quality => ({ quality, ...summarizeArchive(filtered.filter(row => recordedQuality(row) === quality)) })),
    byModel: ['A', 'C'].map(family => ({ family, ...summarizeArchive(filtered.filter(row => row.family === family)) })),
    rows: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length, offset: query.offset, limit: query.limit };
}
