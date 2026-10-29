import type { ResearchStore } from './ResearchStore';

type Row = Record<string, any>;
type Family = 'A' | 'C';
export type ResearchComparisonQuery = { period?: string; from?: string; to?: string };
type ComparisonStore = Pick<ResearchStore, 'listPortfolios' | 'listBets' | 'listLedger' | 'listDecisions'>
  & Partial<Pick<ResearchStore, 'listJobs'>>;
const ZONE = 'Europe/Rome';
const ROW_LIMIT = 500;
const DAY = 86_400_000;
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function dateParts(at: number): Record<string, number> {
  return Object.fromEntries(dateFormatter.formatToParts(at).filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
}

function calendarDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid comparison date: use YYYY-MM-DD');
  const at = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) throw new Error('Invalid comparison calendar date');
  return at;
}

/** Rome's DST transition never occurs at midnight; resolve each boundary independently. */
function romeMidnight(value: string): number {
  const calendar = calendarDate(value);
  let at = calendar;
  for (let i = 0; i < 3; i++) {
    const p = dateParts(at);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    at += calendar - represented;
  }
  return at;
}

const timestamp = (value: unknown): number => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
  ? Date.parse(value) : Number.NaN;
const sum = (items: Row[], value: (row: Row) => number): number => items.reduce((total, row) => total + value(row), 0);
const amount = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const equityDelta = (row: Row): number => amount(row.availableDeltaCents) + amount(row.committedDeltaCents);
const presentAmount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function comparisonPeriod(query: ResearchComparisonQuery, now: Date, earliest?: string) {
  const at = now.getTime();
  if (!Number.isFinite(at)) throw new Error('Invalid comparison clock');
  const key = query.period ?? '30d';
  if (!['7d', '30d', '60d', '90d', 'all', 'custom'].includes(key)) throw new Error('Invalid comparison period');
  let from: number; let to = at;
  if (key === 'custom') {
    if (!query.from || !query.to) throw new Error('Custom comparison requires from and to dates');
    const first = calendarDate(query.from); const last = calendarDate(query.to);
    if (last < first) throw new Error('Comparison end date precedes start date');
    from = romeMidnight(query.from);
    to = romeMidnight(new Date(last + DAY).toISOString().slice(0, 10));
  } else if (key === 'all') {
    const first = timestamp(earliest);
    from = Number.isFinite(first) ? Math.min(first, at) : at;
  } else {
    const p = dateParts(at);
    const first = Date.UTC(p.year, p.month - 1, p.day) - (Number(key.slice(0, -1)) - 1) * DAY;
    from = romeMidnight(new Date(first).toISOString().slice(0, 10));
  }
  return { key, from: new Date(from).toISOString(), to: new Date(to).toISOString(), timezone: ZONE,
    label: key === 'all' ? 'Intera simulazione' : key === 'custom' ? `${query.from} – ${query.to}` : `Ultimi ${key.slice(0, -1)} giorni` };
}

function quoteView(raw: Row | undefined): Row | null {
  if (!raw) return null;
  return Object.fromEntries(['odds', 'bookmaker', 'source', 'capturedAt', 'updatedAt', 'market', 'side', 'line', 'selection', 'team', 'priceType']
    .filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]));
}

function metadata(row: Row, job?: Row): Row {
  const snapshot = row.snapshot ?? {};
  const match = snapshot.match ?? snapshot.inputSnapshot?.match ?? {};
  const forecast = snapshot.forecast ?? snapshot.inputSnapshot?.forecast ?? {};
  const matchId = row.matchId ?? match.matchId ?? forecast.matchId ?? job?.matchId ?? null;
  const home = match.homeTeam ?? match.homeTeamName ?? snapshot.homeTeamName;
  const away = match.awayTeam ?? match.awayTeamName ?? snapshot.awayTeamName;
  return { matchId, matchLabel: match.matchLabel ?? snapshot.matchLabel ?? (home && away ? `${home} – ${away}` : matchId),
    league: match.competition ?? match.league ?? snapshot.competition ?? snapshot.league ?? forecast.competition ?? null,
    kickoffAt: match.kickoffAt ?? snapshot.kickoffAt ?? forecast.kickoffAt ?? job?.kickoffAt ?? null };
}

function settled(row: Row, end: number): boolean {
  const at = timestamp(row.settledAt);
  return Number.isFinite(at) && at < end;
}

function outcome(row: Row): string {
  const multiplier = Number(row.multiplier);
  if (multiplier === 0) return 'LOST';
  if (multiplier === 1) return 'VOID';
  if (multiplier === .5) return 'HALF_LOST';
  return Math.abs(multiplier - Number(row.odds)) < 1e-9 ? 'WON' : 'HALF_WON';
}

function betProfit(row: Row): number {
  return presentAmount(row.profitCents) ?? amount(row.returnCents) - amount(row.stakeCents);
}

function summary(placed: Row[], liquidated: Row[], end: number): Row {
  const profitCents = sum(liquidated, betProfit);
  const settledStakeCents = sum(liquidated, (row) => amount(row.stakeCents));
  return { profitCents, roi: settledStakeCents ? profitCents / settledStakeCents : null,
    stakeCents: sum(placed, (row) => amount(row.stakeCents)), settledStakeCents,
    betCount: placed.length, settledCount: liquidated.length, openCount: placed.filter((row) => !settled(row, end)).length,
    wonCount: liquidated.filter((row) => betProfit(row) > 0).length,
    lostCount: liquidated.filter((row) => betProfit(row) < 0).length,
    voidCount: liquidated.filter((row) => Number(row.multiplier) === 1).length,
    halfWonCount: liquidated.filter((row) => outcome(row) === 'HALF_WON').length,
    halfLostCount: liquidated.filter((row) => outcome(row) === 'HALF_LOST').length };
}

function equityPeriod(movements: Row[], from: number, end: number): Row {
  const before = movements.filter((row) => timestamp(row.createdAt) < from);
  const within = movements.filter((row) => timestamp(row.createdAt) >= from && timestamp(row.createdAt) < end);
  let value = sum(before, equityDelta); let startAt = from; let index = 0;
  // An account opened inside the period starts with its actual capital, not an invented profit.
  if (!before.length && within[0]?.event === 'OPEN') {
    startAt = timestamp(within[0].createdAt);
    while (index < within.length && within[index].event === 'OPEN' && timestamp(within[index].createdAt) === startAt) {
      value += equityDelta(within[index++]);
    }
  }
  const startEquityCents = value;
  const equity = [{ at: new Date(startAt).toISOString(), equityCents: value }];
  let peak = value; let maxDrawdown = 0;
  for (const row of within.slice(index)) {
    value += equityDelta(row);
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
    const point = { at: new Date(timestamp(row.createdAt)).toISOString(), equityCents: value };
    if (equity[equity.length - 1].at === point.at) equity[equity.length - 1] = point;
    else if (equity[equity.length - 1].equityCents !== value) equity.push(point);
  }
  return { startEquityCents, endEquityCents: value,
    profitCents: sum(within.filter((row) => row.event !== 'OPEN'), equityDelta), maxDrawdown, equity };
}

function decisionView(row: Row): Row {
  const quote = quoteView(row.snapshot?.quote);
  return { action: row.action, market: row.market, selection: row.selection, modelVersion: row.modelVersion,
    reason: row.reason ?? null, quote, bookmaker: quote?.bookmaker ?? null };
}

function sameDecision(a: Row, c: Row): boolean {
  if (a.action !== c.action) return false;
  if (a.action !== 'BET') return true;
  const left = decisionView(a); const right = decisionView(c);
  return left.market === right.market && left.selection === right.selection
    && ['odds', 'bookmaker', 'source', 'line', 'side', 'team'].every((key) => left.quote?.[key] === right.quote?.[key]);
}

/** Read-only economic comparison. It never creates wallets or substitutes historical model backtests. */
export async function buildResearchComparison(store: ComparisonStore, query: ResearchComparisonQuery = {}, now = new Date()): Promise<Row> {
  const [rawPortfolios, rawBets, rawLedger, rawDecisions, jobs] = await Promise.all([
    store.listPortfolios(), store.listBets(), store.listLedger(), store.listDecisions(), store.listJobs?.() ?? Promise.resolve([]),
  ]);
  const wallets = new Set(['shadow_A', 'shadow_C']);
  const validTime = (row: Row, key: string) => Number.isFinite(timestamp(row[key])) && timestamp(row[key]) <= now.getTime();
  const bets = rawBets.filter((row) => wallets.has(row.portfolioId) && validTime(row, 'placedAt'));
  const ledger = rawLedger.filter((row) => wallets.has(row.portfolioId) && validTime(row, 'createdAt'))
    .map((row, index) => ({ ...row, order: index })).sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt) || a.order - b.order);
  const decisions = rawDecisions.filter((row) => wallets.has(row.portfolioId) && validTime(row, 'createdAt'));
  const timestamps = [...ledger.map((row) => row.createdAt), ...bets.map((row) => row.placedAt), ...decisions.map((row) => row.createdAt)]
    .sort((a, b) => timestamp(a) - timestamp(b));
  const period = comparisonPeriod(query, now, timestamps[0]);
  const from = timestamp(period.from); const end = Math.min(timestamp(period.to), now.getTime() + 1);
  const contains = (at: unknown) => timestamp(at) >= from && timestamp(at) < end;
  const placed = bets.filter((row) => contains(row.placedAt));
  const liquidated = bets.filter((row) => contains(row.settledAt));
  const portfolios = (['A', 'C'] as Family[]).map<Row>((family) => {
    const portfolioId = `shadow_${family}`;
    const portfolio = rawPortfolios.find((row) => row.id === portfolioId);
    const movements = ledger.filter((row) => row.portfolioId === portfolioId);
    const measured = equityPeriod(movements, from, end);
    const own = summary(placed.filter((row) => row.portfolioId === portfolioId), liquidated.filter((row) => row.portfolioId === portfolioId), end);
    return { family, portfolioId, initialized: Boolean(portfolio),
      initialCents: portfolio ? sum(movements.filter((row) => row.event === 'OPEN'), equityDelta) : null,
      currentEquityCents: presentAmount(portfolio?.equityCents), currentAvailableCents: presentAmount(portfolio?.availableCents),
      currentCommittedCents: presentAmount(portfolio?.committedCents), ...own,
      ...(portfolio ? measured : { startEquityCents: null, endEquityCents: null, profitCents: null, maxDrawdown: null, equity: [] }) };
  });
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const meta = (row: Row) => metadata(row, jobById.get(row.jobId));
  const breakdown = (key: 'league' | 'market') => {
    const label = (row: Row): string => String((key === 'league' ? meta(row).league : row.market) ?? 'Non disponibile');
    const labels = [...new Set([...placed, ...liquidated].map(label))].sort();
    return labels.map((value) => ({ label: value, ...Object.fromEntries((['A', 'C'] as Family[]).map((family) => [family,
      summary(placed.filter((row) => row.family === family && label(row) === value),
        liquidated.filter((row) => row.family === family && label(row) === value), end)])) }));
  };
  const decisionsByJob = new Map<string, Partial<Record<Family, Row>>>();
  for (const row of decisions.filter((row) => contains(row.createdAt)).sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt) || String(a.id).localeCompare(String(b.id)))) {
    if (row.family !== 'A' && row.family !== 'C') continue;
    const group = decisionsByJob.get(row.jobId) ?? {};
    group[row.family as Family] = row;
    decisionsByJob.set(row.jobId, group);
  }
  const pairs = [...decisionsByJob.values()].filter((row) => row.A && row.C) as Array<{ A: Row; C: Row }>;
  const differences = pairs.filter((row) => !sameDecision(row.A, row.C)).map<Row>(({ A, C }) => ({
    ...meta(A), at: A.createdAt, A: decisionView(A), C: decisionView(C),
  })).sort((a, b) => timestamp(b.at) - timestamp(a.at) || String(a.matchId).localeCompare(String(b.matchId)));
  const betRows = [...placed].sort((a, b) => timestamp(b.placedAt) - timestamp(a.placedAt) || String(a.id).localeCompare(String(b.id)))
    .slice(0, ROW_LIMIT).map((row) => ({ id: row.id, family: row.family, portfolioId: row.portfolioId, modelVersion: row.modelVersion,
      ...meta(row), placedAt: row.placedAt, createdAt: row.placedAt, market: row.market, selection: row.selection,
      odds: row.odds, stakeCents: row.stakeCents, quote: quoteView(row.snapshot?.quote),
      bookmaker: row.snapshot?.quote?.bookmaker ?? null, source: row.snapshot?.quote?.source ?? null,
      reason: row.snapshot?.reason ?? null, status: settled(row, end) ? outcome(row) : 'PENDING',
      settledAt: settled(row, end) ? row.settledAt : null, profitCents: settled(row, end) ? betProfit(row) : null }));
  const [a, c] = portfolios;
  const leader = !a.initialized || !c.initialized ? null : a.profitCents === c.profitCents ? 'TIE' : a.profitCents > c.profitCents ? 'A' : 'C';
  return { period, observedAt: now.toISOString(), portfolios, leader, byLeague: breakdown('league'), byMarket: breakdown('market'),
    decisionDifferences: { comparedCount: pairs.length, differentCount: differences.length,
      sameCount: pairs.length - differences.length, incompleteCount: decisionsByJob.size - pairs.length,
      total: differences.length, truncated: differences.length > ROW_LIMIT, rows: differences.slice(0, ROW_LIMIT) },
    bets: { total: placed.length, truncated: placed.length > ROW_LIMIT, rows: betRows },
    semantics: { intervals: 'from_inclusive_to_exclusive', timezone: ZONE, money: 'integer_cents', rates: 'fractions',
      counts: 'betCount/stakeCents: placements in period; settledCount/outcomes/settledStakeCents: settlements in period, including earlier placements',
      openCount: 'placements in period still pending at period end',
      roi: 'profit from settlements in period / stake of those settlements; null without settled stake',
      profit: 'ledger equity movements in period excluding initial capital; open stakes remain committed capital',
      halfResults: 'half wins included in wonCount; half losses included in lostCount; separate half counts are also provided',
      equity: 'available plus committed capital; opening capital is not profit; drawdown restarts at period baseline',
      leader: 'higher virtual profit in selected period; no claim of statistical model superiority',
      history: 'preserved A/C portfolio history; protocol is the recorded quote priceType when available', rowLimit: ROW_LIMIT } };
}
