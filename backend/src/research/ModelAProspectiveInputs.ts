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
