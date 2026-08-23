import React, { useEffect, useState } from 'react';
import { getCompetitionTransitionAudit, getCompetitionTransitions, getCompetitionTransitionReferences } from '../utils/api';
import './competition-transitions.css';

const CompetitionTransitions: React.FC = () => {
  const [audit, setAudit] = useState<any | null>(null);
  const [transitions, setTransitions] = useState<any[]>([]);
  const [references, setReferences] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([
      getCompetitionTransitionAudit({ force: true }),
      getCompetitionTransitions({ force: true }),
      getCompetitionTransitionReferences({ force: true }),
    ])
      .then(([auditResponse, transitionsResponse, referencesResponse]) => {
        if (!active) return;
        setAudit(auditResponse.data ?? null);
        setTransitions(transitionsResponse.data ?? []);
        setReferences(referencesResponse.data ?? []);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Errore caricamento audit transizioni');
      })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  return (
    <section className="transition-audit-page">
      <header className="transition-audit-hero">
        <span className="transition-audit-kicker">Audit dati</span>
        <h1>Promozioni e retrocessioni</h1>
        <p>Archivio preparatorio per normalizzare il passaggio tra categorie. Nessun correttivo è ancora attivo nel modello.</p>
      </header>

      {error && <div className="transition-audit-alert">{error}</div>}
      {loading && <div className="transition-audit-empty">Caricamento audit...</div>}

      {!loading && audit && (
        <>
          <div className="transition-audit-grid">
            <article><strong>{audit.catalogCount}</strong><span>competizioni catalogate</span></article>
            <article><strong>{audit.seasonReferenceCount}</strong><span>riferimenti stagione</span></article>
            <article><strong>{audit.transitionCount}</strong><span>transizioni archiviate</span></article>
            <article><strong>{audit.readyTransitionCount}</strong><span>righe complete</span></article>
          </div>

          <div className="transition-audit-callout">
            <strong>Correttivo modello disattivato</strong>
            <span>Le informazioni servono ora solo per audit e raccolta dati. Verranno usate nelle predizioni soltanto dopo backtest validato.</span>
          </div>

          <div className="transition-audit-card">
            <div className="transition-audit-card__header">
              <h2>Riferimenti per campionato e stagione</h2>
              <span>{references.length} righe</span>
            </div>
            {references.length === 0 ? (
              <div className="transition-audit-empty">Nessun riferimento importato. Non vengono applicate stime automatiche.</div>
            ) : (
              <div className="transition-audit-table-wrap"><table><thead><tr><th>Competizione</th><th>Stagione</th><th>Squadre</th><th>PPG medio</th><th>Copertura</th></tr></thead><tbody>
                {references.map((row) => <tr key={`${row.source_competition_id}-${row.source_season}`}><td>{row.competition_name ?? row.source_competition_id}</td><td>{row.source_season}</td><td>{row.teams_count}</td><td>{row.mean_ppg == null ? '—' : Number(row.mean_ppg).toFixed(2)}</td><td>{row.coverage_status}</td></tr>)}
              </tbody></table></div>
            )}
          </div>

          <div className="transition-audit-card">
            <div className="transition-audit-card__header"><h2>Transizioni squadra</h2><span>{transitions.length} righe</span></div>
            {transitions.length === 0 ? (
              <div className="transition-audit-empty">Nessuna promozione o retrocessione importata.</div>
            ) : (
              <div className="transition-audit-table-wrap"><table><thead><tr><th>Squadra</th><th>Tipo</th><th>Origine</th><th>Destinazione</th><th>PPG origine</th><th>Stato</th></tr></thead><tbody>
                {transitions.map((row) => <tr key={row.transition_id}><td>{row.team_name ?? row.team_id}</td><td>{row.transition_type}</td><td>{row.source_competition_name ?? '—'}</td><td>{row.destination_competition_id} {row.destination_season}</td><td>{row.source_ppg == null ? '—' : Number(row.source_ppg).toFixed(2)}</td><td>{row.coverage_status}/{row.source_quality}</td></tr>)}
              </tbody></table></div>
            )}
          </div>
        </>
      )}
    </section>
  );
};

export default CompetitionTransitions;
