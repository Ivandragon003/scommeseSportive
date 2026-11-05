"use strict";
/**
 * ProbabilityEnsembleService — blending modello-modello a livello superiore.
 *
 * Combina le probabilità dei mercati GOAL di due modelli indipendenti
 * (Dixon-Coles e Poisson-xG) PRIMA della calibrazione per-famiglia, così la
 * calibrazione viene fittata e applicata sulle probabilità già blendate.
 *
 *   p = (1 - w_family) * p_DixonColes + w_family * p_PoissonXg
 *
 * Proprietà: essendo una combinazione convessa (w ∈ [0,1]), preserva TUTTI i
 * vincoli di coerenza che valgono già nei due modelli:
 *   - homeWin + draw + awayWin = 1
 *   - overX + underX = 1  per ogni linea
 *   - btts + bttsNo = 1
 * Doppia chance e DNB vengono derivate a valle dal 1X2 (già blendato), quindi
 * restano coerenti automaticamente.
 *
 * Solo i mercati goal vengono toccati; qualunque altra chiave (tiri, gialli,
 * falli, corner, handicap, exact score, player props) passa invariata.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.goalMarketFamilyOf = goalMarketFamilyOf;
exports.weightForFamily = weightForFamily;
exports.blendGoalProbabilities = blendGoalProbabilities;
/** Mappa una chiave flat a una famiglia goal blendabile, o null se non goal. */
function goalMarketFamilyOf(key) {
    if (key === 'homeWin' || key === 'draw' || key === 'awayWin')
        return 'oneXTwo';
    if (key === 'btts' || key === 'bttsNo')
        return 'btts';
    if (/^(over|under)(05|15|25|35|45)$/.test(key))
        return 'overUnder';
    return null;
}
/** Peso del blend per una famiglia (fallback su default), clampato in [0,1]. */
function weightForFamily(weights, family) {
    const raw = weights[family];
    const w = Number.isFinite(Number(raw)) ? Number(raw) : Number(weights.default);
    if (!Number.isFinite(w))
        return 0;
    return Math.min(1, Math.max(0, w));
}
/**
 * Restituisce una NUOVA mappa flat con le chiavi goal blendate col Poisson-xG.
 * Non muta l'input. Se `enabled` è false o `poissonGoalProbs` è null, ritorna
 * una copia invariata (retrocompatibile).
 */
function blendGoalProbabilities(dixonColesFlat, poissonGoalProbs, config) {
    const out = { ...dixonColesFlat };
    if (!config.enabled || !poissonGoalProbs)
        return out;
    for (const [key, dcValue] of Object.entries(dixonColesFlat)) {
        const family = goalMarketFamilyOf(key);
        if (!family)
            continue;
        const poissonValue = Number(poissonGoalProbs[key]);
        if (!Number.isFinite(poissonValue) || poissonValue < 0 || poissonValue > 1)
            continue;
        if (!Number.isFinite(Number(dcValue)))
            continue;
        const w = weightForFamily(config.weights, family);
        if (w <= 0)
            continue;
        out[key] = (1 - w) * Number(dcValue) + w * poissonValue;
    }
    return out;
}
