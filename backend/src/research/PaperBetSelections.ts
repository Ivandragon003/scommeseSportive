import type { RecommendationQuote } from './AppRecommendationQuotes';

/** Semantic identity excludes the price and bookmaker; family and fixture are separate keys. */
export function paperSelectionKey(quote: RecommendationQuote): string {
  const lineMarkets = ['totals', 'team_totals', 'european_handicap', 'asian_handicap',
    'shots', 'shots_on_target', 'yellow_cards', 'cards_total'];
  const teamMarkets = ['team_totals', 'shots'];
  return JSON.stringify([quote.market, quote.side, lineMarkets.includes(quote.market) ? quote.line ?? null : null,
    teamMarkets.includes(quote.market) ? quote.team ?? null : null, null]);
}

export function bestPaperSelections<T extends { selectionKey: string; quote: { odds: number; bookmaker: string } }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const previous = best.get(item.selectionKey);
    if (!previous || item.quote.odds > previous.quote.odds
      || (item.quote.odds === previous.quote.odds && item.quote.bookmaker.localeCompare(previous.quote.bookmaker) < 0)) {
      best.set(item.selectionKey, item);
    }
  }
  return [...best.values()].sort((a, b) => a.selectionKey.localeCompare(b.selectionKey));
}
