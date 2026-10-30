import React, { useEffect, useState } from 'react';
import { getResearchOverview } from '../../utils/researchApi';
import {
  ComparisonBreakdown, EconomicMetrics, ProbabilityMetrics, ResearchBenchmarkReport, ResearchMarket,
  ResearchOverview,
} from './researchTypes';
import {
  breakdownLabel, confidenceInterval, count, dateTime, marketLabel,
  metric, money, percent, portfolioLabel,
} from './researchPresentation';
import { Badge, Empty, Metric } from './ResearchPrimitives';
import ResearchAutomationStatus from './ResearchAutomationStatus';
import ResearchExperimentsPanel from './ResearchExperimentsPanel';
import ResearchOddsPanel from './ResearchOddsPanel';
import EquityChart from './ResearchEquityChart';
import './research.css';

type ResearchTab = 'history' | 'markets' | 'experiments' | 'odds' | 'system';
const TABS: Array<{ id: ResearchTab; label: string }> = [
  { id: 'history', label: 'Storico' },
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
    <thead><tr><th>Misura</th><th>Backtest A</th><th>Backtest C</th></tr></thead>
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
    <section className="research-panel"><h2>Backtest economico storico</h2><p>Risultati del solo backtest. I saldi correnti e le puntate registrate sono in Budget e Giocate.</p>{report.economic ? <><EconomicTable a={report.economic.A} c={report.economic.C} /><EquityChart a={report.economic.A?.equity} c={report.economic.C?.equity} title="Patrimoni storici A e C" /></> : <Empty>Backtest economico non disponibile: nessun rendimento ricostruito da quote stimate.</Empty>}</section>
    <section className="research-panel"><h2>Decisioni differenti</h2>{differences ? <dl className="research-metrics research-metrics--decisions">{[
      ['Stessa puntata', differences.same], ['Puntate differenti', differences.different], ['Solo A', differences.onlyA], ['Solo C', differences.onlyC], ['Nessuna puntata', differences.neither],
    ].map(([label, value]) => <Metric key={String(label)} label={String(label)} value={count(value)} />)}</dl> : <Empty>Confronto delle decisioni non ancora disponibile.</Empty>}</section>
    {(report.byLeague?.length || report.byMarket?.length || report.bySeason?.length || report.byOddsBand?.length) ? <section className="research-panel"><h2>Stabilità e segmenti</h2><Breakdown title="Per campionato" rows={report.byLeague} /><Breakdown title="Per mercato" rows={report.byMarket} /><Breakdown title="Per stagione" rows={report.bySeason} /><Breakdown title="Per fascia di quota" rows={report.byOddsBand} /></section> : null}
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
  const [tab, setTab] = useState<ResearchTab>('history');
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
  return <div className="tool-page research-page"><header className="tool-page__header research-header"><div><span className="tool-page__eyebrow">Validazione</span><h1 className="tool-page__title">Confronto modelli</h1><p className="tool-page__subtitle">Modello statistico A e modello ibrido C: benchmark e validazione delle previsioni.</p></div>{tab !== 'odds' && <button type="button" className="fp-btn fp-btn-ghost" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{loading ? 'Caricamento…' : 'Aggiorna confronto'}</button>}</header>
    <p className="research-scope">I portafogli A/C e le puntate registrate sono gestiti nelle normali sezioni dell’app. Qui restano benchmark storici e controlli dei modelli.</p><nav className="research-scope" aria-label="Gestione portafogli A/C"><a className="fp-btn fp-btn-ghost" href="/budget">Apri Budget</a> <a className="fp-btn fp-btn-ghost" href="/bets">Apri Giocate</a> <a className="fp-btn fp-btn-ghost" href="/prediction-archive">Apri Archivio</a></nav>
    <div className="research-tabs" role="tablist" aria-label="Sezioni confronto modelli">{TABS.map((item, index) => <button type="button" key={item.id} role="tab" id={`research-tab-${item.id}`} aria-controls={`research-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      setTab(TABS[nextIndex].id); document.getElementById(`research-tab-${TABS[nextIndex].id}`)?.focus();
    }}>{item.label}</button>)}</div>
    {tab !== 'odds' && error && <div className="fp-alert fp-alert-danger research-error" role="alert"><strong>Confronto non aggiornato</strong><p>{error}</p>{overview && <small>Restano visibili i dati caricati il {dateTime(loadedAt)}.</small>}</div>}
    {tab !== 'odds' && loading && !overview && <p role="status" className="research-empty">Caricamento del confronto A/C…</p>}
    {tab !== 'odds' && !loading && !overview && error && <Empty>Non è possibile mostrare benchmark o stato dei modelli senza una risposta valida del backend.</Empty>}
    {(overview || tab === 'odds') && <div role="tabpanel" id={`research-panel-${tab}`} aria-labelledby={`research-tab-${tab}`} aria-busy={tab === 'odds' ? undefined : loading} tabIndex={0}>{tab === 'odds' && <ResearchOddsPanel />}{overview && <>{tab === 'history' && <HistoryPanel overview={overview} />}{tab === 'markets' && <MarketsPanel markets={overview.markets} />}{tab === 'experiments' && <ResearchExperimentsPanel overview={overview} />}{tab === 'system' && <SystemPanel overview={overview} />}</>}</div>}
  </div>;
};

export default ResearchPage;
