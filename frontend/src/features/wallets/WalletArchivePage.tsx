import { useEffect, useMemo, useState } from 'react';
import { CircleDollarSign, RotateCcw } from 'lucide-react';
import { AppSelect } from '../../components/common/AppSelect';
import AppCalendarInput from '../../components/common/AppCalendarInput';
import { getWalletHistory } from '../../utils/walletApi';
import { ComparisonBet } from '../research/researchComparisonTypes';
import { useAppWalletData, WalletBetTable, WalletLoadState, walletMoney } from './AppWallets';
import { recordedBetQuality } from './BetQualityBadge';
import { archiveSummary, filterArchiveRows, historicalArchiveRows } from './archiveHistory';
import WalletBetEvidence from './WalletBetEvidence';
import '../prediction-archive/prediction-archive.css';
import './wallet-archive.css';

const QUALITY = ['HIGH', 'MEDIUM', 'LOW', 'SPECULATIVE', 'UNKNOWN'];
const qualityLabel = (value: string) => value === 'UNKNOWN' ? 'Non registrata' : value === 'SPECULATIVE' ? 'Speculative' : value[0] + value.slice(1).toLowerCase();
const initialModel = () => {
  const value = new URLSearchParams(window.location.search).get('model');
  return value === 'A' || value === 'C' || value === 'baseline' ? value : 'all';
};

export default function WalletArchivePage() {
  const [model, setModel] = useState(initialModel);
  const [status, setStatus] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [qualities, setQualities] = useState<string[]>([]);
  const [selectedBetId, setSelectedBetId] = useState<string | null>(null);
  const { data, loading, error, refresh } = useAppWalletData({ period: 'all' });
  const [history, setHistory] = useState<ComparisonBet[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setHistoryLoading(true); setHistoryError(null);
    getWalletHistory(controller.signal).then(rows => { if (active) setHistory(historicalArchiveRows(rows)); })
      .catch(() => { if (active) setHistoryError('Non è stato possibile caricare lo storico deterministico. Riprova.'); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [revision]);
  useEffect(() => {
    const sync = () => setRevision(value => value + 1);
    window.addEventListener('data-sync-complete', sync);
    return () => window.removeEventListener('data-sync-complete', sync);
  }, []);
  const reload = () => { refresh(); setRevision(value => value + 1); };
  const invalidDates = !!from && !!to && from > to;
  const rows = useMemo(() => filterArchiveRows([...history, ...(data?.bets.rows || [])], { model, status, from, to, qualities }),
    [history, data, model, status, from, to, qualities]);
  const summary = archiveSummary(rows);
  const selectedBet = rows.find(bet => bet.id === selectedBetId && !bet.historical) ?? null;
  const ready = !loading && !historyLoading && !error && !historyError && !!data && !invalidDates;
  const partial = data?.bets.truncated === true;
  const activeFilters = model !== 'all' || status !== 'all' || !!from || !!to || qualities.length > 0;
  const reset = () => { setModel('all'); setStatus('all'); setFrom(''); setTo(''); setQualities([]); setSelectedBetId(null); };
  return <div className="app-wallet-page pa-page wallet-archive">
    <header className="app-wallet-head"><div><h1>Archivio</h1><p>Giocate, classificazioni registrate e risultati. Lo storico senza modello è la baseline deterministica.</p></div>
      <button type="button" className="fp-btn fp-btn-ghost" disabled={loading || historyLoading} onClick={reload}>Aggiorna archivio</button>
    </header>
    <section className="wallet-archive__played" aria-label="Giocate registrate"><CircleDollarSign size={24} aria-hidden="true" /><div><strong>Giocate</strong><small>Baseline deterministica e portafogli A/C</small></div>
      <span className="pa-tab__count">{ready ? summary.total : '—'}</span></section>
    <section className="wallet-archive__filters" aria-label="Filtri archivio">
      <label className="app-wallet-filter">Modello<AppSelect aria-label="Modello" value={model} onChange={value => { setModel(value); setSelectedBetId(null); }} options={[
        { value: 'all', label: 'Tutti i modelli' }, { value: 'A', label: 'A deterministico · con storico' },
        { value: 'C', label: 'C machine learning' }, { value: 'baseline', label: 'Baseline · solo storico' },
      ]} /></label>
      <label className="app-wallet-filter">Da<AppCalendarInput aria-label="Da" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label className="app-wallet-filter">A<AppCalendarInput aria-label="A" value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></label>
      <label className="app-wallet-filter">Esito<AppSelect aria-label="Esito" value={status} onChange={value => { setStatus(value); setSelectedBetId(null); }} options={[
        { value: 'all', label: 'Tutte le giocate' }, { value: 'open', label: 'Aperte' }, { value: 'settled', label: 'Liquidate' },
        { value: 'WON', label: 'Vinte' }, { value: 'LOST', label: 'Perse' }, { value: 'VOID', label: 'Rimborsate' },
      ]} /></label>
      <fieldset className="pa-risk-filters"><legend>Classificazione</legend><div>{QUALITY.map(value => <button type="button" key={value} className={`pa-filter${qualities.includes(value) ? ' is-active' : ''}`}
        aria-pressed={qualities.includes(value)} onClick={() => setQualities(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value])}>{qualityLabel(value)}</button>)}</div></fieldset>
      <button type="button" className="pa-reset" disabled={!activeFilters} onClick={reset}><RotateCcw size={16} aria-hidden="true" />Azzera filtri</button>
      {invalidDates && <p className="pa-filter-error" role="alert">La data finale deve essere successiva o uguale alla data iniziale.</p>}
    </section>
    <WalletLoadState loading={loading || historyLoading} error={error || historyError} refresh={reload} />
    {ready && <>
      <section className="pa-summary" aria-label="Riepilogo giocate">
        <div className="pa-summary__intro"><span>Riepilogo giocate{partial ? ' caricate' : ''}</span><strong>{summary.settled} concluse · {summary.open} aperte</strong>
          <small>{summary.won} vinte · {summary.lost} perse · {summary.void} rimborsate</small><small>{from || to ? `${from || 'Inizio storico'} — ${to || 'Oggi'}` : 'Tutte le date'} · {qualities.length ? qualities.map(qualityLabel).join(', ') : 'Tutte le classificazioni'}</small></div>
        <div className="pa-summary__metric pa-summary__metric--win"><span>Vinto</span><strong>{walletMoney(summary.wonCents)}</strong></div>
        <div className="pa-summary__metric pa-summary__metric--loss"><span>Perso</span><strong>{walletMoney(summary.lostCents)}</strong></div>
        <div className={`pa-summary__metric pa-summary__metric--net ${(summary.netCents ?? 0) < 0 ? 'is-negative' : 'is-positive'}`}><span>Saldo netto</span><strong>{walletMoney(summary.netCents)}</strong></div>
        <p>Profitto netto delle giocate liquidate nei filtri scelti; le giocate aperte sono escluse.{summary.missingProfit ? ' Alcuni risultati economici non sono registrati.' : ''}</p>
      </section>
      <section className="wallet-archive__quality" aria-label="Statistiche per classificazione"><h2>Risultati per classificazione</h2>
        <div className="wallet-archive__quality-table"><table><thead><tr><th>Classificazione</th><th>Giocate</th><th>Vinte / perse / rimborsate</th><th>Saldo netto</th></tr></thead><tbody>
          {QUALITY.map(value => { const group = rows.filter(bet => (recordedBetQuality(bet) || 'UNKNOWN') === value); const stats = archiveSummary(group);
            return group.length ? <tr key={value}><th>{qualityLabel(value)}</th><td>{stats.total}<small>{stats.open} aperte</small></td><td>{stats.won} / {stats.lost} / {stats.void}</td><td>{walletMoney(stats.netCents)}</td></tr> : null;
          })}
          {!rows.length && <tr><td colSpan={4}>Nessuna giocata nei filtri scelti.</td></tr>}
        </tbody></table></div>
      </section>
      <p className="app-wallet-help">Orari italiani. Baseline deterministica: {history.length} giocate storiche.
        {' '}{data.portfolios.map(portfolio => `Modello ${portfolio.family}: ${portfolio.betCount ?? '—'} giocate registrate`).join(' · ')}.
      </p>
      <WalletBetTable rows={rows} model="all" emptyText="Nessuna giocata registrata nei filtri scelti." onInspectBet={bet => setSelectedBetId(bet.id)} />
      {partial && <p role="status">Mostrate fino a {data.bets.rows.length} delle {data.bets.total} giocate A/C del periodo, oltre allo storico deterministico. Riepilogo e statistiche si riferiscono alle sole registrazioni caricate.</p>}
      {selectedBet && <WalletBetEvidence key={selectedBet.id} bet={selectedBet} onClose={() => setSelectedBetId(null)} />}
    </>}
  </div>;
}
