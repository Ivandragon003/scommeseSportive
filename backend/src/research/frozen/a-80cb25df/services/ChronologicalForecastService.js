"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HISTORICAL_RESULT_DELAY_MS = void 0;
exports.buildChronologicalForecasts = buildChronologicalForecasts;
exports.buildChronologicalForecastsAsync = buildChronologicalForecastsAsync;
// Outcomes are not assumed to be known at kickoff, even for date-only sources.
exports.HISTORICAL_RESULT_DELAY_MS = 2 * 60 * 60 * 1000;
/** Builds OOS predictions entirely in memory from a single historical export. */
function* chronologicalForecasts(matches, options) {
    const cutoff = options.asOf.getTime();
    if (!Number.isFinite(cutoff))
        throw new Error('Invalid historical forecast cutoff');
    const completed = matches.filter((match) => Number.isFinite(match.date.getTime()) &&
        match.date.getTime() + exports.HISTORICAL_RESULT_DELAY_MS <= cutoff &&
        match.homeGoals !== undefined && match.homeGoals !== null &&
        match.awayGoals !== undefined && match.awayGoals !== null &&
        Number.isFinite(match.homeGoals) && Number.isFinite(match.awayGoals) &&
        match.homeGoals >= 0 && match.awayGoals >= 0).sort((a, b) => a.date.getTime() - b.date.getTime() || a.matchId.localeCompare(b.matchId));
    const targets = completed.slice(-Math.max(1, options.maxForecastMatches ?? 450));
    const minTraining = Math.max(1, options.minTrainingMatches ?? 30);
    const interval = Math.max(0, options.refitIntervalMs ?? 7 * 24 * 60 * 60 * 1000);
    const predictors = new Map();
    for (const match of targets) {
        const timestamp = match.date.getTime();
        const competition = match.competition ?? '';
        const past = completed.filter((row) => (row.competition ?? '') === competition && row.matchId !== match.matchId &&
            row.date.getTime() + exports.HISTORICAL_RESULT_DELAY_MS <= timestamp);
        if (past.length < minTraining)
            continue;
        let predictor = predictors.get(competition);
        if (!predictor || timestamp - predictor.fittedAt >= interval) {
            predictor = { predict: options.createPredictor(past, new Date(timestamp)), fittedAt: timestamp };
            predictors.set(competition, predictor);
        }
        // Explicit prematch whitelist: target outcomes/xG/counts cannot reach a predictor.
        const target = {
            matchId: match.matchId, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
            date: new Date(timestamp), competition: match.competition, season: match.season,
            referee: match.referee,
        };
        yield { match, probabilities: predictor.predict(target, past),
            availableAt: timestamp + exports.HISTORICAL_RESULT_DELAY_MS };
    }
}
function buildChronologicalForecasts(matches, options) {
    return [...chronologicalForecasts(matches, options)];
}
/** Keep HTTP/health requests responsive between historical fits/forecast batches. */
async function buildChronologicalForecastsAsync(matches, options) {
    const forecasts = [];
    for (const forecast of chronologicalForecasts(matches, options)) {
        forecasts.push(forecast);
        if (forecasts.length % 8 === 0)
            await new Promise((resolve) => setImmediate(resolve));
    }
    return forecasts;
}
