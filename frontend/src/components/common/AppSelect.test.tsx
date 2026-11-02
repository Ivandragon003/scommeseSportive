import { fireEvent, render, screen } from '@testing-library/react';
import { AppDateInput, AppSelect } from './AppSelect';
test('styled picker supports keyboard selection and Escape', () => {
  const changed = jest.fn();
  render(<AppSelect aria-label="Esito" value="" onChange={changed} options={[{value:'',label:'Tutti'}, {value:'WON',label:'Vinte'}]} />);
  const control = screen.getByRole('combobox', {name:'Esito'});
  fireEvent.keyDown(control, {key:'ArrowDown'});
  expect(screen.getByRole('listbox')).toBeTruthy();
  fireEvent.keyDown(control, {key:'End'}); fireEvent.keyDown(control, {key:'Enter'});
  expect(changed).toHaveBeenCalledWith('WON'); expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.click(control); fireEvent.keyDown(control, {key:'Escape'});
  expect(screen.queryByRole('listbox')).toBeNull();
});
test('popup supports touch/click selection and outside dismissal', () => {
  const changed = jest.fn();
  render(<AppSelect aria-label="Modello" value="A" onChange={changed} options={[{value:'A',label:'Modello A'}, {value:'C',label:'Modello C'}]} />);
  fireEvent.click(screen.getByRole('combobox')); fireEvent.click(screen.getByRole('option', {name:'Modello C'}));
  expect(changed).toHaveBeenCalledWith('C');
  fireEvent.click(screen.getByRole('combobox')); fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('listbox')).toBeNull();
});
test('date controls retain native calendar constraints', () => {
  render(<AppDateInput aria-label="Dal" min="2026-01-01" />);
  const date = screen.getByLabelText('Dal') as HTMLInputElement;
  expect(date.type).toBe('date'); fireEvent.change(date, {target:{value:'2026-09-07'}});
  expect(date.value).toBe('2026-09-07'); expect(date.min).toBe('2026-01-01');
});
