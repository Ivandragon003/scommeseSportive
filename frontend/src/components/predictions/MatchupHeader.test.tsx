import { render, screen, within } from '@testing-library/react';
import MatchupHeader from './MatchupHeader';

test('displays stored attack and defence under the correct team, never inventing missing strength', () => {
  render(<MatchupHeader match={{ home_team_id: 'home', away_team_id: 'away', home_team_name: 'Inter', away_team_name: 'Milan' }}
    prediction={null} teams={[{ team_id: 'home', attack_strength: 1.12, defence_strength: 0.91 }]}
    meta="Serie A" onRefresh={() => undefined} loading={false} />);
  expect(within(screen.getByLabelText('Forza Inter')).getByText('1.12')).toBeTruthy();
  expect(within(screen.getByLabelText('Forza Inter')).getByText('0.91')).toBeTruthy();
  expect(within(screen.getByLabelText('Forza Milan')).getAllByText('—')).toHaveLength(2);
  expect(screen.getByRole('heading', { level: 1, name: 'Inter vs Milan' })).toBeTruthy();
});
