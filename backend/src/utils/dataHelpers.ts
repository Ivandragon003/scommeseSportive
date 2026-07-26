// Small shared data-coercion helpers used by the API layer and derived-stats
// services. Extracted verbatim from api/routes.ts to remove duplication and keep
// the service layer independent of the route module.

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseRawJson(value: unknown): any | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function normalizeShotResult(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

export function safePct(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
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
export function bookingPoints(yellows: number, reds: number): number {
  const y = Number(yellows);
  const r = Number(reds);
  return (Number.isFinite(y) ? y : 0) + 2 * (Number.isFinite(r) ? r : 0);
}
