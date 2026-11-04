import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SpoolRecord = { id: string; matchId: string; forecastAt: string; kickoffAt: string; payload: string; durable?: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function location(dir: string, id: string): string { if (!uuid.test(id)) throw new Error('invalid spool id'); return join(dir, `${id}.json`); }

/** Synchronous file fsync is the admission boundary; callers must handle failure. */
export function persistSpool(dir: string, record: SpoolRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = location(dir, record.id), temporary = `${dest}.partial`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ ...record, durable: true })); fsyncSync(fd); }
  finally { closeSync(fd); }
  if (Date.now() >= Date.parse(record.kickoffAt)) { unlinkSync(temporary); throw new Error('kickoff reached before durable admission'); }
  // An existing ID must never be overwritten, even if an identifier is reused.
  linkSync(temporary, dest);
  unlinkSync(temporary);
  if (Date.now() >= Date.parse(record.kickoffAt)) { unlinkSync(dest); throw new Error('kickoff reached during durable admission'); }
}
export function* iterateSpool(dir: string, afterId?: string): Generator<SpoolRecord> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names = readdirSync(dir).sort();
  for (const name of names.filter(name => name.endsWith('.partial')))
    console.error('[ModelAProspective] incomplete durable spool file retained:', name);
  for (const name of names.filter(name => name.endsWith('.json') && !uuid.test(name.slice(0, -5))))
    console.error('[ModelAProspective] invalid durable spool filename retained:', name);
  const candidates = names.filter(name => uuid.test(name.slice(0, -5)) && name.endsWith('.json'));
  // Resume after the last visited ID, wrapping once even if that file was removed.
  const split = afterId ? candidates.findIndex(name => name > `${afterId}.json`) : 0;
  const ordered = split < 0 ? candidates : candidates.slice(split).concat(candidates.slice(0, split));
  for (const name of ordered) {
    try {
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SpoolRecord;
      if (`${value.id}.json` !== name || typeof value.payload !== 'string' || value.durable !== true
        || !Number.isFinite(Date.parse(value.forecastAt)) || !Number.isFinite(Date.parse(value.kickoffAt))
        || Date.parse(value.forecastAt) >= Date.parse(value.kickoffAt)) throw new Error('invalid record');
      const payload = JSON.parse(value.payload);
      if (payload.id !== value.id || payload.matchId !== value.matchId || payload.forecastAt !== value.forecastAt
        || payload.kickoffAt !== value.kickoffAt || payload.family !== 'A') throw new Error('payload mismatch');
      yield value;
    } catch (error) { console.error('[ModelAProspective] invalid durable spool file:', name, error); }
  }
}
export function readSpool(dir: string): SpoolRecord[] {
  return [...iterateSpool(dir)];
}
export function countSpool(dir: string): number {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return readdirSync(dir).filter(name => name.endsWith('.json') || name.endsWith('.partial')).length;
}
export function auditSpool(dir: string, event: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(join(dir, 'audit.ndjson'), 'a', 0o600);
  try { writeFileSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
}
export function removeSpool(dir: string, id: string): void {
  try { unlinkSync(location(dir, id)); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
}

/** Counts persisted audit events, including diagnostic evidence of damaged audit lines. */
export function readSpoolAuditCounts(dir: string): { counts: Record<string, number>; invalidLines: number } {
  let data: string;
  try { data = readFileSync(join(dir, 'audit.ndjson'), 'utf8'); }
  catch (error: any) { if (error?.code === 'ENOENT') return { counts: {}, invalidLines: 0 }; throw error; }
  const counts: Record<string, number> = {};
  let invalidLines = data && !data.endsWith('\n') ? 1 : 0;
  const lines = data.split('\n');
  if (invalidLines) lines.pop(); // An unterminated last write is not a confirmed audit event.
  for (const line of lines) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (typeof event.type !== 'string') throw new Error('missing type');
      counts[event.type] = (counts[event.type] ?? 0) + 1;
    } catch { invalidLines++; }
  }
  return { counts, invalidLines };
}
