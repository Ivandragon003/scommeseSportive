import React, { useEffect, useState } from 'react';
import { getResearchComparison } from '../../utils/researchApi';
import {
  ComparisonDecision, ComparisonPeriod, ComparisonPortfolio, PeriodBreakdown,
  ResearchComparison, ResearchComparisonQuery,
} from './researchComparisonTypes';
import { Badge, Empty, Metric } from './ResearchPrimitives';
import EquityChart from './ResearchEquityChart';
import { count, dateTime, decisionReason, finiteNumber, marketLabel, metric, money, percent } from './researchPresentation';

const PERIODS: Array<{ value: ComparisonPeriod; label: string }> = [
  { value: '7d', label: '7 giorni' }, { value: '30d', label: '30 giorni' },
  { value: '60d', label: '60 giorni' }, { value: '90d', label: '90 giorni' },
  { value: 'all', label: 'Intera simulazione' }, { value: 'custom', label: 'Periodo personalizzato' },
];

const protocolLabel = (value?: string) => value === 'prematch' ? 'Quota prepartita'
  : value === 't15' ? 'Protocollo storico T−15' : value ? `Protocollo registrato: ${value}` : 'Protocollo non registrato';

const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

const PeriodCard = ({ portfolio }: { portfolio: ComparisonPortfolio }) => (
  <article className="research-portfolio" aria-label={`Risultati periodo ${portfolio.family}`}>
    <h3>{portfolio.family === 'A' ? 'A · Statistico tradizionale' : 'C · Ibrido statistico + CatBoost'}</h3>
    {portfolio.initialized === false && <p>Portafoglio non inizializzato in questo database.</p>}
    <dl className="research-metrics">
      <Metric label="Profitto / perdita nel periodo" value={money(portfolio.profitCents)} />
      <Metric label="ROI sulle puntate liquidate" value={percent(portfolio.roi)} />
      <Metric label="Patrimonio a inizio periodo" value={money(portfolio.startEquityCents)} />
      <Metric label="Patrimonio a fine periodo" value={money(portfolio.endEquityCents)} />
      <Metric label="Puntate registrate" value={count(portfolio.betCount)} />
      <Metric label="Stake registrato" value={money(portfolio.stakeCents)} />
      <Metric label="Puntate liquidate" value={count(portfolio.settledCount)} />
      <Metric label="Stake liquidato" value={money(portfolio.settledStakeCents)} />
      <Metric label="Vinte (incluse mezze vincite)" value={count(portfolio.wonCount)} />
      <Metric label="Perse (incluse mezze perdite)" value={count(portfolio.lostCount)} />
      <Metric label="Rimborsate" value={count(portfolio.voidCount)} />
      <Metric label="Drawdown massimo nel periodo" value={percent(portfolio.maxDrawdown)} help="Massima discesa dal patrimonio più alto osservato nel periodo." />
    </dl>
  </article>
);

const EconomicBreakdown = ({ title, rows, markets = false }: { title: string; rows: PeriodBreakdown[]; markets?: boolean }) => (
  <details className="research-breakdown">
    <summary>{title}</summary>
    {rows.length ? <div className="research-table-wrap"><table className="fp-table">
      <caption>{title} nel periodo selezionato</caption>
      <thead><tr><th>Gruppo</th><th>Modello</th><th>Puntate registrate</th><th>Liquidate</th><th>Vinte</th><th>Perse</th><th>Stake liquidato</th><th>Profitto</th><th>ROI</th></tr></thead>
      <tbody>{rows.flatMap((row) => (['A', 'C'] as const).map((family) => <tr key={`${row.label}-${family}`}>
        <th scope="row">{markets ? marketLabel(row.label) : row.label}</th><td>{family}</td>
        <td>{count(row[family]?.betCount)}</td><td>{count(row[family]?.settledCount)}</td>
        <td>{count(row[family]?.wonCount)}</td><td>{count(row[family]?.lostCount)}</td>
        <td>{money(row[family]?.settledStakeCents)}</td><td>{money(row[family]?.profitCents)}</td><td>{percent(row[family]?.roi)}</td>
      </tr>))}</tbody>
    </table></div> : <Empty>Nessun risultato registrato per questo raggruppamento.</Empty>}
  </details>
);

const Decision = ({ decision }: { decision?: ComparisonDecision | null }) => {
  if (!decision) return <span>Decisione non registrata</span>;
  const quote = typeof decision.quote === 'object' ? decision.quote : undefined;
  const odds = typeof decision.quote === 'number' ? decision.quote : quote?.odds;
  return <>
    <strong>{decision.action === 'BET' ? decision.selection || 'Selezione non disponibile' : 'Nessuna puntata'}</strong>
    {decision.market && <small>{marketLabel(decision.market)}</small>}
    {decision.action === 'BET' && <small>Quota {metric(odds)} · {quote?.bookmaker || decision.bookmaker || 'Bookmaker non disponibile'}</small>}
    {quote?.source && <small>Fonte: {quote.source}</small>}
    {decision.action === 'BET' && <small>{protocolLabel(quote?.priceType)}</small>}
    {(quote?.updatedAt || quote?.capturedAt) && <small>Quota del {dateTime(quote.updatedAt || quote.capturedAt)}</small>}
    <small>{decisionReason(decision.reason)}</small>
  </>;
};

const ComparisonResults = ({ data }: { data: ResearchComparison }) => {
  const [family, setFamily] = useState('all');
  const a = data.portfolios.find((portfolio) => portfolio.family === 'A');
  const c = data.portfolios.find((portfolio) => portfolio.family === 'C');
  const bets = data.bets.rows.filter((bet) => family === 'all'
    || bet.family === family || bet.portfolioId === data.portfolios.find((portfolio) => portfolio.family === family)?.portfolioId);
  const differences = data.decisionDifferences;
  return <>
    <p className="research-help">Periodo: {data.period.label}. Orari in {data.period.timezone}.</p>
    <p className="research-conclusion" role="status">
      {data.leader === 'A' || data.leader === 'C' ? `Maggiore profitto virtuale nel periodo: modello ${data.leader}.`
        : data.leader === 'TIE' ? 'I due portafogli hanno lo stesso profitto virtuale nel periodo.'
          : 'Confronto economico non disponibile: dati contabili incompleti.'}
    </p>
    <p>Il risultato economico del periodo non dimostra superiorità statistica. C resta Challenger; log loss, Brier score e calibrazione sono nel benchmark storico.</p>
    <p className="research-help">Puntate e stake registrati si riferiscono alle decisioni del periodo. Profitto, ROI, vinte e perse si riferiscono alle liquidazioni avvenute nel periodo, anche per puntate precedenti. Il ROI divide il profitto per lo stake liquidato; senza liquidazioni resta non disponibile. Le mezze vincite e perdite sono incluse nei rispettivi conteggi.</p>
    <div className="research-portfolios">{[a, c].map((portfolio, index) => portfolio
      ? <PeriodCard key={portfolio.portfolioId} portfolio={portfolio} />
      : <Empty key={index}>Dati del portafoglio {index === 0 ? 'A' : 'C'} non disponibili.</Empty>)}</div>
    <EquityChart a={a?.equity} c={c?.equity} title="Evoluzione del capitale nel periodo" />
    <EconomicBreakdown title="Risultati per campionato" rows={data.byLeague} />
    <EconomicBreakdown title="Risultati per mercato" rows={data.byMarket} markets />
    <p className="research-help">Lo storico dei portafogli resta conservato. Il protocollo delle quote è mostrato quando registrato; le vecchie osservazioni non vengono rietichettate come decisioni notturne.</p>
    <h3>Decisioni a confronto</h3>
    <p>{count(differences.differentCount)} decisioni differenti su {count(differences.comparedCount)} partite confrontate.</p>
    {!!differences.incompleteCount && <p className="research-help">{count(differences.incompleteCount)} confronti incompleti: manca una decisione, non viene interpretata come astensione.</p>}
    {differences.rows.length ? <div className="research-table-wrap"><table className="fp-table">
      <caption>Decisioni differenti A/C registrate nel periodo</caption>
      <thead><tr><th>Partita</th><th>Modello A</th><th>Modello C</th><th>Registrazione</th></tr></thead>
      <tbody>{differences.rows.map((row, index) => <tr key={`${row.matchId}-${row.at}-${index}`}>
        <td><strong>{row.matchLabel || row.matchId || 'Partita non disponibile'}</strong>{row.league && <small>{row.league}</small>}{row.kickoffAt && <small>Inizio {dateTime(row.kickoffAt)}</small>}</td>
        <td><Decision decision={row.A} /></td><td><Decision decision={row.C} /></td><td>{dateTime(row.at)}</td>
      </tr>)}</tbody>
    </table></div> : <Empty>{differences.comparedCount > 0 ? 'Nessuna differenza fra le decisioni confrontabili del periodo.' : 'Nessuna coppia di decisioni A/C confrontabile nel periodo.'}</Empty>}
    {differences.truncated && <p className="research-help">Visualizzate {count(differences.rows.length)} di {count(differences.total)} righe. I conteggi del confronto comprendono tutte le decisioni del periodo.</p>}
    <div className="research-section-heading"><h3>Puntate virtuali prepartita</h3>
      <label className="research-filter">Portafoglio<select value={family} onChange={(event) => setFamily(event.target.value)}>
        <option value="all">A e C, mantenuti separati</option><option value="A">Portafoglio A</option><option value="C">Portafoglio C</option>
      </select></label>
    </div>
    {bets.length ? <div className="research-table-wrap"><table className="fp-table">
      <caption>Puntate registrate nel periodo; esiti alla fine del periodo</caption>
      <thead><tr><th>Modello</th><th>Partita e selezione</th><th>Stake</th><th>Quota e bookmaker</th><th>Esito</th><th>Profitto liquidato</th><th>Registrazione</th></tr></thead>
      <tbody>{bets.map((bet) => <tr key={bet.id}>
        <td>{bet.family || data.portfolios.find((portfolio) => portfolio.portfolioId === bet.portfolioId)?.family || 'Non disponibile'}</td>
        <td><strong>{bet.matchLabel || bet.matchId || 'Partita non disponibile'}</strong><small>{bet.league}</small>{bet.kickoffAt && <small>Inizio {dateTime(bet.kickoffAt)}</small>}{bet.market && <small>{marketLabel(bet.market)}</small>}<small>{bet.selection}</small></td>
        <td>{money(bet.stakeCents)}</td><td>{metric(bet.odds)}<small>{bet.quote?.bookmaker || bet.bookmaker || 'Bookmaker non disponibile'}</small>{bet.quote?.source && <small>Fonte: {bet.quote.source}</small>}<small>{protocolLabel(bet.quote?.priceType)}</small>{(bet.quote?.updatedAt || bet.quote?.capturedAt) && <small>Quota del {dateTime(bet.quote.updatedAt || bet.quote.capturedAt)}</small>}</td>
        <td><Badge state={bet.status} /></td><td>{finiteNumber(bet.profitCents) ? money(bet.profitCents) : 'Aperta a fine periodo'}</td>
        <td>{dateTime(bet.createdAt)}<small className="research-version">{bet.modelVersion}</small>{bet.settledAt && <small>Liquidata {dateTime(bet.settledAt)}</small>}</td>
      </tr>)}</tbody>
    </table></div> : <Empty>{data.bets.truncated ? 'Nessuna puntata di questo portafoglio nelle righe caricate; le metriche includono l’intero periodo.' : 'Nessuna puntata virtuale registrata per questa selezione.'}</Empty>}
    {data.bets.truncated && <p className="research-help">L’elenco contiene fino a {count(data.bets.rows.length)} delle {count(data.bets.total)} puntate del periodo, prima del filtro portafoglio. Le metriche e i raggruppamenti includono tutte le puntate.</p>}
  </>;
};

const ResearchComparisonPanel = ({ revision = 0 }: { revision?: number }) => {
  const [query, setQuery] = useState<ResearchComparisonQuery | null>({ period: '30d' });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<ResearchComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setData(null); setError(null);
    if (!query) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    getResearchComparison(query, controller.signal).then((result) => {
      if (active) setData(result);
    }).catch((failure) => {
      if (active) setError(failure?.response?.data?.error || failure?.message || 'Rendimenti non disponibili.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [query, revision, retry]);
  const custom = !query || query.period === 'custom';
  return <section className="research-panel" aria-labelledby="research-period-title" aria-busy={loading}>
    <div className="research-section-heading"><h2 id="research-period-title">Rendimento dei portafogli nel periodo</h2>
      <label className="research-filter">Periodo<select value={query?.period || 'custom'} onChange={(event) => {
        const period = event.target.value as ComparisonPeriod;
        setQuery(period === 'custom' ? null : { period });
      }}>{PERIODS.map((period) => <option key={period.value} value={period.value}>{period.label}</option>)}</select></label>
    </div>
    {custom && <form className="research-period-form" onSubmit={(event) => {
      event.preventDefault();
      if (!validDate(from) || !validDate(to) || from > to) {
        setError('Scegli due date valide, con la data iniziale precedente o uguale a quella finale.'); return;
      }
      setQuery({ period: 'custom', from, to });
    }}>
      <label className="research-filter">Dal<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></label>
      <label className="research-filter">Al<input type="date" value={to} onChange={(event) => setTo(event.target.value)} required /></label>
      <button className="fp-btn fp-btn-ghost" type="submit">Applica periodo</button>
      <p className="research-help">Entrambe le date sono incluse, secondo il calendario Europe/Rome.</p>
    </form>}
    {loading && <p role="status">Caricamento dei rendimenti del periodo…</p>}
    {error && <div className="fp-alert fp-alert-danger" role="alert"><p>{error}</p>{query && <button className="fp-btn fp-btn-ghost" type="button" onClick={() => setRetry((value) => value + 1)}>Riprova rendimenti</button>}</div>}
    {data && !loading && <ComparisonResults data={data} />}
    {!query && !error && <Empty>Seleziona le date e applica il periodo per leggere i risultati.</Empty>}
    {error && !data && <Empty>Saldi e risultati del periodo non vengono ricostruiti con dati dimostrativi.</Empty>}
  </section>;
};

export default ResearchComparisonPanel;
