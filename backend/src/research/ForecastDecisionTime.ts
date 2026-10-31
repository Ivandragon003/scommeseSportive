export type NightlyDecisionSchedule = { hour?: number; minute?: number };
export const NIGHTLY_DECISION_TIME_PROTOCOL = 'nightly-europe-rome-v1';
const rome = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Explicit offsets are mandatory: a date-only or local clock is not a known kickoff. */
export function forecastTimestamp(value: unknown): number {
  return typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
}

/** Last real scheduled boundary before kickoff, including Rome's skipped/repeated DST hour. */
export function resolveNightlyForecastAt(kickoffAt: string, schedule: NightlyDecisionSchedule = {}): string {
  const kickoff = forecastTimestamp(kickoffAt), hour = schedule.hour ?? 3, minute = schedule.minute ?? 7;
  if (!Number.isFinite(kickoff) || !Number.isInteger(hour) || hour < 0 || hour > 23
    || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('invalid_nightly_decision_schedule');
  const start = Math.ceil(kickoff / 60000) * 60000 - 60000;
  for (let at = start; at >= start - 49 * 3600000; at -= 60000) {
    const parts = Object.fromEntries(rome.formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]));
    if (parts.hour === hour && parts.minute === minute) return new Date(at).toISOString();
  }
  throw new Error('nightly_decision_boundary_unavailable');
}

/** Nominal scheduled times are reproducible proxies, never evidence that a historical run really executed then. */
export function nightlyDecisionTimeReason(input: { kickoffAt: string; forecastAt: string },
  schedule: NightlyDecisionSchedule = {}, recordedAt?: string): string | null {
  const kickoff = forecastTimestamp(input.kickoffAt), forecast = forecastTimestamp(input.forecastAt);
  if (!Number.isFinite(kickoff) || !Number.isFinite(forecast) || forecast >= kickoff) return 'invalid_forecast_chronology';
  let expected: string;
  try { expected = resolveNightlyForecastAt(input.kickoffAt, schedule); } catch { return 'invalid_nightly_decision_schedule'; }
  if (recordedAt !== undefined) {
    const recorded = forecastTimestamp(recordedAt);
    return !Number.isFinite(recorded) || forecast !== recorded || recorded < forecastTimestamp(expected)
      ? 'recorded_nightly_time_mismatch' : null;
  }
  return forecast !== forecastTimestamp(expected) ? 'nightly_forecast_time_mismatch' : null;
}
