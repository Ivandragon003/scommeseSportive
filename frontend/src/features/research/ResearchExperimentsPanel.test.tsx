import { fireEvent, render, screen, within } from '@testing-library/react';
import ResearchExperimentsPanel from './ResearchExperimentsPanel';
import { ResearchExperiment, ResearchOverview } from './researchTypes';

const overview = (): ResearchOverview => ({
  models: [], portfolios: [], bets: [], markets: [], jobs: [], experiments: [], modelEvents: [],
  latestBenchmark: null, latestDiagnostics: null, notifications: [],
  status: { nightlyCreatesBets: false, legacyAutomationDisabled: true, schedulerEnabled: false,
    toleranceSeconds: 60, blockers: [], deployment: 'not_verified' },
});

const experiment = (id: string, kind = 'intensity_correction'): ResearchExperiment => ({
  id, createdAt: '2026-10-27T09:00:00Z', family: 'C', kind, featureGroup: 'all_features',
  runtimeCompatible: false, eligibleForPromotion: false,
  report: { phase: 'development', metricsA: { n: 320, logLoss: 1.02, brier: .62, ece: .04 },
    metricsC: { n: 320, logLoss: 1.01, brier: .61, ece: .03 },
    pairedCI: { logLoss: [-.03, .01], weeklyBrier: [-.02, .02] } },
});

test('i tre metodi restano esperimenti di sviluppo senza promozioni o portafogli aggiuntivi', () => {
  const payload = overview();
  payload.experiments = [experiment('exp-intensity'), experiment('exp-probabilities', 'probability_correction'),
    experiment('exp-ensemble', 'calibrated_ensemble')];
  render(<ResearchExperimentsPanel overview={payload} />);
  const table = screen.getByRole('table', { name: 'Metadati degli esperimenti; nessun nuovo portafoglio o candidato operativo' });
  expect(within(table).getByText('Correzione delle intensità')).toBeTruthy();
  expect(within(table).getByText('Correzione delle probabilità')).toBeTruthy();
  expect(within(table).getByText('Ensemble calibrato')).toBeTruthy();
  expect(within(table).getAllByText('Non idoneo alla promozione')).toHaveLength(3);
  expect(within(table).getAllByText('Non compatibile con il runtime')).toHaveLength(3);
  expect(within(table).getAllByText('[-0,03; 0,01]')).toHaveLength(3);
  expect(screen.getByText(/Non costituiscono un nuovo test indipendente/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Promuovi|Attiva|Registra|Punta/i })).toBeNull();
  expect(screen.queryByText('ROI')).toBeNull();
});

test('diagnosi protegge il test storico e mostra la mancanza di un nuovo test indipendente', () => {
  const payload = overview();
  payload.latestDiagnostics = { id: 'diagnostic-1', createdAt: '2026-10-27T09:00:00Z', report: {
    protection: { protectedFinalCount: 745, originalReportHash: 'immutable-report-hash', newIndependentTestAvailable: false },
    findings: [{ severity: 'high', code: 'protected_holdout', message: 'Il vecchio test finale resta escluso dagli esperimenti.' }],
    recommendation: 'Conservare il Champion finché manca una nuova valutazione indipendente.',
  } };
  render(<ResearchExperimentsPanel overview={payload} />);
  expect(screen.getByText('745')).toBeTruthy();
  expect(screen.getByText('Non disponibile')).toBeTruthy();
  expect(screen.getByText('Il vecchio test finale resta escluso dagli esperimenti.')).toBeTruthy();
  expect(screen.getByText('Gravità alta')).toBeTruthy();
  expect(screen.getByText('immutable-report-hash')).toBeTruthy();
  expect(screen.getByText(/Conservare il Champion/)).toBeTruthy();
});

test('metriche e importanze mancanti non diventano risultati economici o zeri', () => {
  const payload = overview();
  const row = experiment('exp-missing');
  row.report = { phase: 'development', metricsC: { n: 0, logLoss: null },
    hyperparameters: { iterations: 120, predictions: [{ fabricatedScore: 999 }] } };
  payload.experiments = [row];
  render(<ResearchExperimentsPanel overview={payload} />);
  const table = screen.getByRole('table', { name: 'Metadati degli esperimenti; nessun nuovo portafoglio o candidato operativo' });
  expect(within(table).getByText('0')).toBeTruthy();
  expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
  expect(screen.getByText('120')).toBeTruthy();
  expect(screen.queryByText('999')).toBeNull();
  expect(screen.queryByText('0%')).toBeNull();
  expect(screen.queryByText('ROI')).toBeNull();
  expect(screen.getByText('Importanza delle feature non disponibile per questo esperimento.')).toBeTruthy();
});

test('importanza e motivi di esclusione conservano valori e limiti del report', () => {
  const payload = overview();
  const row = experiment('exp-features', 'feature_ablation');
  row.report.featureImportance = [{ feature: 'eloDifference', importance: 12.5, permutationMean: .004, permutationStd: .002 }];
  row.report.rejectionReasons = ['Manca un campione finale indipendente.'];
  row.report.byLeague = { 'Serie A': { A: { n: 100, logLoss: .99 }, C: { n: 100, logLoss: .98 } } };
  payload.experiments = [row];
  render(<ResearchExperimentsPanel overview={payload} />);
  expect(screen.getByText('eloDifference')).toBeTruthy();
  expect(screen.getByText('12,5')).toBeTruthy();
  expect(screen.getByText('0,004')).toBeTruthy();
  expect(screen.getByText('0,002')).toBeTruthy();
  expect(screen.getByText('Manca un campione finale indipendente.')).toBeTruthy();
  expect(screen.getByText('Serie A')).toBeTruthy();
});

test('eventi del registro mantengono versione precedente e ragione senza modificare gli esperimenti', () => {
  const payload = overview();
  payload.modelEvents = [
    { family: 'C', version: 'C-restored', previousVersion: 'C-regression', action: 'ROLLBACK', reason: 'Regressione operativa verificata.', createdAt: '2026-10-27T09:00:00Z' },
  ];
  render(<ResearchExperimentsPanel overview={payload} />);
  const table = screen.getByRole('table', { name: 'Promozioni e rollback registrati' });
  expect(within(table).getByText('C-restored')).toBeTruthy();
  expect(within(table).getByText('C-regression')).toBeTruthy();
  expect(within(table).getByText('Regressione operativa verificata.')).toBeTruthy();
  expect(screen.getByText('Nessun esperimento di sviluppo registrato.')).toBeTruthy();
});

test('molti esperimenti hanno paginazione, filtri e un solo dettaglio selezionato', () => {
  const payload = overview();
  payload.experiments = Array.from({ length: 45 }, (_, index) => experiment(`experiment-${index}`, index % 2 ? 'calibrated_ensemble' : 'intensity_correction'));
  render(<ResearchExperimentsPanel overview={payload} />);
  const table = screen.getByRole('table', { name: 'Metadati degli esperimenti; nessun nuovo portafoglio o candidato operativo' });
  expect(within(table).getAllByRole('row')).toHaveLength(21);
  expect(within(table).getByText('experiment-0')).toBeTruthy();
  expect(within(table).queryByText('experiment-20')).toBeNull();
  expect(screen.getAllByText('Validazione di sviluppo. Le metriche e gli intervalli di questo esperimento non autorizzano la promozione del modello.')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Pagina successiva' }));
  expect(within(table).getByText('experiment-20')).toBeTruthy();
  expect(within(table).queryByText('experiment-0')).toBeNull();
  fireEvent.change(screen.getByLabelText('Metodo'), { target: { value: 'calibrated_ensemble' } });
  expect(screen.getByText('22 esperimenti di sviluppo corrispondono ai filtri.')).toBeTruthy();
  expect(within(table).getByText('experiment-1')).toBeTruthy();
  expect(within(table).queryByText('experiment-0')).toBeNull();
});

test('etichette storiche e calibratori mantengono il significato dei controlli reali', () => {
  const payload = overview();
  const row = experiment('exp-history');
  row.featureGroup = 'reduced_history_730_days';
  row.report.history = { trainingHistoryDays: 730, timeHalfLifeDays: null };
  row.report.calibration = 'isotonic_1x2_coherent';
  payload.experiments = [row];
  render(<ResearchExperimentsPanel overview={payload} />);
  const table = screen.getByRole('table', { name: 'Metadati degli esperimenti; nessun nuovo portafoglio o candidato operativo' });
  expect(within(table).getByText('Etichette di training degli ultimi 730 giorni')).toBeTruthy();
  expect(screen.getByText('Isotonica 1X2 coerente')).toBeTruthy();
  expect(screen.getByText('Età massima delle etichette di training (giorni)')).toBeTruthy();
  expect(screen.getByText('730')).toBeTruthy();
});

test('controlli senza ML e confronti su quote osservate non diventano prove di rendimento', () => {
  const payload = overview();
  const control = experiment('control-no-ml', 'no_ml_control');
  control.featureGroup = 'no_ml_control';
  payload.experiments = [control, experiment('observed-quotes', 'historical_snapshot_replay')];
  render(<ResearchExperimentsPanel overview={payload} />);
  const table = screen.getByRole('table', { name: 'Metadati degli esperimenti; nessun nuovo portafoglio o candidato operativo' });
  expect(within(table).getAllByText('Controllo senza ML')).toHaveLength(2);
  expect(within(table).getByText('Confronto su quote osservate')).toBeTruthy();
  expect(within(table).getByRole('columnheader', { name: 'Metodo o controllo' })).toBeTruthy();
  expect(screen.queryByText('ROI')).toBeNull();
  expect(screen.queryByText(/Profitto|Vincita/)).toBeNull();
});

test('liste diagnostiche vuote hanno uno stato esplicito e le etichette dataset restano leggibili', () => {
  const payload = overview();
  payload.latestDiagnostics = { id: 'diagnostic-empty-lists', createdAt: '2026-10-27T09:00:00Z', report: {
    datasetAudit: { counts: { eligible: 7323 }, duplicates: { matchIds: [] } },
  } };
  render(<ResearchExperimentsPanel overview={payload} />);
  expect(screen.getByText('Numerosità · Partite ammissibili')).toBeTruthy();
  expect(screen.getByText('7323')).toBeTruthy();
  expect(screen.getByText('Duplicati · Identificativi partita')).toBeTruthy();
  expect(screen.getByText('Nessun elemento')).toBeTruthy();
});
