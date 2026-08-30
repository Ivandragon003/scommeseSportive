import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

  test('sessione condivisa usa richieste credentialed e invalida la cache al login', async () => {
    const { getAdminSession, loginSharedAdmin, logoutSharedAdmin } = await import('./api');
    mockGet.mockResolvedValueOnce({
      data: { success: true, data: { authenticated: true, sharedDataUserId: 'user1' } },
    });
    mockPost
      .mockResolvedValueOnce({ data: { success: true, data: { authenticated: true, sharedDataUserId: 'user1' } } })
      .mockResolvedValueOnce({ data: undefined });

    await getAdminSession();
    await loginSharedAdmin('shared password');
    await logoutSharedAdmin();

    expect(mockGet).toHaveBeenCalledWith('/auth/session');
    expect(mockPost).toHaveBeenNthCalledWith(1, '/auth/login', { password: 'shared password' });
    expect(mockPost).toHaveBeenNthCalledWith(2, '/auth/logout');
  });

  test('sincronizza le giocate condivise tramite un endpoint di mutazione esplicito', async () => {
    const { syncSharedBets } = await import('./api');
    mockPost.mockResolvedValueOnce({ data: { success: true, data: { settled: 1 } } });

    const result = await syncSharedBets();

    expect(mockPost).toHaveBeenCalledWith('/bets/sync');
    expect(result).toEqual({ success: true, data: { settled: 1 } });
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

  test('syncUpcomingKickoffs usa endpoint calendario e invalida cache upcoming', async () => {
    const { getUpcomingMatches, invalidateApiCache, syncUpcomingKickoffs } = await import('./api');
    invalidateApiCache();
    mockGet
      .mockResolvedValueOnce({ data: { success: true, data: [{ match_id: 'first' }] } })
      .mockResolvedValueOnce({ data: { success: true, data: [{ match_id: 'second' }] } });
    mockPost.mockResolvedValueOnce({ data: { success: true, data: { corrected: 1 } } });

    await getUpcomingMatches({ competition: 'Serie A' });
    await syncUpcomingKickoffs({ mode: 'top5', season: '2025/2026', limit: 160 });
    await getUpcomingMatches({ competition: 'Serie A' });

    expect(mockPost).toHaveBeenCalledWith(
      '/system/sync-upcoming-kickoffs',
      expect.objectContaining({ mode: 'top5', season: '2025/2026', limit: 160 }),
      expect.objectContaining({ timeout: 120000 })
    );
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  test('refreshPlayerAvailability notifica i pannelli della stessa partita dopo il refresh', async () => {
    const { PLAYER_AVAILABILITY_UPDATED_EVENT, refreshPlayerAvailability } = await import('./api');
    const received: string[] = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent<{ matchId: string }>).detail.matchId);
    };
    window.addEventListener(PLAYER_AVAILABILITY_UPDATED_EVENT, listener);
    mockPost.mockResolvedValueOnce({ data: { success: true, saved: 22 } });

    try {
      await refreshPlayerAvailability('match-42');
      expect(received).toEqual(['match-42']);
    } finally {
      window.removeEventListener(PLAYER_AVAILABILITY_UPDATED_EVENT, listener);
    }
  });

  test('runFootballDataSync usa il contratto supplementare frontend-only', async () => {
    const { runFootballDataSync } = await import('./api');
    mockPost.mockResolvedValueOnce({
      data: { success: true, sync: { matchesUpdated: 12 }, prune: {}, teamsUpdated: 4 },
    });

    await runFootballDataSync({
      competitions: ['Serie A'],
      recomputeAverages: true,
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/scraper/football-data',
      {
        competitions: ['Serie A'],
        recomputeAverages: true,
      },
      expect.objectContaining({ timeout: 3600000 })
    );
  });

  test('runUnderstatImport non consente al client di cambiare la finestra quinquennale', async () => {
    const { runUnderstatImport } = await import('./api');
    mockPost.mockResolvedValueOnce({ data: { success: true } });

    await runUnderstatImport({ yearsBack: 1, seasons: ['2025/2026'] });

    expect(mockPost).toHaveBeenCalledWith(
      '/scraper/understat',
      expect.objectContaining({ yearsBack: 5, seasons: undefined }),
      expect.objectContaining({ timeout: 3600000 })
    );
  });

  test('getPredictionArchive inoltra i filtri supportati all endpoint read-only', async () => {
    const { getPredictionArchive } = await import('./api');
    mockGet.mockResolvedValueOnce({ data: { success: true, data: [] } });

    await getPredictionArchive({ status: 'unplayed', matchId: 'match-42', limit: 50 });

    expect(mockGet).toHaveBeenCalledWith('/predictions/archive', {
      params: { status: 'unplayed', matchId: 'match-42', limit: 50 },
    });
  });

  test('budget e giocate riusano una cache breve e la sync esplicita la invalida', async () => {
    const { getBudget, getBets, invalidateApiCache, syncSharedBets } = await import('./api');
    invalidateApiCache();
    mockGet.mockResolvedValue({ data: { success: true, data: [] } });
    mockPost.mockResolvedValueOnce({ data: { success: true, data: { settled: 0 } } });

    await getBudget('user1');
    await getBudget('user1');
    await getBets('user1');
    await getBets('user1');
    expect(mockGet).toHaveBeenCalledTimes(2);

    await syncSharedBets();
    await getBudget('user1');
    await getBets('user1');
    expect(mockGet).toHaveBeenCalledTimes(4);
  });

  test('response cache resta bounded, elimina scaduti su una chiave diversa e mantiene invalidate', async () => {
    const { RESPONSE_CACHE_MAX_ENTRIES, getApiResponseCacheStats, getTeams, invalidateApiCache } = await import('./api');
    invalidateApiCache();
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockGet.mockImplementation(() => Promise.resolve({ data: { success: true, data: [] } }));

    for (let index = 0; index < RESPONSE_CACHE_MAX_ENTRIES; index += 1) {
      await getTeams(`competition-${index}`, { cacheMs: 50 });
    }
    expect(getApiResponseCacheStats().responseEntries).toBe(RESPONSE_CACHE_MAX_ENTRIES);
    expect(mockGet).toHaveBeenCalledTimes(RESPONSE_CACHE_MAX_ENTRIES);

    await getTeams('competition-0', { cacheMs: 50 });
    expect(getApiResponseCacheStats().responseEntries).toBe(RESPONSE_CACHE_MAX_ENTRIES);
    expect(mockGet).toHaveBeenCalledTimes(RESPONSE_CACHE_MAX_ENTRIES);

    await getTeams(`competition-${RESPONSE_CACHE_MAX_ENTRIES}`, { cacheMs: 50 });
    expect(getApiResponseCacheStats().responseEntries).toBe(RESPONSE_CACHE_MAX_ENTRIES);
    expect(mockGet).toHaveBeenCalledTimes(RESPONSE_CACHE_MAX_ENTRIES + 1);

    now += 51;
    await getTeams('competition-after-expiry', { cacheMs: 50 });
    expect(getApiResponseCacheStats().responseEntries).toBe(1);

    invalidateApiCache((key) => key.includes('competition-after-expiry'));
    expect(getApiResponseCacheStats().responseEntries).toBe(0);
  });

  test('la cache nginx per asset hashati include bundle main e lazy chunk CRA', () => {
    const nginxConfig = readFileSync(resolve(__dirname, '../../nginx.conf'), 'utf8');
    const locationLine = nginxConfig.split(/\r?\n/).find((line) => line.includes('location ~*'));
    const quotedPattern = locationLine?.match(/location ~\* "([^"]+)"/i)?.[1];
    expect(quotedPattern).toBeTruthy();

    const assetPattern = new RegExp(quotedPattern!, 'i');
    expect(assetPattern.test('main.4a1c24c9.js')).toBe(true);
    expect(assetPattern.test('main.4a1c24c9.css')).toBe(true);
    expect(assetPattern.test('797.b23acff4.chunk.js')).toBe(true);
    expect(assetPattern.test('797.b23acff4.chunk.css')).toBe(true);
  });
});
