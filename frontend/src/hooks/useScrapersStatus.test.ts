import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { useScrapersStatus } from './useScrapersStatus';

const mockGetOddsSnapshotStatus = jest.fn();
const mockGetProviderHealth = jest.fn();
const mockGetScraperStatus = jest.fn();
const mockGetSystemHealth = jest.fn();
const mockGetSystemMetrics = jest.fn();
const mockGetUnderstatScraperInfo = jest.fn();

jest.mock('../utils/api', () => ({
  getOddsSnapshotStatus: (...args: unknown[]) => mockGetOddsSnapshotStatus(...args),
  getProviderHealth: (...args: unknown[]) => mockGetProviderHealth(...args),
  getScraperStatus: (...args: unknown[]) => mockGetScraperStatus(...args),
  getSystemHealth: (...args: unknown[]) => mockGetSystemHealth(...args),
  getSystemMetrics: (...args: unknown[]) => mockGetSystemMetrics(...args),
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
    mockGetScraperStatus.mockReset().mockResolvedValue({ data: {} });
    mockGetSystemHealth.mockReset().mockResolvedValue({ data: {} });
    mockGetSystemMetrics.mockReset().mockResolvedValue({ data: {} });
    mockGetUnderstatScraperInfo.mockReset().mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('visibilitychange durante un refresh mantiene una sola catena timer', async () => {
    render(createElement(StatusProbe));
    await act(async () => { await Promise.resolve(); });
    expect(mockGetScraperStatus).toHaveBeenCalledTimes(1);

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await Promise.resolve(); });
    expect(mockGetScraperStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(mockGetScraperStatus).toHaveBeenCalledTimes(3);

    await act(async () => {
      jest.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(mockGetScraperStatus).toHaveBeenCalledTimes(4);
  });
});
