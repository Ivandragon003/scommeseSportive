import { createHash } from 'node:crypto';

export interface ModelAInputProvenance {
  inputSnapshotHash: string | null;
  inputAvailableThrough: string | null;
  observedInputsThrough: string | null;
  snapshot: unknown;
  components: Array<{ name: string; observedAt: string; hash: string }>;
  limitations: string[];
  temporalStatus: 'locally_observed' | 'unverified';
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
  return createHash('sha256').update(JSON.stringify(ordered(snapshot))).digest('hex');
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

/** Preserve existing row timestamps as evidence of local writes, never source publication. */
export function modelASourceTimestampEvidence(row: any, inspectedAt: string) {
  let observation: any;
  try { observation = JSON.parse(typeof row?.raw_json === 'string' ? row.raw_json : '{}')?.resultObservation; } catch { /* No source observation is inferred from unreadable JSON. */ }
  return {
    inspectedAt,
    source: typeof row?.source === 'string' ? row.source : null,
    recordPresent: row != null,
    created: timestampEvidence(row?.created_at, 'local_database_record_creation_not_input_publication', inspectedAt, true),
    updated: timestampEvidence(row?.last_updated, 'local_database_row_write_not_input_publication', inspectedAt, true),
    resultObservation: { source: typeof observation?.source === 'string' ? observation.source : null,
      sourceMatchesRecord: observation?.source != null && observation.source === row?.source,
      timestamp: timestampEvidence(observation?.observedAt, 'declared_result_ingestion_observation_not_publication', inspectedAt) },
    providerPublishedAt: null,
    limitation: 'These declarations do not establish availability of all contributing inputs or historical revisions.',
  };
}

/** Observe actual inference arguments synchronously before use, without changing them. */
export class ModelAInputCapture {
  private values: Record<string, unknown> = {};
  private components: ModelAInputProvenance['components'] = [];
  private errors: string[] = [];

  observe(name: string, value: unknown): void {
    try {
      // Copy at the observation boundary: later model/cache mutations must not rewrite evidence.
      // JSON omits callbacks and undefined object fields just as the persisted payload does.
      const copy = JSON.parse(JSON.stringify(value));
      const observedAt = new Date().toISOString();
      this.values[name] = copy;
      this.components.push({ name, observedAt, hash: modelAInputSnapshotHash(copy) });
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
    const complete = !missing.length && !this.errors.length;
    const snapshot = { schema: 'model-a-effective-inputs-v1', scope: 'over-under-2.5', values: this.values };
    return {
      inputSnapshotHash: complete ? modelAInputSnapshotHash(snapshot) : null,
      // A local read time cannot stand in for an unknown source/training availability bound.
      inputAvailableThrough: null,
      observedInputsThrough: this.components.length ? this.components.map(x => x.observedAt).sort()[this.components.length - 1] : null,
      snapshot, components: this.components, limitations,
      temporalStatus: complete ? 'locally_observed' : 'unverified',
      reason: complete ? 'Effective inputs observed locally before use; complete upstream temporal availability remains unverified.'
        : 'Effective input snapshot incomplete; consult limitations.',
    };
  }
}
