import { randomUUID } from 'node:crypto';
import { auditSpool, countSpool, persistSpool, readSpool, removeSpool, SpoolRecord } from './ModelAProspectiveSpool';
import { reconcileModelAProspectiveResults } from './ModelAProspectiveResults';

type Sink = { appendModelAProspectiveForecast?: (record: SpoolRecord) => Promise<void>;
  getModelAProspectiveResultCandidates?: () => Promise<any[]>; appendModelAProspectiveResult?: (event: any) => Promise<boolean> };
type Input = { match: any; request: { matchId?: string; homeTeamId: string; awayTeamId: string; competition?: string; season?: string };
  asOf: string; origin: 'direct_a' | 'shared_ac' | 'internal'; model: { version: string; codeHash: string; configHash: string; stateHash: string };
  contextual: Record<string, number>; calibrated: Record<string, number> | null;
  decision: Record<string, number>; selected: any; exactCandidates?: Array<{ selection: string; probability: number; origin: 'vig' | 'board' }>; modelParametersHash: string;
  calibration: { profileHash: string; globalSamples: number; overSamples: number | null; underSamples: number | null;
    overCurve: string; underCurve: string };
  odds?: { source: string; capturedAt: string; odds: Record<string, number>; bookmakerBySelection: Record<string, string> } };

const maxQueue = 256;
const maxConcurrent = 4;
const maxAttempts = 3;
type Job = { sink: Sink; record: SpoolRecord; attempts: number; spoolDir?: string };
const queue: Job[] = [];
const tracked = new Set<string>();
let active = 0;
const stats = { accepted: 0, stored: 0, retries: 0, failed: 0, rejected: 0, ineligible: 0, captureErrors: 0 };
function durableAudit(event: Record<string, unknown>): void {
  const dir = process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR?.trim();
  if (!dir) return;
  try { auditSpool(dir, event); } catch (error) { console.error('[ModelAProspective] durable audit unavailable:', error); }
}
export function modelAProspectiveStats() {
  const dir = process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR?.trim();
  let durablePending: number | null = null;
  if (dir && modelAProspectiveEnabled()) {
    try { durablePending = countSpool(dir); }
    catch (error) { console.error('[ModelAProspective] cannot inspect durable spool:', error); }
  }
  return { ...stats, pending: queue.length + active, active, durablePending };
}
/** Caller must stop admitting new forecasts before draining; the web process does not yet call this on signals. */
export async function drainModelAProspective(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (queue.length + active > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (queue.length + active !== 0) return false;
  const dir = process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR?.trim();
  try { return !dir || countSpool(dir) === 0; }
  catch (error) { console.error('[ModelAProspective] cannot inspect durable spool during drain:', error); return false; }
}
function pump(): void {
  while (active < maxConcurrent && queue.length) {
    const job = queue.shift()!; active++; job.attempts++;
    Promise.resolve().then(() => {
      if (typeof job.sink.appendModelAProspectiveForecast !== 'function') throw new Error('prospective storage unavailable');
      return job.sink.appendModelAProspectiveForecast(job.record);
    }).then(() => { if (job.spoolDir) removeSpool(job.spoolDir, job.record.id); stats.stored++; }).catch((error: unknown) => {
      console.error('[ModelAProspective] recording failed:', error instanceof Error ? error.message : String(error), `id=${job.record.id}`, `attempt=${job.attempts}`);
      if (job.attempts < maxAttempts && Date.now() + 500 < Date.parse(job.record.kickoffAt)) {
        stats.retries++;
        // Keep the slot occupied while waiting so retrying jobs still count towards the bound.
        return new Promise<void>(resolve => setTimeout(() => { queue.push(job); resolve(); }, job.attempts * 100));
      }
      stats.failed++; durableAudit({ type: 'delivery_unconfirmed', id: job.record.id });
      console.error('[ModelAProspective] delivery unconfirmed after retries:', job.record.id);
    }).finally(() => { active--; if (!queue.some(item => item.record.id === job.record.id)) tracked.delete(job.record.id); pump(); });
  }
}
export const modelAProspectiveEnabled = (): boolean => process.env.MODEL_A_PROSPECTIVE_ENABLED === 'true';
let recoveryTimer: NodeJS.Timeout | undefined;
let warnedVolatile = false;
/** Replay fsynced events after restart; sink inserts idempotently even after kickoff. */
export function recoverModelAProspective(sink: Sink): number {
  const dir = process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR?.trim();
  if (!modelAProspectiveEnabled() || !dir) return 0;
  let added = 0;
  try {
    for (const record of readSpool(dir)) {
      if (queue.length + active >= maxQueue) break;
      if (tracked.has(record.id)) continue;
      tracked.add(record.id); queue.push({ sink, record, attempts: 0, spoolDir: dir }); added++;
    }
    if (added) setImmediate(pump);
  } catch (error) { console.error('[ModelAProspective] spool recovery failed:', error); }
  return added;
}
export function startModelAProspectiveRecovery(sink: Sink): void {
  if (!modelAProspectiveEnabled()) return;
  recoverModelAProspective(sink);
  const reconcile = () => { if (modelAProspectiveEnabled()) void reconcileModelAProspectiveResults(sink).catch(error => console.error('[ModelAProspective] result reconciliation failed:', error)); };
  reconcile();
  if (!recoveryTimer) { recoveryTimer = setInterval(() => { recoverModelAProspective(sink); reconcile(); }, 30000); recoveryTimer.unref(); }
}
const pair = (flat: Record<string, number> | null) => ({
  over: typeof flat?.over25 === 'number' && Number.isFinite(flat.over25) && flat.over25 >= 0 && flat.over25 <= 1 ? flat.over25 : null,
  under: typeof flat?.under25 === 'number' && Number.isFinite(flat.under25) && flat.under25 >= 0 && flat.under25 <= 1 ? flat.under25 : null,
});

/** Enqueue only real, current A predictions; never block or alter inference on a failed write. */
export function scheduleModelAProspective(sink: Sink, input: Input): void {
  if (!modelAProspectiveEnabled()) return;
  let eventId: string | undefined;
  try {
    const now = Date.now(), at = Date.parse(input.asOf), kickoff = Date.parse(String(input.match?.date ?? ''));
    if (!input.request.matchId || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(input.match?.date ?? ''))
      || !Object.prototype.hasOwnProperty.call(input.match ?? {}, 'home_goals') || !Object.prototype.hasOwnProperty.call(input.match ?? {}, 'away_goals')
      || String(input.match?.match_id ?? '') !== input.request.matchId
      || String(input.match?.home_team_id ?? '') !== input.request.homeTeamId || String(input.match?.away_team_id ?? '') !== input.request.awayTeamId
      || input.match?.home_goals != null || input.match?.away_goals != null || !Number.isFinite(kickoff)
      || !Number.isFinite(at) || at > now || now - at > 300000 || now >= kickoff) {
      stats.ineligible++; console.warn('[ModelAProspective] skipped: fixture or observation time not eligible'); return;
    }
    const id = randomUUID(); eventId = id;
    const spoolDir = process.env.MODEL_A_PROSPECTIVE_SPOOL_DIR?.trim();
    if (!spoolDir && process.env.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE !== 'true') {
      stats.rejected++; console.error('[ModelAProspective] durable spool required; forecast not recorded:', id); return;
    }
    if (queue.length + active >= maxQueue) { stats.rejected++; durableAudit({ type: 'queue_full', id, matchId: input.request.matchId });
      console.error('[ModelAProspective] queue full; forecast not recorded:', id); return; }
    const contextual = pair(input.contextual), calibrated = pair(input.calibrated), decision = pair(input.decision);
    const selectedKey = String(input.selected?.selection ?? '');
    const roundedSelected = input.selected?.ourProbability;
    const matches = (input.exactCandidates ?? []).filter(item => item.selection === selectedKey && typeof roundedSelected === 'number'
      && Number((item.probability * 100).toFixed(2)) === roundedSelected);
    const uniqueExact = [...new Set(matches.map(item => item.probability))];
    const exactSelected = uniqueExact.length === 1 ? uniqueExact[0] : null;
    const quotes = input.odds?.source === 'odds_api' && Number.isFinite(Date.parse(input.odds.capturedAt)) && Date.parse(input.odds.capturedAt) <= at
      ? ['over25', 'under25'].flatMap(selection => {
        const odds = input.odds!.odds[selection], bookmaker = input.odds!.bookmakerBySelection[selection];
        return Number.isFinite(odds) && odds > 1 && bookmaker ? [{ selection, odds, bookmaker, provider: input.odds!.source,
          capturedAt: input.odds!.capturedAt, updatedAt: null, freshness: 'provider update time unavailable' }] : [];
      }) : [];
    const forecastAt = new Date(now).toISOString();
    const payload = JSON.stringify({ schema: 'model-a-operational-prospective-v1', id, family: 'A', matchId: input.request.matchId,
      competition: input.request.competition ?? input.match.competition ?? null, season: input.request.season ?? input.match.season ?? null, origin: input.origin,
      homeTeamId: input.request.homeTeamId, awayTeamId: input.request.awayTeamId, forecastAt, inputAsOf: input.asOf,
      capturedAt: forecastAt, kickoffAt: new Date(kickoff).toISOString(), model: input.model,
      modelParametersHash: input.modelParametersHash, calibration: input.calibration,
      stages: { ensembleRaw: { value: null, reason: 'pre-context ensemble not exposed by operational pipeline' },
        contextual: { value: contextual, reason: 'post-context and ensemble; effects not separated' },
        calibrated: { value: input.calibrated ? calibrated : null, reason: input.calibrated ? null : 'calibrated stage unavailable' },
        marketBlended: { value: null, reason: 'market blend not exposed independently from opportunities' },
        decision: { value: decision, reason: 'surviving opportunities only; rounded to two decimal percentage points, not the exact internal EV probability' } },
      selected: input.selected ? { selection: input.selected.selection ?? null, probability: typeof input.selected.ourProbability === 'number' ? input.selected.ourProbability / 100 : null,
        precision: 'rounded to two decimal percentage points', exactProbability: exactSelected,
        exactReason: exactSelected === null ? 'no uniquely identifiable pre-rounding Over/Under candidate' : null,
        exactOrigins: exactSelected === null ? [] : [...new Set(matches.map(item => item.origin))] } : null,
      quotes, provenance: { inputSnapshotHash: null, inputAvailableThrough: null,
        reason: 'historical input availability not independently timestamped; model state hash is not an input snapshot' } });
    if (!spoolDir && !warnedVolatile) { warnedVolatile = true; console.warn('[ModelAProspective] spool directory unset; collection is volatile'); }
    const record: SpoolRecord = { id, matchId: input.request.matchId, forecastAt, kickoffAt: new Date(kickoff).toISOString(), payload };
    if (spoolDir) {
      if (countSpool(spoolDir) >= 10000) { stats.rejected++; durableAudit({ type: 'spool_full', id, matchId: input.request.matchId });
        console.error('[ModelAProspective] durable spool full; forecast not recorded:', id); return; }
      persistSpool(spoolDir, record); record.durable = true;
    }
    stats.accepted++; tracked.add(id); queue.push({ sink, attempts: 0, record, spoolDir });
    setImmediate(pump);
  } catch (error) { stats.captureErrors++; durableAudit({ type: 'capture_error', id: eventId, matchId: input.request.matchId });
    console.error('[ModelAProspective] recording setup failed:', eventId ?? 'unassigned', error instanceof Error ? error.message : String(error)); }
}
