export const DEFAULT_MATCH_TIME_ZONE = 'Europe/Rome';

type DateInput = string | number | Date | null | undefined;

const HAS_EXPLICIT_TIME_ZONE = /(?:z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

export function parseMatchDateValue(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // Understat often returns UTC timestamps without a trailing timezone.
  // Treat those naive match datetimes as UTC once, then display in Europe/Rome.
  const normalized =
    NAIVE_ISO_DATE_TIME.test(raw) && !HAS_EXPLICIT_TIME_ZONE.test(raw)
      ? `${raw.replace(' ', 'T')}Z`
      : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatMatchTime(value: DateInput, timeZone = DEFAULT_MATCH_TIME_ZONE): string {
  const date = parseMatchDateValue(value);
  if (!date) return '--';
  return new Intl.DateTimeFormat('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(date);
}

export function formatMatchDate(value: DateInput, timeZone = DEFAULT_MATCH_TIME_ZONE): string {
  const date = parseMatchDateValue(value);
  if (!date) return 'Data da definire';
  return new Intl.DateTimeFormat('it-IT', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    timeZone,
  }).format(date);
}

export function formatMatchDateTime(value: DateInput, timeZone = DEFAULT_MATCH_TIME_ZONE): string {
  const date = parseMatchDateValue(value);
  if (!date) return 'Data da definire';
  return `${formatMatchDate(date, timeZone)}, ${formatMatchTime(date, timeZone)}`;
}

export function getMatchDayKey(value: DateInput, timeZone = DEFAULT_MATCH_TIME_ZONE): string {
  const date = parseMatchDateValue(value);
  if (!date) return 'unknown';
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
