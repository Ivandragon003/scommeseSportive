import { PredictionService } from '../services/PredictionService';
import { GoalSettlement, settleGoalQuote } from './GoalSettlement';
import type { ResearchQuote } from './ResearchEvaluation';

export type RecommendationQuote = Omit<ResearchQuote, 'market'> & { market: string };
type QuoteEvidence = Omit<RecommendationQuote, 'selection' | 'market' | 'side' | 'line' | 'team'>;
const unresolved = (): GoalSettlement => ({ status: 'UNRESOLVED', returnMultiplier: null });
const compactLine = (raw: string): number => raw.includes('.') || raw.length === 1 ? Number(raw)
  : /\d(?:25|75)$/.test(raw) ? Number(raw) / 100 : Number(raw) / 10;
const statMarkets: Record<string, string> = {
  shots_total: 'shots', shots_home: 'shots', shots_away: 'shots', sot_total: 'shots_on_target',
  yellow: 'yellow_cards', cards_total: 'cards_total',
};

/** Decode existing app keys only; disabled markets and player props never enter the team advice. */
export function appRecommendationQuote(selection: string, evidence: QuoteEvidence): RecommendationQuote | null {
  const key = String(selection ?? '').trim();
  const lower = key.toLowerCase();
  const make = (market: string, side: RecommendationQuote['side'], line?: number,
    team?: RecommendationQuote['team']): RecommendationQuote => ({ ...evidence, selection: key, market, side, line, team });
  if (['homewin', 'draw', 'awaywin'].includes(lower)) return make('1x2', lower === 'homewin' ? 'home' : lower === 'awaywin' ? 'away' : 'draw');
  if (lower === 'btts' || lower === 'bttsno') return make('btts', lower === 'btts' ? 'yes' : 'no');
  let match = /^double_chance_(1x|x2|12)$/.exec(lower);
  if (match) return make('double_chance', match[1] as RecommendationQuote['side']);
  match = /^dnb_(home|away)$/.exec(lower);
  if (match) return make('dnb', match[1] as 'home' | 'away');
  match = /^(over|under)(\d+(?:\.\d+)?)$/.exec(lower);
  if (match) {
    const line = compactLine(match[2]);
    return line >= 0 && line <= 7.5 ? make('totals', match[1] as 'over' | 'under', line) : null;
  }
  match = /^team_(home|away)_(over|under)_(\d+(?:\.\d+)?)$/.exec(lower);
  if (match) return make('team_totals', match[2] as 'over' | 'under', compactLine(match[3]), match[1] as 'home' | 'away');
  match = /^ahcp_(away_)?(-?\d+(?:\.\d+)?)$/.exec(lower);
  // App aliases encode the home threshold; provider prices encode the selected team's adjustment.
  if (match) return make('asian_handicap', match[1] ? 'away' : 'home', Number(match[2]) * (match[1] ? 1 : -1));
  match = /^hcp_(home|draw|away)([+-]?\d+(?:\.\d+)?)$/.exec(lower);
  if (match) return make('european_handicap', match[1] as 'home' | 'draw' | 'away', Number(match[2]) * (match[1] === 'away' ? -1 : 1));
  match = /^(shots_total|shots_home|shots_away|sot_total|yellow|cards_total)_(over|under)_(\d+(?:[.,]\d+)?)$/.exec(lower);
  if (match) return make(statMarkets[match[1]], match[2] as 'over' | 'under', Number(match[3].replace(',', '.')),
    match[1] === 'shots_home' ? 'home' : match[1] === 'shots_away' ? 'away' : undefined);
  match = /^(shots|shotshome|shotsaway|shotsot|yellow|cardstotal)(over|under)(\d+)$/i.exec(lower);
  if (match) {
    const domain = ({ shots: 'shots_total', shotshome: 'shots_home', shotsaway: 'shots_away',
      shotsot: 'sot_total', yellow: 'yellow', cardstotal: 'cards_total' } as Record<string, string>)[match[1]];
    return make(statMarkets[domain], match[2] as 'over' | 'under', Number(match[3]) / 10,
      domain === 'shots_home' ? 'home' : domain === 'shots_away' ? 'away' : undefined);
  }
  return null;
}

function validStatQuote(quote: RecommendationQuote): boolean {
  if (!quote || !Object.values(statMarkets).includes(quote.market)) return false;
  const parsed = appRecommendationQuote(quote.selection, quote);
  if (!parsed || parsed.market !== quote.market || parsed.side !== quote.side || parsed.line !== quote.line
    || parsed.team !== quote.team || !Number.isFinite(quote.line) || quote.line! < 0
    || !Number.isInteger(quote.line! * 2)) return false;
  // Reuse the goal quote's provenance validation without pretending statistics are goals.
  return settleGoalQuote({ ...quote, market: '1x2', side: 'home' }, 0, 0).status !== 'UNRESOLVED';
}

export function appQuoteSettlementSupported(quote: RecommendationQuote): boolean {
  return !!quote && (quote as RecommendationQuote & { usedSyntheticOdds?: boolean }).usedSyntheticOdds !== true
    && (settleGoalQuote(quote as ResearchQuote, 0, 0).status !== 'UNRESOLVED' || validStatQuote(quote));
}

let statEvaluator: PredictionService | undefined;
/** Missing statistics remain unresolved; never let Number(null) turn unavailable evidence into zero. */
export function settleAppRecommendationQuote(quote: RecommendationQuote, match: Record<string, any>): GoalSettlement {
  if (!quote || !match || !appQuoteSettlementSupported(quote)) return unresolved();
  if (settleGoalQuote(quote as ResearchQuote, 0, 0).status !== 'UNRESOLVED') {
    return settleGoalQuote(quote as ResearchQuote, match.home_goals, match.away_goals);
  }
  if (!validStatQuote(quote)) return unresolved();
  const fields = quote.market === 'cards_total'
    ? ['home_yellow_cards', 'away_yellow_cards', 'home_red_cards', 'away_red_cards']
    : quote.market === 'yellow_cards' ? ['home_yellow_cards', 'away_yellow_cards']
      : quote.market === 'shots_on_target' ? ['home_shots_on_target', 'away_shots_on_target']
        : quote.team === 'home' ? ['home_shots'] : quote.team === 'away' ? ['away_shots'] : ['home_shots', 'away_shots'];
  if ([...fields, 'home_goals', 'away_goals'].some((field) => match[field] === null || match[field] === undefined
    || typeof match[field] === 'boolean' || String(match[field]).trim() === ''
    || !Number.isSafeInteger(Number(match[field])) || Number(match[field]) < 0)) return unresolved();
  const domain = quote.market === 'cards_total' ? 'cards_total' : quote.market === 'yellow_cards' ? 'yellow'
    : quote.market === 'shots_on_target' ? 'sot_total' : quote.team ? `shots_${quote.team}` : 'shots_total';
  // This method is read-only and does not need a database or a provider client.
  statEvaluator ??= new PredictionService(undefined as any);
  const result = statEvaluator.evaluateSelectionAgainstMatch(`${domain}_${quote.side}_${quote.line!.toFixed(1)}`, match);
  return result ? { status: result.status, returnMultiplier: result.status === 'WON' ? quote.odds : result.status === 'VOID' ? 1 : 0 } : unresolved();
}
