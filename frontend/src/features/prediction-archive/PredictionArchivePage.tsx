import React, { useEffect, useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronUp, Clock3, FlaskConical, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  BetOpportunityArchiveFilters,
  BetOpportunityArchiveRecord,
  getBetOpportunityArchive,
} from '../../utils/api';
import {
  archiveErrorMessage,
  archiveMatchMeta,
  archiveMatchTitle,
  classificationBadge,
  dateTime,
  decimal,
  exclusionReasonLabel,
  opportunityLabel,
  opportunityMarketLabel,
  opportunityOdds,
  percentage,
  resultBadge,
  typeBadge,
} from './predictionArchivePresentation';
import './prediction-archive.css';

type ArchiveFilter =
  | 'all' | 'operative' | 'simulated'
  | 'high' | 'medium' | 'low' | 'speculative'
  | 'pending' | 'win' | 'loss' | 'void';

const FILTERS: Array<{ value: ArchiveFilter; label: string; params: BetOpportunityArchiveFilters }> = [
  { value: 'all', label: 'Tutte', params: {} },
  { value: 'operative', label: 'Operative', params: { type: 'operative' } },
  { value: 'simulated', label: 'Simulate', params: { type: 'simulated' } },
  { value: 'high', label: 'High', params: { classification: 'high' } },
  { value: 'medium', label: 'Medium', params: { classification: 'medium' } },
  { value: 'low', label: 'Low', params: { classification: 'low' } },
  { value: 'speculative', label: 'Speculative', params: { classification: 'speculative' } },
  { value: 'pending', label: 'In attesa', params: { result: 'pending' } },
  { value: 'win', label: 'Vinte', params: { result: 'win' } },
  { value: 'loss', label: 'Perse', params: { result: 'loss' } },
  { value: 'void', label: 'Rimborsate', params: { result: 'void' } },
];

const PredictionArchivePage: React.FC = () => {
  const [filter, setFilter] = useState<ArchiveFilter>('all');
  const [rows, setRows] = useState<BetOpportunityArchiveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const overview = useMemo(() => ({
    operative: rows.filter((row) => row.archive_type === 'operative').length,
    simulated: rows.filter((row) => row.archive_type === 'simulated').length,
    pending: rows.filter((row) => row.result === 'pending').length,
  }), [rows]);

  useEffect(() => {
    let ignore = false;

    const loadArchive = async () => {
      setLoading(true);
      setError('');
      setExpandedId(null);
      try {
        const selectedFilter = FILTERS.find((item) => item.value === filter);
        const response = await getBetOpportunityArchive({ ...(selectedFilter?.params ?? {}), limit: 200 });
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
        <div className="pa-heading">
          <span className="pa-heading-icon" aria-hidden="true"><Archive size={24} /></span>
          <div>
          <span className="pa-eyebrow">Registro decisionale</span>
          <h1>Archivio giocate</h1>
          <p>
            Fino a 3 giocate Medium/High per partita diventano operative. Una Low entra solo con
            quota reale, EV, edge e Kelly positivi; tutte le altre restano simulazioni senza impatto sul budget.
          </p>
          </div>
        </div>
        {!loading && !error && <span className="pa-total">{rows.length} risultati</span>}
      </header>

      {!loading && !error && (
        <div className="pa-overview" role="group" aria-label="Riepilogo del filtro attivo">
          <div className="pa-overview--operative"><span className="pa-overview__icon" aria-hidden="true"><ShieldCheck size={18} /></span><span className="pa-overview__label">Operative</span><strong className="pa-overview__value">{overview.operative}</strong></div>
          <div className="pa-overview--simulated"><span className="pa-overview__icon" aria-hidden="true"><FlaskConical size={18} /></span><span className="pa-overview__label">Simulate</span><strong className="pa-overview__value">{overview.simulated}</strong></div>
          <div className="pa-overview--pending"><span className="pa-overview__icon" aria-hidden="true"><Clock3 size={18} /></span><span className="pa-overview__label">Da verificare</span><strong className="pa-overview__value">{overview.pending}</strong></div>
        </div>
      )}

      <nav className="pa-filters" aria-label="Filtra archivio giocate">
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
          <div className="pa-loading" aria-label="Caricamento archivio giocate">
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
          <div className="pa-state" role="status" aria-label="Archivio giocate vuoto">
            <strong>Nessuna giocata trovata</strong>
            <p>Le vecchie probabilità tecniche non classificate non vengono mostrate. Le nuove opportunità compariranno alla prossima elaborazione.</p>
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="pa-table-scroll">
            <table className="pa-table">
              <thead>
                <tr>
                  <th>Partita</th>
                  <th>Mercato e selezione</th>
                  <th>Quota</th>
                  <th>Classificazione</th>
                  <th>Tipo</th>
                  <th>Risultato</th>
                  <th><span className="sr-only">Dettagli</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const classification = classificationBadge(row.classification);
                  const kind = typeBadge(row.archive_type);
                  const result = resultBadge(row.result);
                  const odds = opportunityOdds(row);
                  const expanded = expandedId === row.decision_id;
                  const probability = row.calibrated_probability ?? row.raw_probability;
                  return (
                    <React.Fragment key={row.decision_id}>
                      <tr className={`pa-row pa-row--${row.archive_type}`}>
                        <td>
                          <span className="pa-cell-label">Partita</span>
                          <strong>{archiveMatchTitle(row)}</strong>
                          <small>{archiveMatchMeta(row)}</small>
                        </td>
                        <td>
                          <span className="pa-cell-label">Mercato e selezione</span>
                          <strong>{opportunityMarketLabel(row.market_name)}</strong>
                          <small>{opportunityLabel(row.market_name, row.selection, row.home_team_name, row.away_team_name)}</small>
                        </td>
                        <td className="pa-odds">
                          <span className="pa-cell-label">Quota</span>
                          {odds !== null ? <><strong>{decimal(odds)}</strong><small>{row.bookmaker_name}</small></> : <span className="pa-missing">Non disponibile</span>}
                        </td>
                        <td>
                          <span className="pa-cell-label">Classificazione</span>
                          <span className={`pa-badge pa-confidence pa-confidence--${classification.tone}`}>{classification.label}</span>
                        </td>
                        <td>
                          <span className="pa-cell-label">Tipo</span>
                          <span className={`pa-badge pa-badge--${kind.tone}`}>{kind.label}</span>
                        </td>
                        <td>
                          <span className="pa-cell-label">Risultato</span>
                          <span className={`pa-badge pa-badge--${result.tone}`}>{result.label}</span>
                        </td>
                        <td className="pa-actions">
                          <button
                            type="button"
                            className="pa-expand"
                            aria-label={`${expanded ? 'Chiudi' : 'Apri'} dettagli ${archiveMatchTitle(row)}: ${opportunityMarketLabel(row.market_name)} — ${opportunityLabel(row.market_name, row.selection, row.home_team_name, row.away_team_name)}`}
                            aria-expanded={expanded}
                            onClick={() => setExpandedId(expanded ? null : row.decision_id)}
                          >
                            {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="pa-details-row">
                          <td colSpan={7}>
                            <div className="pa-details">
                              <dl>
                                <div><dt>Probabilità del modello</dt><dd>{percentage(probability)}</dd></div>
                                <div><dt>EV tecnico</dt><dd>{percentage(row.ev)}</dd></div>
                                <div><dt>{row.archive_type === 'operative' ? 'Stake effettivo' : 'Stake teorico'}</dt><dd>{decimal(row.archive_type === 'operative' ? row.bet_stake : row.theoretical_stake_amount)}</dd></div>
                                <div><dt>Bookmaker</dt><dd>{row.bookmaker_name || '—'}</dd></div>
                                <div><dt>Registrata il</dt><dd>{dateTime(row.created_at)}</dd></div>
                                <div><dt>Conclusa il</dt><dd>{dateTime(row.settled_at)}</dd></div>
                              </dl>
                              {row.archive_type === 'operative' ? (
                                <p className="pa-bet-note">Giocata operativa: la puntata è stata detratta dal budget.</p>
                              ) : (
                                <p className="pa-bet-note pa-bet-note--unplayed">Simulazione: {exclusionReasonLabel(row.exclusion_reason)}</p>
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
