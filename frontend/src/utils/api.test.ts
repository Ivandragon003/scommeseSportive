const mockPost = jest.fn();
const mockGet = jest.fn();
const mockDelete = jest.fn();

export {};

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      get: mockGet,
      post: mockPost,
      delete: mockDelete,
    })),
    isAxiosError: (value: unknown) => Boolean((value as { isAxiosError?: boolean })?.isAxiosError),
  },
}));

describe('backtesting API timeout', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    mockDelete.mockReset();
  });

  test('runWalkForwardBacktest usa timeout lungo dedicato', async () => {
    const { LONG_BACKTEST_TIMEOUT_MS, runWalkForwardBacktest } = await import('./api');
    mockPost.mockResolvedValueOnce({ data: { success: true, data: { kind: 'walk_forward' } } });

    await runWalkForwardBacktest({ competition: 'TOP_5', maxFolds: 10 });

    expect(mockPost).toHaveBeenCalledWith(
      '/backtest/walk-forward',
      expect.objectContaining({ competition: 'TOP_5', maxFolds: 10 }),
      expect.objectContaining({ timeout: LONG_BACKTEST_TIMEOUT_MS })
    );
    expect(LONG_BACKTEST_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  test('runWalkForwardBacktest rende leggibile un timeout Axios', async () => {
    const { WALK_FORWARD_TIMEOUT_MESSAGE, runWalkForwardBacktest } = await import('./api');
    mockPost.mockRejectedValueOnce({
      isAxiosError: true,
      code: 'ECONNABORTED',
      message: 'timeout of 30000ms exceeded',
    });

    await expect(runWalkForwardBacktest({ competition: 'TOP_5' }))
      .rejects
      .toThrow(WALK_FORWARD_TIMEOUT_MESSAGE);
  });
});
