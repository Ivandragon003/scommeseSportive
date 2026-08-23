import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import {
  getPredictionArchive,
  PredictionArchiveRecord,
  PredictionArchiveStatus,
} from '../../utils/api';
import {
  archiveMatchMeta,
  archiveMatchTitle,
  archiveOdds,
  archiveErrorMessage,
  confidenceBadge,
  dateTime,
  decimal,
  percentage,
  resultBadge,
} from './predictionArchivePresentation';
import './prediction-archive.css';

type ArchiveFilter = 'all' | PredictionArchiveStatus;

const FILTERS: Array<{ value: ArchiveFilter; label: string }> = [
  { value: 'all', label: 'Tutte' },
  { value: 'played', label: 'Giocate' },
  { value: 'unplayed', label: 'Non giocate' },
  { value: 'pending', label: 'In attesa' },
  { value: 'win', label: 'Vinte' },
  { value: 'loss', label: 'Perse' },
  { value: 'void', label: 'Void' },
];

const PredictionArchivePage: React.FC = () => {
  const [filter, setFilter] = useState<ArchiveFilter>('all');
  const [rows, setRows] = useState<PredictionArchiveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    const loadArchive = async () => {
      setLoading(true);
      setError('');
      setExpandedId(null);
      try {
        const params = filter === 'all' ? { limit: 200 } : { status: filter, limit: 200 };
        const response = await getPredictionArchive(params);
        if (!response.success) throw new Error(response.error || 'Archivio non disponibile');
        if (!ignore) setRows(Array.isArray(response.data) ? response.data : []);
      } catch (loadError) {
        if (!ignore) {
          setRows([]);
          setError(archiveErrorMessage(loadError));
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    };

    void loadArchive();
    return () => { ignore = true; };
  }, [filter, retryKey]);

  return (
    <div className="pa-page">
      <header className="pa-header">
        <div>
          <span className="pa-eyebrow">Storico del modello</span>
          <h1>Archivio prediction</h1>
          <p>Consulta tutte le prediction generate. Una prediction “Non giocata” non è una bet e non modifica il budget.</p>
        </div>
        {!loading && !error && <span className="pa-total">{rows.length} risultati</span>}
      </header>

      <nav className="pa-filters" aria-label="Filtra archivio prediction">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={`pa-filter${filter === value ? ' active' : ''}`}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      <section className="pa-card" aria-live="polite">
        {loading && (
          <div className="pa-loading" aria-label="Caricamento archivio prediction">
            <RefreshCw className="fp-spin" size={22} aria-hidden="true" />
            <span>Caricamento archivio…</span>
          </div>
        )}

        {!loading && error && (
          <div className="pa-state pa-state--error" role="alert">
            <strong>Archivio non disponibile</strong>
            <p>{error}</p>
            <button type="button" className="fp-btn fp-btn-secondary" onClick={() => setRetryKey((value) => value + 1)}>
              Riprova
            </button>
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div className="pa-state" role="status" aria-label="Archivio prediction vuoto">
            <strong>Nessuna prediction trovata</strong>
            <p>Non ci sono elementi per il filtro selezionato.</p>
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="pa-table-scroll">
            <table className="pa-table">
              <thead>
                <tr>
                  <th>Partita</th><th>Mercato e selezione</th><th>Quota</th><th>Probabilità</th>
                  <th>EV</th><th>Confidence</th><th>Stato prediction</th><th>Giocata</th><th>Risultato</th><th><span className="sr-only">Dettagli</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const played = row.was_played === 1 || row.was_played === true;
                  const result = resultBadge(row.result);
                  const confidence = confidenceBadge(row.confidence_computed);
                  const odds = archiveOdds(row);
                  const pending = String(row.result ?? 'pending').toLowerCase() === 'pending';
                  const expanded = expandedId === row.prediction_id;
                  return (
                    <React.Fragment key={row.prediction_id}>
                      <tr className="pa-row">
                        <td><span className="pa-cell-label">Partita</span><strong>{archiveMatchTitle(row)}</strong><small>{archiveMatchMeta(row)}</small></td>
                        <td><span className="pa-cell-label">Mercato e selezione</span><strong>{row.market || '—'}</strong><small>{row.selection || '—'}</small></td>
                        <td className="pa-odds">
                          <span className="pa-cell-label">Quota</span>
                          {odds.prediction !== null ? <><strong>{decimal(odds.prediction)}</strong><small>Quota prediction</small></> : <span className="pa-missing">Non disponibile</span>}
                          {odds.bet !== null && <small>Giocata: {decimal(odds.bet)}</small>}
                        </td>
                        <td><span className="pa-cell-label">Probabilità</span>{percentage(row.calibrated_probability ?? row.raw_probability)}</td>
                        <td><span className="pa-cell-label">EV</span>{percentage(row.ev)}</td>
                        <td><span className="pa-cell-label">Confidence</span><span className={`pa-badge pa-confidence pa-confidence--${confidence.tone}`}>{confidence.label}</span></td>
                        <td><span className="pa-cell-label">Stato prediction</span><span className={`pa-badge pa-badge--${pending ? 'pending' : 'settled'}`}>{pending ? 'In attesa' : 'Regolata'}</span></td>
                        <td><span className="pa-cell-label">Giocata</span><span className={`pa-badge pa-badge--${played ? 'played' : 'unplayed'}`}>{played ? 'Giocata' : 'Non giocata'}</span></td>
                        <td><span className="pa-cell-label">Risultato</span><span className={`pa-badge pa-badge--${result.tone}`}>{result.label}</span></td>
                        <td className="pa-actions">
                          <button
                            type="button"
                            className="pa-expand"
                            aria-label={`${expanded ? 'Chiudi' : 'Apri'} dettagli prediction ${row.prediction_id}`}
                            aria-expanded={expanded}
                            onClick={() => setExpandedId(expanded ? null : row.prediction_id)}
                          >
                            {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="pa-details-row">
                          <td colSpan={10}>
                            <div className="pa-details">
                              <dl>
                                <div><dt>ID prediction</dt><dd>{row.prediction_id}</dd></div>
                                <div><dt>Match ID</dt><dd>{row.match_id}</dd></div>
                                <div><dt>Probabilità grezza</dt><dd>{percentage(row.raw_probability)}</dd></div>
                                <div><dt>Probabilità calibrata</dt><dd>{percentage(row.calibrated_probability)}</dd></div>
                                <div><dt>Kelly</dt><dd>{percentage(row.kelly)}</dd></div>
                                <div><dt>Campione</dt><dd>{row.sample_size_at_time ?? '—'}</dd></div>
                                <div><dt>Regolata il</dt><dd>{dateTime(row.settled_at)}</dd></div>
                              </dl>
                              {row.ev_reason && <p className="pa-reason"><strong>Nota EV:</strong> {row.ev_reason}</p>}
                              {played ? (
                                <p className="pa-bet-note">Bet collegata: {row.bet_id || '—'} · stato {row.bet_status || '—'} · stake {decimal(row.bet_stake)} · quota {decimal(row.bet_odds)}</p>
                              ) : (
                                <p className="pa-bet-note pa-bet-note--unplayed">Nessuna bet collegata: questa prediction non incide sul budget.</p>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default PredictionArchivePage;
