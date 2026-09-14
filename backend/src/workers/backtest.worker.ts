import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseService } from '../db/DatabaseService';
import { PredictionService } from '../services/PredictionService';
import type { WalkForwardBacktestJob } from '../services/HeavyJobService';

const serializeError = (error: unknown) => {
  const current = error instanceof Error ? error : new Error(String(error));
  return { name: current.name, message: current.message, stack: current.stack };
};

const run = async (): Promise<void> => {
  const job = workerData as WalkForwardBacktestJob;
  // The API process has already applied the schema migrations before it can
  // dispatch a backtest job. Avoid replaying the full bootstrap in each worker.
  const db = new DatabaseService({ skipSchemaBootstrap: true });
  let response: { type: 'result'; result: unknown } | { type: 'error'; error: ReturnType<typeof serializeError> };
  try {
    const service = new PredictionService(db);
    const result = await service.runWalkForwardBacktest(
      job.competition,
      job.season,
      job.historicalOdds,
      job.options
    );
    response = { type: 'result', result };
  } catch (error) {
    response = { type: 'error', error: serializeError(error) };
  } finally {
    await db.close().catch(() => undefined);
  }
  // HeavyJobService may terminate after receiving this message, so release the
  // database connection before signalling completion.
  parentPort?.postMessage(response!);
};

void run();
