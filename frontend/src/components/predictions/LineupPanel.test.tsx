import { act, render, screen } from '@testing-library/react';
import LineupPanel from './LineupPanel';

const mockGetPlayerAvailability = jest.fn();

jest.mock('../../utils/api', () => ({
  getPlayerAvailability: (...args: unknown[]) => mockGetPlayerAvailability(...args),
  PLAYER_AVAILABILITY_UPDATED_EVENT: 'player-availability-updated',
}));

const response = (name: string, confirmed: boolean) => ({
  data: {
    home: [{
      playerId: `home-${name}`, name, teamName: 'Casa', probability: confirmed ? 1 : 0.8,
      tier: confirmed ? 'confirmed_starter' : 'probable_starter',
      status: confirmed ? 'confirmed_starter' : 'predicted_starter', source: confirmed ? 'api_football_confirmed' : 'last_five_lineup_model',
    }],
    away: [],
    hasConfirmedLineup: confirmed,
    hasProviderData: confirmed,
    homeHistoryMatchesUsed: 5,
    awayHistoryMatchesUsed: 5,
    note: 'Nota formazione',
  },
});

test('ricarica il pannello quando il refresh della stessa partita termina', async () => {
  mockGetPlayerAvailability
    .mockResolvedValueOnce(response('Titolare stimato', false))
    .mockResolvedValueOnce(response('Titolare ufficiale', true));
  render(<LineupPanel matchId="match-42" />);

  await screen.findByText('Titolare stimato');
  act(() => {
    window.dispatchEvent(new CustomEvent('player-availability-updated', {
      detail: { matchId: 'match-42' },
    }));
  });

  await screen.findByText('Titolare ufficiale');
  expect(await screen.findByText('Ufficiale')).toBeTruthy();
  expect(mockGetPlayerAvailability).toHaveBeenCalledTimes(2);
});
