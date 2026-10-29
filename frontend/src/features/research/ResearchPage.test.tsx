import { fireEvent, render, screen, within } from '@testing-library/react';
import ResearchPage from './ResearchPage';
import { getResearchComparison, getResearchOddsStatus, getResearchOverview } from '../../utils/researchApi';
import { ResearchOverview } from './researchTypes';
import { ResearchComparison } from './researchComparisonTypes';

jest.mock('../../utils/researchApi');
jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null, Legend: () => null, Line: () => null, Tooltip: () => null,
  XAxis: () => null, YAxis: () => null,
}));

const mockedComparison = getResearchComparison as jest.MockedFunction<typeof getResearchComparison>;
const emptyComparison = (): ResearchComparison => ({
  period: { key: '30d', from: '2026-10-01T00:00:00Z', to: '2026-10-30T00:00:00Z', timezone: 'Europe/Rome', label: 'Ultimi 30 giorni' },
  portfolios: [], leader: null, byLeague: [], byMarket: [],
  decisionDifferences: { comparedCount: 0, differentCount: 0, total: 0, truncated: false, rows: [] },
  bets: { total: 0, truncated: false, rows: [] },
});
const mockedOverview = getResearchOverview as jest.MockedFunction<typeof getResearchOverview>;
const mockedOddsStatus = getResearchOddsStatus as jest.MockedFunction<typeof getResearchOddsStatus>;
const emptyOverview = (): ResearchOverview => ({
  models: [], portfolios: [], bets: [], markets: [], jobs: [], latestBenchmark: null, notifications: [],
  status: {
    mode: 'NIGHTLY_PRE_MATCH', nightlyCreatesBets: false, legacyAutomationDisabled: true, schedulerEnabled: false, schedulerState: 'NOT_OBSERVED',
    toleranceSeconds: 60, blockers: ['Deployment remoto non verificato.'], deployment: 'not_verified',
  },
});

beforeEach(() => {
  jest.resetAllMocks();
  mockedComparison.mockResolvedValue(emptyComparison());
  mockedOddsStatus.mockResolvedValue({ observedAt: '2026-10-27T09:00:00Z', month: '2026-10', resetAt: '2026-11-01T00:00:00Z',
    providers: [], usage: [], events: [], plannedForecast: null, limitations: [] });
});

test('mostra il caricamento senza assumere saldi o benchmark', () => {
  mockedOverview.mockReturnValue(new Promise(() => undefined));
  render(<ResearchPage />);
  expect(screen.getByRole('status').textContent).toMatch(/Caricamento del confronto/);
  expect(screen.queryByText(/1\.?000,00\s€/)).toBeNull();
  expect(screen.queryByText('Nessun benchmark eseguito.')).toBeNull();
});

test('stato vuoto esplicito e navigazione accessibile nei sei pannelli', async () => {
  mockedOverview.mockResolvedValue(emptyOverview());
  render(<ResearchPage />);
  await screen.findByRole('heading', { name: 'Portafogli virtuali A e C' });
  expect(screen.getByRole('tab', { name: 'Portafogli' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Portafogli' }), { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Storico' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText('Nessun benchmark eseguito.')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Portafogli' }));
  expect(screen.getByText(/Portafogli non inizializzati/)).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Mercati' }));
  expect(screen.getByText(/Nessuna validazione di mercato registrata/)).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Esperimenti' }));
  expect(screen.getByText('Nessun esperimento di sviluppo registrato.')).toBeTruthy();
  expect(mockedOddsStatus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'API quote' }));
  expect(await screen.findByText('2026-10')).toBeTruthy();
  expect(mockedOddsStatus).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('tab', { name: 'Sistema' }));
  expect(screen.getByText('Deployment remoto non verificato.')).toBeTruthy();
  expect(within(screen.getByRole('definition', { name: 'Stato nightly osservato' }))
    .getByText('Non ancora osservata')).toBeTruthy();
  expect(screen.queryByText(/Scheduler T−15/)).toBeNull();
  expect(screen.getByText('No')).toBeTruthy();
});

test('il monitor quote resta consultabile se la panoramica A/C non è disponibile', async () => {
  mockedOverview.mockRejectedValue(new Error('Panoramica modelli non disponibile'));
  render(<ResearchPage />);
  await screen.findByRole('alert');
  expect(mockedOddsStatus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'API quote' }));
  expect(await screen.findByText('2026-10')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Stato API quote' })).toBeTruthy();
  expect(screen.queryByText('Panoramica modelli non disponibile')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Aggiorna confronto' })).toBeNull();
});

test('errore backend non diventa un risultato vuoto o una falsa disponibilità', async () => {
  mockedOverview.mockRejectedValue(new Error('Database non raggiungibile'));
  render(<ResearchPage />);
  expect((await screen.findByRole('alert')).textContent).toMatch(/Database non raggiungibile/);
  expect(screen.getByText(/Non è possibile mostrare saldi o metriche/)).toBeTruthy();
  expect(screen.queryByText('Nessun benchmark eseguito.')).toBeNull();
  mockedOverview.mockResolvedValue(emptyOverview());
  fireEvent.click(screen.getByRole('button', { name: 'Aggiorna confronto' }));
  expect(await screen.findByRole('heading', { name: 'Portafogli virtuali A e C' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('i portafogli A e C e le registrazioni restano indipendenti', async () => {
  const overview = emptyOverview();
  overview.portfolios = [
    { id: 'shadow_A', family: 'A', initialCents: 100000, availableCents: 99000, committedCents: 1000, equityCents: 100000, profitCents: 0, betCount: 1, settledCount: 0 },
    { id: 'shadow_C', family: 'C', initialCents: 100000, availableCents: 100900, committedCents: 0, equityCents: 100900, profitCents: 900, betCount: 1, settledCount: 1 },
  ];
  overview.bets = [
    { id: 'a1', portfolioId: 'shadow_A', matchId: 'fixture-A', modelVersion: 'A-frozen', selection: 'homeWin', stakeCents: 1000, odds: 1.9, status: 'PENDING', createdAt: '2026-10-27T19:30:00Z', quote: { bookmaker: 'Bookmaker A' } },
    { id: 'c1', portfolioId: 'shadow_C', matchId: 'fixture-C', modelVersion: 'C-real-catboost', selection: 'under25', stakeCents: 1000, odds: 1.9, status: 'WON', createdAt: '2026-10-27T19:30:00Z', profitCents: 900, quote: { bookmaker: 'Bookmaker C' } },
  ];
  mockedOverview.mockResolvedValue(overview);
  mockedComparison.mockResolvedValue({ ...emptyComparison(), bets: { total: overview.bets.length, truncated: false, rows: overview.bets }, portfolios: overview.portfolios.map((portfolio) => ({ family: portfolio.family, portfolioId: portfolio.id, equity: portfolio.history || [] })) });
  render(<ResearchPage />);
  await screen.findByRole('heading', { name: 'Portafogli virtuali A e C' });
  fireEvent.click(screen.getByRole('tab', { name: 'Portafogli' }));
  const portfolioA = screen.getByRole('article', { name: 'Portafoglio A' });
  const portfolioC = screen.getByRole('article', { name: 'Portafoglio C' });
  expect(within(portfolioA).getAllByText(/1\.?000,00\s€/).length).toBe(2);
  expect(within(portfolioA).getByText(/990,00\s€/)).toBeTruthy();
  expect(within(portfolioA).getByText(/10,00\s€/)).toBeTruthy();
  expect(within(portfolioC).getAllByText(/1\.?009,00\s€/).length).toBe(2);
  expect(screen.queryByText(/2\.?009,00\s€/)).toBeNull();
  fireEvent.change(await screen.findByLabelText('Portafoglio'), { target: { value: 'A' } });
  expect(await screen.findByText('fixture-A')).toBeTruthy();
  expect(screen.queryByText('fixture-C')).toBeNull();
  expect(screen.queryByRole('button', { name: /Punta|Registra giocata|Promuovi/i })).toBeNull();
});

test('mercati e versioni distinguono A attivo da C sperimentale e mantengono i motivi', async () => {
  const overview = emptyOverview();
  overview.markets = [
    { family: 'A', modelVersion: 'A-frozen', market: '1x2', state: 'ACTIVE', evidence: { n: 240, ece: 0.03, roi: 0.01, dataCoverage: 0.99, realQuoteCoverage: 0.9 }, reason: 'Validazione registrata A.' },
    { family: 'C', modelVersion: 'C-candidate', market: '1x2', state: 'EXPERIMENTAL', evidence: { n: 40 }, reason: 'Campione prospettico insufficiente.' },
  ];
  mockedOverview.mockResolvedValue(overview);
  mockedComparison.mockResolvedValue({ ...emptyComparison(), bets: { total: overview.bets.length, truncated: false, rows: overview.bets }, portfolios: overview.portfolios.map((portfolio) => ({ family: portfolio.family, portfolioId: portfolio.id, equity: portfolio.history || [] })) });
  render(<ResearchPage />);
  await screen.findByRole('heading', { name: 'Portafogli virtuali A e C' });
  fireEvent.click(screen.getByRole('tab', { name: 'Mercati' }));
  const marketA = screen.getByRole('region', { name: 'Esito finale 1X2 modello A' });
  const marketC = screen.getByRole('region', { name: 'Esito finale 1X2 modello C' });
  expect(within(marketA).getByText('Attivo')).toBeTruthy();
  expect(within(marketA).getByText('240')).toBeTruthy();
  expect(within(marketC).getByText('Sperimentale')).toBeTruthy();
  expect(within(marketC).getByText('Campione prospettico insufficiente.')).toBeTruthy();
  expect(within(marketC).queryByText('Attivo')).toBeNull();
});

test('benchmark mostra osservazioni, intervalli appaiati e limiti senza proclamare un vincitore', async () => {
  const overview = emptyOverview();
  overview.latestBenchmark = { id: 'report-1', createdAt: '2026-10-27T03:30:00Z', report: {
    probabilistic: { A: { n: 100, logLoss: 0.98, brier: 0.22, ece: 0.04 }, C: { n: 100, logLoss: 0.97, brier: 0.21, ece: 0.03 }, paired: { n: 100, logLossCI: [-0.04, 0.02] } },
    conclusion: 'Confronto non conclusivo: intervallo compatibile con nessun miglioramento.',
    warnings: ['Quote storiche mancanti: valutazione economica non eseguita.'],
    decisionDifferences: { same: 10, different: 12, onlyA: 3, onlyC: 4, neither: 71 },
  } };
  mockedOverview.mockResolvedValue(overview);
  mockedComparison.mockResolvedValue({ ...emptyComparison(), bets: { total: overview.bets.length, truncated: false, rows: overview.bets }, portfolios: overview.portfolios.map((portfolio) => ({ family: portfolio.family, portfolioId: portfolio.id, equity: portfolio.history || [] })) });
  render(<ResearchPage />);
  await screen.findByRole('heading', { name: 'Portafogli virtuali A e C' });
  fireEvent.click(screen.getByRole('tab', { name: 'Storico' }));
  expect(await screen.findByText(/Confronto non conclusivo: intervallo/)).toBeTruthy();
  expect(screen.getByText('[-0,04; 0,02]')).toBeTruthy();
  expect(screen.getByText('Quote storiche mancanti: valutazione economica non eseguita.')).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'A · Statistico' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'C · Ibrido ML' })).toBeTruthy();
  expect(screen.getByText('Nessuna puntata')).toBeTruthy();
  expect(screen.queryByText(/C è migliore/)).toBeNull();
});

test('mostra tutte le configurazioni di un mercato senza nascondere le versioni precedenti', async () => {
  const overview = emptyOverview();
  overview.markets = [
    { family: 'A', modelVersion: 'A-reference', market: '1x2', state: 'SHADOW', evidence: { probabilisticSamples: 280 }, reason: 'Validazione prospettica in corso.' },
    { family: 'A', modelVersion: 'A-retrained', market: '1x2', state: 'EXPERIMENTAL', reason: 'Nuova configurazione da verificare.' },
  ];
  mockedOverview.mockResolvedValue(overview);
  mockedComparison.mockResolvedValue({ ...emptyComparison(), bets: { total: overview.bets.length, truncated: false, rows: overview.bets }, portfolios: overview.portfolios.map((portfolio) => ({ family: portfolio.family, portfolioId: portfolio.id, equity: portfolio.history || [] })) });
  render(<ResearchPage />);
  await screen.findByRole('heading', { name: 'Portafogli virtuali A e C' });
  fireEvent.click(screen.getByRole('tab', { name: 'Mercati' }));
  const market = screen.getByRole('region', { name: 'Esito finale 1X2 modello A' });
  expect(within(market).getByText('A-reference')).toBeTruthy();
  expect(within(market).getByText('A-retrained')).toBeTruthy();
  expect(within(market).getByText('280')).toBeTruthy();
  expect(within(market).getByText('Sperimentale storico')).toBeTruthy();
  expect(within(market).getByText('Sperimentale')).toBeTruthy();
});

test('mostra provenienza dello snapshot e stato aperto con esposizione del singolo portafoglio', async () => {
  const overview = emptyOverview();
  overview.portfolios = [{ id: 'shadow_A', family: 'A', initialCents: 100000, availableCents: 99000, committedCents: 1000, equityCents: 100000, profitCents: 0, betCount: 1, settledCount: 0 }];
  overview.bets = [{ id: 'a1', portfolioId: 'shadow_A', matchId: 'fixture-A', modelVersion: 'A-reference', selection: 'homeWin', stakeCents: 1000, odds: 1.9, status: 'PENDING', createdAt: '2026-10-27T19:30:00Z', quote: { bookmaker: 'Bookmaker A', source: 'the_odds_api', updatedAt: '2026-10-27T19:28:00Z' } }];
  mockedOverview.mockResolvedValue(overview);
  mockedComparison.mockResolvedValue({ ...emptyComparison(), bets: { total: overview.bets.length, truncated: false, rows: overview.bets }, portfolios: overview.portfolios.map((portfolio) => ({ family: portfolio.family, portfolioId: portfolio.id, equity: portfolio.history || [] })) });
  render(<ResearchPage />);
  await screen.findByRole('heading', { name: 'Portafogli virtuali A e C' });
  fireEvent.click(screen.getByRole('tab', { name: 'Portafogli' }));
  const portfolio = screen.getByRole('article', { name: 'Portafoglio A' });
  expect(within(portfolio).getByText('1%')).toBeTruthy();
  expect(within(portfolio).getByText('Puntate aperte')).toBeTruthy();
  expect(await screen.findByText('Fonte: the_odds_api')).toBeTruthy();
  expect(screen.getByText(/Quota del/)).toBeTruthy();
});

test('calibrazione e intervalli temporali compaiono solo quando presenti nel report', async () => {
  const overview = emptyOverview();
  overview.latestBenchmark = { report: {
    probabilistic: { A: { n: 20, calibration: [{ predicted: 0.6, observed: 0.55, n: 20 }] }, paired: { weekLogLossCI: [-0.03, 0.04] } },
    conclusion: 'Campione non conclusivo.',
  } };
  mockedOverview.mockResolvedValue(overview);
  mockedComparison.mockResolvedValue({ ...emptyComparison(), bets: { total: overview.bets.length, truncated: false, rows: overview.bets }, portfolios: overview.portfolios.map((portfolio) => ({ family: portfolio.family, portfolioId: portfolio.id, equity: portfolio.history || [] })) });
  render(<ResearchPage />);
  await screen.findByRole('heading', { name: 'Portafogli virtuali A e C' });
  fireEvent.click(screen.getByRole('tab', { name: 'Storico' }));
  await screen.findByText('Campione non conclusivo.');
  expect(screen.getByText('Calibrazione delle probabilità')).toBeTruthy();
  expect(screen.getByText('60%')).toBeTruthy();
  expect(screen.getByText('55%')).toBeTruthy();
  expect(screen.getByText('Intervallo log loss per settimane C − A')).toBeTruthy();
});

test('le decisioni congelate mantengono probabilità distinte e il modello assente non copia A', async () => {
  const overview = emptyOverview();
  overview.decisions = [
    { id: 'dA', matchId: 'fixture-T15', family: 'A', modelVersion: 'A-reference', action: 'BET', selection: 'homeWin', market: '1x2', createdAt: '2026-10-27T19:30:10Z', inputId: 'shared-snapshot', probabilityStages: { raw: { homeWin: .60 }, calibrated: { homeWin: .57 }, decision: { homeWin: .55 } }, bookmakerProbabilities: { homeWin: { bookmaker: 'Bookmaker A', source: 'odds_api', raw: .51, noVig: .49 } } },
    { id: 'dC', matchId: 'fixture-T15', family: 'C', modelVersion: 'C-unavailable', action: 'ABSTAIN', reason: 'hybrid_model_unavailable_or_incompatible', createdAt: '2026-10-27T19:30:10Z', inputId: 'shared-snapshot', probabilityStages: { raw: {}, calibrated: null, decision: null } },
  ];
  mockedOverview.mockResolvedValue(overview);
  mockedComparison.mockResolvedValue({ ...emptyComparison(), bets: { total: overview.bets.length, truncated: false, rows: overview.bets }, portfolios: overview.portfolios.map((portfolio) => ({ family: portfolio.family, portfolioId: portfolio.id, equity: portfolio.history || [] })) });
  render(<ResearchPage />);
  await screen.findByRole('heading', { name: 'Portafogli virtuali A e C' });
  fireEvent.click(screen.getByRole('tab', { name: 'Portafogli' }));
  expect(screen.getByText('60% / 57% / 55%')).toBeTruthy();
  expect(screen.getByText('1: 49%')).toBeTruthy();
  expect(screen.getByText('Modello C assente o incompatibile.')).toBeTruthy();
  expect(screen.getAllByText('— / — / —')).toHaveLength(3);
  expect(screen.getAllByText('Snapshot shared-snapshot')).toHaveLength(2);
});

test('riepilogo giornaliero mantiene variazioni e risultati distinti per portafoglio', async () => {
  const overview = emptyOverview();
  overview.dailySummary = { day: '2026-10-27', timezone: 'Europe/Rome', portfolios: [
    { portfolioId: 'shadow_A', family: 'A', registeredBets: 1, settledBets: 1, profitCents: 900, portfolioDeltaCents: 900, startEquityCents: 100000, endEquityCents: 100900, endAvailableCents: 100900, endCommittedCents: 0 },
    { portfolioId: 'shadow_C', family: 'C', registeredBets: 1, settledBets: 0, profitCents: 0, portfolioDeltaCents: 0, startEquityCents: 100000, endEquityCents: 100000, endAvailableCents: 99000, endCommittedCents: 1000 },
  ] };
  mockedOverview.mockResolvedValue(overview);
  mockedComparison.mockResolvedValue({ ...emptyComparison(), bets: { total: overview.bets.length, truncated: false, rows: overview.bets }, portfolios: overview.portfolios.map((portfolio) => ({ family: portfolio.family, portfolioId: portfolio.id, equity: portfolio.history || [] })) });
  render(<ResearchPage />);
  await screen.findByRole('heading', { name: 'Portafogli virtuali A e C' });
  fireEvent.click(screen.getByRole('tab', { name: 'Sistema' }));
  const a = screen.getByRole('article', { name: 'Riepilogo A' });
  const c = screen.getByRole('article', { name: 'Riepilogo C' });
  expect(within(a).getByText(/1\.?009,00\s€/)).toBeTruthy();
  expect(within(c).getByText(/1\.?000,00\s€/)).toBeTruthy();
  expect(screen.queryByText(/2\.?009,00\s€/)).toBeNull();
});

test('la sola inizializzazione dei portafogli non diventa una curva di rendimento', async () => {
  const overview = emptyOverview();
  overview.portfolios = [{ id: 'shadow_A', family: 'A', initialCents: 100000, availableCents: 100000, committedCents: 0, equityCents: 100000, profitCents: 0, history: [{ at: '2026-10-27T09:00:00Z', equityCents: 100000 }] }];
  mockedOverview.mockResolvedValue(overview);
  mockedComparison.mockResolvedValue({ ...emptyComparison(), bets: { total: overview.bets.length, truncated: false, rows: overview.bets }, portfolios: overview.portfolios.map((portfolio) => ({ family: portfolio.family, portfolioId: portfolio.id, equity: portfolio.history || [] })) });
  render(<ResearchPage />);
  await screen.findByRole('heading', { name: 'Portafogli virtuali A e C' });
  fireEvent.click(screen.getByRole('tab', { name: 'Portafogli' }));
  expect(await screen.findByText('Il grafico comparirà quando saranno disponibili più movimenti per almeno un portafoglio.')).toBeTruthy();
  expect(screen.queryByRole('figure')).toBeNull();
});
