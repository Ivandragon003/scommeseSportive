import {
  PREDICTION_JOB_HTTP_TIMEOUT_MS,
  PREDICTION_JOB_MAX_WAIT_MS,
  PREDICTION_JOB_POLL_INTERVAL_MS,
  runPredictionJob,
} from './predictionJobApi';

const JOB_ID = 'job-42';
const request = {
  homeTeamId: 'home', awayTeamId: 'away', matchId: 'fixture-1', competition: 'Serie A',
  bookmakerOdds: { home: 3, under25: 2.48 }, oddsSource: 'odds_api',
  bankroll: 980.46, options: { includePlayerProps: false },
};
const prediction = { success: true, data: {
  probabilities: { home: 0.42, draw: 0.29, away: 0.29 }, calibration: 'unchanged',
  ranking: ['home', 'under25'], recommendationPacket: { selected: { selection: 'home', stakePercent: 1.06 } },
  modelSpecificField: { retained: true },
}, count: 225 };
const envelope = (status: 'RUNNING' | 'COMPLETED' | 'FAILED', extra: Record<string, unknown> = {}) => ({
  data: { success: true, data: { id: JOB_ID, status, ...extra } },
});
const completed = () => envelope('COMPLETED', { response: prediction, responseStatus: 200 });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function fixture() {
  return { post: jest.fn().mockResolvedValue(envelope('RUNNING')), get: jest.fn().mockResolvedValue(completed()) };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-11-01T15:00:00Z')); });
afterEach(() => { jest.useRealTimers(); });

test('starts A once with the complete original input and returns its complete response unchanged', async () => {
  const api = fixture();
  api.get.mockResolvedValueOnce(envelope('RUNNING')).mockResolvedValueOnce(completed());
  const result = runPredictionJob(api, request);
  await flush();
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith('/predict/jobs', request, { timeout: PREDICTION_JOB_HTTP_TIMEOUT_MS });
  expect(api.post.mock.calls[0][1]).toBe(request);
  expect(api.get).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(PREDICTION_JOB_POLL_INTERVAL_MS); await flush();
  expect(await result).toBe(prediction);
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.get).toHaveBeenLastCalledWith(`/predict/jobs/${JOB_ID}`, { timeout: PREDICTION_JOB_HTTP_TIMEOUT_MS });
  expect(request).not.toHaveProperty('asOf');
});

test('a calculation lasting more than the 125-second gateway limit is retrieved through short reads', async () => {
  const api = fixture(), startedAt = Date.now();
  api.get.mockImplementation(async () => Date.now() - startedAt >= 126_000 ? completed() : envelope('RUNNING'));
  const result = runPredictionJob(api, request);
  await flush();
  for (let i = 0; i < 63; i++) { jest.advanceTimersByTime(PREDICTION_JOB_POLL_INTERVAL_MS); await flush(); }
  expect(await result).toBe(prediction);
  expect(Date.now() - startedAt).toBe(126_000);
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.get.mock.calls.length).toBe(64);
  expect(api.get.mock.calls.every((call) => call[1].timeout <= 15_000)).toBe(true);
});

test.each([
  { code: 'ECONNABORTED' }, { code: 'ERR_NETWORK' },
  ...[502, 503, 504, 524].map(status => ({ response: { status } })),
])('only a temporary status-read failure is retried: %j', async error => {
  const api = fixture(); api.get.mockRejectedValueOnce(error).mockResolvedValueOnce(completed());
  const result = runPredictionJob(api, request); await flush();
  jest.advanceTimersByTime(PREDICTION_JOB_POLL_INTERVAL_MS); await flush();
  expect(await result).toBe(prediction); expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.post).toHaveBeenCalledTimes(1);
});

test.each([{ code: 'ECONNABORTED' }, { response: { status: 524 } }])('job creation is never retried: %j', async error => {
  const api = fixture(); api.post.mockRejectedValueOnce(error);
  await expect(runPredictionJob(api, request)).rejects.toBe(error);
  expect(api.post).toHaveBeenCalledTimes(1); expect(api.get).not.toHaveBeenCalled();
});

test('a busy A job is an explicit failure, without starting another calculation', async () => {
  const api = fixture(); api.post.mockRejectedValueOnce({ response: { status: 409 } });
  await expect(runPredictionJob(api, request)).rejects.toThrow('Un’altra analisi');
  expect(api.post).toHaveBeenCalledTimes(1); expect(api.get).not.toHaveBeenCalled();
});

test('a lost job after a restart stops polling and never silently restarts A', async () => {
  const api = fixture(); api.get.mockRejectedValueOnce({ response: { status: 404 } });
  await expect(runPredictionJob(api, request)).rejects.toThrow('interrotta');
  jest.advanceTimersByTime(60_000); await flush();
  expect(api.post).toHaveBeenCalledTimes(1); expect(api.get).toHaveBeenCalledTimes(1);
});

test('a failed calculation with original HTTP503 is terminal, unlike a temporary GET503', async () => {
  const api = fixture(), original = { success: false, error: 'Original model error' };
  api.get.mockResolvedValueOnce(envelope('FAILED', { response: original, responseStatus: 503 }));
  const failure = await runPredictionJob(api, request).catch(error => error);
  expect(failure.message).not.toContain(original.error);
  expect(failure.response).toEqual({ status: 503, data: original });
  expect(api.post).toHaveBeenCalledTimes(1); expect(api.get).toHaveBeenCalledTimes(1);
});

test('an authentication error while reading is not retried', async () => {
  const api = fixture(), error = { response: { status: 401 } }; api.get.mockRejectedValueOnce(error);
  await expect(runPredictionJob(api, request)).rejects.toBe(error);
  expect(api.get).toHaveBeenCalledTimes(1); expect(api.post).toHaveBeenCalledTimes(1);
});

test('abort while waiting clears the timer and stops reads without a second POST', async () => {
  const api = fixture(), controller = new AbortController(); api.get.mockResolvedValue(envelope('RUNNING'));
  const result = runPredictionJob(api, request, { signal: controller.signal }).catch(error => error);
  await flush(); expect(jest.getTimerCount()).toBe(1); controller.abort();
  expect((await result).name).toBe('AbortError'); expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(60_000); await flush();
  expect(api.get).toHaveBeenCalledTimes(1); expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post.mock.calls[0][2].signal).toBe(controller.signal);
  expect(api.get.mock.calls[0][1].signal).toBe(controller.signal);
});

test('abort is propagated to an active read and the result cannot be applied late', async () => {
  const api = fixture(), controller = new AbortController();
  api.get.mockImplementationOnce((_url, config) => new Promise((_resolve, reject) => {
    config.signal.addEventListener('abort', () => reject({ code: 'ERR_CANCELED' }), { once: true });
  }));
  const result = runPredictionJob(api, request, { signal: controller.signal }).catch(error => error);
  await flush(); controller.abort();
  expect((await result).name).toBe('AbortError');
  expect(api.get).toHaveBeenCalledTimes(1); expect(api.post).toHaveBeenCalledTimes(1);
});

test('a late read from a transport ignoring abort is discarded', async () => {
  const api = fixture(), controller = new AbortController(); let release: (value: unknown) => void;
  api.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const result = runPredictionJob(api, request, { signal: controller.signal }).catch(error => error);
  await flush(); controller.abort(); release!(completed());
  expect((await result).name).toBe('AbortError'); expect(api.get).toHaveBeenCalledTimes(1);
});

test('an already aborted view never starts A', async () => {
  const api = fixture(), controller = new AbortController(); controller.abort();
  await expect(runPredictionJob(api, request, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(api.post).not.toHaveBeenCalled(); expect(api.get).not.toHaveBeenCalled();
});

test.each([
  { success: true, data: { id: 'another-job', status: 'COMPLETED', response: prediction } },
  { success: true, data: { id: JOB_ID, status: 'UNKNOWN' } },
  { success: true, data: { id: JOB_ID, status: 'COMPLETED' } },
  { success: true, data: { id: JOB_ID, status: 'COMPLETED', response: { success: true } } },
  { success: true, data: { id: JOB_ID, status: 'COMPLETED', response: prediction, responseStatus: 503 } },
  { success: true, data: { id: JOB_ID, status: 'FAILED', response: prediction, responseStatus: 503 } },
])('an unrelated or malformed result is rejected: %j', async payload => {
  const api = fixture(); api.get.mockResolvedValueOnce({ data: payload });
  await expect(runPredictionJob(api, request)).rejects.toThrow('completare l’analisi');
  expect(api.post).toHaveBeenCalledTimes(1); expect(api.get).toHaveBeenCalledTimes(1);
});

test('a malformed creation identifier is never used as a URL', async () => {
  const api = fixture(); api.post.mockResolvedValueOnce({ data: { success: true, data: { id: '../auth', status: 'RUNNING' } } });
  await expect(runPredictionJob(api, request)).rejects.toThrow('completare l’analisi');
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).toHaveBeenCalledTimes(1);
});

test('the complete polling wait is bounded, without resubmitting A', async () => {
  const api = fixture(); api.get.mockResolvedValue(envelope('RUNNING'));
  const result = runPredictionJob(api, request).catch(error => error); await flush();
  for (let i = 0; i < PREDICTION_JOB_MAX_WAIT_MS / PREDICTION_JOB_POLL_INTERVAL_MS; i++) {
    jest.advanceTimersByTime(PREDICTION_JOB_POLL_INTERVAL_MS); await flush();
  }
  expect((await result).message).toContain('troppo tempo');
  expect(api.post).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});
