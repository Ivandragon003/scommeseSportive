import type { ResearchQuote } from './ResearchEvaluation';
import type { GoalMarket } from './GoalSettlement';

export type HistoricalSnapshotRow = {
  snapshot_id: string; match_id?: string | null; match_date?: string | null; commence_time?: string | null;
  competition?: string | null; season?: string | null; source: string; captured_at: string;
  home_team_name?: string | null; away_team_name?: string | null;
  matchLinkEvidence?: { method: 'existing_match_id' | 'unique_exact_fixture'; originalMatchId: string | null };
  selected_bookmaker_name?: string | null; selected_bookmaker_key?: string | null;
  selected_odds_json?: string | null; live_selected_odds_json?: string | null; all_bookmaker_odds_json?: string | null;
  used_synthetic_odds?: number | boolean | null; used_fallback_bookmaker?: number | boolean | null;
};
export type HistoricalMatchIdentity = { match_id: string; date: string; competition: string; season: string;
  home_team_name: string; away_team_name: string };
export type HistoricalFixtureIndex = ReadonlyMap<string, HistoricalMatchIdentity[]>;
const fixtureKey = (competition: string, kickoff: string, home: string, away: string): string =>
  JSON.stringify([competition, kickoff, home, away]);
export function buildHistoricalFixtureIndex(matches: HistoricalMatchIdentity[], normalizeTeamName: (value: string) => string): HistoricalFixtureIndex {
  const index = new Map<string, HistoricalMatchIdentity[]>();
  for (const match of matches) {
    const kickoff = recordedOddsTimestamp(match.date);
    if (!kickoff) continue;
    const key = fixtureKey(match.competition, kickoff, normalizeTeamName(match.home_team_name), normalizeTeamName(match.away_team_name));
    const bucket = index.get(key) ?? []; bucket.push(match); index.set(key, bucket);
    index.set(JSON.stringify(['id', match.match_id]), [match]);
  }
  return index;
}
export type HistoricalObservedQuote = Omit<ResearchQuote, 'updatedAt'> & {
  updatedAt?: string; timestampEvidence: 'observed_snapshot'; snapshotId: string; snapshotSource: string;
  providerUpdatedAt: null; observationAt: string; priceType: 'prematch';
  sourceSelectionKey: string;
  matchLinkEvidence?: HistoricalSnapshotRow['matchLinkEvidence'];
};
export type HistoricalSnapshotObservation = {
  snapshotId: string; matchId: string; kickoffAt: string; observationAt: string;
  competition: string | null; season: string | null; source: string;
  providerUpdatedAt: null; t15FreshnessVerified: false; quotes: HistoricalObservedQuote[];
  matchLinkEvidence?: HistoricalSnapshotRow['matchLinkEvidence'];
};

/** Resolve old bulk rows locally, with the project's existing alias normalizer.
 * Never reverse teams, infer a day/time, or mutate the remote snapshot identity.
 */
export function linkHistoricalSnapshot(row: HistoricalSnapshotRow, matches: HistoricalMatchIdentity[] | HistoricalFixtureIndex,
  normalizeTeamName: (value: string) => string): { row: HistoricalSnapshotRow; reason: string | null } {
  const index = Array.isArray(matches) ? buildHistoricalFixtureIndex(matches, normalizeTeamName) : matches;
  if (row.match_id && row.match_date) {
    const known = index.get(JSON.stringify(['id', row.match_id]))?.[0];
    if (known && row.home_team_name && row.away_team_name
      && (normalizeTeamName(row.home_team_name) !== normalizeTeamName(known.home_team_name)
        || normalizeTeamName(row.away_team_name) !== normalizeTeamName(known.away_team_name))) {
      return { row: { ...row, match_id: null, match_date: null }, reason: 'linked_fixture_team_mismatch' };
    }
    return { row: { ...row, matchLinkEvidence: { method: 'existing_match_id', originalMatchId: row.match_id } }, reason: null };
  }
  const kickoff = recordedOddsTimestamp(row.commence_time);
  const home = normalizeTeamName(row.home_team_name ?? ''), away = normalizeTeamName(row.away_team_name ?? '');
  if (!kickoff || !home || !away || home === away || !row.competition) return { row, reason: 'fixture_identity_incomplete' };
  const candidates = index.get(fixtureKey(row.competition, kickoff, home, away)) ?? [];
  if (candidates.length !== 1) return { row, reason: candidates.length ? 'ambiguous_fixture_identity' : 'exact_fixture_not_found' };
  const match = candidates[0];
  return { row: { ...row, match_id: match.match_id, match_date: match.date, season: match.season,
    matchLinkEvidence: { method: 'unique_exact_fixture', originalMatchId: row.match_id ?? null } }, reason: null };
}

/** SQLite datetime values without an offset are UTC; date-only values remain inadmissible. */
export function recordedOddsTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(value.trim())) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number), calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return null;
  const iso = value.trim().replace(' ', 'T');
  const parsed = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
const object = (value: unknown): Record<string, any> => {
  if (typeof value !== 'string' || !value.trim()) return {};
  try { const parsed = JSON.parse(value); return parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed : {}; }
  catch { return {}; }
};
const price = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 1;
const goalLine = (raw: string): number => {
  if (raw.includes('.') || raw.length === 1) return Number(raw);
  if (/^\d5$/.test(raw)) return Number(raw) / 10;
  if (/^\d(?:25|75)$/.test(raw)) return Number(raw) / 100;
  return Number.NaN;
};

/** Decode only existing goal-selection conventions; specialist/ambiguous keys stay out. */
export function historicalGoalSelection(selection: string): Pick<ResearchQuote, 'market' | 'side' | 'line' | 'team'> | null {
  if (['1', 'X', '2'].includes(selection)) return { market: '1x2', side: selection === '1' ? 'home' : selection === '2' ? 'away' : 'draw' };
  if (['homeWin', 'draw', 'awayWin'].includes(selection)) return { market: '1x2', side: selection === 'homeWin' ? 'home' : selection === 'awayWin' ? 'away' : 'draw' };
  if (/^double_chance_(1x|x2|12)$/.test(selection)) return { market: 'double_chance', side: selection.slice(14) as '1x' | 'x2' | '12' };
  if (/^dnb_(home|away)$/.test(selection)) return { market: 'dnb', side: selection.slice(4) as 'home' | 'away' };
  if (selection === 'btts' || selection === 'bttsNo') return { market: 'btts', side: selection === 'btts' ? 'yes' : 'no' };
  const total = /^(over|under)(\d+(?:\.\d+)?)$/.exec(selection);
  if (total) {
    const line = goalLine(total[2]);
    if (line >= 0 && line <= 10 && Math.abs(line * 4 - Math.round(line * 4)) < 1e-8) return { market: 'totals', side: total[1] as 'over' | 'under', line };
  }
  const team = /^team_(home|away)_(over|under)_(\d+(?:\.\d+)?)$/.exec(selection);
  if (team) {
    const line = goalLine(team[3]);
    if (line >= 0 && line <= 10 && Math.abs(line * 4 - Math.round(line * 4)) < 1e-8) return { market: 'team_totals', team: team[1] as 'home' | 'away', side: team[2] as 'over' | 'under', line };
  }
  const asian = /^ahcp_(away_)?(-?\d+(?:\.\d+)?)$/.exec(selection);
  if (asian && Math.abs(Number(asian[2]) * 4 - Math.round(Number(asian[2]) * 4)) < 1e-8) return { market: 'asian_handicap', side: asian[1] ? 'away' : 'home', line: Number(asian[2]) };
  // Legacy European key signs are not a uniformly documented price convention.
  // They are not reinterpreted as the selected team's Asian adjustment.
  return null;
}

function groupKey(quote: Pick<ResearchQuote, 'market' | 'side' | 'line' | 'team'>): string {
  const line = quote.market === 'asian_handicap' && quote.side === 'away' ? -Number(quote.line) : quote.line;
  return [quote.market, quote.team ?? '', line ?? ''].join(':');
}
function completeGroup(quotes: HistoricalObservedQuote[]): boolean {
  const market: GoalMarket = quotes[0].market;
  const sides = new Set(quotes.map((quote) => quote.side));
  const expected = market === '1x2' ? ['home', 'draw', 'away'] : market === 'double_chance' ? ['1x', 'x2', '12']
    : market === 'btts' ? ['yes', 'no'] : ['dnb', 'asian_handicap'].includes(market) ? ['home', 'away'] : ['over', 'under'];
  return expected.every((side) => sides.has(side as ResearchQuote['side']));
}

/** A historical observation is not a provider last_update and never proves T-15 freshness. */
export function historicalSnapshotObservation(row: HistoricalSnapshotRow): {
  observation: HistoricalSnapshotObservation | null; reason: string | null;
} {
  const reject = (reason: string) => ({ observation: null, reason });
  if (row.used_synthetic_odds === true || Number(row.used_synthetic_odds) === 1 || /synthetic|estimated|model|completion/i.test(row.source)) return reject('synthetic_or_model_completed');
  if (!row.match_id || !row.match_date) return reject('match_or_kickoff_missing');
  const observationAt = recordedOddsTimestamp(row.captured_at), kickoffAt = recordedOddsTimestamp(row.match_date);
  if (!observationAt || !kickoffAt) return reject('invalid_observation_or_kickoff_time');
  if (Date.parse(observationAt) >= Date.parse(kickoffAt)) return reject('observed_at_or_after_kickoff');
  const providerKickoff = recordedOddsTimestamp(row.commence_time);
  if (providerKickoff && providerKickoff !== kickoffAt) return reject('provider_kickoff_mismatch');
  const isOddsApi = /^(?:the_)?odds_api(?:_|$)/i.test(row.source);
  const isEurobet = /^eurobet(?:_|$)/i.test(row.source);
  if (!isOddsApi && !isEurobet) return reject('unknown_snapshot_source');
  const bookmakerMaps = object(row.all_bookmaker_odds_json);
  if (!Object.keys(bookmakerMaps).length) {
    const bookmaker = String(row.selected_bookmaker_name ?? '').trim() || (isEurobet ? 'Eurobet' : '');
    const observed = object(row.live_selected_odds_json);
    if (bookmaker) bookmakerMaps[bookmaker] = Object.keys(observed).length ? observed : object(row.selected_odds_json);
  }
  const grouped = new Map<string, Map<string, HistoricalObservedQuote[]>>();
  for (const [bookmaker, values] of Object.entries(bookmakerMaps)) {
    if (!bookmaker.trim() || !values || typeof values !== 'object' || Array.isArray(values)) continue;
    const byMarket = new Map<string, HistoricalObservedQuote[]>();
    const ambiguousGroups = new Set<string>();
    for (const [selection, odds] of Object.entries(values)) {
      const decoded = historicalGoalSelection(selection);
      if (!decoded || !price(odds)) continue;
      const canonicalSelection = selection === '1' ? 'homeWin' : selection === 'X' ? 'draw' : selection === '2' ? 'awayWin'
        : decoded.market === 'team_totals' ? `team_${decoded.team}_${decoded.side}_${decoded.line}` : selection;
      const quote: HistoricalObservedQuote = { ...decoded, selection: canonicalSelection, sourceSelectionKey: selection, odds, bookmaker,
        source: isOddsApi ? 'odds_api' : 'eurobet_scraper', capturedAt: observationAt,
        timestampEvidence: 'observed_snapshot', snapshotId: row.snapshot_id, snapshotSource: row.source,
        matchLinkEvidence: row.matchLinkEvidence,
        providerUpdatedAt: null, observationAt, priceType: 'prematch' };
      const key = groupKey(quote), bucket = byMarket.get(key) ?? [];
      const previous = bucket.find((entry) => entry.selection === canonicalSelection);
      if (previous && previous.odds !== odds) ambiguousGroups.add(key);
      if (!previous) bucket.push(quote);
      byMarket.set(key, bucket);
    }
    for (const [key, quotes] of byMarket) {
      if (ambiguousGroups.has(key) || !completeGroup(quotes)) continue;
      const books = grouped.get(key) ?? new Map<string, HistoricalObservedQuote[]>(); books.set(bookmaker, quotes); grouped.set(key, books);
    }
  }
  const preference = (name: string) => /eurobet/i.test(name) ? 0 : /(?:\(IT\)|italia|_it$)/i.test(name) ? 1 : 2;
  const quotes = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, books]) => {
    const book = [...books.keys()].sort((a, b) => preference(a) - preference(b) || a.localeCompare(b))[0];
    return books.get(book)!;
  });
  if (!quotes.length) return reject('complete_real_bookmaker_partition_missing');
  return { observation: { snapshotId: row.snapshot_id, matchId: row.match_id, kickoffAt, observationAt,
    competition: row.competition ?? null, season: row.season ?? null, source: row.source,
    matchLinkEvidence: row.matchLinkEvidence,
    providerUpdatedAt: null, t15FreshnessVerified: false, quotes }, reason: null };
}

/** Choose a recorded entry, not a stale price transplanted into the later T-15 forecast. */
export function selectHistoricalObservation(observations: HistoricalSnapshotObservation[], input: {
  matchId: string; forecastCutoff: string; modelAvailableThrough?: string;
}): HistoricalSnapshotObservation | null {
  const cutoff = recordedOddsTimestamp(input.forecastCutoff);
  const modelTime = input.modelAvailableThrough ? recordedOddsTimestamp(input.modelAvailableThrough) : null;
  if (!cutoff || input.modelAvailableThrough && !modelTime) return null;
  return observations.filter((row) => row.matchId === input.matchId && Date.parse(row.observationAt) <= Date.parse(cutoff)
    && (!modelTime || Date.parse(row.observationAt) > Date.parse(modelTime)))
    .sort((a, b) => Date.parse(b.observationAt) - Date.parse(a.observationAt) || a.snapshotId.localeCompare(b.snapshotId))[0] ?? null;
}

/** Existing football-data JSON discarded source columns/bookmakers; no identity can be recovered honestly. */
export function footballDataHistoricalEvidence(value: unknown): { available: boolean; openingSelections: number;
  closingSelections: number; economicAdmissible: false; reason: string } {
  const parsed = object(value);
  const count = (values: unknown) => values && typeof values === 'object' ? Object.values(values).filter(price).length : 0;
  const openingSelections = count(parsed.opening), closingSelections = count(parsed.closing);
  return { available: openingSelections + closingSelections > 0, openingSelections, closingSelections,
    economicAdmissible: false, reason: 'aggregate_or_unknown_bookmaker_and_observation_timestamp' };
}
