import type { AxiosRequestConfig } from 'axios';
import type { ApiResponse } from './api';

export const PREDICTION_JOB_HTTP_TIMEOUT_MS = 15_000;
export const PREDICTION_JOB_MAX_WAIT_MS = 10 * 60 * 1000;
export const PREDICTION_JOB_POLL_INTERVAL_MS = 2_000;

interface JobTransport {
  post<T>(url: string, body: unknown, config: AxiosRequestConfig): Promise<{ data: T }>;
  get<T>(url: string, config: AxiosRequestConfig): Promise<{ data: T }>;
}

interface PredictionJob {
  id: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  response?: ApiResponse<unknown>;
  responseStatus?: number;
}

const unavailable = () => new Error('Non è stato possibile completare l’analisi. Puoi riprovare.');
const expired = () => new Error('L’analisi è stata interrotta o non è più disponibile. Riapri la partita per riprovare.');
const timedOut = () => new Error('L’analisi sta impiegando troppo tempo. Puoi riprovare tra poco.');
const aborted = () => Object.assign(new Error('Consultazione annullata.'), { name: 'AbortError' });
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);

function checkWait(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
  if (Date.now() >= deadline) throw timedOut();
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(aborted());
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function parseJob(value: unknown, expectedId?: string): PredictionJob {
  if (!object(value) || value.success !== true || !object(value.data)) throw unavailable();
  const job = value.data;
  if (!validId(job.id) || (expectedId !== undefined && job.id !== expectedId)
    || !['RUNNING', 'COMPLETED', 'FAILED'].includes(job.status)) throw unavailable();
  if (job.responseStatus !== undefined && (!Number.isInteger(job.responseStatus)
    || job.responseStatus < 100 || job.responseStatus > 599)) throw unavailable();
  return job as PredictionJob;
}

function temporaryReadError(error: unknown): boolean {
  if (!object(error)) return false;
  if (['ECONNABORTED', 'ETIMEDOUT', 'ERR_NETWORK', 'ECONNRESET'].includes(error.code)) return true;
  return [502, 503, 504, 524].includes(error.response?.status);
}

/** Polling is read-only. Starting a calculation is deliberately never retried. */
export async function runPredictionJob<T>(
  transport: JobTransport,
  request: unknown,
  options?: { signal?: AbortSignal },
): Promise<ApiResponse<T>> {
  const signal = options?.signal;
  const deadline = Date.now() + PREDICTION_JOB_MAX_WAIT_MS;
  const config = (): AxiosRequestConfig => ({
    timeout: Math.max(1, Math.min(PREDICTION_JOB_HTTP_TIMEOUT_MS, deadline - Date.now())),
    ...(signal ? { signal } : {}),
  });
  checkWait(deadline, signal);
  let accepted: unknown;
  try {
    accepted = (await transport.post<unknown>('/predict/jobs', request, config())).data;
  } catch (error) {
    if (signal?.aborted) throw aborted();
    if (object(error) && error.response?.status === 409) {
      throw new Error('Un’altra analisi è già in corso. Riprova tra poco.');
    }
    throw error;
  }
  checkWait(deadline, signal);
  const started = parseJob(accepted);
  if (started.status !== 'RUNNING') throw unavailable();
  const url = `/predict/jobs/${encodeURIComponent(started.id)}`;

  while (true) {
    checkWait(deadline, signal);
    let payload: unknown;
    try {
      payload = (await transport.get<unknown>(url, config())).data;
    } catch (error) {
      checkWait(deadline, signal);
      if (object(error) && error.response?.status === 404) throw expired();
      if (!temporaryReadError(error)) throw error;
      await wait(Math.min(PREDICTION_JOB_POLL_INTERVAL_MS, deadline - Date.now()), signal);
      continue;
    }
    checkWait(deadline, signal);
    const job = parseJob(payload, started.id);
    if (job.status === 'RUNNING') {
      await wait(Math.min(PREDICTION_JOB_POLL_INTERVAL_MS, deadline - Date.now()), signal);
      continue;
    }
    const response = job.response;
    if (!object(response) || typeof response.success !== 'boolean') throw unavailable();
    if (job.status === 'FAILED') {
      if (response.success || (job.responseStatus !== undefined && job.responseStatus < 400)) throw unavailable();
      throw Object.assign(unavailable(), {
        response: { status: job.responseStatus ?? 500, data: response },
      });
    }
    if (!response.success || !Object.prototype.hasOwnProperty.call(response, 'data')
      || (job.responseStatus !== undefined && job.responseStatus >= 400)) throw unavailable();
    return response as ApiResponse<T>;
  }
}
