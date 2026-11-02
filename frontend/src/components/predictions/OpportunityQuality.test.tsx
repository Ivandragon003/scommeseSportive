import { render, screen } from '@testing-library/react';
import OpportunityQuality from './OpportunityQuality';
test('shows the actual confidence and EV without inventing missing diagnostics', () => {
  const view = render(<OpportunityQuality opportunity={{confidence:'LOW',expectedValue:7.2,marketTier:'SPECULATIVE'}} />);
  expect(screen.getByText('LOW · Bassa')).toBeTruthy(); expect(screen.getByText('+7.20%')).toBeTruthy(); expect(screen.getByText('Speculativa')).toBeTruthy();
  view.rerender(<OpportunityQuality opportunity={{}} />);
  expect(screen.getAllByText('Non disponibile')).toHaveLength(2);
});
