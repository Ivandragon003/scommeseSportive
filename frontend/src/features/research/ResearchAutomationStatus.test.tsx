import { render, screen, within } from '@testing-library/react';
import ResearchAutomationStatus from './ResearchAutomationStatus';
import { ResearchOverview } from './researchTypes';

const status = (): ResearchOverview['status'] => ({
  mode: 'NIGHTLY_PRE_MATCH', nightlyCreatesBets: false, legacyAutomationDisabled: true,
  schedulerEnabled: false, schedulerState: 'NOT_OBSERVED', toleranceSeconds: null,
  blockers: [], deployment: 'not_verified', nightly: { lastRun: null, overdue: false },
});
const valueFor = (label: string) => within(screen.getByRole('definition', { name: label }));

test('configurazione web distinta dalla registrazione del job, senza requisito worker', () => {
  render(<ResearchAutomationStatus status={{ ...status(), nightlyCreatesBets: true, schedulerEnabled: true }} />);
  expect(screen.getByText('Nightly Pre-Match Virtual Betting')).toBeTruthy();
  expect(valueFor('Abilitazione dichiarata dal backend web').getByText('Sì')).toBeTruthy();
  expect(valueFor('Registrazioni abilitate nell’ultimo job osservato').getByText('Non verificato')).toBeTruthy();
  expect(screen.getByText(/non certifica i secret o il workflow pubblicato su GitHub/)).toBeTruthy();
  expect(screen.queryByText(/heartbeat|Scheduler T−15|stato del worker/i)).toBeNull();
});

test('ultimo import, manutenzione completa e elaborazione virtuale sono osservazioni distinte', () => {
  render(<ResearchAutomationStatus status={{ ...status(), lastDataUpdateAt: '2026-10-27T03:00:00Z', lastNightlyAt: null,
    nightly: { lastRun: { startedAt: '2026-10-27T02:00:00Z', endedAt: '2026-10-27T02:10:00Z', success: true, summary: { enabled: true } } } }} />);
  expect(valueFor('Ultima nightly manutenzione completa riuscita').getByText('Non disponibile')).toBeTruthy();
  expect(valueFor('Ultimo aggiornamento dei dati').queryByText('Non disponibile')).toBeNull();
  expect(valueFor('Ultima elaborazione virtuale terminata').queryByText('Non disponibile')).toBeNull();
  expect(valueFor('Registrazioni abilitate nell’ultimo job osservato').getByText('Sì')).toBeTruthy();
});

test('metriche nightly mancanti restano distinte da zero osservato', () => {
  const { rerender } = render(<ResearchAutomationStatus status={status()} />);
  expect(valueFor('Partite analizzate').getByText('—')).toBeTruthy();
  rerender(<ResearchAutomationStatus status={{ ...status(), schedulerState: 'SUCCESS', nightly: {
    lastRun: { success: true }, metrics: { analyzedMatches: 4, registeredBets: 0, skippedMatches: 4, errors: 0, settlement: { checked: 2, settled: 1, unresolved: 1 } },
  } }} />);
  expect(valueFor('Stato nightly osservato').getByText('Riuscita')).toBeTruthy();
  expect(valueFor('Partite analizzate').getByText('4')).toBeTruthy();
  expect(valueFor('Puntate virtuali registrate').getByText('0')).toBeTruthy();
  expect(valueFor('Liquidazioni ancora in attesa').getByText('1')).toBeTruthy();
});

test('mancata nightly viene segnalata senza confonderla con il worker dismesso', () => {
  render(<ResearchAutomationStatus status={{ ...status(), schedulerState: 'MISSED', nightly: {
    expectedAt: '2026-10-27T02:00:00Z', nextAt: '2026-10-28T02:00:00Z', overdue: true,
  } }} />);
  expect(screen.getByRole('heading', { name: 'Nightly attesa non osservata' })).toBeTruthy();
  expect(valueFor('Stato nightly osservato').getByText('Esecuzione attesa mancante')).toBeTruthy();
  expect(screen.queryByText(/heartbeat|worker/i)).toBeNull();
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
