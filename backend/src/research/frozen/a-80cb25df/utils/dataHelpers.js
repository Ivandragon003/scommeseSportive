"use strict";
// Small shared data-coercion helpers used by the API layer and derived-stats
// services. Extracted verbatim from api/routes.ts to remove duplication and keep
// the service layer independent of the route module.
Object.defineProperty(exports, "__esModule", { value: true });
exports.numOrNull = numOrNull;
exports.parseRawJson = parseRawJson;
exports.normalizeShotResult = normalizeShotResult;
exports.safePct = safePct;
exports.bookingPoints = bookingPoints;
function numOrNull(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function parseRawJson(value) {
    if (typeof value !== 'string' || value.trim().length === 0)
        return null;
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
function normalizeShotResult(value) {
    return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}
function safePct(numerator, denominator) {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0)
        return 0;
    return numerator / denominator;
}
/**
 * Booking points (mercato "cartellini totali") come li regolano i bookmaker del
 * proprietario (Eurobet, Goldbet, 888): giallo = 1, rosso = 2.
 *
 * La formula resta yellows + 2*reds e NON va cambiata in "solo rossi diretti":
 * il dataset Understat (unica fonte dei cartellini, verificato: 100% delle
 * partite con rossi hanno source=understat e totali == somma roster) NON
 * distingue rosso diretto da doppia ammonizione, ma li codifica ENTRAMBI come
 * 0 gialli + 1 rosso. Quindi:
 *   - rosso diretto        (0y,1r) -> 2  ✓
 *   - doppia ammonizione   (0y,1r) -> 2  ✓ (i due gialli non sono contati)
 *   - giallo + rosso diretto (1y,1r) -> 3 ✓
 *   - solo giallo          (1y,0r) -> 1  ✓
 * yellows + 2*reds coincide col settlement bookmaker su tutti i casi. Vedi
 * analisi A6 (docs). Cambiare in yellows + 2*direct_reds introdurrebbe un errore
 * (sottoconterebbe le doppie ammonizioni, codificate come rossi "nudi").
 */
function bookingPoints(yellows, reds) {
    const y = Number(yellows);
    const r = Number(reds);
    return (Number.isFinite(y) ? y : 0) + 2 * (Number.isFinite(r) ? r : 0);
}
