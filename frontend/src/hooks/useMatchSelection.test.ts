import { act, renderHook, waitFor } from '@testing-library/react';
import { getRecentMatches, getTeams, getUpcomingMatches } from '../utils/api';
import { useMatchSelection } from './useMatchSelection';

jest.mock('../utils/api');
const upcoming = getUpcomingMatches as jest.MockedFunction<typeof getUpcomingMatches>;
const recent = getRecentMatches as jest.MockedFunction<typeof getRecentMatches>;
const teams = getTeams as jest.MockedFunction<typeof getTeams>;
const now = Date.parse('2026-11-01T19:00:00Z');
const fixture = (id: string, date: string, extra = {}) => ({ match_id: id, date, home_goals: null, away_goals: null, ...extra });

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  window.history.replaceState(null, '', '/predictions');
  teams.mockResolvedValue({ data: [] } as any);
  recent.mockResolvedValue({ data: [] } as any);
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('upcoming excludes past, kickoff boundary, results and invalid dates even in a stale response', async () => {
  upcoming.mockResolvedValue({ data: [
    fixture('past', '2026-11-01T14:00:00Z'), fixture('boundary', '2026-11-01T19:00:00Z'),
    fixture('future', '2026-11-01T20:00:00Z'), fixture('utc-naive', '2026-11-01 20:00:00'),
    fixture('played', '2026-11-01T20:00:00Z', { home_goals: 0, away_goals: 0 }),
    fixture('partial-score', '2026-11-01T20:00:00Z', { home_goals: 1 }), fixture('invalid', 'unknown'),
  ] } as any);
  const { result } = renderHook(useMatchSelection);
  await waitFor(() => expect(result.current.upcoming).toHaveLength(7));
  expect(result.current.visibleMatches.map((row) => row.match_id)).toEqual(['future', 'utc-naive']);
  expect(upcoming).toHaveBeenCalledWith(expect.objectContaining({ includeStartedWithoutResult: false }));
});

test('a match disappears after kickoff while the page stays open without requesting providers again', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(now);
  upcoming.mockResolvedValue({ data: [fixture('soon', '2026-11-01T19:00:10Z')] } as any);
  const { result } = renderHook(useMatchSelection);
  await act(async () => { await Promise.resolve(); });
  expect(result.current.visibleMatches).toHaveLength(1);
  act(() => { jest.advanceTimersByTime(30_000); });
  expect(result.current.visibleMatches).toHaveLength(0);
  expect(upcoming).toHaveBeenCalledTimes(1);
});

test.each(['focus', 'visibilitychange'])('returning through %s removes elapsed fixtures immediately', async (event) => {
  upcoming.mockResolvedValue({ data: [fixture('soon', '2026-11-01T19:00:10Z')] } as any);
  const { result } = renderHook(useMatchSelection);
  await waitFor(() => expect(result.current.visibleMatches).toHaveLength(1));
  jest.spyOn(Date, 'now').mockReturnValue(now + 20_000);
  act(() => { (event === 'focus' ? window : document).dispatchEvent(new Event(event)); });
  expect(result.current.visibleMatches).toHaveLength(0);
  expect(upcoming).toHaveBeenCalledTimes(1);
});

test('completed view still requires the real final score', async () => {
  window.history.replaceState(null, '', '/predictions?mode=recent');
  recent.mockResolvedValue({ data: [fixture('missing', '2026-11-01T14:00:00Z'),
    fixture('final', '2026-11-01T14:00:00Z', { home_goals: 0, away_goals: 0 })] } as any);
  const { result } = renderHook(useMatchSelection);
  await waitFor(() => expect(result.current.visibleMatches).toHaveLength(1));
  expect(result.current.visibleMatches[0].match_id).toBe('final');
  expect(upcoming).not.toHaveBeenCalled();
});
