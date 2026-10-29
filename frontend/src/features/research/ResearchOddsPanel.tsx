import React, { useEffect, useState } from 'react';
import { getResearchOddsStatus } from '../../utils/researchApi';
import { Empty, Metric } from './ResearchPrimitives';
import { count, dateTime, finiteNumber, percent } from './researchPresentation';
import {
  oddsEventLabel, oddsLimitationLabel, oddsOperationLabel, oddsProviderLabel, oddsReasonLabel,
  oddsStatusLabel, utcDateTime, validCacheRate,
} from './researchOddsPresentation';
import { NightlyDemandScenario, ResearchOddsForecast, ResearchOddsProvider, ResearchOddsStatus } from './researchOddsTypes';

const PAGE_SIZE = 20;
const accountKey = (value: { provider: string; accountScope: string }) => JSON.stringify([value.provider, value.accountScope]);
const accountLabel = (value: { provider: string; accountScope: string }) => `${oddsProviderLabel(value.provider)} · ${value.accountScope}`;

const Pagination = ({ label, page, pages, onChange }: {
  label: string; page: number; pages: number; onChange: (page: number) => void;
}) => pages > 1 ? <nav className="research-experiment-pagination" aria-label={label}>
  <button type="button" className="fp-btn fp-btn-ghost fp-btn-sm" disabled={page === 0} onClick={() => onChange(page - 1)}>Precedenti</button>
  <span>Pagina {page + 1} di {pages}</span>
  <button type="button" className="fp-btn fp-btn-ghost fp-btn-sm" disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}>Successivi</button>
</nav> : null;

const ProviderBudget = ({ provider }: { provider: ResearchOddsProvider }) => (
  <article className="research-portfolio research-odds-provider" aria-label={`Contabilità ${accountLabel(provider)}`}>
    <div className="research-section-heading">
      <h3>{oddsProviderLabel(provider.provider)}</h3>
      <span className="research-badge">{oddsStatusLabel(provider.status)}</span>
    </div>
    <p className="research-help">Ambito account: <span className="research-version">{provider.accountScope}</span></p>
    <dl className="research-metrics">
      <Metric label="Limite mensile di pianificazione" value={count(provider.monthlyLimit)} help="Configurazione interna, non quota residua del provider" />
      <Metric label="Disponibile per pianificare" value={count(provider.availableCredits)} help="Calcolo prudenziale interno del gestore" />
      <Metric label="Residui osservati dal provider" value={count(provider.observedRemaining)} />
      <Metric label="Usati osservati dal provider" value={count(provider.observedUsed)} />
    </dl>
    <p className="research-help">Ultima misura della quota API: {dateTime(provider.observedAt)}.<br />Ultimo recupero del provider: {dateTime(provider.lastFetch)}.<br />Ultima acquisizione quote con bookmaker: {provider.actualCoverageAsOf ? dateTime(provider.actualCoverageAsOf) : 'Nessuna osservazione quote'}.</p>
    <p className="research-help">L’acquisizione salvata non certifica l’età delle singole quote. La nightly controlla l’aggiornamento di ogni mercato al momento della decisione notturna.</p>
    <details className="research-breakdown">
      <summary>Contabilità dei crediti e verifiche</summary>
      <dl className="research-system">
        <Metric label="Riserva prudenziale" value={count(provider.reserveCredits)} />
        <Metric label="Crediti stimati nelle richieste" value={count(provider.plannedCredits)} />
        <Metric label="Addebiti interni" value={count(provider.chargedCredits)} help="Comprendono le stime prudenziali degli esiti non misurabili" />
        <Metric label="Crediti prenotati" value={count(provider.reservedCredits)} />
        <Metric label="Crediti da risposte misurate" value={count(provider.measuredCredits)} />
        <Metric label="Addebiti senza costo misurato" value={count(provider.unknownChargedCredits)} />
        {finiteNumber(provider.carryoverCredits) && provider.carryoverCredits > 0 && <Metric label="Crediti impegnati da richieste precedenti" value={count(provider.carryoverCredits)} help="Impegno residuo conservato nel nuovo mese dal registro prudenziale" />}
        <Metric label="Richieste registrate nel mese" value={count(provider.requests)} />
        <Metric label="Errori registrati nel mese" value={count(provider.failures)} />
        <Metric label="Pianificazione ancorata a misure" value={provider.planningVerified === true ? 'Sì' : provider.planningVerified === false ? 'No' : 'Non documentato'} />
        <Metric label="Controllo mensile del gestore superato" value={provider.resetConfirmed === true ? 'Sì' : provider.resetConfirmed === false ? 'No' : 'Non documentato'} help="Conferma interna per consentire richieste, non prova dell’istante di reset del provider" />
      </dl>
    </details>
    <details className="research-breakdown">
      <summary>Bookmaker e mercati osservati</summary>
      <p className="research-help">Elenchi ricavati dai dati salvati. La copertura attuale richiede quote aggiornate.</p>
      <p className="research-help">Ultima osservazione dei metadati: {dateTime(provider.actualCoverageAsOf)}.{provider.actualCoverageSource === 'last_20_cached_responses' && ' Campione limitato alle ultime 20 risposte salvate.'}</p>
      <h4>Bookmaker presenti nei metadati</h4>
      {provider.actualBookmakers?.length ? <ul className="research-odds-tags">{provider.actualBookmakers.map((bookmaker) => <li key={bookmaker}>{bookmaker}</li>)}</ul>
        : <p>Bookmaker osservati non documentati in questo stato.</p>}
      <h4>Mercati presenti nei metadati</h4>
      {provider.actualMarkets?.length ? <ul className="research-odds-tags">{provider.actualMarkets.map((market) => <li key={market}>{market}</li>)}</ul>
        : <p>Mercati osservati non documentati in questo stato.</p>}
    </details>
  </article>
);

const BudgetScenario = ({ title, scenario }: { title: string; scenario?: NightlyDemandScenario }) => (
  <article className="research-portfolio" aria-label={title}><h3>{title}</h3>
    <dl className="research-metrics">
      <Metric label="Capacità residua ipotizzata" value={count(scenario?.availableCredits)} />
      <Metric label="Crediti ammessi nello scenario" value={count(scenario?.admittedCredits)} />
      <Metric label="Gruppi nightly ammessi" value={count(scenario?.admittedGroups)} />
      <Metric label="Gruppi nightly esclusi" value={count(scenario?.skippedGroups)} />
      <Metric label="Partite del calendario entro il budget" value={count(scenario?.assumedCoveredFixtures)} />
      <Metric label="Partite del calendario fuori budget" value={count(scenario?.skippedFixtures)} />
    </dl>
  </article>
);

const Forecast = ({ forecast }: { forecast: ResearchOddsForecast | null }) => {
  if (!forecast) return <section className="research-panel">
    <h2>Previsione del fabbisogno nightly</h2><Empty>Non disponibile: nessuna stima sul calendario ricevuta.</Empty>
  </section>;
  if (forecast.mode !== 'NIGHTLY' || forecast.scope !== 'remaining_scheduled_nightly_runs_in_current_utc_month') {
    return <section className="research-panel"><h2>Previsione del fabbisogno nightly</h2>
      <Empty>Il formato ricevuto non descrive le finestre della nuova nightly. Nessun conteggio viene ricostruito dal precedente protocollo.</Empty>
    </section>;
  }
  const assumptions = forecast.assumptions;
  const schedule = finiteNumber(assumptions?.hour) && finiteNumber(assumptions?.minute)
    ? `${String(assumptions.hour).padStart(2, '0')}:${String(assumptions.minute).padStart(2, '0')}` : 'Non documentato';
  return <section className="research-panel">
    <h2>Previsione del fabbisogno nightly</h2>
    <p className="research-conclusion">{forecast.completeCalendarVerified && forecast.futureKickoffsVerified
      ? 'Stima sul calendario disponibile.' : 'Stima sul calendario disponibile: incompleto oppure con orari futuri non verificati.'}</p>
    <p className="research-help">La proiezione raggruppa per campionato e finestra notturna, con una richiesta condivisa da A/C. Considera le nightly programmate restanti nel mese UTC della richiesta, non gruppi per orario del calcio d’inizio. Non misura il consumo o la quota effettiva del provider.</p>
    <dl className="research-system">
      <Metric label="Crediti stimati per le nightly restanti" value={count(forecast.estimatedCredits)} />
      <Metric label="Richieste HTTP stimate" value={count(forecast.estimatedHttpRequests)} />
      <Metric label="Crediti base senza retry" value={count(forecast.baseCredits)} />
      <Metric label="Crediti aggiuntivi ipotizzati per retry" value={count(forecast.retryCreditAllowance)} />
      <Metric label="Totale mensile di pianificazione" value={count(forecast.projectedTotalCredits)} />
      <Metric label="Partite considerate nella stima" value={count(forecast.calendarFixtures)} />
      <Metric label="Gruppi campionato / finestra nightly" value={count(forecast.competitionNightlyGroups)} />
      <Metric label="Prossima nightly inclusa nella stima" value={dateTime(forecast.nextScheduledAt)} />
      <Metric label="Soglia temporale della stima · UTC" value={utcDateTime(forecast.through)} />
      <Metric label="Quota misurata associata alla proiezione" value={count(forecast.measuredQuota)} />
      <Metric label="Registrazioni nightly dichiarate nel backend" value={forecast.enabled === true ? 'Abilitate' : forecast.enabled === false ? 'Disabilitate' : 'Non verificate'} />
    </dl>
    <p className="research-help">Il calendario vuoto produce zero gruppi stimati, non una misura di zero consumo del provider. L’ultima finestra può includere partite del mese successivo; ritardi, run saltati o supplementari e altre richieste possono cambiare la domanda.</p>
    {assumptions && <details className="research-breakdown"><summary>Ipotesi della stima nightly</summary>
      <dl className="research-system">
        <Metric label="Margine di retry stimato" value={validCacheRate(assumptions.retryRate) ? percent(assumptions.retryRate) : '—'} />
        <Metric label="Gruppi con un retry ipotizzato" value={count(assumptions.retryGroups)} />
        <Metric label="Numero di regioni ipotizzato" value={count(assumptions.regionCount)} />
        <Metric label="Mercati ipotizzati insieme" value={assumptions.markets?.length ? assumptions.markets.join(', ') : 'Non documentati'} />
        <Metric label="Modelli che condividono la richiesta" value={assumptions.sharedByModels?.length ? assumptions.sharedByModels.join(', ') : 'Non documentati'} />
        <Metric label="Fuso della programmazione" value={assumptions.scheduleTimezone || 'Non documentato'} />
        <Metric label="Orario locale ipotizzato" value={schedule} />
        <Metric label="Fuso del mese contabile" value={assumptions.accountingTimezone || 'Non documentato'} />
        <Metric label="Finestra delle partite" value={assumptions.windowHours === null ? 'Fino alla prossima nightly prevista'
          : finiteNumber(assumptions.windowHours) ? `${count(assumptions.windowHours)} ore` : 'Non documentata'} />
      </dl>
      <p className="research-help">Le leghe senza incontri non richiedono un feed. Il retry è un’ipotesi di capacità, non un tasso di guasto misurato; numero di modelli e partite della stessa lega/finestra non moltiplicano le richieste.</p>
    </details>}
    <details className="research-breakdown"><summary>Scenari di capacità entro il budget</summary>
      <dl className="research-system">
        <Metric label="Limite mensile interno" value={count(forecast.budget?.monthlyLimit)} />
        <Metric label="Riserva protetta per richieste informative" value={count(forecast.budget?.reserveCredits)} />
        <Metric label="Limite ordinario di pianificazione" value={count(forecast.budget?.ordinaryMonthlyLimit)} />
        <Metric label="Limite essenziale di pianificazione" value={count(forecast.budget?.essentialMonthlyLimit)} />
      </dl>
      <p className="research-help">La nightly è essenziale e può usare la riserva entro il limite totale. La capacità è una stima prudenziale del gestore, non il saldo osservato del provider. Le partite entro budget non rappresentano quote disponibili o copertura reale delle puntate.</p>
      <div className="research-portfolios"><BudgetScenario title="Scenario ordinario" scenario={forecast.ordinaryScenario} /><BudgetScenario title="Scenario essenziale nightly" scenario={forecast.essentialScenario} /></div>
    </details>
  </section>;
};

const OddsStatusContent = ({ data }: { data: ResearchOddsStatus }) => {
  const [scope, setScope] = useState('all');
  const [usagePage, setUsagePage] = useState(0);
  const [eventPage, setEventPage] = useState(0);
  const scopes = new Map<string, { provider: string; accountScope: string }>();
  for (const row of [...data.providers, ...(data.configuredProviders || []), ...data.usage, ...data.events]) scopes.set(accountKey(row), row);
  const usage = data.usage.filter((row) => scope === 'all' || accountKey(row) === scope);
  const events = data.events.filter((row) => scope === 'all' || accountKey(row) === scope);
  const usagePages = Math.ceil(usage.length / PAGE_SIZE), eventPages = Math.ceil(events.length / PAGE_SIZE);
  const currentUsagePage = Math.min(usagePage, Math.max(0, usagePages - 1));
  const currentEventPage = Math.min(eventPage, Math.max(0, eventPages - 1));
  const cache = data.cache;
  const admitted = finiteNumber(cache?.hits) && finiteNumber(cache?.fetchReservations) ? cache.hits + cache.fetchReservations : undefined;
  return <>
    <section className="research-panel">
      <h3>Periodo e cache</h3>
      <dl className="research-system">
        <Metric label="Mese contabile locale" value={/^\d{4}-\d{2}$/.test(data.month) ? data.month : 'Non disponibile'} />
        <Metric label="Prossima soglia di pianificazione · UTC" value={utcDateTime(data.resetAt)} />
        <Metric label="Stato letto dal database" value={dateTime(data.observedAt)} />
        <Metric label="Hit cache / richieste ammesse (90 giorni)" value={validCacheRate(cache?.hitRate) ? percent(cache.hitRate) : '—'} />
        <Metric label="Risposte da cache (90 giorni)" value={count(cache?.hits)} />
        <Metric label="Prenotazioni di rete (90 giorni)" value={count(cache?.fetchReservations)} />
      </dl>
      <p className="research-help">Il tasso usa hit cache e prenotazioni di rete{finiteNumber(admitted) ? ` (${count(admitted)} in totale)` : ''}. Rifiuti e controlli in attesa sono esclusi. Una prenotazione non prova che una chiamata HTTP sia stata inviata, per esempio dopo un arresto.</p>
      <p className="research-help">La soglia del primo giorno del mese UTC è una convenzione locale: il fuso e l’istante del reset del provider non sono garantiti da questa data. Le osservazioni sono mostrate in Europe/Rome.</p>
    </section>
    <section className="research-panel">
      <h3>Configurazione dei provider</h3>
      {data.configuredProviders?.length ? <ul className="research-odds-configuration">{data.configuredProviders.map((provider) => <li key={accountKey(provider)}>
        <strong>{accountLabel(provider)}</strong><span>{oddsStatusLabel(provider.status)}</span>
        <p>Credenziali configurate: {provider.configured ? 'sì' : 'no'}. {provider.note}</p>
      </li>)}</ul> : <Empty>Configurazione dei provider non documentata nello stato ricevuto.</Empty>}
      <h4>Fallback automatico</h4>
      {data.fallback ? <p>{oddsStatusLabel(data.fallback.status)}{data.fallback.provider ? ` · ${oddsProviderLabel(data.fallback.provider)}` : ''}. {data.fallback.reason}</p>
        : <p>Disponibilità di un fallback non documentata in questo stato.</p>}
    </section>
    <section className="research-panel">
      <h3>Crediti per provider e ambito account</h3>
      <p>I limiti e il disponibile del gestore sono pianificazione interna. I residui effettivi del provider compaiono soltanto se sono stati osservati nelle sue risposte.</p>
      {data.providers.length ? <div className="research-portfolios">{data.providers.map((provider) => <ProviderBudget key={accountKey(provider)} provider={provider} />)}</div>
        : <><Empty>Nessuna contabilità di consumo registrata per questo mese. Il saldo del provider resta sconosciuto.</Empty>
          <p className="research-help">Bookmaker e mercati osservati non documentati in questo stato.</p></>}
    </section>
    <Forecast forecast={data.plannedForecast} />
    <section className="research-panel">
      <div className="research-section-heading"><h3>Consumi e richieste saltate</h3>
        <label className="research-filter">Provider / ambito
          <select value={scope} onChange={(event) => { setScope(event.target.value); setUsagePage(0); setEventPage(0); }}>
            <option value="all">Tutti gli ambiti, mantenuti separati</option>
            {Array.from(scopes.entries()).map(([key, provider]) => <option key={key} value={key}>{accountLabel(provider)}</option>)}
          </select>
        </label>
      </div>
      <p className="research-help">I consumi per funzione e gli eventi seguono la finestra documentata nei limiti della vista. I costi di una richiesta con più mercati restano associati all’intero gruppo.</p>
      {usage.length ? <>
        <div className="research-table-wrap"><table className="fp-table">
          <caption>Richieste registrate per funzione e insieme di mercati</caption>
          <thead><tr><th>Provider / ambito</th><th>Funzione / endpoint</th><th>Mercati richiesti insieme</th><th>Richieste</th><th>Crediti stimati</th><th>Addebiti interni</th><th>Crediti misurati</th></tr></thead>
          <tbody>{usage.slice(currentUsagePage * PAGE_SIZE, (currentUsagePage + 1) * PAGE_SIZE).map((row, index) => <tr key={`${accountKey(row)}-${row.endpoint}-${index}`}>
            <td>{accountLabel(row)}</td><td><strong>{oddsOperationLabel(row.operation)}</strong><small className="research-version">{row.endpoint}</small></td>
            <td>{row.markets?.length ? row.markets.join(', ') : 'Nessun mercato specificato'}</td>
            <td>{count(row.requests)}</td><td>{count(row.plannedCredits)}</td><td>{count(row.chargedCredits)}</td><td>{count(row.measuredCredits)}</td>
          </tr>)}</tbody>
        </table></div>
        <Pagination label="Pagine dei consumi API" page={currentUsagePage} pages={usagePages} onChange={setUsagePage} />
      </> : <Empty>Nessuna richiesta per funzione registrata per l’ambito selezionato.</Empty>}
      <h4>Eventi e motivi delle richieste saltate</h4>
      {events.length ? <>
        <div className="research-table-wrap"><table className="fp-table">
          <caption>Eventi del gestore e motivi dei rifiuti</caption>
          <thead><tr><th>Provider / ambito</th><th>Evento</th><th>Motivo</th><th>Numero</th><th>Ultimo evento</th></tr></thead>
          <tbody>{events.slice(currentEventPage * PAGE_SIZE, (currentEventPage + 1) * PAGE_SIZE).map((row, index) => <tr key={`${accountKey(row)}-${row.type}-${row.reason}-${index}`}>
            <td>{accountLabel(row)}</td><td>{oddsEventLabel(row.type)}</td><td>{oddsReasonLabel(row.reason)}</td><td>{count(row.count)}</td><td>{dateTime(row.lastAt)}</td>
          </tr>)}</tbody>
        </table></div>
        <Pagination label="Pagine degli eventi API" page={currentEventPage} pages={eventPages} onChange={setEventPage} />
      </> : <Empty>Nessun evento o rifiuto registrato per l’ambito selezionato.</Empty>}
    </section>
    {!!data.limitations?.length && <section className="research-panel"><details className="research-breakdown">
      <summary>Limiti delle misure e della pianificazione</summary>
      <ul className="research-notes">{data.limitations.map((limitation, index) => <li key={`${limitation}-${index}`}>{oddsLimitationLabel(limitation)}</li>)}</ul>
    </details></section>}
  </>;
};

const ResearchOddsPanel = () => {
  const [data, setData] = useState<ResearchOddsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoading(true); setError(null);
    getResearchOddsStatus(controller.signal).then((next) => { if (active) setData(next); })
      .catch((failure) => { if (active) setError(failure?.response?.data?.error || failure?.message || 'Stato delle API quote non disponibile.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [revision]);
  return <div className="research-stack research-odds">
    <section className="research-panel">
      <div className="research-section-heading"><h2>Stato API quote</h2>
        <button type="button" className="fp-btn fp-btn-ghost" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{loading ? 'Caricamento stato…' : 'Aggiorna stato quote'}</button>
      </div>
      <p>Questa vista legge lo stato salvato nel database. L’apertura e l’aggiornamento non interrogano i provider e non registrano puntate.</p>
      {error && <div className="fp-alert fp-alert-danger research-error" role="alert"><strong>Stato quote non aggiornato</strong><p>{error}</p>{data && <small>Restano visibili i dati letti il {dateTime(data.observedAt)}.</small>}</div>}
      {loading && !data && <p role="status">Caricamento dello stato delle API quote…</p>}
      {!loading && !data && error && <Empty>Consumi, saldo e copertura restano sconosciuti senza una risposta valida.</Empty>}
    </section>
    {data && <div className="research-stack" aria-busy={loading}><OddsStatusContent data={data} /></div>}
  </div>;
};

export default ResearchOddsPanel;
