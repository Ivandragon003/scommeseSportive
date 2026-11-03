import { useState } from 'react';
import { Check, CircleDollarSign, RotateCcw } from 'lucide-react';
import { AppSelect } from '../../components/common/AppSelect';
import AppCalendarInput from '../../components/common/AppCalendarInput';
import { WalletBetTable, WalletLoadState, walletMoney } from './AppWallets';
import { useWalletArchive } from './useWalletArchive';
import ArchiveSummary from './ArchiveSummary';
import WalletBetEvidence from './WalletBetEvidence';
import '../prediction-archive/prediction-archive.css';
import './wallet-archive.css';

const QUALITY = ['HIGH', 'MEDIUM', 'LOW', 'SPECULATIVE', 'UNKNOWN'];
const qualityLabel = (value: string) => value === 'UNKNOWN' ? 'Non registrata' : value === 'SPECULATIVE' ? 'Speculative' : value[0] + value.slice(1).toLowerCase();
const initialModel = () => {
  const value = new URLSearchParams(window.location.search).get('model');
  return value === 'baseline' ? 'A' : value === 'A' || value === 'C' ? value : 'all';
};

export default function WalletArchivePage() {
  const [model, setModel] = useState(initialModel);
  const [status, setStatus] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [qualities, setQualities] = useState<string[]>([]);
  const [selectedBetId, setSelectedBetId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const invalidDates = !!from && !!to && from > to;
  const { data, loading, error, refresh } = useWalletArchive({ model, status, from: invalidDates ? '' : from, to: invalidDates ? '' : to, qualities, offset, limit: 200 });
  const rows = data?.rows || [];
  const selectedBet = rows.find(bet => bet.id === selectedBetId && !bet.historical) ?? null;
  const ready = !!data && !error && !invalidDates;
  const activeFilters = model !== 'all' || status !== 'all' || !!from || !!to || qualities.length > 0;
  const changed = () => { setOffset(0); setSelectedBetId(null); };
  const reset = () => { setModel('all'); setStatus('all'); setFrom(''); setTo(''); setQualities([]); changed(); };
  return <div className="app-wallet-page pa-page wallet-archive" aria-busy={loading}>
    <header className="app-wallet-head"><div><h1>Archivio</h1><p>Giocate, classificazioni registrate e risultati. Deterministico (Modello A) e machine learning (Modello C).</p></div>
      <button type="button" className="fp-btn fp-btn-ghost" disabled={loading} onClick={refresh}>Aggiorna archivio</button>
    </header>
    <section className="wallet-archive__played" aria-label="Giocate registrate"><CircleDollarSign size={24} aria-hidden="true" /><div><strong>Giocate</strong><small>Deterministico (Modello A) e machine learning (Modello C)</small></div>
      <span className="pa-tab__count">{ready ? data.total : '—'}</span></section>
    <section className="wallet-archive__filters" aria-label="Filtri archivio">
      <label className="app-wallet-filter">Modello<AppSelect aria-label="Modello" value={model} onChange={value => { setModel(value); changed(); }} options={[
        { value: 'all', label: 'Tutti i modelli' }, { value: 'A', label: 'Deterministico (Modello A)' },
        { value: 'C', label: 'Machine learning (Modello C)' },
      ]} /></label>
      <label className="app-wallet-filter">Da<AppCalendarInput aria-label="Da" value={from} onChange={event => { setFrom(event.target.value); changed(); }} /></label>
      <label className="app-wallet-filter">A<AppCalendarInput aria-label="A" value={to} min={from || undefined} onChange={event => { setTo(event.target.value); changed(); }} /></label>
      <label className="app-wallet-filter">Esito<AppSelect aria-label="Esito" value={status} onChange={value => { setStatus(value); changed(); }} options={[
        { value: 'all', label: 'Tutte le giocate' }, { value: 'open', label: 'Aperte' }, { value: 'settled', label: 'Liquidate' },
        { value: 'WON', label: 'Vinte' }, { value: 'LOST', label: 'Perse' }, { value: 'VOID', label: 'Rimborsate' },
      ]} /></label>
      <fieldset className="pa-risk-filters"><legend>Classificazione</legend><div>{QUALITY.map(value => <button type="button" key={value} className={`pa-filter${qualities.includes(value) ? ' is-active' : ''}`}
        aria-pressed={qualities.includes(value)} onClick={() => { changed(); setQualities(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value]); }}><Check size={14} aria-hidden="true" style={{ visibility: qualities.includes(value) ? 'visible' : 'hidden' }} />{qualityLabel(value)}</button>)}</div></fieldset>
      <button type="button" className="pa-reset" disabled={!activeFilters} onClick={reset}><RotateCcw size={16} aria-hidden="true" />Azzera filtri</button>
      {invalidDates && <p className="pa-filter-error" role="alert">La data finale deve essere successiva o uguale alla data iniziale.</p>}
    </section>
    <WalletLoadState loading={loading && !data} error={error} refresh={refresh} />
    {ready && <>
      <p role="status" className="app-wallet-help wallet-archive__request">{loading ? 'Aggiornamento risultati…' : ' '}</p>
      <ArchiveSummary summary={data.summary} scope={`${from || to ? `${from || 'Inizio'} — ${to || 'Oggi'}` : 'Tutte le date'} · ${qualities.length ? qualities.map(qualityLabel).join(', ') : 'Tutte le classificazioni'}`} />
      <section className="wallet-archive__quality" aria-label="Statistiche per classificazione"><h2>Risultati per classificazione</h2>
        <div className="wallet-archive__quality-table"><table><thead><tr><th>Classificazione</th><th>Giocate</th><th>Vinte / perse / rimborsate</th><th>Saldo netto</th></tr></thead><tbody>
          {data.byClassification.filter(stats => stats.total > 0).map(stats => <tr key={stats.quality}><th>{qualityLabel(stats.quality)}</th><td>{stats.total}<small>{stats.open} aperte</small></td><td>{stats.won} / {stats.lost} / {stats.void}</td><td>{walletMoney(stats.netCents)}</td></tr>)}
          {!rows.length && <tr><td colSpan={4}>Nessuna giocata nei filtri scelti.</td></tr>}
        </tbody></table></div>
      </section>
      <p className="app-wallet-help">Orari italiani. {data.byModel.map(item => `Modello ${item.family}: ${item.total} giocate`).join(' · ')}.</p>
      <WalletBetTable rows={rows} model="all" emptyText="Nessuna giocata registrata nei filtri scelti." onInspectBet={bet => setSelectedBetId(bet.id)} />
      {data.total > data.limit && <nav className="app-wallet-toolbar" aria-label="Pagine archivio">
        <button type="button" className="fp-btn fp-btn-ghost" disabled={loading || offset === 0} onClick={() => { setOffset(Math.max(0, offset - 200)); setSelectedBetId(null); }}>Precedenti</button>
        <span>{data.offset + 1}–{data.offset + rows.length} di {data.total}</span>
        <button type="button" className="fp-btn fp-btn-ghost" disabled={loading || data.offset + rows.length >= data.total} onClick={() => { setOffset(offset + 200); setSelectedBetId(null); }}>Successive</button>
      </nav>}
      {selectedBet && <WalletBetEvidence key={selectedBet.id} bet={selectedBet} onClose={() => setSelectedBetId(null)} />}
    </>}
  </div>;
}
