import { fireEvent, screen, within } from '@testing-library/react';
export function selectOption(control: HTMLElement, value: string) {
  if (control instanceof HTMLSelectElement) { fireEvent.change(control, { target: { value } }); return; }
  fireEvent.click(control);
  const option = within(screen.getByRole('listbox')).getAllByRole('option').find(item => item.getAttribute('data-value') === value);
  if (!option) throw new Error(`Option unavailable: ${value}`);
  fireEvent.click(option);
}
