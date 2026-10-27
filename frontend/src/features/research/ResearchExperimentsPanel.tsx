import React, { useState } from 'react';
import { Empty, Metric } from './ResearchPrimitives';
import { confidenceInterval, count, dateTime, finiteNumber, marketLabel, metric } from './researchPresentation';
import { ProbabilityMetrics, ResearchExperiment, ResearchOverview } from './researchTypes';

const methodLabel = (value: string) => ({
  intensity_correction: 'Correzione delle intensità',
  probability_correction: 'Correzione delle probabilità',
  calibrated_ensemble: 'Ensemble calibrato',
  feature_ablation: 'Ablazione delle feature',
  feature_importance: 'Importanza delle feature',
  calibration_diagnosis: 'Diagnosi della calibrazione',
  no_ml_control: 'Controllo senza ML',
  historical_snapshot_replay: 'Confronto su quote osservate',
}[value] || value.replace(/_/g, ' '));

const featureGroupLabel = (value: string) => ({
  basic: 'Base', basic_plus_xg: 'Base + xG e xGA', basic_plus_recent: 'Base + forma recente',
  basic_plus_elo: 'Base + Elo', basic_plus_venue: 'Base + casa e trasferta', full: 'Tutte le feature',
  no_ml_control: 'Controllo senza ML',
  reduced_stable_selection_groups: 'Gruppi scelti nella selezione',
  reduced_stable_selection_features: 'Feature scelte nella selezione',
  reduced_history_730_days: 'Etichette di training degli ultimi 730 giorni',
  reduced_temporal_half_life_365_days: 'Peso del training dimezzato dopo 365 giorni',
}[value] || value.replace(/_/g, ' '));

const settingValueLabel = (value: string) => ({
  identity: 'Nessuna calibrazione aggiuntiva',
  legacy_family_isotonic_normalized: 'Isotonica per famiglia storica con normalizzazione',
  isotonic_1x2_coherent: 'Isotonica 1X2 coerente',
  temperature_joint_coherent: 'Temperatura della distribuzione congiunta',
  'Unadjusted descriptive changes only: league composition, partial seasons and sampling uncertainty can explain differences; no causal structural break is established.': 'Le variazioni sono descrittive: composizione delle leghe, stagioni parziali e incertezza del campione possono spiegare le differenze. Non dimostrano un cambiamento strutturale causale.',
}[value] || value);

const settingLabel = (value: string) => ({
  iterations: 'Iterazioni', depth: 'Profondità', learningRate: 'Tasso di apprendimento',
  learning_rate: 'Tasso di apprendimento', l2LeafReg: 'Regolarizzazione', randomSeed: 'Seed',
  random_seed: 'Seed', threadCount: 'Thread', window: 'Finestra storica', seasons: 'Stagioni',
  minMatches: 'Campione minimo', method: 'Metodo', sampleSize: 'Osservazioni', n: 'Osservazioni',
  version: 'Versione', fittedBefore: 'Calibratore stimato prima di', phase: 'Fase',
  trainingHistoryDays: 'Età massima delle etichette di training (giorni)',
  timeHalfLifeDays: 'Giorni per dimezzare il peso del training',
  baselineJointProxyMismatch: 'Coerenza della baseline congiunta',
  maximum1x2AbsoluteDifference: 'Scarto massimo 1X2',
  meanMaximum1x2AbsoluteDifference: 'Scarto massimo medio 1X2',
  nonzeroRowsAbove1eMinus8: 'Osservazioni con differenza oltre 1e-8',
  baselineSerializationMaximumAbsoluteDifference: 'Scarto massimo nella ricostruzione della baseline',
  counts: 'Numerosità', eligible: 'Partite ammissibili', features: 'Feature',
  raw: 'Partite importate', rawCompleted: 'Partite concluse',
  descriptiveSeasonDrift: 'Variazioni descrittive fra stagioni', interpretation: 'Interpretazione',
  referenceSeason: 'Stagione di riferimento', development: 'Sviluppo', from: 'Da', to: 'A',
  idHash: 'Hash degli identificativi', independentFutureTestAvailable: 'Nuovo test futuro indipendente',
  protectedOverlap: 'Intersezione con il test protetto', duplicates: 'Duplicati', fixtures: 'Partite',
  matchIds: 'Identificativi partita', predictionIds: 'Identificativi previsione', rawMatchIds: 'Identificativi partita importati',
}[value] || value.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));

const scalar = (value: unknown): string | null => {
  if (typeof value === 'string') return settingValueLabel(value);
  if (finiteNumber(value)) return metric(value);
  if (typeof value === 'boolean') return value ? 'Sì' : 'No';
  return null;
};

/** Show bounded metadata, never a raw JSON dump or arrays of model predictions. */
const settingRows = (value: unknown, prefix = '', depth = 0): Array<[string, string]> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const result: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    const label = prefix ? `${prefix} · ${settingLabel(key)}` : settingLabel(key);
    const simple = scalar(item);
    if (item === null) result.push([label, '—']);
    else if (simple !== null) result.push([label, simple]);
    else if (Array.isArray(item) && item.length <= 20 && item.every((entry) => scalar(entry) !== null)) {
      result.push([label, item.length ? item.map(scalar).join(', ') : 'Nessun elemento']);
    } else if (depth < 1) result.push(...settingRows(item, label, depth + 1));
  }
  return result.slice(0, 20);
};

const Settings = ({ label, value }: { label: string; value: unknown }) => {
  const text = scalar(value);
  const rows = settingRows(value);
  return <section className="research-experiment-settings" aria-label={label}>
    <h4>{label}</h4>
    {text !== null ? <p>{text}</p> : rows.length ? <dl className="research-evidence">
      {rows.map(([name, setting], index) => <Metric key={`${name}-${index}`} label={name} value={setting} />)}
    </dl> : <p className="research-help">{value == null ? 'Non disponibile.' : 'Dettagli tecnici conservati nel report dell’esperimento.'}</p>}
  </section>;
};

const DevelopmentMetrics = ({ a, c }: { a?: ProbabilityMetrics; c?: ProbabilityMetrics }) => (
  <div className="research-table-wrap">
    <table className="fp-table research-compare-table">
      <caption>Metriche sul campione di sviluppo; non costituiscono un nuovo test indipendente</caption>
      <thead><tr><th>Misura</th><th>A</th><th>C sperimentale</th></tr></thead>
      <tbody>{[
        { label: 'Osservazioni', key: 'n' as const, format: count },
        { label: 'Log loss', key: 'logLoss' as const, format: metric },
        { label: 'Brier score', key: 'brier' as const, format: metric },
        { label: 'Errore di calibrazione', key: 'ece' as const, format: metric },
      ].map(({ label, key, format }) => <tr key={key}>
        <th scope="row">{label}</th><td>{format(a?.[key])}</td><td>{format(c?.[key])}</td>
      </tr>)}</tbody>
    </table>
  </div>
);

const DevelopmentIntervals = ({ intervals }: { intervals?: ResearchExperiment['report']['pairedCI'] }) => (
  <dl className="research-paired">
    <Metric label="IC log loss C − A" value={confidenceInterval(intervals?.logLoss) || '—'} />
    <Metric label="IC Brier C − A" value={confidenceInterval(intervals?.brier) || '—'} />
    <Metric label="IC log loss per settimane C − A" value={confidenceInterval(intervals?.weeklyLogLoss) || '—'} />
    <Metric label="IC Brier per settimane C − A" value={confidenceInterval(intervals?.weeklyBrier) || '—'} />
  </dl>
);

const SegmentMetrics = ({ label, groups, markets = false }: {
  label: string;
  groups?: ResearchExperiment['report']['byLeague'];
  markets?: boolean;
}) => {
  if (!groups || !Object.keys(groups).length) return null;
  return <details className="research-breakdown">
    <summary>{label}</summary>
    <div className="research-table-wrap"><table className="fp-table">
      <caption>{label}: osservazioni e metriche di sviluppo</caption>
      <thead><tr><th>Gruppo</th><th>N A</th><th>N C</th><th>Log loss A</th><th>Log loss C</th><th>Brier A</th><th>Brier C</th></tr></thead>
      <tbody>{Object.entries(groups).map(([group, values]) => <tr key={group}>
        <th scope="row">{markets ? marketLabel(group) : group}</th>
        <td>{count(values.A?.n)}</td><td>{count(values.C?.n)}</td>
        <td>{metric(values.A?.logLoss)}</td><td>{metric(values.C?.logLoss)}</td>
        <td>{metric(values.A?.brier)}</td><td>{metric(values.C?.brier)}</td>
      </tr>)}</tbody>
    </table></div>
  </details>;
};

const FeatureImportance = ({ rows }: { rows?: ResearchExperiment['report']['featureImportance'] }) => {
  if (!rows?.length) return <p className="research-help">Importanza delle feature non disponibile per questo esperimento.</p>;
  return <details className="research-breakdown">
    <summary>Importanza e permutazione delle feature</summary>
    <p className="research-help">Le importanze descrivono il modello su questi dati. Da sole non dimostrano causalità o utilità su partite future. I valori mantengono la scala del report.</p>
    <div className="research-table-wrap"><table className="fp-table">
      <caption>Importanza delle feature misurata nell’esperimento</caption>
      <thead><tr><th>Feature</th><th>Importanza</th><th>Permutazione · media</th><th>Permutazione · deviazione standard</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={`${row.feature}-${index}`}>
        <th scope="row">{row.feature}</th><td>{metric(row.importance)}</td>
        <td>{metric(row.permutationMean)}</td><td>{metric(row.permutationStd)}</td>
      </tr>)}</tbody>
    </table></div>
  </details>;
};

const ExperimentDetails = ({ experiment }: { experiment: ResearchExperiment }) => {
  const report = experiment.report;
  return <details className="research-experiment-detail" open>
    <summary>{methodLabel(experiment.kind)} · {featureGroupLabel(experiment.featureGroup)} · {experiment.id}</summary>
    <p className="research-help">Validazione di sviluppo. Le metriche e gli intervalli di questo esperimento non autorizzano la promozione del modello.</p>
    <DevelopmentMetrics a={report.metricsA} c={report.metricsC} />
    <DevelopmentIntervals intervals={report.pairedCI} />
    <div className="research-experiment-configuration">
      <Settings label="Iperparametri" value={report.hyperparameters} />
      <Settings label="Storico utilizzato" value={report.history} />
      <Settings label="Calibrazione" value={report.calibration} />
    </div>
    <SegmentMetrics label="Sviluppo per campionato" groups={report.byLeague} />
    <SegmentMetrics label="Sviluppo per stagione" groups={report.bySeason} />
    <SegmentMetrics label="Sviluppo per mercato" groups={report.byMarket} markets />
    <FeatureImportance rows={report.featureImportance} />
    {!!report.rejectionReasons?.length && <div className="research-blockers">
      <h4>Motivi di esclusione dalla promozione</h4>
      <ul>{report.rejectionReasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}</ul>
    </div>}
  </details>;
};

const DiagnosticEvidence = ({ diagnostics }: { diagnostics: ResearchOverview['latestDiagnostics'] }) => {
  if (!diagnostics) return <section className="research-panel"><h2>Diagnosi dei dati e della calibrazione</h2><Empty>Nessuna diagnosi registrata.</Empty></section>;
  const { report } = diagnostics;
  const protectedTest = report.protection;
  return <section className="research-panel">
    <h2>Diagnosi dei dati e della calibrazione</h2>
    <p>Diagnosi del {dateTime(diagnostics.createdAt)} · <span className="research-version">{diagnostics.id}</span></p>
    <dl className="research-system">
      <Metric label="Osservazioni del test finale storico protetto" value={count(protectedTest?.protectedFinalCount)} />
      <Metric label="Nuovo test indipendente" value={protectedTest?.newIndependentTestAvailable === false
        ? 'Non disponibile' : protectedTest?.newIndependentTestAvailable === true ? 'Dichiarato; indipendenza da verificare' : 'Non documentato'} />
    </dl>
    <p className="research-help">Il test finale storico deve restare escluso dalle scelte di sviluppo. Rileggere quel campione non produce nuove evidenze indipendenti.</p>
    {report.recommendation && <p className="research-conclusion">{report.recommendation}</p>}
    {report.findings?.length ? <ul className="research-diagnostic-findings">
      {report.findings.map((finding, index) => <li key={`${finding.code}-${index}`}>
        <strong>{({ critical: 'Critico', error: 'Errore', warning: 'Attenzione', info: 'Nota', high: 'Gravità alta', medium: 'Gravità media', low: 'Gravità bassa' } as Record<string, string>)[finding.severity.toLowerCase()] || finding.severity}</strong>
        <p>{finding.message}</p><small className="research-version">{finding.code}</small>
      </li>)}
    </ul> : <p className="research-help">Nessun rilievo diagnostico disponibile.</p>}
    {report.datasetAudit && <Settings label="Controlli sul dataset" value={report.datasetAudit} />}
    {protectedTest?.originalReportHash && <details className="research-breakdown">
      <summary>Identità del report storico protetto</summary>
      <p className="research-version">{protectedTest.originalReportHash}</p>
    </details>}
  </section>;
};

const ModelEvents = ({ events }: { events: ResearchOverview['modelEvents'] }) => (
  <section className="research-panel">
    <h2>Decisioni registrate sui modelli</h2>
    <p>Le modifiche al Champion conservano motivo e versione precedente. Gli esperimenti di sviluppo restano separati dal registro dei modelli utilizzabili.</p>
    {events?.length ? <div className="research-table-wrap"><table className="fp-table">
      <caption>Promozioni e rollback registrati</caption>
      <thead><tr><th>Data</th><th>Famiglia e versione</th><th>Azione</th><th>Versione precedente</th><th>Motivo</th></tr></thead>
      <tbody>{events.map((event, index) => <tr key={`${event.family}-${event.version}-${event.createdAt}-${index}`}>
        <td>{dateTime(event.createdAt)}</td><td>{event.family} · <span className="research-version">{event.version}</span></td>
        <td>{event.action === 'PROMOTE' ? 'Promozione' : 'Rollback'}</td>
        <td className="research-version">{event.previousVersion || '—'}</td><td>{event.reason || 'Non disponibile'}</td>
      </tr>)}</tbody>
    </table></div> : <Empty>Nessuna promozione o rollback registrati.</Empty>}
  </section>
);

const ResearchExperimentsPanel = ({ overview }: { overview: ResearchOverview }) => {
  const experiments = overview.experiments || [];
  const [method, setMethod] = useState('all');
  const [featureGroup, setFeatureGroup] = useState('all');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const methods = Array.from(new Set(experiments.map((experiment) => experiment.kind)));
  const featureGroups = Array.from(new Set(experiments.map((experiment) => experiment.featureGroup)));
  const filtered = experiments.filter((experiment) => (method === 'all' || experiment.kind === method)
    && (featureGroup === 'all' || experiment.featureGroup === featureGroup));
  const pageSize = 20;
  const pageCount = Math.ceil(filtered.length / pageSize);
  const currentPage = Math.min(page, Math.max(0, pageCount - 1));
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selected = filtered.find((experiment) => experiment.id === selectedId) || filtered[0];
  return <div className="research-stack">
    <section className="research-panel">
      <h2>Esperimenti di sviluppo</h2>
      <p className="research-conclusion">Questi risultati servono a confrontare feature, calibrazione e integrazioni ibride. Non costituiscono un nuovo test indipendente e non sono modelli operativi.</p>
      {experiments.length ? <>
        <div className="research-experiment-filters">
          <label className="research-filter">Metodo
            <select value={method} onChange={(event) => { setMethod(event.target.value); setPage(0); }}>
              <option value="all">Tutti i metodi</option>
              {methods.map((kind) => <option value={kind} key={kind}>{methodLabel(kind)}</option>)}
            </select>
          </label>
          <label className="research-filter">Gruppo di feature
            <select value={featureGroup} onChange={(event) => { setFeatureGroup(event.target.value); setPage(0); }}>
              <option value="all">Tutti i gruppi</option>
              {featureGroups.map((group) => <option value={group} key={group}>{featureGroupLabel(group)}</option>)}
            </select>
          </label>
        </div>
        <p className="research-help" role="status">{count(filtered.length)} esperimenti di sviluppo corrispondono ai filtri.</p>
        {filtered.length ? <>
        <div className="research-table-wrap"><table className="fp-table">
          <caption>Metadati degli esperimenti; nessun nuovo portafoglio o candidato operativo</caption>
          <thead><tr><th>Esperimento e data</th><th>Metodo o controllo</th><th>Gruppo di feature</th><th>N A</th><th>N C</th><th>Log loss A</th><th>Log loss C</th><th>IC log loss C − A</th><th>Uso operativo</th></tr></thead>
          <tbody>{visible.map((experiment) => <tr key={experiment.id}>
            <td><strong>{experiment.id}</strong><small>{dateTime(experiment.createdAt)}</small></td>
            <td>{methodLabel(experiment.kind)}</td><td>{featureGroupLabel(experiment.featureGroup)}</td>
            <td>{count(experiment.report.metricsA?.n)}</td><td>{count(experiment.report.metricsC?.n)}</td>
            <td>{metric(experiment.report.metricsA?.logLoss)}</td><td>{metric(experiment.report.metricsC?.logLoss)}</td>
            <td>{confidenceInterval(experiment.report.pairedCI?.logLoss) || '—'}</td>
            <td>{experiment.runtimeCompatible === false ? 'Non compatibile con il runtime' : 'Compatibilità non certificata'}<small>{experiment.eligibleForPromotion === false ? 'Non idoneo alla promozione' : 'Promozione non autorizzata da questa vista'}</small></td>
          </tr>)}</tbody>
        </table></div>
        {pageCount > 1 && <nav className="research-experiment-pagination" aria-label="Pagine degli esperimenti">
          <button type="button" className="fp-btn fp-btn-ghost fp-btn-sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Pagina precedente</button>
          <span>Pagina {currentPage + 1} di {pageCount}</span>
          <button type="button" className="fp-btn fp-btn-ghost fp-btn-sm" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Pagina successiva</button>
        </nav>}
        <h3>Dettagli, ablazioni e diagnosi dei singoli esperimenti</h3>
        <label className="research-filter research-experiment-selection">Esperimento da esaminare
          <select value={selected?.id || ''} onChange={(event) => setSelectedId(event.target.value)}>
            {filtered.map((experiment) => <option key={experiment.id} value={experiment.id}>{methodLabel(experiment.kind)} · {featureGroupLabel(experiment.featureGroup)} · {experiment.id}</option>)}
          </select>
        </label>
        {selected && <ExperimentDetails key={selected.id} experiment={selected} />}
        </> : <Empty>Nessun esperimento corrisponde ai filtri selezionati.</Empty>}
      </> : <Empty>Nessun esperimento di sviluppo registrato.</Empty>}
    </section>
    <DiagnosticEvidence diagnostics={overview.latestDiagnostics} />
    <ModelEvents events={overview.modelEvents} />
  </div>;
};

export default ResearchExperimentsPanel;
