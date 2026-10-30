import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import API from '../../utils/api';
import WalletBetEvidence, { loadWalletBetEvidence } from './WalletBetEvidence';
import { ComparisonBet } from '../research/researchComparisonTypes';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));

const mockedGet = API.get as jest.Mock;
const bet: ComparisonBet = {
  id: 'funded-c', family: 'C', portfolioId: 'shadow_C', modelVersion: 'C-pinned', matchId: 'match-1',
  matchLabel: 'Home – Away', market: 'totals', selection: 'under25', odds: 2.9, stakeCents: 1000,
  status: 'PENDING', createdAt: '2026-10-30T14:17:00Z',
  quote: { bookmaker: 'Betsson', source: 'odds_api', capturedAt: '2026-10-30T14:16:00Z' },
};
const cDecision = {
  id: 'execution-c', betId: 'funded-c', matchId: 'match-1', family: 'C', action: 'BET',
  modelVersion: 'C-pinned', selection: 'under25', confidence: null,
  recommendationPacket: { model: { version: 'C-pinned' }, selected: { selection: 'under25' } },
};
const aDecision = {
  id: 'execution-a', betId: 'funded-a', matchId: 'match-1', family: 'A', action: 'BET',
  modelVersion: 'APP-A', selection: 'homeWin', confidence: 'HIGH',
  recommendationPacket: { model: { version: 'APP-A' }, selected: { selection: 'homeWin' } },
};
const response = (decisions: unknown[]) => ({ data: { success: true, data: { matchId: 'match-1', decisions } } });

describe('WalletBetEvidence', () => {
  beforeEach(() => { jest.clearAllMocks(); mockedGet.mockResolvedValue(response([aDecision, cDecision])); });

  test('selects the recorded C packet for a funded C bet, never A replay or an invented classification', async () => {
    render(<WalletBetEvidence bet={bet} onClose={jest.fn()} />);
    expect(await screen.findByText('C-pinned')).toBeTruthy();
    expect(screen.getByText('Non registrata')).toBeTruthy();
    expect(screen.queryByText('High')).toBeNull();
    expect(screen.queryByText('APP-A')).toBeNull();
    expect(mockedGet).toHaveBeenCalledWith('/research/forecasts', { params: { matchId: 'match-1' }, signal: expect.anything() });
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(API.post).not.toHaveBeenCalled();
  });

  test('does not substitute the A packet when the matching C record is unavailable', async () => {
    mockedGet.mockResolvedValueOnce(response([aDecision]));
    render(<WalletBetEvidence bet={bet} onClose={jest.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('modello C non è disponibile');
    expect(screen.queryByText('APP-A')).toBeNull();
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(API.post).not.toHaveBeenCalled();
  });

  test('rejects another funded bet or a mismatched packet for the same match and family', async () => {
    mockedGet.mockResolvedValueOnce(response([{ ...cDecision, betId: 'another-bet' }]));
    await expect(loadWalletBetEvidence(bet)).rejects.toThrow('non è disponibile');
    mockedGet.mockResolvedValueOnce(response([{ ...cDecision, recommendationPacket: { model: { version: 'APP-A' }, selected: { selection: 'under25' } } }]));
    await expect(loadWalletBetEvidence(bet)).rejects.toThrow('non è disponibile');
  });

  test('accepts the compact recorded C packet without inventing an A-style model descriptor', async () => {
    mockedGet.mockResolvedValueOnce(response([{ ...cDecision, recommendationPacket: { selected: { selection: 'under25' }, ranked: [] } }]));
    const decision = await loadWalletBetEvidence(bet);
    expect(decision.family).toBe('C');
    expect(decision.modelVersion).toBe('C-pinned');
    expect(decision.recommendationPacket?.model).toBeUndefined();
  });

  test('shows the recorded half-loss return, not zero', async () => {
    render(<WalletBetEvidence bet={{ ...bet, status: 'HALF_LOST', profitCents: -500 }} onClose={jest.fn()} />);
    expect(await screen.findByText('C-pinned')).toBeTruthy();
    expect(screen.getByText('Mezza perdita')).toBeTruthy();
    expect(screen.getByText(/^5,00\s€$/)).toBeTruthy();
    expect(screen.getByText(/^-5,00\s€$/)).toBeTruthy();
  });

  test('moves keyboard focus to the opened evidence and restores it when closed', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Apri evidenza</button>
        {open && <WalletBetEvidence bet={bet} onClose={() => setOpen(false)} />}</>;
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Apri evidenza' });
    const focused = jest.fn();
    document.addEventListener('focusin', focused);
    try {
      trigger.focus();
      fireEvent.click(trigger);
      expect(await screen.findByText('C-pinned')).toBeTruthy();
      expect(focused).toHaveBeenLastCalledWith(expect.objectContaining({ target: screen.getByRole('region', { name: 'Pronostico registrato modello C' }) }));
      fireEvent.click(screen.getByRole('button', { name: 'Chiudi pronostico' }));
      expect(focused).toHaveBeenLastCalledWith(expect.objectContaining({ target: trigger }));
    } finally {
      document.removeEventListener('focusin', focused);
    }
  });
});
