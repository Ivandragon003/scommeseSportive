export type BookmakerOddsMap = Record<string, Record<string, number>>;

export interface CoherentBookmakerOddsBundle {
  odds: Record<string, number>;
  bookmakerBySelection: Record<string, string>;
  bookmakers: string[];
}

const isUsableOdd = (value: unknown): value is number => {
  const odd = Number(value);
  return Number.isFinite(odd) && odd > 1;
};

export const isExactScoreSelection = (selection: string): boolean =>
  /^exact(?:_|$)/i.test(String(selection ?? '').trim());

/**
 * Returns a stable key for selections whose bookmaker margin must be computed
 * from the same price sheet. Different lines remain separate groups.
 */
export const bookmakerMarketGroupKey = (selection: string): string => {
  const key = String(selection ?? '').trim();
  const lower = key.toLowerCase();

  if (['homewin', 'draw', 'awaywin'].includes(lower)) return 'match_result';
  if (['btts', 'bttsno'].includes(lower)) return 'btts';
  if (['dnb_home', 'dnb_away'].includes(lower)) return 'draw_no_bet';
  if (['double_chance_1x', 'double_chance_x2', 'double_chance_12'].includes(lower)) return 'double_chance';

  const handicap = lower.match(/^ahcp_(?:away_)?(.+)$/);
  if (handicap) return `asian_handicap:${handicap[1]}`;

  // Covers camelCase totals (over25/cardsTotalOver45) and underscore-based
  // statistical/player markets (..._over_2.5 / ..._under_2.5).
  const normalizedSide = lower
    .replace(/(^|_)(over|under)(?=_|\d)/, '$1side')
    .replace(/(over|under)(?=\d)/, 'side');
  if (normalizedSide !== lower) return `paired:${normalizedSide}`;

  return `single:${lower}`;
};

const bookmakerPreferenceScore = (entries: Array<[string, number]>): number => {
  if (entries.length === 0) return Number.NEGATIVE_INFINITY;
  // With equal group coverage, prefer the price sheet that is collectively
  // most favourable to the bettor. Logarithms avoid one large price
  // dominating the comparison and remain deterministic.
  return entries.reduce((sum, [, odd]) => sum + Math.log(odd), 0) / entries.length;
};

export const buildCoherentBookmakerOddsBundle = (
  allBookmakerOdds: BookmakerOddsMap | null | undefined
): CoherentBookmakerOddsBundle => {
  const grouped = new Map<string, Map<string, Array<[string, number]>>>();

  for (const [bookmakerName, rawOdds] of Object.entries(allBookmakerOdds ?? {})) {
    const bookmaker = String(bookmakerName ?? '').trim();
    if (!bookmaker || !rawOdds || typeof rawOdds !== 'object') continue;

    for (const [selection, rawOdd] of Object.entries(rawOdds)) {
      if (!selection || isExactScoreSelection(selection) || !isUsableOdd(rawOdd)) continue;
      const groupKey = bookmakerMarketGroupKey(selection);
      const byBookmaker = grouped.get(groupKey) ?? new Map<string, Array<[string, number]>>();
      const entries = byBookmaker.get(bookmaker) ?? [];
      entries.push([selection, Number(rawOdd)]);
      byBookmaker.set(bookmaker, entries);
      grouped.set(groupKey, byBookmaker);
    }
  }

  const odds: Record<string, number> = {};
  const bookmakerBySelection: Record<string, string> = {};

  for (const byBookmaker of grouped.values()) {
    const selected = Array.from(byBookmaker.entries()).sort(([leftName, leftEntries], [rightName, rightEntries]) =>
      rightEntries.length - leftEntries.length
      || bookmakerPreferenceScore(rightEntries) - bookmakerPreferenceScore(leftEntries)
      || leftName.localeCompare(rightName, 'it')
    )[0];
    if (!selected) continue;

    const [bookmaker, entries] = selected;
    for (const [selection, odd] of entries) {
      odds[selection] = odd;
      bookmakerBySelection[selection] = bookmaker;
    }
  }

  return {
    odds,
    bookmakerBySelection,
    bookmakers: Array.from(new Set(Object.values(bookmakerBySelection))).sort((a, b) => a.localeCompare(b, 'it')),
  };
};
