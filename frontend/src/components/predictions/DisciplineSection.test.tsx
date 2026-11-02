import { render, screen, within } from '@testing-library/react';
import DisciplineSection from './DisciplineSection';

test('restores the actual foul, yellow and red estimates supplied by the prediction', () => {
  render(<DisciplineSection prediction={{homeTeam:'Inter',awayTeam:'Milan',
    foulsPrediction:{totalFouls:{expected:24.6},homeFouls:{expected:12.4},awayFouls:{expected:12.2}},
    cardsPrediction:{totalYellow:{expected:4.5},homeYellow:{expected:2.1},awayYellow:{expected:2.4},totalRed:{expected:0.18,probAtLeastOne:0.16}}}} />);
  const fouls = within(screen.getByRole('article',{name:'Previsione falli'}));
  expect(fouls.getByText('24.60')).toBeTruthy(); expect(fouls.getByText('12.40')).toBeTruthy();
  expect(within(screen.getByRole('article',{name:'Previsione cartellini gialli'})).getByText('4.50')).toBeTruthy();
  const reds = within(screen.getByRole('article',{name:'Previsione cartellini rossi'}));
  expect(reds.getByText('0.18')).toBeTruthy(); expect(reds.getByText('16.0%')).toBeTruthy();
});

test('missing or invalid discipline values are unavailable, never zero-filled observations', () => {
  render(<DisciplineSection prediction={{cardsPrediction:{totalRed:{expected:-1,probAtLeastOne:2}},foulsPrediction:null}} />);
  expect(screen.getAllByText('Non disponibile')).toHaveLength(7);
  expect(screen.queryByText('0.00')).toBeNull(); expect(screen.queryByText('Almeno un rosso')).toBeNull();
});
