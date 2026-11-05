"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.learnBlendWeights = learnBlendWeights;
exports.noVigProbability = noVigProbability;
const PredictionEngineConfig_1 = require("../config/PredictionEngineConfig");
const MathUtils_1 = require("../models/utils/MathUtils");
const EPS = 1e-9;
function meanLogLoss(samples, modelWeight) {
    let total = 0;
    for (const sample of samples) {
        const blended = (0, MathUtils_1.clamp)(modelWeight * sample.modelProb + (1 - modelWeight) * sample.marketProbNoVig, EPS, 1 - EPS);
        total += sample.outcome === 1 ? -Math.log(blended) : -Math.log(1 - blended);
    }
    return total / samples.length;
}
function learnBlendWeights(samples, options = {}) {
    const minSamples = Math.max(10, options.minSamples ?? PredictionEngineConfig_1.predictionEngineConfig.marketBlending.learnedBlendMinSamples);
    const weightMin = (0, MathUtils_1.clamp)(options.weightMin ?? 0.40, 0, 1);
    const weightMax = (0, MathUtils_1.clamp)(options.weightMax ?? 0.84, weightMin, 1);
    const weightStep = Math.max(0.005, options.weightStep ?? 0.02);
    const byCategory = new Map();
    for (const sample of samples ?? []) {
        const category = String(sample?.category ?? '').trim();
        const modelProb = Number(sample?.modelProb);
        const marketProb = Number(sample?.marketProbNoVig);
        const outcome = sample?.outcome;
        if (!category)
            continue;
        if (!Number.isFinite(modelProb) || modelProb <= 0 || modelProb >= 1)
            continue;
        if (!Number.isFinite(marketProb) || marketProb <= 0 || marketProb >= 1)
            continue;
        if (outcome !== 0 && outcome !== 1)
            continue;
        const bucket = byCategory.get(category) ?? [];
        bucket.push({ category, modelProb, marketProbNoVig: marketProb, outcome });
        byCategory.set(category, bucket);
    }
    const learned = {};
    for (const [category, bucket] of byCategory.entries()) {
        if (bucket.length < minSamples)
            continue;
        let bestWeight = weightMax;
        let bestLoss = Infinity;
        for (let w = weightMin; w <= weightMax + 1e-9; w += weightStep) {
            const loss = meanLogLoss(bucket, w);
            if (loss < bestLoss - 1e-12) {
                bestLoss = loss;
                bestWeight = w;
            }
        }
        learned[category] = {
            modelWeight: Number(bestWeight.toFixed(3)),
            sampleSize: bucket.length,
            logLossModelOnly: Number(meanLogLoss(bucket, 1).toFixed(6)),
            logLossLearned: Number(bestLoss.toFixed(6)),
        };
    }
    return learned;
}
/**
 * Probabilità no-vig di una selezione a partire dalle quote della selezione
 * e delle companion dello stesso mercato (2-way o 3-way).
 * Restituisce null se non ci sono abbastanza quote per rimuovere il vig.
 */
function noVigProbability(odds, companionOdds) {
    if (!Number.isFinite(odds) || odds <= 1)
        return null;
    const validCompanions = (companionOdds ?? []).filter((o) => Number.isFinite(o) && o > 1);
    if (validCompanions.length === 0)
        return null;
    const impliedSelf = 1 / odds;
    const impliedTotal = impliedSelf + validCompanions.reduce((sum, o) => sum + 1 / o, 0);
    if (impliedTotal <= 0)
        return null;
    const noVig = impliedSelf / impliedTotal;
    return noVig > 0 && noVig < 1 ? noVig : null;
}
