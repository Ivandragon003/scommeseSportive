"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COHERENT_CALIBRATION_TARGET = exports.COHERENT_PROBABILITY_PROTOCOL = void 0;
exports.fitCoherentCalibration = fitCoherentCalibration;
exports.applyCoherentProbabilityPipeline = applyCoherentProbabilityPipeline;
exports.coherentProbabilityPipelineHash = coherentProbabilityPipelineHash;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const ValueBettingEngine_1 = require("../models/value/ValueBettingEngine");
const EnhancedMarketAnalysis_1 = require("../models/value/EnhancedMarketAnalysis");
const PredictionEngineConfig_1 = require("../config/PredictionEngineConfig");
const GoalSettlement_1 = require("./GoalSettlement");
const ResearchProbabilityPipeline_1 = require("./ResearchProbabilityPipeline");
exports.COHERENT_PROBABILITY_PROTOCOL = 'joint-goal-coherent-v2';
exports.COHERENT_CALIBRATION_TARGET = 'joint_1x2_normalized-v2';
const RESULT_KEYS = ['homeWin', 'draw', 'awayWin'];
const engine = new ValueBettingEngine_1.ValueBettingEngine();
const time = (value) => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
    ? Date.parse(value) : Number.NaN;
const probability = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const resultKey = (home, away) => home > away ? 'homeWin' : home === away ? 'draw' : 'awayWin';
function normalizedResult(values) {
    if (!RESULT_KEYS.every((key) => probability(values[key])))
        throw new Error('invalid_coherent_result_probabilities');
    const total = RESULT_KEYS.reduce((sum, key) => sum + values[key], 0);
    if (!(total > 0))
        throw new Error('empty_coherent_result_partition');
    return Object.fromEntries(RESULT_KEYS.map((key) => [key, values[key] / total]));
}
/** Reweight only existing cells, preserving each result's conditional score distribution. */
function projectResultPartition(matrix, target) {
    const current = (0, GoalSettlement_1.scoreMatrixMarkets)(matrix);
    for (const key of RESULT_KEYS)
        if (current[key] === 0 && target[key] > 0) {
            throw new Error('coherent_partition_support_missing');
        }
    return (0, GoalSettlement_1.normalizeScoreMatrix)(matrix.map((row, home) => row.map((mass, away) => {
        const key = resultKey(home, away);
        return current[key] > 0 ? mass * target[key] / current[key] : 0;
    })));
}
function validateProfile(profile, forecast) {
    if (!profile || profile.protocol !== 'existing-isotonic-v1' || !Number.isSafeInteger(profile.nObservations)
        || profile.nObservations < 0 || !Number.isSafeInteger(profile.matches) || profile.matches < 0)
        throw new Error('invalid_coherent_calibration_profile');
    if (profile.targetProtocol !== exports.COHERENT_CALIBRATION_TARGET) {
        throw new Error('coherent_calibration_target_mismatch');
    }
    if (profile.fittedThrough !== null && (!Number.isFinite(time(profile.fittedThrough)) || time(profile.fittedThrough) > forecast)) {
        throw new Error('future_coherent_calibration_profile');
    }
    if (profile.nObservations > 0 && profile.fittedThrough === null)
        throw new Error('missing_coherent_calibration_chronology');
    const validCurve = (curve) => Array.isArray(curve) && curve.length >= 2
        && curve.every((point, index) => point && probability(point.x) && probability(point.y)
            && (index === 0 || (point.x >= curve[index - 1].x && point.y >= curve[index - 1].y)));
    if (!validCurve(profile.calibrationPoints) || !profile.byFamily || typeof profile.byFamily !== 'object') {
        throw new Error('invalid_coherent_calibration_curve');
    }
    for (const curve of Object.values(profile.byFamily))
        if (!curve || !validCurve(curve.points)
            || !Number.isSafeInteger(curve.nObservations) || curve.nObservations < 0)
            throw new Error('invalid_coherent_family_curve');
}
/** Fit only a normalized, mutually exclusive 1X2 partition, never DC/DNB pseudo-labels. */
function fitCoherentCalibration(observations, asOf) {
    const cutoff = time(asOf);
    if (!Number.isFinite(cutoff))
        throw new Error('invalid_coherent_calibration_cutoff');
    const eligible = observations.filter((row) => Number.isFinite(time(row.availableAt)) && time(row.availableAt) <= cutoff)
        .map((row) => {
        const normalized = normalizedResult(row.probabilities);
        if (!RESULT_KEYS.every((key) => row.outcomes[key] === 0 || row.outcomes[key] === 1)
            || RESULT_KEYS.reduce((sum, key) => sum + Number(row.outcomes[key]), 0) !== 1)
            throw new Error('invalid_coherent_onehot_outcome');
        return { ...row, probabilities: normalized,
            outcomes: Object.fromEntries(RESULT_KEYS.map((key) => [key, row.outcomes[key]])) };
    });
    return { ...(0, ResearchProbabilityPipeline_1.fitResearchCalibration)(eligible, asOf), targetProtocol: exports.COHERENT_CALIBRATION_TARGET };
}
function temperatureMatrix(matrix, temperature) {
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature <= 0)
        throw new Error('invalid_coherent_temperature');
    const logs = matrix.map((row) => row.map((mass) => mass > 0 ? Math.log(mass) / temperature : -Infinity));
    const maximum = Math.max(...logs.flat());
    if (!Number.isFinite(maximum))
        throw new Error('unstable_coherent_temperature');
    return (0, GoalSettlement_1.normalizeScoreMatrix)(logs.map((row) => row.map((value) => value === -Infinity ? 0 : Math.exp(value - maximum))));
}
function quoteReason(quote, forecast) {
    if ((0, GoalSettlement_1.settleGoalQuote)(quote, 0, 0).status === 'UNRESOLVED'
        || /synthetic|model|estimated|unknown|aggregate|average|fallback/i.test(quote?.source ?? ''))
        return 'non_real_or_invalid_quote';
    const captured = time(quote.capturedAt), updated = time(quote.updatedAt);
    const priceType = quote.priceType;
    const observationOnly = quote.timestampEvidence === 'observed_snapshot';
    if (!Number.isFinite(captured))
        return 'quote_timezone_or_time_missing';
    if (observationOnly && (priceType !== 'prematch' || captured !== forecast))
        return 'observation_quote_requires_its_forecast_time';
    if (!Number.isFinite(updated) && !(observationOnly && quote.updatedAt === undefined))
        return 'quote_provider_update_required';
    if (captured > forecast || updated > forecast || updated > captured)
        return 'future_quote';
    if (priceType === 't15'
        && (forecast - captured > 300000 || forecast - updated > 300000))
        return 'stale_t15_quote';
    return null;
}
function chooseBookmaker(quotes, exclude) {
    const groups = new Map();
    for (const quote of quotes) {
        if (quote.market !== '1x2')
            continue;
        const key = quote.side === 'home' ? 'homeWin' : quote.side === 'away' ? 'awayWin' : 'draw';
        if (quote.selection !== key) {
            exclude('noncanonical_result_selection');
            continue;
        }
        const groupId = JSON.stringify([quote.bookmaker, quote.source, quote.capturedAt, quote.updatedAt]);
        const group = groups.get(groupId) ?? { quote, prices: {}, invalid: false };
        if (group.prices[key] !== undefined && group.prices[key] !== quote.odds)
            group.invalid = true;
        group.prices[key] = quote.odds;
        groups.set(groupId, group);
    }
    const complete = [...groups.values()].filter((group) => {
        if (group.invalid) {
            exclude('conflicting_result_sheet');
            return false;
        }
        if (!RESULT_KEYS.every((key) => group.prices[key] !== undefined)) {
            exclude('incomplete_result_sheet');
            return false;
        }
        return true;
    });
    const priority = (bookmaker) => /eurobet/i.test(bookmaker) ? 0 : /(?:_it$|ital)/i.test(bookmaker) ? 1 : 2;
    complete.sort((a, b) => priority(a.quote.bookmaker) - priority(b.quote.bookmaker)
        || time(b.quote.capturedAt) - time(a.quote.capturedAt)
        || a.quote.bookmaker.localeCompare(b.quote.bookmaker) || a.quote.source.localeCompare(b.quote.source)
        || JSON.stringify(a.prices).localeCompare(JSON.stringify(b.prices)));
    if (!complete.length)
        return null;
    const chosen = complete[0], odds = chosen.prices;
    const margin = RESULT_KEYS.reduce((sum, key) => sum + 1 / odds[key], 0);
    return { bookmaker: chosen.quote.bookmaker, source: chosen.quote.source,
        capturedAt: chosen.quote.capturedAt, updatedAt: chosen.quote.updatedAt ?? null,
        timestampEvidence: chosen.quote.timestampEvidence ?? 'provider_update', odds,
        probabilities: Object.fromEntries(RESULT_KEYS.map((key) => [key, (1 / odds[key]) / margin])) };
}
function jointMarkets(matrix, quotes) {
    const result = (0, GoalSettlement_1.scoreMatrixMarkets)(matrix);
    for (const quote of quotes) {
        const derived = (0, GoalSettlement_1.evaluateGoalQuote)(matrix, quote).probability;
        // A malformed alias must never overwrite a canonical goal marginal.
        if (!(quote.selection in result))
            result[quote.selection] = derived;
    }
    return result;
}
/** Every decision marginal is derived from the returned joint distribution. */
function applyCoherentProbabilityPipeline(input) {
    const forecast = time(input.forecastAt);
    if (!Number.isFinite(forecast))
        throw new Error('invalid_coherent_forecast_time');
    const normalized = (0, GoalSettlement_1.normalizeScoreMatrix)(input.matrix);
    const raw = input.rawProbabilities ? { ...input.rawProbabilities } : (0, GoalSettlement_1.scoreMatrixMarkets)(normalized);
    if (!Object.values(raw).every(probability))
        throw new Error('invalid_coherent_raw_probability');
    const mode = input.mode ?? (input.profile ? 'isotonic_1x2' : 'identity');
    if (!['identity', 'isotonic_1x2', 'temperature'].includes(mode))
        throw new Error('invalid_coherent_calibration_mode');
    // Profiles also supply learned blend weights, even when calibration itself is disabled.
    if (input.profile || mode === 'isotonic_1x2')
        validateProfile(input.profile, forecast);
    let calibratedMatrix = normalized;
    if (mode === 'isotonic_1x2') {
        const partition = normalizedResult((0, GoalSettlement_1.scoreMatrixMarkets)(normalized));
        const corrected = (0, EnhancedMarketAnalysis_1.applyCalibrationToFlatProbabilities)(partition, input.profile.calibrationPoints, input.profile.nObservations, engine, input.profile.byFamily);
        calibratedMatrix = projectResultPartition(normalized, normalizedResult(corrected));
    }
    else if (mode === 'temperature')
        calibratedMatrix = temperatureMatrix(normalized, input.temperature);
    const quoteExclusions = {};
    const exclude = (reason) => { quoteExclusions[reason] = (quoteExclusions[reason] ?? 0) + 1; };
    const eligibleQuotes = (input.quotes ?? []).filter((quote) => {
        const reason = quoteReason(quote, forecast);
        if (reason)
            exclude(reason);
        return !reason;
    });
    const bookmaker = chooseBookmaker(eligibleQuotes, exclude);
    let matrix = calibratedMatrix;
    const marketBlendingApplied = bookmaker !== null && input.context?.enableMarketBlending !== false;
    if (marketBlendingApplied) {
        const partition = normalizedResult((0, GoalSettlement_1.scoreMatrixMarkets)(calibratedMatrix));
        const groups = engine.buildMarketGroups(bookmaker.odds);
        const blended = Object.fromEntries(RESULT_KEYS.map((key) => [key,
            engine.blendForecastProbability(key, partition[key], groups[key], { ...input.context,
                enableMarketCalibration: false, enableMarketBlending: true,
                learnedBlendWeights: input.context?.learnedBlendWeights ?? input.profile?.learnedBlendWeights })]));
        matrix = projectResultPartition(calibratedMatrix, normalizedResult(blended));
    }
    return { protocol: exports.COHERENT_PROBABILITY_PROTOCOL, mode, matrix,
        profileTarget: mode === 'isotonic_1x2' ? input.profile.targetProtocol : null,
        raw, calibrated: jointMarkets(calibratedMatrix, eligibleQuotes), decision: jointMarkets(matrix, eligibleQuotes),
        bookmaker, marketBlendingApplied, quoteExclusions };
}
/** Stable across line endings; a changed implementation cannot reuse an approved profile silently. */
function coherentProbabilityPipelineHash() {
    const modules = ['./CoherentProbabilityPipeline', './ResearchProbabilityPipeline', './GoalSettlement',
        '../models/value/ValueBettingEngine', '../models/value/EnhancedMarketAnalysis',
        '../models/utils/MathUtils', '../config/PredictionEngineConfig', '../config/predictionConfig'];
    const hash = (0, node_crypto_1.createHash)('sha256').update(exports.COHERENT_PROBABILITY_PROTOCOL);
    for (const module of modules)
        hash.update(module).update((0, node_fs_1.readFileSync)(require.resolve(module), 'utf8').replace(/\r\n/g, '\n'));
    hash.update(JSON.stringify({ calibration: PredictionEngineConfig_1.predictionEngineConfig.calibration, marketBlending: PredictionEngineConfig_1.predictionEngineConfig.marketBlending }));
    return hash.digest('hex');
}
