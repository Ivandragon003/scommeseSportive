import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { useScrapersStatus } from './useScrapersStatus';

const mockGetOddsSnapshotStatus = jest.fn();
const mockGetProviderHealth = jest.fn();
const mockGetSystemHealth = jest.fn();
const mockGetUnderstatScraperInfo = jest.fn();

jest.mock('../utils/api', () => ({
  getOddsSnapshotStatus: (...args: unknown[]) => mockGetOddsSnapshotStatus(...args),
  getProviderHealth: (...args: unknown[]) => mockGetProviderHealth(...args),
  getSystemHealth: (...args: unknown[]) => mockGetSystemHealth(...args),
  getUnderstatScraperInfo: (...args: unknown[]) => mockGetUnderstatScraperInfo(...args),
}));

function StatusProbe() {
  useScrapersStatus();
  return null;
}

describe('useScrapersStatus polling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    mockGetOddsSnapshotStatus.mockReset().mockResolvedValue({ data: {} });
    mockGetProviderHealth.mockReset().mockResolvedValue({ data: {} });
    mockGetSystemHealth.mockReset().mockResolvedValue({
      data: { isUpdating: false, schedulers: {}, providers: {}, metrics: {} },
    });
    mockGetUnderstatScraperInfo.mockReset().mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('visibilitychange durante un refresh mantiene una sola catena timer', async () => {
    render(createElement(StatusProbe));
    await act(async () => { await Promise.resolve(); });
    expect(mockGetSystemHealth).toHaveBeenCalledTimes(1);

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await Promise.resolve(); });
    expect(mockGetSystemHealth).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(59_000);
      await Promise.resolve();
    });
    expect(mockGetSystemHealth).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(mockGetSystemHealth).toHaveBeenCalledTimes(3);
  });
});
