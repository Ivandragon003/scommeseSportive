import { render, screen } from '@testing-library/react';
import SavedModelOpportunities from './SavedModelOpportunities';
import { getManualModelOpportunities } from '../../utils/modelBetActionsApi';

jest.mock('../../utils/modelBetActionsApi');
const get = getManualModelOpportunities as jest.MockedFunction<typeof getManualModelOpportunities>;
beforeEach(() => jest.resetAllMocks());

test('saved-only archives respect model and period without pretending they are funded bets', async () => {
  get.mockResolvedValue([
    { id: 'a', family: 'A', matchId: 'm1', selection: 'over25', classification: 'LOW', createdAt: '2026-11-02T10:00:00Z', snapshot: { matchLabel: 'Casa A – Ospite A', quote: { odds: 2.1, bookmaker: 'Bookmaker reale' } } },
    { id: 'c', family: 'C', matchId: 'm2', selection: 'under25', classification: 'SPECULATIVE', createdAt: '2026-11-02T10:00:00Z', snapshot: { matchLabel: 'Casa C – Ospite C', quote: { odds: 2.4, bookmaker: 'Bookmaker reale C' } } },
    { id: 'old', family: 'C', matchId: 'old', selection: 'under25', classification: 'LOW', createdAt: '2026-10-01T10:00:00Z', snapshot: {} },
  ]);
  render(<SavedModelOpportunities family="C" from="2026-11-01T00:00:00Z" />);
  expect(await screen.findByText('Casa C – Ospite C')).toBeTruthy();
  expect(screen.queryByText('Casa A – Ospite A')).toBeNull();
  expect(screen.queryByText('old')).toBeNull();
  expect(screen.getByText(/nessun capitale è impegnato/)).toBeTruthy();
});

test('failed archive reads remain explicit instead of showing a fabricated empty history', async () => {
  get.mockRejectedValue(new Error('offline'));
  render(<SavedModelOpportunities />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('Nessuna opportunità archiviata nei filtri scelti.')).toBeNull();
});
