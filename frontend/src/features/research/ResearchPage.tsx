import React, { useEffect, useState } from 'react';
import { getResearchOverview } from '../../utils/researchApi';
import {
  ComparisonBreakdown, EconomicMetrics, ProbabilityMetrics, ResearchBenchmarkReport, ResearchMarket,
  ResearchOverview, ResearchPortfolio, ResearchDecision,
} from './researchTypes';
import {
  breakdownLabel, confidenceInterval, count, dateTime, decisionReason, finiteNumber, marketLabel,
  metric, money, percent, portfolioLabel,
} from './researchPresentation';
import { Badge, Empty, Metric } from './ResearchPrimitives';
import ResearchAutomationStatus from './ResearchAutomationStatus';
import ResearchExperimentsPanel from './ResearchExperimentsPanel';
import ResearchOddsPanel from './ResearchOddsPanel';
import EquityChart from './ResearchEquityChart';
import ResearchComparisonPanel from './ResearchComparisonPanel';
import './research.css';

type ResearchTab = 'history' | 'portfolios' | 'markets' | 'experiments' | 'odds' | 'system';
const TABS: Array<{ id: ResearchTab; label: string }> = [
  { id: 'portfolios', label: 'Portafogli' }, { id: 'history', label: 'Storico' },
  { id: 'markets', label: 'Mercati' }, { id: 'experiments', label: 'Esperimenti' },
  { id: 'odds', label: 'API quote' },
  { id: 'system', label: 'Sistema' },
];

const ProbabilityTable = ({ a, c, bookmaker }: { a?: ProbabilityMetrics; c?: ProbabilityMetrics; bookmaker?: ProbabilityMetrics }) => (
  <div className="research-table-wrap"><table className="fp-table research-compare-table">
    <caption>Qualità probabilistica: valori più bassi sono migliori</caption>
    <thead><tr><th>Misura</th><th>A · Statistico</th><th>C · Ibrido ML</th>{bookmaker && <th>Bookmaker senza margine</th>}</tr></thead>
    <tbody>{[
      { label: 'Osservazioni', key: 'n' as const, format: count },
      { label: 'Log loss', key: 'logLoss' as const, format: metric },
      { label: 'Brier score', key: 'brier' as const, format: metric },
      { label: 'Errore di calibrazione', key: 'ece' as const, format: metric },
    ].map(({ label, key, format }) => <tr key={key}><th scope="row">{label}</th><td>{format(a?.[key])}</td><td>{format(c?.[key])}</td>{bookmaker && <td>{format(bookmaker[key])}</td>}</tr>)}</tbody>
  </table></div>
);

const CalibrationTable = ({ a, c }: { a?: ProbabilityMetrics; c?: ProbabilityMetrics }) => {
  if (!a?.calibration?.length && !c?.calibration?.length) return null;
  return <details className="research-breakdown"><summary>Calibrazione delle probabilità</summary><p className="research-help">Per ogni fascia, confronta la probabilità media prevista con la frequenza osservata. Le fasce con poche osservazioni hanno maggiore incertezza.</p><div className="research-table-wrap"><table className="fp-table"><caption>Probabilità previste e frequenze osservate nel test cronologico</caption><thead><tr><th>Modello</th><th>Probabilità prevista</th><th>Frequenza osservata</th><th>Osservazioni</th></tr></thead><tbody>{(['A', 'C'] as const).flatMap((family) => (family === 'A' ? a : c)?.calibration?.map((bin, index) => <tr key={`${family}-${index}`}><th scope="row">{family}</th><td>{percent(bin.predicted)}</td><td>{percent(bin.observed)}</td><td>{count(bin.n)}</td></tr>) || [])}</tbody></table></div></details>;
};

const EconomicTable = ({ a, c }: { a?: EconomicMetrics; c?: EconomicMetrics }) => (
  <div className="research-table-wrap"><table className="fp-table research-compare-table">
    <caption>Simulazione economica storica con quote verificabili</caption>
    <thead><tr><th>Misura</th><th>Portafoglio storico A</th><th>Portafoglio storico C</th></tr></thead>
    <tbody>{[
      { label: 'Capitale iniziale', key: 'initialCents' as const, format: money },
      { label: 'Capitale finale', key: 'finalCents' as const, format: money },
      { label: 'Profitto / perdita', key: 'profitCents' as const, format: money },
      { label: 'ROI', key: 'roi' as const, format: percent },
      { label: 'Drawdown massimo', key: 'maxDrawdown' as const, format: percent },
      { label: 'Puntate', key: 'betCount' as const, format: count },
      { label: 'Win rate', key: 'winRate' as const, format: percent },
      { label: 'Closing Line Value', key: 'clv' as const, format: percent },
    ].map(({ label, key, format }) => <tr key={key}><th scope="row">{label}</th><td>{format(a?.[key])}</td><td>{format(c?.[key])}</td></tr>)}</tbody>
  </table></div>
);

const PairedEvidence = ({ paired }: { paired?: Record<string, unknown> }) => {
  if (!paired || !Object.keys(paired).length) return <Empty>Intervalli appaiati non disponibili: nessuna superiorità statistica dimostrata.</Empty>;
  return <dl className="research-paired">{Object.entries(paired).map(([key, value]) => {
    const interval = confidenceInterval(value);
    const names: Record<string, string> = { n: 'Osservazioni appaiate', sampleSize: 'Osservazioni appaiate', logLossDelta: 'Differenza log loss C − A', deltaLogLoss: 'Differenza log loss C − A', brierDelta: 'Differenza Brier C − A', deltaBrier: 'Differenza Brier C − A', logLossCI: 'Intervallo log loss C − A', brierCI: 'Intervallo Brier C − A', weekLogLossCI: 'Intervallo log loss per settimane C − A', weekBrierCI: 'Intervallo Brier per settimane C − A', matchClusters: 'Partite indipendenti', weekClusters: 'Settimane osservate', confidenceLevel: 'Livello di confidenza' };
    if (!interval && typeof value !== 'number' && typeof value !== 'string') return null;
    return <div key={key}><dt>{names[key] || key}</dt><dd>{interval || (typeof value === 'number' ? metric(value) : String(value))}</dd></div>;
  })}</dl>;
};

const Breakdown = ({ title, rows }: { title: string; rows?: ComparisonBreakdown[] }) => {
  if (!Array.isArray(rows) || !rows.length) return null;
  return <details className="research-breakdown"><summary>{title}</summary><div className="research-table-wrap"><table className="fp-table"><caption>{title}: osservazioni e qualità per modello</caption><thead><tr><th>Gruppo</th><th>N A</th><th>N C</th><th>Log loss A</th><th>Log loss C</th><th>Brier A</th><th>Brier C</th><th>ROI A</th><th>ROI C</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${breakdownLabel(row)}-${index}`}><th scope="row">{breakdownLabel(row)}</th><td>{count(row.A?.n ?? row.n)}</td><td>{count(row.C?.n ?? row.n)}</td><td>{metric(row.A?.logLoss)}</td><td>{metric(row.C?.logLoss)}</td><td>{metric(row.A?.brier)}</td><td>{metric(row.C?.brier)}</td><td>{percent(row.A?.roi)}</td><td>{percent(row.C?.roi)}</td></tr>)}</tbody></table></div></details>;
};

const HistoryPanel = ({ overview }: { overview: ResearchOverview }) => {
  const benchmark = overview.latestBenchmark;
  const report: ResearchBenchmarkReport | null = benchmark ? benchmark.report || benchmark : null;
  if (!report) return <section className="research-panel" aria-labelledby="research-history-title"><h2 id="research-history-title">Benchmark storico</h2><Empty>Nessun benchmark eseguito.</Empty><p>Il confronto richiede le stesse partite, gli stessi input temporali e le stesse quote. Nessun dato viene sostituito con risultati dimostrativi.</p></section>;
  const differences = report.decisionDifferences;
  return <div className="research-stack">
    <section className="research-panel" aria-labelledby="research-history-title">
      <div className="research-section-heading"><div><h2 id="research-history-title">Benchmark storico A vs C</h2>{benchmark?.createdAt && <p>Report del {dateTime(benchmark.createdAt)}</p>}</div><span className="fp-badge fp-badge-blue">Backtest storico</span></div>
      <p className="research-conclusion">{report.conclusion || 'Il report non contiene una conclusione statistica: confronto non conclusivo.'}</p>
      <p className="research-help">Questo report storico conserva il metodo e i risultati dell’esperimento registrato. Non certifica una configurazione utilizzabile nel percorso operativo.</p>
      {report.summary && <p>{report.summary}</p>}
      {!!report.warnings?.length && <ul className="research-notes">{report.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>}
      <ProbabilityTable a={report.probabilistic?.A} c={report.probabilistic?.C} bookmaker={report.probabilistic?.bookmaker} />
      <CalibrationTable a={report.probabilistic?.A} c={report.probabilistic?.C} />
      <p className="research-help">Log loss e Brier misurano la qualità delle probabilità. L'errore di calibrazione confronta probabilità previste e frequenze osservate. Le sole partite indovinate non bastano.</p>
      <h3>Confronto appaiato e incertezza</h3>
      <PairedEvidence paired={report.probabilistic?.paired} />
    </section>
    <section className="research-panel"><h2>Portafogli storici</h2><p>Queste simulazioni restano separate dalle puntate virtuali della nightly e dai saldi legacy.</p>{report.economic ? <><EconomicTable a={report.economic.A} c={report.economic.C} /><EquityChart a={report.economic.A?.equity} c={report.economic.C?.equity} title="Patrimoni storici A e C" /></> : <Empty>Backtest economico non disponibile: nessun rendimento ricostruito da quote stimate.</Empty>}</section>
    <section className="research-panel"><h2>Decisioni differenti</h2>{differences ? <dl className="research-metrics research-metrics--decisions">{[
      ['Stessa puntata', differences.same], ['Puntate differenti', differences.different], ['Solo A', differences.onlyA], ['Solo C', differences.onlyC], ['Nessuna puntata', differences.neither],
    ].map(([label, value]) => <Metric key={String(label)} label={String(label)} value={count(value)} />)}</dl> : <Empty>Confronto delle decisioni non ancora disponibile.</Empty>}</section>
    {(report.byLeague?.length || report.byMarket?.length || report.bySeason?.length || report.byOddsBand?.length) ? <section className="research-panel"><h2>Stabilità e segmenti</h2><Breakdown title="Per campionato" rows={report.byLeague} /><Breakdown title="Per mercato" rows={report.byMarket} /><Breakdown title="Per stagione" rows={report.bySeason} /><Breakdown title="Per fascia di quota" rows={report.byOddsBand} /></section> : null}
  </div>;
};

const PortfolioCard = ({ portfolio }: { portfolio: ResearchPortfolio }) => <article className="research-portfolio" aria-label={portfolioLabel(portfolio)}>
  <div className="research-section-heading"><h3>{portfolioLabel(portfolio)}</h3><span className="fp-badge fp-badge-blue">Modello {portfolio.family}</span></div>
  <dl className="research-metrics">
    <Metric label="Stake corrente" value={portfolio.family === 'A' ? 'Stake del consiglio' : '1% fisso'}
      help={portfolio.family === 'A' ? 'Percentuale variabile indicata nel consiglio della pagina Partite.' : undefined} />
    <Metric label="Esposizione massima" value="5%" />
    <Metric label="Patrimonio contabile" value={money(portfolio.equityCents)} help="Disponibile + capitale impegnato" />
    <Metric label="Disponibile" value={money(portfolio.availableCents)} />
    <Metric label="Impegnato" value={money(portfolio.committedCents)} />
    <Metric label="Profitto / perdita dall’apertura" value={money(portfolio.profitCents)} />
    <Metric label="Capitale iniziale" value={money(portfolio.initialCents)} />
    <Metric label="Puntate liquidate" value={count(portfolio.settledCount)} />
    <Metric label="Puntate aperte" value={count(portfolio.openCount ?? (finiteNumber(portfolio.betCount) && finiteNumber(portfolio.settledCount) ? Math.max(0, portfolio.betCount - portfolio.settledCount) : undefined))} />
    <Metric label="Esposizione attuale" value={finiteNumber(portfolio.equityCents) && portfolio.equityCents > 0 && finiteNumber(portfolio.committedCents) ? percent(portfolio.committedCents / portfolio.equityCents) : '—'} />
  </dl>
</article>;

const DecisionEvidence = ({ decisions }: { decisions?: ResearchDecision[] }) => {
  if (!decisions?.length) return <section className="research-panel"><h2>Previsioni e decisioni congelate</h2><Empty>Nessuno snapshot decisionale A/C registrato. Le probabilità registrate compariranno dopo un'esecuzione della nightly.</Empty></section>;
  const rows = [...decisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.matchId.localeCompare(b.matchId) || a.family.localeCompare(b.family));
  const labels: Record<string, string> = { homeWin: '1', draw: 'X', awayWin: '2' };
  return <section className="research-panel"><h2>Previsioni e decisioni congelate</h2><p>Registro recente indipendente dal filtro periodo. Le probabilità registrate restano legate alla versione e allo snapshot prepartita. Grezza, calibrata e decisionale sono fasi distinte; la quota bookmaker conserva il proprio operatore.</p><details className="research-breakdown"><summary>Leggi le ultime {rows.length} decisioni A/C</summary><div className="research-table-wrap"><table className="fp-table"><caption>Decisioni prospettiche conservate prima della partita</caption><thead><tr><th>Partita e modello</th><th>Decisione</th><th>Probabilità grezza / calibrata / decisionale</th><th>Bookmaker senza margine</th><th>Motivazione</th></tr></thead><tbody>{rows.map((decision) => {
    const selections = decision.selection ? [decision.selection] : ['homeWin', 'draw', 'awayWin'];
    return <tr key={decision.id}><td><strong>{decision.matchId}</strong><span>Modello {decision.family}</span><small className="research-version">{decision.modelVersion}</small><small>{dateTime(decision.forecastAt || decision.createdAt)}</small>{decision.inputId && <small className="research-version">Snapshot {decision.inputId}</small>}</td><td>{decision.action === 'BET' ? <><strong>{decision.selection}</strong>{decision.market && <small>{marketLabel(decision.market)}</small>}</> : 'Nessuna puntata'}</td><td><ul className="research-probability-list">{selections.map((selection) => <li key={selection}><strong>{labels[selection] || selection}</strong><span>{percent(decision.probabilityStages?.raw?.[selection])} / {percent(decision.probabilityStages?.calibrated?.[selection])} / {percent(decision.probabilityStages?.decision?.[selection] ?? (selection === decision.selection ? decision.probability : undefined))}</span></li>)}</ul></td><td><ul className="research-probability-list">{selections.map((selection) => {
      const bookmaker = decision.bookmakerProbabilities?.[selection];
      return <li key={selection}><span>{labels[selection] || selection}: {percent(bookmaker?.noVig)}</span>{bookmaker && <small>{bookmaker.bookmaker} · {bookmaker.source}</small>}</li>;
    })}</ul></td><td>{decisionReason(decision.reason)}</td></tr>;
  })}</tbody></table></div></details></section>;
};

const PortfolioPanel = ({ overview, revision }: { overview: ResearchOverview; revision: number }) => {
  const portfolios = (['A', 'C'] as const).flatMap((family) => {
    const portfolio = overview.portfolios?.find((item) => item.family === family && item.id !== 'main');
    return portfolio ? [portfolio] : [];
  });
  return <div className="research-stack">
    <section className="research-panel"><h2>Portafogli virtuali A e C</h2>
      <p>Saldi attuali di due portafogli indipendenti. La nightly valuta le stesse partite e quote; ogni modello sceglie una puntata oppure nessuna. C resta Challenger.</p>
      <p className="research-help">A usa lo stake variabile del consiglio della pagina Partite; C usa uno stake fisso dell’1%. Esposizione massima 5% per ciascun portafoglio, massimo una puntata per partita e modello. I patrimoni non si sommano e non comprendono il budget legacy. Nessun denaro reale.</p>
      {portfolios.length ? <div className="research-portfolios">{portfolios.map((portfolio) => <PortfolioCard key={portfolio.id} portfolio={portfolio} />)}</div>
        : <Empty>Portafogli non inizializzati. Nessun capitale o risultato viene presunto.</Empty>}
    </section>
    <ResearchComparisonPanel revision={revision} />
    <DecisionEvidence decisions={overview.decisions} />
  </div>;
};

const marketEvidence = (market?: ResearchMarket) => {
  const evidence = market?.evidence || {};
  return {
    n: evidence.probabilisticSamples ?? evidence.sampleSize ?? evidence.n ?? evidence.predictionCount,
    coverage: evidence.dataCoverage ?? evidence.coverage,
    ece: evidence.ece ?? evidence.calibrationError,
    roi: evidence.roi,
    quotes: evidence.realQuoteCoverage ?? evidence.quoteCoverage,
  };
};

const MarketsPanel = ({ markets }: { markets: ResearchMarket[] }) => {
  const grouped = new Map<string, { A: ResearchMarket[]; C: ResearchMarket[] }>();
  for (const market of markets || []) {
    const group = grouped.get(market.market) || { A: [], C: [] };
    group[market.family].push(market);
    grouped.set(market.market, group);
  }
  return <section className="research-panel"><h2>Validazione dei mercati</h2><p>Lo stato appartiene a un mercato e a una versione del modello. Promuovere un modello non attiva automaticamente tutti i suoi mercati.</p><dl className="research-state-guide"><div><dt><Badge state="EXPERIMENTAL" /></dt><dd>Validazione statistica incompleta. Le puntate virtuali sono ammesse solo con dati, quote e liquidazione tecnicamente idonei.</dd></div><div><dt><Badge state="SHADOW" /></dt><dd>Stato storico conservato; non rappresenta un portafoglio o una modalità aggiuntiva.</dd></div><div><dt><Badge state="ACTIVE" /></dt><dd>Validazione registrata per questa versione; il modello C resta Challenger.</dd></div><div><dt><Badge state="SUSPENDED" /></dt><dd>Temporaneamente escluso per controlli falliti o regressioni.</dd></div></dl>{grouped.size ? <div className="research-market-list">{Array.from(grouped.entries()).map(([key, group]) => <article className="research-market" key={key}><h3>{marketLabel(key)}</h3><div className="research-market__models">{(['A', 'C'] as const).map((family) => {
    const versions = group[family];
    return <section key={family} aria-label={`${marketLabel(key)} modello ${family}`}><h4>Modello {family}</h4>{versions.length ? versions.map((row) => {
      const evidence = marketEvidence(row);
      return <div className="research-market-version" key={row.modelVersion}><div className="research-section-heading"><p className="research-version">{row.modelVersion}</p><Badge state={row.state} /></div><dl className="research-evidence"><Metric label="Previsioni" value={count(evidence.n)} /><Metric label="Copertura dati" value={percent(evidence.coverage)} /><Metric label="Errore calibrazione" value={metric(evidence.ece)} /><Metric label="ROI virtuale" value={percent(evidence.roi)} /><Metric label="Copertura quote reali" value={percent(evidence.quotes)} /></dl><p>{row.reason || (row.state === 'ACTIVE' ? 'Validazione registrata per questa versione.' : 'Evidenze di promozione non ancora complete.')}</p></div>;
    }) : <p>Non configurato</p>}</section>;
  })}</div></article>)}</div> : <Empty>Nessuna validazione di mercato registrata. Nessun mercato viene considerato attivo implicitamente.</Empty>}</section>;
};

const SystemPanel = ({ overview }: { overview: ResearchOverview }) => {
  const status = overview.status;
  return <div className="research-stack"><ResearchAutomationStatus status={status} />
    <section className="research-panel"><h2>Modelli e aggiornamenti</h2><dl className="research-system"><Metric label="Ultima validazione" value={dateTime(status?.lastValidationAt)} /><Metric label="Ultimo training" value={dateTime(status?.training?.lastAt)} /><Metric label="Stato training" value={status?.training?.status || 'Non disponibile'} /><Metric label="Ultima promozione" value={dateTime(status?.lastPromotionAt ?? status?.training?.lastPromotionAt)} /><Metric label="Ultimo rollback" value={dateTime(status?.lastRollbackAt ?? status?.training?.lastRollbackAt)} /></dl>{overview.models?.length ? <div className="research-table-wrap"><table className="fp-table"><caption>Versioni del registro modelli</caption><thead><tr><th>Famiglia</th><th>Versione</th><th>Stato</th><th>Dati ammessi fino a</th><th>Creazione</th></tr></thead><tbody>{overview.models.map((model) => <tr key={`${model.family}-${model.version}`}><td>{model.family === 'A' ? 'A · Statistico' : 'C · Ibrido ML'}</td><td className="research-version">{model.version}</td><td><Badge state={model.status} /></td><td>{dateTime(model.trainedThrough)}</td><td>{dateTime(model.createdAt)}</td></tr>)}</tbody></table></div> : <Empty>Nessuna versione registrata. Il modello C non è considerato disponibile senza un artefatto ML valido.</Empty>}</section>

    <section className="research-panel"><h2>Riepiloghi e segnalazioni</h2><p>Riepiloghi giornalieri e problemi tecnici importanti, senza notifiche per ogni puntata.</p>{overview.dailySummary && <><h3>Riepilogo del {overview.dailySummary.day}</h3><p className="research-help">Giornata contabile in {overview.dailySummary.timezone}; ogni portafoglio mantiene il proprio saldo.</p><div className="research-portfolios">{overview.dailySummary.portfolios.map((portfolio) => <article className="research-portfolio" key={portfolio.portfolioId} aria-label={`Riepilogo ${portfolio.family}`}><h3>{portfolioLabel({ id: portfolio.portfolioId, family: portfolio.family })}</h3><dl className="research-metrics"><Metric label="Puntate registrate" value={count(portfolio.registeredBets)} /><Metric label="Puntate liquidate" value={count(portfolio.settledBets)} /><Metric label="Profitto / perdita della giornata" value={money(portfolio.profitCents)} /><Metric label="Variazione del patrimonio" value={money(portfolio.portfolioDeltaCents)} /><Metric label="Patrimonio a fine giornata" value={money(portfolio.endEquityCents)} /></dl></article>)}</div></>}{overview.notifications?.length ? <ul className="research-notifications">{overview.notifications.map((notification, index) => <li key={notification.id || index}><strong>{notification.title || (notification.kind === 'daily_summary' ? 'Riepilogo giornaliero' : 'Segnalazione tecnica')}</strong><p>{notification.message || 'Dettaglio non disponibile.'}</p>{notification.createdAt && <small>{dateTime(notification.createdAt)}</small>}</li>)}</ul> : <Empty>Nessun riepilogo o segnalazione disponibile.</Empty>}</section>
  </div>;
};

const ResearchPage: React.FC = () => {
  const [tab, setTab] = useState<ResearchTab>('portfolios');
  const [overview, setOverview] = useState<ResearchOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoading(true); setError(null);
    getResearchOverview(controller.signal).then((data) => {
      if (!active) return;
      setOverview(data); setLoadedAt(new Date().toISOString());
    }).catch((failure) => {
      if (!active) return;
      setError(failure?.response?.data?.error || failure?.message || 'Impossibile caricare il confronto dei modelli.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [revision]);
  return <div className="tool-page research-page"><header className="tool-page__header research-header"><div><span className="tool-page__eyebrow">Laboratorio personale</span><h1 className="tool-page__title">Confronto A/C</h1><p className="tool-page__subtitle">Modello statistico A e modello ibrido C: evidenze, portafogli virtuali e affidabilità.</p></div>{tab !== 'odds' && <button type="button" className="fp-btn fp-btn-ghost" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{loading ? 'Caricamento…' : 'Aggiorna confronto'}</button>}</header>
    <p className="research-scope">Nightly Pre-Match Virtual Betting. Due portafogli indipendenti, solo capitale virtuale; benchmark storico distinto dai risultati registrati.</p>
    <div className="research-tabs" role="tablist" aria-label="Sezioni confronto modelli">{TABS.map((item, index) => <button type="button" key={item.id} role="tab" id={`research-tab-${item.id}`} aria-controls={`research-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      setTab(TABS[nextIndex].id); document.getElementById(`research-tab-${TABS[nextIndex].id}`)?.focus();
    }}>{item.label}</button>)}</div>
    {tab !== 'odds' && error && <div className="fp-alert fp-alert-danger research-error" role="alert"><strong>Confronto non aggiornato</strong><p>{error}</p>{overview && <small>Restano visibili i dati caricati il {dateTime(loadedAt)}.</small>}</div>}
    {tab !== 'odds' && loading && !overview && <p role="status" className="research-empty">Caricamento del confronto A/C…</p>}
    {tab !== 'odds' && !loading && !overview && error && <Empty>Non è possibile mostrare saldi o metriche senza una risposta valida del backend.</Empty>}
    {(overview || tab === 'odds') && <div role="tabpanel" id={`research-panel-${tab}`} aria-labelledby={`research-tab-${tab}`} aria-busy={tab === 'odds' ? undefined : loading} tabIndex={0}>{tab === 'odds' && <ResearchOddsPanel />}{overview && <>{tab === 'history' && <HistoryPanel overview={overview} />}{tab === 'portfolios' && <PortfolioPanel overview={overview} revision={revision} />}{tab === 'markets' && <MarketsPanel markets={overview.markets} />}{tab === 'experiments' && <ResearchExperimentsPanel overview={overview} />}{tab === 'system' && <SystemPanel overview={overview} />}</>}</div>}
  </div>;
};

export default ResearchPage;
