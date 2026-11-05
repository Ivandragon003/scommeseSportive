"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyCalibrationToFlatProbabilities = applyCalibrationToFlatProbabilities;
exports.applyIntraMatchCorrelationCap = applyIntraMatchCorrelationCap;
exports.computeEvMultiplierFromRichness = computeEvMultiplierFromRichness;
exports.buildRichnessAwareAdaptivePatch = buildRichnessAwareAdaptivePatch;
exports.applyRichnessToSelectionFamilies = applyRichnessToSelectionFamilies;
exports.separateByMarketTier = separateByMarketTier;
exports.analyzeMarketsEnhanced = analyzeMarketsEnhanced;
exports.evaluateComboBet = evaluateComboBet;
function applyCalibrationToFlatProbabilities(flatProbabilities, calibrationPoints, nObservations, engine, calibrationByFamily) {
    const calibrated = {};
    for (const [key, rawProb] of Object.entries(flatProbabilities ?? {})) {
        if (!Number.isFinite(rawProb) || rawProb <= 0 || rawProb >= 1) {
            calibrated[key] = rawProb;
            continue;
        }
        // Curva specifica della famiglia di mercato se disponibile e affidabile,
        // altrimenti fallback alla curva globale.
        const familyCurve = calibrationByFamily?.[engine.categorizeSelection(key)];
        if (familyCurve && familyCurve.points.length >= 2) {
            calibrated[key] = engine.calibrate(rawProb, familyCurve.points, familyCurve.nObservations);
        }
        else {
            calibrated[key] = engine.calibrate(rawProb, calibrationPoints, nObservations);
        }
    }
    return calibrated;
}
function applyIntraMatchCorrelationCap(opportunities, maxSingleMatchExposure = 5.0) {
    const byMatch = new Map();
    const noMatch = [];
    for (const opp of opportunities ?? []) {
        if (!opp.matchId) {
            noMatch.push(opp);
            continue;
        }
        const group = byMatch.get(opp.matchId) ?? [];
        group.push(opp);
        byMatch.set(opp.matchId, group);
    }
    const result = [...noMatch];
    for (const [, group] of byMatch) {
        if (group.length === 1) {
            result.push(group[0]);
            continue;
        }
        const totalStake = group.reduce((sum, item) => sum + Number(item.suggestedStakePercent ?? 0), 0);
        if (!Number.isFinite(totalStake) || totalStake <= 0 || totalStake <= maxSingleMatchExposure) {
            result.push(...group);
            continue;
        }
        const scaleFactor = maxSingleMatchExposure / totalStake;
        result.push(...group.map((opp) => ({
            ...opp,
            suggestedStakePercent: Number(Math.max(0.25, Number(opp.suggestedStakePercent ?? 0) * scaleFactor).toFixed(2)),
        })));
    }
    return result.sort((a, b) => Number(b.rankingScore ?? Number(b.expectedValue ?? 0) * Number(b.adaptiveRankMultiplier ?? 1)) -
        Number(a.rankingScore ?? Number(a.expectedValue ?? 0) * Number(a.adaptiveRankMultiplier ?? 1)));
}
function computeEvMultiplierFromRichness(richnessScore, sensitivity = 1.2) {
    const r = Math.max(0.30, Math.min(0.93, Number(richnessScore ?? 0.30)));
    return Number((1 + (1 - r) * sensitivity).toFixed(3));
}
function buildRichnessAwareAdaptivePatch(richnessScore, baseEvThresholds) {
    const multiplier = computeEvMultiplierFromRichness(richnessScore);
    const delta = multiplier - 1;
    const categories = {};
    for (const [cat, baseEv] of Object.entries(baseEvThresholds)) {
        const evDelta = Number(Math.min(0.06, Number(baseEv) * delta).toFixed(4));
        categories[cat] = {
            evDelta,
            coherenceDelta: 0,
            rankingMultiplier: 1,
            sampleSize: 0,
            rankingErrorRate: 0,
            filterRejectionRate: 0,
            confirmationRate: 0,
            wrongPickRate: 0,
        };
    }
    return categories;
}
function applyRichnessToSelectionFamilies(existingFamilies, richnessScore) {
    const multiplier = computeEvMultiplierFromRichness(richnessScore);
    const delta = multiplier - 1;
    const adjusted = {};
    for (const [family, tuning] of Object.entries(existingFamilies ?? {})) {
        const baseEvDelta = Number(tuning?.evDelta ?? 0);
        const richnessPenalty = baseEvDelta > 0
            ? Number(Math.min(0.06, baseEvDelta * delta).toFixed(4))
            : 0;
        adjusted[family] = {
            ...tuning,
            evDelta: Number((baseEvDelta + richnessPenalty).toFixed(4)),
        };
    }
    return adjusted;
}
function separateByMarketTier(opportunities) {
    const coreBets = [];
    const secondaryBets = [];
    const speculativeBets = [];
    for (const opp of opportunities ?? []) {
        if (opp.marketTier === 'CORE')
            coreBets.push(opp);
        else if (opp.marketTier === 'SECONDARY')
            secondaryBets.push(opp);
        else
            speculativeBets.push(opp);
    }
    return { coreBets, secondaryBets, speculativeBets };
}
function analyzeMarketsEnhanced(params) {
    const { flatProbabilities, marketGroups, marketNames, matchId, richnessScore, calibrationPoints, nCalibrationObs, calibrationByFamily, engine, maxComboLegs = 3, minCombinedEV = 0.08, analysisContext, } = params;
    const calibratedProbs = applyCalibrationToFlatProbabilities(flatProbabilities, calibrationPoints, nCalibrationObs, engine, calibrationByFamily);
    const baseThresholds = {
        goal_1x2: 0.030,
        btts_yes: 0.034,
        btts_no: 0.055,
        goal_over: 0.028,
        goal_under: 0.045,
        goal_ou: 0.025,
        shots: 0.005,
        shots_ot: 0.005,
        corners: 0.008,
        yellow_cards: 0.008,
        fouls: 0.008,
        exact_score: 0.050,
        handicap: 0.050,
    };
    const richnessPatch = buildRichnessAwareAdaptivePatch(richnessScore, baseThresholds);
    const existingProfile = engine.getAdaptiveTuning();
    const selectionFamilyPatch = applyRichnessToSelectionFamilies(existingProfile?.selectionFamilies, richnessScore);
    const mergedProfile = {
        source: existingProfile?.source ?? 'richness_patch',
        generatedAt: new Date().toISOString(),
        totalReviews: existingProfile?.totalReviews ?? 0,
        categories: {
            ...existingProfile?.categories,
            ...Object.fromEntries(Object.entries(richnessPatch).map(([cat, patch]) => {
                const existing = existingProfile?.categories?.[cat];
                return [
                    cat,
                    {
                        evDelta: Number(existing?.evDelta ?? 0) + Number(patch?.evDelta ?? 0),
                        coherenceDelta: Number(existing?.coherenceDelta ?? 0),
                        rankingMultiplier: Number(existing?.rankingMultiplier ?? 1),
                        sampleSize: Number(existing?.sampleSize ?? 0),
                        rankingErrorRate: Number(existing?.rankingErrorRate ?? 0),
                        filterRejectionRate: Number(existing?.filterRejectionRate ?? 0),
                        confirmationRate: Number(existing?.confirmationRate ?? 0),
                        wrongPickRate: Number(existing?.wrongPickRate ?? 0),
                    },
                ];
            })),
        },
        selectionFamilies: selectionFamilyPatch,
    };
    let allOpportunities = [];
    engine.setAdaptiveTuning(mergedProfile);
    try {
        allOpportunities = engine
            .analyzeMarketsWithVigRemoval(calibratedProbs, marketGroups, marketNames, {
            ...analysisContext,
            richnessScore,
        })
            .map((opp) => ({ ...opp, matchId: opp.matchId ?? matchId }));
    }
    finally {
        engine.setAdaptiveTuning(existingProfile);
    }
    const { coreBets, secondaryBets, speculativeBets } = separateByMarketTier(allOpportunities);
    const cappedCore = applyIntraMatchCorrelationCap(coreBets, 5.0);
    const cappedSecondary = applyIntraMatchCorrelationCap(secondaryBets, 4.0);
    const comboCandidates = engine
        .selectMediumAndAbove(cappedCore)
        .filter((opp) => Boolean(opp.matchId));
    const comboBets = engine
        .buildCombinations(comboCandidates, maxComboLegs, minCombinedEV)
        .filter((combo) => combo.isIndependent);
    return {
        coreBets: cappedCore,
        secondaryBets: cappedSecondary,
        speculativeBets,
        comboBets,
        allBets: [...cappedCore, ...cappedSecondary],
    };
}
function evaluateComboBet(combo, matchResults, evaluateSingleBet) {
    const legsResults = [];
    let allEvaluable = true;
    for (const leg of combo.legs ?? []) {
        const matchId = String(leg.matchId ?? '').trim();
        const matchData = matchId ? matchResults[matchId] : null;
        const legResult = matchData ? evaluateSingleBet(leg.selection, matchData) : null;
        legsResults.push({ selection: leg.selection, won: legResult });
        if (legResult === null)
            allEvaluable = false;
    }
    const won = allEvaluable && legsResults.every((r) => r.won === true);
    return { won, allLegsEvaluable: allEvaluable, legsResults };
}
