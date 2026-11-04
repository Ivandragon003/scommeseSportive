import { createHash } from 'node:crypto';

export interface ModelAInputProvenance {
  inputSnapshotHash: string | null;
  inputAvailableThrough: string | null;
  observedInputsThrough: string | null;
  snapshot: unknown;
  components: Array<{ name: string; observedAt: string; hash: string }>;
  limitations: string[];
  temporalStatus: 'locally_observed' | 'unverified';
  classification: 'technical_only';
  rigorousEligible: false;
  reason: string | null;
}

function ordered(value: any): any {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, ordered(value[key])]));
  return value;
}

/** Hash the persisted JSON value, independent of object insertion order. */
export function modelAInputSnapshotHash(snapshot: unknown): string {
  const persisted = JSON.parse(JSON.stringify(snapshot));
  return hashPersistedJson(persisted);
}

/** Internal only: callers must already have normalized through persisted JSON. */
function hashPersistedJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}

type TimestampEvidence = { declared: string | null; utc: string | null;
  status: 'missing' | 'invalid' | 'future' | 'observed'; meaning: string };

function timestampEvidence(value: unknown, meaning: string, inspectedAt: string, sqliteUtc = false): TimestampEvidence {
  const declared = typeof value === 'string' ? value : null;
  const result: TimestampEvidence = { declared, utc: null, status: declared === null ? 'missing' : 'invalid', meaning };
  if (!declared) return result;
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/i.exec(declared);
  if (!parts || (!parts[8] && !sqliteUtc)) return result;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return result;
  // These two columns are written by SQLite datetime('now'), which uses UTC.
  // A provider observation without a timezone is deliberately not normalized.
  const instant = Date.parse(declared.replace(' ', 'T') + (parts[8] ? '' : 'Z'));
  if (!Number.isFinite(instant) || !Number.isFinite(Date.parse(inspectedAt))) return result;
  result.utc = new Date(instant).toISOString();
  result.status = instant > Date.parse(inspectedAt) ? 'future' : 'observed';
  return result;
}

function publicIdentifier(value: unknown): string | number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // Public football IDs and source labels are not URLs, credentials or arbitrary payloads.
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ? value : null;
}

/** Fingerprint an actually consumed record without retaining raw provider payloads. */
export function modelASourceRecordEvidence(row: any, inspectedAt: string) {
  let observation: any;
  let aggregate: any;
  try { observation = JSON.parse(typeof row?.raw_json === 'string' ? row.raw_json : '{}')?.resultObservation; } catch { /* No source observation is inferred from unreadable JSON. */ }
  try { aggregate = JSON.parse(typeof row?.team_stats_json === 'string' ? row.team_stats_json : '{}')?.computed; } catch { /* The record hash still identifies unreadable source data. */ }
  let recordHash: string | null = null;
  const flags: string[] = [];
  try { if (row != null) recordHash = modelAInputSnapshotHash(row); } catch { flags.push('record_hash_unavailable'); }
  const identity = Object.fromEntries(['id', 'match_id', 'team_id', 'player_id', 'referee_id',
    'matchId', 'teamId', 'playerId', 'refereeId', 'provider_fixture_id',
    'source_match_id', 'source_team_id', 'source_player_id', 'cache_key', 'transition_id', 'batch_id', 'history_id']
    .filter(key => publicIdentifier(row?.[key]) !== null).map(key => [key, publicIdentifier(row[key])]));
  const source = typeof row?.source === 'string' ? publicIdentifier(row.source) : null;
  const resultSource = typeof observation?.source === 'string' ? publicIdentifier(observation.source) : null;
  const timestamps = {
    created: timestampEvidence(row?.created_at, 'local_database_record_creation_not_input_publication', inspectedAt, true),
    updated: timestampEvidence(row?.last_updated, 'local_database_row_write_not_input_publication', inspectedAt, true),
    fitted: timestampEvidence(row?.fitted_at, 'local_model_fit_record_write_not_training_input_availability', inspectedAt, true),
    aggregateComputed: timestampEvidence(aggregate?.updatedAt, 'local_team_aggregate_computation_not_source_publication', inspectedAt),
    lineupCaptured: timestampEvidence(row?.fetched_at, 'local_lineup_snapshot_capture_write_not_provider_publication', inspectedAt),
    profileGenerated: timestampEvidence(row?.generatedAt, 'local_adaptive_profile_generation_not_training_input_availability', inspectedAt),
  };
  const resultTimestamp = timestampEvidence(observation?.observedAt, 'declared_result_ingestion_observation_not_publication', inspectedAt);
  for (const [name, evidence] of Object.entries({ ...timestamps, resultObservation: resultTimestamp })) {
    if (evidence.status === 'invalid' || evidence.status === 'future') flags.push(`${name}_timestamp_${evidence.status}`);
  }
  if (observation?.source != null && observation.source !== row?.source) flags.push('result_observation_source_mismatch');
  if (timestamps.created.utc && timestamps.updated.utc && timestamps.created.utc > timestamps.updated.utc) flags.push('database_write_order_mismatch');
  // These fields have no verified publication/revision semantics in the current producers.
  // A similarly named declaration must never silently acquire those semantics.
  if (row?.providerPublishedAt != null || row?.provider_published_at != null
    || row?.providerRevisionAt != null || row?.provider_revision_at != null) flags.push('provider_timestamp_semantics_unverified');
  return {
    inspectedAt,
    localAcquiredAt: null,
    source,
    recordPresent: row != null,
    identity,
    recordHash,
    ...timestamps,
    resultObservation: { source: resultSource,
      sourceMatchesRecord: observation?.source != null && observation.source === row?.source,
      timestamp: resultTimestamp },
    providerPublishedAt: null,
    providerRevisionAt: null,
    classification: 'technical_only' as const,
    rigorousEligible: false as const,
    flags,
    limitation: 'These declarations do not establish availability of all contributing inputs or historical revisions.',
  };
}

/** Compatibility alias: local database timestamps are never source publication. */
export const modelASourceTimestampEvidence = modelASourceRecordEvidence;

/** Observe actual inference arguments synchronously before use, without changing them. */
export class ModelAInputCapture {
  private values: Record<string, unknown> = {};
  private components: ModelAInputProvenance['components'] = [];
  private errors: string[] = [];
  private sources: Record<string, unknown> = {};

  observeSources(component: string, records: Record<string, unknown>, inspectedAt = new Date().toISOString()): void {
    try {
      const evidence = Object.fromEntries(Object.entries(records).map(([name, value]) => [name,
        Array.isArray(value) ? {
          ...modelASourceRecordEvidence(value, inspectedAt),
          recordCount: value.length,
          records: value.map(row => modelASourceRecordEvidence(row, inspectedAt)),
        } : modelASourceRecordEvidence(value, inspectedAt)]));
      // Freeze the evidence boundary even if a caller later changes an identifier or row.
      this.sources[component] = JSON.parse(JSON.stringify(evidence));
    } catch {
      this.errors.push(`source_evidence_capture_failed:${component}`);
    }
  }

  observe(name: string, value: unknown): void {
    try {
      // Copy at the observation boundary: later model/cache mutations must not rewrite evidence.
      // JSON omits callbacks and undefined object fields just as the persisted payload does.
      const copy = JSON.parse(JSON.stringify(value));
      const observedAt = new Date().toISOString();
      this.values[name] = copy;
      this.components.push({ name, observedAt, hash: hashPersistedJson(copy) });
    } catch {
      this.errors.push(`snapshot_capture_failed:${name}`);
    }
  }

  finish(): ModelAInputProvenance {
    const required = ['contextual', 'ensemble', 'analysis'];
    const missing = required.filter(name => !Object.prototype.hasOwnProperty.call(this.values, name));
    const limitations = [
      'Provider publication and historical revision timestamps are not available for all source data.',
      'Training, calibration and adaptive tuning histories have no complete temporal lineage in this snapshot.',
      'Local observation timestamps depend on the host clock; they are not independent timestamp attestations.',
      'The snapshot covers effective Over/Under inputs, not every upstream training row or other market.',
      ...this.errors, ...missing.map(name => `missing_component:${name}`),
    ];
    const complete = !missing.length && !this.errors.some(error => error.startsWith('snapshot_capture_failed:'));
    const snapshot = JSON.parse(JSON.stringify({ schema: 'model-a-effective-inputs-v1', scope: 'over-under-2.5', values: this.values,
      sourceEvidence: this.sources, classification: 'technical_only', rigorousEligible: false }));
    return {
      inputSnapshotHash: complete ? hashPersistedJson(snapshot) : null,
      // A local read time cannot stand in for an unknown source/training availability bound.
      inputAvailableThrough: null,
      observedInputsThrough: this.components.length ? this.components.map(x => x.observedAt).sort()[this.components.length - 1] : null,
      snapshot, components: this.components.map(component => ({ ...component })), limitations,
      temporalStatus: complete ? 'locally_observed' : 'unverified',
      classification: 'technical_only',
      rigorousEligible: false,
      reason: complete ? 'Effective inputs observed locally before use; complete upstream temporal availability remains unverified.'
        : 'Effective input snapshot incomplete; consult limitations.',
    };
  }
}
