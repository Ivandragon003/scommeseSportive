/** Historic flattened totals cannot distinguish genuine shots from high goal lines. */
export const CURRENT_ODDS_MAPPING = 'provider-market-semantics-v2';
export const LEGACY_ODDS_MAPPING = 'legacy-unverified-v1';

export function quarantineLegacyShotTotals(value: unknown, version: unknown): {
  value: unknown; selections: string[];
} {
  if (version === CURRENT_ODDS_MAPPING || !value || typeof value !== 'object' || Array.isArray(value)) {
    return { value, selections: [] };
  }
  const selections: string[] = [];
  const clean = (entry: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(entry)) {
      const match = /^shots_total_(?:over|under)_(\d+(?:\.\d+)?)$/i.exec(key);
      if (match && Number(match[1]) >= 8) {
        selections.push(prefix ? `${prefix}/${key}` : key);
      } else if (item && typeof item === 'object' && !Array.isArray(item)) {
        result[key] = clean(item as Record<string, unknown>, prefix ? `${prefix}/${key}` : key);
      } else {
        result[key] = item;
      }
    }
    return result;
  };
  return { value: clean(value as Record<string, unknown>, ''), selections };
}
