import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DixonColesModel, MatchData } from '../models/core/DixonColesModel';
import { PoissonXgModel } from '../models/core/PoissonXgModel';
import { BacktestingEngine } from '../models/backtesting/BacktestingEngine';
import { HISTORICAL_RESULT_DELAY_MS } from '../services/ChronologicalForecastService';
import { blendGoalProbabilities } from '../services/ProbabilityEnsembleService';
import { predictionConfig } from '../config/predictionConfig';
import { predictionEngineConfig } from '../config/PredictionEngineConfig';
import { ALGORITHM_VERSION, BACKTEST_ENGINE_VERSION, RANKING_VERSION } from '../config/algorithmVersions';

export const FEATURE_SCHEMA_VERSION = 'prematch-numeric-v1';
export const BASELINE_PROTOCOL_VERSION = 'statistical-asof-v1';
export const TOP5_COMPETITIONS = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'] as const;
const WEEK_MS = 7 * 86400000;
const MIN_TRAINING_MATCHES = 30;

export interface ResearchMatch {
  matchId: string; homeTeamId: string; awayTeamId: string; date: string;
  competition: string; season?: string;
  homeGoals?: number | null; awayGoals?: number | null;
  homeXG?: number | null; awayXG?: number | null;
  homeTotalShots?: number | null; awayTotalShots?: number | null;
  homeShotsOnTarget?: number | null; awayShotsOnTarget?: number | null;
  homeYellowCards?: number | null; awayYellowCards?: number | null;
  homeRedCards?: number | null; awayRedCards?: number | null;
  homeFouls?: number | null; awayFouls?: number | null;
  /** Optional observed availability; never earlier than the conservative result delay. */
  availableAt?: string;
}

export interface ForecastInput {
  matchId: string; competition: string; kickoffAt: string; forecastAt: string;
  season?: string; homeTeamId?: string; awayTeamId?: string;
  features: number[]; featureNames: string[]; featureSchema: string;
  baselineMatrix: number[][]; baselineProbabilities: Record<string, number>;
  lambdaHome: number; lambdaAway: number; maxTrainingAvailableAt: string | null;
  trainingCount: number; modelFitAt: string; baselineVersion: string;
}

export interface TrainingRow extends ForecastInput {
  homeGoals: number; awayGoals: number; availableAt: string;
}

export interface TrainingDataset {
  schemaVersion: string; featureNames: string[]; asOf: string;
  baselineManifest: ReturnType<typeof baselineManifest>; rows: TrainingRow[];
  exclusions: { insufficientHistory: number; incomplete: number; outsideTop5: number };
}

const teamFeatureNames = ['elo', 'sample', 'goals_for', 'goals_against', 'xg_for', 'xg_against',
  'xg_coverage', 'shots_for', 'shots_against', 'recent_points', 'recent_goal_diff',
  'venue_goals_for', 'venue_goals_against', 'rest_days', 'season_goals_for', 'season_goals_against'];
export const FEATURE_NAMES = [...teamFeatureNames.map((name) => `home_${name}`),
  ...teamFeatureNames.map((name) => `away_${name}`), 'elo_difference', 'lambda_home_A', 'lambda_away_A',
  ...TOP5_COMPETITIONS.map((_, index) => `league_${index}`)];

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const completed = (match: ResearchMatch): boolean => finite(match.homeGoals) && finite(match.awayGoals)
  && match.homeGoals >= 0 && match.awayGoals >= 0 && Number.isInteger(match.homeGoals) && Number.isInteger(match.awayGoals);
const time = (value: string): number => Date.parse(value);
const resultAvailableAt = (match: ResearchMatch): number => Math.max(time(match.date) + HISTORICAL_RESULT_DELAY_MS,
  Number.isFinite(time(match.availableAt ?? '')) ? time(match.availableAt!) : 0);
const normalizeCompetition = (competition: string): string => ({ EPL: 'Premier League', La_liga: 'La Liga',
  Bundesliga: 'Bundesliga', Ligue_1: 'Ligue 1', Serie_A: 'Serie A', 'La liga': 'La Liga' }[competition] ?? competition);

/** Result values and optional statistics are copied only after the temporal eligibility test. */
function eligibleHistory(history: ResearchMatch[], targetId: string, forecastAt: number, competition?: string): ResearchMatch[] {
  const seen = new Set<string>();
  return history.filter((match) => {
    if (match.matchId === targetId || seen.has(match.matchId) || !Number.isFinite(time(match.date)) || !completed(match)
      || resultAvailableAt(match) > forecastAt || (competition && normalizeCompetition(match.competition) !== competition)) return false;
    seen.add(match.matchId); return true;
  }).sort((a, b) => time(a.date) - time(b.date) || a.matchId.localeCompare(b.matchId));
}

function toMatchData(match: ResearchMatch): MatchData {
  const out: MatchData = { matchId: match.matchId, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
    date: new Date(match.date), competition: normalizeCompetition(match.competition), season: match.season };
  for (const key of ['homeGoals', 'awayGoals', 'homeXG', 'awayXG', 'homeTotalShots', 'awayTotalShots',
    'homeShotsOnTarget', 'awayShotsOnTarget', 'homeYellowCards', 'awayYellowCards', 'homeRedCards', 'awayRedCards',
    'homeFouls', 'awayFouls'] as const) if (finite(match[key])) out[key] = Number(match[key]);
  return out;
}

function sourceHashes(): Record<string, string> {
  const root = join(__dirname, '..'), extension = __filename.endsWith('.ts') ? '.ts' : '.js';
  const files: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.name.endsWith(extension) && !entry.name.endsWith('.d.ts')) files.push(file);
    }
  };
  // Include transitive mathematical dependencies, not only the public DC wrapper.
  collect(join(root, 'models')); collect(join(root, 'config'));
  for (const name of ['../services/PredictionContextBuilder', '../services/ProbabilityEnsembleService',
    '../services/ChronologicalForecastService', './ForecastCore']) files.push(require.resolve(name));
  return Object.fromEntries([...new Set(files)].sort().map((file) => [relative(root, file).replace(/\\/g, '/'),
    createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex')]));
}

const BASELINE_DETAILS = {
  protocolVersion: BASELINE_PROTOCOL_VERSION, algorithmVersion: ALGORITHM_VERSION,
  backtestEngineVersion: BACKTEST_ENGINE_VERSION, rankingVersion: RANKING_VERSION,
  featureSchema: FEATURE_SCHEMA_VERSION, minTrainingMatches: MIN_TRAINING_MATCHES,
  refitIntervalMs: WEEK_MS, resultDelayMs: HISTORICAL_RESULT_DELAY_MS,
  predictionConfig: JSON.parse(JSON.stringify(predictionConfig)),
  predictionEngineConfig: JSON.parse(JSON.stringify(predictionEngineConfig)),
  fit: { iterations: 280, learningRate: 0.04 }, codeHashes: sourceHashes(),
  probabilityProtocol: 'Existing DC + Poisson-xG family ensemble and historical as-of supplementary context. Calibration and decision filtering are downstream, shared for A/C.',
  matrixProtocol: 'Joint proxy: DC + Poisson-xG with the configured default ensemble weight. If family weights differ, this proxy is not identical to every A flat marginal; official A market evaluation uses baselineProbabilities.',
  oddsAsFeatures: false, playerFeatures: false,
};
const BASELINE_HASH = createHash('sha256').update(JSON.stringify(BASELINE_DETAILS)).digest('hex');
export function baselineManifest(): typeof BASELINE_DETAILS & { version: string; fingerprint: string } {
  return JSON.parse(JSON.stringify({ ...BASELINE_DETAILS, version: `A-${BASELINE_HASH.slice(0, 16)}`, fingerprint: BASELINE_HASH }));
}

type FittedBaseline = { model: DixonColesModel; poisson: PoissonXgModel; fittedAt: number; count: number };
function fitBaseline(past: ResearchMatch[], forecastAt: number): FittedBaseline {
  if (past.length < MIN_TRAINING_MATCHES) throw new Error(`insufficient_history: need ${MIN_TRAINING_MATCHES} completed prior matches`);
  const model = new DixonColesModel();
  const matches = past.map(toMatchData);
  const teams = [...new Set(matches.flatMap((match) => [match.homeTeamId, match.awayTeamId]))];
  const params = model.fitModel(matches, teams, 280, 0.04, { referenceDate: new Date(forecastAt) });
  model.setParams({ ...params, homeAdvantage: Math.max(-0.8, Math.min(1.2, params.homeAdvantage * predictionConfig.model.homeAdvantageScale)) });
  const poisson = new PoissonXgModel(); poisson.fit(matches);
  return { model, poisson, fittedAt: forecastAt, count: past.length };
}

function poissonMatrix(home: number, away: number, size: number): number[][] {
  const pmf = (lambda: number): number[] => {
    const values = [Math.exp(-lambda)]; for (let i = 1; i < size; i++) values.push(values[i - 1] * lambda / i); return values;
  };
  const ph = pmf(home), pa = pmf(away);
  const matrix = ph.map((h) => pa.map((a) => h * a));
  const total = matrix.flat().reduce((a, b) => a + b, 0);
  return matrix.map((row) => row.map((p) => p / total));
}

function eloRatings(history: ResearchMatch[]): Map<string, number> {
  const ratings = new Map<string, number>();
  for (const match of history) {
    const h = ratings.get(match.homeTeamId) ?? 1500, a = ratings.get(match.awayTeamId) ?? 1500;
    const expected = 1 / (1 + Math.pow(10, (a - h - 60) / 400));
    const actual = match.homeGoals! > match.awayGoals! ? 1 : match.homeGoals === match.awayGoals ? 0.5 : 0;
    const delta = 20 * (actual - expected);
    ratings.set(match.homeTeamId, h + delta); ratings.set(match.awayTeamId, a - delta);
  }
  return ratings;
}

function teamFeatures(history: ResearchMatch[], teamId: string, homeVenue: boolean, season: string | undefined,
  forecastAt: number, ratings: Map<string, number>): number[] {
  const rows = history.filter((match) => match.homeTeamId === teamId || match.awayTeamId === teamId);
  const side = (match: ResearchMatch) => match.homeTeamId === teamId;
  const mean = (subset: ResearchMatch[], get: (match: ResearchMatch) => unknown, fallback = 0): number => {
    const values = subset.map(get).filter(finite); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : fallback;
  };
  const gf = (m: ResearchMatch) => side(m) ? m.homeGoals : m.awayGoals;
  const ga = (m: ResearchMatch) => side(m) ? m.awayGoals : m.homeGoals;
  const xgf = (m: ResearchMatch) => side(m) ? m.homeXG : m.awayXG;
  const xga = (m: ResearchMatch) => side(m) ? m.awayXG : m.homeXG;
  const recent = rows.slice(-5), venue = rows.filter((m) => side(m) === homeVenue), currentSeason = rows.filter((m) => m.season === season);
  return [ratings.get(teamId) ?? 1500, rows.length, mean(rows, gf, 1.3), mean(rows, ga, 1.3),
    mean(rows, xgf, 1.3), mean(rows, xga, 1.3), rows.length ? rows.filter((m) => finite(xgf(m)) && finite(xga(m))).length / rows.length : 0,
    mean(rows, (m) => side(m) ? m.homeTotalShots : m.awayTotalShots),
    mean(rows, (m) => side(m) ? m.awayTotalShots : m.homeTotalShots),
    mean(recent, (m) => gf(m)! > ga(m)! ? 3 : gf(m) === ga(m) ? 1 : 0),
    mean(recent, (m) => gf(m)! - ga(m)!), mean(venue, gf, 1.3), mean(venue, ga, 1.3),
    rows.length ? Math.min(60, Math.max(0, (forecastAt - time(rows[rows.length - 1].date)) / 86400000)) : 60,
    mean(currentSeason, gf, 1.3), mean(currentSeason, ga, 1.3)];
}

function forecastWithFit(history: ResearchMatch[], target: ResearchMatch, forecastAt: string, fit: FittedBaseline): ForecastInput {
  const cutoff = time(forecastAt), kickoff = time(target.date);
  if (!Number.isFinite(cutoff) || !Number.isFinite(kickoff) || cutoff > kickoff) throw new Error('forecastAt must be at or before kickoff');
  const competition = normalizeCompetition(target.competition);
  const past = eligibleHistory(history, target.matchId, cutoff, competition);
  if (fit.fittedAt > cutoff) throw new Error('future_model_parameters');
  const targetData: MatchData = { matchId: target.matchId, homeTeamId: target.homeTeamId, awayTeamId: target.awayTeamId,
    date: new Date(kickoff), competition, season: target.season };
  const context = new BacktestingEngine().buildAsOfPredictionContext(targetData, past.map(toMatchData));
  const full = fit.model.computeFullProbabilities(target.homeTeamId, target.awayTeamId, context.homeXG, context.awayXG, context.supplementaryData);
  const baselineProbabilities = blendGoalProbabilities(full.flatProbabilities,
    fit.poisson.computeGoalProbabilities(target.homeTeamId, target.awayTeamId), predictionEngineConfig.ensemble);
  const h = baselineProbabilities.homeWin, d = baselineProbabilities.draw, a = baselineProbabilities.awayWin;
  Object.assign(baselineProbabilities, { double_chance_1x: h + d, double_chance_x2: a + d, double_chance_12: h + a,
    dnb_home: h / Math.max(1e-12, h + a), dnb_away: a / Math.max(1e-12, h + a) });
  // Reconstruct the same DC matrix with context-adjusted intensities and fitted dependence.
  const dcMatrixModel = new DixonColesModel({ rho: fit.model.getParams().rho,
    attackParams: { home: Math.log(full.lambdaHome), away: Math.log(full.lambdaAway) },
    defenceParams: { home: 0, away: 0 }, homeAdvantage: 0, homeAdvantagePerTeam: {}, levelCorrection: undefined });
  const dependence = dcMatrixModel.buildScoreMatrix('home', 'away').probabilities;
  const poissonLambdas = fit.poisson.expectedGoals(target.homeTeamId, target.awayTeamId);
  const weight = predictionEngineConfig.ensemble.enabled && poissonLambdas
    ? Math.max(0, Math.min(1, predictionEngineConfig.ensemble.weights.default)) : 0;
  const partner = poissonLambdas ? poissonMatrix(poissonLambdas.lambdaHome, poissonLambdas.lambdaAway, dependence.length) : dependence;
  const baselineMatrix = dependence.map((row, i) => row.map((p, j) => (1 - weight) * p + weight * partner[i][j]));
  const allPast = eligibleHistory(history, target.matchId, cutoff);
  const ratings = eloRatings(allPast);
  const homeFeatures = teamFeatures(allPast, target.homeTeamId, true, target.season, cutoff, ratings);
  const awayFeatures = teamFeatures(allPast, target.awayTeamId, false, target.season, cutoff, ratings);
  const features = [...homeFeatures, ...awayFeatures, homeFeatures[0] - awayFeatures[0], full.lambdaHome, full.lambdaAway,
    ...TOP5_COMPETITIONS.map((name) => name === competition ? 1 : 0)];
  return { matchId: target.matchId, competition, season: target.season, homeTeamId: target.homeTeamId, awayTeamId: target.awayTeamId,
    kickoffAt: new Date(kickoff).toISOString(), forecastAt: new Date(cutoff).toISOString(),
    features, featureNames: [...FEATURE_NAMES], featureSchema: FEATURE_SCHEMA_VERSION, baselineMatrix, baselineProbabilities,
    lambdaHome: full.lambdaHome, lambdaAway: full.lambdaAway,
    maxTrainingAvailableAt: allPast.length ? new Date(Math.max(...allPast.map(resultAvailableAt))).toISOString() : null,
    trainingCount: fit.count, modelFitAt: new Date(fit.fittedAt).toISOString(), baselineVersion: baselineManifest().version };
}

export function buildForecastInput(history: ResearchMatch[], target: ResearchMatch, forecastAt: string): ForecastInput {
  const cutoff = time(forecastAt), competition = normalizeCompetition(target.competition);
  if (!TOP5_COMPETITIONS.includes(competition as any)) throw new Error('unsupported_competition');
  const past = eligibleHistory(history, target.matchId, cutoff, competition);
  return forecastWithFit(history, target, forecastAt, fitBaseline(past, cutoff));
}

/** All eligible matches, not only previous recommended bets; no silent 450-target cap. */
export function buildTrainingDataset(matches: ResearchMatch[], asOf: string): TrainingDataset {
  const cutoff = time(asOf); if (!Number.isFinite(cutoff)) throw new Error('invalid_asof');
  const exclusions = { insufficientHistory: 0, incomplete: 0, outsideTop5: 0 };
  const rows: TrainingRow[] = [], fits = new Map<string, FittedBaseline>();
  const sorted = [...matches].sort((a, b) => time(a.date) - time(b.date) || a.matchId.localeCompare(b.matchId));
  const ids = new Set<string>();
  for (const target of sorted) {
    if (ids.has(target.matchId)) throw new Error(`duplicate_match_id: ${target.matchId}`); ids.add(target.matchId);
    const competition = normalizeCompetition(target.competition);
    if (!TOP5_COMPETITIONS.includes(competition as any)) { exclusions.outsideTop5++; continue; }
    if (!completed(target) || !Number.isFinite(time(target.date)) || resultAvailableAt(target) > cutoff) { exclusions.incomplete++; continue; }
    const forecastAt = time(target.date) - 15 * 60000;
    const past = eligibleHistory(sorted, target.matchId, forecastAt, competition);
    if (past.length < MIN_TRAINING_MATCHES) { exclusions.insufficientHistory++; continue; }
    let fit = fits.get(competition);
    if (!fit || forecastAt - fit.fittedAt >= WEEK_MS) { fit = fitBaseline(past, forecastAt); fits.set(competition, fit); }
    const input = forecastWithFit(sorted, target, new Date(forecastAt).toISOString(), fit);
    rows.push({ ...input, homeGoals: target.homeGoals!, awayGoals: target.awayGoals!, availableAt: new Date(resultAvailableAt(target)).toISOString() });
  }
  return { schemaVersion: FEATURE_SCHEMA_VERSION, featureNames: [...FEATURE_NAMES], asOf: new Date(cutoff).toISOString(),
    baselineManifest: baselineManifest(), rows, exclusions };
}
