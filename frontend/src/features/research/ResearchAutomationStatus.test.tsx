import { render, screen, within } from '@testing-library/react';
import ResearchAutomationStatus from './ResearchAutomationStatus';
import { ResearchOverview } from './researchTypes';

const status = (): ResearchOverview['status'] => ({
  nightlyCreatesBets: false, legacyAutomationDisabled: true, schedulerEnabled: false,
  toleranceSeconds: 60, blockers: [], deployment: 'not_verified',
  automationScope: 'local_code', remoteVerification: 'not_verified_from_backend',
});

const valueFor = (label: string) => within(screen.getByRole('definition', { name: label }));

test('flag locali sicuri non certificano la disattivazione della nightly GitHub pubblicata', () => {
  render(<ResearchAutomationStatus status={status()} />);
  expect(screen.getByText('Codice e processo corrente')).toBeTruthy();
  expect(screen.getByText('Non verificata dal backend')).toBeTruthy();
  expect(valueFor('Nightly crea nuove puntate · codice corrente').getByText('No')).toBeTruthy();
  expect(valueFor('Vecchio percorso disabilitato · codice corrente').getByText('Sì')).toBeTruthy();
  expect(screen.getByText(/servono il workflow pubblicato e i log delle esecuzioni su GitHub/)).toBeTruthy();
});

test('ultimo import e nightly completa restano osservazioni distinte', () => {
  render(<ResearchAutomationStatus status={{ ...status(), lastDataUpdateAt: '2026-10-27T03:00:00Z', lastNightlyAt: null }} />);
  expect(valueFor('Ultima nightly completa riuscita').getByText('Non disponibile')).toBeTruthy();
  expect(valueFor('Ultimo aggiornamento dei dati').queryByText('Non disponibile')).toBeNull();
});

test('il worker condiviso distingue attività, segnale scaduto e stato sconosciuto', () => {
  const { rerender } = render(<ResearchAutomationStatus status={{ ...status(), schedulerEnabled: true, schedulerState: 'ACTIVE' }} />);
  expect(valueFor('Scheduler T−15 · stato condiviso').getByText('Attivo')).toBeTruthy();
  rerender(<ResearchAutomationStatus status={{ ...status(), schedulerEnabled: false, schedulerState: 'STALE' }} />);
  expect(valueFor('Scheduler T−15 · stato condiviso').getByText('Segnale scaduto')).toBeTruthy();
  rerender(<ResearchAutomationStatus status={{ ...status(), schedulerEnabled: null, schedulerState: 'UNKNOWN' }} />);
  expect(valueFor('Scheduler T−15 · stato condiviso').getByText('Non verificato')).toBeTruthy();
});

test('quota API non misurata resta mancante e uno zero osservato rimane zero', () => {
  const { rerender } = render(<ResearchAutomationStatus status={{ ...status(), apiQuota: null }} />);
  expect(valueFor('Crediti residui osservati').getByText('—')).toBeTruthy();
  expect(valueFor('Crediti usati osservati').getByText('—')).toBeTruthy();
  rerender(<ResearchAutomationStatus status={{ ...status(), apiQuota: { remaining: 0, used: 500, lastCost: 2, observedAt: '2026-10-27T09:00:00Z' } }} />);
  expect(valueFor('Crediti residui osservati').getByText('0')).toBeTruthy();
  expect(valueFor('Crediti usati osservati').getByText('500')).toBeTruthy();
  expect(valueFor('Costo dell’ultima richiesta').getByText('2')).toBeTruthy();
});
