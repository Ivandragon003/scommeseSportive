import { act, renderHook, waitFor } from '@testing-library/react';
import { usePredictionAnalysis } from './usePredictionAnalysis';
import { useOddsForMatch } from './useOddsForMatch';

jest.mock('./useOddsForMatch');
const mockedOdds = useOddsForMatch as jest.MockedFunction<typeof useOddsForMatch>;

const matchA = { match_id: 'a', home_team_id: 'home-a', away_team_id: 'away-a', date: '2099-01-01T12:00:00Z', home_goals: null, away_goals: null };
const matchB = { ...matchA, match_id: 'b', home_team_id: 'home-b', away_team_id: 'away-b' };
const resultFor = (matchId: string) => ({ finalPred: { matchId, valueOpportunities: [] }, appliedOdds: { over25: '2.10' },
  bookmakerBySelection: { over25: 'Bookmaker' }, analysisBookmakers: ['Bookmaker'], marketsRequested: [], oddsMsg: 'Quote reali disponibili', oddsTone: 'success' as const });

test('returning to cached A clears the pending B loading state and ignores its late result', async () => {
  const fetchPredictionWithOdds = jest.fn();
  let resolveB!: (value: ReturnType<typeof resultFor>) => void;
  const pendingB = new Promise<ReturnType<typeof resultFor>>(resolve => { resolveB = resolve; });
  fetchPredictionWithOdds.mockResolvedValueOnce(resultFor('a')).mockReturnValueOnce(pendingB);
  mockedOdds.mockReturnValue({ fetchPredictionWithOdds });
  const params = { budget: null, competition: 'Serie A', matchMode: 'upcoming' as const, teams: [],
    setActiveMatchId: jest.fn(), setTab: jest.fn(), beforeAnalyze: jest.fn(async () => undefined) };
  const { result } = renderHook(() => usePredictionAnalysis(params));
  await act(async () => { await result.current.handleAnalyze(matchA); });
  expect(result.current.pred.matchId).toBe('a');
  expect(result.current.loading).toBe(false);
  act(() => { void result.current.handleAnalyze(matchB); });
  await waitFor(() => expect(fetchPredictionWithOdds).toHaveBeenCalledTimes(2));
  expect(result.current.loading).toBe(true);
  expect(result.current.loadingMatchId).toBe('b');
  const signalB = fetchPredictionWithOdds.mock.calls[1][0].signal as AbortSignal;
  await act(async () => { await result.current.handleAnalyze(matchA); });
  expect(signalB.aborted).toBe(true);
  expect(result.current.pred.matchId).toBe('a');
  expect(result.current.loading).toBe(false);
  expect(result.current.loadingMatchId).toBeNull();
  expect(fetchPredictionWithOdds).toHaveBeenCalledTimes(2);
  await act(async () => { resolveB(resultFor('b')); await pendingB; });
  expect(result.current.pred.matchId).toBe('a');
  expect(result.current.loading).toBe(false);
  expect(result.current.loadingMatchId).toBeNull();
  expect(fetchPredictionWithOdds).toHaveBeenCalledTimes(2);
});
