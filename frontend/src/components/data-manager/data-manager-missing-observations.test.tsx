import { render, screen } from '@testing-library/react';
import DataManagerPageView from './DataManagerPageView';
import { getStatsOverview, getTeams } from '../../utils/api';

jest.mock('../../utils/api');

test('league summaries distinguish missing averages from measured zero', async () => {
  (getTeams as jest.Mock).mockResolvedValue({ data: [] });
  (getStatsOverview as jest.Mock).mockResolvedValue({ data: {
    leagues: [
      { competition: 'Missing league', matches: 1, avgGoals: null, avgTotalCards: null, avgTotalShots: null, xgCoveragePct: null },
      { competition: 'Zero league', matches: 1, avgGoals: 0, avgTotalCards: 0, avgTotalShots: 0, xgCoveragePct: 0 },
    ],
  } });
  render(<DataManagerPageView />);
  await screen.findByText('Missing league');
  expect(screen.getByText('Zero league')).toBeTruthy();
  for (const label of ['Gol medi', 'Cartellini medi', 'Tiri medi']) {
    expect(screen.getByText((_, element) => element?.textContent === `${label}-`)).toBeTruthy();
    expect(screen.getByText((_, element) => element?.textContent === `${label}0.00`)).toBeTruthy();
  }
  expect(screen.getByText((_, element) => element?.textContent === 'Copertura xG-')).toBeTruthy();
  expect(screen.getByText((_, element) => element?.textContent === 'Copertura xG0.0%')).toBeTruthy();
});
