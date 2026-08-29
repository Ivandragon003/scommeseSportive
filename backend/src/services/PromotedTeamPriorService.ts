import { clamp } from '../models/utils/MathUtils';

/**
 * A deliberately small, transparent bridge between a promoted team's last
 * complete second-tier season and its first top-flight fixtures.
 *
 * It is not xG and it must never be presented as such: the source only holds
 * observed results.  We therefore use it as a bounded relative goal-rate
 * signal and fade it out as actual top-flight results become available.
 */
export interface PromotedTeamHistoryRow {
  transition_type?: string | null;
  transition_mode?: string | null;
  coverage_status?: string | null;
  source_quality?: string | null;
  source_season?: string | null;
  source_competition_id?: string | null;
  lower_matches?: number | null;
  goals_for_per_match?: number | null;
  goals_against_per_match?: number | null;
  league_goals_for_per_match?: number | null;
  completed_top_flight_matches?: number | null;
}

export interface PromotedTeamPrior {
  applied: boolean;
  sourceSeason: string;
  sourceCompetitionId: string;
  lowerDivisionMatches: number;
  completedTopFlightMatches: number;
  weight: number;
  attackIndex: number;
  concessionIndex: number;
  /** Confidence evidence only; it can never unlock HIGH on its own. */
  evidenceCoveragePercent: number;
  reason?: string;
}

export interface PromotedMatchXgAdjustment {
  homeXG?: number;
  awayXG?: number;
  homePrior: PromotedTeamPrior | null;
  awayPrior: PromotedTeamPrior | null;
}

const MIN_LOWER_DIVISION_MATCHES = 20;
const FADE_OUT_AFTER_TOP_FLIGHT_MATCHES = 8;
const MAX_PRIOR_WEIGHT = 0.30;

const asFinite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

export function buildPromotedTeamPrior(row: PromotedTeamHistoryRow | null | undefined): PromotedTeamPrior | null {
  if (!row) return null;
  const matches = asFinite(row.lower_matches);
  const goalsFor = asFinite(row.goals_for_per_match);
  const goalsAgainst = asFinite(row.goals_against_per_match);
  const leagueGoals = asFinite(row.league_goals_for_per_match);
  const topFlightMatches = Math.max(0, asFinite(row.completed_top_flight_matches) ?? 0);
  const sourceSeason = String(row.source_season ?? '').trim();
  const sourceCompetitionId = String(row.source_competition_id ?? '').trim();

  if (String(row.transition_type ?? '').toLowerCase() !== 'promoted') return null;
  if (String(row.coverage_status ?? '').toLowerCase() !== 'complete') return null;
  const sourceQuality = String(row.source_quality ?? '').toLowerCase();
  const transitionMode = String(row.transition_mode ?? '').toLowerCase();
  // Existing direct promotions are intentionally stored as "estimated": the
  // CSV proves the final ranking but does not try to infer playoff winners.
  // A complete, direct 1st/2nd-place promotion is nevertheless deterministic;
  // playoff and all other unconfirmed transitions remain fail-closed.
  const deterministicDirectPromotion = sourceQuality === 'estimated'
    && (transitionMode === 'direct_1' || transitionMode === 'direct_2');
  if (sourceQuality !== 'confirmed' && !deterministicDirectPromotion) return null;
  if (matches === null || matches < MIN_LOWER_DIVISION_MATCHES || goalsFor === null || goalsFor <= 0 || goalsAgainst === null || goalsAgainst < 0 || leagueGoals === null || leagueGoals <= 0 || !sourceSeason || !sourceCompetitionId) {
    return null;
  }

  // A complete 38-game season is fully eligible; shorter but valid seasons
  // contribute proportionally.  The influence disappears after eight actual
  // top-flight games, where the primary Understat model has direct evidence.
  const sampleWeight = clamp(matches / 38, 0, 1);
  const fade = clamp(1 - (topFlightMatches / FADE_OUT_AFTER_TOP_FLIGHT_MATCHES), 0, 1);
  const weight = Number((MAX_PRIOR_WEIGHT * sampleWeight * fade).toFixed(4));
  if (weight <= 0) return null;

  return {
    applied: true,
    sourceSeason,
    sourceCompetitionId,
    lowerDivisionMatches: Math.round(matches),
    completedTopFlightMatches: Math.round(topFlightMatches),
    weight,
    // Clamps keep a very unusual lower-tier season from overwhelming the
    // top-flight model.  1 means exactly league-average for that season.
    attackIndex: Number(clamp(goalsFor / leagueGoals, 0.65, 1.45).toFixed(4)),
    concessionIndex: Number(clamp(goalsAgainst / leagueGoals, 0.65, 1.45).toFixed(4)),
    evidenceCoveragePercent: 40,
  };
}

/**
 * Applies the relative lower-division signal to the xG inputs.  The model
 * still supplies the baseline and the final DC probability matrix; this
 * function only nudges goals-for and goals-against in the first fixtures.
 */
export function applyPromotedTeamPriors(params: {
  homeXG?: number;
  awayXG?: number;
  homePrior: PromotedTeamPrior | null;
  awayPrior: PromotedTeamPrior | null;
}): PromotedMatchXgAdjustment {
  const homeBase = asFinite(params.homeXG);
  const awayBase = asFinite(params.awayXG);
  let homeXG = homeBase ?? undefined;
  let awayXG = awayBase ?? undefined;

  const nudge = (base: number | undefined, index: number, weight: number): number | undefined => {
    if (base === undefined || base <= 0) return base;
    return Number((base * (1 + weight * (index - 1))).toFixed(4));
  };

  // A promoted home team affects its own attack and the away side's expected
  // goals through the goals it conceded in the lower division; vice versa for
  // a promoted away team.
  if (params.homePrior) {
    homeXG = nudge(homeXG, params.homePrior.attackIndex, params.homePrior.weight);
    awayXG = nudge(awayXG, params.homePrior.concessionIndex, params.homePrior.weight);
  }
  if (params.awayPrior) {
    awayXG = nudge(awayXG, params.awayPrior.attackIndex, params.awayPrior.weight);
    homeXG = nudge(homeXG, params.awayPrior.concessionIndex, params.awayPrior.weight);
  }

  return { homeXG, awayXG, homePrior: params.homePrior, awayPrior: params.awayPrior };
}

/** A promoted prior may lift missing-history evidence only to MEDIUM. */
export function effectiveCoverageWithPromotedPrior(
  rawCoveragePercent: number | null | undefined,
  prior: PromotedTeamPrior | null,
): number | null {
  const raw = asFinite(rawCoveragePercent);
  if (!prior) return raw === null ? null : clamp(raw, 0, 100);
  return Math.min(60, Math.max(raw ?? 0, prior.evidenceCoveragePercent));
}
