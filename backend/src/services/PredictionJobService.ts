import { createHash, randomUUID } from 'node:crypto';

export type PredictionJobResult = { responseStatus: number; response: unknown };
export type PredictionJobView = {
  id: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  response?: unknown;
  responseStatus?: number;
};
type Job = PredictionJobView & {
  owner: string;
  key: string;
  started: boolean;
  completedAt?: number;
  work?: () => Promise<PredictionJobResult>;
};

const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export class PredictionJobBusyError extends Error {
  constructor() { super('Un’altra analisi è ancora in corso. Riprova tra poco.'); }
}

/** A transport envelope only: the supplied prediction operation and its instance are unchanged. */
export class PredictionJobService {
  private readonly jobs = new Map<string, Job>();
  private activeId?: string;
  private readonly clock: () => number;
  private readonly schedule: (work: () => void) => unknown;
  private readonly resultTtlMs: number;
  private readonly maxResults: number;

  constructor(options: { clock?: () => number; schedule?: (work: () => void) => unknown;
    resultTtlMs?: number; maxResults?: number } = {}) {
    this.clock = options.clock ?? Date.now;
    this.schedule = options.schedule ?? setImmediate;
    this.resultTtlMs = options.resultTtlMs ?? 10 * 60_000;
    this.maxResults = Math.max(1, options.maxResults ?? 8);
  }

  create(owner: string, body: Record<string, unknown>, work: (body: any) => Promise<PredictionJobResult>): PredictionJobView {
    this.prune();
    const input = jsonCopy(body);
    const key = createHash('sha256').update(JSON.stringify([owner, input])).digest('hex');
    const active = this.activeId ? this.jobs.get(this.activeId) : undefined;
    if (active?.status === 'RUNNING') {
      if (active.owner === owner && active.key === key) return this.view(active);
      throw new PredictionJobBusyError();
    }
    const job: Job = { id: randomUUID(), owner, key, status: 'RUNNING', started: false, work: () => work(input) };
    this.jobs.set(job.id, job);
    this.activeId = job.id;
    return this.view(job);
  }

  /** Called after the accepting HTTP response finishes (or disconnects), never during create. */
  start(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.started || job.status !== 'RUNNING') return;
    job.started = true;
    this.schedule(() => {
      const work = job.work!;
      delete job.work;
      void Promise.resolve().then(work).then((result) => {
        this.complete(job, result);
      }).catch(() => {
        this.complete(job, { responseStatus: 500,
          response: { success: false, error: 'Analisi non disponibile. Riprova.' } });
      }).finally(() => {
        if (this.activeId === id) this.activeId = undefined;
      });
    });
  }

  get(owner: string, id: string): PredictionJobView | null {
    this.prune();
    const job = this.jobs.get(id);
    return job?.owner === owner ? this.view(job) : null;
  }

  private complete(job: Job, result: PredictionJobResult): void {
    job.response = jsonCopy(result.response);
    job.responseStatus = result.responseStatus;
    job.status = result.responseStatus >= 400 ? 'FAILED' : 'COMPLETED';
    job.completedAt = this.clock();
    this.prune();
  }

  private view(job: Job): PredictionJobView {
    return { id: job.id, status: job.status, ...(job.status === 'RUNNING' ? {}
      : { response: jsonCopy(job.response), responseStatus: job.responseStatus }) };
  }

  private prune(): void {
    const now = this.clock();
    for (const [id, job] of this.jobs) {
      if (job.completedAt !== undefined && now - job.completedAt >= this.resultTtlMs) this.jobs.delete(id);
    }
    const completed = [...this.jobs.values()].filter((job) => job.completedAt !== undefined)
      .sort((a, b) => a.completedAt! - b.completedAt!);
    for (const job of completed.slice(0, Math.max(0, completed.length - this.maxResults))) this.jobs.delete(job.id);
  }
}
