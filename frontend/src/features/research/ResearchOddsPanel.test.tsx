import { act, fireEvent, render, screen, within } from '@testing-library/react';
import ResearchOddsPanel from './ResearchOddsPanel';
import { getResearchOddsStatus } from '../../utils/researchApi';
import { ResearchOddsForecast, ResearchOddsProvider, ResearchOddsStatus } from './researchOddsTypes';
import emptyNightlyForecast from './__fixtures__/nightly-odds-forecast-empty.json';
import calendarNightlyForecast from './__fixtures__/nightly-odds-forecast-calendar.json';

jest.mock('../../utils/researchApi');
const mockedStatus = getResearchOddsStatus as jest.MockedFunction<typeof getResearchOddsStatus>;
const status = (): ResearchOddsStatus => ({
  observedAt: '2026-10-27T09:00:00Z', month: '2026-10', resetAt: '2026-11-01T00:00:00Z',
  providers: [], usage: [], events: [], plannedForecast: null, limitations: [],
  cache: { window: 'last_90_days', hits: 0, fetchReservations: 0, hitRate: null },
  configuredProviders: [{ provider: 'odds_api', accountScope: 'primary', configured: false, status: 'NOT_CONFIGURED', note: 'Nessuna verifica esterna eseguita.' }],
  fallback: { status: 'UNAVAILABLE', provider: null, reason: 'Nessun fallback gratuito autorizzato configurato.' },
});
const provider = (): ResearchOddsProvider => ({
  provider: 'odds_api', accountScope: 'primary', status: 'UNOBSERVED', monthlyLimit: 500, reserveCredits: 50,
  resetConfirmed: false, planningVerified: false, observedUsed: null, observedRemaining: null, observedAt: null,
  plannedCredits: 0, chargedCredits: 0, reservedCredits: 0, measuredCredits: 0, unknownChargedCredits: 0,
  availableCredits: 450, requests: 0, failures: 0, lastFetch: null, plannedForecast: null,
});

beforeEach(() => jest.resetAllMocks());

test('il caricamento non presume credito o consumo effettivo', () => {
  mockedStatus.mockReturnValue(new Promise(() => undefined));
  render(<ResearchOddsPanel />);
  expect(screen.getByRole('status').textContent).toContain('Caricamento dello stato');
  expect(screen.queryByText('500')).toBeNull();
  expect(mockedStatus).toHaveBeenCalledTimes(1);
});

test('500 pianificati e 450 disponibili internamente non diventano residui osservati', async () => {
  const payload = status(); payload.providers = [provider()];
  mockedStatus.mockResolvedValue(payload);
  render(<ResearchOddsPanel />);
  const card = await screen.findByRole('article', { name: 'Contabilità The Odds API · primary' });
  expect(within(card).getByRole('definition', { name: 'Limite mensile di pianificazione' }).textContent).toBe('500');
  expect(within(card).getByRole('definition', { name: 'Disponibile per pianificare' }).textContent).toBe('450');
  expect(within(card).getByRole('definition', { name: 'Residui osservati dal provider' }).textContent).toBe('—');
  expect(within(card).getByRole('definition', { name: 'Usati osservati dal provider' }).textContent).toBe('—');
  expect(screen.getByText('Bookmaker osservati non documentati in questo stato.')).toBeTruthy();
  expect(screen.queryByText('Eurobet')).toBeNull();
  expect(screen.getByText('Non configurato')).toBeTruthy();
  expect(screen.getByText(/Nessun fallback gratuito autorizzato configurato/)).toBeTruthy();
});

test('zero misurato resta distinto da assenza di misura e i metadati non inventano operatori', async () => {
  const payload = status(); payload.providers = [{ ...provider(), observedUsed: 0, observedRemaining: 0,
    observedAt: '2026-10-27T08:59:00Z', actualBookmakers: ['Bookmaker osservato'], actualMarkets: ['h2h'] }];
  mockedStatus.mockResolvedValue(payload);
  render(<ResearchOddsPanel />);
  const card = await screen.findByRole('article', { name: 'Contabilità The Odds API · primary' });
  expect(within(card).getByRole('definition', { name: 'Residui osservati dal provider' }).textContent).toBe('0');
  expect(within(card).getByRole('definition', { name: 'Usati osservati dal provider' }).textContent).toBe('0');
  expect(screen.getByText('Bookmaker osservato')).toBeTruthy();
  expect(screen.queryByText('Eurobet')).toBeNull();
});

test('il tasso cache usa la misura ammessa e non include i rifiuti nel denominatore', async () => {
  const payload = status(); payload.cache = { window: 'last_90_days', hits: 3, fetchReservations: 1, hitRate: .75 };
  payload.events = [{ provider: 'odds_api', accountScope: 'primary', type: 'DENIED', reason: 'odds_credit_budget_exhausted', count: 100, lastAt: payload.observedAt }];
  mockedStatus.mockResolvedValue(payload);
  render(<ResearchOddsPanel />);
  expect(await screen.findByText('75%')).toBeTruthy();
  expect(screen.getByText(/4 in totale/)).toBeTruthy();
  expect(screen.getByText('Budget prudenziale di crediti insufficiente.')).toBeTruthy();
});

test('consumi numerosi sono paginati e il costo del gruppo mercati non viene diviso', async () => {
  const payload = status();
  payload.usage = Array.from({ length: 25 }, (_, index) => ({ provider: 'odds_api', accountScope: 'primary',
    endpoint: `/events/${index}/odds`, operation: `function-${index}`, markets: ['h2h', 'totals'],
    requests: 1, plannedCredits: 2, chargedCredits: 2, measuredCredits: 2 }));
  mockedStatus.mockResolvedValue(payload);
  render(<ResearchOddsPanel />);
  const table = await screen.findByRole('table', { name: 'Richieste registrate per funzione e insieme di mercati' });
  expect(within(table).getAllByRole('row')).toHaveLength(21);
  expect(within(table).getByText('function-0')).toBeTruthy();
  expect(within(table).queryByText('function-20')).toBeNull();
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Pagine dei consumi API' })).getByRole('button', { name: 'Successivi' }));
  expect(within(table).getAllByRole('row')).toHaveLength(6);
  expect(within(table).getByText('function-20')).toBeTruthy();
  expect(within(table).getAllByText('h2h, totals')).toHaveLength(5);
});

// Fixtures generated offline by the real backend forecastRemainingNightlyOddsDemand
// at 2026-10-29T14:20:00Z, then wrapped exactly like /research/odds-status.
test('il nuovo payload nightly mostra gruppi per lega/finestra, crediti base e retry', async () => {
  const payload = status(); payload.plannedForecast = calendarNightlyForecast as ResearchOddsForecast;
  payload.providers = [provider()];
  mockedStatus.mockResolvedValue(payload);
  render(<ResearchOddsPanel />);
  await screen.findByText(/Stima sul calendario disponibile: incompleto/);
  expect(screen.getByRole('definition', { name: 'Gruppi campionato / finestra nightly' }).textContent).toBe('2');
  expect(screen.getByRole('definition', { name: 'Crediti base senza retry' }).textContent).toBe('6');
  expect(screen.getByRole('definition', { name: 'Crediti aggiuntivi ipotizzati per retry' }).textContent).toBe('3');
  expect(screen.getByRole('definition', { name: 'Crediti stimati per le nightly restanti' }).textContent).toBe('9');
  expect(screen.getByRole('definition', { name: 'Richieste HTTP stimate' }).textContent).toBe('3');
  expect(screen.getByRole('definition', { name: 'Orario locale ipotizzato' }).textContent).toBe('03:00');
  expect(screen.getByRole('definition', { name: 'Finestra delle partite' }).textContent).toBe('Fino alla prossima nightly prevista');
  expect(screen.getByRole('definition', { name: 'Quota misurata associata alla proiezione' }).textContent).toBe('—');
  expect(screen.getByRole('definition', { name: 'Residui osservati dal provider' }).textContent).toBe('—');
  expect(screen.getByRole('definition', { name: 'Prossima soglia di pianificazione · UTC' }).textContent).toContain('00:00 UTC');
  expect(screen.getByText(/il fuso e l’istante del reset del provider non sono garantiti/)).toBeTruthy();
  expect(screen.queryByText('Gruppi campionato / orario')).toBeNull();
  expect(screen.queryByText('Finestra cache ipotizzata (secondi)')).toBeNull();
});

test('calendario vuoto del vero builder rende zero numerico senza inventare quote osservate', async () => {
  const payload = status(); payload.plannedForecast = emptyNightlyForecast as ResearchOddsForecast;
  mockedStatus.mockResolvedValue(payload);
  render(<ResearchOddsPanel />);
  await screen.findByText(/Stima sul calendario disponibile: incompleto/);
  for (const name of ['Gruppi campionato / finestra nightly', 'Partite considerate nella stima',
    'Crediti stimati per le nightly restanti', 'Crediti base senza retry', 'Crediti aggiuntivi ipotizzati per retry', 'Richieste HTTP stimate']) {
    expect(screen.getByRole('definition', { name }).textContent).toBe('0');
  }
  const essential = within(screen.getByRole('article', { name: 'Scenario essenziale nightly' }));
  expect(essential.getByRole('definition', { name: 'Gruppi nightly ammessi' }).textContent).toBe('0');
  expect(essential.getByRole('definition', { name: 'Gruppi nightly esclusi' }).textContent).toBe('0');
  expect(screen.getByRole('definition', { name: 'Quota misurata associata alla proiezione' }).textContent).toBe('—');
  expect(screen.getByRole('definition', { name: 'Limite ordinario di pianificazione' }).textContent).toBe('450');
  expect(screen.getByRole('definition', { name: 'Limite essenziale di pianificazione' }).textContent).toBe('500');
  expect(screen.getByText(/Il saldo del provider resta sconosciuto/)).toBeTruthy();
  expect(screen.queryByText('Eurobet')).toBeNull();
});

test('gruppi mancanti restano ignoti senza recuperare il vecchio campo per kickoff', async () => {
  const payload = status(); payload.plannedForecast = { ...emptyNightlyForecast, competitionNightlyGroups: undefined,
    competitionKickoffGroups: 99 } as ResearchOddsForecast;
  mockedStatus.mockResolvedValue(payload);
  render(<ResearchOddsPanel />);
  await screen.findByText(/Stima sul calendario disponibile: incompleto/);
  expect(screen.getByRole('definition', { name: 'Gruppi campionato / finestra nightly' }).textContent).toBe('—');
  expect(screen.queryByText('99')).toBeNull();
});

test('una proiezione del vecchio protocollo non viene presentata come domanda nightly', async () => {
  const payload = status(); payload.plannedForecast = { ...emptyNightlyForecast, mode: undefined,
    scope: 'remaining_decision_targets_in_current_utc_month', competitionKickoffGroups: 99 } as unknown as ResearchOddsForecast;
  mockedStatus.mockResolvedValue(payload);
  render(<ResearchOddsPanel />);
  expect(await screen.findByText(/Il formato ricevuto non descrive le finestre della nuova nightly/)).toBeTruthy();
  expect(screen.queryByText('99')).toBeNull();
  expect(screen.queryByText('Gruppi campionato / finestra nightly')).toBeNull();
});

test('l’errore non diventa uno stato vuoto e un aggiornamento fallito preserva le misure precedenti', async () => {
  mockedStatus.mockRejectedValueOnce(new Error('Database non disponibile'));
  render(<ResearchOddsPanel />);
  expect((await screen.findByRole('alert')).textContent).toContain('Database non disponibile');
  expect(screen.queryByText('0')).toBeNull();
  mockedStatus.mockResolvedValueOnce(status());
  fireEvent.click(screen.getByRole('button', { name: 'Aggiorna stato quote' }));
  await screen.findByText('2026-10');
  expect(screen.getByText('Bookmaker e mercati osservati non documentati in questo stato.')).toBeTruthy();
  mockedStatus.mockRejectedValueOnce(new Error('Aggiornamento fallito'));
  fireEvent.click(screen.getByRole('button', { name: 'Aggiorna stato quote' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Restano visibili i dati letti');
  expect(screen.getByText('2026-10')).toBeTruthy();
});

test('la vista non esegue polling e annulla la richiesta quando viene chiusa', async () => {
  mockedStatus.mockResolvedValueOnce(status());
  const { unmount } = render(<ResearchOddsPanel />);
  await screen.findByText('2026-10');
  jest.useFakeTimers();
  try { act(() => jest.advanceTimersByTime(60000)); expect(mockedStatus).toHaveBeenCalledTimes(1); }
  finally { jest.useRealTimers(); }
  const signal = mockedStatus.mock.calls[0][0];
  unmount();
  expect(signal?.aborted).toBe(true);
});

test('un recupero di calendario non viene mostrato come aggiornamento quote', async () => {
  const payload = status();
  payload.providers = [{ ...provider(), lastFetch: '2026-10-27T08:59:00Z', actualCoverageAsOf: null, carryoverCredits: 7 }];
  payload.configuredProviders = [{ provider: 'odds_api', accountScope: 'primary', configured: true,
    status: 'CONFIGURED_NOT_PROBED', note: 'Presenza delle credenziali, disponibilità non verificata.' }];
  mockedStatus.mockResolvedValue(payload);
  render(<ResearchOddsPanel />);
  await screen.findByRole('article', { name: 'Contabilità The Odds API · primary' });
  expect(screen.getByText(/Ultimo recupero del provider:/)).toBeTruthy();
  expect(screen.getByText(/Nessuna osservazione quote/)).toBeTruthy();
  expect(screen.queryByText(/Ultimo aggiornamento quote/)).toBeNull();
  expect(screen.getByText('Configurato, verifica non eseguita')).toBeTruthy();
  expect(screen.getByRole('definition', { name: 'Crediti impegnati da richieste precedenti' }).textContent).toBe('7');
});
