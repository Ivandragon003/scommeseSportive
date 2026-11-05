"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.goalCalibrationObservation = goalCalibrationObservation;
exports.fitResearchCalibration = fitResearchCalibration;
exports.applyResearchProbabilityPipeline = applyResearchProbabilityPipeline;
const ValueBettingEngine_1 = require("../models/value/ValueBettingEngine");
const EnhancedMarketAnalysis_1 = require("../models/value/EnhancedMarketAnalysis");
const PredictionEngineConfig_1 = require("../config/PredictionEngineConfig");
const GoalSettlement_1 = require("./GoalSettlement");
const engine = new ValueBettingEngine_1.ValueBettingEngine();
/** Known binary labels only. Pushes remain null rather than invented losses. */
function goalCalibrationObservation(matchId, availableAt, probabilities, homeGoals, awayGoals) {
    if (!Number.isSafeInteger(homeGoals) || !Number.isSafeInteger(awayGoals) || homeGoals < 0 || awayGoals < 0)
        throw new Error('invalid_goal_outcome');
    const home = homeGoals > awayGoals, away = awayGoals > homeGoals, draw = homeGoals === awayGoals;
    const outcomes = {
        homeWin: Number(home), draw: Number(draw), awayWin: Number(away),
        btts: Number(homeGoals > 0 && awayGoals > 0), bttsNo: Number(homeGoals === 0 || awayGoals === 0),
        double_chance_1x: Number(!away), double_chance_x2: Number(!home),
        double_chance_12: Number(!draw),
        dnb_home: draw ? null : Number(home), dnb_away: draw ? null : Number(away),
    };
    for (const key of Object.keys(probabilities)) {
        const total = /^(over|under)(05|15|25|35|45)$/.exec(key);
        const team = /^team_(home|away)_(over|under)_(\d+(?:\.\d+)?)$/.exec(key);
        const actual = team ? team[1] === 'home' ? homeGoals : awayGoals : homeGoals + awayGoals;
        const line = total ? Number(total[2]) / 10 : team ? Number(team[3]) : NaN;
        const side = total?.[1] ?? team?.[2];
        if (Number.isFinite(line) && line * 2 % 2 === 1)
            outcomes[key] = Number(side === 'over' ? actual > line : actual < line);
    }
    return { matchId, availableAt, probabilities, outcomes };
}
/** The same isotonic implementation and family thresholds used by PredictionService. */
function fitResearchCalibration(observations, asOf) {
    const cutoff = Date.parse(asOf);
    if (!Number.isFinite(cutoff))
        throw new Error('invalid_calibration_cutoff');
    const predicted = [], observed = [];
    const families = new Map();
    const seen = new Set();
    let through = null;
    const ordered = [...observations].sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt)
        || a.matchId.localeCompare(b.matchId));
    for (const row of ordered) {
        const available = Date.parse(row.availableAt);
        if (!Number.isFinite(available) || available > cutoff || seen.has(row.matchId))
            continue;
        seen.add(row.matchId);
        through = Math.max(through ?? available, available);
        for (const [key, probability] of Object.entries(row.probabilities)) {
            const outcome = row.outcomes[key];
            if (!Number.isFinite(probability) || probability <= 0 || probability >= 1 || (outcome !== 0 && outcome !== 1))
                continue;
            predicted.push(probability);
            observed.push(outcome);
            const family = engine.categorizeSelection(key), bucket = families.get(family) ?? { predicted: [], observed: [] };
            bucket.predicted.push(probability);
            bucket.observed.push(outcome);
            families.set(family, bucket);
        }
    }
    const byFamily = {};
    if (PredictionEngineConfig_1.predictionEngineConfig.calibration.enablePerFamilyCalibration)
        for (const [family, bucket] of families) {
            if (bucket.predicted.length < PredictionEngineConfig_1.predictionEngineConfig.calibration.perFamilyMinSamples)
                continue;
            const points = engine.fitIsotonicCalibration(bucket.predicted, bucket.observed).calibrationPoints;
            if (points.length >= 3)
                byFamily[family] = { points, nObservations: bucket.predicted.length };
        }
    return { protocol: 'existing-isotonic-v1', calibrationPoints: engine.fitIsotonicCalibration(predicted, observed).calibrationPoints,
        nObservations: predicted.length, byFamily, learnedBlendWeights: {}, matches: seen.size,
        fittedThrough: through === null ? null : new Date(through).toISOString() };
}
/** Preserve the existing A raw probabilities separately from calibrated decision probabilities. */
function applyResearchProbabilityPipeline(raw, profile, quotes, forecastAt, context = {}) {
    const cutoff = Date.parse(forecastAt);
    if (!Number.isFinite(cutoff) || (profile.fittedThrough && Date.parse(profile.fittedThrough) > cutoff))
        throw new Error('future_calibration_profile');
    const calibrated = (0, EnhancedMarketAnalysis_1.applyCalibrationToFlatProbabilities)(raw, profile.calibrationPoints, profile.nObservations, engine, profile.byFamily);
    const decision = { ...calibrated };
    // No-vig companions must belong to the same actual operator and snapshot.
    const books = new Map();
    for (const quote of quotes) {
        if ((0, GoalSettlement_1.settleGoalQuote)(quote, 0, 0).status === 'UNRESOLVED'
            || Date.parse(quote.capturedAt) > cutoff || Date.parse(quote.updatedAt) > cutoff)
            continue;
        const key = `${quote.bookmaker}:${quote.source}:${quote.capturedAt}`;
        const rows = books.get(key) ?? [];
        rows.push(quote);
        books.set(key, rows);
    }
    for (const rows of books.values()) {
        const odds = Object.fromEntries(rows.map((quote) => [quote.selection, quote.odds]));
        const groups = engine.buildMarketGroups(odds);
        for (const quote of rows) {
            const p = calibrated[quote.selection];
            if (!Number.isFinite(p))
                continue;
            decision[quote.selection] = engine.blendForecastProbability(quote.selection, p, groups[quote.selection], { ...context, enableMarketBlending: true, learnedBlendWeights: profile.learnedBlendWeights });
        }
    }
    return { raw: { ...raw }, calibrated, decision };
}
