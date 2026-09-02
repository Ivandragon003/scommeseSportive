import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CircleDollarSign, ClipboardList, CircleSlash2, ChevronDown, ChevronUp, RefreshCw, RotateCcw } from 'lucide-react';
import { AppDateInput } from '../../components/common/AppSelect';
import {
  BetOpportunityArchiveCategory,
  BetOpportunityArchiveCategoryCounts,
  BetOpportunityClassification,
  BetOpportunityArchiveFilters,
  BetOpportunityArchiveRecord,
  BetOpportunityArchiveSummary,
  MatchWithoutArchivedOpportunityRecord,
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
  resultBadge,
  typeBadge,
} from './predictionArchivePresentation';
import './prediction-archive.css';

const RISK_FILTERS: Array<{ value: BetOpportunityClassification; label: string }> = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'speculative', label: 'Speculative' },
];

const EMPTY_SUMMARY: BetOpportunityArchiveSummary = {
  settledCount: 0,
  wonCount: 0,
  lostCount: 0,
  voidCount: 0,
  wonProfit: 0,
  lostProfit: 0,
  netProfit: 0,
};

const EMPTY_COUNTS: BetOpportunityArchiveCategoryCounts = { played: 0, unplayed: 0, noProposal: 0 };

const ARCHIVE_TABS: Array<{
  value: BetOpportunityArchiveCategory;
  label: string;
  description: string;
  icon: React.ElementType;
}> = [
  { value: 'played', label: 'Giocate', description: 'Inserite nel budget', icon: CircleDollarSign },
  { value: 'unplayed', label: 'Non giocate', description: 'Analizzate, senza puntata', icon: ClipboardList },
  { value: 'no_proposal', label: 'Nessuna proposta', description: 'Concluse senza decisione', icon: CircleSlash2 },
];

const money = (amount: number, signed = false) => {
  const value = Number.isFinite(amount) ? amount : 0;
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
};

const filterDateLabel = (value: string) => {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
};

const completedScore = (row: MatchWithoutArchivedOpportunityRecord) => {
  const home = Number(row.home_goals);
  const away = Number(row.away_goals);
  return Number.isFinite(home) && Number.isFinite(away) ? `${home}–${away}` : 'Conclusa';
};

const PredictionArchivePage: React.FC = () => {
  const [category, setCategory] = useState<BetOpportunityArchiveCategory>('played');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [classifications, setClassifications] = useState<BetOpportunityClassification[]>([]);
  const [rows, setRows] = useState<BetOpportunityArchiveRecord[]>([]);
  const [noProposalRows, setNoProposalRows] = useState<MatchWithoutArchivedOpportunityRecord[]>([]);
  const [summary, setSummary] = useState<BetOpportunityArchiveSummary>(EMPTY_SUMMARY);
  const [counts, setCounts] = useState<BetOpportunityArchiveCategoryCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filters = useMemo<BetOpportunityArchiveFilters>(() => ({
    category,
    from: from || undefined,
    to: to || undefined,
    classifications: category === 'no_proposal' || classifications.length === 0 ? undefined : classifications,
    limit: 200,
  }), [category, from, to, classifications]);
  const isNoProposal = category === 'no_proposal';
  const activeTab = ARCHIVE_TABS.find((tab) => tab.value === category)!;
  const ActiveTabIcon = activeTab.icon;
  const invalidDateRange = Boolean(from && to && from > to);
  const filtersAreActive = Boolean(from || to || (!isNoProposal && classifications.length > 0));
  const summaryScope = useMemo(() => {
    const dateScope = from && to
      ? `${filterDateLabel(from)} – ${filterDateLabel(to)}`
      : from
        ? `Dal ${filterDateLabel(from)}`
        : to
          ? `Fino al ${filterDateLabel(to)}`
          : 'Tutte le date';
    const classificationScope = !isNoProposal && classifications.length > 0
      ? classifications.map((classification) => RISK_FILTERS.find((item) => item.value === classification)?.label).filter(Boolean).join(', ')
      : 'Tutte le classificazioni';
    return `${dateScope} · ${classificationScope}`;
  }, [from, to, classifications, isNoProposal]);

  const selectCategory = (nextCategory: BetOpportunityArchiveCategory) => {
    setCategory(nextCategory);
    setExpandedId(null);
    if (nextCategory === 'no_proposal') setClassifications([]);
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const lastIndex = ARCHIVE_TABS.length - 1;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
    if (event.key === 'ArrowLeft') nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = lastIndex;
    if (nextIndex === null) return;

    event.preventDefault();
    selectCategory(ARCHIVE_TABS[nextIndex].value);
    // The selected tab is the only tab stop. Move focus with the selection so
    // keyboard users keep their place in the archive's tab sequence.
    tabRefs.current[nextIndex]?.focus();
  };

  const toggleClassification = (classification: BetOpportunityClassification) => {
    setClassifications((active) => active.includes(classification)
      ? active.filter((value) => value !== classification)
      : [...active, classification]);
  };

  const resetFilters = () => {
    setFrom('');
    setTo('');
    setClassifications([]);
  };

  useEffect(() => {
    let ignore = false;

    if (invalidDateRange) {
      setLoading(false);
      return () => { ignore = true; };
    }

    const loadArchive = async () => {
      setLoading(true);
      setError('');
      setExpandedId(null);
      try {
        const response = await getBetOpportunityArchive(filters);
        if (!response.success) throw new Error(response.error || 'Archivio non disponibile');
        if (!ignore) {
          const data = Array.isArray(response.data) ? response.data : [];
          setRows(category === 'no_proposal' ? [] : data as BetOpportunityArchiveRecord[]);
          setNoProposalRows(category === 'no_proposal' ? data as MatchWithoutArchivedOpportunityRecord[] : []);
          setSummary(response.summary ?? EMPTY_SUMMARY);
          // The active list is the authoritative result for the request just
          // completed. Keep its tab count in sync even when a cached/global
          // aggregate is briefly stale after an archive write.
          setCounts({
            ...(response.counts ?? EMPTY_COUNTS),
            [category]: data.length,
          });
        }
      } catch (loadError) {
        if (!ignore) {
          setRows([]);
          setNoProposalRows([]);
          setSummary(EMPTY_SUMMARY);
          setCounts(EMPTY_COUNTS);
          setError(archiveErrorMessage(loadError));
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    };

    void loadArchive();
    return () => { ignore = true; };
  }, [category, filters, invalidDateRange, retryKey]);

  const visibleCount = isNoProposal ? noProposalRows.length : rows.length;
  const contextualCountLabel = category === 'unplayed'
    ? `${visibleCount} ${visibleCount === 1 ? 'decisione salvata' : 'decisioni salvate'}`
    : `${visibleCount} ${visibleCount === 1 ? 'partita senza proposta' : 'partite senza proposta'}`;

  return (
    <div className="pa-page">
      <header className="pa-header">
        <div className="pa-heading">
          <span className="pa-heading-icon" aria-hidden="true"><Archive size={24} /></span>
          <div>
          <span className="pa-eyebrow">Registro decisionale</span>
          <h1>Archivio</h1>
          <p>Separa le giocate reali dalle analisi salvate e controlla le partite concluse senza una proposta.</p>
          </div>
        </div>
        {!loading && !error && <span className="pa-total">{visibleCount} {filtersAreActive ? 'risultati filtrati' : 'risultati'}</span>}
      </header>

      <section className="pa-tabs-panel" aria-label="Categorie archivio">
        <div className="pa-tabs" role="tablist" aria-label="Categorie delle partite archiviate">
          {ARCHIVE_TABS.map((tab, index) => {
            const Icon = tab.icon;
            const selected = category === tab.value;
            const count = tab.value === 'played' ? counts.played : tab.value === 'unplayed' ? counts.unplayed : counts.noProposal;
            return (
              <button
                key={tab.value}
                id={`archive-tab-${tab.value}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="archive-results"
                tabIndex={selected ? 0 : -1}
                className={`pa-tab${selected ? ' is-active' : ''}`}
                onClick={() => selectCategory(tab.value)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                ref={(element) => { tabRefs.current[index] = element; }}
              >
                <Icon size={18} aria-hidden="true" />
                <span className="pa-tab__copy"><strong>{tab.label}</strong><small>{tab.description}</small></span>
                <span className="pa-tab__count" aria-label={`${count} ${tab.label.toLocaleLowerCase('it-IT')}`}>{count}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="pa-filter-panel" aria-label="Filtra archivio giocate">
        <div className="pa-date-filters">
          <label className="pa-date-filter">
            <span>Da</span>
            <AppDateInput value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="pa-date-filter">
            <span>A</span>
            <AppDateInput value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
        <fieldset className="pa-risk-filters" disabled={isNoProposal} aria-describedby={isNoProposal ? 'pa-risk-unavailable' : undefined}>
          <legend>Classificazione</legend>
          <div>
            {RISK_FILTERS.map(({ value, label }) => {
              const active = classifications.includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  className={`pa-filter pa-filter--${value}${active ? ' active' : ''}`}
                  aria-pressed={active}
                  onClick={() => toggleClassification(value)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </fieldset>
        <button type="button" className="pa-reset" onClick={resetFilters} disabled={!filtersAreActive}>
          <RotateCcw size={15} aria-hidden="true" /> Azzera filtri
        </button>
        {isNoProposal && <p id="pa-risk-unavailable" className="pa-filter-hint">La classificazione vale solo per decisioni archiviate.</p>}
        {invalidDateRange && <p className="pa-filter-error" role="alert">La data “Da” deve precedere la data “A”.</p>}
      </section>

      {!loading && !error && !invalidDateRange && category === 'played' && summary.settledCount > 0 && (
        <section className="pa-summary" aria-label="Riepilogo economico delle giocate concluse">
          <div className="pa-summary__intro">
            <span>Riepilogo giocate</span>
            <strong>{summary.settledCount} concluse</strong>
            <small className="pa-summary__scope">{summaryScope}</small>
            <small>{summary.wonCount} vinte · {summary.lostCount} perse · {summary.voidCount} rimborsate</small>
          </div>
          <div className="pa-summary__metric pa-summary__metric--win"><span>Vinto</span><strong>{money(summary.wonProfit, true)}</strong></div>
          <div className="pa-summary__metric pa-summary__metric--loss"><span>Perso</span><strong>−{money(summary.lostProfit)}</strong></div>
          <div className={`pa-summary__metric pa-summary__metric--net ${summary.netProfit >= 0 ? 'is-positive' : 'is-negative'}`}><span>Saldo netto</span><strong>{money(summary.netProfit, true)}</strong></div>
          <p>Il saldo usa esclusivamente il profitto delle giocate operative concluse.</p>
        </section>
      )}

      {!loading && !error && !invalidDateRange && (category !== 'played' || summary.settledCount === 0) && (
        <section className="pa-context-summary" aria-label={`Riepilogo ${activeTab.label.toLocaleLowerCase('it-IT')}`}>
          <ActiveTabIcon size={22} aria-hidden="true" />
          <div>
            <span>{filtersAreActive ? 'Nei filtri selezionati' : category === 'unplayed' ? 'Analisi senza puntata' : 'Copertura delle partite concluse'}</span>
            <strong>{contextualCountLabel}</strong>
          </div>
          <p>{category === 'unplayed'
            ? 'Queste analisi non sono entrate nel budget e non incidono sul saldo.'
            : category === 'played'
              ? 'Non ci sono ancora giocate operative concluse nei filtri scelti: il saldo comparirà solo quando esisteranno risultati reali.'
              : 'L’assenza di una proposta non indica un errore: la partita è stata conclusa senza una decisione idonea da archiviare.'}</p>
        </section>
      )}

      <section id="archive-results" role="tabpanel" aria-labelledby={`archive-tab-${category}`} className="pa-card" aria-live="polite">
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

        {!loading && !error && visibleCount === 0 && (
          <div className="pa-state" role="status" aria-label="Archivio giocate vuoto">
            <strong>{category === 'no_proposal' ? 'Nessuna partita senza proposta' : category === 'unplayed' ? 'Nessuna analisi non giocata' : 'Nessuna giocata trovata'}</strong>
            <p>{category === 'no_proposal'
              ? 'Nel periodo scelto tutte le partite concluse hanno almeno una decisione archiviata.'
              : 'Prova a modificare i filtri oppure attendi la prossima elaborazione.'}</p>
          </div>
        )}

        {!loading && !error && isNoProposal && noProposalRows.length > 0 && (
          <div className="pa-table-scroll">
            <table className="pa-table pa-table--coverage">
              <thead><tr><th>Partita</th><th>Competizione</th><th>Risultato finale</th></tr></thead>
              <tbody>{noProposalRows.map((row) => (
                <tr key={row.match_id} className="pa-row pa-row--no-proposal">
                  <td><span className="pa-cell-label">Partita</span><strong>{row.home_team_name || 'Squadra casa'} – {row.away_team_name || 'Squadra ospite'}</strong><small>{dateTime(row.match_date)}</small></td>
                  <td><span className="pa-cell-label">Competizione</span><strong>{row.competition || 'Competizione non indicata'}</strong></td>
                  <td><span className="pa-cell-label">Risultato finale</span><span className="pa-score">{completedScore(row)}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}

        {!loading && !error && !isNoProposal && rows.length > 0 && (
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
                  return (
                    <React.Fragment key={row.decision_id}>
                      <tr className={`pa-row pa-row--${row.archive_type} pa-row--result-${result.tone}`}>
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
