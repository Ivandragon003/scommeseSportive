import { clamp } from '../models/utils/MathUtils';

/**
 * Factual, team-only history for a side entering a top division from its
 * corresponding second division. No player information and no synthetic xG
 * are used here: the source contains observed team results and match stats.
 */
export interface LowerDivisionHistoryRow {
  source_season?: string | null;
  source_competition_id?: string | null;
  coverage_status?: string | null;
  transition_mode?: string | null;
  lower_matches?: number | null;
  completed_top_flight_matches?: number | null;
  goals_for_per_match?: number | null;
  goals_against_per_match?: number | null;
  shots_for_per_match?: number | null;
  shots_against_per_match?: number | null;
  shots_on_target_for_per_match?: number | null;
  shots_on_target_against_per_match?: number | null;
  fouls_for_per_match?: number | null;
  fouls_against_per_match?: number | null;
  corners_for_per_match?: number | null;
  corners_against_per_match?: number | null;
  yellow_cards_for_per_match?: number | null;
  yellow_cards_against_per_match?: number | null;
}

export interface PromotedTeamPrior {
  applied: true;
  sourceCompetitionId: string;
  sourceSeasons: string[];
  lowerDivisionMatches: number;
  completedTopFlightMatches: number;
  transitionEvidence: 'direct' | 'previous_lower_tier';
  /** Confidence evidence only; it can never unlock HIGH on its own. */
  evidenceCoveragePercent: number;
  teamProfile: {
    goalsForPerMatch: number | null;
    goalsAgainstPerMatch: number | null;
    shotsForPerMatch: number | null;
    shotsAgainstPerMatch: number | null;
    shotsOnTargetForPerMatch: number | null;
    shotsOnTargetAgainstPerMatch: number | null;
    foulsForPerMatch: number | null;
    foulsAgainstPerMatch: number | null;
    cornersForPerMatch: number | null;
    cornersAgainstPerMatch: number | null;
    yellowCardsForPerMatch: number | null;
    yellowCardsAgainstPerMatch: number | null;
  };
}

const MIN_LOWER_DIVISION_MATCHES = 20;
const MAX_CONTIGUOUS_SEASONS = 5;

const asFinite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const seasonStart = (value: unknown): number | null => {
  const match = String(value ?? '').match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
};

/** Map public competition names to the stable transition catalogue IDs. */
export function destinationCompetitionIdFor(competition: unknown): string | null {
  const normalized = String(competition ?? '').trim().toLowerCase();
  const ids: Record<string, string> = {
    'serie a': 'serie_a',
    'premier league': 'premier_league',
    'la liga': 'la_liga',
    bundesliga: 'bundesliga',
    'ligue 1': 'ligue_1',
  };
  return ids[normalized] ?? null;
}

/** Maps each supported top division to its factual lower-division source. */
export function sourceCompetitionIdFor(competition: unknown): string | null {
  const destination = destinationCompetitionIdFor(competition);
  const sources: Record<string, string> = {
    serie_a: 'serie_b',
    premier_league: 'championship',
    la_liga: 'segunda_division',
    bundesliga: '2_bundesliga',
    ligue_1: 'ligue_2',
  };
  return destination ? sources[destination] ?? null : null;
}

/**
 * Builds a profile from up to five *contiguous* lower-division seasons ending
 * immediately before the top-flight season. A gap stops the lookback: an old
 * stint in Serie B must not be silently applied after intervening top-flight
 * seasons. Newer seasons receive more evidence weight, while a longer season
 * contributes more than a short one.
 */
export function buildPromotedTeamPrior(
  rows: LowerDivisionHistoryRow[] | null | undefined,
  destinationSeason: string,
): PromotedTeamPrior | null {
  const targetStart = seasonStart(destinationSeason);
  if (!targetStart || !Array.isArray(rows)) return null;
  const byStart = new Map(rows.map((row) => [seasonStart(row.source_season), row]));
  const selected: Array<{ row: LowerDivisionHistoryRow; weight: number }> = [];

  for (let age = 0; age < MAX_CONTIGUOUS_SEASONS; age += 1) {
    const row = byStart.get(targetStart - 1 - age);
    const matches = asFinite(row?.lower_matches);
    if (!row || String(row.coverage_status ?? '').toLowerCase() !== 'complete' || matches === null || matches < MIN_LOWER_DIVISION_MATCHES) break;
    // This is evidence weighting, not a probability-model coefficient. The
    // latest completed season dominates without discarding factual continuity.
    selected.push({ row, weight: matches / (age + 1) });
  }
  if (selected.length === 0) return null;

  const weightedAverage = (field: keyof LowerDivisionHistoryRow): number | null => {
    let numerator = 0;
    let denominator = 0;
    for (const item of selected) {
      const value = asFinite(item.row[field]);
      if (value === null) continue;
      numerator += value * item.weight;
      denominator += item.weight;
    }
    return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
  };
  const newest = selected[0].row;
  const sourceCompetitionId = String(newest.source_competition_id ?? '').trim();
  if (!sourceCompetitionId) return null;
  const direct = ['direct_1', 'direct_2', 'direct_3', 'playoff'].includes(
    String(newest.transition_mode ?? '').toLowerCase(),
  );

  return {
    applied: true,
    sourceCompetitionId,
    sourceSeasons: selected.map(({ row }) => String(row.source_season)),
    lowerDivisionMatches: selected.reduce((sum, { row }) => sum + Math.round(asFinite(row.lower_matches) ?? 0), 0),
    completedTopFlightMatches: Math.max(0, Math.round(asFinite(newest.completed_top_flight_matches) ?? 0)),
    transitionEvidence: direct ? 'direct' : 'previous_lower_tier',
    evidenceCoveragePercent: 40,
    teamProfile: {
      goalsForPerMatch: weightedAverage('goals_for_per_match'),
      goalsAgainstPerMatch: weightedAverage('goals_against_per_match'),
      shotsForPerMatch: weightedAverage('shots_for_per_match'),
      shotsAgainstPerMatch: weightedAverage('shots_against_per_match'),
      shotsOnTargetForPerMatch: weightedAverage('shots_on_target_for_per_match'),
      shotsOnTargetAgainstPerMatch: weightedAverage('shots_on_target_against_per_match'),
      foulsForPerMatch: weightedAverage('fouls_for_per_match'),
      foulsAgainstPerMatch: weightedAverage('fouls_against_per_match'),
      cornersForPerMatch: weightedAverage('corners_for_per_match'),
      cornersAgainstPerMatch: weightedAverage('corners_against_per_match'),
      yellowCardsForPerMatch: weightedAverage('yellow_cards_for_per_match'),
      yellowCardsAgainstPerMatch: weightedAverage('yellow_cards_against_per_match'),
    },
  };
}

/** A promoted-team profile may lift missing-history evidence only to MEDIUM. */
export function effectiveCoverageWithPromotedPrior(
  rawCoveragePercent: number | null | undefined,
  prior: PromotedTeamPrior | null,
): number | null {
  const raw = asFinite(rawCoveragePercent);
  if (!prior) return raw === null ? null : clamp(raw, 0, 100);
  return Math.min(60, Math.max(raw ?? 0, prior.evidenceCoveragePercent));
}
