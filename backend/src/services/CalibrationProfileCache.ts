import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FamilyCalibrationCurve } from '../models/value/EnhancedMarketAnalysis';

export type CalibrationProfile = {
  calibrationPoints: Array<{ x: number; y: number }>;
  nObservations: number;
  byFamily: Record<string, FamilyCalibrationCurve>;
  learnedBlendWeights: Record<string, { modelWeight: number; sampleSize: number }>;
};

export const calibrationPayloadHash = (payload: string): string => createHash('sha256').update(payload).digest('hex');
let codeRevision: string | undefined;

/** Hash the deployed implementation too: an unchanged version label must never reuse changed maths. */
function runtimeCodeRevision(): string {
  if (codeRevision) return codeRevision;
  const root = join(__dirname, '..');
  const extension = __filename.endsWith('.ts') ? '.ts' : '.js';
  const hash = createHash('sha256').update('chronological-calibration-cache-v1');
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(extension) && !entry.name.endsWith('.d.ts')) {
        hash.update(relative(root, path).replace(/\\/g, '/'));
        hash.update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
      }
    }
  };
  visit(root);
  codeRevision = hash.digest('hex');
  return codeRevision;
}

/** Callers provide the entire eligible input cohort and the evaluated model configuration. */
export function calibrationProfileFingerprint(inputs: unknown, configuration: unknown): string {
  return calibrationPayloadHash(JSON.stringify([runtimeCodeRevision(), configuration, inputs]));
}

/** Cache damage is a miss, never permission to use a partial/default calibration. */
export function decodeCalibrationProfile(payload: string, checksum: string): CalibrationProfile | null {
  if (calibrationPayloadHash(payload) !== checksum) return null;
  try {
    const value = JSON.parse(payload);
    const count = (n: unknown): boolean => Number.isSafeInteger(n) && Number(n) >= 0;
    const probability = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    const points = (curve: any): boolean => Array.isArray(curve) && curve.length >= 2
      && curve.every((point: any, index: number) => point && probability(point.x) && probability(point.y)
        && (index === 0 || (point.x >= curve[index - 1].x && point.y >= curve[index - 1].y)));
    const record = (input: any): boolean => input !== null && typeof input === 'object' && !Array.isArray(input);
    if (!record(value) || !points(value.calibrationPoints) || !count(value.nObservations)
      || !record(value.byFamily) || !record(value.learnedBlendWeights)) return null;
    if (!Object.values(value.byFamily).every((entry: any) => record(entry)
      && points(entry.points) && count(entry.nObservations))) return null;
    if (!Object.values(value.learnedBlendWeights).every((entry: any) => record(entry)
      && probability(entry.modelWeight) && count(entry.sampleSize))) return null;
    return value as CalibrationProfile;
  } catch {
    return null;
  }
}
