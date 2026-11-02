import { render, screen, waitFor } from '@testing-library/react';
import MatchQuoteRequest from './MatchQuoteRequest';
import { getOddsForMatch } from '../../utils/api';
jest.mock('../../utils/api');
const getOdds = getOddsForMatch as jest.MockedFunction<typeof getOddsForMatch>;
const match = { match_id: 'auto-m1', competition: 'Serie A', home_team_name: 'Inter', away_team_name: 'Milan', date: '2026-11-03T20:00:00Z' };
beforeEach(() => { jest.resetAllMocks(); });

test('the betting tab retrieves missing quotes once and recalculates without requiring a click', async () => {
  getOdds.mockResolvedValue({ data: { found: true, source: 'odds_api' } } as any);
  const refresh = jest.fn();
  const view = render(<MatchQuoteRequest match={match} onLoaded={refresh} ready={false} />);
  expect(getOdds).not.toHaveBeenCalled();
  view.rerender(<MatchQuoteRequest match={match} onLoaded={refresh} ready />);
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(getOdds).toHaveBeenCalledWith(expect.objectContaining({ matchId: 'auto-m1', cacheOnly: false, requestNetwork: true }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  view.unmount();
  render(<MatchQuoteRequest match={match} onLoaded={refresh} />);
  expect(getOdds).toHaveBeenCalledTimes(1);
});

test('valid saved quotes never request provider credits', () => {
  render(<MatchQuoteRequest match={{ ...match, match_id: 'saved' }} onLoaded={jest.fn()} hasQuotes />);
  expect(screen.getByRole('status').textContent).toContain('Quote reali disponibili');
  expect(getOdds).not.toHaveBeenCalled();
});

test('a failed automatic retrieval does not loop or create a recommendation', async () => {
  getOdds.mockResolvedValue({ data: { found: false, source: 'odds_unavailable' } } as any);
  const refresh = jest.fn();
  render(<MatchQuoteRequest match={{ ...match, match_id: 'unavailable' }} onLoaded={refresh} />);
  expect(await screen.findByText(/Quote non disponibili per questa partita/)).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
  expect(getOdds).toHaveBeenCalledTimes(1);
});
