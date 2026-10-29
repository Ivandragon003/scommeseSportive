import { DatabaseService } from '../db/DatabaseService';
import { baselineManifest } from './ForecastCore';
import { readResearchMonitoring, researchNightlyStatus } from './ResearchMonitoring';

type Row = Record<string, any>;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Missing measurements stay missing; an unmeasured result must never become zero. */
function economics(raw?: Row): Row | undefined {
  if (!raw) return undefined;
  const cents = (value: unknown) => number(value) === undefined ? undefined : Math.round(Number(value) * 100);
  return { initialCents: raw.initialCents ?? cents(raw.initialBankroll), finalCents: raw.finalCents ?? cents(raw.finalBankroll),
    profitCents: raw.profitCents ?? cents(raw.netProfit), roi: number(raw.roi), maxDrawdown: number(raw.maxDrawdown),
    betCount: number(raw.betCount) ?? (Array.isArray(raw.bets) ? raw.bets.length : number(raw.bets)),
    winRate: number(raw.winRate), clv: number(raw.clv ?? raw.meanClv), equity: raw.equityCurve ?? raw.equity };
}

const breakdown = (raw?: Record<string, any>): Row[] => Object.entries(raw ?? {}).map(([label, item]) => ({ label, ...item }));
const reportWarning = (value: unknown): string => {
  const raw = typeof value === 'string' ? value : String((value as Row)?.code ?? '');
  if (/No historical bookmaker prices|economic.*not_performed|No historical quote/i.test(raw)) return 'Quote storiche non caricate: il confronto riguarda le probabilità e non misura il rendimento delle puntate.';
  if (/No independent quote-labelled|Economic decisions require/i.test(raw)) return 'Mancano quote reali su un campione indipendente per stimare il valore prudenziale delle puntate.';
  if (/Historical result availability|two-hour delay|contemporaneous provider/i.test(raw)) return 'Nello storico i risultati diventano utilizzabili dopo almeno due ore; l’orario effettivo di acquisizione non è certificato.';
  if (/A is the frozen|as-of historical context|A uses the frozen|live context/i.test(raw)) return 'La baseline A usa un protocollo storico congelato; il contesto corrente può contenere informazioni aggiuntive.';
  if (/Final holdout|untouched within this run|Repeated model development|Repeated development/i.test(raw)) return 'Il test finale resta separato in questo esperimento. Ulteriori ottimizzazioni richiedono un nuovo campione indipendente.';
  if (/score grid|truncated|tail/i.test(raw)) return 'La distribuzione dei gol viene troncata e normalizzata; le probabilità di coda non sono validate separatamente.';
  if (/No new learned bookmaker-blend/i.test(raw)) return 'Questo esperimento non ristima i pesi del confronto con il mercato.';
  return raw;
};
export function benchmarkOverview(raw: Row | null): Row | null {
  if (!raw) return null;
  const report = raw.report ?? raw;
  const A = report.A ?? report.metricsA;
  const C = report.C ?? report.metricsC;
  const probabilityOnly = String(report.type ?? '').includes('probability') && report.bookmakerBenchmark?.n === 0;
  const econ = probabilityOnly ? undefined : report.economics?.onePercent ?? report.economic;
  const warnings: string[] = [...(report.warnings ?? []), ...(report.limitations ?? [])].map(reportWarning);
  if (!econ) warnings.push('Backtest economico non disponibile: servono quote storiche verificabili e compatibili con il protocollo.');
  if (report.productionPromotion === false) warnings.push('Questo report non autorizza la promozione operativa dei modelli.');
  if (String(report.probabilityPipeline ?? '').includes('isotonic') && report.probabilityProtocol !== 'joint-goal-coherent-v2') {
    warnings.push('Report storico conservato: la pipeline corrente V2 usa probabilità congiunte coerenti e richiede una nuova validazione.');
  }
  return { id: raw.id, createdAt: raw.createdAt,
    summary: 'Confronto cronologico A/C su partite successive ai dati di addestramento e calibrazione.',
    probabilistic: { A, C, bookmaker: report.bookmakerBenchmark?.bookmaker ?? report.bookmaker ?? report.bookmakerMetrics,
      paired: report.paired ?? { logLoss: report.pairedLogLossDifference, brier: report.pairedBrierDifference } },
    economic: econ ? { A: economics(econ.A), C: economics(econ.C) } : undefined,
    byLeague: breakdown(report.byLeague ?? (A?.byLeague ? Object.fromEntries(Object.keys(A.byLeague).map((key) =>
      [key, { A: A.byLeague[key], C: C?.byLeague?.[key] }])) : undefined)),
    bySeason: breakdown(report.bySeason ?? (A?.bySeason ? Object.fromEntries(Object.keys(A.bySeason).map((key) =>
      [key, { A: A.bySeason[key], C: C?.bySeason?.[key] }])) : undefined)),
    byMarket: breakdown(report.byMarket), byOddsBand: breakdown(report.byOddsBand),
    decisionDifferences: report.decisionDifferences, conclusion: ({
      inconclusive: 'Il confronto non è statisticamente conclusivo.',
      C_supported_on_primary_holdout: 'Il test primario sostiene C; la promozione richiede gli altri controlli.',
      A_supported_on_primary_holdout: 'Il test primario sostiene A; i risultati restano limitati al campione valutato.',
      C_probabilistically_better: 'C migliora le probabilità nel test storico; non dimostra redditività futura.',
      A_probabilistically_better: 'A migliora le probabilità nel test storico; non dimostra redditività futura.',
    } as Record<string, string>)[report.conclusion] ?? report.conclusion, warnings };
}

/** Read-only DTO shared by web and Android. It never initializes a bankroll on GET. */
export async function buildResearchOverview(db: DatabaseService, options: { now?: string | Date; nightlyEnabled?: boolean } = {}): Promise<Row> {
  const [models, rawPortfolios, bets, markets, jobs, ledger, latestBenchmark, runs, decisions, monitoring, registeredExperiments, modelEvents, benchmarks] = await Promise.all([
    db.research.getModels(), db.research.listPortfolios(), db.research.listBets(), db.research.listMarkets(),
    db.research.listJobs(), db.research.listLedger(), db.research.getLatestBenchmark('PAIR'), db.listRecentSchedulerRuns(50),
    db.research.listDecisions(), readResearchMonitoring(db, options.now ?? new Date()),
    db.researchExperiments?.list() ?? Promise.resolve([]), db.research.listModelEvents(), db.research.listBenchmarks({ limit: 1 }),
  ]);
  const named = async (name: string) => db.listRecentSchedulerRunsByName
    ? db.listRecentSchedulerRunsByName(name, 5) : runs.filter((run) => run.schedulerName === name);
  const [nightlyRuns, trainingRuns, dataRuns, providerRuns, researchNightlyRuns] = await Promise.all([
    named('nightly'), named('research_training'), named('understat'), named('research_provider'), named('research_nightly'),
  ]);
  const portfolios = rawPortfolios.map((portfolio) => {
    const movements = ledger.filter((row) => row.portfolioId === portfolio.id);
    let equityCents = 0;
    const history = movements.map((row) => { equityCents += row.availableDeltaCents + row.committedDeltaCents;
      return { at: row.createdAt, equityCents }; });
    const initialCents = movements.filter((row) => row.event === 'OPEN')
      .reduce((sum, row) => sum + row.availableDeltaCents + row.committedDeltaCents, 0);
    const ownBets = bets.filter((bet) => bet.portfolioId === portfolio.id);
    return { ...portfolio, initialCents, profitCents: portfolio.equityCents - initialCents,
      betCount: ownBets.length, settledCount: ownBets.filter((bet) => bet.status === 'SETTLED').length,
      openCount: ownBets.filter((bet) => bet.status === 'PENDING').length, history };
  });
  // An import completing is not evidence that the entire nightly completed.
  const nightly = nightlyRuns.find((row) => row.success);
  const training = trainingRuns[0];
  const dataUpdate = dataRuns.find((row) => row.success);
  const provider = providerRuns[0];
  const quotaRun = providerRuns.find((row) => row.summary?.quota?.observedAt);
  const diagnosticRecord = registeredExperiments.find((experiment) => experiment.kind === 'DIAGNOSTIC_RUN');
  const rejected = benchmarks[0]?.report;
  const rejectionLabels: Record<string, string> = {
    protected_original_final_reused: 'Il test finale precedente è già stato consultato e resta protetto.',
    new_independent_future_holdout_required: 'Serve un nuovo periodo futuro indipendente.',
    measured_operational_checks_missing_or_failed: 'Mancano tre partite e snapshot distinti con la pipeline operativa verificata.',
    legacy_probability_protocol_not_operational: 'La vecchia calibrazione marginale non è abilitata al percorso operativo.',
    calibration_pipeline_hash_mismatch: 'La configurazione della calibrazione non corrisponde al codice verificato.',
  };
  const rejectionFindings = (Array.isArray(rejected?.warnings) ? rejected.warnings : [])
    .filter((warning) => warning?.invalidating === true && typeof warning.code === 'string')
    .map((warning) => ({ severity: 'high', code: warning.code,
      message: `${benchmarks[0].modelVersion ?? 'Candidato'}: ${rejectionLabels[warning.code] ?? warning.code}` }));
  const latestDiagnostics = diagnosticRecord ? { ...diagnosticRecord, report: { ...diagnosticRecord.report,
    findings: [...(diagnosticRecord.report?.findings ?? []), ...rejectionFindings] } } : null;
  const experiments = registeredExperiments.filter((experiment) => experiment.kind !== 'DIAGNOSTIC_RUN');
  const blockers: string[] = [];
  const enabled = options.nightlyEnabled ?? process.env.RESEARCH_NIGHTLY_ENABLED === 'true';
  const nightlyStatus = researchNightlyStatus(researchNightlyRuns, options.now ?? new Date(), enabled);
  const schedulerState = nightlyStatus.state;
  if (!enabled) blockers.push('Registrazione virtuale notturna disabilitata: l’attivazione richiede conferma esplicita.');
  if (nightlyStatus.overdue) blockers.push('Elaborazione notturna non osservata entro il margine previsto.');
  if (enabled && schedulerState === 'DISABLED') blockers.push('Il run osservato dichiara la registrazione virtuale disabilitata.');
  if (schedulerState === 'FAILED') blockers.push('L’ultima elaborazione notturna è fallita.');
  if (!models.some((model) => model.family === 'C')) blockers.push('Nessun artefatto CatBoost C registrato.');
  return {
    baseline: baselineManifest(),
    models: models.map((model) => ({ family: model.family, version: model.version,
      status: model.isChampion ? 'CHAMPION' : 'CANDIDATE', createdAt: model.createdAt,
      trainedThrough: model.artifact?.trainedThrough, metrics: model.artifact?.metrics })),
    portfolios, bets: bets.map((bet) => ({ ...bet, createdAt: bet.placedAt, quote: bet.snapshot?.quote,
      status: bet.status !== 'SETTLED' ? 'PENDING' : bet.multiplier === 0 ? 'LOST' : bet.multiplier === 1 ? 'VOID'
        : bet.multiplier === .5 ? 'HALF_LOST' : bet.multiplier === bet.odds ? 'WON' : 'HALF_WON' })),
    markets, jobs, latestBenchmark: benchmarkOverview(latestBenchmark), experiments, latestDiagnostics: latestDiagnostics ?? null, modelEvents,
    decisions: decisions.slice(-50).reverse().map((decision) => ({
      id: decision.id, matchId: jobs.find((job) => job.id === decision.jobId)?.matchId,
      family: decision.family, modelVersion: decision.modelVersion, action: decision.action,
      selection: decision.selection, market: decision.market, reason: decision.reason, createdAt: decision.createdAt,
      quote: decision.snapshot?.quote, probability: decision.snapshot?.probability,
      inputId: decision.inputId, forecastAt: decision.snapshot?.forecastAt,
      bookmakerProbabilities: decision.snapshot?.bookmakerProbabilities,
      probabilityStages: decision.snapshot?.probabilityStages,
    })),
    status: { mode: 'NIGHTLY_PRE_MATCH', nightlyCreatesBets: enabled, legacyAutomationDisabled: true, schedulerEnabled: enabled,
      schedulerState,
      automationScope: 'local_code', remoteVerification: 'not_verified_from_backend',
      heartbeatAt: null, toleranceSeconds: null, nightly: nightlyStatus,
      lastSchedulerJobAt: nightlyStatus.lastRun?.endedAt ?? null,
      lastNightlyAt: nightly?.endedAt ?? null, training: training ? { lastAt: training.endedAt, status: training.success ? 'success' : 'failed' } : undefined,
      lastDataUpdateAt: dataUpdate?.endedAt ?? null, dbStatus: 'raggiungibile',
      lastProviderAt: provider?.endedAt ?? null, apiQuota: quotaRun?.summary?.quota ?? null,
      lastValidationAt: benchmarks[0]?.createdAt ?? null,
      lastPromotionAt: [...modelEvents].reverse().find((event) => event.action === 'PROMOTE')?.createdAt ?? null,
      lastRollbackAt: [...modelEvents].reverse().find((event) => event.action === 'ROLLBACK')?.createdAt ?? null,
      blockers, deployment: 'Decisioni tramite GitHub Actions nightly; il backend web non registra puntate automaticamente. Stato remoto da collaudare separatamente.',
      providerStatus: provider ? (provider.success ? 'Ultima richiesta riuscita; controllare timestamp e copertura.' : 'Ultima richiesta fallita.')
        : 'Nessuna richiesta al provider misurata da questo processo.' },
    notifications: monitoring.notifications, dailySummary: monitoring.dailySummary, notificationDelivery: monitoring.delivery,
  };
}
