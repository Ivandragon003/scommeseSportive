import type { DixonColesModel, MatchData, SupplementaryData } from '../models/core/DixonColesModel';
import type { PoissonXgModel } from '../models/core/PoissonXgModel';
import { PredictionContextBuilder, type ContextualPredictionInput } from './PredictionContextBuilder';
import { HISTORICAL_RESULT_DELAY_MS } from './ChronologicalForecastService';
import { blendGoalProbabilities, EnsembleConfig } from './ProbabilityEnsembleService';
import type { PreparedForecast } from './SharedForecastCalculator';

const FORM_MATCHES = 5;

export function modelARecentForm(target: MatchData, history: MatchData[], asOf: Date = target.date) {
  const competition = target.competition?.trim();
  const seasonKey = (value?: string) => value?.trim().replace('-', '/');
  const season = seasonKey(target.season);
  const cutoff = Math.min(target.date.getTime(), asOf.getTime());
  if (!competition || !season || !Number.isFinite(cutoff)) return undefined;

  const eligible = history.filter(match => {
    const kickoff = match.date.getTime();
    return match.matchId && match.matchId !== target.matchId
      && match.competition?.trim() === competition && seasonKey(match.season) === season
      && kickoff + HISTORICAL_RESULT_DELAY_MS <= cutoff
      && Number.isInteger(match.homeGoals) && match.homeGoals! >= 0
      && Number.isInteger(match.awayGoals) && match.awayGoals! >= 0;
  }).sort((a, b) => b.date.getTime() - a.date.getTime() || a.matchId.localeCompare(b.matchId));
  const distinct = [...new Map(eligible.map(match => [match.matchId, match])).values()];

  const index = (team: string) => {
    const lastFive = distinct.filter(match => match.homeTeamId === team || match.awayTeamId === team).slice(0, FORM_MATCHES);
    if (lastFive.length !== FORM_MATCHES) return undefined;
    const points = lastFive.reduce((total, match) => {
      const diff = (match.homeGoals! - match.awayGoals!) * (match.homeTeamId === team ? 1 : -1);
      return total + (diff > 0 ? 3 : diff === 0 ? 1 : 0);
    }, 0);
    return points / (3 * FORM_MATCHES);
  };
  const homeFormIndex = index(target.homeTeamId);
  const awayFormIndex = index(target.awayTeamId);
  return homeFormIndex === undefined || awayFormIndex === undefined ? undefined : { homeFormIndex, awayFormIndex };
}

export function modelAFormAdjustments(
  form: NonNullable<ReturnType<typeof modelARecentForm>>,
  request: ContextualPredictionInput,
  competitiveness?: number,
) {
  return new PredictionContextBuilder().build({
    request: { ...request, ...form, competitiveness },
    homeTeam: null, awayTeam: null, referee: null, homePlayers: [], awayPlayers: [],
  }).supplementaryData.contextAdjustments;
}

export function historicalModelAFormAdjustments(target: MatchData, history: MatchData[], competitiveness?: number) {
  const form = modelARecentForm(target, history);
  if (!form) return undefined;
  const day = 86_400_000;
  const cutoff = target.date.getTime();
  const schedule = (teamId: string) => {
    const times = history
      .filter(m => m.matchId !== target.matchId && (m.homeTeamId === teamId || m.awayTeamId === teamId))
      .map(m => m.date.getTime())
      .filter(time => time + HISTORICAL_RESULT_DELAY_MS <= cutoff);
    return {
      rest: Math.round((cutoff - Math.max(...times)) / day),
      recent: times.filter(time => cutoff - time <= 14 * day).length,
    };
  };
  const home = schedule(target.homeTeamId), away = schedule(target.awayTeamId);
  return modelAFormAdjustments(form, {
    homeRestDays: home.rest, awayRestDays: away.rest,
    homeRecentMatchesCount: home.recent, awayRecentMatchesCount: away.recent,
  }, competitiveness);
}

/** Replace only 1X2, after callers have derived the other markets from the standard forecast. */
export function applyModelAOneXTwoForm(
  flat: Record<string, number>, model: DixonColesModel, prepared: PreparedForecast,
  poisson: PoissonXgModel | null, ensemble: EnsembleConfig, homeXG?: number, awayXG?: number,
  adjustments?: SupplementaryData['contextAdjustments'],
): void {
  if (!adjustments) return;
  const { homeTeamId, awayTeamId } = prepared;
  const { homeWin, draw, awayWin } = model.computeFullProbabilities(homeTeamId, awayTeamId, homeXG, awayXG,
    { contextAdjustments: adjustments }).flatProbabilities;
  const partner = ensemble.enabled && poisson?.hasParams() ? poisson.computeGoalProbabilities(homeTeamId, awayTeamId) : null;
  Object.assign(flat, blendGoalProbabilities({ homeWin, draw, awayWin }, partner, ensemble));
}
