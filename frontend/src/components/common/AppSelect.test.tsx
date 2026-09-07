import { fireEvent, render, screen } from '@testing-library/react';
import { AppDateInput, AppSelect } from './AppSelect';

test('i filtri usano controlli di sistema accessibili anche in WebView', () => {
  const changed = jest.fn();
  render(<>
    <AppSelect aria-label="Esito" value="" onChange={changed} options={[{ value: '', label: 'Tutti' }, { value: 'WON', label: 'Vinte' }]} />
    <AppDateInput aria-label="Dal" min="2026-01-01" />
  </>);
  fireEvent.change(screen.getByRole('combobox', { name: 'Esito' }), { target: { value: 'WON' } });
  expect(changed).toHaveBeenCalledWith('WON');
  const date = screen.getByLabelText('Dal') as HTMLInputElement;
  expect(date.type).toBe('date');
  fireEvent.change(date, { target: { value: '2026-09-07' } });
  expect(date.value).toBe('2026-09-07');
  expect(date.min).toBe('2026-01-01');
});
