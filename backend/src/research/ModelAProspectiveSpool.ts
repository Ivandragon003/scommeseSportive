import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
  renameSync(temporary, dest);
  if (Date.now() >= Date.parse(record.kickoffAt)) { unlinkSync(dest); throw new Error('kickoff reached during durable admission'); }
}
export function readSpool(dir: string): SpoolRecord[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return readdirSync(dir).filter(name => uuid.test(name.slice(0, -5)) && name.endsWith('.json')).flatMap(name => {
    try {
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SpoolRecord;
      if (`${value.id}.json` !== name || typeof value.payload !== 'string' || value.durable !== true
        || !Number.isFinite(Date.parse(value.forecastAt)) || !Number.isFinite(Date.parse(value.kickoffAt))
        || Date.parse(value.forecastAt) >= Date.parse(value.kickoffAt)) throw new Error('invalid record');
      const payload = JSON.parse(value.payload);
      if (payload.id !== value.id || payload.matchId !== value.matchId || payload.forecastAt !== value.forecastAt
        || payload.kickoffAt !== value.kickoffAt || payload.family !== 'A') throw new Error('payload mismatch');
      return [value];
    } catch (error) { console.error('[ModelAProspective] invalid durable spool file:', name, error); return []; }
  });
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
