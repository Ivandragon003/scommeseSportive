import React, { useEffect, useMemo, useState } from 'react';
import { AppDateInput, AppSelect } from '../components/common/AppSelect';
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  Clock3,
  HelpCircle,
  History,
  Search,
  Ticket,
  TrendingUp,
  WalletCards,
  X,
} from 'lucide-react';
import { useBudgetManagerData } from '../hooks/useBudgetManagerData';
import {
  formatBetDateTime,
  formatBetMarketName,
  getBetSelectionLabel,
  getBetSourceLabel,
  getBetStatus,
  isLegacyBet,
} from '../utils/betPresentation';
import './budget-manager.css';

interface BetsManagerProps {
  activeUser: string;
}

interface DateRange {
  from: string;
  to: string;
}

type BetView = 'PENDING' | 'CLOSED' | 'ALL' | 'WON' | 'LOST' | 'VOID';

const readFiltersFromUrl = () => {
  if (!window.location.pathname.endsWith('/bets')) {
    return { search: '', view: 'PENDING' as BetView, historyOutcome: '', historyCompetition: '', dateRange: { from: '', to: '' } };
  }
  const params = new URLSearchParams(window.location.search);
  const view = params.get('betsView') as BetView | null;
  return {
    search: params.get('betsSearch') ?? '',
    view: view && ['PENDING', 'CLOSED', 'ALL', 'WON', 'LOST', 'VOID'].includes(view) ? view : 'PENDING' as BetView,
    historyOutcome: params.get('betsOutcome') ?? '',
    historyCompetition: params.get('betsCompetition') ?? '',
    dateRange: { from: params.get('betsFrom') ?? '', to: params.get('betsTo') ?? '' },
  };
};

const formatDateInput = (value: string) => {
  if (!value) return '';
  return new Intl.DateTimeFormat('it-IT').format(new Date(`${value}T12:00:00`));
};

const formatMoney = (value: unknown) => `EUR ${Number(value ?? 0).toFixed(2)}`;

const isWithinDateRange = (value: unknown, range: DateRange) => {
  if (!range.from && !range.to) return true;
  const timestamp = new Date(String(value ?? '')).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const from = range.from ? new Date(`${range.from}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
  const to = range.to ? new Date(`${range.to}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
  return timestamp >= from && timestamp <= to;
};

const getBookmakerLabel = (bet: any) => {
  const realSource = bet?.bookmaker_name ?? bet?.bookmaker ?? bet?.odds_bookmaker ?? bet?.odds_source;
  return String(realSource || getBetSourceLabel(bet?.source));
};

const BetRow: React.FC<{
  bet: any;
  expanded: boolean;
  onToggle: () => void;
  variant: 'open' | 'history';
}> = ({ bet, expanded, onToggle, variant }) => {
  const status = getBetStatus(bet.status);
  const selection = getBetSelectionLabel(bet.selection);
  const stake = Number(bet.stake ?? 0);
  const odds = Number(bet.odds ?? 0);
  const profit = bet.profit === null || bet.profit === undefined ? null : Number(bet.profit);
  const returnAmount = variant === 'open'
    ? stake * odds
    : String(bet.status) === 'WON'
      ? stake + Number(profit ?? 0)
      : String(bet.status) === 'VOID'
        ? stake
        : 0;
  const probabilityValue = Number(bet.our_probability ?? bet.ourProbability ?? bet.estimated_probability ?? bet.probability ?? bet.model_probability);
  const probability = Number.isFinite(probabilityValue) && probabilityValue > 0
    ? `${probabilityValue <= 1 ? (probabilityValue * 100).toFixed(0) : probabilityValue.toFixed(0)}%`
    : 'Non disponibile';

  return (
    <article className={`bet-row bet-row--${variant} bet-row--${status.className}${expanded ? ' is-expanded' : ''}`}>
      <button
        type="button"
        className="bet-row__summary"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Chiudi' : 'Apri'} dettaglio ${bet.home_team_name ?? '-'} ${bet.away_team_name ?? '-'}`}
      >
        <span className="bet-row__chevron" aria-hidden="true">{expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span>
        <span className="bet-row__match bet-row__cell">
          <strong>{bet.home_team_name ?? '-'} — {bet.away_team_name ?? '-'}</strong>
          <small>{bet.competition ?? '-'} · {formatBetDateTime(bet.placed_at)}</small>
        </span>
        <span className="bet-row__pick bet-row__cell">
          <strong>{formatBetMarketName(bet.market_name)}</strong>
          {selection && <small>{selection}</small>}
        </span>
        <span className="bet-row__quote bet-row__cell"><small>Quota reale</small><strong>{odds.toFixed(2)}</strong><span>{getBookmakerLabel(bet)}</span></span>
        <span className="bet-row__stake bet-row__cell"><small>Puntata</small><strong>{formatMoney(stake)}</strong></span>
        <span className="bet-row__return bet-row__cell"><small>{variant === 'open' ? 'Ritorno potenziale' : 'Ritorno'}</small><strong>{formatMoney(returnAmount)}</strong></span>
        <span className={`bm-status ${status.className}`}>{status.label}</span>
        {variant === 'history' && profit !== null && (
          <span className={`bet-row__profit ${profit >= 0 ? 'is-positive' : 'is-negative'}`}>{profit > 0 ? '+' : ''}{formatMoney(profit)}</span>
        )}
      </button>
      {expanded && (
        <div className="bet-row__detail">
          <div><small>Pronostico originale</small><strong>{formatBetMarketName(bet.market_name)}</strong>{selection && <span>{selection}</span>}</div>
          <div><small>Quota alla giocata</small><strong>{odds.toFixed(2)}</strong></div>
          <div><small>P. nostra</small><strong>{probability}</strong></div>
          <div><small>Puntata</small><strong>{formatMoney(stake)}</strong></div>
          <div><small>Giocata il</small><strong>{formatBetDateTime(bet.placed_at)}</strong></div>
          <div><small>Fonte quota</small><strong>{getBookmakerLabel(bet)}</strong>{isLegacyBet(bet) && <span className="bm-data-warning">Dato precedente alla validazione</span>}</div>
        </div>
      )}
    </article>
  );
};

const BetsManager: React.FC<BetsManagerProps> = ({ activeUser }) => {
  const initialFilters = useMemo(readFiltersFromUrl, []);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search, setSearch] = useState(initialFilters.search);
  const [view, setView] = useState<BetView>(initialFilters.view);
  const [historyOutcome, setHistoryOutcome] = useState(initialFilters.historyOutcome);
  const [historyCompetition, setHistoryCompetition] = useState(initialFilters.historyCompetition);
  const [datePanelOpen, setDatePanelOpen] = useState(false);
  const [draftDateRange, setDraftDateRange] = useState<DateRange>(initialFilters.dateRange);
  const [dateRange, setDateRange] = useState<DateRange>(initialFilters.dateRange);
  const {
    budget,
    bets,
    loading,
    pendingBets,
    netProfit,
    winsCount,
    lossesCount,
    voidCount,
  } = useBudgetManagerData(activeUser);

  useEffect(() => {
    const writeFilters = () => {
      if (!window.location.pathname.endsWith('/bets')) return;
      const params = new URLSearchParams(window.location.search);
      const values: Record<string, string> = {
        betsSearch: search, betsView: view, betsOutcome: historyOutcome, betsCompetition: historyCompetition,
        betsFrom: dateRange.from, betsTo: dateRange.to,
      };
      Object.entries(values).forEach(([key, value]) => value ? params.set(key, value) : params.delete(key));
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`);
    };
    writeFilters();
  }, [search, view, historyOutcome, historyCompetition, dateRange]);

  useEffect(() => {
    const restoreFilters = () => {
      const next = readFiltersFromUrl();
      setSearch(next.search); setView(next.view); setHistoryOutcome(next.historyOutcome); setHistoryCompetition(next.historyCompetition);
      setDateRange(next.dateRange); setDraftDateRange(next.dateRange); setExpandedId(null);
    };
    window.addEventListener('popstate', restoreFilters);
    return () => window.removeEventListener('popstate', restoreFilters);
  }, []);

  const closedCount = winsCount + lossesCount + voidCount;
  const capitalExposure = pendingBets.reduce((sum, bet) => sum + Number(bet?.stake ?? 0), 0);
  const normalizedSearch = search.trim().toLocaleLowerCase('it');
  const competitions = useMemo(() => Array.from(new Set(
    bets.map((bet) => String(bet?.competition ?? '').trim()).filter(Boolean),
  )).sort((left, right) => left.localeCompare(right, 'it')), [bets]);
  const matchesSharedFilters = (bet: any) => {
    const matchesSearch = !normalizedSearch || [
      bet.home_team_name,
      bet.away_team_name,
      bet.competition,
      formatBetMarketName(bet.market_name),
      getBetSelectionLabel(bet.selection),
    ].some((value) => String(value ?? '').toLocaleLowerCase('it').includes(normalizedSearch));
    return matchesSearch && isWithinDateRange(bet.placed_at, dateRange);
  };
  const showOpen = view === 'PENDING' || view === 'ALL';
  const visibleOpenBets = showOpen ? pendingBets.filter(matchesSharedFilters) : [];
  const visibleHistoryBets = bets.filter((bet) => {
    const status = String(bet?.status ?? '');
    if (status === 'PENDING' || !matchesSharedFilters(bet)) return false;
    const viewStatus = view === 'WON' || view === 'LOST' || view === 'VOID' ? view : '';
    if (viewStatus && status !== viewStatus) return false;
    if (historyOutcome && status !== historyOutcome) return false;
    if (historyCompetition && String(bet?.competition ?? '') !== historyCompetition) return false;
    return true;
  });
  const hasDateRange = Boolean(dateRange.from || dateRange.to);
  const dateButtonLabel = hasDateRange
    ? dateRange.from === dateRange.to
      ? formatDateInput(dateRange.from || dateRange.to)
      : `${dateRange.from ? formatDateInput(dateRange.from) : 'Inizio'} – ${dateRange.to ? formatDateInput(dateRange.to) : 'Oggi'}`
    : 'Intervallo date';
  const applyDateRange = () => {
    const nextRange = draftDateRange.from && draftDateRange.to && draftDateRange.from > draftDateRange.to
      ? { from: draftDateRange.to, to: draftDateRange.from }
      : draftDateRange;
    setDraftDateRange(nextRange);
    setDateRange(nextRange);
    setDatePanelOpen(false);
  };
  const resetDateRange = () => {
    const emptyRange = { from: '', to: '' };
    setDraftDateRange(emptyRange);
    setDateRange(emptyRange);
    setDatePanelOpen(false);
  };
  const toggle = (bet: any) => {
    const id = String(bet.bet_id);
    setExpandedId((current) => current === id ? null : id);
  };

  return (
    <div className="bm-wrap bets-page">
      <header className="bm-head bets-page-head">
        <div>
          <span className="bets-page-eyebrow"><Ticket size={15} aria-hidden="true" /> Registro bankroll</span>
          <h1 className="bm-title">Giocate</h1>
          <p className="bm-sub">Monitora le tue giocate in attesa e consulta lo storico dei risultati.</p>
        </div>
        <button type="button" className="account-page-help" aria-label="Apri aiuto pagina" onClick={() => window.dispatchEvent(new CustomEvent('glossary-open'))}><HelpCircle size={24} /></button>
        {!loading && (
          <dl className="bets-summary" aria-label="Riepilogo giocate">
            <div>
              <span className="bets-summary__icon bets-summary__desktop"><CircleDollarSign size={22} /></span><span className="bets-summary__icon bets-summary__mobile"><Clock3 size={22} /></span>
              <span><dt><span className="bets-summary__desktop">Capitale impegnato</span><span className="bets-summary__mobile">Aperte</span></dt><dd><span className="bets-summary__desktop">{formatMoney(capitalExposure)}</span><span className="bets-summary__mobile">{pendingBets.length}</span></dd><small className="bets-summary__desktop">{pendingBets.length} aperte</small></span>
            </div>
            <div className={Number(budget?.roi ?? 0) >= 0 ? 'is-positive' : 'is-negative'}>
              <span className="bets-summary__icon bets-summary__desktop"><TrendingUp size={22} /></span><span className="bets-summary__icon bets-summary__mobile"><Check size={22} /></span>
              <span><dt><span className="bets-summary__desktop">Rendimento storico</span><span className="bets-summary__mobile">Chiuse</span></dt><dd><span className="bets-summary__desktop">{Number(budget?.roi ?? 0) >= 0 ? '+' : ''}{Number(budget?.roi ?? 0).toFixed(1)}%</span><span className="bets-summary__mobile">{closedCount}</span></dd><small className="bets-summary__desktop">{closedCount} concluse</small></span>
            </div>
            <div className={netProfit >= 0 ? 'is-positive' : 'is-negative'}>
              <span className="bets-summary__icon bets-summary__desktop"><WalletCards size={22} /></span><span className="bets-summary__icon bets-summary__mobile"><TrendingUp size={22} /></span>
              <span><dt><span className="bets-summary__desktop">Saldo giocate</span><span className="bets-summary__mobile">Risultato</span></dt><dd>{netProfit >= 0 ? '+' : ''}{formatMoney(netProfit)}</dd><small className="bets-summary__desktop">profitto netto</small></span>
            </div>
          </dl>
        )}
      </header>

      {loading ? (
        <div className="bm-skeleton" aria-busy="true" aria-label="Caricamento giocate"><span /><span /><span /></div>
      ) : (
        <>
          <div className="bets-mobile-tabs" role="group" aria-label="Vista giocate mobile">
            <button type="button" className={view === 'PENDING' ? 'active' : ''} aria-pressed={view === 'PENDING'} onClick={() => setView('PENDING')}>Aperte</button>
            <button type="button" className={view === 'CLOSED' ? 'active' : ''} aria-pressed={view === 'CLOSED'} onClick={() => setView('CLOSED')}>Chiuse</button>
            <button type="button" className={view === 'ALL' ? 'active' : ''} aria-label="Tutte" aria-pressed={view === 'ALL'} onClick={() => setView('ALL')}>Tutte</button>
          </div>

          <section className="bets-toolbar" aria-label="Filtri giocate">
            <div className="bm-ftabs bets-status-tabs" role="group" aria-label="Filtra giocate">
              {[
                { value: 'PENDING', label: 'In attesa' },
                { value: 'ALL', label: 'Tutte', ariaLabel: 'Tutte le giocate' },
                { value: 'WON', label: 'Vinte' },
                { value: 'LOST', label: 'Perse' },
                { value: 'VOID', label: 'Annullate' },
              ].map((item) => (
                <button key={item.value} type="button" aria-label={item.ariaLabel} className={`bm-ftab${view === item.value ? ' active' : ''}`} onClick={() => setView(item.value as BetView)} aria-pressed={view === item.value}>{item.label}</button>
              ))}
            </div>
            <div className="bets-toolbar__right">
              <label className="bets-search"><Search size={18} aria-hidden="true" /><span className="sr-only">Cerca una giocata</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cerca per partita o competizione" /></label>
              <div className="bets-date-filter">
                <button
                  type="button"
                  className={`bets-date-button${hasDateRange ? ' is-active' : ''}`}
                  aria-expanded={datePanelOpen}
                  aria-controls="bets-date-panel"
                  onClick={() => setDatePanelOpen((open) => !open)}
                >
                  <CalendarDays size={18} aria-hidden="true" /> <span>{dateButtonLabel}</span><ChevronDown size={16} aria-hidden="true" />
                </button>
                {datePanelOpen && (
                  <div className="bets-date-panel" id="bets-date-panel" role="group" aria-label="Seleziona intervallo date">
                    <div className="bets-date-panel__head"><strong>Intervallo date</strong><button type="button" aria-label="Chiudi intervallo date" onClick={() => setDatePanelOpen(false)}><X size={16} /></button></div>
                    <label htmlFor="bets-date-from">Data iniziale<AppDateInput id="bets-date-from" value={draftDateRange.from} onChange={(event) => setDraftDateRange((range) => ({ ...range, from: event.target.value }))} /></label>
                    <label htmlFor="bets-date-to">Data finale<AppDateInput id="bets-date-to" value={draftDateRange.to} onChange={(event) => setDraftDateRange((range) => ({ ...range, to: event.target.value }))} /></label>
                    <div className="bets-date-panel__actions">
                      <button type="button" className="fp-btn fp-btn-ghost fp-btn-sm" onClick={resetDateRange}>Azzera intervallo</button>
                      <button type="button" className="fp-btn fp-btn-solid fp-btn-sm" onClick={applyDateRange}>Applica intervallo</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {!budget && <div className="fp-alert fp-alert-warning">Inizializza il budget prima di registrare nuove giocate.</div>}

          {showOpen && (
          <section className="bets-section bets-section--open" aria-labelledby="open-bets-title" aria-label="Giocate aperte">
              <div className="bets-section__head">
                <div><Clock3 size={22} aria-hidden="true" /><h2 id="open-bets-title">Giocate in attesa</h2><span className="fp-badge fp-badge-blue">{visibleOpenBets.length}</span></div>
                <span className="bets-section__hint">Capitale già impegnato · aggiornamento automatico a risultato disponibile</span>
              </div>
              <div className="bets-table-shell">
                <div className="bets-table-head" aria-hidden="true"><span /><span>Partita / Data</span><span>Mercato / Selezione</span><span>Quota reale</span><span>Puntata</span><span>Ritorno potenziale</span><span>Stato</span></div>
                {visibleOpenBets.length === 0 ? (
                  <div className="fp-empty bets-empty"><Ticket size={28} /><strong>Nessuna giocata aperta</strong><span>Le nuove giocate compariranno qui.</span></div>
                ) : visibleOpenBets.map((bet) => (
                  <BetRow key={String(bet.bet_id)} bet={bet} variant="open" expanded={expandedId === String(bet.bet_id)} onToggle={() => toggle(bet)} />
                ))}
              </div>
            </section>
          )}

          <section className="bets-section bets-history bets-section--history" aria-labelledby="history-title" aria-label="Storico giocate">
            <div className="bets-section__head">
              <div><History size={22} aria-hidden="true" /><h2 id="history-title">Storico giocate</h2><span className="fp-badge">{visibleHistoryBets.length}</span></div>
              <div className="bets-history-filters">
                <label><span className="sr-only">Filtra storico per esito</span><AppSelect aria-label="Filtra storico per esito" value={historyOutcome} onChange={setHistoryOutcome} options={[{value:'',label:'Tutti gli esiti'},{value:'WON',label:'Vinte'},{value:'LOST',label:'Perse'},{value:'VOID',label:'Annullate'}]} /></label>
                <label><span className="sr-only">Filtra storico per competizione</span><AppSelect aria-label="Filtra storico per competizione" value={historyCompetition} onChange={setHistoryCompetition} options={[{value:'',label:'Tutte le competizioni'}, ...competitions.map((competition) => ({value:competition,label:competition}))]} /></label>
              </div>
            </div>
            <div className="bets-table-shell">
              <div className="bets-table-head bets-table-head--history" aria-hidden="true"><span /><span>Partita / Data</span><span>Mercato / Selezione</span><span>Quota reale</span><span>Puntata</span><span>Ritorno</span><span>Esito</span><span>Profitto/Perdita</span></div>
              {visibleHistoryBets.length === 0 ? (
                <div className="fp-empty bets-empty"><strong>Nessuna giocata registrata</strong><span>Modifica i filtri oppure torna alle partite.</span></div>
              ) : visibleHistoryBets.slice(0, 80).map((bet) => (
                <BetRow key={String(bet.bet_id)} bet={bet} variant="history" expanded={expandedId === String(bet.bet_id)} onToggle={() => toggle(bet)} />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
};

export default BetsManager;
