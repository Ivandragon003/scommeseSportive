import React from 'react';
import { ResearchOverview } from './researchTypes';
import { count, dateTime } from './researchPresentation';
import { Metric } from './ResearchPrimitives';

const booleanLabel = (value?: boolean | null) => value === true ? 'Sì' : value === false ? 'No' : 'Non verificato';
const nightlyState = (value?: string) => ({
  DISABLED: 'Disabilitata nella configurazione web', NOT_OBSERVED: 'Non ancora osservata',
  PENDING: 'In attesa', RUNNING: 'In esecuzione', SUCCESS: 'Riuscita', FAILED: 'Fallita', MISSED: 'Esecuzione attesa mancante',
}[value || ''] || 'Non ancora osservata');

export const nightlyReferenceTime = (value: unknown): string | null => {
  if (!(value instanceof Date) && (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T.*(?:z|[+-]\d{2}:\d{2})$/i.test(value))) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
};

const ResearchAutomationStatus = ({ status }: { status: ResearchOverview['status'] }) => {
  const nightly = status?.nightly;
  const run = nightly?.lastRun;
  const metrics = nightly?.metrics;
  const referenceTime = nightlyReferenceTime(nightly?.expectedAt);
  return <section className="research-panel">
    <h2>Stato delle automazioni</h2>
    <p className="research-conclusion">Nightly Pre-Match Virtual Betting</p>
    <p>La nightly aggiorna i dati e valuta le puntate virtuali A/C prima delle partite. Questa schermata legge le esecuzioni registrate nel database; la configurazione dichiarata dal backend web non certifica i secret o il workflow pubblicato su GitHub.</p>
    <dl className="research-system">
      <Metric label="Abilitazione dichiarata dal backend web" value={status?.mode === 'NIGHTLY_PRE_MATCH' ? booleanLabel(status?.schedulerEnabled) : 'Non verificato'} />
      <Metric label="Registrazioni abilitate nell’ultimo job osservato" value={booleanLabel(nightly?.executionEnabled ?? run?.summary?.enabled)} />
      <Metric label="Stato nightly osservato" value={nightlyState(status?.schedulerState)} />
      <Metric label="Ultima elaborazione virtuale avviata" value={dateTime(run?.startedAt)} />
      <Metric label="Ultima elaborazione virtuale terminata" value={dateTime(run?.endedAt)} />
      <Metric label="Esito dell’ultima elaborazione" value={!run ? 'Non disponibile' : run.success === true ? 'Riuscita' : run.success === false ? 'Fallita' : 'In esecuzione'} />
      <Metric label="Ultima nightly manutenzione completa riuscita" value={dateTime(status?.lastNightlyAt)} />
      <Metric label="Ultimo aggiornamento dei dati" value={dateTime(status?.lastDataUpdateAt)} />
      <Metric label="Esecuzione notturna attesa" value={dateTime(nightly?.expectedAt)} />
      <Metric label="Prossima esecuzione prevista" value={dateTime(nightly?.nextAt)} />
      <Metric label="Partite analizzate" value={count(metrics?.analyzedMatches)} />
      <Metric label="Puntate virtuali registrate" value={count(metrics?.registeredBets)} />
      <Metric label="Partite saltate" value={count(metrics?.skippedMatches)} />
      <Metric label="Partite perse per ritardo" value={count(metrics?.missedMatches)} />
      <Metric label="Errori dell’elaborazione" value={count(metrics?.errors)} />
      <Metric label="Errori API" value={count(metrics?.apiErrors)} />
      <Metric label="Puntate controllate per liquidazione" value={count(metrics?.settlement?.checked)} />
      <Metric label="Puntate liquidate nell’ultimo job" value={count(metrics?.settlement?.settled)} />
      <Metric label="Liquidazioni ancora in attesa" value={count(metrics?.settlement?.unresolved)} />
      <Metric label="Percorso legacy disabilitato" value={booleanLabel(status?.legacyAutomationDisabled)} />
      <Metric label="Stato API" value={status?.providerStatus || 'Non verificato'} />
      <Metric label="Ultima osservazione del provider" value={dateTime(status?.lastProviderAt)} />
      <Metric label="Stato database" value={status?.dbStatus || 'Non verificato'} />
    </dl>
    <p className="research-help">{referenceTime ? <>Orario di riferimento: {referenceTime} Europe/Rome, con ora legale.</> : <>Orario non disponibile.</>} Il timestamp effettivo del job determina le decisioni; un’esecuzione mancata non genera puntate retroattive. Le osservazioni non misurate restano non disponibili.</p>
    {nightly?.overdue && <div className="research-blockers" role="status"><h3>Nightly attesa non osservata</h3><p>È trascorsa la tolleranza prevista: controllare l’esecuzione programmata su GitHub.</p></div>}
    {run?.error && <p className="fp-alert fp-alert-danger">Ultimo errore registrato: {run.error}</p>}
    <h3>Consumo delle API quote</h3>
    <dl className="research-system">
      <Metric label="Crediti residui osservati" value={count(status?.apiQuota?.remaining)} />
      <Metric label="Crediti usati osservati" value={count(status?.apiQuota?.used)} />
      <Metric label="Costo dell’ultima richiesta" value={count(status?.apiQuota?.lastCost)} />
      <Metric label="Ultima misura della quota API" value={dateTime(status?.apiQuota?.observedAt)} />
    </dl>
    {!status?.apiQuota && <p className="research-help">Il database non contiene una misura recente dei crediti del provider.</p>}
    {!!status?.blockers?.length && <div className="research-blockers" role="status">
      <h3>Problemi tecnici da verificare</h3>
      <ul>{status.blockers.map((blocker, index) => <li key={`${blocker}-${index}`}>{blocker}</li>)}</ul>
    </div>}
  </section>;
};

export default ResearchAutomationStatus;
