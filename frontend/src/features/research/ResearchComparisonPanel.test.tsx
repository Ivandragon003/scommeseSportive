import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ResearchComparisonPanel from './ResearchComparisonPanel';
import { getResearchComparison } from '../../utils/researchApi';
import { ResearchComparison } from './researchComparisonTypes';

jest.mock('../../utils/researchApi');
jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null, Legend: () => null, Line: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));
const request = getResearchComparison as jest.MockedFunction<typeof getResearchComparison>;
const comparison = (): ResearchComparison => ({
  period: { key: '30d', from: '2026-10-01T22:00:00Z', to: '2026-10-30T02:00:00Z', timezone: 'Europe/Rome', label: 'Ultimi 30 giorni' },
  portfolios: [
    { family: 'A', portfolioId: 'shadow_A', initialized: true, startEquityCents: 100000, endEquityCents: 99000,
      profitCents: -1000, roi: -.1, stakeCents: 12000, settledStakeCents: 10000, betCount: 600, settledCount: 10,
      wonCount: 4, lostCount: 6, voidCount: 0, maxDrawdown: .08, equity: [{ at: '2026-10-01T22:00:00Z', equityCents: 100000 }, { at: '2026-10-29T02:00:00Z', equityCents: 99000 }] },
    { family: 'C', portfolioId: 'shadow_C', initialized: true, startEquityCents: 100000, endEquityCents: 100900,
      profitCents: 900, roi: .09, stakeCents: 11000, settledStakeCents: 10000, betCount: 11, settledCount: 10,
      wonCount: 6, lostCount: 4, voidCount: 0, maxDrawdown: .02, equity: [{ at: '2026-10-01T22:00:00Z', equityCents: 100000 }, { at: '2026-10-29T02:00:00Z', equityCents: 100900 }] },
  ], leader: 'C',
  byLeague: [{ label: 'Serie A', A: { profitCents: -1000, roi: -.1 }, C: { profitCents: 900, roi: .09 } }],
  byMarket: [{ label: '1x2', A: { profitCents: -1000 }, C: { profitCents: 900 } }],
  decisionDifferences: { comparedCount: 12, differentCount: 8, total: 8, truncated: true, incompleteCount: 2, rows: [{
    matchId: 'fixture1', matchLabel: 'Squadra Uno – Squadra Due', league: 'Serie A', at: '2026-10-29T02:00:00Z',
    A: { action: 'BET', selection: 'homeWin', market: '1x2', quote: { odds: 1.9, bookmaker: 'Bookmaker A', source: 'odds_api' } },
    C: { action: 'ABSTAIN', reason: 'central_ev_below_threshold' },
  }] },
  bets: { total: 611, truncated: true, rows: [{ id: 'bet1', family: 'A', portfolioId: 'shadow_A', matchId: 'fixture1',
    matchLabel: 'Squadra Uno – Squadra Due', league: 'Serie A', modelVersion: 'A-recorded', market: '1x2', selection: 'homeWin',
    stakeCents: 1000, odds: 1.9, status: 'LOST', profitCents: -1000, createdAt: '2026-10-29T02:00:00Z',
    quote: { bookmaker: 'Bookmaker A', source: 'odds_api', capturedAt: '2026-10-29T01:59:00Z' } }] },
});

beforeEach(() => { jest.resetAllMocks(); request.mockResolvedValue(comparison()); });

test('metriche complete dal backend e leader economico distinto dalla qualità statistica', async () => {
  render(<ResearchComparisonPanel />);
  await screen.findByText('Maggiore profitto virtuale nel periodo: modello C.');
  const a = within(screen.getByRole('article', { name: 'Risultati periodo A' }));
  const c = within(screen.getByRole('article', { name: 'Risultati periodo C' }));
  expect(a.getByRole('definition', { name: 'Puntate registrate' }).textContent).toBe('600');
  expect(a.getByRole('definition', { name: 'ROI sulle puntate liquidate' }).textContent).toBe('-10%');
  expect(a.getByRole('definition', { name: 'Drawdown massimo nel periodo' }).textContent).toBe('8%');
  expect(c.getByRole('definition', { name: 'Profitto / perdita nel periodo' }).textContent).toMatch(/9,00\s€/);
  expect(screen.getByText(/non dimostra superiorità statistica/)).toBeTruthy();
  expect(screen.getByText(/liquidazioni avvenute nel periodo, anche per puntate precedenti/)).toBeTruthy();
  expect(screen.getByText(/Le metriche e i raggruppamenti includono tutte le puntate/)).toBeTruthy();
  expect(screen.getByRole('figure', { name: 'Evoluzione del capitale nel periodo' })).toBeTruthy();
  expect(screen.queryByText(/2\.?009,00\s€/)).toBeNull();
});

test('elenca quote reali e differenze, senza trasformare una decisione mancante in astensione', async () => {
  render(<ResearchComparisonPanel />);
  await screen.findByText(/8 decisioni differenti su 12/);
  expect(screen.getByText(/2 confronti incompleti/)).toBeTruthy();
  expect(screen.getByText('Nessuna puntata')).toBeTruthy();
  expect(screen.getByText('Quota 1,9 · Bookmaker A')).toBeTruthy();
  expect(screen.getAllByText('Fonte: odds_api')).toHaveLength(2);
  expect(screen.getByText(/Quota del/)).toBeTruthy();
  expect(screen.getByText('Risultati per campionato')).toBeTruthy();
  expect(screen.getByText('Risultati per mercato')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Portafoglio'), { target: { value: 'C' } });
  expect(screen.getByText(/Nessuna puntata di questo portafoglio nelle righe caricate/)).toBeTruthy();
});

test('tutti i periodi predefiniti richiedono aggregati al backend, senza filtrare un elenco troncato', async () => {
  render(<ResearchComparisonPanel />);
  await screen.findByText(/Maggiore profitto virtuale/);
  expect(request.mock.calls[0][0]).toEqual({ period: '30d' });
  for (const period of ['7d', '60d', '90d', 'all', '30d']) {
    fireEvent.change(screen.getByLabelText('Periodo'), { target: { value: period } });
    await waitFor(() => expect(request.mock.calls[request.mock.calls.length - 1][0]).toEqual({ period }));
  }
});

test('periodo personalizzato valida le date e invia date locali inclusive senza conversioni UTC client', async () => {
  render(<ResearchComparisonPanel />);
  await screen.findByText(/Maggiore profitto virtuale/);
  fireEvent.change(screen.getByLabelText('Periodo'), { target: { value: 'custom' } });
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('Dal'), { target: { value: '2026-10-25' } });
  fireEvent.change(screen.getByLabelText('Al'), { target: { value: '2026-10-24' } });
  fireEvent.click(screen.getByRole('button', { name: 'Applica periodo' }));
  expect(screen.getByRole('alert').textContent).toMatch(/Scegli due date valide/);
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('Al'), { target: { value: '2026-10-25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Applica periodo' }));
  await waitFor(() => expect(request.mock.calls[1][0]).toEqual({ period: 'custom', from: '2026-10-25', to: '2026-10-25' }));
  expect(screen.getByText(/Entrambe le date sono incluse/)).toBeTruthy();
});

test('un errore di caricamento non mostra saldi o leader inventati e permette il retry', async () => {
  request.mockRejectedValueOnce(new Error('Periodo non disponibile'));
  render(<ResearchComparisonPanel />);
  expect((await screen.findByRole('alert')).textContent).toMatch(/Periodo non disponibile/);
  expect(screen.queryByRole('article')).toBeNull();
  expect(screen.queryByText(/Maggiore profitto/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Riprova rendimenti' }));
  expect(await screen.findByText(/Maggiore profitto virtuale/)).toBeTruthy();
});

test('risposte tardive di un filtro annullato non sostituiscono il periodo corrente', async () => {
  let resolveOld: (data: ResearchComparison) => void = () => undefined;
  request.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  render(<ResearchComparisonPanel />);
  fireEvent.change(screen.getByLabelText('Periodo'), { target: { value: '7d' } });
  await screen.findByText(/Maggiore profitto virtuale nel periodo: modello C/);
  expect(request.mock.calls[0][1]?.aborted).toBe(true);
  await act(async () => { resolveOld({ ...comparison(), leader: 'A' }); });
  expect(screen.queryByText(/Maggiore profitto virtuale nel periodo: modello A/)).toBeNull();
});

test('mancanza di liquidazioni non diventa ROI zero, una sola apertura non inventa una curva', async () => {
  const data = comparison(); data.leader = 'TIE';
  data.portfolios = data.portfolios.map((portfolio) => ({ ...portfolio, roi: null, profitCents: 0, settledCount: 0,
    equity: [{ at: '2026-10-29T02:00:00Z', equityCents: 100000 }] }));
  request.mockResolvedValue(data);
  render(<ResearchComparisonPanel />);
  await screen.findByText(/stesso profitto virtuale/);
  const a = within(screen.getByRole('article', { name: 'Risultati periodo A' }));
  expect(a.getByRole('definition', { name: 'ROI sulle puntate liquidate' }).textContent).toBe('—');
  expect(screen.queryByRole('figure')).toBeNull();
});

test('storico quote non viene rietichettato come nightly e un esito futuro resta aperto nel periodo', async () => {
  const data = comparison();
  data.bets.rows[0] = { ...data.bets.rows[0], status: 'PENDING', profitCents: null, settledAt: null,
    quote: { ...data.bets.rows[0].quote, priceType: 't15' } };
  data.decisionDifferences.rows = [];
  data.decisionDifferences.differentCount = 0;
  request.mockResolvedValue(data);
  render(<ResearchComparisonPanel />);
  await screen.findByText('Protocollo storico T−15');
  expect(screen.getByText('Aperta a fine periodo')).toBeTruthy();
  expect(screen.getByText('Nessuna differenza fra le decisioni confrontabili del periodo.')).toBeTruthy();
  expect(screen.queryByText('Quota prepartita')).toBeNull();
});
