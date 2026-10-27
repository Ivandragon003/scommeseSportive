import React, { useEffect, useState } from 'react';
import { getResearchOddsStatus } from '../../utils/researchApi';
import { Empty, Metric } from './ResearchPrimitives';
import { count, dateTime, finiteNumber, percent } from './researchPresentation';
import {
  oddsEventLabel, oddsLimitationLabel, oddsOperationLabel, oddsProviderLabel, oddsReasonLabel,
  oddsStatusLabel, utcDateTime, validCacheRate,
} from './researchOddsPresentation';
import { ResearchOddsForecast, ResearchOddsProvider, ResearchOddsStatus } from './researchOddsTypes';

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
    <p className="research-help">L’acquisizione salvata non certifica l’età delle singole quote. Il percorso T−15 controlla separatamente l’aggiornamento di ogni mercato.</p>
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

const Forecast = ({ forecast }: { forecast: ResearchOddsForecast | null }) => {
  if (!forecast) return <section className="research-panel">
    <h2>Previsione del fabbisogno</h2><Empty>Non misurata: nessuna stima sul calendario disponibile.</Empty>
  </section>;
  const assumptions = forecast.assumptions;
  return <section className="research-panel">
    <h2>Previsione del fabbisogno</h2>
    <p className="research-conclusion">{forecast.completeCalendarVerified && forecast.futureKickoffsVerified
      ? 'Stima sul calendario disponibile.' : 'Stima sul calendario disponibile: incompleto oppure con orari futuri non verificati.'}</p>
    <p className="research-help">La proiezione riguarda i target decisionali restanti nel mese UTC. Non garantisce il consumo mensile e non rappresenta la quota effettiva del provider.</p>
    <dl className="research-system">
      <Metric label="Crediti stimati per i target restanti" value={count(forecast.estimatedCredits)} />
      <Metric label="Richieste HTTP stimate" value={count(forecast.estimatedHttpRequests)} />
      <Metric label="Totale mensile di pianificazione" value={count(forecast.projectedTotalCredits)} />
      <Metric label="Partite considerate nella stima" value={count(forecast.calendarFixtures)} />
      <Metric label="Gruppi campionato / orario" value={count(forecast.competitionKickoffGroups)} />
      <Metric label="Soglia temporale della stima" value={utcDateTime(forecast.through)} />
      <Metric label="Quota misurata associata alla proiezione" value={count(forecast.measuredQuota)} />
    </dl>
    {assumptions && <details className="research-breakdown"><summary>Ipotesi della stima</summary>
      {Array.isArray(assumptions) ? <ul className="research-notes">{assumptions.map((assumption, index) => <li key={`${assumption}-${index}`}>{assumption}</li>)}</ul>
        : <dl className="research-system">
          <Metric label="Margine di retry stimato" value={validCacheRate(assumptions.retryRate) ? percent(assumptions.retryRate) : '—'} />
          <Metric label="Numero di regioni ipotizzato" value={count(assumptions.regionCount)} />
          <Metric label="Mercati ipotizzati insieme" value={assumptions.markets?.length ? assumptions.markets.join(', ') : 'Non documentati'} />
          <Metric label="Modelli che condividono la richiesta" value={assumptions.sharedByModels?.length ? assumptions.sharedByModels.join(', ') : 'Non documentati'} />
          <Metric label="Finestra cache ipotizzata (secondi)" value={count(assumptions.cacheWindowSeconds)} />
        </dl>}
    </details>}
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
