import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import AppCalendarInput from './AppCalendarInput';

test('calendar selects an actual day across month navigation and closes with focus restored', () => {
  function Field() {
    const [value, setValue] = useState('2026-11-03');
    return <label>Data iniziale<AppCalendarInput value={value} onChange={event => setValue(event.target.value)} /></label>;
  }
  render(<Field />);
  const input = screen.getByLabelText('Data iniziale') as HTMLInputElement;
  const focus = jest.spyOn(input, 'focus');
  fireEvent.click(input);
  fireEvent.click(screen.getByRole('button', { name: 'Mese successivo' }));
  fireEvent.click(screen.getByRole('button', { name: '12 dicembre 2026' }));
  expect(input.value).toBe('2026-12-12');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(focus).toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
