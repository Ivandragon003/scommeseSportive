/** SQL/Understat timestamps without an offset are UTC, independent of host TZ. */
export function historicalTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const text = String(value ?? '').trim();
  const parts = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (!parts) return NaN;
  const year = Number(parts[1]), month = Number(parts[2]), date = Number(parts[3]);
  const day = new Date(Date.UTC(year, month - 1, date));
  if (day.getUTCFullYear() !== year || day.getUTCMonth() + 1 !== month || day.getUTCDate() !== date ||
    Number(parts[4] ?? 0) > 23 || Number(parts[5] ?? 0) > 59 || Number(parts[6] ?? 0) > 59) return NaN;
  if (!parts[4]) return day.getTime();
  const iso = text.replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
}
