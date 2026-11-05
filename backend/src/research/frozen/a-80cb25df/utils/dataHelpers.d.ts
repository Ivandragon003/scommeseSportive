export declare function numOrNull(value: unknown): number | null;
export declare function parseRawJson(value: unknown): any | null;
export declare function normalizeShotResult(value: unknown): string;
export declare function safePct(numerator: number, denominator: number): number;
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
export declare function bookingPoints(yellows: number, reds: number): number;
