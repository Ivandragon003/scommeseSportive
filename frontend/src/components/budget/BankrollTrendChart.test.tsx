import { fireEvent, render, screen } from '@testing-library/react';
import BankrollTrendChart from './BankrollTrendChart';

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-07T12:00:00Z')));
afterEach(() => jest.restoreAllMocks());

test('gli ultimi sette giorni partono da oggi, senza riproporre movimenti vecchi', () => {
  render(<BankrollTrendChart initialBudget={1000} settledBets={[
    { profit: 20, placed_at: '2026-08-15T12:00:00Z' },
  ]} />);
  fireEvent.click(screen.getByRole('button', { name: '7G' }));
  expect(screen.getByTestId('bankroll-trend-chart').getAttribute('aria-label')).toContain('EUR 1020.00 a EUR 1020.00, 0 movimenti');
  expect(screen.getByRole('status').textContent).toContain('Nessuna giocata conclusa');
  fireEvent.click(screen.getByRole('button', { name: '30G' }));
  expect(screen.getByTestId('bankroll-trend-chart').getAttribute('aria-label')).toContain('EUR 1000.00 a EUR 1020.00, 1 movimenti');
});

test('una giocata entra nel grafico alla chiusura e le date mancanti non diventano 1970', () => {
  render(<BankrollTrendChart initialBudget={1000} settledBets={[
    { profit: 20, placed_at: '2026-08-01T12:00:00Z', settled_at: '2026-09-06T12:00:00Z' },
    { profit: 999, placed_at: null },
  ]} />);
  fireEvent.click(screen.getByRole('button', { name: '7G' }));
  expect(screen.getByTestId('bankroll-trend-chart').getAttribute('aria-label')).toContain('EUR 1000.00 a EUR 1020.00, 1 movimenti');
});
