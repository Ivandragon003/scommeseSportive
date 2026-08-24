import { Worker, type WorkerOptions } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type WalkForwardBacktestJob = {
  competition: string;
  season?: string;
  historicalOdds?: Record<string, Record<string, number>>;
  options?: Record<string, unknown>;
};

type WorkerMessage =
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: { name?: string; message?: string; stack?: string } };

type WorkerLike = Pick<Worker, 'on' | 'once' | 'terminate'>;
type WorkerFactory = (filename: string, options: WorkerOptions) => WorkerLike;

export class HeavyJobBusyError extends Error {
  constructor() {
    super('Un backtest e gia in esecuzione. Riprova quando termina.');
    this.name = 'HeavyJobBusyError';
  }
}

export class HeavyJobService {
  private running = false;
  private readonly timeoutMs: number;
  private readonly workerFactory: WorkerFactory;

  constructor(options?: { timeoutMs?: number; workerFactory?: WorkerFactory }) {
    this.timeoutMs = Math.max(
      1_000,
      Number(options?.timeoutMs ?? process.env.BACKTEST_JOB_TIMEOUT_MS ?? process.env.BACKTEST_ROUTE_TIMEOUT_MS ?? 10 * 60 * 1000)
        || 10 * 60 * 1000
    );
    this.workerFactory = options?.workerFactory ?? ((filename, workerOptions) => new Worker(filename, workerOptions));
  }

  async runWalkForwardBacktest(job: WalkForwardBacktestJob): Promise<any> {
    if (this.running) throw new HeavyJobBusyError();
    this.running = true;
    try {
      return await this.execute(job);
    } finally {
      this.running = false;
    }
  }

  private execute(job: WalkForwardBacktestJob): Promise<any> {
    return new Promise((resolve, reject) => {
      const compiledWorker = join(__dirname, '..', 'workers', 'backtest.worker.js');
      const useCompiledWorker = existsSync(compiledWorker);
      const worker = this.workerFactory(
        useCompiledWorker ? compiledWorker : join(__dirname, '..', 'workers', 'backtest.worker.ts'),
        useCompiledWorker
          ? { workerData: job }
          : { workerData: job, execArgv: ['-r', 'ts-node/register'] }
      );
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void worker.terminate().catch(() => undefined);
        callback();
      };
      const timeout = setTimeout(() => {
        settle(() => reject(new Error(`Backtest worker timed out after ${this.timeoutMs}ms.`)));
      }, this.timeoutMs);

      worker.on('message', (message: WorkerMessage) => {
        if (message?.type === 'result') return settle(() => resolve(message.result));
        if (message?.type === 'error') {
          const error = new Error(String(message.error?.message ?? 'Backtest worker failed.'));
          error.name = String(message.error?.name ?? 'Error');
          if (message.error?.stack) error.stack = message.error.stack;
          return settle(() => reject(error));
        }
        return settle(() => reject(new Error('Backtest worker returned an invalid message.')));
      });
      worker.once('error', (error) => settle(() => reject(error)));
      worker.once('exit', (code) => {
        if (code !== 0) settle(() => reject(new Error(`Backtest worker exited with code ${code}.`)));
        else settle(() => reject(new Error('Backtest worker exited without a result message.')));
      });
    });
  }
}
