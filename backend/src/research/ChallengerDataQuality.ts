import { createHash } from 'node:crypto';
import quarantine from './challenger-data-quarantine.json';

type MatchIdentity = { matchId: string };
export type ChallengerDataQualityManifest = typeof quarantine;
export type ChallengerDataQualityPopulation = {
  inputRows: number; retainedRows: number; excludedRows: number; excludedMatchIds: string[];
};
export type ChallengerDataQualityEvidence = {
  policyVersion: string; policyHash: string; action: 'quarantine_not_timestamp_correction';
  history: ChallengerDataQualityPopulation; targets: ChallengerDataQualityPopulation;
};
export type ChallengerDataQualityTag = {
  dataQualityPolicyHash?: string; dataQualityBaselineClean?: boolean;
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** The manifest changes the identity of explicitly opted-in C inputs, never shared A data. */
export const CHALLENGER_DATA_QUALITY_MANIFEST = deepFreeze(JSON.parse(JSON.stringify(quarantine)) as ChallengerDataQualityManifest);
export const CHALLENGER_DATA_QUALITY_POLICY_HASH = createHash('sha256')
  .update(JSON.stringify(CHALLENGER_DATA_QUALITY_MANIFEST)).digest('hex');
const reasons = new Map(CHALLENGER_DATA_QUALITY_MANIFEST.entries.map((entry) => [entry.matchId, entry.reason]));
if (CHALLENGER_DATA_QUALITY_MANIFEST.scope !== 'C_only'
  || CHALLENGER_DATA_QUALITY_MANIFEST.action !== 'quarantine_not_timestamp_correction'
  || reasons.size !== CHALLENGER_DATA_QUALITY_MANIFEST.entries.length
  || CHALLENGER_DATA_QUALITY_MANIFEST.entries.some((entry) => !/^understat_\d+$/.test(entry.matchId) || !entry.reason)) {
  throw new Error('invalid_challenger_data_quality_manifest');
}

export function challengerDataQualityReason(matchId: string): string | null {
  return reasons.get(String(matchId)) ?? null;
}

/** Returns a new array. Dates, labels, statistics and the supplied objects are never edited. */
export function filterChallengerHistory<T extends MatchIdentity>(history: readonly T[]): T[] {
  return history.filter((match) => !reasons.has(match.matchId));
}

export function getChallengerDataQualityEvidence(history: readonly MatchIdentity[],
  targets: readonly MatchIdentity[] = history): ChallengerDataQualityEvidence {
  const population = (rows: readonly MatchIdentity[]): ChallengerDataQualityPopulation => {
    const excluded = rows.filter((row) => reasons.has(row.matchId));
    return { inputRows: rows.length, retainedRows: rows.length - excluded.length, excludedRows: excluded.length,
      excludedMatchIds: [...new Set(excluded.map((row) => row.matchId))].sort() };
  };
  return { policyVersion: CHALLENGER_DATA_QUALITY_MANIFEST.version, policyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH,
    action: 'quarantine_not_timestamp_correction', history: population(history), targets: population(targets) };
}

export function hasCleanChallengerBaseline(input: ChallengerDataQualityTag): boolean {
  return input.dataQualityPolicyHash === CHALLENGER_DATA_QUALITY_POLICY_HASH && input.dataQualityBaselineClean === true;
}
