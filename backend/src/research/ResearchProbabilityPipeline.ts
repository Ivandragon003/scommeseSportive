import { ValueAnalysisContext, ValueBettingEngine } from '../models/value/ValueBettingEngine';
import { applyCalibrationToFlatProbabilities, FamilyCalibrationCurve } from '../models/value/EnhancedMarketAnalysis';
import { CalibrationProfile } from '../services/CalibrationProfileCache';
import { predictionEngineConfig } from '../config/PredictionEngineConfig';
import { MarketQuote, settleGoalQuote } from './GoalSettlement';

export interface CalibrationObservation {
  matchId: string; availableAt: string; probabilities: Record<string, number>;
  outcomes: Record<string, 0 | 1 | null>;
}
export interface ResearchCalibrationProfile extends CalibrationProfile {
  protocol: 'existing-isotonic-v1'; fittedThrough: string | null; matches: number;
}
const engine = new ValueBettingEngine();

/** Known binary labels only. Pushes remain null rather than invented losses. */
export function goalCalibrationObservation(matchId: string, availableAt: string,
  probabilities: Record<string, number>, homeGoals: number, awayGoals: number): CalibrationObservation {
  if (!Number.isSafeInteger(homeGoals) || !Number.isSafeInteger(awayGoals) || homeGoals < 0 || awayGoals < 0) throw new Error('invalid_goal_outcome');
  const home = homeGoals > awayGoals, away = awayGoals > homeGoals, draw = homeGoals === awayGoals;
  const outcomes: Record<string, 0 | 1 | null> = {
    homeWin: Number(home) as 0 | 1, draw: Number(draw) as 0 | 1, awayWin: Number(away) as 0 | 1,
    btts: Number(homeGoals > 0 && awayGoals > 0) as 0 | 1, bttsNo: Number(homeGoals === 0 || awayGoals === 0) as 0 | 1,
    double_chance_1x: Number(!away) as 0 | 1, double_chance_x2: Number(!home) as 0 | 1,
    double_chance_12: Number(!draw) as 0 | 1,
    dnb_home: draw ? null : Number(home) as 0 | 1, dnb_away: draw ? null : Number(away) as 0 | 1,
  };
  for (const key of Object.keys(probabilities)) {
    const total = /^(over|under)(05|15|25|35|45)$/.exec(key);
    const team = /^team_(home|away)_(over|under)_(\d+(?:\.\d+)?)$/.exec(key);
    const actual = team ? team[1] === 'home' ? homeGoals : awayGoals : homeGoals + awayGoals;
    const line = total ? Number(total[2]) / 10 : team ? Number(team[3]) : NaN;
    const side = total?.[1] ?? team?.[2];
    if (Number.isFinite(line) && line * 2 % 2 === 1) outcomes[key] = Number(side === 'over' ? actual > line : actual < line) as 0 | 1;
  }
  return { matchId, availableAt, probabilities, outcomes };
}

/** The same isotonic implementation and family thresholds used by PredictionService. */
export function fitResearchCalibration(observations: CalibrationObservation[], asOf: string): ResearchCalibrationProfile {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff)) throw new Error('invalid_calibration_cutoff');
  const predicted: number[] = [], observed: number[] = [];
  const families = new Map<string, { predicted: number[]; observed: number[] }>();
  const seen = new Set<string>(); let through: number | null = null;
  const ordered = [...observations].sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt)
    || a.matchId.localeCompare(b.matchId));
  for (const row of ordered) {
    const available = Date.parse(row.availableAt);
    if (!Number.isFinite(available) || available > cutoff || seen.has(row.matchId)) continue;
    seen.add(row.matchId); through = Math.max(through ?? available, available);
    for (const [key, probability] of Object.entries(row.probabilities)) {
      const outcome = row.outcomes[key];
      if (!Number.isFinite(probability) || probability <= 0 || probability >= 1 || (outcome !== 0 && outcome !== 1)) continue;
      predicted.push(probability); observed.push(outcome);
      const family = engine.categorizeSelection(key), bucket = families.get(family) ?? { predicted: [], observed: [] };
      bucket.predicted.push(probability); bucket.observed.push(outcome); families.set(family, bucket);
    }
  }
  const byFamily: Record<string, FamilyCalibrationCurve> = {};
  if (predictionEngineConfig.calibration.enablePerFamilyCalibration) for (const [family, bucket] of families) {
    if (bucket.predicted.length < predictionEngineConfig.calibration.perFamilyMinSamples) continue;
    const points = engine.fitIsotonicCalibration(bucket.predicted, bucket.observed).calibrationPoints;
    if (points.length >= 3) byFamily[family] = { points, nObservations: bucket.predicted.length };
  }
  return { protocol: 'existing-isotonic-v1', calibrationPoints: engine.fitIsotonicCalibration(predicted, observed).calibrationPoints,
    nObservations: predicted.length, byFamily, learnedBlendWeights: {}, matches: seen.size,
    fittedThrough: through === null ? null : new Date(through).toISOString() };
}

/** Preserve the existing A raw probabilities separately from calibrated decision probabilities. */
export function applyResearchProbabilityPipeline(
  raw: Record<string, number>, profile: ResearchCalibrationProfile, quotes: MarketQuote[],
  forecastAt: string, context: ValueAnalysisContext = {},
): { raw: Record<string, number>; calibrated: Record<string, number>; decision: Record<string, number> } {
  const cutoff = Date.parse(forecastAt);
  if (!Number.isFinite(cutoff) || (profile.fittedThrough && Date.parse(profile.fittedThrough) > cutoff)) throw new Error('future_calibration_profile');
  const calibrated = applyCalibrationToFlatProbabilities(raw, profile.calibrationPoints, profile.nObservations, engine, profile.byFamily);
  const decision = { ...calibrated };
  // No-vig companions must belong to the same actual operator and snapshot.
  const books = new Map<string, MarketQuote[]>();
  for (const quote of quotes) {
    if (settleGoalQuote(quote, 0, 0).status === 'UNRESOLVED'
      || Date.parse(quote.capturedAt) > cutoff || Date.parse(quote.updatedAt) > cutoff) continue;
    const key = `${quote.bookmaker}:${quote.source}:${quote.capturedAt}`;
    const rows = books.get(key) ?? []; rows.push(quote); books.set(key, rows);
  }
  for (const rows of books.values()) {
    const odds = Object.fromEntries(rows.map((quote) => [quote.selection, quote.odds]));
    const groups = engine.buildMarketGroups(odds);
    for (const quote of rows) {
      const p = calibrated[quote.selection];
      if (!Number.isFinite(p)) continue;
      decision[quote.selection] = engine.blendForecastProbability(quote.selection, p, groups[quote.selection],
        { ...context, enableMarketBlending: true, learnedBlendWeights: profile.learnedBlendWeights });
    }
  }
  return { raw: { ...raw }, calibrated, decision };
}
