import React from 'react';
import { ResearchOverview } from './researchTypes';
import { count, dateTime, finiteNumber } from './researchPresentation';
import { Metric } from './ResearchPrimitives';

const ResearchAutomationStatus = ({ status }: { status: ResearchOverview['status'] }) => (
  <section className="research-panel">
    <h2>Stato delle automazioni</h2>
    <p className="research-conclusion">
      Questa schermata descrive il codice corrente e lo stato del worker registrato nel database condiviso.
      La nightly pubblicata su GitHub e il collaudo remoto richiedono una verifica separata sul rispettivo servizio.
    </p>
    <dl className="research-system">
      <Metric label="Ambito della verifica" value={status?.automationScope === 'local_code'
        ? 'Codice e processo corrente' : 'Ambito non certificato'} />
      <Metric label="Verifica remota di GitHub e scheduler" value="Non verificata dal backend" />
      <Metric label="Nightly crea nuove puntate · codice corrente" value={status?.nightlyCreatesBets === false
        ? 'No' : status?.nightlyCreatesBets === true ? 'Sì · configurazione da correggere' : 'Non verificato'} />
      <Metric label="Vecchio percorso disabilitato · codice corrente" value={status?.legacyAutomationDisabled === true
        ? 'Sì' : status?.legacyAutomationDisabled === false ? 'Da disabilitare' : 'Non verificato'} />
      <Metric label="Scheduler T−15 · stato condiviso" value={status?.schedulerState === 'STALE'
        ? 'Segnale scaduto' : status?.schedulerEnabled === true
          ? 'Attivo' : status?.schedulerEnabled === false ? 'Fermo' : 'Non verificato'} />
      <Metric label="Ultimo segnale dello scheduler registrato" value={dateTime(status?.heartbeatAt)} />
      <Metric label="Ultima nightly completa riuscita" value={dateTime(status?.lastNightlyAt)} />
      <Metric label="Ultimo aggiornamento dei dati" value={dateTime(status?.lastDataUpdateAt)} />
      <Metric label="Tolleranza configurata" value={finiteNumber(status?.toleranceSeconds)
        ? `${status.toleranceSeconds} secondi` : 'Non disponibile'} />
      <Metric label="Stato API" value={status?.providerStatus || 'Non verificato'} />
      <Metric label="Ultima osservazione del provider" value={dateTime(status?.lastProviderAt)} />
      <Metric label="Freschezza quote" value={dateTime(status?.quotesFreshThrough)} />
      <Metric label="Stato database" value={status?.dbStatus || 'Non verificato'} />
      <Metric label="Configurazione del processo" value={status?.deployment === 'not_verified'
        ? 'Non verificata' : status?.deployment || 'Non verificata'} />
    </dl>
    <p className="research-help">
      Lo stato del worker deriva dal database condiviso. Per accertare che la vecchia nightly remota abbia smesso
      di registrare puntate servono il workflow pubblicato e i log delle esecuzioni su GitHub.
      Gli orari sono mostrati in Europe/Rome; il target è T−15 e una finestra persa resta mancata.
    </p>
    <h3>Consumo delle API quote</h3>
    <dl className="research-system">
      <Metric label="Crediti residui osservati" value={count(status?.apiQuota?.remaining)} />
      <Metric label="Crediti usati osservati" value={count(status?.apiQuota?.used)} />
      <Metric label="Costo dell’ultima richiesta" value={count(status?.apiQuota?.lastCost)} />
      <Metric label="Ultima misura della quota API" value={dateTime(status?.apiQuota?.observedAt)} />
    </dl>
    {!status?.apiQuota && <p className="research-help">
      Il provider non ha fornito una misura recente dei crediti in questo processo.
    </p>}
    {!!status?.blockers?.length && <div className="research-blockers" role="status">
      <h3>Requisiti ancora bloccati</h3>
      <ul>{status.blockers.map((blocker, index) => <li key={`${blocker}-${index}`}>{blocker}</li>)}</ul>
    </div>}
  </section>
);

export default ResearchAutomationStatus;
