import type { Client, Transaction } from '@libsql/client';
import { PredictionService } from '../services/PredictionService';
import { RecommendationQuote, appQuoteSettlementSupported } from './AppRecommendationQuotes';
import { settleGoalQuote, GoalSettlement } from './GoalSettlement';
import { researchHash, researchJson } from './ResearchStore';

export type PaperSelection = {
  market: string; selection: string; selectionKey: string; quote: RecommendationQuote;
  probability: number; ev: number; confidence?: string; prudentialEv?: number;
  probabilityConfiguration?: Record<string, any>; probabilityConfigurationHash?: string; modelVersion?: string;
  [key: string]: any;
};
export type PaperReadOptions = { family?: 'A' | 'C'; status?: 'PENDING' | 'SETTLED'; matchId?: string; from?: string; until?: string };
type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;
type Row = Record<string, any>;
export const PAPER_ACCOUNTING_MODE = 'PAPER_FIXED_UNIT';
export const PAPER_POLICY_VERSION = 'paper-fixed-unit-v1';

/** Detect the version separately from strict registration validation. */
export function isPaperPolicy(policy: any): boolean {
  return policy?.version === PAPER_POLICY_VERSION && policy?.virtualOnly === true
    && policy?.stakeModeA === PAPER_ACCOUNTING_MODE && policy?.stakeModeC === PAPER_ACCOUNTING_MODE
    && policy?.fixedStakeUnits === 1;
}

const object = (row: any): Row => {
  const result: Row = {};
  for (const [key, raw] of Object.entries(row)) {
    const name = key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
    result[name] = typeof raw === 'bigint' ? Number(raw) : raw;
    if (key.endsWith('_json') && typeof raw === 'string') result[name.slice(0, -4)] = JSON.parse(raw);
  }
  return result;
};
const iso = (value: string | Date): string => {
  if (typeof value === 'string' && !/(?:z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('Paper timestamp requires timezone');
  const time = new Date(value); if (!Number.isFinite(time.getTime())) throw new Error('Invalid paper timestamp'); return time.toISOString();
};

/** An absent additive schema fails explicitly, without initialization writes. */
export async function listPaperBetViews(client: Executor, options: PaperReadOptions = {}): Promise<Row[]> {
  const present = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('paper_model_bets','paper_model_settlements')");
  if (present.rows.length !== 2) { const error = new Error('Paper execution migration 028 is required'); (error as any).code = 'paper_schema_required'; throw error; }
  const filters: string[] = [], args: any[] = [];
  if (options.family !== undefined) {
    if (!['A', 'C'].includes(options.family)) throw new Error('Invalid paper family');
    filters.push('b.family=?'); args.push(options.family);
  }
  if (options.matchId) { filters.push('b.match_id=?'); args.push(options.matchId); }
  if (options.status === 'PENDING') filters.push('s.bet_id IS NULL');
  else if (options.status === 'SETTLED') filters.push('s.bet_id IS NOT NULL');
  else if (options.status !== undefined) throw new Error('Invalid paper status');
  if (options.from) { filters.push('julianday(b.placed_at)>=julianday(?)'); args.push(iso(options.from)); }
  if (options.until) { filters.push('julianday(b.placed_at)<julianday(?)'); args.push(iso(options.until)); }
  const result = await client.execute({ sql: `SELECT b.*,s.multiplier,s.return_cents,s.evidence_json,s.settled_at
    FROM paper_model_bets b LEFT JOIN paper_model_settlements s ON s.bet_id=b.id
    ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY b.placed_at,b.id`, args });
  return result.rows.map(raw => {
    const row = object(raw), snapshot = row.snapshot ?? {}, quote = snapshot.quote ?? null;
    const status = row.settledAt ? row.evidence?.status ?? (row.multiplier === 0 ? 'LOST' : row.multiplier === 1 ? 'VOID'
      : row.multiplier === .5 ? 'HALF_LOST' : Math.abs(row.multiplier - row.odds) < 1e-9 ? 'WON' : 'HALF_WON') : 'PENDING';
    return { ...row, accountingMode: PAPER_ACCOUNTING_MODE, portfolioId: `shadow_${row.family}`,
      originDecisionId: row.originDecisionId, effectiveExecutionDecisionId: row.executionDecisionId,
      // Cents remain a compatibility record; paper units retain the original payout precision.
      status, stakeUnits: 1, returnUnits: row.settledAt ? Number(row.multiplier) : null,
      profitUnits: row.settledAt ? Number(row.multiplier) - 1 : null,
      profitCents: row.settledAt ? row.returnCents - row.stakeCents : null,
      createdAt: row.placedAt, quote, bookmaker: quote?.bookmaker ?? null, source: quote?.source ?? null,
      probability: snapshot.probability ?? null, confidence: snapshot.confidence ?? null,
      classification: snapshot.classification ?? snapshot.confidence ?? null,
      matchLabel: snapshot.matchLabel ?? null, league: snapshot.competition ?? snapshot.league ?? null,
      kickoffAt: snapshot.kickoffAt ?? null, modelVersion: row.modelVersion };
  });
}

function metrics(rows: Row[]): Row {
  const settled = rows.filter(row => row.settledAt != null), sum = (key: string) => settled.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const returnUnits = sum('multiplier'), profitUnits = returnUnits - settled.length;
  const settledStakeCents = sum('stakeCents'), wins = settled.filter(row => Number(row.multiplier) > 1).length;
  const decisive = settled.filter(row => Number(row.multiplier) !== 1).length;
  return { totalCount: rows.length, betCount: rows.length, openCount: rows.length - settled.length, settledCount: settled.length,
    totalStakeUnits: rows.reduce((total, row) => total + Number(row.stakeCents), 0) / 100,
    settledStakeUnits: settledStakeCents / 100, returnUnits, profitUnits,
    roiPercent: settled.length ? profitUnits / settled.length * 100 : null,
    winRatePercent: decisive ? wins / decisive * 100 : null,
    wonCount: wins, lostCount: settled.filter(row => Number(row.multiplier) < 1).length,
    voidCount: settled.filter(row => Number(row.multiplier) === 1).length };
}

/** Unit results derive only from immutable placements and settlements, never wallet balances. */
export function paperBetOverview(rows: Row[]): Row {
  const history = (selected: Row[]) => {
    let profitUnits = 0;
    return selected.filter(row => row.settledAt != null).sort((a, b) => Date.parse(a.settledAt) - Date.parse(b.settledAt) || a.id.localeCompare(b.id))
      .map(row => { profitUnits += Number(row.multiplier) - 1;
        return { at: row.settledAt, betId: row.id, profitUnits }; });
  };
  return { accountingMode: PAPER_ACCOUNTING_MODE, fixedStakeUnits: 1, ...metrics(rows), history: history(rows),
    portfolios: ['A', 'C'].map(family => { const own = rows.filter(row => row.family === family);
      return { family, ...metrics(own), history: history(own) }; }) };
}

export async function settlePaperBet(tx: Executor, id: string, multiplier: number, evidence: Row, now = new Date()): Promise<Row> {
  const betRaw = (await tx.execute({ sql: 'SELECT * FROM paper_model_bets WHERE id=?', args: [id] })).rows[0];
  if (!betRaw) throw new Error('Paper bet not found');
  const bet = object(betRaw), existingRaw = (await tx.execute({ sql: 'SELECT * FROM paper_model_settlements WHERE bet_id=?', args: [id] })).rows[0];
  if (existingRaw) {
    const existing = object(existingRaw);
    if (existing.multiplier !== multiplier || researchHash(existing.evidence) !== researchHash(evidence)) throw new Error('Paper settlement evidence is immutable');
    return { ...existing, settled: false };
  }
  const allowed = [0, .5, 1, (Number(bet.odds) + 1) / 2, Number(bet.odds)];
  if (!Number.isFinite(multiplier) || !allowed.some(value => Math.abs(value - multiplier) < 1e-9)) throw new Error('Unsupported paper settlement multiplier');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !Object.keys(evidence).length) throw new Error('Paper settlement evidence required');
  const returnCents = Math.round(100 * multiplier), settledAt = iso(now);
  if (!Number.isSafeInteger(returnCents) || returnCents < 0) throw new Error('Invalid paper return');
  await tx.execute({ sql: 'INSERT INTO paper_model_settlements(bet_id,multiplier,return_cents,evidence_json,settled_at) VALUES (?,?,?,?,?)',
    args: [id, multiplier, returnCents, researchJson(evidence), settledAt] });
  return { betId: id, multiplier, returnCents, profitUnits: multiplier - 1, evidence, settledAt, settled: true };
}

/** Prototype-only evaluation has no constructor, database, cache or network side effects. */
let statEvaluator: PredictionService | undefined;
function settlement(quote: RecommendationQuote, match: Row): GoalSettlement {
  const unknown: GoalSettlement = { status: 'UNRESOLVED', returnMultiplier: null };
  if (!appQuoteSettlementSupported(quote)) return unknown;
  const numeric = (value: any) => value !== null && value !== undefined && typeof value !== 'boolean'
    && String(value).trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  if (![match.home_goals, match.away_goals].every(numeric)) return unknown;
  const goal = settleGoalQuote(quote as any, Number(match.home_goals), Number(match.away_goals));
  if (goal.returnMultiplier != null) return goal;
  const fields = quote.market === 'cards_total' ? ['home_yellow_cards', 'away_yellow_cards', 'home_red_cards', 'away_red_cards']
    : quote.market === 'yellow_cards' ? ['home_yellow_cards', 'away_yellow_cards']
      : quote.market === 'shots_on_target' ? ['home_shots_on_target', 'away_shots_on_target']
        : quote.market === 'shots' ? quote.team === 'home' ? ['home_shots'] : quote.team === 'away' ? ['away_shots'] : ['home_shots', 'away_shots'] : [];
  if (!fields.length || !fields.every(field => numeric(match[field]))) return unknown;
  const domain = quote.market === 'cards_total' ? 'cards_total' : quote.market === 'yellow_cards' ? 'yellow'
    : quote.market === 'shots_on_target' ? 'sot_total' : quote.team ? `shots_${quote.team}` : 'shots_total';
  statEvaluator ??= Object.create(PredictionService.prototype) as PredictionService;
  const result = statEvaluator.evaluateSelectionAgainstMatch(`${domain}_${quote.side}_${quote.line!.toFixed(1)}`, match);
  return result ? { status: result.status, returnMultiplier: result.status === 'WON' ? quote.odds : result.status === 'VOID' ? 1 : 0 } : unknown;
}

type PaperSettlementDatabase = {
  recommendations: { listPaperBets(options?: PaperReadOptions): Promise<Row[]>; isPaperUninitialized?(): Promise<boolean> };
  research: { runResearchTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  getMatchById(matchId: string): Promise<Row | null>;
};
export async function settlePaperModelBets(db: PaperSettlementDatabase, options: { allowUninitialized?: boolean } = {}): Promise<{
  checked: number; settled: number; unresolved: number; accountingState?: 'NOT_INITIALIZED';
}> {
  let bets: Row[];
  try { bets = await db.recommendations.listPaperBets({ status: 'PENDING' }); }
  catch (error) {
    if ((error as any)?.code !== 'paper_schema_required' || options.allowUninitialized !== true
      || await db.recommendations.isPaperUninitialized?.() !== true) throw error;
    return { checked: 0, settled: 0, unresolved: 0, accountingState: 'NOT_INITIALIZED' };
  }
  const summary = { checked: bets.length, settled: 0, unresolved: 0 }, matches = new Map<string, Row | null>();
  for (const bet of bets) {
    if (!matches.has(bet.matchId)) matches.set(bet.matchId, await db.getMatchById(bet.matchId));
    const match = matches.get(bet.matchId), outcome = match ? settlement(bet.snapshot?.quote, match) : null;
    if (!match || outcome?.returnMultiplier == null) { summary.unresolved++; continue; }
    let resultObservation: any = null;
    try { const observed = JSON.parse(match.raw_json || '{}').resultObservation;
      if (['football_data_csv', 'official_club_report', 'football_data_org'].includes(observed?.source)) resultObservation = observed;
    } catch { /* Older fixtures do not carry a separate result observation. */ }
    const evidence = { matchId: bet.matchId, homeGoals: Number(match.home_goals), awayGoals: Number(match.away_goals),
      source: resultObservation?.source || match.source || null, resultKickoffAt: match.date ?? null, status: outcome.status,
      ...(resultObservation ? { resultSourceUrl: resultObservation.sourceUrl ?? null, resultObservedAt: resultObservation.observedAt ?? null } : {}),
      ...(['cards_total', 'yellow_cards', 'shots', 'shots_on_target'].includes(bet.market)
        ? { market: bet.market, selection: bet.selection, statistics: Object.fromEntries([
          'home_shots', 'away_shots', 'home_shots_on_target', 'away_shots_on_target', 'home_yellow_cards', 'away_yellow_cards', 'home_red_cards', 'away_red_cards',
        ].filter(field => match[field] !== undefined).map(field => [field, match[field]])) } : {}) };
    const result = await db.research.runResearchTransaction(tx => settlePaperBet(tx, bet.id, outcome.returnMultiplier!, evidence));
    if (result.settled) summary.settled++;
  }
  return summary;
}
